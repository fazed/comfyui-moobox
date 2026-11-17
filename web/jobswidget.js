import { barJob, element, isLocal, nodeName, overallProgress, primaryNode } from "./jobspanel.js";

const POSITION_KEY = "moobox.jobs.widget";
const MARGIN = 8;
const DOCK_REACH = 220;
const STATS_DELAY = 1000;

// The queue runs one job at a time, so a group without a running job waits behind the other one.
function chip(name, items, otherRunning) {
  const running = items.filter(job => job.status === "running").length;
  const queued = items.length - running;
  if (queued && !running && otherRunning) {
    const position = items.length === 1 ? items[0].position : null;
    const other = name === "Local builds" ? "an external job" : "a local build";
    return { count: items.length, waiting: true, title: `${name}: ${queued} waiting behind ${other}${position ? ` · queue position ${position}` : ""}` };
  }
  return { count: items.length, waiting: false, title: `${name}: ${running} running, ${queued} queued` };
}

export function widgetState(jobs, tag) {
  const active = jobs.filter(job => ["running", "queued"].includes(job.status));
  const job = barJob(jobs, tag);
  const percent = job ? overallProgress(job) : null;
  const node = job ? primaryNode(job) : null;
  const mine = Boolean(job) && isLocal(job, tag);
  return {
    idle: !job,
    percent,
    mine,
    label: !job ? "Idle" : [percent === null ? null : `${Math.floor(percent)}%`, node ? nodeName(job, node[0]) : "Running"].filter(Boolean).join(" · "),
    local: chip("Local builds", active.filter(item => isLocal(item, tag)), Boolean(job) && !mine),
    external: chip("External jobs", active.filter(item => !isLocal(item, tag)), mine),
  };
}

const GB = 1024 ** 3;

// Missing or failed values show a dash; VRAM is null when ComfyUI runs on the CPU.
export function statsState(stats) {
  const meter = (name, percent, detail) => Number.isFinite(percent)
    ? { name, percent: Math.max(0, Math.min(100, percent)), value: `${Math.round(percent)}%`, title: `${name} ${detail}` }
    : { name, percent: null, value: "—", title: `${name} not available` };
  const memory = (name, item) => meter(name, item?.total > 0 ? 100 * item.used / item.total : NaN,
    item && `${(item.used / GB).toFixed(1)} of ${(item.total / GB).toFixed(1)} GB`);
  return [meter("CPU", stats?.cpu, `${Math.round(stats?.cpu)}%`), memory("RAM", stats?.ram), memory("VRAM", stats?.vram)];
}

