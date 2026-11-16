import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupIsOn, parseColors, pickGroups } from '../web/groupstate.js';

const groups = [
  { group: { title: 'B  Detailers', color: '#3F789E', pos: [0, 400] }, order: 0, path: [] },
  { group: { title: 'A  Models', color: '#3b4a5a', pos: [0, 0] }, order: 0, path: [] },
  { group: { title: 'Face [x', color: '#3F789E', pos: [100, 0] }, order: 0, path: [] },
  { group: { title: 'Sub Hair', color: '#3F789E', pos: [0, -50] }, path: ['Detailers: SFW'], order: 1 },
];
const titles = (picked) => picked.map((entry) => entry.group.title);

test('sorts by graph then position, and by alphanumeric title', () => {
  assert.deepEqual(titles(pickGroups([...groups], {})), ['A  Models', 'Face [x', 'B  Detailers', 'Sub Hair']);
  assert.deepEqual(titles(pickGroups([...groups], { sort: 'alphanumeric' })), ['A  Models', 'B  Detailers', 'Face [x', 'Sub Hair']);
});

test('filters on regex, falls back to text for invalid regex, and on colors', () => {
  assert.deepEqual(titles(pickGroups([...groups], { title: 'detail|models' })), ['A  Models', 'B  Detailers']);
  assert.deepEqual(titles(pickGroups([...groups], { title: '[x' })), ['Face [x']);
  const colors = parseColors('blue, #3B4A5A', { blue: { groupcolor: '#88A' } });
  assert.deepEqual(colors, ['#88a', '#3b4a5a']);
  assert.deepEqual(titles(pickGroups([...groups], { colors })), ['A  Models']);
});

test('a group is on while any node is active', () => {
  assert.equal(groupIsOn([{ mode: 4 }, { mode: 0 }]), true);
  assert.equal(groupIsOn([{ mode: 4 }, { mode: 2 }]), false);
  assert.equal(groupIsOn([]), false);
});

test('subgraph filter takes a subgraph and the ones inside it, never the root', () => {
  const nested = [...groups, { group: { title: 'Deep', color: '#000', pos: [0, 0] }, path: ['Detailers: SFW', 'Inner'], order: 2 }];
  assert.deepEqual(titles(pickGroups([...nested], { subgraph: 'Detailers: SFW' })), ['Sub Hair', 'Deep']);
  assert.deepEqual(titles(pickGroups([...nested], { subgraph: 'Detailers: SFW › Inner' })), ['Deep']);
  assert.deepEqual(titles(pickGroups([...nested], { subgraph: 'Detailers' })), []);
  assert.equal(pickGroups([...nested], { subgraph: '(all)' }).length, 5);
});
