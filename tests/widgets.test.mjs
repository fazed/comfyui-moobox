import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as state from '../web/state.js';

class Element extends EventTarget {
  children = [];
  attributes = {};
  dataset = {};
  value = '';
  style = {};
  classList = { add() {}, remove() {}, toggle() {} };
  append(...items) { items.forEach((item) => { item.parentNode = this; }); this.children.push(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  getBoundingClientRect() { return { left: 0, right: 30, top: 0, bottom: 30 }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { this.dispatchEvent(new Event('click')); }
  focus() { this.document.activeElement = this; }
  scrollIntoView() {}
  contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
  querySelectorAll() { return this.children.flatMap((child) => [...(child.dataset.focus ? [child] : []), ...child.querySelectorAll()]); }
  get valueAsNumber() { return Number(this.value); }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
const labelled = (root, name) => find(root, (el) => el.attributes['aria-label'] === name);

async function harness(fetchApi, dynamicModules = {}, console = globalThis.console, nodeTypes = {}) {
  let extension;
  const listeners = new Set();
  const document = {
    head: new Element(),
    body: new Element(),
    listeners,
    createElement: (tag) => { const el = new Element(); el.tagName = tag.toUpperCase(); el.document = document; return el; },
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
  };
  const window = { innerWidth: 1200, innerHeight: 800 };
  const LiteGraph = { registered_node_types: nodeTypes };
  const navigator = { copied: [], clipboard: { writeText: async (text) => { navigator.copied.push(text); } } };
  const localStorage = { items: {}, getItem(name) { return this.items[name] ?? null; }, setItem(name, value) { this.items[name] = String(value); } };
  const context = vm.createContext({ document, window, navigator, localStorage, LiteGraph, URL, AbortController, Event, structuredClone, setTimeout, clearTimeout, console });
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  const source = await readFile(new URL('../web/widgets.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => { meta.url = new URL('../web/widgets.js', import.meta.url).href; },
    importModuleDynamically: async (specifier) => {
      if (!dynamicModules[specifier]) throw new Error(`Cannot find module ${specifier}`);
      const dynamic = synthetic(dynamicModules[specifier]);
      await dynamic.link(() => {});
      await dynamic.evaluate();
      return dynamic;
    },
  });
  const mocks = {
    '../../scripts/app.js': { app: { registerExtension: (value) => { extension = value; } } },
    '../../scripts/api.js': { api: { fetchApi, apiURL: (path) => path } },
    './icons.js': { glyph: () => new Element() },
    './state.js': state,
    './styles.js': {},
  };
  await module.link((specifier) => synthetic(mocks[specifier]));
  await module.evaluate();
  const node = {
    mode: 0,
    widgets: [],
    outputs: [],
    graph: { beforeChange() {}, afterChange() {}, setDirtyCanvas() {} },
    addDOMWidget(name, type, element, options) {
      const widget = { name, type, element, options };
      Object.defineProperty(widget, 'value', { get: options.getValue, set: options.setValue });
      this.widgets.push(widget);
      return widget;
    },
  };
  return { node, document, navigator, localStorage, extension };
}

test('loader factory restores state synchronously and removes selected rows permanently', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const entries = [{ name: 'alpha', active: false, strength: 0.4, clipStrength: 0.6, words: [] }];
  widget.value = JSON.stringify(entries);
  const root = widget.element;
  const search = find(root, (el) => el.type === 'search');
  assert.equal(search.value, '');
  search.value = 'new query';
  assert.equal(JSON.parse(widget.serializeValue())[0].active, false);
  labelled(root, 'Remove alpha').click();
  assert.deepEqual(JSON.parse(widget.value), []);
  widget.value = widget.serializeValue();
  assert.ok(find(root, (el) => el.textContent === 'Build your LoRA stack'));
  widget.onRemove();
});

test('optional manager metadata failures do not prevent native LoRA selection', async () => {
  const { node, document, extension } = await harness(async (path) => {
    if (path.includes('/search')) return { ok: true, json: async () => ({ names: ['alpha.safetensors'] }) };
    if (path.includes('/words')) return { ok: true, json: async () => ({ words: [] }) };
    throw new Error('LoRA Manager not installed');
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'alpha';
  search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  results.children[0].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(widget.value)[0].name, 'alpha.safetensors');
  assert.equal(search.value, '');
  assert.equal(document.activeElement, search);
  widget.onRemove();
});

test('late search responses cannot replace results for a newer query', async () => {
  let resolveOld;
  const { node, extension } = await harness(async (path) => {
    if (path.endsWith('q=old')) return new Promise((resolve) => { resolveOld = resolve; });
    return { ok: true, json: async () => ({ names: ['new.safetensors'] }) };
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'old'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  search.value = 'new'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  resolveOld({ ok: true, json: async () => ({ names: ['old.safetensors'] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(results.children[0].children[1].textContent, 'new');
  widget.onRemove();
});

test('native search sends the chosen family and a family change refreshes the results', async () => {
  const paths = [];
  const { node, extension } = await harness(async (path) => {
    paths.push(path);
    return { ok: true, json: async () => ({ names: [path.includes('family=SDXL') ? 'sdxl.safetensors' : 'any.safetensors'] }) };
  });
  const type = { prototype: {} };
  extension.beforeRegisterNodeDef(type, { name: 'MooBoxLoraLoader' });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const family = { name: 'family', value: 'Any', callback: () => { family.changed = true; } };
  node.widgets.push(family);
  type.prototype.onNodeCreated.call(node);
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'style'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(paths.at(-1), '/moobox-lora/search?q=style');
  family.value = 'SDXL';
  family.callback('SDXL');
  assert.equal(family.changed, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(paths.at(-1), '/moobox-lora/search?q=style&family=SDXL');
  assert.equal(results.children[0].children[1].textContent, 'sdxl');
  family.value = 'Krea 2';
  family.callback('Krea 2');
  assert.equal(paths.at(-1), '/moobox-lora/search?q=style&family=Krea%202');
  widget.onRemove();
});

test('LoRA Manager search uses the full MooBox search when a family is chosen', async () => {
  const paths = [];
  const { node, extension } = await harness(async (path) => {
    paths.push(path);
    return { ok: true, json: async () => (path.startsWith('/lm/') ? { relative_paths: ['manager.safetensors'] } : { names: ['sdxl.safetensors'] }) };
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const family = { name: 'family', value: 'Any' };
  node.widgets.push({ name: 'loader', value: 'LoRA Manager' }, family);
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'concept'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(paths.at(-1), '/lm/loras/relative-paths?search=concept&limit=50');
  assert.equal(results.children[0].children[1].textContent, 'manager');
  family.value = 'SDXL';
  widget.refreshSearch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(paths.at(-1), '/moobox-lora/search?q=concept&family=SDXL');
  assert.equal(results.children[0].children[1].textContent, 'sdxl');
  widget.onRemove();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (target, name) => target.dispatchEvent(Object.assign(new Event('keydown'), { key: name }));
const pageOf = (path, total) => {
  const offset = Number(new URL(path, 'http://local').searchParams.get('offset') ?? 0);
  return { names: Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, index) => `lora_${offset + index}.safetensors`), total };
};

test('native search appends every page in order and keeps the highlighted result', async () => {
  const paths = [];
  let release;
  const { node, extension } = await harness(async (path) => {
    if (path.includes('/words')) return { ok: true, json: async () => ({ words: [] }) };
    paths.push(path);
    if (path.endsWith('offset=50')) await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => pageOf(path, 120) };
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  const status = find(widget.element, (el) => el.className === 'mb-status');
  search.value = 'lora'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(results.children.length, 50);
  assert.equal(status.textContent, 'Showing 50 of 120…');
  key(search, 'ArrowDown'); key(search, 'ArrowDown');
  release();
  for (let index = 0; index < 5; index++) await tick();
  assert.deepEqual(paths, ['/moobox-lora/search?q=lora', '/moobox-lora/search?q=lora&offset=50', '/moobox-lora/search?q=lora&offset=100']);
  assert.equal(results.children.length, 120);
  assert.equal(results.children[119].children[1].textContent, 'lora_119');
  assert.equal(status.textContent, '120 matches. Choose a result or press Enter to add it.');
  key(search, 'Enter');
  await tick();
  assert.equal(JSON.parse(widget.value)[0].name, 'lora_2.safetensors');
  widget.onRemove();
});

test('changing the query stops loading the pages of the old query', async () => {
  const paths = [];
  let release;
  const { node, extension } = await harness(async (path) => {
    paths.push(path);
    if (path.endsWith('q=old&offset=50')) await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => pageOf(path, path.includes('q=old') ? 200 : 3) };
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'old'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  search.value = 'new'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  release();
  for (let index = 0; index < 5; index++) await tick();
  assert.deepEqual(paths, ['/moobox-lora/search?q=old', '/moobox-lora/search?q=old&offset=50', '/moobox-lora/search?q=new']);
  assert.equal(results.children.length, 3);
  widget.onRemove();
});

test('LoRA Manager search without a family stays a single page of 50', async () => {
  const paths = [];
  const { node, extension } = await harness(async (path) => {
    paths.push(path);
    return { ok: true, json: async () => ({ relative_paths: pageOf('/?offset=0', 50).names, total: 300 }) };
  });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  node.widgets.push({ name: 'loader', value: 'LoRA Manager' });
  const search = find(widget.element, (el) => el.type === 'search');
  const results = find(widget.element, (el) => el.className === 'mb-results');
  search.value = 'concept'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  await tick();
  assert.deepEqual(paths, ['/lm/loras/relative-paths?search=concept&limit=50']);
  assert.equal(results.children.length, 50);
  widget.onRemove();
});

test('trigger factory restores groups before interaction and preserves child switches', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  const value = state.reconcileWords({ groups: [] }, 'alpha, beta');
  value.groups[0].active = true;
  value.groups[0].items[1].active = false;
  widget.value = JSON.stringify(value);
  const group = find(widget.element, (el) => el.className === 'mb-card mb-group');
  const words = find(group, (el) => el.className === 'mb-pills');
  assert.deepEqual(words.children.map((pill) => pill.dataset.active), ['true', 'false']);
  labelled(group, 'Toggle word alpha').click();
  assert.deepEqual(JSON.parse(widget.value).groups[0].items.map((item) => item.active), [false, false]);
  assert.equal(JSON.parse(widget.value).groups[0].active, true);
});

test('trigger words take a per-word weight that defaults to 1', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify(state.reconcileWords({ groups: [] }, 'alpha, beta'));
  const weight = labelled(widget.element, 'Word weight beta');
  assert.equal(weight.value, 1);
  weight.value = '0.7';
  weight.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(widget.value).groups[0].items[1].strength, 0.7);
});

test('LoRAs can be reordered with the move buttons', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1 }, { name: 'beta', strength: 1 }]);
  labelled(widget.element, 'Move alpha down').click();
  assert.deepEqual(JSON.parse(widget.value).map((entry) => entry.name), ['beta', 'alpha']);
});


test('model and CLIP controls can be linked without changing saved values on restore', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', active: true, strength: 0.4, clipStrength: 0.6, words: [] }]);
  assert.equal(JSON.parse(widget.value)[0].clipStrength, 0.6);
  assert.equal(labelled(widget.element, 'Link model and CLIP for alpha'), undefined);
  labelled(widget.element, 'Show link and CLIP settings for alpha').click();
  labelled(widget.element, 'Link model and CLIP for alpha').click();
  assert.equal(JSON.parse(widget.value)[0].clipStrength, 0.4);
  const strength = labelled(widget.element, 'Model strength alpha');
  strength.value = '0.8';
  strength.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(widget.value)[0].clipStrength, 0.8);
  widget.onRemove();
});

const MANAGER = { 'Lora Loader (LoraManager)': {} };
const ok = (data) => ({ ok: true, json: async () => data });

const tabNames = (box) => find(box, (el) => el.attributes.role === 'tablist').children.map((tab) => tab.textContent);
const selectedTab = (box) => find(box, (el) => el.attributes.role === 'tablist').children.find((tab) => tab.attributes['aria-selected'] === 'true').textContent;

test('the info popover shows read-only details in tabs and links to the exact manager lookup', async () => {
  const paths = [];
  const { node, document, navigator, extension } = await harness(async (path) => {
    paths.push(path);
    if (path.startsWith('/lm/loras/details')) return ok({ success: true, metadata: {
      model_name: 'Alpha Style', base_model: 'SDXL 1.0', preview_url: '/previews/alpha.png',
      civitai: { trainedWords: ['alpha, ink,', ' bold '] }, usage_tips: '{"strength": 0.8, "clip_skip": 2}', description: '<p>Bold <b>lines</b> &amp; ink</p><script>x</script>',
    } });
    if (path.startsWith('/lm/loras/get-notes')) return ok({ success: true, notes: '  Use at 0.7\n  with ink  ' });
    return ok({ success: true, schema: { kind: 'unet', groups: ['IN'], blocks: [{ id: 'IN01', group: 'IN', index: 1 }, { id: 'IN02', group: 'IN', index: 2 }] } });
  }, {}, globalThis.console, MANAGER);
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'styles/alpha & beta.safetensors', strength: 0.7, clipStrength: 0.7 }]);
  assert.equal(labelled(widget.element, 'Open styles/alpha & beta.safetensors in LoRA Manager'), undefined);
  const info = labelled(widget.element, 'Show details for styles/alpha & beta.safetensors');
  info.click();
  await tick();
  const box = document.body.children[0];
  assert.equal(document.body.children.length, 1);
  assert.equal(info.attributes['aria-expanded'], 'true');
  const lora = 'styles%2Falpha%20%26%20beta';
  assert.deepEqual(paths, [`/lm/loras/details?name=${lora}`, `/lm/loras/block-weight-schema?name=${lora}`, `/lm/loras/get-notes?name=${lora}`]);
  assert.deepEqual(tabNames(box), ['Overview', 'Description', 'Blocks', 'Notes']);
  assert.equal(selectedTab(box), 'Overview');
  assert.ok(find(box, (el) => el.textContent === 'Alpha Style'));
  assert.ok(find(box, (el) => el.textContent === 'SDXL 1.0'));
  assert.equal(find(box, (el) => el.className === 'mb-info-preview').src, '/previews/alpha.png');
  assert.ok(find(box, (el) => el.textContent === 'Recommended strength 0.8'));
  assert.equal(find(box, (el) => el.textContent === 'Bold lines & ink\nx'), undefined);
  const status = find(box, (el) => el.attributes.role === 'status');
  labelled(box, 'Copy alpha, ink').click();
  await tick();
  assert.equal(status.textContent, 'Copied alpha, ink');
  labelled(box, 'Copy all trigger words').click();
  await tick();
  assert.deepEqual(navigator.copied, ['alpha, ink', 'alpha, ink, bold']);
  assert.equal(status.textContent, 'Copied all trigger words');
  const tablist = find(box, (el) => el.attributes.role === 'tablist');
  key(tablist, 'ArrowRight');
  assert.equal(selectedTab(box), 'Description');
  assert.equal(document.activeElement, tablist.children[1]);
  assert.ok(find(box, (el) => el.textContent === 'Bold lines & ink\nx'));
  assert.equal(find(box, (el) => el.textContent === 'Alpha Style'), undefined);
  labelled(box, 'Blocks').click();
  assert.ok(find(box, (el) => el.textContent === 'IN: IN01, IN02'));
  assert.ok(find(box, (el) => el.textContent === 'Every block uses the row strength 0.7.'));
  key(tablist, 'ArrowRight');
  assert.equal(selectedTab(box), 'Notes');
  assert.equal(find(box, (el) => el.className === 'mb-info-text mb-info-notes').textContent, 'Use at 0.7\n  with ink');
  key(tablist, 'ArrowRight');
  assert.equal(selectedTab(box), 'Overview');
  key(tablist, 'ArrowLeft');
  assert.equal(selectedTab(box), 'Notes');
  assert.equal(paths.length, 3);
  const link = labelled(box, 'Open styles/alpha & beta.safetensors in LoRA Manager');
  assert.equal(new URL(link.href).searchParams.get('name'), 'styles/alpha & beta.safetensors');
  assert.equal(link.target, '_blank');
  assert.ok(link.rel.includes('noopener'));
  info.click();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
  info.click();
  key(document.body.children[0], 'Escape');
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
  assert.equal(widget.computeLayoutSize().minHeight, 340);
  widget.onRemove();
});

test('the info popover says details are unavailable and closes on outside clicks and node removal', async () => {
  const { node, document, extension } = await harness(async () => ({ ok: false, status: 404 }), {}, globalThis.console, MANAGER);
  const type = { prototype: {} };
  extension.beforeRegisterNodeDef(type, { name: 'MooBoxLoraLoader' });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1 }]);
  labelled(widget.element, 'Show details for alpha').click();
  await tick();
  assert.ok(find(document.body.children[0], (el) => el.textContent === 'Details unavailable'));
  const [dismiss] = document.listeners;
  dismiss({ target: document.body.children[0].children[0] });
  assert.equal(document.body.children.length, 1);
  dismiss({ target: new Element() });
  assert.equal(document.body.children.length, 0);
  labelled(widget.element, 'Show details for alpha').click();
  type.prototype.onRemoved.call(node);
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
  labelled(widget.element, 'Show details for alpha').click();
  widget.onRemove();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
});

