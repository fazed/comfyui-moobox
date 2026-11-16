import { app } from "../../scripts/app.js";
import { ALL, groupIsOn, nodesInside, nodesToSwitch, OFF_MODE, parseColors, pickGroups } from "./groupstate.js";
import "./styles.js";

const GROUPS = "MooBoxGroupsToggle";
const ROW_HEIGHT = 30;
const BAR_HEIGHT = 34;
const FILTERS = ["match_title", "match_colors", "sort", "root_graph", "match_subgraph"];
const refreshers = new Map();

function nodesIn(group, self) {
  return nodesInside(group._bounding, group.graph.nodes.filter((item) => item !== self), LiteGraph.NODE_TITLE_HEIGHT);
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

function groupsWidget(node) {
  const root = document.createElement("div");
  root.className = "kt-root kt-groups";
  const bar = document.createElement("div");
  bar.className = "kt-groups-bar";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "kt-button";
  reload.textContent = "↻ Refresh";
  reload.title = "Read the groups and their state again";
  reload.addEventListener("click", (event) => { event.stopPropagation(); refresh(); });
  bar.append(reload);
  const list = document.createElement("div");
  list.className = "kt-groups-list";
  root.append(bar, list);
  let signature = "";
  let rows = 0;

  const value = (name) => node.widgets.find((widget) => widget.name === name)?.value;
  const refresh = () => {
    if (!node.graph) return;
    const rootMode = value("root_graph") !== false;
    const everything = collectGroups(node.graph);
    const names = [...new Set(everything.flatMap(({ path }) => path.map((_, i) => path.slice(0, i + 1).join(" › "))))];
    const chooser = node.widgets.find((widget) => widget.name === "match_subgraph");
    if (chooser) {
      const values = [ALL, ...names];
      if (!values.includes(chooser.value)) values.push(chooser.value);
      if (values.join("|") !== chooser.options.values.join("|")) chooser.options.values = values;
      if (Boolean(chooser.hidden) !== rootMode) {
        chooser.hidden = rootMode;
        node.setSize([node.size[0], node.computeSize()[1]]);
      }
    }
    const listed = everything.filter(({ path }) => (path.length === 0) === rootMode);
    const picked = pickGroups(listed, { title: value("match_title") ?? "", colors: parseColors(value("match_colors") ?? "", LGraphCanvas.node_colors), sort: value("sort"), subgraph: rootMode ? ALL : value("match_subgraph") ?? ALL });
    const entries = picked.map((entry) => ({ ...entry, nodes: nodesIn(entry.group, node) }));
    const next = JSON.stringify(entries.map(({ group, path, nodes }) => [path, group.title, group.color, groupIsOn(nodes)]));
    if (next === signature) return;
    signature = next;
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "kt-groups-empty";
      empty.textContent = "No matching groups";
      list.append(empty);
    }
    let heading;
    for (const { group, path, nodes } of entries) {
      const where = path.join(" › ");
      if (where !== heading && where) {
        const label = document.createElement("div");
        label.className = "kt-group-path";
        label.textContent = where;
        list.append(label);
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
        const off = OFF_MODE[value("action")];
        for (const item of nodesToSwitch(nodesIn(group, node), on, off)) item.mode = on ? off : 0;
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
        go.addEventListener("click", (event) => { event.stopPropagation(); app.canvas.centerOnNode(group); });
        row.append(go);
      }
      list.append(row);
    }
    rows = Math.max(entries.length, 1);
    const size = node.computeSize();
    if (node.size[1] < size[1]) node.setSize([node.size[0], size[1]]);
  };

  const widget = node.addDOMWidget("groups", "custom", root, { serialize: false, hideInPanel: true, getMinHeight: () => rows * ROW_HEIGHT + BAR_HEIGHT + 16 });
  widget.computeLayoutSize = () => ({ minHeight: rows * ROW_HEIGHT + BAR_HEIGHT + 16, minWidth: 220 });
  // ComfyUI reports no change to groups, node positions or modes, so the list is read on creation, on load, after each filter change and when Refresh is pressed.
  for (const widgetName of FILTERS) {
    const filter = node.widgets.find((item) => item.name === widgetName);
    const changed = filter.callback;
    filter.callback = (...args) => { changed?.(...args); refresh(); };
  }
  const configured = node.onConfigure;
  node.onConfigure = function (...args) { configured?.apply(this, args); refresh(); };
  // nodeCreated runs before the node is in a graph (new, cloned or pasted nodes).
  const added = node.onAdded;
  node.onAdded = function (...args) { added?.apply(this, args); refresh(); };
  const removed = node.onRemoved;
  node.onRemoved = function (...args) { refreshers.delete(node); return removed?.apply(this, args); };
  refreshers.set(node, refresh);
  refresh();
  return widget;
}

app.registerExtension({
  name: "MooBox.GroupsToggle",
  nodeCreated(node) {
    if (node.comfyClass === GROUPS) groupsWidget(node);
  },
  afterConfigureGraph() {
    for (const refresh of refreshers.values()) refresh();
  },
});
