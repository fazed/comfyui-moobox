import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { completion, currentToken, parseTags, searchTags } from "./tags.js";

const PREFIX = "MooBox.TagAutocomplete.";
const TEXT_FIELDS = ".comfy-multiline-input, [data-widgets-grid-node-id]";
// The widget name of natural-language inputs; Nodes 2.0 wraps it in data-widget-name, legacy nodes use it as placeholder.
const NATURAL_TEXT = "natural_text";
const MIRRORED = ["boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontWeight", "fontSize", "lineHeight", "fontFamily", "letterSpacing", "textTransform", "tabSize", "wordSpacing"];

const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./styles.css", import.meta.url).href;
document.head.append(style);

let entries = [];
let popup = null;
let hits = [];
let selected = 0;
let field = null;
let range = null;

const setting = (name) => app.extensionManager.setting.get(PREFIX + name);

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function loadTags() {
  const response = await api.fetchApi("/moobox-tags", { cache: "no-store" });
  const text = response.ok ? await response.text() : "";
  entries = parseTags(text);
  return text;
}

function caretPosition(textarea) {
  const computed = getComputedStyle(textarea);
  const mirror = element("div");
  for (const name of MIRRORED) mirror.style[name] = computed[name];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "0" });
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
  const marker = element("span", "", "​");
  mirror.append(marker);
  document.body.append(mirror);
  const left = marker.offsetLeft - textarea.scrollLeft + textarea.clientLeft;
  const bottom = marker.offsetTop + marker.offsetHeight - textarea.scrollTop + textarea.clientTop;
  mirror.remove();
  const rect = textarea.getBoundingClientRect();
  const scale = rect.width / textarea.offsetWidth || 1;
  return { x: rect.left + left * scale, y: rect.top + bottom * scale, line: marker.offsetHeight * scale };
}

function close() {
  popup?.remove();
  popup = null;
  hits = [];
  field = null;
}

function render() {
  popup.replaceChildren(...hits.map((hit, index) => {
    const row = element("div", index === selected ? "kt-tag-row kt-tag-selected" : "kt-tag-row");
    row.append(element("span", "kt-tag-name", hit.alias ? `${hit.alias} → ${hit.tag}` : hit.tag));
    if (hit.count) row.append(element("span", "kt-tag-count", hit.count.toLocaleString("en")));
    row.addEventListener("mousedown", (event) => { event.preventDefault(); accept(index); });
    return row;
  }));
  popup.children[selected]?.scrollIntoView({ block: "nearest" });
}

function insertOptions(target) {
  return {
    spaces: setting("ReplaceUnderscores"),
    escape: setting("EscapeBrackets"),
    comma: !target.dataset.ktTagPicker && setting("AppendComma"),
  };
}

function addPicked(picker, text) {
  picker.value = "";
  picker.dispatchEvent(new CustomEvent("kt-tag", { detail: text.trim() }));
}

