import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { afterRun, randomSeed, savedNode, validSeed } from "./seedstate.js";
import "./styles.js";

const SEEDS = "MooBoxSeeds";
const MAX_SEEDS = 16;
const ROW_HEIGHT = 38;
const MODES = {
  fixed: { icon: "📌", label: "Fixed", info: "Leaves the value unchanged" },
  increment: { icon: "+1", label: "Increment", info: "Adds 1 after each run" },
  decrement: { icon: "-1", label: "Decrement", info: "Subtracts 1 after each run" },
  randomize: { icon: "🔀", label: "Randomize", info: "Picks a new random value after each run" },
};
let menu;

function closeMenu() {
  menu?.remove();
  menu = undefined;
  document.removeEventListener("pointerdown", dismiss, true);
}

function dismiss(event) {
  if (!menu?.contains(event.target)) closeMenu();
}

function openMenu(anchor, current, choose) {
  closeMenu();
  menu = element("div", "kt-seed-menu");
  menu.append(element("div", "kt-seed-menu-title", "After running, update the seed:"));
  for (const [mode, { icon, label, info }] of Object.entries(MODES)) {
    const item = element("button", "kt-seed-menu-item");
    item.type = "button";
    item.dataset.active = String(mode === current);
    item.title = info;
    item.append(element("span", "kt-seed-menu-icon", icon), element("span", "", `${label} · ${info}`));
    item.addEventListener("click", () => { closeMenu(); choose(mode); });
    menu.append(item);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - 300, window.innerWidth - 310))}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 190)}px`;
  document.body.append(menu);
  document.addEventListener("pointerdown", dismiss, true);
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text, title, action) {
  const el = element("button", "kt-button kt-icon", text);
  el.type = "button";
  el.title = title;
  el.setAttribute("aria-label", title);
  el.addEventListener("click", (event) => { event.stopPropagation(); action(); });
  return el;
}

function syncOutputs(node, count) {
  if (node.outputs.length === count) return;
  while (node.outputs.length > count) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < count) node.addOutput(`seed_${node.outputs.length + 1}`, "INT");
  node.setSize([node.size[0], node.computeSize()[1]]);
}

function seedsWidget(node, name) {
  const root = element("div", "kt-root kt-seeds");
  let state = [{ seed: -1, last: null }];
  let widget;

  const commit = (next) => {
    node.graph?.beforeChange?.();
    widget.value = JSON.stringify(next);
    node.graph?.afterChange?.();
  };
  const update = (index, patch) => commit(state.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  const render = () => {
    root.replaceChildren();
    const all = element("div", "kt-seed-all");
    all.append(element("span", "kt-seed-all-label", "All seeds"),
      button("🔁", "Random each time: set every seed to -1", () => commit(state.map((entry) => ({ ...entry, seed: -1 })))),
      button("✨", "New fixed random: pick a new seed for every row", () => commit(state.map((entry) => ({ ...entry, seed: randomSeed() })))),
      button("♻", "Use last used seeds: restore every row that has one", () => commit(state.map((entry) => ({ ...entry, seed: entry.last ?? entry.seed })))));
    root.append(all);
    state.forEach((entry, index) => {
      const row = element("div", "kt-seed-row");
      const field = element("div", "kt-seed-field");
      const input = element("input", "kt-number");
      input.type = "text";
      input.inputMode = "numeric";
      input.value = entry.seed;
      input.title = "Seed (-1 picks a new random seed on every run)";
      input.setAttribute("aria-label", `Seed ${index + 1}`);
      input.addEventListener("change", () => {
        const parsed = Number(input.value.trim());
        if (input.value.trim() !== "" && validSeed(parsed)) update(index, { seed: parsed });
        else input.value = entry.seed;
      });
      const mode = entry.mode ?? "fixed";
      const random = entry.seed === -1;
      const shuffle = element("button", "kt-seed-shuffle", random ? "🔀" : MODES[mode].icon);
      shuffle.type = "button";
      shuffle.dataset.active = String(random || mode !== "fixed");
      shuffle.title = random ? "Random each time (-1). Click to choose what happens after a run" : `${MODES[mode].label}: ${MODES[mode].info}. Click to change`;
      shuffle.setAttribute("aria-label", "Update the seed after running");
      shuffle.addEventListener("click", (event) => { event.stopPropagation(); openMenu(shuffle, mode, (next) => update(index, { mode: next })); });
      field.append(input, shuffle);

      const each = button("🔁", "Random each time: a new seed on every run (-1)", () => update(index, { seed: -1 }));
      const fresh = button("✨", "New fixed random: pick one new seed now and keep it", () => update(index, { seed: randomSeed() }));
      const last = button("♻", entry.last == null ? "No seed used yet" : `Use last used seed: ${entry.last}`, () => update(index, { seed: entry.last }));
      last.disabled = entry.last == null;
      const remove = button("×", `Remove seed ${index + 1}`, () => commit(state.filter((_, i) => i !== index)));
      remove.disabled = state.length === 1;
      row.append(field, each, fresh, last, remove);
      root.append(row);
    });
    const add = button("+ Add seed", "Add a seed and output", () => commit([...state, { seed: -1, last: null }]));
    add.disabled = state.length >= MAX_SEEDS;
    root.append(add);
  };

  const height = () => (state.length + 1) * ROW_HEIGHT + 56;
  widget = node.addDOMWidget(name, "custom", root, {
    getValue: () => JSON.stringify(state),
    setValue: (value) => {
      state = typeof value === "string" ? JSON.parse(value) : value;
      render();
      syncOutputs(node, state.length);
      node.graph?.setDirtyCanvas(true, true);
    },
    serialize: true,
    hideInPanel: true,
    getMinHeight: height,
  });
  widget.computeLayoutSize = () => ({ minHeight: height(), minWidth: 300 });
  widget.serializeValue = () => JSON.stringify(state.map((entry) => entry.seed));
  const removed = widget.onRemove;
  widget.onRemove = function () {
    closeMenu();
    return removed?.apply(this, arguments);
  };
  render();
  return { widget, minWidth: 320, minHeight: height() };
}

function findNode(id) {
  let graph = app.rootGraph;
  let node;
  for (const part of String(id).split(":")) {
    node = graph?.getNodeById(Number(part));
    graph = node?.subgraph;
  }
  return node;
}

// Seeds are resolved when the prompt is queued so the saved image metadata holds the real values.
// The widgets only advance once the server accepted the prompt.
const queuePrompt = api.queuePrompt;
api.queuePrompt = async function (index, prompt, ...args) {
  const advance = [];
  for (const [id, item] of Object.entries(prompt.output ?? {})) {
    if (item.class_type !== SEEDS) continue;
    const used = JSON.parse(item.inputs.seeds).map((seed) => (seed === -1 ? randomSeed() : seed));
    item.inputs.seeds = JSON.stringify(used);
    const widget = findNode(id)?.widgets?.find((w) => w.name === "seeds");
    if (!widget) continue;
    const current = JSON.parse(widget.value);
    const saved = savedNode(prompt.workflow, id);
    if (saved) saved.widgets_values = [JSON.stringify(current.map((entry, i) => ({ ...entry, seed: used[i], last: used[i] })))];
    advance.push(() => { widget.value = JSON.stringify(current.map((entry, i) => ({ ...entry, last: used[i], seed: afterRun(entry, used[i]) }))); });
  }
  const result = await queuePrompt.call(this, index, prompt, ...args);
  for (const apply of advance) apply();
  return result;
};

app.registerExtension({
  name: "MooBox.Seeds",
  getCustomWidgets() {
    return { MOOBOX_SEEDS: seedsWidget };
  },
  nodeCreated(node) {
    if (node.comfyClass !== SEEDS) return;
    syncOutputs(node, JSON.parse(node.widgets.find((w) => w.name === "seeds").value).length);
  },
});
