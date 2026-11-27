import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { glyph } from "./icons.js";
import { outputKey } from "./previewstate.js";
import { exportableImages, exportMessage, exportVisible, lastRunImages, previewRefs } from "./savestate.js";
import "./styles.js";

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Shown while the save toggle is off: saves the temp previews of the last run to the output folder.
function exportWidget(node) {
  let images = [];
  const root = element("div", "mb mb-save");
  const button = element("button", "mb-btn");
  button.type = "button";
  button.title = "Save the previews of the last run to the output folder";
  button.append(glyph("save"), element("span", "", "Save"));
  const status = element("span", "mb-muted mb-save-status");
  root.append(button, status);
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  // One row: a maximum only, so saved node sizes load unchanged.
  const widget = node.addDOMWidget("export", "custom", root, { serialize: false, hideInPanel: true, getMaxHeight: () => 40 });
  const toggle = node.widgets?.find((item) => item.name === "save");

  const setStatus = (state, message) => {
    status.dataset.state = state;
    status.textContent = message;
    status.title = message;
  };
  const refresh = () => {
    const visible = exportVisible(toggle?.value);
    widget.hidden = !visible;
    root.style.display = visible ? "" : "none";
    button.disabled = !exportableImages(images).length;
    if (!images.length) setStatus("", visible ? "Run the workflow to preview, then save." : "");
    node.setDirtyCanvas?.(true, true);
  };
  if (toggle) {
    const callback = toggle.callback;
    toggle.callback = function () {
      const result = callback?.apply(this, arguments);
      refresh();
      return result;
    };
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    setStatus("busy", "Saving...");
    try {
      const response = await api.fetchApi("/moobox-save/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: exportableImages(images) }),
      });
      const { state, message } = exportMessage(response.status, await response.text());
      setStatus(state, message);
    } catch (error) {
      setStatus("error", `Saving failed: ${error.message}`);
    }
    button.disabled = !exportableImages(images).length;
  });
  refresh();
  return {
    show(list) {
      images = Array.isArray(list) ? list : [];
      setStatus("", "");
      refresh();
    },
    refresh,
  };
}

app.registerExtension({
  name: "MooBox.SaveImage",
  beforeRegisterNodeDef(type, data) {
    if (data.name !== "MooBoxSaveImage") return;
    const created = type.prototype.onNodeCreated;
    type.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      this.mooboxExport = exportWidget(this);
    };
    // Undo recreates the node and a page reload empties app.nodeOutputs: the previews of the last run are
    // also kept in node.properties (read here, never captured at creation, as configure replaces properties).
    const configured = type.prototype.onConfigure;
    type.prototype.onConfigure = function () {
      configured?.apply(this, arguments);
      this.mooboxExport?.show(lastRunImages(app.nodeOutputs[outputKey(this)]?.images, this.properties?.moobox_previews));
    };
    const executed = type.prototype.onExecuted;
    type.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      this.properties.moobox_previews = previewRefs(message?.images);
      // Properties changed without a graph event: let ComfyUI store the open workflow so a page reload keeps them.
      app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState();
      this.mooboxExport?.show(message?.images);
    };
  },
});
