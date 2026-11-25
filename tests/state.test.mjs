import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeLoraNames, activeWords, addLora, allWords, blockGroups, filterCount, filterLabel, folderRows, infoTabs, libraryRows, loraDetails, loraLabel, markdownBlocks, mergeLoraCode, parentFolder, pickerRows, pickLora, plainText, recipeEntries, recipeMeta, recipeRows, reconcileWords, rememberRecent, sameLora, splitWords, triggerGroups } from '../web/state.js';

test('labels split a LoRA name into its title and folder', () => {
  assert.deepEqual(loraLabel('chars\\style/ink.safetensors'), { title: 'ink', folder: 'chars / style' });
  assert.deepEqual(loraLabel('plain.pt'), { title: 'plain', folder: '' });
});

test('picking a saved LoRA switches it on instead of adding it twice', () => {
  const entries = [{ name: 'style\\ink.safetensors', strength: 0.4, clipStrength: 0.4, active: false, words: ['inked'] }];
  const enabled = pickLora(entries, { name: 'style/ink.safetensors', strength: 1, clipStrength: 1, active: true, words: [] });
  assert.deepEqual(enabled, [{ name: 'style\\ink.safetensors', strength: 0.4, clipStrength: 0.4, active: true, words: ['inked'] }]);
  assert.equal(entries[0].active, false);
  assert.equal(pickLora(entries, { name: 'ink.safetensors', active: true }).length, 2);
});

test('picker rows mark saved LoRAs as added or off and leave folders alone', () => {
  const entries = [{ name: 'a\\on.safetensors' }, { name: 'off.safetensors', active: false }];
  const rows = libraryRows([{ relative_path: 'a/on.safetensors', model_name: 'On' }, { relative_path: 'off' }, { relative_path: 'new.safetensors' }, { model_name: 'no path' }]);
  assert.deepEqual(pickerRows([{ type: 'folder', name: 'a', path: 'a', count: 1 }, ...rows], entries), [
    { type: 'folder', name: 'a', path: 'a', count: 1 },
    { type: 'lora', path: 'a/on.safetensors', title: 'On', badge: 'Added' },
    { type: 'lora', path: 'off', title: 'off', badge: 'Off' },
    { type: 'lora', path: 'new.safetensors', title: 'new', badge: '' },
  ]);
  assert.deepEqual(libraryRows(undefined), []);
});

test('folder rows list subfolders with their path and count before the folder\'s LoRAs', () => {
  const root = { count: 3, items: [{ relative_path: 'top', model_name: 'Top' }], folders: {
    styles: { count: 2, items: [{ relative_path: 'styles/ink', model_name: 'Ink' }], folders: { old: { count: 1, items: [], folders: {} } } },
  } };
  assert.deepEqual(folderRows(root, ''), [{ type: 'folder', name: 'styles', path: 'styles', count: 2 }, { type: 'lora', path: 'top', title: 'Top' }]);
  assert.deepEqual(folderRows(root, 'styles'), [{ type: 'folder', name: 'old', path: 'styles/old', count: 1 }, { type: 'lora', path: 'styles/ink', title: 'Ink' }]);
  assert.deepEqual(folderRows(root, 'styles/old'), []);
  assert.equal(folderRows(root, 'gone'), null);
  assert.equal(parentFolder('styles/old'), 'styles');
  assert.equal(parentFolder('styles'), '');
});

test('recent picks move to the front without duplicates or badges and are capped', () => {
  let recent = [];
  for (const path of ['a', 'b', 'a', 'c']) recent = rememberRecent(recent, { type: 'lora', path, title: path.toUpperCase(), badge: 'Added' }, 2);
  assert.deepEqual(recent, [{ type: 'lora', path: 'c', title: 'C' }, { type: 'lora', path: 'a', title: 'A' }]);
});

test('the filter count matches LoRA Manager\'s badge and labels the button', () => {
  assert.equal(filterCount(null), 0);
  assert.equal(filterCount({ activeFolder: 'null', recursiveSearch: true, filters: {} }), 0);
  assert.equal(filterCount({ activeFolder: 'styles', filters: { baseModel: ['SDXL 1.0', '__EMPTY_WILDCARD_RESULT__', ''], tags: { ink: 'include', sketch: 'exclude' }, autoTags: {}, license: { noCredit: 'include' }, modelTypes: ['LoRA'] } }), 6);
  assert.equal(filterCount({ recursiveSearch: false, filters: null }), 1);
  assert.equal(filterLabel(0), 'Filters');
  assert.equal(filterLabel(3), 'Filters · 3');
});

