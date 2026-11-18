import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { glyph } from "./icons.js";
import { activeWords, addLora, reconcileWords, splitWords } from "./state.js";
import "./styles.js";

const LOADER = "MooBoxLoraLoader";
const TRIGGERS = "MooBoxTriggerWords";
const MANAGER_NODE = "Lora Loader (LoraManager)";

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
  topbar.append(search, managerLink(""));
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
  let widget, synced;
  let selected = 0;
  let dragFrom = -1;
  const expanded = new Set();

  const select = async (name) => {
    if (selecting) return;
    selecting = true;
    status.textContent = "Adding LoRA…";
    const manager = node.widgets?.find((item) => item.name === "loader")?.value === "LoRA Manager";
    try {
      let words;
      if (manager) {
        const data = await json(`/lm/loras/get-trigger-words?name=${encodeURIComponent(stem(name))}`);
        if (data.success === false) throw new Error("LoRA Manager could not read this LoRA.");
        words = data.trigger_words || [];
      } else {
        const data = await json(`/moobox-lora/words?name=${encodeURIComponent(name)}`);
        words = data.words;
        // Metadata is optional; the loader and saved selections do not depend on LoRA Manager.
        if (!words.length) {
          try {
            const response = await api.fetchApi(`/lm/loras/get-trigger-words?name=${encodeURIComponent(stem(name))}`);
            if (response.ok) words = (await response.json()).trigger_words || [];
          } catch {
            words = [];
          }
        }
      }
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

      const parts = entry.name.replaceAll("\\", "/").split("/");
      const label = element("span", "mb-name", parts.pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, ""));
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
      const manager = managerLink(entry.name, "");
      manager.classList.add("mb-icon");
      manager.dataset.variant = "ghost";

      const row = element("div", "mb-card-head");
      row.append(handle, order, toggle(entry.active !== false, `Enable ${entry.name}`, (active) => update({ active })), identity,
        number(entry.strength, `Model strength ${entry.name}`, (strength) => update({ strength, ...(linked ? { clipStrength: strength } : {}) })),
        settings, manager, remove);
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
        results.append(...names.map((name) => {
          const choice = button("", `Add ${name}`, () => select(name), "ghost");
          choice.classList.add("mb-result");
          const parts = name.replaceAll("\\", "/").split("/");
          const title = parts.pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
          const thumb = element("img", "mb-thumb");
          thumb.alt = "";
          thumb.loading = "lazy";
          thumb.addEventListener("error", () => { thumb.style.visibility = "hidden"; });
          thumb.src = previewUrl(name);
          choice.append(thumb, element("span", "mb-result-name", title), element("span", "mb-result-folder", parts.join(" / ") || "LoRA library"));
          if (JSON.parse(widget.value).some((entry) => entry.name === name)) choice.append(element("span", "mb-badge mb-result-add", "Added"));
          return choice;
        }));
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
  widget.onRemove = () => { disposed = true; clearTimeout(timer); controller?.abort(); hidePreview(); };
  widget.refreshSearch = () => { clearTimeout(timer); runSearch(); };
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
        if (LiteGraph.registered_node_types[MANAGER_NODE]) loader.value = "LoRA Manager";
        else loader.options.values = ["ComfyUI"];
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
