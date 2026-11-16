export function parseColors(text, names = {}) {
  return text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
    .map((part) => (names[part]?.groupcolor ?? part).toLowerCase());
}

export function matchTitle(title, pattern) {
  if (!pattern || title.toLowerCase().includes(pattern.toLowerCase())) return true;
  try {
    return new RegExp(pattern, "i").test(title);
  } catch {
    return false;
  }
}

export const ALL = "(all)";

export function inSubgraph(path, chosen) {
  if (chosen === ALL) return true;
  const joined = path.join(" › ");
  return joined === chosen || joined.startsWith(chosen + " › ");
}

export function pickGroups(entries, { title = "", colors = [], sort = "position", subgraph = ALL }) {
  const picked = entries.filter(({ group, path }) => matchTitle(group.title, title) && inSubgraph(path, subgraph) && (!colors.length || colors.includes((group.color ?? "").toLowerCase())));
  if (sort === "alphanumeric") return picked.sort((a, b) => a.order - b.order || a.group.title.localeCompare(b.group.title, undefined, { numeric: true }));
  return picked.sort((a, b) => a.order - b.order || a.group.pos[1] - b.group.pos[1] || a.group.pos[0] - b.group.pos[0]);
}

// A group counts as on while at least one of its nodes is active (mode 0).
export const groupIsOn = (nodes) => nodes.some((node) => node.mode === 0);
export const OFF_MODE = { bypass: 4, mute: 2 };

// Switching off only touches active nodes and switching on only undoes this toggle's own mode, so a node muted inside a bypass group stays muted.
// If no node has that mode, switching on activates them all.
export function nodesToSwitch(nodes, on, offMode) {
  if (on) return nodes.filter((node) => node.mode === 0);
  const off = nodes.filter((node) => node.mode === offMode);
  return off.length ? off : nodes;
}

// Nodes whose centre lies inside the group. Uses pos and size only: boundingRect is not computed for nodes of a subgraph that was never shown.
export function nodesInside([x, y, width, height], nodes, titleHeight) {
  return nodes.filter((node) => {
    const centreX = node.pos[0] + node.size[0] / 2;
    const centreY = node.pos[1] - titleHeight + (node.size[1] + titleHeight) / 2;
    return centreX >= x && centreX <= x + width && centreY >= y && centreY <= y + height;
  });
}
