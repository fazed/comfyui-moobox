import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { glyph } from "./icons.js";
import { activeLoraNames, activeWords, addLora, allWords, blockGroups, filterCount, filterLabel, folderRows, infoTabs, libraryRows, loraDetails, loraIndex, loraLabel, markdownBlocks, mergeLoraCode, parentFolder, pickerRows, pickLora, recipeEntries, recipeMeta, recipeRows, reconcileWords, rememberRecent, sameLora, splitWords } from "./state.js";
import "./styles.js";

const LOADER = "MooBoxLoraLoader";
const TRIGGERS = "MooBoxTriggerWords";
const MANAGER_NODE = "Lora Loader (LoraManager)";
// LoRA Manager's adapter API, set once it registered the loader as a Send to ComfyUI target.
let loraManager = null;
// One popover at a time, appended to the body; it closes on Escape, an outside click, its button or node removal.
let popover;

function managerInstalled() {
  return Boolean(LiteGraph.registered_node_types[MANAGER_NODE]);
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(text, title, action, variant) {
  const el = element("button", "mb-btn", text);
  if (variant) el.dataset.variant = variant;
  el.type = "button";
  el.title = title;
  el.setAttribute("aria-label", title);
  el.dataset.focus = title;
  el.addEventListener("click", (event) => { event.stopPropagation(); action(); });
  return el;
}

function toggle(active, title, action) {
  const label = element("label", "mb-switch");
  const input = element("input");
  input.type = "checkbox";
  input.checked = active;
  input.setAttribute("aria-label", title);
  input.addEventListener("change", () => action(input.checked));
  label.title = title;
  label.append(input, element("span", "mb-switch-track"));
  return label;
}

function field(label, input) {
  const wrapper = element("label", "mb-field");
  wrapper.append(element("span", "mb-label", label), input);
  return wrapper;
}

function managerLink(name, text = "Manager") {
  const link = element("a", "mb-btn mb-manager-link");
  link.append(glyph("external"));
  if (text) link.append(element("span", "", text));
  const url = new URL("./open-manager.html", import.meta.url);
  url.searchParams.set("name", name);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = name ? `Open ${name} in LoRA Manager` : "Open LoRA Manager";
  link.setAttribute("aria-label", link.title);
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function number(value, title, action) {
  const input = element("input", "mb-input mb-number");
  input.type = "text";
  input.inputMode = "decimal";
  input.value = value;
  input.title = title;
  input.setAttribute("aria-label", title);
  input.dataset.focus = title;
  input.addEventListener("change", () => {
    const parsed = Number(input.value.replace(",", "."));
    if (input.value.trim() !== "" && Number.isFinite(parsed)) action(parsed);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const parsed = Number(input.value.replace(",", ".")) || 0;
    const next = Math.round((parsed + (event.key === "ArrowUp" ? 0.05 : -0.05)) * 100) / 100;
    input.value = next;
    input.dispatchEvent(new Event("change"));
  });
  return input;
}

function change(node, widget, value) {
  const focus = document.activeElement?.dataset?.focus;
  node.graph?.beforeChange?.();
  widget.value = JSON.stringify(value);
  if (focus) [...widget.element.querySelectorAll("[data-focus]")].find((input) => input.dataset.focus === focus)?.focus({ preventScroll: true });
  node.graph?.afterChange?.();
  node.graph?.setDirtyCanvas(true, true);
}

function setTriggerSource(node, source) {
  const widget = node.widgets?.find((item) => item.name === "selection");
  if (!widget) return;
  const state = JSON.parse(widget.value);
  const defaultActive = node.widgets.find((item) => item.name === "default_active")?.value ?? false;
  widget.value = JSON.stringify(reconcileWords(state, source, defaultActive));
}

function syncConnected(node, source) {
  for (const linkId of node.outputs?.[2]?.links || []) {
    const links = node.graph?.links;
    const link = typeof links?.get === "function" ? links.get(linkId) : links?.[linkId];
    const target = link && node.graph.getNodeById(link.target_id);
    if (target?.comfyClass === TRIGGERS) setTriggerSource(target, source);
  }
}

async function json(path, options) {
  const response = await api.fetchApi(path, options);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function closePopover() {
  if (!popover) return;
  const { box, anchor, onClose } = popover;
  popover = undefined;
  document.removeEventListener("pointerdown", dismissPopover, true);
  box.remove();
  anchor.setAttribute("aria-expanded", "false");
  onClose?.();
}

function dismissPopover(event) {
  if (!popover.box.contains(event.target) && !popover.anchor.contains(event.target)) closePopover();
}

function openPopover(anchor, box, owner, onClose) {
  closePopover();
  box.tabIndex = -1;
  // Keys typed in the popover stay out of ComfyUI's shortcuts.
  box.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { closePopover(); anchor.focus(); }
  });
  const rect = anchor.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 240));
  box.style.left = `${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328))}px`;
  box.style.top = `${top}px`;
  box.style.maxHeight = `${window.innerHeight - top - 8}px`;
  document.body.append(box);
  document.addEventListener("pointerdown", dismissPopover, true);
  anchor.setAttribute("aria-expanded", "true");
  popover = { box, anchor, owner, onClose };
}

function makeWidget(node, name, root, initial, render) {
  let state = initial;
  root.dataset.captureWheel = "true";
  root.tabIndex = -1;
  root.addEventListener("pointerenter", () => {
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
  });
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  root.addEventListener("wheel", (event) => event.stopPropagation());
  const widget = node.addDOMWidget(name, "custom", root, {
    getValue: () => JSON.stringify(state),
    setValue: (value) => {
      state = typeof value === "string" ? JSON.parse(value) : value;
      render(state);
    },
    serialize: true,
    hideInPanel: true,
    getMinHeight: () => 340,
    selectOn: ["click", "focus"],
  });
  widget.computeLayoutSize = () => ({ minHeight: 340, minWidth: 420 });
  widget.serializeValue = () => JSON.stringify(state);
  render(state);
  return { widget, minWidth: 460, minHeight: 340 };
}

let previewBox;

// LoRA Manager matches the file name without its extension.
function stem(name) {
  return name.replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
}

function previewUrl(name) {
  return api.apiURL(`/moobox-lora/preview?name=${encodeURIComponent(name)}`);
}

