import { element } from "./jobspanel.js";

const GB = 1024 ** 3;
export const STATS_INTERVALS = { "Off": 0, "1 s": 1000, "2 s": 2000, "5 s": 5000, "10 s": 10000 };

// Missing or failed values show a dash; VRAM is null when ComfyUI runs on the CPU.
export function statsState(stats) {
  const meter = (name, percent, detail) => Number.isFinite(percent)
    ? { name, percent: Math.max(0, Math.min(100, percent)), value: `${Math.round(percent)}%`, title: `${name} ${detail}` }
    : { name, percent: null, value: "—", title: `${name} not available` };
  const memory = (name, item) => meter(name, item?.total > 0 ? 100 * item.used / item.total : NaN,
    item && `${(item.used / GB).toFixed(1)} of ${(item.total / GB).toFixed(1)} GB`);
  return [meter("CPU", stats?.cpu, `${Math.round(stats?.cpu)}%`), memory("RAM", stats?.ram), memory("VRAM", stats?.vram)];
}

// Docks in the native action bar, which ComfyUI may build late, so every refresh docks it again when needed.
// The update timer is the only one in the pack and skips its request while the tab is hidden.
export function createStatsWidget(api, interval) {
  const root = element("button", "mbj-stats");
  root.type = "button";
  const meters = statsState(null).map(({ name }) => {
    const el = element("span", "mbj-stats-meter");
    const value = element("span", "mbj-stats-value");
    const fill = element("span", "mbj-stats-fill");
    const track = element("span", "mbj-stats-bar");
    track.append(fill);
    el.append(element("span", "mbj-stats-name", name), value, track);
    root.append(el);
    return { el, value, fill };
  });

  function place() {
    const parent = document.querySelector(".actionbar-container") || document.body;
    root.classList.toggle("mbj-stats-floating", parent === document.body);
    if (root.parentElement !== parent) parent.prepend(root);
  }

  function render(data) {
    statsState(data).forEach((state, index) => {
      const { el, value, fill } = meters[index];
      value.textContent = state.value;
      fill.style.width = state.percent === null ? "0" : `${state.percent}%`;
      el.title = state.title;
    });
    root.title = data ? "Click to refresh" : "System stats unavailable · click to retry";
  }

  const abort = new AbortController();
  async function refresh() {
    let data = null;
    try {
      const response = await api.fetchApi("/moobox-system", { cache: "no-store", signal: abort.signal });
      if (response.ok) data = await response.json();
    } catch {}
    if (abort.signal.aborted) return;
    render(data);
    place();
  }
  root.onclick = refresh;

  let timer = null;
  function setRate(ms) {
    clearInterval(timer);
    timer = ms > 0 ? setInterval(() => { if (!document.hidden && !root.hidden) void refresh(); }, ms) : null;
  }

  render(null);
  place();
  setRate(interval);
  void refresh();

  return {
    refresh,
    setRate,
    setVisible(visible) { root.hidden = visible === false; },
    close() {
      clearInterval(timer);
      abort.abort();
      root.remove();
    },
  };
}
