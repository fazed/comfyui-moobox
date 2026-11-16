import { splitWords } from "./state.js";

function splitCsv(line) {
  const fields = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  fields.push(field);
  return fields;
}

// Accepts "tag", "tag,count" and the a1111 "tag,type,count,aliases" format.
export function parseTags(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = splitCsv(line);
    const tag = fields[0].trim();
    if (!tag) continue;
    const count = Number(fields.length === 2 ? fields[1] : fields[2]) || 0;
    const aliases = (fields[3] || "").split(",").map((alias) => alias.trim().toLowerCase()).filter((alias) => alias && alias !== "null");
    entries.push({ tag, key: tag.toLowerCase(), count, aliases });
  }
  return entries.sort((a, b) => b.count - a.count);
}

export function searchTags(entries, query, limit) {
  const q = query.trimStart().toLowerCase().replaceAll(" ", "_");
  if (!q) return [];
  const starts = [], contains = [];
  for (const { tag, key, count, aliases } of entries) {
    const alias = aliases.find((name) => name.startsWith(q));
    if (key.startsWith(q)) starts.push({ tag, count });
    else if (alias) starts.push({ tag, count, alias });
    else if (key.includes(q)) contains.push({ tag, count });
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

export function currentToken(before) {
  if (/<[^>]*$/.test(before)) return null;
  const token = /[^,\n()[\]{}|:]*$/.exec(before)[0].trimStart();
  if (!token || /^[\d.]+$/.test(token)) return null;
  return { token, start: before.length - token.length };
}

export function completion(after, tag, { spaces, escape, comma }) {
  let text = spaces && !/^score_|^\S{1,2}_\S{1,2}$/.test(tag) ? tag.replaceAll("_", " ") : tag;
  if (escape) text = text.replace(/[()]/g, "\\$&");
  return comma && !/^[ \t]*,/.test(after) ? `${text}, ` : text;
}

export function formatTags(text) {
  const seen = new Set();
  const tags = [];
  for (const word of splitWords(text.replace(/\r?\n/g, ","))) {
    const tag = word.split(/\s+/).join(" ");
    if (!seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); tags.push(tag); }
  }
  return tags.join(", ");
}
