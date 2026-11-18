import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { completion, currentToken, formatTags, parseTags, searchTags } from '../web/tags.js';

test('formatTags matches the Python format_tags on the shared cases', async () => {
  for (const [text, expected] of JSON.parse(await readFile(new URL('./format_cases.json', import.meta.url), 'utf8'))) assert.equal(formatTags(text), expected);
});

const entries = parseTags('long_hair,0,200,"nagahair,lh"\n1girl,0,900,\nsolo,50\nhair_ornament,0,10,null\nlong_sleeves\n"quoted,tag",5');

test('parses plain, counted and a1111 rows sorted by count', () => {
  assert.deepEqual(entries.map((entry) => entry.tag), ['1girl', 'long_hair', 'solo', 'hair_ornament', 'quoted,tag', 'long_sleeves']);
  assert.deepEqual(entries.find((entry) => entry.tag === 'long_hair').aliases, ['nagahair', 'lh']);
  assert.deepEqual(entries.find((entry) => entry.tag === 'hair_ornament').aliases, []);
});

test('prefix and alias matches come before substring matches', () => {
  assert.deepEqual(searchTags(entries, 'long h', 10).map((hit) => hit.tag), ['long_hair']);
  assert.deepEqual(searchTags(entries, 'hair', 10).map((hit) => hit.tag), ['hair_ornament', 'long_hair']);
  assert.deepEqual(searchTags(entries, 'lh', 10), [{ tag: 'long_hair', count: 200, alias: 'lh' }]);
  assert.equal(searchTags(entries, 'o', 1).length, 1);
  assert.deepEqual(searchTags(entries, '  ', 10), []);
});

test('finds the token before the caret and skips lora syntax and weights', () => {
  assert.deepEqual(currentToken('1girl, long ha'), { token: 'long ha', start: 7 });
  assert.deepEqual(currentToken('(solo:1.2), bl'), { token: 'bl', start: 12 });
  assert.equal(currentToken('1girl, '), null);
  assert.equal(currentToken('<lora:abc'), null);
  assert.equal(currentToken('(solo:1.'), null);
});

test('formats the accepted tag', () => {
  const on = { spaces: true, escape: true, comma: true };
  assert.equal(completion('', 'hatsune_miku_(cosplay)', on), 'hatsune miku \\(cosplay\\), ');
  assert.equal(completion(', solo', 'long_hair', on), 'long hair');
  assert.equal(completion('', '^_^', on), '^_^, ');
  assert.equal(completion('', 'score_9', on), 'score_9, ');
  assert.equal(completion('', 'long_hair', { spaces: false, escape: false, comma: false }), 'long_hair');
});

test('tag autocomplete and tag box use mb- classes whose colours all come from tokens.css', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  for (const file of ['../web/autocomplete.js', '../web/tagprompt.js']) assert.doesNotMatch(await read(file), /kt-|dataset\.kt/, file);
  assert.match(await read('../web/autocomplete.js'), /"mb-popup mb-menu mb-tag-popup"/);
  assert.match(await read('../web/moobox.css'), /css\/tags\.css/);
  assert.doesNotMatch(await read('../web/css/tags.css'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i);
});
