export function splitWords(text, groups = false) {
  const result = [];
  let current = "", depth = 0, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { current += char; escaped = false; }
    else if (char === "\\") { current += char; escaped = true; }
    else if (char === "(") { depth++; current += char; }
    else if (char === ")") { depth = Math.max(0, depth - 1); current += char; }
    else if (char === "," && depth === 0 && (!groups || text.slice(i, i + 2) === ",,")) {
      if (current.trim()) result.push(current.trim());
      current = "";
      while (text[i + 1] === ",") i++;
    } else current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

export function addLora(entries, entry) {
  return entries.some((saved) => saved.name === entry.name) ? entries : [...entries, entry];
}

export function reconcileWords(state, source, defaultActive = false) {
  const groups = structuredClone(state.groups || []).map((group) => ({ ...group, present: false }));
  const queues = new Map();
  groups.forEach((group) => {
    if (!queues.has(group.text)) queues.set(group.text, []);
    queues.get(group.text).push(group);
  });
  const visible = [];
  for (const text of splitWords(source, true)) {
    let group = queues.get(text)?.shift();
    if (!group) {
      group = { text, active: defaultActive, strength: 1, items: splitWords(text).map((word) => ({ text: word, active: true })) };
      groups.push(group);
    }
    group.present = true;
    visible.push(group);
  }
  return { ...state, source, groups: [...visible, ...groups.filter((group) => !group.present)] };
}

export function activeWords(entries, mode = 0) {
  if (mode !== 0 && mode !== 3) return "";
  return entries.filter((entry) => entry.active !== false).flatMap((entry) => entry.words || []).join(",, ");
}