test('the description tab renders markdown as elements and never as links, images or HTML', async () => {
  const description = '## Usage\n\nUse **bold** and *soft*.\n- one\n- two\n\n| a | b |\n| :-- | --: |\n| [x](https://evil.test) | &lt;img src=x onerror=alert(1)&gt; |\n\n![pic](https://evil.test/p.png)';
  const { node, document, extension } = await harness(async (path) => {
    if (path.startsWith('/lm/loras/details')) return ok({ success: true, metadata: { civitai: { trainedWords: ['alpha'] }, description } });
    if (path.startsWith('/lm/loras/block-weight-schema')) return ok({ success: true, schema: { blocks: [] } });
    return { ok: false, status: 404 };
  }, {}, globalThis.console, MANAGER);
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1 }]);
  labelled(widget.element, 'Show details for alpha').click();
  await tick();
  const box = document.body.children[0];
  labelled(box, 'Description').click();
  const body = find(box, (el) => el.className === 'mb-info-body');
  const tag = (name) => find(body, (el) => el.tagName === name);
  const textOf = (el) => el.textContent ?? el.children.map(textOf).join('');
  assert.equal(textOf(tag('H4')), 'Usage');
  assert.equal(textOf(tag('STRONG')), 'bold');
  assert.equal(textOf(tag('EM')), 'soft');
  assert.equal(tag('UL').children.length, 2);
  const table = tag('TABLE');
  assert.equal(table.children[0].children[0].dataset.align, 'left');
  assert.equal(table.children[0].children[1].dataset.align, 'right');
  assert.equal(textOf(table.children[1].children[0]), 'x');
  assert.equal(textOf(table.children[1].children[1]), '<img src=x onerror=alert(1)>');
  assert.equal(find(body, (el) => el.tagName === 'IMG' || el.tagName === 'A'), undefined);
  assert.equal(find(body, (el) => el.attributes.href !== undefined || el.attributes.src !== undefined), undefined);
  assert.ok(find(body, (el) => el.tagName === 'P' && textOf(el) === 'pic'));
});

