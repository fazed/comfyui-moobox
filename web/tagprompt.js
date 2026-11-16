import { app } from "../../scripts/app.js";
import { release } from "./autocomplete.js";
import { formatTags } from "./tags.js";

const MIN_HEIGHT = 190;

function element(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function tagWidget(node, name) {
  const root = element("div", "kt-tagbox");
  const picker = element("input", "kt-tag-input");
  picker.type = "text";
  picker.placeholder = "Add a tag…";
  picker.autocomplete = "off";
  picker.spellcheck = false;
  picker.dataset.ktTagPicker = "1";
  const area = element("textarea", "kt-tag-area");
  area.placeholder = "tag, tag, …";
  area.spellcheck = false;
  area.dataset.ktTagField = "1";
  root.append(picker, area);

  picker.addEventListener("kt-tag", (event) => {
    area.value = formatTags(`${area.value}, ${event.detail}`);
    node.setDirtyCanvas(true, true);
  });
  area.addEventListener("blur", () => { area.value = formatTags(area.value); });
  root.dataset.captureWheel = "true";
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  root.addEventListener("wheel", (event) => event.stopPropagation());

  const widget = node.addDOMWidget(name, "custom", root, {
    getValue: () => area.value,
    setValue: (value) => { area.value = value; },
    serialize: true,
    hideInPanel: true,
    getMinHeight: () => MIN_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: MIN_HEIGHT, minWidth: 300 });
  widget.serializeValue = () => formatTags(area.value);
  const removed = widget.onRemove;
  widget.onRemove = function () {
    release(picker);
    release(area);
    return removed?.apply(this, arguments);
  };
  return { widget, minWidth: 300, minHeight: MIN_HEIGHT };
}

app.registerExtension({
  name: "MooBox.TagPrompt",
  getCustomWidgets() {
    return { MOOBOX_TAGS: tagWidget };
  },
});
