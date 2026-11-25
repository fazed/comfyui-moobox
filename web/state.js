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

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const LORA_TAG = new RegExp(`<lora:([^>]+?)(?::(${NUMBER}))?(?::(${NUMBER}))?>`, "gi");
const loraPath = (name) => name.replaceAll("\\", "/").replace(/\.(safetensors|ckpt|pt|bin)$/i, "");

// LoRA Manager sends file names without extension, with folders only when the name alone is ambiguous.
export function sameLora(name, sent) {
  const path = loraPath(name), wanted = loraPath(sent);
  return path === wanted || path.endsWith(`/${wanted}`);
}

export function mergeLoraCode(entries, code, mode) {
  const result = mode === "replace" ? [] : [...entries];
  for (const [, sent, model, clip] of code.matchAll(LORA_TAG)) {
    const strength = model === undefined ? 1 : Number(model);
    const clipStrength = clip === undefined ? strength : Number(clip);
    const patch = { strength, clipStrength, linked: strength === clipStrength, active: true };
    const index = result.findIndex((entry) => sameLora(entry.name, sent));
    if (index >= 0) result[index] = { ...result[index], ...patch };
    else result.push({ name: sent, words: [], ...entries.find((entry) => sameLora(entry.name, sent)), ...patch });
  }
  return result;
}

export function activeLoraNames(entries) {
  return entries.filter((entry) => entry.active !== false).map((entry) => entry.name);
}

export function loraLabel(name) {
  const parts = name.replaceAll("\\", "/").split("/");
  return { title: parts.pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, ""), folder: parts.join(" / ") };
}

// LoRA Manager's relative paths use forward slashes; ComfyUI names may use the system separator.
export function loraIndex(entries, name) {
  return entries.findIndex((entry) => loraPath(entry.name) === loraPath(name));
}

// Picking a LoRA that is already in the stack switches it on and keeps its saved strengths.
export function pickLora(entries, entry) {
  const index = loraIndex(entries, entry.name);
  return index < 0 ? [...entries, entry] : entries.map((saved, i) => (i === index ? { ...saved, active: true } : saved));
}

// LoRA Manager's search and folder index list LoRAs as { relative_path, model_name }.
export function libraryRows(items) {
  return (items || []).filter((item) => item?.relative_path).map((item) => ({ type: "lora", path: item.relative_path, title: item.model_name || loraLabel(item.relative_path).title }));
}

// The folder index nests { count, folders, items } per folder; a folder that is gone yields null.
export function folderRows(root, folder) {
  let node = root;
  for (const part of folder.split("/").filter(Boolean)) node = node?.folders?.[part];
  if (!node) return null;
  return [
    ...Object.entries(node.folders || {}).map(([name, child]) => ({ type: "folder", name, path: folder ? `${folder}/${name}` : name, count: child.count || 0 })),
    ...libraryRows(node.items),
  ];
}

export function parentFolder(path) {
  return path.split("/").slice(0, -1).join("/");
}

export function pickerRows(rows, entries) {
  return rows.map((row) => {
    if (row.type !== "lora") return row;
    const saved = entries[loraIndex(entries, row.path)];
    return { ...row, badge: !saved ? "" : saved.active === false ? "Off" : "Added" };
  });
}

export function rememberRecent(recent, row, limit = 20) {
  return [{ type: "lora", path: row.path, title: row.title }, ...recent.filter((item) => item.path !== row.path)].slice(0, limit);
}

// Counts like LoRA Manager's Filters badge: base models, tags, auto tags, licenses, model types and a folder scope.
export function filterCount(snapshot) {
  const filters = snapshot?.filters || {};
  const keys = (value) => (value && typeof value === "object" ? Object.keys(value).length : 0);
  const baseModels = Array.isArray(filters.baseModel) ? filters.baseModel.filter((name) => name && name !== "__EMPTY_WILDCARD_RESULT__").length : 0;
  const scope = (snapshot?.activeFolder && snapshot.activeFolder !== "null") || snapshot?.recursiveSearch === false ? 1 : 0;
  return baseModels + keys(filters.tags) + keys(filters.autoTags) + keys(filters.license) + keys(filters.modelTypes) + scope;
}

export function filterLabel(count) {
  return count ? `Filters · ${count}` : "Filters";
}

// Recipe lists already carry each LoRA's file name, strength and library state.
export function recipeRows(items) {
  return (items || []).filter((item) => item?.id !== undefined).map((item) => ({
    type: "recipe",
    id: String(item.id),
    title: item.title || item.name || item.file_name || "Untitled recipe",
    preview: item.file_url || "",
    baseModel: item.base_model || "",
    loras: (item.loras || []).filter((lora) => lora && !lora.exclude && (lora.file_name || lora.name)).map((lora) => {
      const strength = Number(lora.strength ?? lora.weight);
      return {
        name: lora.file_name || lora.name,
        title: lora.modelName || lora.model_name || lora.file_name || lora.name,
        strength: Number.isFinite(strength) ? strength : 1,
        status: lora.isDeleted ? "deleted" : lora.inLibrary === false ? "missing" : "ready",
      };
    }),
  }));
}

export function recipeMeta(recipe) {
  return [`${recipe.loras.length} LoRA${recipe.loras.length === 1 ? "" : "s"}`, recipe.baseModel].filter(Boolean).join(" · ");
}