test('the info popover hides the Blocks tab without blocks and says when there is no description or notes', async () => {
  const { node, document, navigator, extension } = await harness(async (path) => {
    if (path.startsWith('/lm/loras/details')) return ok({ success: true, metadata: { civitai: { trainedWords: ['alpha'] } } });
    if (path.startsWith('/lm/loras/block-weight-schema')) return ok({ success: true, schema: { blocks: [] } });
    return { ok: false, status: 404 };
  }, {}, globalThis.console, MANAGER);
  navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1 }]);
  labelled(widget.element, 'Show details for alpha').click();
  await tick();
  const box = document.body.children[0];
  assert.deepEqual(tabNames(box), ['Overview', 'Description', 'Notes']);
  labelled(box, 'Copy all trigger words').click();
  await tick();
  assert.equal(find(box, (el) => el.attributes.role === 'status').textContent, 'Could not copy all trigger words');
  labelled(box, 'Description').click();
  assert.ok(find(box, (el) => el.textContent === 'No description'));
  labelled(box, 'Notes').click();
  assert.ok(find(box, (el) => el.textContent === 'No notes'));
  widget.onRemove();
  assert.equal(document.body.children.length, 0);
});

test('closing the info popover, opening another or removing the node aborts its requests', async () => {
  const signals = [];
  const pending = [];
  const { node, document, extension } = await harness((path, options) => {
    signals.push(options.signal);
    return new Promise((resolve) => pending.push(resolve));
  }, {}, globalThis.console, MANAGER);
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1 }, { name: 'beta', strength: 1, clipStrength: 1 }]);
  const alpha = labelled(widget.element, 'Show details for alpha');
  alpha.click();
  const first = document.body.children[0];
  assert.equal(signals.length, 3);
  alpha.click();
  assert.ok(signals.every((signal) => signal.aborted));
  pending.forEach((resolve) => resolve(ok({ success: true, metadata: {}, schema: { blocks: [] }, notes: '' })));
  await tick();
  assert.equal(find(first, (el) => el.attributes.role === 'tablist').children.length, 0);
  alpha.click();
  labelled(widget.element, 'Show details for beta').click();
  assert.ok(signals.slice(3, 6).every((signal) => signal.aborted));
  assert.ok(signals.slice(6).every((signal) => !signal.aborted));
  widget.onRemove();
  assert.equal(signals.length, 9);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
});

