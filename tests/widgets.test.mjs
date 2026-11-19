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
  classList = { add() {}, remove() {}, toggle() {} };
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
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

async function harness(fetchApi, dynamicModules = {}, console = globalThis.console) {
  let extension;
  const document = {
    head: new Element(),
    createElement: () => { const el = new Element(); el.document = document; return el; },
  };
  const context = vm.createContext({ document, URL, AbortController, Event, structuredClone, setTimeout, clearTimeout, console });
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
  return { node, document, extension };
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

test('every LoRA has an isolated browser link to the exact manager lookup', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_LORAS(node, 'loras');
  widget.value = JSON.stringify([{ name: 'styles/alpha & beta.safetensors', strength: 1, clipStrength: 1 }]);
  const link = labelled(widget.element, 'Open styles/alpha & beta.safetensors in LoRA Manager');
  assert.equal(new URL(link.href).searchParams.get('name'), 'styles/alpha & beta.safetensors');
  assert.equal(link.target, '_blank');
  assert.ok(link.rel.includes('noopener'));
  assert.equal(widget.computeLayoutSize().minHeight, 340);
  widget.onRemove();
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
