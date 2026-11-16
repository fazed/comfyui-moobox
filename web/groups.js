import { app } from "../../scripts/app.js";
import { ALL, groupIsOn, OFF_MODE, parseColors, pickGroups } from "./groupstate.js";

const GROUPS = "MooBoxGroupsToggle";
const ROW_HEIGHT = 30;
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./styles.css", import.meta.url).href;
document.head.append(style);

function nodesIn(group, self) {
  group.recomputeInsideNodes();
  return [...group._children].filter((item) => item.constructor?.name !== "LGraphGroup" && item.id !== undefined && item !== self && item.mode !== undefined);
}

// Every group of the graph and of the subgraphs below it. A subgraph used by several nodes is listed once.
function collectGroups(graph, path = [], seen = new Set()) {
  const found = [...graph._groups].map((group) => ({ group, graph, path, order: seen.size }));
  for (const item of graph.nodes) {
    if (!item.subgraph || seen.has(item.subgraph.id)) continue;
    seen.add(item.subgraph.id);
    found.push(...collectGroups(item.subgraph, [...path, item.title || item.subgraph.name], seen));
  }
  return found;
}

function centerOn(group) {
  const canvas = app.canvas;
  const [x, y, width, height] = group._bounding;
  canvas.ds.offset = [-(x + width / 2) + canvas.canvas.width / 2 / canvas.ds.scale, -(y + height / 2) + canvas.canvas.height / 2 / canvas.ds.scale];
  canvas.setDirty(true, true);
}

function groupsWidget(node) {
  const root = document.createElement("div");
  root.className = "kt-root kt-groups";
  let signature = "";
  let rows = 0;

  const value = (name) => node.widgets.find((widget) => widget.name === name)?.value;
  const refresh = () => {
    if (!node.graph) return;
    const listed = value("all_graphs") === false ? collectGroups(node.graph).filter((entry) => entry.graph === node.graph) : collectGroups(node.graph);
    const names = [...new Set(listed.flatMap(({ path }) => path.map((_, i) => path.slice(0, i + 1).join(" › "))))];
    const chooser = node.widgets.find((widget) => widget.name === "match_subgraph");
    if (chooser) chooser.options.values = [ALL, ...names];
    const picked = pickGroups(listed, { title: value("match_title") ?? "", colors: parseColors(value("match_colors") ?? "", LGraphCanvas.node_colors), sort: value("sort"), subgraph: value("match_subgraph") ?? ALL });
    const entries = picked.map((entry) => ({ ...entry, nodes: nodesIn(entry.group, node) }));
    const next = JSON.stringify(entries.map(({ group, path, nodes }) => [path, group.title, group.color, groupIsOn(nodes)]));
    if (next === signature) return;
    signature = next;
    root.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "kt-groups-empty";
      empty.textContent = "No matching groups";
      root.append(empty);
    }
    let heading;
    for (const { group, path, nodes } of entries) {
      const where = path.join(" › ");
      if (where !== heading && where) {
        const label = document.createElement("div");
        label.className = "kt-group-path";
        label.textContent = where;
        root.append(label);
      }
      heading = where;
      const on = groupIsOn(nodes);
      const row = document.createElement("div");
      row.className = "kt-group-row";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "kt-group-toggle";
      toggle.dataset.on = String(on);
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(on));
      toggle.setAttribute("aria-label", group.title);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        node.graph.beforeChange?.();
        const mode = on ? OFF_MODE[value("action")] : 0;
        for (const item of nodesIn(group, node)) item.mode = mode;
        node.graph.afterChange?.();
        app.canvas.setDirty(true, true);
        refresh();
      });
      const swatch = document.createElement("span");
      swatch.className = "kt-group-swatch";
      swatch.style.background = group.color ?? "";
      const title = document.createElement("span");
      title.className = "kt-group-title";
      title.textContent = group.title;
      title.title = [...path, group.title].join(" › ");
      row.append(toggle, swatch, title);
      if (!path.length) {
        const go = document.createElement("button");
        go.type = "button";
        go.className = "kt-group-go";
        go.textContent = "→";
        go.title = "Go to group";
        go.setAttribute("aria-label", `Go to ${group.title}`);
        go.addEventListener("click", (event) => { event.stopPropagation(); centerOn(group); });
        row.append(go);
      }
      root.append(row);
    }
    rows = Math.max(entries.length, 1);
    const size = node.computeSize();
    if (node.size[1] < size[1]) node.setSize([node.size[0], size[1]]);
  };

  const widget = node.addDOMWidget("groups", "custom", root, { serialize: false, hideInPanel: true, getMinHeight: () => rows * ROW_HEIGHT + 16 });
  widget.computeLayoutSize = () => ({ minHeight: rows * ROW_HEIGHT + 16, minWidth: 220 });
  const timer = setInterval(refresh, 400);
  const removed = node.onRemoved;
  node.onRemoved = function (...args) { clearInterval(timer); return removed?.apply(this, args); };
  refresh();
  return widget;
}

app.registerExtension({
  name: "MooBox.GroupsToggle",
  nodeCreated(node) {
    if (node.comfyClass === GROUPS) groupsWidget(node);
  },
});