test('without LoRA Manager the rows have no info button and the top bar no quick add', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1 }]);
  assert.equal(labelled(widget.element, 'Show details for alpha'), undefined);
  assert.equal(labelled(widget.element, 'Quick Pick from LoRA Manager'), undefined);
  assert.ok(labelled(widget.element, 'Open LoRA Manager'));
  widget.onRemove();
});

const settle = async () => { for (let index = 0; index < 8; index++) await tick(); };
const rowLabels = (dialog) => find(dialog, (el) => el.className === 'mb-quick-list').children.filter((el) => el.attributes.role === 'option').map((el) => el.attributes['aria-label']);
const badgeOf = (row) => row.children.find((el) => el.className === 'mb-badge mb-quick-badge')?.textContent;
const LIBRARY = { count: 2, items: [{ relative_path: 'top', model_name: 'Top' }], folders: { styles: { count: 1, items: [{ relative_path: 'styles/ink', model_name: 'Ink' }], folders: {} } } };

function quickPickApi(paths, overrides = {}) {
  return async (path, options = {}) => {
    paths.push(path);
    assert.equal(options.method, undefined);
    for (const [prefix, data] of Object.entries(overrides)) if (path.startsWith(prefix)) return data;
    if (path.startsWith('/lm/loras/active-filters')) return ok({ success: true, filters: { activeFolder: 'styles', recursiveSearch: true, filters: {} } });
    if (path.startsWith('/lm/loras/folder-index')) return ok({ success: true, root: LIBRARY });
    if (path.startsWith('/lm/loras/relative-paths')) return ok({ success: true, items: [{ relative_path: 'styles\\ink.safetensors', model_name: 'Ink' }, { relative_path: 'new.safetensors', model_name: 'New' }] });
    if (path.startsWith('/lm/loras/details')) return ok({ success: true, metadata: { model_name: 'Ink Style', base_model: 'SDXL 1.0', preview_url: '/previews/ink.png', civitai: { trainedWords: ['ink, bold'] }, usage_tips: '{"strength": 0.8}' } });
    if (path.startsWith('/moobox-lora/search')) {
      const query = decodeURIComponent(path.split('q=')[1]);
      return ok({ names: ['pink.safetensors', 'styles\\ink.safetensors', 'new.safetensors', 'chars\\hero.safetensors'].filter((name) => name.includes(query)) });
    }
    if (path.startsWith('/moobox-lora/words')) return ok({ words: ['fresh'] });
    throw new Error(`unexpected ${path}`);
  };
}