test('recipes keep their LoRAs with strength and status and add only the ones in the library', () => {
  const [recipe, empty] = recipeRows([
    { id: 7, title: 'Ink portrait', file_url: '/api/lm/recipes/7.webp', base_model: 'SDXL 1.0', loras: [
      { file_name: 'ink', modelName: 'Ink Style', strength: 0.6, inLibrary: true },
      { file_name: 'gone', strength: '0.4', isDeleted: true },
      { file_name: 'remote', weight: 0.8, inLibrary: false },
      { file_name: 'skipped', exclude: true },
      { name: 'legacy' },
    ] },
    { id: 'x', loras: [] },
    { title: 'no id' },
  ]);
  assert.deepEqual(recipe.loras, [
    { name: 'ink', title: 'Ink Style', strength: 0.6, status: 'ready' },
    { name: 'gone', title: 'gone', strength: 0.4, status: 'deleted' },
    { name: 'remote', title: 'remote', strength: 0.8, status: 'missing' },
    { name: 'legacy', title: 'legacy', strength: 1, status: 'ready' },
  ]);
  assert.deepEqual([recipe.id, recipe.title, recipe.preview, recipeMeta(recipe)], ['7', 'Ink portrait', '/api/lm/recipes/7.webp', '4 LoRAs · SDXL 1.0']);
  assert.deepEqual(recipeEntries(recipe), [
    { name: 'ink', strength: 0.6, clipStrength: 0.6, linked: true, active: true, words: [] },
    { name: 'legacy', strength: 1, clipStrength: 1, linked: true, active: true, words: [] },
  ]);
  assert.deepEqual([empty.title, recipeMeta(empty), recipeEntries(empty)], ['Untitled recipe', '0 LoRAs', []]);
  assert.equal(recipeRows(undefined).length, 0);
});

test('details read usage tips from JSON text or objects and fall back for missing fields', () => {
  const details = loraDetails({ usage_tips: '{"strength": "0.75", "strength_min": 0.5, "strength_max": 1, "clip_skip": 2}', civitai: { trainedWords: ['ink'] } }, 'style/ink.safetensors');
  assert.deepEqual(details, { title: 'ink', preview: '', baseModel: 'Base model unknown', words: ['ink'], strength: 0.75, tips: 'Range 0.5–1 · CLIP skip 2', description: '' });
  assert.equal(loraDetails({ usage_tips: 'not json' }, 'a').strength, undefined);
  assert.equal(loraDetails({ usage_tips: { strength: 1, clip_strength: 0.6 } }, 'a').tips, 'CLIP 0.6');
  assert.equal(loraDetails({ model_name: 'Ink', modelDescription: '<p>Model</p>' }, 'a').description, 'Model');
});

test('descriptions become plain text without markup', () => {
  assert.equal(plainText('<p>One<br>two</p><img src=x onerror=alert(1)><p>&lt;b&gt; &amp; &quot;three&quot;</p>'), 'One\ntwo\n<b> & "three"');
});

test('markdown headings stop at ### and paragraphs break on single newlines', () => {
  assert.deepEqual(markdownBlocks('# One\n## Two\n### Three\n#### Four'), [
    { type: 'heading', level: 1, runs: [{ text: 'One' }] },
    { type: 'heading', level: 2, runs: [{ text: 'Two' }] },
    { type: 'heading', level: 3, runs: [{ text: 'Three' }] },
    { type: 'paragraph', runs: [{ text: '#### Four' }] },
  ]);
  assert.deepEqual(markdownBlocks('one\ntwo\n\nthree'), [
    { type: 'paragraph', runs: [{ text: 'one\ntwo' }] },
    { type: 'paragraph', runs: [{ text: 'three' }] },
  ]);
});