function resultChoice(name, badge, action) {
  const choice = button("", `Add ${name}`, action, "ghost");
  choice.classList.add("mb-result");
  const { title, folder } = loraLabel(name);
  const thumb = element("img", "mb-thumb");
  thumb.alt = "";
  thumb.loading = "lazy";
  thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
  thumb.src = previewUrl(name);
  choice.append(thumb, element("span", "mb-result-name", title), element("span", "mb-result-folder", folder || "LoRA library"));
  if (badge) choice.append(element("span", "mb-badge mb-result-add", badge));
  return choice;
}

function infoSection(title, ...content) {
  const section = element("section", "mb-info-section");
  section.append(element("span", "mb-label", title), ...content);
  return section;
}

function copyButton(label, text, status) {
  const copy = button("", `Copy ${label}`, async () => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `Copied ${label}`;
    } catch {
      status.textContent = `Could not copy ${label}`;
    }
  }, "ghost");
  copy.classList.add("mb-icon");
  copy.append(glyph("copy"));
  return copy;
}

// Preview, name, base model, trigger words and usage tips, shared by the info popover and Quick Pick.
function overviewPanel(view, name, status) {
  const head = element("div", "mb-info-head");
  if (view.preview) {
    const video = /\.(mp4|webm|mov)$/i.test(view.preview);
    const preview = element(video ? "video" : "img", "mb-info-preview");
    if (video) Object.assign(preview, { muted: true, loop: true, autoplay: true, playsInline: true });
    else preview.alt = "";
    preview.addEventListener("error", () => preview.remove());
    preview.src = view.preview;
    head.append(preview);
  }
  const identity = element("div", "mb-identity");
  const title = element("span", "mb-name", view.title);
  title.title = name;
  identity.append(title, element("span", "mb-muted", view.baseModel));
  head.append(identity);
  const overview = [head];
  const words = element("div", "mb-pills");
  words.append(...view.words.map((group) => {
    const pill = element("span", "mb-pill mb-info-word");
    pill.append(element("span", "", group), copyButton(group, group, status));
    return pill;
  }));
  const copyAll = copyButton("all trigger words", allWords(view.words), status);
  copyAll.append(element("span", "", "Copy all"));
  overview.push(view.words.length ? infoSection("Trigger words", words, copyAll) : infoSection("Trigger words", element("span", "mb-muted", "None in the local metadata")));
  if (view.strength !== undefined || view.tips) {
    const usage = [];
    if (view.strength !== undefined) usage.push(element("span", "", `Recommended strength ${view.strength}`));
    if (view.tips) usage.push(element("span", "mb-muted", view.tips));
    overview.push(infoSection("Usage tips", ...usage));
  }
  return overview;
}

// Markdown becomes elements filled with textContent only; links and images keep just their label.
function markdownNodes(text) {
  return markdownBlocks(text).map((block) => {
    if (block.type === "heading") return withRuns(element(`h${block.level + 2}`, "mb-info-heading"), block.runs);
    if (block.type === "paragraph") return withRuns(element("p", "mb-info-text"), block.runs);
    if (block.type === "list") {
      const list = element("ul", "mb-info-list");
      list.append(...block.items.map((runs) => withRuns(element("li"), runs)));
      return list;
    }
    const table = element("table", "mb-info-table");
    table.append(...[block.head, ...block.rows].map((cells, row) => {
      const tr = element("tr");
      tr.append(...cells.map((runs, column) => {
        const cell = withRuns(element(row ? "td" : "th"), runs);
        if (block.align[column]) cell.dataset.align = block.align[column];
        return cell;
      }));
      return tr;
    }));
    return table;
  });
}

function withRuns(el, runs) {
  el.append(...runs.map(inlineNode));
  return el;
}

function inlineNode({ text, bold, italic, code }) {
  const node = element(code ? "code" : italic ? "em" : "span", "", text);
  if (!bold) return node;
  const strong = element("strong");
  strong.append(node);
  return strong;
}

// Panels per tab name; the server's description and notes only ever become text nodes.
function infoPanels(entry, metadata, blocks, notes, status) {
  const view = loraDetails(metadata, entry.name);
  return {
    Overview: overviewPanel(view, entry.name, status),
    Description: view.description ? markdownNodes(view.description) : [element("span", "mb-muted", "No description")],
    Blocks: [...blocks.map(({ group, ids }) => element("span", "mb-info-blocks", `${group}: ${ids.join(", ")}`)),
      element("span", "mb-muted", `Every block uses the row strength ${entry.strength}.`)],
    Notes: [notes.trim() ? element("p", "mb-info-text mb-info-notes", notes.trim()) : element("span", "mb-muted", "No notes")],
  };
}

function showTabs(tabs, body, names, panels) {
  const select = (index) => {
    [...tabs.children].forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
    });
    body.setAttribute("aria-label", names[index]);
    body.replaceChildren(...panels[names[index]]);
    body.scrollTop = 0;
  };
  tabs.replaceChildren(...names.map((name, index) => {
    const tab = button(name, name, () => select(index), "ghost");
    tab.setAttribute("role", "tab");
    return tab;
  }));
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = [...tabs.children].findIndex((tab) => tab.tabIndex === 0);
    const next = (current + (event.key === "ArrowRight" ? 1 : names.length - 1)) % names.length;
    select(next);
    tabs.children[next].focus();
  });
  body.setAttribute("role", "tabpanel");
  select(0);
}

function showPreview(anchor, name) {
  if (!previewBox) {
    previewBox = element("img", "mb-popup mb-preview");
    previewBox.alt = "";
    previewBox.addEventListener("error", () => { previewBox.style.display = "none"; });
    document.body.append(previewBox);
  }
  const rect = anchor.getBoundingClientRect();
  previewBox.style.display = "block";
  previewBox.style.left = `${Math.min(rect.right + 10, window.innerWidth - 230)}px`;
  previewBox.style.top = `${Math.max(8, Math.min(rect.top - 20, window.innerHeight - 290))}px`;
  previewBox.src = previewUrl(name);
}

function hidePreview() {
  if (previewBox) previewBox.style.display = "none";
}

