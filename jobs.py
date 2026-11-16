"""Read-only job observer. Never rebroadcast native execution payloads."""
import copy
import functools
import itertools
import logging
import math
import time
import uuid
from collections import OrderedDict

from aiohttp import web

EVENT = "moobox_jobs.snapshot"
TERMINAL = {"completed", "error", "interrupted", "removed"}
WATCHED = {"execution_start", "executing", "progress", "progress_state",
           "execution_success", "execution_error", "execution_interrupted", "execution_cached"}


def text(value, limit=120):
    return value[:limit] if isinstance(value, str) else ""


def number(value):
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0


def clean_event(event, data):
    if event not in WATCHED or not isinstance(data, dict):
        return None
    prompt_id = text(data.get("prompt_id"))
    if not prompt_id:
        return None  # Never guess a job from mutable server.client_id/last_node_id.
    result = {"prompt_id": prompt_id}
    if event == "execution_cached":
        result["cached"] = [text(n) for n in data.get("nodes", []) if isinstance(n, str)]
    elif event == "progress_state":
        result["finished"] = [text(k) for k, v in data.get("nodes", {}).items()
                              if isinstance(v, dict) and v.get("state") == "finished"]
        result["nodes"] = {
            text(k): {"state": text(v.get("state")), "value": number(v.get("value")),
                      "max": number(v.get("max"))}
            for k, v in itertools.islice(((k, v) for k, v in data.get("nodes", {}).items()
                if isinstance(k, str) and isinstance(v, dict) and v.get("state") == "running"), 256)
        }
    else:
        result.update(node=text(data.get("node")), value=number(data.get("value")),
                      max=number(data.get("max")), error_type=text(data.get("exception_type")))
    return result


