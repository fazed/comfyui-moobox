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

const groupKey = (text) => text.replace(/^[\s,]+|[\s,]+$/g, "");

export function reconcileWords(state, source, defaultActive = false) {
  const groups = structuredClone(state.groups || []).map((group) => ({ ...group, present: false }));
  const queues = new Map();
  groups.forEach((group) => {
    const key = groupKey(group.text);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(group);
  });
  const visible = [];
  for (const text of splitWords(source, true)) {
    let group = queues.get(groupKey(text))?.shift();
    if (!group) {
      group = { text, active: defaultActive, strength: 1, items: splitWords(text).map((word) => ({ text: word, active: true })) };
      groups.push(group);
    }
    group.text = text;
    group.present = true;
    visible.push(group);
  }
  const keys = new Set(visible.map((group) => groupKey(group.text)));
  return { ...state, source, groups: [...visible, ...groups.filter((group) => !group.present && !keys.has(groupKey(group.text)))] };
}

export function activeWords(entries, mode = 0) {
  if (mode !== 0 && mode !== 3) return "";
  return entries.filter((entry) => entry.active !== false).flatMap((entry) => entry.words || []).join(",, ");
}