async function loraWords(node, name) {
  if (node.widgets?.find((item) => item.name === "loader")?.value === "LoRA Manager") {
    const data = await json(`/lm/loras/get-trigger-words?name=${encodeURIComponent(stem(name))}`);
    if (data.success === false) throw new Error("LoRA Manager could not read this LoRA.");
    return data.trigger_words || [];
  }
  const data = await json(`/moobox-lora/words?name=${encodeURIComponent(name)}`);
  // Metadata is optional; the loader and saved selections do not depend on LoRA Manager.
  if (data.words.length) return data.words;
  try {
    const response = await api.fetchApi(`/lm/loras/get-trigger-words?name=${encodeURIComponent(stem(name))}`);
    return response.ok ? (await response.json()).trigger_words || [] : [];
  } catch {
    return [];
  }
}

// LoRA Manager's names may lack the extension or the folder; the loader needs ComfyUI's own file name.
async function comfyName(sent, signal) {
  const data = await json(`/moobox-lora/search?q=${encodeURIComponent(sent.replaceAll("\\", "/").split("/").pop())}`, { signal });
  return data.names.find((item) => sameLora(item, sent)) ?? sent;
}

const RECENT_KEY = "moobox.quickPick.recent";
const HINTS = {
  LoRAs: "Up/Down Navigate · Left/Right Folder · Enter Open/Apply · Shift+Enter Keep open · Esc Close",
  Recipes: "Up/Down Navigate · Enter Append · Shift+Enter Keep open · Esc Close",
};
// One Quick Pick at a time, appended to the body; it closes on Escape, its close button, the backdrop, an add or node removal.
let quickPick;

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function writeRecent(recent) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Recent picks are a convenience; blocked storage only loses the list.
  }
}

