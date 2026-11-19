import { barJob, element, isLocal, nodeName, overallProgress, primaryNode, subProgress } from "./jobspanel.js";

const POSITION_KEY = "moobox.jobs.widget";
const MARGIN = 8;
const DOCK_REACH = 220;

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
    step: job ? subProgress(job) : null,
    mine,
    label: !job ? "Idle" : [percent === null ? null : `${Math.floor(percent)}%`, node ? nodeName(job, node[0]) : "Running"].filter(Boolean).join(" · "),
    local: chip("Local builds", active.filter(item => isLocal(item, tag)), Boolean(job) && !mine),
    external: chip("External jobs", active.filter(item => !isLocal(item, tag)), mine),
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
  const root = element("div", "mb-widget");
  const grip = element("span", "mb-widget-grip", "⋮⋮");
  grip.title = "Drag to move · drop on the bar or double-click to dock";
  const meter = element("button", "mb-widget-meter");
  meter.type = "button";
  meter.onclick = openPanel;
  const fill = element("span", "mb-widget-fill");
  const label = element("span", "mb-widget-label");
  const step = element("span", "mb-widget-step");
  meter.append(fill, step, label);
  const local = element("span", "mb-badge mb-widget-count");
  const external = element("span", "mb-badge mb-widget-count mb-widget-external-count");
  root.append(grip, meter, local, external);
  document.body.append(root);

  let position = loadPosition(storage);

  function place() {
    const bar = document.querySelector(".actionbar-container");
    root.classList.toggle("mb-widget-floating", Boolean(position) || !bar);
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
    step.hidden = !state.step;
    step.style.width = state.step ? `${state.step.percent}%` : "0";
    root.classList.toggle("mb-widget-external", !state.idle && !state.mine);
    root.classList.toggle("mb-widget-idle", state.idle);
    meter.title = [state.label, state.step?.label, "click for details"].filter(Boolean).join(" · ");
    for (const [el, chip] of [[local, state.local], [external, state.external]]) {
      el.hidden = chip.count === 0;
      el.textContent = String(chip.count);
      el.title = chip.title;
      el.classList.toggle("mb-widget-waiting", chip.waiting);
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
      root.classList.toggle("mb-widget-docking", overDock(pointer.clientX, pointer.clientY));
      place();
    };
    const end = pointer => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      root.classList.remove("mb-widget-docking");
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
