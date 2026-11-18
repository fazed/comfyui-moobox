import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

test('the manager page loads moobox.css', async () => {
  const web = new URL('../web/', import.meta.url);
  const read = (path) => readFile(new URL(path, web), 'utf8');
  assert.match(await read('open-manager.html'), /href="\.\/moobox\.css"/);
  assert.match(await read('moobox.css'), /css\/manager\.css/);
  assert.doesNotMatch(await read('css/manager.css'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i);
  assert.doesNotMatch(await read('styles.js'), /styles\.css/);
});

test('the pack has no kt-, mbj- or kc- classes, old sheets or colours outside tokens.css', async () => {
  const web = new URL('../web/', import.meta.url);
  const read = (path) => readFile(new URL(path, web), 'utf8');
  const files = (await readdir(web, { recursive: true })).map((name) => name.replaceAll('\\', '/'));
  for (const old of ['styles.css', 'jobs.css', 'compare.css']) assert.ok(!files.includes(old), old);
  assert.match(await read('moobox.css'), /css\/jobs\.css[\s\S]*css\/compare\.css/);
  for (const file of files.filter((name) => /\.(js|css|html)$/.test(name))) assert.doesNotMatch(await read(file), /\b(kt|mbj|kc)-/, file);
  for (const sheet of files.filter((name) => /^css\/.+\.css$/.test(name) && name !== 'css/tokens.css')) assert.doesNotMatch(await read(sheet), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i, sheet);
});