// Mirrors LoRA Manager's Quick Pick through its read-only endpoints; adding goes through the loader's own state.
function openQuickPick(node, widget, anchor) {
  closePopover();
  quickPick?.close();
  let tab = "LoRAs", view = "folders", folder = "", filtered = false, recentOnly = false, closed = false;
  let found = [], recipes = [], recent = readRecent(), library, libraryError = false, listError = false, loading = false;
  let rows = [], rowElements = [], highlighted = 0, activeFilters = 0, timer, search, loads, detail, adding;
  const backdrop = element("div", "mb-popup mb-quick-backdrop");
  const dialog = element("div", "mb-quick");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.tabIndex = -1;
  const title = element("strong", "mb-quick-title");
  const heading = element("div", "mb-identity");
  heading.append(title, element("span", "mb-muted", `Add to ${node.title || "MooBox LoRA Loader"} (#${node.id})`));
  const closeButton = button("", "Close Quick Pick", () => { close(); anchor.focus(); }, "ghost");
  closeButton.classList.add("mb-icon");
  closeButton.append(glyph("close"));
  const head = element("div", "mb-quick-head");
  head.append(heading, closeButton);
  const tabs = element("div", "mb-tabs");
  tabs.setAttribute("role", "tablist");
  const input = element("input", "mb-input mb-search");
  input.type = "search";
  input.autocomplete = "off";
  const layout = element("div", "mb-joined");
  for (const [mode, text] of [["folders", "Folder"], ["flat", "Flat"]]) {
    const choice = button(text, `${text} view`, () => { view = mode; highlighted = 0; renderList(); input.focus(); });
    choice.dataset.mode = mode;
    layout.append(choice);
  }
  const filters = button("Filters", "Use LoRA Manager's active filters", () => {
    filtered = !filtered;
    loadLibrary();
    loadSearch();
  });
  const recentButton = button("Recent", "Show recently added LoRAs", () => { recentOnly = !recentOnly; highlighted = 0; renderList(); input.focus(); });
  const options = element("div", "mb-quick-options");
  options.append(layout, filters, recentButton);
  const tools = element("div", "mb-quick-tools");
  tools.append(input, options);
  const list = element("div", "mb-quick-list");
  list.setAttribute("role", "listbox");
  const preview = element("aside", "mb-quick-preview");
  const body = element("div", "mb-quick-body");
  body.append(list, preview);
  const status = element("span", "mb-status");
  status.setAttribute("role", "status");
  const hints = element("span", "mb-quick-hints");
  const foot = element("div", "mb-quick-foot");
  foot.append(status, hints);
  dialog.append(head, tabs, tools, body, foot);
  backdrop.append(dialog);

  const close = () => {
    if (closed) return;
    closed = true;
    quickPick = undefined;
    clearTimeout(timer);
    [search, loads, detail, adding].forEach((request) => request?.abort());
    backdrop.remove();
    anchor.setAttribute("aria-expanded", "false");
  };
  const query = () => input.value.trim();
  const browsing = () => tab === "LoRAs" && view === "folders" && !recentOnly && !query();
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const currentRows = () => {
    if (tab === "Recipes") return recipes;
    if (recentOnly) return recent.filter((row) => `${row.title} ${row.path}`.toLowerCase().includes(query().toLowerCase()));
    if (browsing()) return (library && folderRows(library, folder)) || [];
    return found;
  };

  const summary = () => {
    if (tab === "Recipes") return loading ? "Loading…" : listError ? "Recipes unavailable" : plural(rows.length, "recipe");
    if (recentOnly) return plural(rows.length, "recently added LoRA");
    if (browsing()) return libraryError ? "Folder view unavailable" : !library ? "Loading folders…"
      : `${plural(rows.reduce((sum, row) => sum + (row.type === "folder" ? row.count : 1), 0), "LoRA")} in this folder`;
    return loading ? "Searching…" : listError ? "Search unavailable" : `${plural(rows.length, "result")}${filtered ? " within active filters" : ""}`;
  };

  const highlight = (index) => {
    if (index === highlighted || !rowElements[index]) return;
    rowElements[highlighted]?.setAttribute("aria-selected", "false");
    rowElements[highlighted]?.classList.remove("mb-selected");
    highlighted = index;
    rowElements[index].setAttribute("aria-selected", "true");
    rowElements[index].classList.add("mb-selected");
    rowElements[index].scrollIntoView({ block: "nearest" });
    renderPreview();
  };

  const add = async (picks, label, keepOpen, added) => {
    if (adding) return;
    adding = new AbortController();
    const { signal } = adding;
    status.textContent = `Adding ${label}…`;
    try {
      const resolved = [];
      for (const pick of picks) {
        const name = await comfyName(pick.name, signal);
        const words = loraIndex(JSON.parse(widget.value), name) < 0 ? await loraWords(node, name) : [];
        resolved.push({ ...pick, name, words });
      }
      if (signal.aborted) return;
      change(node, widget, resolved.reduce(pickLora, JSON.parse(widget.value)));
      added?.();
      if (!keepOpen) { close(); anchor.focus(); return; }
      renderList();
      status.textContent = `Added ${label}`;
      input.focus();
    } catch (error) {
      if (!signal.aborted) status.textContent = `Could not add ${label}: ${error.message}`;
    } finally {
      if (adding?.signal === signal) adding = undefined;
    }
  };

  const openFolder = (path, from = "") => {
    folder = path;
    highlighted = Math.max(0, (folderRows(library, path) || []).findIndex((row) => row.type === "folder" && row.path === from));
    renderList();
    input.focus();
  };

  const activate = (row, keepOpen) => {
    if (row.type === "folder") openFolder(row.path);
    else if (row.type === "recipe") {
      const entries = recipeEntries(row);
      if (entries.length) add(entries, row.title, keepOpen);
      else status.textContent = "No LoRAs of this recipe are in the library";
    } else add([{ name: row.path, strength: 1, clipStrength: 1, linked: true, active: true }], row.title, keepOpen, () => {
      recent = rememberRecent(recent, row);
      writeRecent(recent);
    });
  };

  const rowElement = (row, index) => {
    const choice = element("button", `mb-btn mb-quick-row mb-quick-${row.type}`);
    choice.type = "button";
    choice.setAttribute("role", "option");
    choice.setAttribute("aria-selected", String(index === highlighted));
    if (index === highlighted) choice.classList.add("mb-selected");
    if (row.type === "folder") {
      choice.setAttribute("aria-label", `Open folder ${row.name}, ${plural(row.count, "LoRA")}`);
      choice.append(glyph("folder"), element("span", "mb-quick-name", row.name), element("span", "mb-muted", String(row.count)), glyph("next"));
    } else if (row.type === "recipe") {
      choice.setAttribute("aria-label", `Append recipe ${row.title}`);
      const thumb = element("img", "mb-thumb");
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
      thumb.src = row.preview;
      choice.append(thumb, element("span", "mb-quick-name", row.title), element("span", "mb-quick-path", recipeMeta(row)));
    } else {
      choice.setAttribute("aria-label", `Add ${row.path}`);
      choice.title = row.path;
      choice.append(element("span", "mb-quick-name", row.title), element("span", "mb-quick-path", row.path));
      if (row.badge) choice.append(element("span", "mb-badge mb-quick-badge", row.badge));
    }
    choice.addEventListener("pointermove", () => highlight(index));
    choice.addEventListener("click", (event) => activate(row, event.shiftKey));
    return choice;
  };

  const emptyText = () => {
    if (tab === "Recipes") return loading ? "Loading…" : listError ? "Recipes unavailable" : query() ? "No recipes match this search." : "No recipes yet.";
    if (recentOnly) return "No recently added LoRAs yet. Add one from Quick Pick to build the list.";
    if (browsing()) return libraryError ? "Folder view unavailable. Use the Flat view." : !library ? "Loading folders…" : "This folder is empty.";
    return loading ? "Searching…" : listError ? "Search unavailable" : "No matching LoRAs";
  };

  const actions = (primary, label, keep) => {
    const row = element("div", "mb-quick-actions");
    row.append(button(label, label, () => primary(false)), button(keep, keep, () => primary(true)));
    return row;
  };

  const recipePreview = (row) => {
    if (row.preview) {
      const image = element("img", "mb-info-preview");
      image.alt = "";
      image.addEventListener("error", () => image.remove());
      image.src = row.preview;
      preview.append(image);
    }
    const lines = row.loras.map((lora) => {
      const line = element("div", "mb-quick-lora");
      line.dataset.status = lora.status;
      const name = element("span", "mb-name", lora.title);
      name.title = lora.name;
      line.append(name, element("span", "mb-muted", lora.status === "ready" ? lora.strength.toFixed(2) : `${lora.strength.toFixed(2)} · ${lora.status}`));
      return line;
    });
    const skipped = row.loras.length - recipeEntries(row).length;
    preview.append(element("span", "mb-name", row.title), element("span", "mb-muted", recipeMeta(row)),
      infoSection(`LoRAs (${row.loras.length})`, ...(lines.length ? lines : [element("span", "mb-muted", "This recipe has no LoRAs.")])));
    if (skipped) preview.append(element("span", "mb-muted", `${plural(skipped, "LoRA")} not in the library will be skipped.`));
    preview.append(actions((keepOpen) => activate(row, keepOpen), "Append", "Append, keep open"),
      element("span", "mb-muted", "The recipe is only read; its checkpoint and prompt are not applied."));
  };

  const renderPreview = () => {
    detail?.abort();
    const row = rows[highlighted];
    preview.replaceChildren();
    if (!row) preview.append(element("span", "mb-muted", tab === "Recipes" ? "Select a recipe to see its LoRAs." : "Select a LoRA to see its details."));
    else if (row.type === "folder") preview.append(element("span", "mb-name", row.name), element("span", "mb-muted", `${plural(row.count, "LoRA")}. Enter or Right opens the folder.`));
    else if (row.type === "recipe") recipePreview(row);
    else {
      detail = new AbortController();
      const { signal } = detail;
      const buttons = actions((keepOpen) => activate(row, keepOpen), "Add", "Add, keep open");
      preview.append(element("span", "mb-muted", "Loading details…"));
      json(`/lm/loras/details?name=${encodeURIComponent(stem(row.path))}`, { signal }).then((data) => {
        if (!signal.aborted) preview.replaceChildren(...overviewPanel(loraDetails(data.metadata, row.path), row.path, status), buttons, managerLink(row.path, "Full details"));
      }, () => {
        if (!signal.aborted) preview.replaceChildren(element("span", "mb-name", row.title), element("span", "mb-muted", "Details unavailable"), buttons);
      });
    }
  };

  const renderList = () => {
    if (browsing() && library && !folderRows(library, folder)) folder = "";
    rows = pickerRows(currentRows(), JSON.parse(widget.value));
    highlighted = Math.max(0, Math.min(highlighted, rows.length - 1));
    rowElements = rows.map(rowElement);
    list.replaceChildren();
    if (browsing()) {
      const nav = element("div", "mb-quick-nav");
      if (folder) {
        const back = button("", "Back to the parent folder", () => openFolder(parentFolder(folder), folder), "ghost");
        back.append(glyph("prev"), element("span", "", "Back"));
        nav.append(back);
      }
      nav.append(element("span", "mb-muted", folder || "All"));
      list.append(nav);
    }
    list.append(...rowElements);
    if (!rows.length) list.append(element("div", "mb-empty", emptyText()));
    for (const choice of layout.children) choice.setAttribute("aria-pressed", String(choice.dataset.mode === view));
    recentButton.setAttribute("aria-pressed", String(recentOnly));
    filters.setAttribute("aria-pressed", String(filtered));
    filters.textContent = filterLabel(activeFilters);
    filters.title = activeFilters ? `LoRA Manager has ${plural(activeFilters, "active filter")}` : "No active filters are set in LoRA Manager";
    status.textContent = summary();
    renderPreview();
  };

  const loadSearch = async () => {
    search?.abort();
    search = new AbortController();
    const { signal } = search;
    const recipeTab = tab === "Recipes";
    const text = encodeURIComponent(query());
    loading = true;
    listError = false;
    renderList();
    try {
      const data = await json(recipeTab
        ? `/lm/recipes?page=1&page_size=30&sort_by=date&search=${text}`
        : `/lm/loras/relative-paths?search=${text}&limit=60&match_model_name=true&include_model_name=true${filtered ? "&use_active_filters=true" : ""}`, { signal });
      if (signal.aborted) return;
      if (recipeTab) recipes = recipeRows(data.items);
      else found = libraryRows(data.items);
    } catch {
      if (signal.aborted) return;
      listError = true;
      if (recipeTab) recipes = []; else found = [];
    }
    loading = false;
    highlighted = 0;
    renderList();
  };

  const loadLibrary = async () => {
    loads?.abort();
    loads = new AbortController();
    const { signal } = loads;
    library = undefined;
    libraryError = false;
    json("/lm/loras/active-filters", { signal }).then((data) => {
      if (signal.aborted) return;
      activeFilters = filterCount(data.filters);
      renderList();
    }, () => {});
    try {
      const data = await json(`/lm/loras/folder-index${filtered ? "?use_active_filters=true" : ""}`, { signal });
      if (signal.aborted) return;
      library = data.root;
    } catch {
      if (signal.aborted) return;
      libraryError = true;
    }
    renderList();
  };

  const setTab = (name) => {
    tab = name;
    title.textContent = name === "Recipes" ? "Quick Pick · Recipe" : "Quick Pick · LoRA";
    dialog.setAttribute("aria-label", title.textContent);
    for (const choice of tabs.children) choice.setAttribute("aria-selected", String(choice.textContent === name));
    options.hidden = name === "Recipes";
    input.placeholder = name === "Recipes" ? "Search recipes, tags, LoRA names…" : "Search file or model name…";
    input.setAttribute("aria-label", name === "Recipes" ? "Search recipes" : "Search LoRAs");
    hints.textContent = HINTS[name];
    input.value = "";
    highlighted = 0;
    clearTimeout(timer);
    loadSearch();
    input.focus();
  };
  tabs.append(...Object.keys(HINTS).map((name) => {
    const choice = button(name, name, () => setTab(name), "ghost");
    choice.setAttribute("role", "tab");
    return choice;
  }));

  input.addEventListener("input", () => {
    clearTimeout(timer);
    search?.abort();
    timer = setTimeout(loadSearch, 180);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight(Math.max(0, Math.min(rows.length - 1, highlighted + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (browsing() && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      if (event.key === "ArrowLeft" && folder) openFolder(parentFolder(folder), folder);
      else if (event.key === "ArrowRight" && rows[highlighted]?.type === "folder") openFolder(rows[highlighted].path);
    } else if (event.key === "Enter" && rows[highlighted]) {
      event.preventDefault();
      activate(rows[highlighted], event.shiftKey);
    }
  });
  // Keys typed in the dialog stay out of ComfyUI's shortcuts.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus(); }
  });
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.body.append(backdrop);
  anchor.setAttribute("aria-expanded", "true");
  quickPick = { owner: widget, close };
  loadLibrary();
  setTab("LoRAs");
}

function loaderWidget(node, name) {
  const root = element("div", "mb mb-loras");
  const searchArea = element("div", "mb-search-area");
  const search = element("input", "mb-input mb-search");
  search.type = "search";
  search.placeholder = "Search LoRAs to add…";
  search.setAttribute("aria-label", "Search LoRAs to add");
  search.autocomplete = "off";
  const results = element("div", "mb-results");
  const topbar = element("div", "mb-joined");
  topbar.append(search);
  if (managerInstalled()) {
    const quickAdd = button("", "Quick Pick from LoRA Manager", () => openQuickPick(node, widget, quickAdd));
    quickAdd.setAttribute("aria-haspopup", "dialog");
    quickAdd.append(glyph("plus"), element("span", "", "Add"));
    topbar.append(quickAdd);
  }
  topbar.append(managerLink(""));
  searchArea.append(topbar, results);
  const status = element("div", "mb-status");
  status.setAttribute("role", "status");
  const searchPanel = element("div", "mb-panel mb-search-panel");
  searchPanel.append(searchArea, status);
  const list = element("div", "mb-list");
  const listHeading = element("div", "mb-section-head");
  const listPanel = element("div", "mb-panel mb-list-panel");
  listPanel.append(listHeading, list);
  root.append(searchPanel, listPanel);
  let timer, controller, disposed = false, selecting = false;
  let widget, synced, notified = "";
  let selected = 0;
  let dragFrom = -1;
  const expanded = new Set();

  const select = async (name) => {
    if (selecting) return;
    selecting = true;
    status.textContent = "Adding LoRA…";
    try {
      const words = await loraWords(node, name);
      if (disposed) return;
      const entry = { name, strength: 1, clipStrength: 1, linked: true, active: true, words };
      change(node, widget, addLora(JSON.parse(widget.value), entry));
      search.value = "";
      results.replaceChildren();
      status.textContent = "";
      search.focus();
    } catch (error) {
      if (!disposed) status.textContent = `Could not add LoRA: ${error.message}`;
    } finally {
      selecting = false;
    }
  };

  const showInfo = (anchor, entry) => {
    if (popover?.anchor === anchor) { closePopover(); return; }
    const box = element("div", "mb-popup mb-popover");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", `Details for ${entry.name}`);
    const tabs = element("div", "mb-tabs");
    tabs.setAttribute("role", "tablist");
    const body = element("div", "mb-info-body", "Loading details…");
    const note = element("div", "mb-status");
    note.setAttribute("role", "status");
    box.append(tabs, body, note, managerLink(entry.name, "Full details"));
    // Closing, opening another popover or removing the node aborts the requests of this one.
    const request = new AbortController();
    const { signal } = request;
    openPopover(anchor, box, widget, () => request.abort());
    box.focus({ preventScroll: true });
    const lora = encodeURIComponent(stem(entry.name));
    // Notes are shown read-only: saving them would write LoRA Manager's model metadata.
    Promise.all([
      json(`/lm/loras/details?name=${lora}`, { signal }),
      json(`/lm/loras/block-weight-schema?name=${lora}`, { signal }).then((data) => blockGroups(data.schema.blocks), () => []),
      json(`/lm/loras/get-notes?name=${lora}`, { signal }).then((data) => data.notes || "", () => ""),
    ]).then(([details, blocks, notes]) => {
      if (!signal.aborted) showTabs(tabs, body, infoTabs(blocks), infoPanels(entry, details.metadata, blocks, notes, note));
    }, () => {
      if (!signal.aborted) body.textContent = "Details unavailable";
    });
  };

  const move = (from, to) => {
    const current = JSON.parse(widget.value);
    if (from === to || to < 0 || to >= current.length) return;
    current.splice(to, 0, current.splice(from, 1)[0]);
    change(node, widget, current);
  };

  const render = (entries) => {
    const scroll = list.scrollTop;
    list.replaceChildren();
    const enabled =entries.filter((entry) => entry.active !== false).length;
    listHeading.replaceChildren(element("span", "mb-label", "Added LoRAs"), element("span", "mb-badge", `${enabled}/${entries.length} on`));
    if (entries.length) listHeading.append(button(enabled === entries.length ? "Disable all" : "Enable all", "Toggle all LoRAs", () => {
      change(node, widget, JSON.parse(widget.value).map((entry) => ({ ...entry, active: enabled !== entries.length })));
    }, "ghost"));
    if (!entries.length) {
      const empty = element("div", "mb-empty");
      empty.append(element("strong", "", "Build your LoRA stack"), element("span", "", "Search above and choose a result to add your first LoRA."));
      list.append(empty);
    }
    entries.forEach((entry, index) => {
      const card = element("div", "mb-card mb-lora");
      const update = (patch) => {
        const current = JSON.parse(widget.value);
        current[index] = { ...current[index], ...patch };
        change(node, widget, current);
      };
      const linked = entry.linked ?? Number(entry.strength) === Number(entry.clipStrength);
      const open = expanded.has(entry.name);

      const handle = element("span", "mb-grip", "⋮⋮");
      handle.title = "Drag to reorder";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        dragFrom = index;
        hidePreview();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", entry.name);
        event.dataTransfer.setDragImage(card, 12, 12);
        card.classList.add("mb-dragging");
      });
      handle.addEventListener("dragend", () => {
        dragFrom = -1;
        card.classList.remove("mb-dragging");
        list.querySelectorAll(".mb-drop-before, .mb-drop-after").forEach((item) => item.classList.remove("mb-drop-before", "mb-drop-after"));
      });
      card.addEventListener("dragover", (event) => {
        if (dragFrom < 0) return;
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        card.classList.toggle("mb-drop-after", after);
        card.classList.toggle("mb-drop-before", !after);
      });
      card.addEventListener("dragleave", () => card.classList.remove("mb-drop-before", "mb-drop-after"));
      card.addEventListener("drop", (event) => {
        if (dragFrom < 0) return;
        event.preventDefault();
        const after = card.classList.contains("mb-drop-after");
        const from = dragFrom;
        dragFrom = -1;
        let to = index + (after ? 1 : 0);
        if (from < to) to--;
        move(from, to);
      });
      const order = element("div", "mb-order");
      const up = button("", `Move ${entry.name} up`, () => move(index, index - 1), "ghost");
      const down = button("", `Move ${entry.name} down`, () => move(index, index + 1), "ghost");
      up.append(glyph("up"));
      down.append(glyph("down"));
      up.disabled = index === 0;
      down.disabled = index === entries.length - 1;
      order.append(up, down);

      const label = element("span", "mb-name", loraLabel(entry.name).title);
      label.title = entry.name;
      label.addEventListener("pointerenter", () => showPreview(label, entry.name));
      label.addEventListener("pointerleave", hidePreview);
      const identity = element("div", "mb-identity");
      identity.append(label);

      const settings = button("", `${open ? "Hide" : "Show"} link and CLIP settings for ${entry.name}`, () => {
        if (expanded.has(entry.name)) expanded.delete(entry.name); else expanded.add(entry.name);
        render(JSON.parse(widget.value));
      }, "ghost");
      settings.classList.add("mb-icon");
      settings.append(glyph("settings"));
      settings.setAttribute("aria-expanded", String(open));
      settings.classList.toggle("mb-attention", !linked);
      const remove = button("", `Remove ${entry.name}`, () => change(node, widget, JSON.parse(widget.value).filter((item) => item.name !== entry.name)), "ghost");
      remove.classList.add("mb-icon");
      remove.append(glyph("trash"));

      const row = element("div", "mb-card-head");
      row.append(handle, order, toggle(entry.active !== false, `Enable ${entry.name}`, (active) => update({ active })), identity,
        number(entry.strength, `Model strength ${entry.name}`, (strength) => update({ strength, ...(linked ? { clipStrength: strength } : {}) })),
        settings);
      if (managerInstalled()) {
        const info = button("", `Show details for ${entry.name}`, () => showInfo(info, entry), "ghost");
        info.classList.add("mb-icon");
        info.append(glyph("info"));
        info.setAttribute("aria-expanded", "false");
        row.append(info);
      }
      row.append(remove);
      card.dataset.active = String(entry.active !== false);
      card.append(row);

      if (open) {
        const link = button("", `Link model and CLIP for ${entry.name}`, () => update({ linked: !linked, ...(!linked ? { clipStrength: entry.strength } : {}) }));
        link.append(glyph("link"), element("span", "", linked ? "Linked" : "Link"));
        link.setAttribute("aria-pressed", String(linked));
        link.classList.add("mb-link-strengths");
        const extra = element("div", "mb-extra mb-joined");
        extra.append(element("span", "mb-addon", "CLIP"), number(entry.clipStrength, `CLIP strength ${entry.name}`, (clipStrength) => update({ clipStrength, ...(linked ? { strength: clipStrength } : {}) })), link);
        card.append(extra);
      }
      list.append(card);
    });
    list.scrollTop = scroll;
    const words = activeWords(entries, node.mode);
    if (words !== synced) syncConnected(node, words);
    synced = words;
    const names = activeLoraNames(entries).join("\n");
    if (names !== notified) loraManager?.notifyLoraNodeChanged(node);
    notified = names;
  };
  const result = makeWidget(node, name, root, [], render);
  widget = result.widget;
  const runSearch = async () => {
    controller?.abort();
    controller = new AbortController();
    const request = controller;
    const query = search.value.trim();
    results.replaceChildren();
    if (!query) { status.textContent = ""; return; }
    status.textContent = "Searching…";
    try {
      const manager = node.widgets?.find((item) => item.name === "loader")?.value === "LoRA Manager";
      const family = node.widgets?.find((item) => item.name === "family")?.value ?? "Any";
      // LoRA Manager returns at most 50 matches, so a family filter searches the full list here instead.
      const native = !manager || family !== "Any";
      selected = 0;
      let offset = 0;
      let more;
      do {
        const data = await json(native
          ? `/moobox-lora/search?q=${encodeURIComponent(query)}${family === "Any" ? "" : `&family=${encodeURIComponent(family)}`}${offset ? `&offset=${offset}` : ""}`
          : `/lm/loras/relative-paths?search=${encodeURIComponent(query)}&limit=50`, { signal: request.signal });
        if (disposed || request.signal.aborted || query !== search.value.trim()) return;
        const names = data.names || data.relative_paths || [];
        // Later pages append without touching the highlighted result.
        results.append(...names.map((name) => resultChoice(name, JSON.parse(widget.value).some((entry) => entry.name === name) ? "Added" : "", () => select(name))));
        if (!offset) results.children[0]?.classList.add("mb-selected");
        offset += names.length;
        more = native && names.length > 0 && offset < data.total;
        status.textContent = !offset ? "No matching LoRAs"
          : more ? `Showing ${offset} of ${data.total}…`
          : `${native ? `${data.total} ${data.total === 1 ? "match" : "matches"}. ` : ""}Choose a result or press Enter to add it.`;
      } while (more);
    } catch (error) {
      if (!disposed && error.name !== "AbortError") status.textContent = "Search unavailable. Check the selected loader in the advanced settings.";
    }
  };
  search.addEventListener("input", () => {
    controller?.abort();
    results.replaceChildren();
    clearTimeout(timer);
    timer = setTimeout(runSearch, 180);
  });
  search.addEventListener("keydown", (event) => {
    const choices = [...results.children];
    if (event.key === "Escape") { controller?.abort(); results.replaceChildren(); return; }
    if (!choices.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      choices[selected]?.classList.remove("mb-selected");
      selected = (selected + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
      choices[selected].classList.add("mb-selected");
      choices[selected].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation(); choices[selected].click();
    }
  });
  widget.closePopover = () => {
    if (popover?.owner === widget) closePopover();
    if (quickPick?.owner === widget) quickPick.close();
  };
  widget.onRemove = () => { disposed = true; clearTimeout(timer); controller?.abort(); hidePreview(); widget.closePopover(); };
  widget.refreshSearch = () => { clearTimeout(timer); runSearch(); };
  // Sent LoRAs are added at once under LoRA Manager's name; this swaps in ComfyUI's file name and reads their trigger words.
  widget.completeSent = async (sentNames) => {
    for (const sent of sentNames) {
      let name = sent, words = [];
      try {
        name = await comfyName(sent);
        words = await loraWords(node, name);
      } catch (error) {
        if (!disposed) status.textContent = `Could not complete ${sent}: ${error.message}`;
      }
      if (disposed) return;
      change(node, widget, JSON.parse(widget.value).map((entry) => entry.name === sent ? { ...entry, name, words } : entry));
    }
  };
  return result;
}

