import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { BAR_MODES, createBars, createPanel, createStore } from "./jobspanel.js";
import { createWidget } from "./jobswidget.js";

const TAB = "moobox-jobs";
const BAR_SETTING = "MooBox.Jobs.ProgressBar";
const WIDGET_SETTING = "MooBox.Jobs.Widget";
let bars, widget;

app.registerExtension({
  name: "MooBox.Jobs",
  settings: [{
    id: WIDGET_SETTING, category: ["MooBox", "Jobs", "Widget"], name: "Show jobs widget in the top bar",
    type: "boolean", defaultValue: true, onChange: (visible) => widget?.setVisible(visible),
  }, {
    id: BAR_SETTING, category: ["MooBox", "Jobs", "Progress bar"], name: "Progress bar position",
    type: "combo", options: BAR_MODES, defaultValue: "Both", onChange: () => bars?.render(),
  }],
  setup() {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("./jobs.css", import.meta.url).href;
    document.head.append(css);
    const store = createStore(api);
    const openPanel = () => app.extensionManager.sidebarTab?.toggleSidebarTab?.(TAB);
    bars = createBars(document.body, store, openPanel, () => app.ui.settings.getSettingValue(BAR_SETTING));
    widget = createWidget(store, openPanel);
    widget.setVisible(app.ui.settings.getSettingValue(WIDGET_SETTING));
    app.extensionManager.registerSidebarTab({
      id: TAB, icon: "icon-[lucide--activity]", title: "Jobs", tooltip: "Local builds and external jobs", type: "custom",
      render: (el) => createPanel(el, store, async (promptId) => {
        await api.fetchApi(`/jobs/${encodeURIComponent(promptId)}/cancel`, { method: "POST" });
        void store.refresh();
      }),
    });
  },
});
