import test from "node:test";
import assert from "node:assert/strict";
import { acceptSnapshot, barJob, clientTag, createBars, createPanel, isLocal, nodeName, overallProgress, primaryNode, progress } from "../web/jobspanel.js";
import { createWidget, statsState, widgetState } from "../web/jobswidget.js";

class Element {
  children = [];
  textContent = "";
  classList = { toggle: (name, on) => { this.classes ??= new Set(); on ? this.classes.add(name) : this.classes.delete(name); } };
  style = {};
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  remove() { this.removed = true; }
  set innerHTML(value) { throw new Error("HTML injection"); }
}
const all = node => [node, ...node.children.flatMap(all)];
const texts = node => all(node).map(n => n.textContent);

function store(jobs, tag = "e40c292c") {
  const listeners = new Set();
  return { snapshot: { jobs }, tag, online: true, listeners,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}

test("late HTTP response cannot overwrite newer websocket state", () => {
  const current = { schema: 1, epoch: "a", revision: 5, jobs: [] };
  assert.equal(acceptSnapshot(current, { ...current, revision: 4 }), false);
  assert.equal(acceptSnapshot(current, { ...current, revision: 6 }), true);
  assert.equal(acceptSnapshot(current, { ...current, epoch: "b", revision: 1 }), true);
});

test("progress is node-local and bounded", () => {
  assert.equal(progress(18, 30), 60);
  assert.equal(progress(50, 30), 100);
  assert.equal(progress(1, 0), null);
});

test("client tag matches the server hash and only tagged jobs are local", () => {
  assert.equal(clientTag("a"), "e40c292c");
  assert.equal(clientTag(""), "");
  assert.equal(isLocal({ client: "e40c292c" }, clientTag("a")), true);
  assert.equal(isLocal({ client: "" }, ""), false);
  assert.equal(isLocal({ client: "e40c292c" }, "00000000"), false);
});

test("overall progress counts finished and cached nodes, plus partial active steps", () => {
  const job = { status: "running", node_types: { a: "Loader", b: "Encode", c: "Sampler", d: "Save" },
    completed_nodes: { a: "cached", b: "finished", unrelated: "cached" }, nodes: { c: { value: 18, max: 30 } } };
  assert.equal(overallProgress(job), 65);
  assert.equal(overallProgress({ ...job, status: "completed" }), 100);
  assert.equal(overallProgress({ status: "running" }), null);
});

test("lazy switches do not displace the node reporting step progress", () => {
  const switches = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`9:${i}`, { value: 0, max: 1 }]));
  assert.equal(primaryNode({ nodes: { ...switches, "7:33": { value: 27, max: 40 } }, current_node: "9:0" })[0], "7:33");
  assert.equal(primaryNode({ nodes: {} }), null);
});

test("node labels distinguish repeated types and fall back when absent", () => {
  const job = { node_types: { a: "KSampler" }, node_labels: { a: "Base pass" } };
  assert.equal(nodeName(job, "a"), "Base pass");
  assert.equal(nodeName({ node_types: job.node_types }, "a"), "KSampler");
  assert.equal(nodeName(job, "unknown"), "Active node");
});

test("the top bar prefers a running local build over an external job", () => {
  const external = { prompt_id: "x", status: "running", client: "11111111" };
  const mine = { prompt_id: "m", status: "running", client: "e40c292c" };
  assert.equal(barJob([mine, external], "e40c292c"), mine);
  assert.equal(barJob([external, { ...mine, status: "queued" }], "e40c292c"), external);
  assert.equal(barJob([{ ...mine, status: "completed" }], "e40c292c"), null);
});

test("a running local build beats any number of external jobs, whatever the order", () => {
  const mine = { prompt_id: "m", status: "running", client: "e40c292c" };
  const runningExternal = { prompt_id: "x", status: "running", client: "11111111" };
  const queuedExternal = { prompt_id: "y", status: "queued", client: "22222222" };
  assert.equal(barJob([runningExternal, queuedExternal, mine], "e40c292c"), mine);
  assert.equal(barJob([mine, runningExternal, { ...queuedExternal, status: "running" }], "e40c292c"), mine);
  const state = widgetState([runningExternal, mine, queuedExternal], "e40c292c");
  assert.equal(state.mine, true);
  assert.equal(state.local.count, 1);
  assert.equal(state.external.count, 2);
});

test("without a running local build the bars show the running external job", () => {
  const runningExternal = { prompt_id: "x", status: "running", client: "11111111" };
  const queuedExternal = { prompt_id: "y", status: "queued", client: "22222222" };
  assert.equal(barJob([queuedExternal, runningExternal], "e40c292c"), runningExternal);
  const queuedMine = { prompt_id: "m", status: "queued", client: "e40c292c" };
  const state = widgetState([queuedMine, runningExternal], "e40c292c");
  assert.equal(barJob([queuedMine, runningExternal], "e40c292c"), runningExternal);
  assert.equal(state.mine, false);
  assert.equal(state.local.count, 1);
  assert.equal(state.external.count, 1);
});