def client_tag(client_id):
    """FNV-1a hash, so the browser can recognise its own jobs without learning other client ids."""
    tag = 0x811C9DC5
    for byte in str(client_id or "").encode():
        tag = ((tag ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{tag:08x}" if client_id else ""


def needed_nodes(graph, outputs):
    """Nodes that run for the requested outputs: the outputs and everything they depend on."""
    needed = set()
    stack = [n for n in outputs if n in graph]
    while stack:
        node = stack.pop()
        if node in needed:
            continue
        needed.add(node)
        inputs = graph[node].get("inputs", {}) if isinstance(graph[node], dict) else {}
        stack.extend(v[0] for v in inputs.values()
                     if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] in graph)
    return needed


def queue_job(item, state):
    graph = item[2] if isinstance(item[2], dict) else {}
    extra = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    outputs = item[4] if len(item) > 4 and isinstance(item[4], (list, tuple)) else []
    graph = {k: v for k, v in graph.items() if isinstance(k, str) and isinstance(v, dict)}
    if outputs:
        needed = needed_nodes(graph, outputs)
        graph = {k: v for k, v in graph.items() if k in needed}
    return {"prompt_id": text(item[1]), "status": state, "position": number(item[0]),
            "client": client_tag(extra.get("client_id")),
            "node_labels": {text(k): text(v["_meta"].get("title"), 1024)
                            for k, v in graph.items() if isinstance(v.get("_meta"), dict)},
            "node_types": {text(k): text(v.get("class_type")) for k, v in graph.items()}}


def history_job(item):
    job = queue_job(item["prompt"], "unknown")
    job["nodes"] = {}
    status = item.get("status") or {}
    events = {m[0] for m in status.get("messages", []) if isinstance(m, (tuple, list)) and m}
    if "execution_interrupted" in events:
        job["status"] = "interrupted"
    elif status.get("status_str") == "error":
        job["status"] = "error"
    elif status.get("completed") and status.get("status_str") == "success":
        job["status"] = "completed"
    # Deliberately omit exception messages, inputs, outputs, workflow titles and traces.
    return job


class Monitor:
    def __init__(self, server):
        self.server = server
        self.jobs = OrderedDict()
        self.epoch = uuid.uuid4().hex
        self.revision = 0
        self.pending = False

    def merge(self, entry):
        pid = entry["prompt_id"]
        job = self.jobs.setdefault(pid, {"prompt_id": pid, "nodes": {}, "status": "running"})
        # Queue removal follows the success event; don't regress during that window.
        if job["status"] in TERMINAL and entry["status"] in {"running", "queued"}:
            entry = {k: v for k, v in entry.items() if k != "status"}
        job.update(entry)
        self.jobs.move_to_end(pid)

    def reconcile(self):
        queue = self.server.prompt_queue
        running, queued = queue.get_current_queue_volatile()
        history = queue.get_history(max_items=100, map_function=history_job)
        for job in history.values():
            self.merge(job)
        active = set()
        for state, items in (("queued", sorted(queued, key=lambda i: i[0])), ("running", running)):
            for position, item in enumerate(items, 1):
                entry = queue_job(item, state)
                entry["position"] = position if state == "queued" else None
                active.add(entry["prompt_id"])
                self.merge(entry)
        for pid, job in self.jobs.items():
            if pid not in active and job["status"] in {"queued", "running"}:
                job["status"] = "removed"  # Gone from queue, absent from retained history.
                job["nodes"] = {}
        finished = [pid for pid, j in self.jobs.items() if j["status"] not in {"queued", "running"}]
        for pid in finished[:-100]:
            del self.jobs[pid]

    def observe(self, event, data):
        pid = data["prompt_id"]
        job = self.jobs.setdefault(pid, {"prompt_id": pid, "status": "running", "nodes": {}})
        if job["status"] in TERMINAL:
            return
        job.setdefault("completed_nodes", {})
        if event == "execution_start":
            job["status"] = "running"
        elif event == "execution_cached":
            job.setdefault("completed_nodes", {}).update({k: "cached" for k in data["cached"]})
        elif event == "progress_state":
            job.setdefault("completed_nodes", {}).update({k: "finished" for k in data.get("finished", [])})
            job["nodes"] = {k: v for k, v in data["nodes"].items() if v["state"] == "running"}
        elif event in {"executing", "progress"} and data["node"]:
            job["current_node"] = data["node"]
            if event == "executing":
                job["nodes"] = {data["node"]: {"state": "running", "value": 0, "max": 0}}
            else:
                job["nodes"][data["node"]] = {"state": "running", "value": data["value"], "max": data["max"]}
        elif event in {"execution_success", "execution_error", "execution_interrupted"}:
            job["status"] = {"execution_success": "completed", "execution_error": "error",
                             "execution_interrupted": "interrupted"}[event]
            job["error_type"] = data["error_type"]
            job["nodes"] = {}
            job.pop("current_node", None)
        self.schedule_publish()

    def schedule_publish(self):
        if not self.pending:
            self.pending = True
            self.server.loop.call_later(0.2, self.publish)

    def refresh(self):
        try:
            self.reconcile()
        except Exception:
            logging.exception("MooBox jobs: reconciliation failed")
        self.schedule_publish()

    def snapshot(self):
        self.revision += 1
        return {"schema": 1, "epoch": self.epoch, "revision": self.revision,
                "timestamp": time.time(), "jobs": copy.deepcopy(list(self.jobs.values()))}

    def publish(self):
        self.pending = False
        try:
            # Nested envelope prevents ComfyUI's workflow_metadata merge.
            self.server.send_sync(EVENT, {"snapshot": self.snapshot()})
        except Exception:
            logging.exception("MooBox jobs: publication failed")


def install(server):
    if hasattr(server, "_moobox_jobs_monitor"):
        return
    monitor = Monitor(server)
    server._moobox_jobs_monitor = monitor
    original = server.send_sync

    @functools.wraps(original)
    def observed_send(event, data, sid=None):
        result = original(event, data, sid)  # Preserve native routing and exception behavior.
        try:
            clean = clean_event(event, data)
            if event == "status":  # ComfyUI sends it whenever the queue or history changes.
                server.loop.call_soon_threadsafe(monitor.refresh)
            elif clean is not None:
                server.loop.call_soon_threadsafe(monitor.observe, event, clean)
        except Exception:
            logging.exception("MooBox jobs: ignored observation failure")
        return result

    server.send_sync = observed_send

    @server.routes.get("/moobox-jobs/snapshot")
    async def snapshot(request):
        monitor.refresh()
        return web.json_response(monitor.snapshot(), headers={"Cache-Control": "no-store"})