async function openQuickPick(fetchApi) {
  const result = await harness(fetchApi, {}, globalThis.console, MANAGER);
  const { node, document, extension } = result;
  Object.assign(node, { id: 5, title: 'MooBox LoRA Loader' });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  const anchor = labelled(widget.element, 'Quick Pick from LoRA Manager');
  anchor.click();
  await settle();
  return { ...result, widget, anchor, dialog: document.body.children[0]?.children[0] };
}

test('Quick Pick browses folders, previews a LoRA and enables a saved LoRA instead of adding it twice', async () => {
  const paths = [];
  const { node, document, localStorage, widget, anchor, dialog } = await openQuickPick(quickPickApi(paths));
  widget.value = JSON.stringify([{ name: 'styles\\ink.safetensors', strength: 0.4, clipStrength: 0.4, linked: true, active: false, words: ['inked'] }]);
  assert.equal(document.body.children.length, 1);
  assert.equal(anchor.attributes['aria-expanded'], 'true');
  assert.equal(dialog.attributes['aria-label'], 'Quick Pick · LoRA');
  assert.ok(find(dialog, (el) => el.textContent === 'Add to MooBox LoRA Loader (#5)'));
  assert.deepEqual(tabNames(dialog), ['LoRAs', 'Recipes']);
  const input = labelled(dialog, 'Search LoRAs');
  assert.equal(document.activeElement, input);
  assert.deepEqual(paths, ['/lm/loras/active-filters', '/lm/loras/folder-index', '/lm/loras/relative-paths?search=&limit=60&match_model_name=true&include_model_name=true']);
  assert.equal(labelled(dialog, "Use LoRA Manager's active filters").textContent, 'Filters · 1');
  assert.deepEqual(rowLabels(dialog), ['Open folder styles, 1 LoRA', 'Add top']);
  assert.ok(find(dialog, (el) => el.textContent === 'Up/Down Navigate · Left/Right Folder · Enter Open/Apply · Shift+Enter Keep open · Esc Close'));
  key(input, 'ArrowRight');
  await settle();
  assert.ok(labelled(dialog, 'Back to the parent folder'));
  assert.ok(find(dialog, (el) => el.textContent === 'styles'));
  const [row] = find(dialog, (el) => el.className === 'mb-quick-list').children.filter((el) => el.attributes.role === 'option');
  assert.equal(row.attributes['aria-label'], 'Add styles/ink');
  assert.equal(badgeOf(row), 'Off');
  assert.equal(paths.at(-1), '/lm/loras/details?name=styles%2Fink');
  const preview = find(dialog, (el) => el.className === 'mb-quick-preview');
  assert.ok(find(preview, (el) => el.textContent === 'Ink Style'));
  assert.ok(find(preview, (el) => el.textContent === 'SDXL 1.0'));
  assert.equal(find(preview, (el) => el.className === 'mb-info-preview').src, '/previews/ink.png');
  assert.ok(labelled(preview, 'Copy ink, bold'));
  assert.ok(labelled(preview, 'Copy all trigger words'));
  assert.ok(find(preview, (el) => el.textContent === 'Recommended strength 0.8'));
  key(input, 'ArrowLeft');
  assert.deepEqual(rowLabels(dialog), ['Open folder styles, 1 LoRA', 'Add top']);
  key(input, 'ArrowRight');
  key(input, 'Enter');
  await settle();
  assert.deepEqual(JSON.parse(widget.value), [{ name: 'styles\\ink.safetensors', strength: 0.4, clipStrength: 0.4, linked: true, active: true, words: ['inked'] }]);
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
  assert.equal(document.activeElement, anchor);
  assert.equal(anchor.attributes['aria-expanded'], 'false');
  assert.deepEqual(JSON.parse(localStorage.items['moobox.quickPick.recent']), [{ type: 'lora', path: 'styles/ink', title: 'Ink' }]);
  widget.onRemove();
});

