import test from "node:test";
import assert from "node:assert/strict";
import { createStatsWidget, statsState } from "../web/statswidget.js";

class Node {
  children = [];
  textContent = "";
  style = {};
  parentElement = null;
  classList = { toggle() {} };
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  prepend(child) { this.append(child); }
  remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
}
const all = node => [node, ...node.children.flatMap(all)];
const values = node => all(node).filter(n => n.className === "mbj-stats-value").map(n => n.textContent);
const flush = () => new Promise(resolve => queueMicrotask(() => setImmediate(resolve)));

function setup() {
  const saved = Object.fromEntries(["document", "setInterval", "clearInterval"].map(key => [key, globalThis[key]]));
  const timers = new Map();
  let next = 0;
  globalThis.setInterval = (fn, ms) => { timers.set(++next, { fn, ms }); return next; };
  globalThis.clearInterval = id => timers.delete(id);
  const bar = new Node();
  globalThis.document = { createElement: () => new Node(), body: new Node(), hidden: false, querySelector: () => bar };
  const requests = [];
  let cpu = 40;
  const api = { fetchApi: async (url, options) => { requests.push(options.signal); return { ok: true, json: async () => ({ cpu: cpu++, ram: { used: 1, total: 4 }, vram: null }) }; } };
  return { timers, bar, requests, api, restore: () => Object.assign(globalThis, saved) };
}

test("system stats show percentages, GB details and a dash for missing values", () => {
  const GB = 1024 ** 3;
  const [cpu, ram, vram] = statsState({ cpu: 12.4, ram: { used: 8 * GB, total: 32 * GB }, vram: { used: 30 * GB, total: 24 * GB } });
  assert.deepEqual(cpu, { name: "CPU", percent: 12.4, value: "12%", title: "CPU 12%" });
  assert.deepEqual([ram.percent, ram.value, ram.title], [25, "25%", "RAM 8.0 of 32.0 GB"]);
  assert.deepEqual([vram.percent, vram.value], [100, "125%"]);
  const offline = statsState(null);
  assert.deepEqual(offline.map(item => [item.name, item.percent, item.value]), [["CPU", null, "—"], ["RAM", null, "—"], ["VRAM", null, "—"]]);
  assert.equal(statsState({ cpu: 5, ram: { used: 1, total: 2 }, vram: null })[2].title, "VRAM not available");
});

test("stats dock in the action bar, fetch once per tick, skip while hidden, refresh on click and stop on close", async () => {
  const env = setup();
  try {
    const stats = createStatsWidget(env.api, 2000);
    assert.equal(env.bar.children[0].className, "mbj-stats");
    await flush();
    assert.deepEqual(values(env.bar), ["40%", "25%", "—"]);
    assert.equal(env.requests.length, 1);
    assert.deepEqual([...env.timers.values()].map(timer => timer.ms), [2000]);

    const [{ fn: tick }] = env.timers.values();
    tick();
    await flush();
    assert.equal(env.requests.length, 2);
    assert.equal(values(env.bar)[0], "41%");

    document.hidden = true;
    tick();
    assert.equal(env.requests.length, 2);
    document.hidden = false;
    stats.setVisible(false);
    tick();
    assert.equal(env.requests.length, 2);
    stats.setVisible(true);

    env.bar.children[0].onclick();
    assert.equal(env.requests.length, 3);

    stats.close();
    assert.equal(env.timers.size, 0);
    assert.equal(env.bar.children.length, 0);
    assert.ok(env.requests.every(signal => signal.aborted));
  } finally {
    env.restore();
  }
});

test("interval Off starts no timer and a new interval replaces the old timer", async () => {
  const env = setup();
  try {
    const stats = createStatsWidget(env.api, 0);
    await flush();
    assert.equal(env.timers.size, 0);
    assert.equal(env.requests.length, 1);

    stats.setRate(5000);
    stats.setRate(1000);
    assert.deepEqual([...env.timers.values()].map(timer => timer.ms), [1000]);
    stats.setRate(0);
    assert.equal(env.timers.size, 0);
    stats.close();
  } finally {
    env.restore();
  }
});
