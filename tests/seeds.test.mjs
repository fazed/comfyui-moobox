import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import * as icons from '../web/icons.js';
import * as seedstate from '../web/seedstate.js';

const { afterRun, savedNode, stepSeed, validSeed } = seedstate;

// Loads seeds.js with a fake api whose queuePrompt succeeds or fails, and one Seeds node with id 3.
async function queueHarness(queue) {
  let value = JSON.stringify([{ seed: -1, last: null }, { seed: 10, mode: 'increment', last: null }]);
  const widget = { name: 'seeds', get value() { return value; }, set value(next) { value = next; } };
  const api = { queuePrompt: queue };
  const app = { registerExtension() {}, rootGraph: { getNodeById: (id) => (id === 3 ? { widgets: [widget] } : undefined) } };
  const url = new URL('../web/seeds.js', import.meta.url);
  const context = vm.createContext({ document: {}, JSON, Number, Math });
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { context, initializeImportMeta: (meta) => { meta.url = url.href; } });
  const mocks = { '../../scripts/app.js': { app }, '../../scripts/api.js': { api }, './icons.js': icons, './seedstate.js': seedstate, './styles.js': {} };
  await module.link((specifier) => new vm.SyntheticModule(Object.keys(mocks[specifier]), function () {
    for (const [name, item] of Object.entries(mocks[specifier])) this.setExport(name, item);
  }, { context }));
  await module.evaluate();
  const prompt = () => ({ output: { 3: { class_type: 'MooBoxSeeds', inputs: { seeds: '[-1,10]' } } }, workflow: { nodes: [{ id: 3, widgets_values: ['old'] }] } });
  return { api, widget, prompt };
}

test('seeds advance only after the prompt was accepted', async () => {
  const failing = await queueHarness(async () => { throw new Error('400 invalid prompt'); });
  const before = failing.widget.value;
  const rejected = failing.prompt();
  await assert.rejects(failing.api.queuePrompt(0, rejected));
  assert.equal(failing.widget.value, before);

  let sent;
  const ok = await queueHarness(async (index, prompt) => { sent = prompt; return { prompt_id: 'x' }; });
  const accepted = ok.prompt();
  await ok.api.queuePrompt(0, accepted);
  const used = JSON.parse(sent.output[3].inputs.seeds);
  assert.ok(used[0] >= 0);
  assert.equal(used[1], 10);
  assert.deepEqual(JSON.parse(accepted.workflow.nodes[0].widgets_values[0]).map((entry) => entry.seed), used);
  const after = JSON.parse(ok.widget.value);
  assert.deepEqual(after.map((entry) => entry.seed), [-1, 11]);
  assert.deepEqual(after.map((entry) => entry.last), used);
});

test('seeds uses mb- classes whose colours all come from tokens.css', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(await read('../web/seeds.js'), /kt-/);
  const colour = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i;
  for (const sheet of ['../web/css/base.css', '../web/css/seeds.css']) assert.doesNotMatch(await read(sheet), colour, sheet);
});

test('after a run a seed follows its mode, and -1 stays random', () => {
  assert.equal(afterRun({ seed: -1, mode: 'increment' }, 41), -1);
  assert.equal(afterRun({ seed: 5, mode: 'increment' }, 5), 6);
  assert.equal(afterRun({ seed: 0, mode: 'decrement' }, 0), 0);
  assert.equal(afterRun({ seed: 7, mode: 'fixed' }, 7), 7);
  assert.equal(afterRun({ seed: 7 }, 7), 7);
  const next = afterRun({ seed: 7, mode: 'randomize' }, 7);
  assert.ok(Number.isSafeInteger(next) && next >= 0);
});

test('the stepper moves a seed by one, never below 0, and keeps -1 random on minus', () => {
  assert.equal(stepSeed(41, 1), 42);
  assert.equal(stepSeed(41, -1), 40);
  assert.equal(stepSeed(1, -1), 0);
  assert.equal(stepSeed(0, -1), 0);
  assert.equal(stepSeed(-1, -1), -1);
  assert.equal(stepSeed(-1, 1), 0);
  assert.equal(stepSeed(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
});

test('only -1 and non-negative integers are seeds', () => {
  assert.equal(validSeed(-1), true);
  assert.equal(validSeed(0), true);
  assert.equal(validSeed(-2), false);
  assert.equal(validSeed(1.5), false);
  assert.equal(validSeed(2 ** 60), false);
});

test('finds root and subgraph nodes of a prompt id in the saved workflow', () => {
  const workflow = {
    nodes: [{ id: 3, type: 'MooBoxSeeds' }, { id: 12, type: 'sub-a' }],
    definitions: { subgraphs: [
      { id: 'sub-a', nodes: [{ id: 34, type: 'MooBoxSeeds' }, { id: 8, type: 'sub-b' }] },
      { id: 'sub-b', nodes: [{ id: 2, type: 'MooBoxSeeds' }] },
    ] },
  };
  assert.equal(savedNode(workflow, '3'), workflow.nodes[0]);
  assert.equal(savedNode(workflow, '12:34'), workflow.definitions.subgraphs[0].nodes[0]);
  assert.equal(savedNode(workflow, '12:8:2'), workflow.definitions.subgraphs[1].nodes[0]);
  assert.equal(savedNode(workflow, '12:99'), undefined);
  assert.equal(savedNode(undefined, '3'), undefined);
});