test('Quick Pick lists recent and flat results, keeps open with Shift+Enter and closes on Escape', async () => {
  const paths = [];
  const { document, localStorage, widget, anchor, dialog } = await openQuickPick(quickPickApi(paths));
  localStorage.items['moobox.quickPick.recent'] = JSON.stringify([{ type: 'lora', path: 'styles/ink', title: 'Ink' }]);
  widget.value = JSON.stringify([{ name: 'styles\\ink.safetensors', strength: 0.4, clipStrength: 0.4, linked: true, active: true, words: [] }]);
  key(dialog, 'Escape');
  assert.equal(document.body.children.length, 0);
  anchor.click();
  await settle();
  const again = document.body.children[0].children[0];
  labelled(again, 'Show recently added LoRAs').click();
  assert.deepEqual(rowLabels(again), ['Add styles/ink']);
  assert.equal(badgeOf(find(again, (el) => el.attributes['aria-label'] === 'Add styles/ink')), 'Added');
  labelled(again, 'Show recently added LoRAs').click();
  labelled(again, 'Flat view').click();
  assert.deepEqual(rowLabels(again), ['Add styles\\ink.safetensors', 'Add new.safetensors']);
  const input = labelled(again, 'Search LoRAs');
  key(input, 'ArrowDown');
  input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', shiftKey: true }));
  await settle();
  assert.deepEqual(JSON.parse(widget.value).map((entry) => [entry.name, entry.strength, entry.active, entry.words]), [['styles\\ink.safetensors', 0.4, true, []], ['new.safetensors', 1, true, ['fresh']]]);
  assert.equal(document.body.children.length, 1);
  assert.equal(find(again, (el) => el.attributes.role === 'status').textContent, 'Added New');
  assert.equal(badgeOf(find(again, (el) => el.attributes['aria-label'] === 'Add new.safetensors')), 'Added');
  assert.deepEqual(JSON.parse(localStorage.items['moobox.quickPick.recent']).map((item) => item.path), ['new.safetensors', 'styles/ink']);
  input.value = 'hero';
  input.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  const searches = () => paths.filter((path) => path.startsWith('/lm/loras/relative-paths'));
  assert.equal(searches().at(-1), '/lm/loras/relative-paths?search=hero&limit=60&match_model_name=true&include_model_name=true');
  labelled(again, "Use LoRA Manager's active filters").click();
  await settle();
  assert.ok(paths.includes('/lm/loras/folder-index?use_active_filters=true'));
  assert.equal(searches().at(-1), '/lm/loras/relative-paths?search=hero&limit=60&match_model_name=true&include_model_name=true&use_active_filters=true');
  assert.equal(find(again, (el) => el.attributes.role === 'status').textContent, '2 results within active filters');
  labelled(again, 'Close Quick Pick').click();
  assert.equal(document.body.children.length, 0);
  assert.equal(document.activeElement, anchor);
  widget.onRemove();
});

test('the Recipes tab previews a recipe and appends the LoRAs that are in the library', async () => {
  const paths = [];
  const recipe = { id: 9, title: 'Hero ink', file_url: '/api/lm/recipes/9.webp', base_model: 'SDXL 1.0', loras: [
    { file_name: 'hero', modelName: 'Hero', strength: 0.7, inLibrary: true },
    { file_name: 'ink', strength: 0.5, inLibrary: true },
    { file_name: 'remote', strength: 1, inLibrary: false },
  ] };
  const { document, widget, dialog } = await openQuickPick(quickPickApi(paths, { '/lm/recipes': ok({ items: [recipe], total: 1 }) }));
  widget.value = JSON.stringify([{ name: 'styles\\ink.safetensors', strength: 0.4, clipStrength: 0.4, linked: true, active: false, words: [] }]);
  labelled(dialog, 'Recipes').click();
  await settle();
  assert.equal(dialog.attributes['aria-label'], 'Quick Pick · Recipe');
  assert.equal(paths.at(-1), '/lm/recipes?page=1&page_size=30&sort_by=date&search=');
  assert.equal(find(dialog, (el) => el.className === 'mb-quick-options').hidden, true);
  assert.deepEqual(rowLabels(dialog), ['Append recipe Hero ink']);
  const preview = find(dialog, (el) => el.className === 'mb-quick-preview');
  assert.equal(find(preview, (el) => el.className === 'mb-info-preview').src, '/api/lm/recipes/9.webp');
  assert.ok(find(preview, (el) => el.textContent === '3 LoRAs · SDXL 1.0'));
  assert.ok(find(preview, (el) => el.textContent === '1.00 · missing'));
  assert.ok(find(preview, (el) => el.textContent === '1 LoRA not in the library will be skipped.'));
  key(labelled(dialog, 'Search recipes'), 'Enter');
  await settle();
  assert.deepEqual(JSON.parse(widget.value).map((entry) => [entry.name, entry.strength, entry.clipStrength, entry.active, entry.words]), [
    ['styles\\ink.safetensors', 0.4, 0.4, true, []], ['chars\\hero.safetensors', 0.7, 0.7, true, ['fresh']],
  ]);
  assert.equal(document.body.children.length, 0);
  assert.ok(paths.every((path) => !path.startsWith('/lm/recipe/')));
  widget.onRemove();
});