function triggerWidget(node, name) {
  const root = element("div", "mb mb-triggers");
  let widget;
  let previousList;
  const render = (state) => {
    const scroll = previousList?.scrollTop ?? 0;
    root.replaceChildren();
    const visible = state.groups.filter((group) => group.present !== false);
    const count = visible.reduce((sum, group) => sum + group.items.filter((item) => group.active && item.active).length, 0);
    const total = visible.reduce((sum, group) => sum + group.items.length, 0);
    const pills = state.view === "pills";
    const mutate = (index, action) => {
      const value = JSON.parse(widget.value);
      action(value.groups[index]);
      change(node, widget, value);
    };
    const heading = element("div", "mb-section-head");
    const views = element("div", "mb-joined mb-views");
    for (const [view, text] of [["groups", "Groups"], ["pills", "Pills"]]) {
      const choice = button(text, `Show trigger words as ${view}`, () => change(node, widget, { ...JSON.parse(widget.value), view }));
      choice.setAttribute("aria-pressed", String(pills === (view === "pills")));
      views.append(choice);
    }
    heading.append(element("span", "mb-label", "Trigger words"), element("span", "mb-badge", `${count}/${total} active`), views);
    root.append(heading);
    const absent = state.groups.length - visible.length;
    const list = element("div", "mb-list");
    if (!visible.length) {
      const empty = element("div", "mb-empty");
      empty.append(element("strong", "", "Ready for trigger words"), element("span", "", "Connect your loader’s trigger_words output, or enter words below."));
      list.append(empty);
    }
    const wordPills = (index, group) => group.items.map((item, itemIndex) => {
      const on = group.active && item.active;
      const pill = element("span", "mb-pill");
      pill.dataset.active = String(on);
      // Enabling a word in a disabled group switches the group on and keeps its other words off.
      const label = button(item.text, `Toggle word ${item.text}`, () => mutate(index, (value) => {
        if (on) { value.items[itemIndex].active = false; return; }
        if (!value.active) value.items.forEach((other) => { other.active = false; });
        value.active = true;
        value.items[itemIndex].active = true;
      }));
      label.setAttribute("aria-pressed", String(on));
      label.classList.add("mb-pill-label");
      pill.append(label, number(item.strength ?? 1, `Word weight ${item.text}`, (strength) => mutate(index, (value) => { value.items[itemIndex].strength = strength; })));
      return pill;
    });
    // Groups the source no longer produces stay editable in a dashed section until the user forgets them.
    const parked = element("div", "mb-absent");
    if (absent) {
      const title = element("div", "mb-section-head");
      title.append(element("span", "mb-label", `Not in source (${absent})`), button("Forget all", "Remove saved selections of groups the source no longer contains", () => {
        const value = JSON.parse(widget.value);
        change(node, widget, { ...value, groups: value.groups.filter((group) => group.present !== false) });
      }, "ghost"));
      parked.append(title);
    }
    for (const [target, present] of [[list, true], [parked, false]]) {
      const groups = [...state.groups.entries()].filter(([, group]) => (group.present !== false) === present);
      if (pills && groups.length) {
        const cloud = element("div", "mb-pills");
        for (const [index, group] of groups) cloud.append(...wordPills(index, group));
        target.append(cloud);
      }
      for (const [index, group] of pills ? [] : groups) {
        const box = element("div", "mb-card mb-group");
        box.dataset.active = String(group.active);
        const update = (action) => mutate(index, action);
        const row = element("div", "mb-card-head");
        const identity = element("div", "mb-identity");
        const label = element("span", "mb-name", group.text);
        label.title = group.text;
        identity.append(label);
        row.append(toggle(group.active, `Enable group ${group.text}`, (active) => update((item) => { item.active = active; })), identity,
          field("Weight", number(group.strength, `Group strength ${group.text}`, (strength) => update((item) => { item.strength = strength; }))));
        const words = element("div", "mb-pills");
        words.append(...wordPills(index, group));
        box.append(row, words);
        target.append(box);
      }
    }
    if (absent) list.append(parked);
    root.append(list);
    list.scrollTop = scroll;
    previousList = list;
    const editor = element("details", "mb-source-editor");
    const connected = node.inputs?.some((input) => input.name === "trigger_words" && input.link != null) || false;
    editor.open = !connected && !state.source;
    editor.append(element("summary", "", connected ? "Source · connected to loader" : "Edit source words"));
    const manual = element("textarea", "mb-input mb-source");
    manual.placeholder = "One group per line. Separate words within a group with commas.";
    manual.setAttribute("aria-label", "Trigger words");
    manual.readOnly = connected;
    manual.value = splitWords(state.source, true).join("\n");
    manual.addEventListener("change", () => {
      const defaultActive = node.widgets.find((item) => item.name === "default_active")?.value ?? false;
      change(node, widget, reconcileWords(state, manual.value.trim().replace(/\s*\n+\s*/g, ",, "), defaultActive));
    });
    editor.append(manual);
    root.append(editor);
  };
  const result = makeWidget(node, name, root, { source: "", groups: [] }, render);
  widget = result.widget;
  // ComfyUI drops the trigger_words input when the connected loader is bypassed or muted; the saved source must not stand in for it then.
  widget.serializeValue = () => {
    const value = JSON.parse(widget.value);
    return JSON.stringify(node.inputs?.some((input) => input.name === "trigger_words" && input.link != null) ? { ...value, source: "" } : value);
  };
  return result;
}