function accept(index) {
  const hit = hits[index];
  if (!hit || !field) return;
  const textarea = field;
  const after = textarea.value.slice(range.end);
  const text = completion(after, hit.tag, insertOptions(textarea));
  if (textarea.dataset.ktTagPicker) addPicked(textarea, text);
  else {
    textarea.setRangeText(text, range.start, range.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  close();
}

function update(textarea) {
  const caret = textarea.selectionStart;
  const found = textarea.selectionEnd === caret && currentToken(textarea.value.slice(0, caret));
  if (!found || found.token.length < setting("MinChars")) return close();
  hits = searchTags(entries, found.token, setting("MaxResults"));
  if (!hits.length) return close();
  field = textarea;
  range = { start: found.start, end: caret };
  selected = 0;
  if (!popup) {
    popup = element("div", "kt-tag-popup");
    document.body.append(popup);
  }
  render();
  const { x, y, line } = caretPosition(textarea);
  const box = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(0, Math.min(x, innerWidth - box.width))}px`;
  popup.style.top = `${y + box.height > innerHeight ? Math.max(0, y - line - box.height) : y}px`;
}

function usable(target) {
  const picker = target instanceof HTMLInputElement && target.dataset.ktTagPicker;
  const text = target instanceof HTMLTextAreaElement && !target.readOnly && !target.dataset.ktNoAc && target.placeholder !== NATURAL_TEXT && !target.closest(`[data-widget-name="${NATURAL_TEXT}"]`) && (target.dataset.ktTagField || target.closest(TEXT_FIELDS));
  return (picker || text) && setting("Enabled") && entries.length;
}

document.addEventListener("input", (event) => {
  if (usable(event.target) && !event.isComposing) update(event.target);
}, true);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!popup && event.key === "Enter" && target.dataset?.ktTagPicker && target.value.trim() && !event.isComposing) {
    event.preventDefault();
    addPicked(target, completion("", target.value.trim(), { ...insertOptions(target), escape: false }));
    return;
  }
  if (!popup || target !== field) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step) selected = (selected + step + hits.length) % hits.length;
  else if (event.key === "Escape") close();
  else if ((event.key === "Tab" || event.key === "Enter") && !event.ctrlKey && !event.metaKey && !event.shiftKey) accept(selected);
  else return;
  event.preventDefault();
  event.stopPropagation();
  if (popup) render();
}, true);

document.addEventListener("focusout", (event) => { if (event.target === field) close(); }, true);
document.addEventListener("pointerdown", (event) => { if (field && event.target === field) close(); }, true);
document.addEventListener("wheel", (event) => { if (popup && !popup.contains(event.target)) close(); }, { capture: true, passive: true });

function listEditor() {
  const root = element("div", "kt-tags-editor");
  const area = element("textarea", "kt-tags-text");
  area.dataset.ktNoAc = "1";
  area.spellcheck = false;
  area.placeholder = "One tag per line: tag, tag,count or tag,type,count,aliases";
  const status = element("div", "kt-tags-status");
  const show = async () => {
    area.value = await loadTags();
    status.textContent = `${entries.length.toLocaleString("en")} tags loaded`;
  };
  const run = (label, action) => {
    const el = element("button", "kt-tags-button", label);
    el.type = "button";
    el.addEventListener("click", async () => {
      status.textContent = "Working…";
      try { await action(); } catch (error) { status.textContent = error.message; }
    });
    return el;
  };
  const send = async (path, init) => {
    const response = await api.fetchApi(path, init);
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    await show();
  };
  const buttons = element("div", "kt-tags-buttons");
  buttons.append(
    run("Save list", () => send("/moobox-tags", { method: "PUT", body: area.value })),
    run("Download from URL", () => send("/moobox-tags/download", { method: "POST", body: JSON.stringify({ url: setting("Url") }) })),
    run("Reload", show),
  );
  root.append(area, buttons, status);
  show();
  return root;
}

app.registerExtension({
  name: "MooBox.TagAutocomplete",
  settings: [
    { id: PREFIX + "Enabled", category: ["MooBox", "Tag autocomplete", "Enabled"], name: "Enable tag autocomplete in text fields", type: "boolean", defaultValue: true },
    { id: PREFIX + "MinChars", category: ["MooBox", "Tag autocomplete", "MinChars"], name: "Minimum characters before suggesting", type: "slider", attrs: { min: 1, max: 6, step: 1 }, defaultValue: 2 },
    { id: PREFIX + "MaxResults", category: ["MooBox", "Tag autocomplete", "MaxResults"], name: "Maximum suggestions", type: "slider", attrs: { min: 3, max: 30, step: 1 }, defaultValue: 10 },
    { id: PREFIX + "ReplaceUnderscores", category: ["MooBox", "Tag autocomplete", "ReplaceUnderscores"], name: "Insert spaces instead of underscores (score_ tags and ^_^ keep them)", type: "boolean", defaultValue: true },
    { id: PREFIX + "EscapeBrackets", category: ["MooBox", "Tag autocomplete", "EscapeBrackets"], name: "Escape ( ) in inserted tags", type: "boolean", defaultValue: true },
    { id: PREFIX + "AppendComma", category: ["MooBox", "Tag autocomplete", "AppendComma"], name: "Append a comma after the tag", type: "boolean", defaultValue: true },
    { id: PREFIX + "Url", category: ["MooBox", "Tag autocomplete", "Url"], name: "Tag list URL (downloaded only when you click Download)", type: "text", defaultValue: "https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv" },
    { id: PREFIX + "List", category: ["MooBox", "Tag autocomplete", "List"], name: "Tag list", type: listEditor, defaultValue: "" },
  ],
  setup: loadTags,
});
