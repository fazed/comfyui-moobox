import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupIsOn, nodesInside, nodesToSwitch, parseColors, pickGroups } from '../web/groupstate.js';

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
  assert.deepEqual(titles(pickGroups([...groups], { title: '(nothing' })), []);
  const colors = parseColors('blue, #3B4A5A', { blue: { groupcolor: '#88A' } });
  assert.deepEqual(colors, ['#88a', '#3b4a5a']);
  assert.deepEqual(titles(pickGroups([...groups], { colors })), ['A  Models']);
});

test('a literal title matches itself even when it contains regex characters', () => {
  const refine = [{ group: { title: 'Refine Passes (off by default)', pos: [0, 0] }, order: 0, path: [] }];
  assert.equal(pickGroups([...refine], { title: 'Refine Passes (off by default)' }).length, 1);
  assert.equal(pickGroups([...refine], { title: 'passes (OFF' }).length, 1);
  assert.equal(pickGroups([...refine], { title: '^refine.*default\\)$' }).length, 1);
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

test('a muted node in a bypass group survives an off/on cycle', () => {
  const nodes = [{ mode: 0 }, { mode: 2 }, { mode: 0 }];
  assert.deepEqual(nodesToSwitch(nodes, true, 4), [nodes[0], nodes[2]]);
  for (const node of nodesToSwitch(nodes, true, 4)) node.mode = 4;
  assert.deepEqual(nodesToSwitch(nodes, false, 4), [nodes[0], nodes[2]]);
  for (const node of nodesToSwitch(nodes, false, 4)) node.mode = 0;
  assert.deepEqual(nodes.map((node) => node.mode), [0, 2, 0]);
  assert.deepEqual(nodesToSwitch([{ mode: 2 }], false, 4), [{ mode: 2 }]);
});

test('finds nodes by centre from pos and size, ignoring boundingRect', () => {
  const nodes = [{ pos: [0, 0], size: [340, 90] }, { pos: [-500, 0], size: [420, 110] }, { pos: [1500, 200], size: [100, 50] }];
  assert.equal(nodesInside([-40, -110, 1540, 954], nodes, 30).length, 1);
  assert.equal(nodesInside([-600, -110, 600, 954], nodes, 30).length, 1);
  assert.equal(nodesInside([1460, -110, 1540, 954], nodes, 30).length, 1);
});
