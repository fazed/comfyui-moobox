import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { glyph } from "./icons.js";
import { counterText, outputKey, stepIndex } from "./previewstate.js";
import "./styles.js";

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

function previewWidget(node) {
  let files = [];
  let index = 0;
  const root = element("div", "mb mb-images");
  const bar = element("div", "mb-images-bar");
  const counter = element("span", "mb-badge mb-images-counter");
  const stage = element("div", "mb-images-stage");
  const img = element("img");
  const empty = element("div", "mb-empty mb-images-empty", "Run the workflow to preview the connected images.");
  const button = (icon, title, delta) => {
    const el = element("button", "mb-btn");
    el.type = "button";
    el.title = title;
    el.setAttribute("aria-label", title);
    el.append(glyph(icon));
    el.addEventListener("click", () => { index = stepIndex(index, delta, files.length); show(); });
    return el;
  };
  const prev = button("prev", "Previous image", -1);
  const next = button("next", "Next image", 1);
  bar.append(prev, counter, next);
  stage.append(img, empty);
  root.append(bar, stage);

  const show = () => {
    counter.textContent = counterText(index, files.length);
    prev.disabled = next.disabled = files.length < 2;
    empty.style.display = files.length ? "none" : "";
    img.style.display = files.length ? "" : "none";
    if (files.length) img.src = imageUrl(files[index]);
  };
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  node.addDOMWidget("preview", "custom", root, { serialize: false, hideInPanel: true });
  // New nodes start large enough to show an image. No minimum: it would stretch smaller saved sizes on load.
  node.setSize([Math.max(node.size[0], 400), Math.max(node.size[1], 460)]);
  show();
  return (images) => { files = images; index = 0; show(); };
}

app.registerExtension({
  name: "MooBox.PreviewImages",
  beforeRegisterNodeDef(type, data) {
    if (data.name !== "MooBoxPreviewImages") return;
    const created = type.prototype.onNodeCreated;
    type.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      this.showImages = previewWidget(this);
    };
    // Undo and other graph reloads recreate the node: show the images of the last run again.
    const configured = type.prototype.onConfigure;
    type.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      const output = app.nodeOutputs[outputKey(this)];
      if (output?.previews) this.showImages(output.previews);
    };
    const executed = type.prototype.onExecuted;
    type.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      if (message.previews) this.showImages(message.previews);
    };
  },
});