test('the Recipes tab says when recipes are unavailable', async () => {
  const { widget, dialog } = await openQuickPick(quickPickApi([], { '/lm/recipes': { ok: false, status: 404 } }));
  labelled(dialog, 'Recipes').click();
  await settle();
  assert.ok(find(dialog, (el) => el.className === 'mb-empty' && el.textContent === 'Recipes unavailable'));
  assert.equal(rowLabels(dialog).length, 0);
  widget.onRemove();
});

test('closing Quick Pick or removing the node aborts its requests and stops the debounce', async () => {
  const paths = [];
  const signals = [];
  const pending = (path, options) => { paths.push(path); signals.push(options.signal); return new Promise(() => {}); };
  const { node, document, extension, widget, anchor, dialog } = await openQuickPick(pending);
  assert.equal(signals.length, 3);
  const input = labelled(dialog, 'Search LoRAs');
  input.value = 'ink';
  input.dispatchEvent(new Event('input'));
  widget.onRemove();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(paths.length, 3);
  const loader = { prototype: {} };
  extension.beforeRegisterNodeDef(loader, { name: 'MooBoxLoraLoader' });
  anchor.click();
  loader.prototype.onRemoved.call(node);
  assert.equal(document.body.children.length, 0);
  assert.ok(signals.every((signal) => signal.aborted));
  anchor.click();
  const backdrop = document.body.children[0];
  backdrop.children[0].dispatchEvent(new Event('pointerdown'));
  assert.equal(document.body.children.length, 1);
  backdrop.dispatchEvent(new Event('pointerdown'));
  assert.equal(document.body.children.length, 0);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(document.listeners.size, 0);
});

test('a connected trigger node never sends its saved source, an unconnected one does', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify(state.reconcileWords({ groups: [] }, 'alpha,, beta', true));
  node.inputs = [{ name: 'trigger_words', link: null }];
  assert.equal(JSON.parse(widget.serializeValue()).source, 'alpha,, beta');
  node.inputs[0].link = 3;
  assert.equal(JSON.parse(widget.serializeValue()).source, '');
  assert.equal(JSON.parse(widget.serializeValue()).groups.length, 2);
  assert.equal(JSON.parse(widget.value).source, 'alpha,, beta');
});

test('absent groups can be forgotten on request', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify(state.reconcileWords(state.reconcileWords({ groups: [] }, 'alpha,, beta'), 'alpha'));
  assert.ok(find(widget.element, (el) => el.textContent === 'Not in source (1)'));
  const list = find(widget.element, (el) => el.className === 'mb-list');
  assert.deepEqual(list.children.map((box) => box.className), ['mb-card mb-group', 'mb-absent']);
  const parked = list.children[1];
  assert.equal(labelled(parked, 'Enable group alpha'), undefined);
  assert.ok(labelled(parked, 'Toggle word beta'));
  const enable = labelled(parked, 'Enable group beta');
  enable.checked = !enable.checked;
  enable.dispatchEvent(new Event('change'));
  const beta = JSON.parse(widget.value).groups[1];
  assert.deepEqual([beta.text, beta.active, beta.present], ['beta', enable.checked, false]);
  labelled(widget.element, 'Remove saved selections of groups the source no longer contains').click();
  assert.deepEqual(JSON.parse(widget.value).groups.map((group) => group.text), ['alpha']);
  assert.equal(labelled(widget.element, 'Remove saved selections of groups the source no longer contains'), undefined);
});

test('pill view keeps absent pills editable in their own section and can forget them', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  const value = state.reconcileWords(state.reconcileWords({ groups: [] }, 'alpha,, beta, gamma'), 'alpha');
  widget.value = JSON.stringify({ ...value, view: 'pills' });
  const parked = find(widget.element, (el) => el.className === 'mb-absent');
  labelled(parked, 'Toggle word gamma').click();
  const beta = JSON.parse(widget.value).groups[1];
  assert.deepEqual([beta.active, beta.present, beta.items.map((item) => item.active)], [true, false, [false, true]]);
  labelled(widget.element, 'Remove saved selections of groups the source no longer contains').click();
  assert.deepEqual(JSON.parse(widget.value).groups.map((group) => group.text), ['alpha']);
  assert.equal(find(widget.element, (el) => el.className === 'mb-absent'), undefined);
});

test('absent groups sit in a separate section after the present ones in both views', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  const value = state.reconcileWords(state.reconcileWords({ groups: [] }, 'alpha,, beta, gamma,, delta'), 'alpha,, delta');
  const absentSection = () => find(widget.element, (el) => el.className === 'mb-absent');

  widget.value = JSON.stringify({ ...value, view: 'pills' });
  const list = find(widget.element, (el) => el.className === 'mb-list');
  assert.deepEqual(list.children.map((el) => el.className), ['mb-pills', 'mb-absent']);
  const words = (el) => el.children.map((pill) => pill.children[0].textContent);
  assert.deepEqual(words(list.children[0]), ['alpha', 'delta']);
  assert.ok(find(absentSection(), (el) => el.textContent === 'Not in source (1)'));
  assert.ok(labelled(absentSection(), 'Remove saved selections of groups the source no longer contains'));
  assert.deepEqual(words(find(absentSection(), (el) => el.className === 'mb-pills')), ['beta', 'gamma']);
  assert.equal(find(widget.element, (el) => el.className === 'mb-badge').textContent, '0/2 active');

  widget.value = JSON.stringify({ ...value, view: 'groups' });
  const cards = find(widget.element, (el) => el.className === 'mb-list').children;
  assert.deepEqual(cards.map((el) => el.className), ['mb-card mb-group', 'mb-card mb-group', 'mb-absent']);
  const name = (el) => find(el, (child) => child.className === 'mb-name').textContent;
  assert.deepEqual(cards.slice(0, 2).map(name), ['alpha', 'delta']);
  assert.equal(name(cards[2]), 'beta, gamma');
  assert.ok(find(cards[2], (el) => el.textContent === 'Not in source (1)'));

  widget.value = JSON.stringify({ ...state.reconcileWords({ groups: [] }, 'alpha'), view: 'pills' });
  assert.equal(absentSection(), undefined);
  widget.value = JSON.stringify({ ...state.reconcileWords({ groups: [] }, 'alpha'), view: 'groups' });
  assert.equal(absentSection(), undefined);
});