function loadPosition(storage) {
  try {
    const { x, y } = JSON.parse(storage?.getItem(POSITION_KEY) || "null") || {};
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch { return null; }
}

// Docks in the native action bar. Dragging the grip floats it; dropping it on the bar or double-clicking the grip docks it again.
export function createWidget(store, openPanel, api, storage = globalThis.localStorage) {
  const root = element("div", "mbj-widget");
  const grip = element("span", "mbj-widget-grip", "⋮⋮");
  grip.title = "Drag to move · drop on the bar or double-click to dock";
  const meter = element("button", "mbj-widget-meter");
  meter.type = "button";
  meter.onclick = openPanel;
  const fill = element("span", "mbj-widget-fill");
  const label = element("span", "mbj-widget-label");
  meter.append(fill, label);
  const local = element("span", "mbj-widget-count mbj-widget-local");
  const external = element("span", "mbj-widget-count mbj-widget-external-count");
  const stats = element("button", "mbj-widget-stats");
  stats.type = "button";
  const meters = statsState(null).map(({ name }) => {
    const el = element("span", "mbj-widget-stat");
    const value = element("span", "mbj-widget-stat-value");
    const fill = element("span", "mbj-widget-stat-fill");
    const track = element("span", "mbj-widget-stat-bar");
    track.append(fill);
    el.append(element("span", "mbj-widget-stat-name", name), value, track);
    stats.append(el);
    return { el, value, fill };
  });
  root.append(grip, meter, local, external, stats);
  document.body.append(root);

  let position = loadPosition(storage);

  function place() {
    const bar = document.querySelector(".actionbar-container");
    root.classList.toggle("mbj-widget-floating", Boolean(position) || !bar);
    if (position) {
      if (root.parentElement !== document.body) document.body.append(root);
      root.style.right = "auto";
      root.style.left = `${Math.min(position.x, window.innerWidth - root.offsetWidth - MARGIN)}px`;
      root.style.top = `${Math.min(position.y, window.innerHeight - root.offsetHeight - MARGIN)}px`;
      return;
    }
    root.style.left = root.style.top = root.style.right = "";
    const parent = bar || document.body;
    if (root.parentElement !== parent) parent.prepend(root);
  }

  function render() {
    const state = widgetState(store.snapshot?.jobs || [], store.tag);
    label.textContent = state.label;
    fill.style.width = state.percent === null ? "0" : `${state.percent}%`;
    root.classList.toggle("mbj-widget-external", !state.idle && !state.mine);
    root.classList.toggle("mbj-widget-idle", state.idle);
    meter.title = `${state.label} · click for details`;
    for (const [el, chip] of [[local, state.local], [external, state.external]]) {
      el.hidden = chip.count === 0;
      el.textContent = String(chip.count);
      el.title = chip.title;
      el.classList.toggle("mbj-widget-waiting", chip.waiting);
    }
    place();
  }

  // Dropping the widget on (or just left of) the action bar docks it again.
  function overDock(x, y) {
    const bar = document.querySelector(".actionbar-container")?.getBoundingClientRect();
    return Boolean(bar) && x >= bar.left - DOCK_REACH && x <= bar.right && y >= bar.top - MARGIN && y <= bar.bottom + MARGIN;
  }

  grip.onpointerdown = event => {
    if (event.button !== 0) return;
    const box = root.getBoundingClientRect();
    const offset = { x: event.clientX - box.left, y: event.clientY - box.top };
    const move = pointer => {
      position = { x: Math.max(0, pointer.clientX - offset.x), y: Math.max(0, pointer.clientY - offset.y) };
      root.classList.toggle("mbj-widget-docking", overDock(pointer.clientX, pointer.clientY));
      place();
    };
    const end = pointer => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      root.classList.remove("mbj-widget-docking");
      if (!position) return;
      if (overDock(pointer.clientX, pointer.clientY)) dock();
      else storage?.setItem(POSITION_KEY, JSON.stringify(position));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    event.preventDefault();
  };
  function dock() {
    position = null;
    storage?.removeItem(POSITION_KEY);
    place();
  }
  grip.ondblclick = dock;

  // ComfyUI builds its action bar after extensions load and may rebuild it, so dock again when it appears.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued || (root.isConnected && (position || root.parentElement?.matches(".actionbar-container")))) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; place(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function renderStats(data) {
    statsState(data).forEach((state, index) => {
      const { el, value, fill } = meters[index];
      value.textContent = state.value;
      fill.style.width = state.percent === null ? "0" : `${state.percent}%`;
      el.title = state.title;
    });
    stats.title = data ? "Click to refresh" : "System stats unavailable · click to retry";
  }

  // No polling: stats refresh on creation, workflow load, a click and job updates, at most once per STATS_DELAY.
  const abort = new AbortController();
  let statsTimer = null;
  async function refreshStats() {
    clearTimeout(statsTimer);
    statsTimer = null;
    let data = null;
    try {
      const response = await api.fetchApi("/moobox-system", { cache: "no-store", signal: abort.signal });
      if (response.ok) data = await response.json();
    } catch {}
    if (!abort.signal.aborted) renderStats(data);
  }
  stats.onclick = refreshStats;

  window.addEventListener("resize", place);
  const unsubscribe = store.subscribe(() => {
    render();
    statsTimer ??= setTimeout(refreshStats, STATS_DELAY);
  });
  render();
  void refreshStats();

  return {
    refreshStats,
    setVisible(visible) { root.hidden = visible === false; },
    close() {
      unsubscribe();
      clearTimeout(statsTimer);
      abort.abort();
      observer.disconnect();
      window.removeEventListener("resize", place);
      root.remove();
    },
  };
}