app.registerExtension({
  name: "MooBox.LoRAToolkit",
  getCustomWidgets() {
    return { MOOBOX_LORAS: loaderWidget, MOOBOX_TRIGGERS: triggerWidget };
  },
  async setup() {
    try {
      // ComfyUI serves the module under LoRA Manager's folder name: lower case from the registry, mixed case from a git clone.
      const manager = await import("/extensions/comfyui-lora-manager/lora_node_adapters.js")
        .catch(() => import("/extensions/ComfyUI-Lora-Manager/lora_node_adapters.js"));
      if (manager.LORA_NODE_ADAPTER_API_VERSION !== 1) return;
      manager.registerLoraNodeAdapter({
        id: "moobox",
        apiVersion: 1,
        nodeClasses: [LOADER],
        applyLoraCode({ node, loraCode, mode }) {
          const widget = node.widgets.find((item) => item.name === "loras");
          const before = JSON.parse(widget.value);
          const after = mergeLoraCode(before, loraCode, mode);
          change(node, widget, after);
          widget.completeSent(after.filter((entry) => !before.some((saved) => saved.name === entry.name)).map((entry) => entry.name));
        },
        getActiveLoraNames(node) {
          return activeLoraNames(JSON.parse(node.widgets?.find((item) => item.name === "loras")?.value ?? "[]"));
        },
      });
      loraManager = manager;
    } catch (error) {
      console.warn("MooBox: LoRA Manager's Send to ComfyUI is unavailable for the MooBox loader.", error);
    }
  },
  beforeRegisterNodeDef(type, data) {
    if (data.name !== LOADER && data.name !== TRIGGERS) return;
    const previous = type.prototype.onExecuted;
    type.prototype.onExecuted = function (message) {
      previous?.apply(this, arguments);
      if (data.name === LOADER && message.trigger_words) syncConnected(this, message.trigger_words[0]);
      if (data.name === TRIGGERS && message.source) setTriggerSource(this, message.source[0]);
    };
    if (data.name === LOADER) {
      const created = type.prototype.onNodeCreated;
      type.prototype.onNodeCreated = function () {
        created?.apply(this, arguments);
        const family = this.widgets?.find((item) => item.name === "family");
        const loras = this.widgets?.find((item) => item.name === "loras");
        if (family && loras) {
          const changed = family.callback;
          family.callback = (...args) => { changed?.(...args); loras.refreshSearch(); };
        }
        // Saved workflows restore their own choice when the node is configured afterwards.
        const loader = this.widgets?.find((item) => item.name === "loader");
        if (!loader) return;
        if (managerInstalled()) loader.value = "LoRA Manager";
        else loader.options.values = ["ComfyUI"];
      };
      const removed = type.prototype.onRemoved;
      type.prototype.onRemoved = function () {
        removed?.apply(this, arguments);
        this.widgets?.find((item) => item.name === "loras")?.closePopover();
      };
      const connected = type.prototype.onConnectionsChange;
      type.prototype.onConnectionsChange = function () {
        connected?.apply(this, arguments);
        const widget = this.widgets?.find((item) => item.name === "loras");
        if (widget) syncConnected(this, activeWords(JSON.parse(widget.value), this.mode));
      };
    }
  },
});
