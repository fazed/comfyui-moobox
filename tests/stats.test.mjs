import test from "node:test";
import assert from "node:assert/strict";
import { createStatsWidget, statsState } from "../web/statswidget.js";

class Node {
  children = [];
  textContent = "";
  style = {};
  parentElement = null;
  classList = { toggle() {} };
  setAttribute(name, value) { this[name] = value; }
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  prepend(child) { this.append(child); }
  remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
}
const all = node => [node, ...node.children.flatMap(all)];
const values = node => all(node).filter(n => n.className === "mb-stats-value").map(n => n.textContent);
const flush = () => new Promise(resolve => queueMicrotask(() => setImmediate(resolve)));

function setup() {
  const saved = Object.fromEntries(["document", "setInterval", "clearInterval"].map(key => [key, globalThis[key]]));
  const timers = new Map();
  let next = 0;
  globalThis.setInterval = (fn, ms) => { timers.set(++next, { fn, ms }); return next; };
  globalThis.clearInterval = id => timers.delete(id);
  const bar = new Node();
  globalThis.document = { createElement: () => new Node(), createElementNS: () => new Node(), body: new Node(), hidden: false, querySelector: () => bar };
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
    assert.equal(env.bar.children[0].className, "mb-widget mb-stats");
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

    env.bar.children[0].children[0].onclick();
    assert.equal(env.requests.length, 3);

    stats.close();
    assert.equal(env.timers.size, 0);
    assert.equal(env.bar.children.length, 0);
    assert.ok(env.requests.every(signal => signal.aborted));
  } finally {
    env.restore();
  }
});

test("flush frees through core only with an empty queue, stays disabled meanwhile and shows refusals or failures in its title", async () => {
  const env = setup();
  try {
    const fetchStats = env.api.fetchApi;
    const posts = [];
    let queue = { queue_running: [], queue_pending: [] };
    let reply = { ok: true, status: 200 };
    env.api.fetchApi = async (url, options) => {
      if (url === "/queue") return { ok: true, json: async () => queue };
      if (url !== "/free") return fetchStats(url, options);
      posts.push([options.method, JSON.parse(options.body)]);
      if (reply instanceof Error) throw reply;
      return reply;
    };
    const stats = createStatsWidget(env.api, 0);
    await flush();
    const button = env.bar.children[0].children[1];
    assert.equal(button.className, "mb-btn mb-stats-flush");
    assert.equal(button["aria-label"], "Flush models from RAM and VRAM");

    const click = async () => {
      const done = button.onclick();
      assert.equal(button.disabled, true);
      await done;
      await flush();
      assert.equal(button.disabled, false);
      return button.title;
    };
    assert.equal(await click(), "Flush models from RAM and VRAM");
    assert.deepEqual(posts, [["POST", { unload_models: true, free_memory: true }]]);
    assert.equal(env.requests.length, 2);

    queue = { queue_running: [["job"]], queue_pending: [] };
    assert.equal(await click(), "Cannot flush while jobs run");
    queue = { queue_running: [], queue_pending: [["job"]] };
    assert.equal(await click(), "Cannot flush while jobs run");
    assert.equal(posts.length, 1);
    queue = { queue_running: [], queue_pending: [] };
    reply = { ok: false, status: 500 };
    assert.equal(await click(), "Flush failed, click to retry");
    reply = new TypeError("offline");
    assert.equal(await click(), "Flush failed, click to retry");
    assert.equal(env.requests.length, 2);
    reply = { ok: true, status: 200 };
    assert.equal(await click(), "Flush models from RAM and VRAM");
    assert.equal(posts.length, 4);
    assert.equal(env.requests.length, 3);

    stats.close();
    assert.equal(env.bar.children.length, 0);
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
