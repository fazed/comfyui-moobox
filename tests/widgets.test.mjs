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

async function harness(fetchApi) {
  let extension;
  const document = {
    head: new Element(),
    createElement: () => { const el = new Element(); el.document = document; return el; },
  };
  const context = vm.createContext({ document, URL, AbortController, Event, structuredClone, setTimeout, clearTimeout });
  const source = await readFile(new URL('../web/widgets.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => { meta.url = new URL('../web/widgets.js', import.meta.url).href; },
  });
  const mocks = {
    '../../scripts/app.js': { app: { registerExtension: (value) => { extension = value; } } },
    '../../scripts/api.js': { api: { fetchApi, apiURL: (path) => path } },
    './state.js': state,
  };
  await module.link((specifier) => {
    const exports = mocks[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
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
  const results = find(widget.element, (el) => el.className === 'kt-results');
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
  const results = find(widget.element, (el) => el.className === 'kt-results');
  search.value = 'old'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  search.value = 'new'; search.dispatchEvent(new Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 220));
  resolveOld({ ok: true, json: async () => ({ names: ['old.safetensors'] }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(results.children[0].children[1].textContent, 'new');
  widget.onRemove();
});

test('trigger factory restores groups before interaction and preserves child switches', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  const value = state.reconcileWords({ groups: [] }, 'alpha, beta');
  value.groups[0].items[1].active = false;
  widget.value = JSON.stringify(value);
  assert.equal(find(widget.element, (el) => el.className === 'kt-words'), undefined);
  labelled(widget.element, 'Expand group alpha, beta').click();
  const words = find(widget.element, (el) => el.className === 'kt-words');
  assert.equal(find(words.children[1], (el) => el.type === 'checkbox').checked, false);
  const first = find(words.children[0], (el) => el.type === 'checkbox');
  first.checked = false;
  first.dispatchEvent(new Event('change'));
  assert.deepEqual(JSON.parse(widget.value).groups[0].items.map((item) => item.active), [false, false]);
});

test('trigger words take a per-word weight that defaults to 1', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify(state.reconcileWords({ groups: [] }, 'alpha, beta'));
  labelled(widget.element, 'Expand group alpha, beta').click();
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

test('pill view toggles single words and keeps other words in a disabled group off', async () => {
  const { node, extension } = await harness();
  const { widget } = extension.getCustomWidgets().MOOBOX_TRIGGERS(node, 'selection');
  widget.value = JSON.stringify({ ...state.reconcileWords({ groups: [] }, 'alpha, beta'), view: 'pills' });
  assert.equal(find(widget.element, (el) => el.className === 'kt-words'), undefined);
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
