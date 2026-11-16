import test from "node:test";
import assert from "node:assert/strict";
import { acceptSnapshot, barJob, clientTag, createBars, createPanel, isLocal, nodeName, overallProgress, primaryNode, progress } from "../web/jobspanel.js";

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