test("widget chips mark the job type that waits behind the running one", () => {
  const tag = "e40c292c";
  const node_types = { 1: "easy sleep" };
  const mine = { prompt_id: "m", status: "running", client: tag, node_types, nodes: { 1: { value: 0, max: 1 } } };
  const external = { prompt_id: "x", status: "running", client: "11111111", node_types, nodes: { 1: { value: 0, max: 1 } } };

  let state = widgetState([mine, { ...external, status: "queued", position: 1 }], tag);
  assert.equal(state.label, "0% · easy sleep");
  assert.deepEqual([state.local.count, state.local.waiting], [1, false]);
  assert.deepEqual([state.external.count, state.external.waiting], [1, true]);
  assert.match(state.external.title, /waiting behind a local build · queue position 1/);

  state = widgetState([{ ...mine, status: "queued", position: 1 }, external], tag);
  assert.equal(state.mine, false);
  assert.deepEqual([state.local.count, state.local.waiting], [1, true]);
  assert.equal(state.external.waiting, false);
  assert.match(state.local.title, /waiting behind an external job/);

  state = widgetState([external, { ...external, prompt_id: "y", status: "queued", position: 1 }], tag);
  assert.deepEqual([state.local.count, state.external.count, state.external.waiting], [0, 2, false]);
  assert.equal(state.external.title, "External jobs: 1 running, 1 queued");

  state = widgetState([{ ...mine, status: "completed" }], tag);
  assert.deepEqual([state.idle, state.label, state.local.count, state.external.count], [true, "Idle", 0, 0]);
});

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

test("widget stats load on creation, follow job updates at most once per second, refresh on click and stop on close", async () => {
  const saved = Object.fromEntries(["document", "window", "MutationObserver", "setTimeout", "clearTimeout"].map(key => [key, globalThis[key]]));
  class Node extends Element {
    classList = { toggle() {}, remove() {} };
    append(...children) { for (const child of children) child.parentElement = this; super.append(...children); }
    prepend(child) { this.append(child); }
  }
  const timers = new Map();
  let nextTimer = 0;
  globalThis.setTimeout = (fn) => { timers.set(++nextTimer, fn); return nextTimer; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.document = { createElement: () => new Node(), body: new Node(), querySelector: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  try {
    const requests = [];
    const api = { fetchApi: async (url, options) => { requests.push(options.signal); return { ok: true, json: async () => ({ cpu: 40, ram: { used: 1, total: 4 }, vram: null }) }; } };
    const source = store([]);
    const widget = createWidget(source, () => {}, api, null);
    await new Promise(resolve => saved.setTimeout(resolve, 0));
    const values = texts(document.body).filter(text => /%|—/.test(text));
    assert.deepEqual(values, ["40%", "25%", "—"]);
    assert.equal(requests.length, 1);

    for (let i = 0; i < 5; i++) source.listeners.forEach(fn => fn());
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    assert.equal(timers.size, 0);
    assert.equal(requests.length, 2);

    const button = all(document.body).find(node => node.className === "mbj-widget-stats");
    button.onclick();
    assert.equal(requests.length, 3);

    source.listeners.forEach(fn => fn());
    assert.equal(timers.size, 1);
    widget.close();
    assert.equal(timers.size, 0);
    assert.equal(source.listeners.size, 0);
    assert.ok(requests.every(signal => signal.aborted));
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("bars show progress where the mode says and hide when idle", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element(), querySelector: () => null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const parent = new Element();
    const jobs = [{ prompt_id: "x", status: "running", client: "11111111", node_types: { a: "A", b: "B" },
      completed_nodes: { a: "finished" }, nodes: {} }];
    const source = store(jobs);
    let mode = "Top of window";
    const bars = createBars(parent, source, () => {}, () => mode);
    const [top, tab] = parent.children;
    bars.render();
    assert.ok(top.classes.has("mbj-bar-active"));
    assert.ok(!tab.classes.has("mbj-bar-active"));
    assert.ok(top.classes.has("mbj-bar-external"));
    assert.equal(top.children[0].style.width, "50%");
    mode = "Both";
    bars.render();
    assert.ok(tab.classes.has("mbj-bar-active"));
    source.snapshot = { jobs: [] };
    bars.render();
    assert.ok(!top.classes.has("mbj-bar-active") && !tab.classes.has("mbj-bar-active"));
    bars.close();
    assert.ok(top.removed && tab.removed);
  } finally {
    globalThis.document = oldDocument;
  }
});

test("panel splits local from external, only local can stop, runs are collapsible, labels stay text", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    const hostile = "<img onerror=alert(1)>";
    const jobs = [
      { prompt_id: "local-run", client: "e40c292c", status: "running", node_types: { 42: "KSampler" }, node_labels: { 42: hostile },
        nodes: { 42: { value: 18, max: 30 } }, completed_nodes: { 1: "cached" } },
      { prompt_id: "local-queued", client: "e40c292c", status: "queued", position: 1 },
      { prompt_id: "ext-run", client: "", status: "running", node_types: { 7: "Other" }, nodes: { 7: { value: 1, max: 4 } } },
      { prompt_id: "ext-done", client: "", status: "completed", completed_nodes: { 1: "finished", 2: "cached" } },
    ];
    const stopped = [];
    const el = new Element();
    const close = createPanel(el, store(jobs), id => stopped.push(id));
    const groups = el.children[0].children.slice(1);
    assert.equal(groups.length, 2);
    const [local, external] = groups;
    assert.ok(texts(local).includes(hostile));
    assert.ok(texts(local).includes("KSampler · Node 42 · 18 / 30 steps"));
    assert.ok(!texts(local).includes("Other"));
    assert.ok(texts(external).includes("read-only"));
    const stops = node => all(node).filter(n => n.className === "mbj-stop");
    assert.equal(stops(local).length, 2);
    assert.equal(stops(external).length, 0);
    stops(local)[0].onclick();
    assert.deepEqual(stopped, ["local-run"]);
    const runs = all(external).filter(n => String(n.className).startsWith("mbj-run"));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].tagName ?? "details", "details");
    close();
    assert.equal(el.children[0].removed, true);
  } finally {
    globalThis.document = oldDocument;
  }
});
