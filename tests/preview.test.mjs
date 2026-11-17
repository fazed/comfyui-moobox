import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterText, stepIndex } from '../web/previewstate.js';

test('previous and next wrap around at both ends', () => {
  assert.equal(stepIndex(0, 1, 5), 1);
  assert.equal(stepIndex(4, 1, 5), 0);
  assert.equal(stepIndex(0, -1, 5), 4);
  assert.equal(stepIndex(2, -1, 5), 1);
  assert.equal(stepIndex(0, 1, 1), 0);
});

test('no images keeps the index at zero', () => {
  assert.equal(stepIndex(0, 1, 0), 0);
  assert.equal(stepIndex(0, -1, 0), 0);
});

test('counter shows the position out of the total', () => {
  assert.equal(counterText(1, 5), '2 / 5');
  assert.equal(counterText(0, 0), '0 / 0');
});