test('loader re-renders only rewrite connected trigger nodes when the words change', async () => {
  const { node, extension } = await harness();
  let writes = 0;
  const target = { comfyClass: 'MooBoxTriggerWords', widgets: [{ name: 'selection', get value() { return '{"source":"","groups":[]}'; }, set value(_) { writes++; } }] };
  node.outputs = [{}, {}, { links: [1] }];
  Object.assign(node.graph, { links: { 1: { target_id: 7 } }, getNodeById: () => target });
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', strength: 1, clipStrength: 1, words: ['a'] }]);
  const before = writes;
  labelled(widget.element, 'Show link and CLIP settings for alpha').click();
  assert.equal(writes, before);
  const enable = labelled(widget.element, 'Enable alpha');
  enable.checked = false;
  enable.dispatchEvent(new Event('change'));
  assert.equal(writes, before + 1);
  widget.onRemove();
});

test('LoRA Manager sends add LoRAs at once and then complete their file name and trigger words', async () => {
  let adapter;
  const notified = [];
  const lmApi = {
    LORA_NODE_ADAPTER_API_VERSION: 1,
    registerLoraNodeAdapter: (value) => { adapter = value; },
    notifyLoraNodeChanged: (node) => notified.push(node),
  };
  const { node, extension } = await harness(async (path) => {
    if (path.includes('/search?q=ink')) return { ok: true, json: async () => ({ names: ['pink.safetensors', 'style\\ink.safetensors'], total: 2 }) };
    if (path.includes('/words?name=style%5Cink.safetensors')) return { ok: true, json: async () => ({ words: ['inked'] }) };
    throw new Error(`unexpected ${path}`);
  }, { '/extensions/comfyui-lora-manager/lora_node_adapters.js': lmApi });
  await extension.setup();
  assert.equal(adapter.id, 'moobox');
  assert.deepEqual([...adapter.nodeClasses], ['MooBoxLoraLoader']);
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'old.safetensors', strength: 1, clipStrength: 1, linked: true, active: true, words: [] }]);
  adapter.applyLoraCode({ node, loraCode: '<lora:style/ink:0.6>', mode: 'append' });
  assert.deepEqual(JSON.parse(widget.value).map((entry) => entry.name), ['old.safetensors', 'style/ink']);
  assert.deepEqual([...adapter.getActiveLoraNames(node)], ['old.safetensors', 'style/ink']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(widget.value)[1], { name: 'style\\ink.safetensors', words: ['inked'], strength: 0.6, clipStrength: 0.6, linked: true, active: true });
  assert.equal(notified.at(-1), node);
  adapter.applyLoraCode({ node, loraCode: '<lora:ink:0.9>', mode: 'replace' });
  assert.deepEqual(JSON.parse(widget.value), [{ name: 'style\\ink.safetensors', words: ['inked'], strength: 0.9, clipStrength: 0.9, linked: true, active: true }]);
  assert.deepEqual([...adapter.getActiveLoraNames({ widgets: [] })], []);
  widget.onRemove();
});

test('the loader keeps working when LoRA Manager is not installed', async () => {
  const warnings = [];
  const { node, extension } = await harness(undefined, {}, { warn: (...args) => warnings.push(args) });
  await extension.setup();
  assert.equal(warnings.length, 1);
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'alpha', active: true, strength: 1, clipStrength: 1, words: [] }]);
  labelled(widget.element, 'Remove alpha').click();
  assert.deepEqual(JSON.parse(widget.value), []);
  widget.onRemove();
});

test('pill view toggles single words and keeps other words in a disabled group off', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify({ ...state.reconcileWords({ groups: [] }, 'alpha, beta'), view: 'pills' });
  assert.equal(find(widget.element, (el) => el.className?.startsWith('mb-card')), undefined);
  labelled(widget.element, 'Toggle word beta').click();
  const saved = JSON.parse(widget.value);
  assert.equal(saved.view, 'pills');
  assert.equal(saved.groups[0].active, true);
  assert.deepEqual(saved.groups[0].items.map((item) => item.active), [false, true]);
  const weight = labelled(widget.element, 'Word weight beta');
  weight.value = '0.6';
  weight.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(widget.value).groups[0].items[1].strength, 0.6);
  labelled(widget.element, 'Toggle word beta').click();
  assert.equal(JSON.parse(widget.value).groups[0].items[1].active, false);
});

test('loader and trigger widgets use mb- classes whose colours all come from tokens.css', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(await read('../web/widgets.js'), /kt-/);
  assert.match(await read('../web/moobox.css'), /css\/loras\.css/);
  assert.doesNotMatch(await read('../web/css/loras.css'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i);
});
