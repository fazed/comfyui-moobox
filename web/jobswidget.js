import { barJob, element, isLocal, nodeName, overallProgress, primaryNode } from "./jobspanel.js";

const POSITION_KEY = "moobox.jobs.widget";
const MARGIN = 8;
const DOCK_REACH = 220;

export function widgetState(jobs, tag) {
  const active = jobs.filter(job => ["running", "queued"].includes(job.status));
  const job = barJob(jobs, tag);
  const percent = job ? overallProgress(job) : null;
  const node = job ? primaryNode(job) : null;
  return {
    idle: !job,
    percent,
    mine: Boolean(job) && isLocal(job, tag),
    label: !job ? "Idle" : [percent === null ? null : `${Math.floor(percent)}%`, node ? nodeName(job, node[0]) : "Running"].filter(Boolean).join(" · "),
    local: active.filter(item => isLocal(item, tag)).length,
    external: active.filter(item => !isLocal(item, tag)).length,
  };
}

function loadPosition(storage) {
  try {
    const { x, y } = JSON.parse(storage?.getItem(POSITION_KEY) || "null") || {};
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch { return null; }
}

// Docks in the native action bar. Dragging the grip floats it; dropping it on the bar or double-clicking the grip docks it again.
export function createWidget(store, openPanel, storage = globalThis.localStorage) {
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
  local.title = "Local builds";
  external.title = "External jobs";
  root.append(grip, meter, local, external);
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
    for (const [el, count] of [[local, state.local], [external, state.external]]) {
      el.hidden = count === 0;
      el.textContent = String(count);
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
  window.addEventListener("resize", place);
  const unsubscribe = store.subscribe(render);
  render();

  return {
    setVisible(visible) { root.hidden = visible === false; },
    close() {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", place);
      root.remove();
    },
  };
}
