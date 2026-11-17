import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeWords, addLora, reconcileWords, splitWords } from '../web/state.js';

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

test('only active entries and active node modes produce live trigger previews', () => {
  const entries = [{ active: true, words: ['alpha'] }, { active: false, words: ['beta'] }];
  assert.equal(activeWords(entries), 'alpha');
  assert.equal(activeWords(entries, 4), '');
  assert.equal(activeWords(entries, 2), '');
});