// Only LoRAs in the library can be added; their names still have to be matched to ComfyUI's files.
export function recipeEntries(recipe) {
  return recipe.loras.filter((lora) => lora.status === "ready")
    .map(({ name, strength }) => ({ name, strength, clipStrength: strength, linked: true, active: true, words: [] }));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " };

// Descriptions come from Civitai as HTML; the info popover only shows their text.
export function plainText(html) {
  return html.replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]).replace(/\n{3,}/g, "\n\n").trim();
}

// Escapes, links and images (label only), **bold**, __bold__, *italic* and _italic_ (word boundaries only).
const INLINE = /\\([\\*_])|!?\[([^\]]*)\]\([^)]*\)|\*\*(?=\S)((?:\\.|[^\\])+?)(?<=\S)\*\*|(?<!\w)__(?=\S)((?:\\.|[^\\])+?)(?<=\S)__(?!\w)|\*(?=\S)((?:\\.|[^\\])+?)(?<=\S)\*|(?<!\w)_(?=\S)((?:\\.|[^\\])+?)(?<=\S)_(?!\w)/g;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function addRun(runs, text, style) {
  const last = runs.at(-1);
  if (last?.text !== undefined && !!last.bold === !!style.bold && !!last.italic === !!style.italic) last.text += text;
  else runs.push({ text, ...style });
}

function inlineRuns(text, style = {}) {
  const runs = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [all, escaped, label, boldStar, boldUnder, italicStar, italicUnder] = match;
    if (match.index > last) addRun(runs, text.slice(last, match.index), style);
    if (escaped !== undefined) addRun(runs, escaped, style);
    else if (label !== undefined) addRun(runs, label, style);
    else if (boldStar !== undefined || boldUnder !== undefined) runs.push(...inlineRuns(boldStar ?? boldUnder, { ...style, bold: true }));
    else runs.push(...inlineRuns(italicStar ?? italicUnder, { ...style, italic: true }));
    last = match.index + all.length;
  }
  if (last < text.length) addRun(runs, text.slice(last), style);
  return runs;
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const alignOf = (cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);

// Blocks for the description: headings (# to ###), paragraphs, bullet lists and pipe tables. Everything else stays text.
export function markdownBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let paragraph = null;
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    const heading = /^(#{1,3}) +(\S.*)$/.exec(line);
    const item = /^\s*[-*+] +(\S.*)$/.exec(line);
    if (!line.trim()) {
      paragraph = list = null;
    } else if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, runs: inlineRuns(heading[2]) });
      paragraph = list = null;
    } else if (line.includes("|") && next.includes("|") && TABLE_SEPARATOR.test(next)) {
      const table = { type: "table", align: cells(next).map(alignOf), head: cells(line).map((cell) => inlineRuns(cell)), rows: [] };
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) table.rows.push(cells(lines[i]).map((cell) => inlineRuns(cell)));
      blocks.push(table);
      i--;
      paragraph = list = null;
    } else if (item) {
      if (!list) blocks.push((list = { type: "list", items: [] }));
      list.items.push(inlineRuns(item[1]));
      paragraph = null;
    } else {
      list = null;
      if (!paragraph) blocks.push((paragraph = { type: "paragraph", runs: [] }));
      else addRun(paragraph.runs, "\n", {});
      for (const { text, ...style } of inlineRuns(line.trim())) addRun(paragraph.runs, text, style);
    }
  }
  return blocks;
}

function usageTips(value) {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

export function loraDetails(metadata, name) {
  const tips = usageTips(metadata.usage_tips);
  const parts = [];
  if (tips.strength_min !== undefined || tips.strength_max !== undefined) parts.push(`Range ${tips.strength_min ?? "…"}–${tips.strength_max ?? "…"}`);
  else if (tips.strength_range) parts.push(`Range ${tips.strength_range}`);
  const clip = tips.clip_strength ?? tips.clipStrength;
  if (clip !== undefined) parts.push(`CLIP ${clip}`);
  if (tips.clip_skip !== undefined) parts.push(`CLIP skip ${tips.clip_skip}`);
  const strength = Number.parseFloat(tips.strength);
  return {
    title: metadata.model_name || loraLabel(name).title,
    preview: metadata.preview_url || "",
    baseModel: metadata.base_model || "Base model unknown",
    words: triggerGroups(metadata.civitai?.trainedWords || []),
    strength: Number.isFinite(strength) ? strength : undefined,
    tips: parts.join(" · "),
    description: plainText(metadata.description || metadata.modelDescription || ""),
  };
}

export function blockGroups(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    if (!groups.has(block.group)) groups.set(block.group, []);
    groups.get(block.group).push(block.id);
  }
  return [...groups].map(([group, ids]) => ({ group, ids }));
}

export function infoTabs(blocks) {
  return ["Overview", "Description", ...(blocks.length ? ["Blocks"] : []), "Notes"];
}

const groupKey =(text) => text.replace(/^[\s,]+|[\s,]+$/g, "");

// Each trained-words entry is one prompt group; commas at its edges are not part of it.
export function triggerGroups(words) {
  return words.map(groupKey).filter(Boolean);
}

export function allWords(groups) {
  return groups.join(", ");
}

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
