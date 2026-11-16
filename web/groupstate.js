export function parseColors(text, names = {}) {
  return text.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
    .map((part) => (names[part]?.groupcolor ?? part).toLowerCase());
}

export function matchTitle(title, pattern) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(title);
  } catch {
    return title.toLowerCase().includes(pattern.toLowerCase());
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
