import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeLoraNames, activeWords, addLora, mergeLoraCode, reconcileWords, sameLora, splitWords } from '../web/state.js';

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
