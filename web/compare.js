import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const COMPARE = "MooBoxImageCompare";
const BLINK_MS = 600;
const MODES = {
  ab: ["A/B", "Click the image to switch between A and B."],
  slider: ["Slider", "Drag the line: A on the left, B on the right."],
  blend: ["Blend", "Drag to fade B over A. The percentage is the opacity of B."],
  diff: ["Difference", "Orange shows where A and B differ, black where they match."],
  blink: ["Blink", "Switches between A and B automatically."],
};
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = new URL("./compare.css", import.meta.url).href;
document.head.append(style);

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function imageUrl(file) {
  const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  return api.apiURL(`/view?${params}`);
}

function setSource(img, url) {
  if (img.dataset.url === url) return;
  img.dataset.url = url;
  img.src = url;
}

function compareWidgets(node) {
  const state = node.properties.compare ??= { a: null, b: null, mode: "slider", position: 50 };
  const files = new Map();
  let blink;

  const wrap = element("div", "kc-wrap");
  const controls = element("div", "kc-root kc-controls");
  const view = element("div", "kc-root kc-view");
  const stage = element("div", "kc-stage");
  const frame = element("div", "kc-frame");
  const imgA = element("img");
  const imgB = element("img");
  const diff = element("canvas");
  const line = element("div", "kc-line");
  const tagA = element("span", "kc-tag");
  const tagB = element("span", "kc-tag");
  const empty = element("div", "kc-empty");
  imgA.crossOrigin = imgB.crossOrigin = "anonymous";
  frame.append(imgA, imgB, diff, line, tagA, tagB);
  stage.append(frame, empty);
  view.append(stage);

  const choose = (key, label) => {
    const select = element("select");
    select.setAttribute("aria-label", `Image ${label}`);
    select.addEventListener("change", () => { state[key] = Number(select.value); show(); });
    const wrapper = element("label", "", label);
    wrapper.append(select);
    return { select, wrapper };
  };
  const first = choose("a", "A");
  const second = choose("b", "B");
  const swap = element("button", "kc-swap", "⇄");
  swap.type = "button";
  swap.title = "Swap A and B";
  swap.addEventListener("click", () => { [state.a, state.b] = [state.b, state.a]; show(); });
  const mode = element("select");
  mode.setAttribute("aria-label", "Comparison mode");
  for (const [key, [label, info]] of Object.entries(MODES)) mode.append(Object.assign(element("option"), { value: key, textContent: label, title: info }));
  mode.addEventListener("change", () => { state.mode = mode.value; state.showB = false; show(); });
  const info = element("span", "kc-info", "ⓘ");
  const modes = element("div", "kc-mode");
  modes.append(mode, info);
  controls.append(first.wrapper, swap, second.wrapper, modes);

  const connected = () => (node.inputs ?? [])
    .filter((input) => /(^|\.)image\d+$/.test(input.name) && input.link != null)
    .map((input) => Number(input.name.match(/image(\d+)$/)[1]));
  const fit = () => {
    const natural = imgA.naturalWidth ? imgA : imgB;
    if (!natural.naturalWidth) return;
    const scale = Math.min(stage.clientWidth / natural.naturalWidth, stage.clientHeight / natural.naturalHeight);
    const width = natural.naturalWidth * scale;
    const height = natural.naturalHeight * scale;
    Object.assign(frame.style, { width: `${width}px`, height: `${height}px`, left: `${(stage.clientWidth - width) / 2}px`, top: `${(stage.clientHeight - height) / 2}px` });
  };
  const drawDiff = () => {
    if (state.mode !== "diff" || !imgA.naturalWidth || !imgB.naturalWidth || !imgA.complete || !imgB.complete) return;
    const { naturalWidth: width, naturalHeight: height } = imgA;
    diff.width = width;
    diff.height = height;
    const context = diff.getContext("2d", { willReadFrequently: true });
    context.drawImage(imgA, 0, 0);
    const a = context.getImageData(0, 0, width, height);
    context.drawImage(imgB, 0, 0, width, height);
    const b = context.getImageData(0, 0, width, height);
    for (let i = 0; i < a.data.length; i += 4) {
      const delta = Math.min(255, (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) * 3);
      b.data[i] = delta;
      b.data[i + 1] = delta * 0.6;
      b.data[i + 2] = 0;
      b.data[i + 3] = 255;
    }
    context.putImageData(b, 0, 0);
  };
  const options = (select, indexes, value) => {
    select.replaceChildren(...indexes.map((index) => Object.assign(element("option"), { value: index, textContent: `Image ${index + 1}` })));
    select.value = value;
  };
  const paint = () => {
    const slider = state.mode === "slider";
    const showB = state.mode === "ab" || state.mode === "blink" ? state.showB : true;
    imgA.style.visibility = state.mode === "diff" ? "hidden" : "visible";
    imgB.style.visibility = state.mode === "diff" || !showB ? "hidden" : "visible";
    imgB.style.clipPath = slider ? `inset(0 0 0 ${state.position}%)` : "none";
    imgB.style.opacity = state.mode === "blend" ? state.position / 100 : 1;
    diff.style.display = state.mode === "diff" ? "" : "none";
    line.style.display = slider ? "" : "none";
    line.style.left = `${state.position}%`;
    tagA.textContent = state.mode === "diff" ? "Diff" : `${state.a + 1}`;
    tagB.textContent = state.mode === "blend" ? `${state.b + 1} · ${Math.round(state.position)}%` : `${state.b + 1}`;
    const sideBySide = slider || state.mode === "blend";
    tagA.style.left = "6px";
    tagB.style.right = sideBySide ? "6px" : "";
    tagB.style.left = sideBySide ? "" : "6px";
    const single = state.mode === "ab" || state.mode === "blink";
    tagA.style.display = single && showB ? "none" : "";
    tagB.style.display = state.mode === "diff" || (single && !showB) ? "none" : "";
  };
  const show = () => {
    clearInterval(blink);
    const indexes = connected();
    if (!indexes.includes(state.a)) state.a = indexes[0] ?? null;
    if (!indexes.includes(state.b) || (state.b === state.a && indexes.length > 1)) state.b = indexes.find((index) => index !== state.a) ?? state.a;
    options(first.select, indexes, state.a);
    options(second.select, indexes, state.b);
    mode.value = state.mode;
    info.title = MODES[state.mode][1];
    const ready = files.has(state.a) && files.has(state.b);
    empty.textContent = indexes.length < 2 ? "Connect at least two images." : "Run the workflow to compare the connected images.";
    empty.style.display = ready ? "none" : "";
    frame.style.display = ready ? "" : "none";
    if (!ready) return;
    frame.dataset.mode = state.mode;
    setSource(imgA, imageUrl(files.get(state.a)));
    setSource(imgB, imageUrl(files.get(state.b)));
    if (state.mode === "blink") blink = setInterval(() => { state.showB = !state.showB; paint(); }, BLINK_MS);
    paint();
    drawDiff();
    fit();
  };
  const loaded = () => { fit(); drawDiff(); };
  imgA.addEventListener("load", loaded);
  imgB.addEventListener("load", loaded);
  new ResizeObserver(fit).observe(stage);

  const move = (event) => {
    const box = frame.getBoundingClientRect();
    state.position = Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100));
    paint();
  };
  frame.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (state.mode === "ab") { state.showB = !state.showB; paint(); return; }
    if (state.mode !== "slider" && state.mode !== "blend") return;
    frame.setPointerCapture(event.pointerId);
    move(event);
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", () => frame.removeEventListener("pointermove", move), { once: true });
  });

  wrap.append(controls, view);
  wrap.addEventListener("pointerdown", (event) => event.stopPropagation());
  wrap.addEventListener("wheel", (event) => event.stopPropagation());
  const widget = node.addDOMWidget("compare", "custom", wrap, { serialize: false, hideInPanel: true, getMinHeight: () => 360 });
  widget.computeLayoutSize = () => ({ minHeight: 360, minWidth: 360 });
  node.setSize([Math.max(node.size[0], 480), Math.max(node.size[1], 460)]);
  show();
  return {
    refresh: show,
    stop: () => clearInterval(blink),
    load(saved) {
      files.clear();
      for (const file of saved) files.set(Number(file.name.slice(5)), file);
      for (const img of [imgA, imgB]) delete img.dataset.url;
      show();
    },
  };
}

app.registerExtension({
  name: "MooBox.ImageCompare",
  beforeRegisterNodeDef(type, data) {
    if (data.name !== COMPARE) return;
    const created = type.prototype.onNodeCreated;
    type.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      this.compare = compareWidgets(this);
    };
    const changed = type.prototype.onConnectionsChange;
    type.prototype.onConnectionsChange = function () {
      changed?.apply(this, arguments);
      this.compare?.refresh();
    };
    const configured = type.prototype.onConfigure;
    type.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      this.compare?.refresh();
    };
    const removed = type.prototype.onRemoved;
    type.prototype.onRemoved = function () {
      removed?.apply(this, arguments);
      this.compare?.stop();
    };
    const executed = type.prototype.onExecuted;
    type.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      if (message.compare) this.compare.load(message.compare);
    };
  },
});
