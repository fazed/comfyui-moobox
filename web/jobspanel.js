export function acceptSnapshot(previous, next) {
  return next?.schema === 1 && Array.isArray(next.jobs) &&
    (!previous || next.epoch !== previous.epoch || next.revision > previous.revision);
}

export function progress(value, max) {
  return max > 0 && Number.isFinite(value) && Number.isFinite(max)
    ? Math.max(0, Math.min(100, 100 * value / max)) : null;
}

// Same FNV-1a hash as jobs.py: the server never shares raw client ids.
export function clientTag(clientId) {
  if (!clientId) return "";
  let tag = 0x811c9dc5;
  for (const char of String(clientId)) tag = Math.imul(tag ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return tag.toString(16).padStart(8, "0");
}

export function isLocal(job, tag) {
  return Boolean(tag) && job.client === tag;
}

// Equal node weights estimate graph completion, never remaining time.
export function overallProgress(job) {
  if (job.status === "completed") return 100;
  const ids = Object.keys(job.node_types || {});
  if (!ids.length) return null;
  const completed = job.completed_nodes || {};
  let done = ids.filter(id => id in completed).length;
  for (const [id, node] of Object.entries(job.nodes || {})) {
    if (ids.includes(id) && !(id in completed) && node.max > 1)
      done += (progress(node.value, node.max) || 0) / 100;
  }
  return Math.min(99, 100 * done / ids.length);
}

// Lazy switches may remain "running" while waiting for dependencies.
// Prefer a node reporting real step progress over those placeholder states.
export function primaryNode(job) {
  const nodes = Object.entries(job.nodes || {});
  const measured = nodes.filter(([, node]) => node.max > 1 && progress(node.value, node.max) !== null);
  const candidates = measured.length ? measured : nodes;
  return candidates.find(([id]) => id === job.current_node) || candidates.at(-1) || null;
}

export function nodeName(job, id) {
  return job.node_labels?.[id] || job.node_types?.[id] || "Active node";
}

// The bar shows one job: a running local build first, otherwise a running external job.
export function barJob(jobs, tag) {
  const running = jobs.filter(job => job.status === "running");
  const local = running.find(job => isLocal(job, tag));
  return local || running.at(-1) || null;
}

export function createStore(api) {
  const listeners = new Set();
  const abort = new AbortController();
  let latest = null, online = false, fetching = false;
  const store = {
    get snapshot() { return latest; },
    get tag() { return clientTag(api.clientId); },
    get online() { return online; },
    subscribe(listener) {
      listeners.add(listener);
      if (latest) listener();
      return () => listeners.delete(listener);
    },
    refresh,
    close() {
      abort.abort();
      api.removeEventListener("moobox_jobs.snapshot", onSnapshot);
      api.removeEventListener("reconnected", refresh);
      api.removeEventListener("reconnecting", onOffline);
      listeners.clear();
    },
  };
  const emit = () => listeners.forEach(listener => listener());
  function receive(snapshot) {
    if (!acceptSnapshot(latest, snapshot)) return;
    latest = snapshot;
    online = true;
    emit();
  }
  async function refresh() {
    if (fetching) return;
    fetching = true;
    try {
      const response = await api.fetchApi("/moobox-jobs/snapshot", { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error(String(response.status));
      receive(await response.json());
    } catch { onOffline(); }
    finally { fetching = false; }
  }
  function onOffline() {
    online = false;
    emit();
  }
  const onSnapshot = event => receive(event.detail?.snapshot);
  api.addEventListener("moobox_jobs.snapshot", onSnapshot);
  api.addEventListener("reconnected", refresh);
  api.addEventListener("reconnecting", onOffline);
  void refresh();
  return store;
}

export function element(tag, className = "", text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function bar(value, small = false, label = "Progress") {
  const el = element("progress", small ? "mbj-bar mbj-bar-small" : "mbj-bar");
  el.max = 100;
  if (value !== null) el.value = value;
  el.setAttribute("aria-label", label);
  return el;
}

const labels = { completed: "Completed", error: "Failed", interrupted: "Interrupted", removed: "Removed", unknown: "Unknown", running: "Running" };

function stepRows(job, primaryId) {
  const rows = [];
  const add = (id, state) => {
    const row = element("div", "mbj-step");
    row.append(element("span", "", `${nodeName(job, id)} · ${id}`), element("span", "mbj-muted", state));
    rows.push(row);
  };
  for (const [id, node] of Object.entries(job.nodes || {})) {
    if (id === primaryId) continue;
    const percent = node.max > 1 ? progress(node.value, node.max) : null;
    add(id, percent === null ? "No step updates" : `${Math.round(percent)}%`);
  }
  for (const [id, state] of Object.entries(job.completed_nodes || {})) add(id, state === "cached" ? "Cached" : "Completed");
  return rows;
}

export function createPanel(el, store, stop) {
  const root = element("section", "mbj");
  el.replaceChildren(root);
  const header = element("header", "mbj-header");
  const connection = element("span", "mbj-connection", "Connecting…");
  connection.setAttribute("role", "status");
  header.append(element("h2", "", "Jobs"), connection);
  const local = element("div", "mbj-group");
  const external = element("div", "mbj-group");
  root.append(header, local, external);
  const open = new Set();

  function details(key, className, summaryText, summaryExtra) {
    const el = element("details", className);
    el.open = open.has(key);
    el.ontoggle = () => { if (el.open) open.add(key); else open.delete(key); };
    const summary = element("summary");
    summary.append(element("span", "", summaryText));
    if (summaryExtra) summary.append(summaryExtra);
    el.append(summary);
    return el;
  }

  function stopButton(job, label) {
    const button = element("button", "mbj-stop", label);
    button.type = "button";
    button.title = job.status === "running" ? "Stop this build" : "Remove from queue";
    button.setAttribute("aria-label", button.title);
    button.onclick = () => stop(job.prompt_id);
    return button;
  }

  function runCard(job, canStop) {
    const card = element("article", "mbj-card");
    const overall = overallProgress(job);
    const headline = element("div", "mbj-headline");
    headline.append(element("h3", "", "Workflow"), element("strong", "mbj-percent", overall === null ? "—" : `${Math.floor(overall)}%`));
    if (canStop) headline.append(stopButton(job, "Stop"));
    const overallBar = bar(overall, false, "Overall workflow progress (estimate)");
    overallBar.title = "Node-based estimate, not remaining time";
    card.append(headline, overallBar);
    const primary = primaryNode(job);
    if (!primary) card.append(element("p", "mbj-hint", "Preparing node…"));
    else {
      const [id, node] = primary;
      const percent = node.max > 1 ? progress(node.value, node.max) : null;
      const line = element("div", "mbj-line");
      const name = element("span", "mbj-node-name", nodeName(job, id));
      name.title = nodeName(job, id);
      line.append(name, element("span", "mbj-node-percent", percent === null ? "Reported active" : `${Math.round(percent)}%`));
      const type = job.node_types?.[id];
      const description = `${type && type !== nodeName(job, id) ? `${type} · ` : ""}Node ${id}`;
      const block = element("div", "mbj-node");
      block.append(line, bar(percent, true, `Node ${id} progress`),
        element("p", "mbj-hint", percent === null ? description : `${description} · ${node.value} / ${node.max} steps`));
      card.append(block);
    }
    const steps = stepRows(job, primary?.[0]);
    if (steps.length) {
      const run = details(`run:${job.prompt_id}`, "mbj-run", `Steps · ${steps.length}`);
      run.append(...steps);
      card.append(run);
    }
    return card;
  }

  function historyRun(job) {
    const steps = stepRows(job);
    const run = details(`run:${job.prompt_id}`, `mbj-run mbj-state-${job.status}`, labels[job.status] || job.status,
      element("code", "mbj-short-id", job.prompt_id.slice(0, 8)));
    run.append(element("code", "mbj-job-id", job.prompt_id));
    if (!steps.length) run.append(element("p", "mbj-muted", "No steps recorded."));
    run.append(...steps);
    if (job.status === "error") run.append(element("p", "mbj-muted", job.error_type || "See the server log for error details."));
    return run;
  }

  function renderGroup(container, title, jobs, isLocalGroup) {
    const running = jobs.filter(job => job.status === "running");
    const waiting = jobs.filter(job => job.status === "queued").sort((a, b) => a.position - b.position);
    const finished = jobs.filter(job => !["running", "queued"].includes(job.status)).reverse();
    const heading = element("div", "mbj-line mbj-title");
    heading.append(element("span", "", title), element("span", "mbj-count", String(running.length + waiting.length)));
    if (!isLocalGroup) heading.append(element("span", "mbj-badge", "read-only"));
    container.replaceChildren(heading);
    if (!running.length) container.append(element("p", "mbj-muted mbj-idle", isLocalGroup ? "No active builds" : "No active external jobs"));
    for (const job of running) container.append(runCard(job, isLocalGroup));
    for (const job of waiting) {
      const row = element("div", "mbj-queue-row");
      row.append(element("span", "mbj-muted", `#${job.position}`), element("code", "mbj-short-id", job.prompt_id));
      if (isLocalGroup) row.append(stopButton(job, "×"));
      container.append(row);
    }
    const history = details(`history:${title}`, "mbj-history", `History · ${finished.length}`);
    for (const job of finished) history.append(historyRun(job));
    if (!finished.length) history.append(element("p", "mbj-muted", "Finished jobs will appear here."));
    container.append(history);
  }

  function render() {
    const online = store.online;
    connection.textContent = online ? "Live" : "Offline";
    connection.className = online ? "mbj-connection mbj-online" : "mbj-connection";
    connection.title = online ? "Updates automatically" : "Displayed data may be stale";
    const jobs = store.snapshot?.jobs || [];
    renderGroup(local, "Local builds", jobs.filter(job => isLocal(job, store.tag)), true);
    renderGroup(external, "External jobs", jobs.filter(job => !isLocal(job, store.tag)), false);
  }

  const unsubscribe = store.subscribe(render);
  render();
  return () => { unsubscribe(); root.remove(); };
}

export const BAR_MODES = ["Top of window", "On Jobs icon", "Both"];

function progressBar(tag, className, parent, openPanel) {
  const el = element(tag, className);
  const fill = element("span", "mbj-bar-fill");
  el.append(fill);
  if (openPanel) {
    el.type = "button";
    el.onclick = openPanel;
  }
  parent.append(el);
  return { el, fill };
}

// The top line and the line on the Jobs sidebar icon show the same job; the mode picks which exist.
export function createBars(parent, store, openPanel, getMode) {
  const top = progressBar("button", "mbj-topbar", parent, openPanel);
  const tab = progressBar("span", "mbj-tabbar", parent);

  // Inside the sidebar button the line follows the button's layout and its own click toggles the tab.
  function placeTabBar() {
    const button = document.querySelector(`[class~="icon-[lucide--activity]"]`)?.closest("button");
    if (button && tab.el.parentElement !== button) button.append(tab.el);
  }

  function render() {
    const mode = getMode();
    const job = barJob(store.snapshot?.jobs || [], store.tag);
    const overall = job && overallProgress(job);
    const primary = job && primaryNode(job);
    const mine = job && isLocal(job, store.tag);
    const title = job && [mine ? "Local build" : "External job", overall === null ? null : `${Math.floor(overall)}%`,
      primary ? nodeName(job, primary[0]) : null, "click for details"].filter(Boolean).join(" · ");
    for (const [bar, shown] of [[top, mode !== "On Jobs icon"], [tab, mode !== "Top of window"]]) {
      bar.el.classList.toggle("mbj-bar-active", Boolean(job) && shown);
      if (!job) continue;
      bar.el.classList.toggle("mbj-bar-external", !mine);
      bar.el.classList.toggle("mbj-bar-unknown", overall === null);
      bar.fill.style.width = overall === null ? "" : `${overall}%`;
      bar.el.title = title;
    }
    placeTabBar();
  }

  const unsubscribe = store.subscribe(render);
  window.addEventListener("resize", placeTabBar);
  return {
    render,
    close() {
      unsubscribe();
      window.removeEventListener("resize", placeTabBar);
      top.el.remove();
      tab.el.remove();
    },
  };
}