test('markdown bold and italic need word boundaries for underscores and can be escaped', () => {
  assert.deepEqual(markdownBlocks('**a** __b__ *c* _d_ e_f_g \\*h\\*').at(0).runs, [
    { text: 'a', bold: true }, { text: ' ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true },
    { text: ' ' }, { text: 'd', italic: true }, { text: ' e_f_g *h*' },
  ]);
});

test('markdown inline code stays raw, is not merged with neighbouring text and needs a single backtick pair', () => {
  assert.deepEqual(markdownBlocks('a `**b**` c``d`').at(0).runs, [
    { text: 'a ' }, { text: '**b**', code: true }, { text: ' c``d`' },
  ]);
});

test('markdown lists collect consecutive bullets with -, * or +', () => {
  assert.deepEqual(markdownBlocks('- a\n* **b**\n+ c\n\n- d'), [
    { type: 'list', items: [[{ text: 'a' }], [{ text: 'b', bold: true }], [{ text: 'c' }]] },
    { type: 'list', items: [[{ text: 'd' }]] },
  ]);
});

test('markdown tables need pipes in both rows and take alignment from the separator', () => {
  assert.deepEqual(markdownBlocks('| Name | Size | Note |\n| :--- | :---: | ---: |\n| ink | 1 | **big** |\n| pen | 2 |'), [{
    type: 'table',
    align: ['left', 'center', 'right'],
    head: [[{ text: 'Name' }], [{ text: 'Size' }], [{ text: 'Note' }]],
    rows: [[[{ text: 'ink' }], [{ text: '1' }], [{ text: 'big', bold: true }]], [[{ text: 'pen' }], [{ text: '2' }]]],
  }]);
  assert.deepEqual(markdownBlocks('x | y\n---'), [{ type: 'paragraph', runs: [{ text: 'x | y\n---' }] }]);
});

test('markdown links and images keep only their label and HTML or code stay text', () => {
  const links = JSON.stringify(markdownBlocks('[site](https://evil.test) and ![pic](x.png)'));
  assert.equal(links, '[{"type":"paragraph","runs":[{"text":"site and pic"}]}]');
  assert.deepEqual(markdownBlocks('<img src=x onerror=alert(1)>\n```js\nlet a = 1;\n```').at(0).runs, [
    { text: '<img src=x onerror=alert(1)>\n```js\nlet a = 1;\n```' },
  ]);
  assert.deepEqual(markdownBlocks(''), []);
  assert.deepEqual(markdownBlocks(' \n\n'), []);
});

test('trigger groups are trimmed copyable entries and copy all joins them', () => {
  const groups = triggerGroups(['alpha, ink,', ' bold ', ', ', '(soft:1.2)']);
  assert.deepEqual(groups, ['alpha, ink', 'bold', '(soft:1.2)']);
  assert.equal(allWords(groups), 'alpha, ink, bold, (soft:1.2)');
  assert.equal(allWords([]), '');
  assert.deepEqual(loraDetails({ civitai: { trainedWords: [' ink, '] } }, 'a').words, ['ink']);
});

test('info tabs show Blocks only when the schema has blocks', () => {
  assert.deepEqual(infoTabs([{ group: 'IN', ids: ['IN01'] }]), ['Overview', 'Description', 'Blocks', 'Notes']);
  assert.deepEqual(infoTabs([]), ['Overview', 'Description', 'Notes']);
});

test('block schemas group block ids in schema order', () => {
  assert.deepEqual(blockGroups([{ id: 'IN01', group: 'IN' }, { id: 'MID', group: 'MID' }, { id: 'IN02', group: 'IN' }]), [{ group: 'IN', ids: ['IN01', 'IN02'] }, { group: 'MID', ids: ['MID'] }]);
  assert.deepEqual(blockGroups([]), []);
});

test('splits commas while preserving weighted and escaped parentheses', () => {
  assert.deepEqual(splitWords('alpha, (beta, gamma:0.8), cat \\(ears\\)'), ['alpha', '(beta, gamma:0.8)', 'cat \\(ears\\)']);
  assert.deepEqual(splitWords('alpha, beta,, gamma', true), ['alpha, beta', 'gamma']);
});

test('adding a duplicate preserves strengths and disabled state', () => {
  const entries = [{ name: 'alpha', active: false, strength: 0.4 }];
  assert.equal(addLora(entries, { name: 'alpha', strength: 1 }), entries);
  assert.equal(addLora(entries, { name: 'beta', strength: 0.7 }).length, 2);
});

test('repeated source updates preserve groups, children and weights', () => {
  let state = reconcileWords({ groups: [] }, 'alpha, beta,, gamma');
  state.groups[0].items[1].active = false;
  state.groups[0].strength = 0.8;
  state.groups[1].active = false;
  for (let i = 0; i < 5; i++) state = reconcileWords(JSON.parse(JSON.stringify(state)), state.source);
  assert.equal(state.groups[0].items[1].active, false);
  assert.equal(state.groups[0].strength, 0.8);
  assert.equal(state.groups[1].active, false);
});

test('temporarily removed LoRAs retain their selections when restored', () => {
  let state = reconcileWords({ groups: [] }, 'alpha,, beta');
  state.groups[0].active = false;
  state = reconcileWords(state, 'beta');
  assert.equal(state.groups.find((group) => group.text === 'alpha').present, false);
  state = reconcileWords(state, 'beta,, alpha');
  assert.equal(state.groups[1].active, false);
  assert.equal(state.groups[1].present, true);
});

test('default_active affects only new groups', () => {
  const initial = reconcileWords({ groups: [] }, 'alpha', true);
  const updated = reconcileWords(initial, 'alpha,, beta', false);
  assert.equal(updated.groups[0].active, true);
  assert.equal(updated.groups[1].active, false);
});

test('duplicate groups keep independent selections and identity order', () => {
  let state = reconcileWords({ groups: [] }, 'alpha,, alpha', true);
  state.groups[1].active = false;
  state = reconcileWords(state, state.source, true);
  assert.deepEqual(state.groups.map((group) => group.active), [true, false]);
});

test('groups match despite trailing commas and drop saved duplicates', () => {
  const state = { groups: [
    { text: 'alpha,', active: false, strength: 0.7, items: [{ text: 'alpha', active: true }] },
    { text: 'beta, gamma', active: false, strength: 1, items: [] },
    { text: 'alpha', active: true, strength: 1, items: [] },
    { text: 'delta', active: true, strength: 1, items: [] },
  ] };
  const result = reconcileWords(state, 'alpha,,, beta, gamma,', true);
  assert.deepEqual(result.groups.map((group) => [group.text, group.present, group.active]), [
    ['alpha', true, false],
    ['beta, gamma,', true, false],
    ['delta', false, true],
  ]);
  assert.equal(result.groups[0].strength, 0.7);
});

test('sent lora tags parse names with folders and omitted or separate strengths', () => {
  const result = mergeLoraCode([], '<lora:style/ink:0.8:0.5> <lora:glow:-.5> <lora:plain>', 'append');
  assert.deepEqual(result, [
    { name: 'style/ink', words: [], strength: 0.8, clipStrength: 0.5, linked: false, active: true },
    { name: 'glow', words: [], strength: -0.5, clipStrength: -0.5, linked: true, active: true },
    { name: 'plain', words: [], strength: 1, clipStrength: 1, linked: true, active: true },
  ]);
});

test('sent names match saved file names without extension and by trailing folders', () => {
  assert.ok(sameLora('chars\\style\\ink.safetensors', 'ink'));
  assert.ok(sameLora('chars/style/ink.safetensors', 'style/ink'));
  assert.ok(!sameLora('chars/pink.safetensors', 'ink'));
  assert.ok(!sameLora('chars/ink.safetensors', 'style/ink'));
});

test('append switches a saved LoRA on with the sent strength instead of adding it twice', () => {
  const entries = [
    { name: 'a/ink.safetensors', strength: 0.3, clipStrength: 0.3, linked: true, active: false, words: ['inked'] },
    { name: 'b.safetensors', strength: 1, clipStrength: 1, linked: true, active: true, words: [] },
  ];
  const result = mergeLoraCode(entries, '<lora:ink:0.7> <lora:new:1> <lora:new:0.4>', 'append');
  assert.deepEqual(result.map((entry) => entry.name), ['a/ink.safetensors', 'b.safetensors', 'new']);
  assert.deepEqual(result[0], { name: 'a/ink.safetensors', strength: 0.7, clipStrength: 0.7, linked: true, active: true, words: ['inked'] });
  assert.equal(result[2].strength, 0.4);
  assert.equal(entries[0].active, false);
});

test('replace keeps only sent LoRAs in sent order and reuses their saved entries', () => {
  const entries = [
    { name: 'a/ink.safetensors', strength: 0.3, clipStrength: 0.3, linked: true, active: false, words: ['inked'] },
    { name: 'b.safetensors', strength: 1, clipStrength: 1, linked: true, active: true, words: [] },
  ];
  const result = mergeLoraCode(entries, '<lora:new:0.5> <lora:a/ink:0.9>', 'replace');
  assert.deepEqual(result.map((entry) => [entry.name, entry.active, entry.strength]), [['new', true, 0.5], ['a/ink.safetensors', true, 0.9]]);
  assert.deepEqual(result[1].words, ['inked']);
  assert.deepEqual(mergeLoraCode(entries, '', 'replace'), []);
  assert.equal(mergeLoraCode(entries, 'no tags', 'append').length, 2);
});

test('active LoRA names list stored names of enabled entries only', () => {
  assert.deepEqual(activeLoraNames([{ name: 'a\\one.safetensors', active: true }, { name: 'two', active: false }, { name: 'three' }]), ['a\\one.safetensors', 'three']);
  assert.deepEqual(activeLoraNames([]), []);
});

test('only active entries and active node modes produce live trigger previews', () => {
  const entries = [{ active: true, words: ['alpha'] }, { active: false, words: ['beta'] }];
  assert.equal(activeWords(entries), 'alpha');
  assert.equal(activeWords(entries, 4), '');
  assert.equal(activeWords(entries, 2), '');
});
