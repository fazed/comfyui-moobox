import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickDetailCard, managerMatches, prepareManagerNavigation } from '../web/manager.js';

test('manager navigation matches exact filenames and folder boundaries', () => {
  const models = [
    { file_name: 'alpha', folder: 'art', file_path: 'C:/models/art/alpha.safetensors' },
    { file_name: 'alpha', folder: 'fanart', file_path: 'C:/models/fanart/alpha.safetensors' },
    { file_name: 'alphabet', folder: 'art' },
  ];
  assert.deepEqual(managerMatches(models, 'art\\alpha.safetensors'), [models[0]]);
  assert.deepEqual(managerMatches(models, 'alpha'), [models[0], models[1]]);
  assert.deepEqual(managerMatches(models, 'missing'), []);
});

test('manager handoff uses the selected file hash and touches only detail-navigation keys', () => {
  const values = new Map([['other', 'keep']]);
  const storage = { setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  prepareManagerNavigation(storage, { sha256: 'A'.repeat(64) });
  assert.equal(values.get('lora_manager_recipe_to_lora_filterLoraHash'), 'a'.repeat(64));
  assert.equal(values.get('lora_manager_viewLoraDetail'), 'true');
  assert.equal(values.get('other'), 'keep');
});

test('manager handoff reports unindexed files instead of opening an unrelated model', () => {
  assert.throws(() => prepareManagerNavigation({}, { sha256: '' }), /Rescan/);
});

test('the detail card is clicked only when the filter left exactly one model', () => {
  let clicks = 0;
  const card = { querySelector: () => ({ click: () => clicks++ }) };
  const doc = (cards) => ({ querySelectorAll: () => cards });
  assert.equal(clickDetailCard(doc([card, card])), false);
  assert.equal(clickDetailCard(doc([])), false);
  assert.equal(clickDetailCard(null), false);
  assert.equal(clickDetailCard(doc([card])), true);
  assert.equal(clicks, 1);
});
