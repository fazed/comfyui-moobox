import asyncio
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs as module


def item(pid, number=0, client="browser-a"):
    return (number, pid, {"42": {"class_type": "KSampler", "inputs": {"secret": "PRIVATE"}}},
            {"client_id": client, "extra_pnginfo": "PRIVATE"}, ["42"])


class Queue:
    def __init__(self):
        self.running, self.queued, self.history = [], [], {}

    def get_current_queue_volatile(self):
        return self.running, self.queued

    def get_history(self, max_items, map_function):
        return {k: map_function(v) for k, v in list(self.history.items())[-max_items:]}


class MonitorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = []
        self.server = types.SimpleNamespace(loop=asyncio.get_running_loop(), prompt_queue=Queue(),
                                            send_sync=lambda *args: self.sent.append(args))
        self.monitor = module.Monitor(self.server)

    def event(self, name, **data):
        clean = module.clean_event(name, data)
        if clean:
            self.monitor.observe(name, clean)

    async def test_progress_completion_and_error_without_leaking_payloads(self):
        self.server.prompt_queue.running = [item("a")]
        self.server.prompt_queue.queued = [item("b", 2), item("c", 1)]
        self.monitor.reconcile()
        self.event("executing", prompt_id="a", node="42")
        self.event("progress", prompt_id="a", node="42", value=18, max=30, secret="PRIVATE")
        self.assertEqual(self.monitor.jobs["a"]["nodes"]["42"]["value"], 18)
        self.assertEqual(self.monitor.jobs["c"]["position"], 1)
        self.event("execution_success", prompt_id="a")
        self.event("execution_start", prompt_id="b")
        self.event("execution_error", prompt_id="b", exception_type="ValueError", exception_message="PRIVATE")
        self.assertEqual(self.monitor.jobs["a"]["status"], "completed")
        self.assertEqual(self.monitor.jobs["b"]["status"], "error")
        self.monitor.publish()
        self.assertNotIn("PRIVATE", json.dumps(self.sent[-1]))
        self.assertEqual(self.sent[-1][0], module.EVENT)

    async def test_client_is_shared_only_as_a_hash(self):
        self.server.prompt_queue.running = [item("a", client="browser-a")]
        self.server.prompt_queue.queued = [item("b", 1, client=None)]
        self.monitor.reconcile()
        jobs = {job["prompt_id"]: job for job in self.monitor.snapshot()["jobs"]}
        self.assertEqual(jobs["a"]["client"], module.client_tag("browser-a"))
        self.assertEqual(jobs["b"]["client"], "")
        self.assertNotIn("browser-a", json.dumps(self.monitor.snapshot()))

    async def test_client_tag_is_fnv1a(self):
        self.assertEqual(module.client_tag("a"), "e40c292c")
        self.assertEqual(module.client_tag(""), "")

    async def test_history_keeps_client_and_removed_queue_items(self):
        q = self.server.prompt_queue
        q.queued = [item("deleted")]
        q.history = {"done": {"prompt": item("done", client="browser-b"), "outputs": {"secret": "PRIVATE"},
                              "status": {"completed": True, "status_str": "success"}}}
        self.monitor.reconcile()
        q.queued = []
        self.monitor.reconcile()
        self.assertEqual(self.monitor.jobs["done"]["status"], "completed")
        self.assertEqual(self.monitor.jobs["done"]["client"], module.client_tag("browser-b"))
        self.assertEqual(self.monitor.jobs["deleted"]["status"], "removed")
        self.assertNotIn("PRIVATE", json.dumps(self.monitor.snapshot()))

    async def test_cached_and_finished_nodes_survive_reconciliation(self):
        self.server.prompt_queue.running = [item("p")]
        self.event("execution_cached", prompt_id="p", nodes=["10", "11"])
        self.event("progress_state", prompt_id="p", nodes={"42": {"state": "finished", "value": 5, "max": 5}})
        self.monitor.reconcile()
        self.assertEqual(self.monitor.jobs["p"]["completed_nodes"], {"10": "cached", "11": "cached", "42": "finished"})

    async def test_no_guessing_and_nonfinite_values(self):
        self.assertIsNone(module.clean_event("progress", {"node": "42"}))
        self.assertEqual(module.clean_event("progress", {"prompt_id": "p", "max": float("nan")})["max"], 0)

    async def test_node_labels_are_selected_without_other_metadata(self):
        queued = list(item("p"))
        queued[2]["42"]["_meta"] = {"title": "Second pass", "other": "PRIVATE"}
        job = module.queue_job(queued, "running")
        self.assertEqual(job["node_labels"], {"42": "Second pass"})
        self.assertNotIn("PRIVATE", json.dumps(job))

    async def test_progress_counts_only_nodes_needed_for_the_requested_outputs(self):
        graph = {"1": {"class_type": "Loader", "inputs": {}},
                 "2": {"class_type": "ImageCompare", "inputs": {"image": ["1", 0]}},
                 "3": {"class_type": "Upscale", "inputs": {"image": ["2", 0]}},
                 "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
                 "5": {"class_type": "Unrelated", "inputs": {}}}
        partial = module.queue_job((0, "p", graph, {}, ["2"]), "running")
        self.assertEqual(set(partial["node_types"]), {"1", "2"})
        full = module.queue_job((0, "p", graph, {}, ["4"]), "running")
        self.assertEqual(set(full["node_types"]), {"1", "2", "3", "4"})
        self.assertEqual(len(module.queue_job((0, "p", graph, {}), "running")["node_types"]), 5)

    async def test_completion_does_not_regress_and_history_bounded(self):
        self.event("execution_success", prompt_id="a")
        self.server.prompt_queue.running = [item("a")]
        self.monitor.reconcile()
        self.assertEqual(self.monitor.jobs["a"]["status"], "completed")
        for i in range(150):
            self.event("execution_success", prompt_id=str(i))
        self.monitor.reconcile()
        self.assertLessEqual(len(self.monitor.jobs), 100)

    async def test_interrupted_is_not_completed(self):
        history = {"prompt": item("p"), "status": {"completed": False, "status_str": "error",
                   "messages": [["execution_interrupted", {"secret": "PRIVATE"}]]}}
        self.assertEqual(module.history_job(history)["status"], "interrupted")


class InstallationTests(unittest.IsolatedAsyncioTestCase):
    def make_server(self, sent):
        return types.SimpleNamespace(loop=asyncio.get_running_loop(), prompt_queue=Queue(),
                                     app=module.web.Application(), routes=module.web.RouteTableDef(),
                                     send_sync=lambda *a: sent.append(a))

    async def test_passthrough_and_idempotence(self):
        sent = []
        server = self.make_server(sent)
        module.install(server)
        wrapper = server.send_sync
        module.install(server)
        self.assertIs(wrapper, server.send_sync)
        data = {"prompt_id": "p", "node": "42", "secret": "PRIVATE"}
        server.send_sync("executing", data, "external-client")
        await asyncio.sleep(0)
        self.assertIs(sent[0][1], data)
        self.assertEqual(sent[0][2], "external-client")
        self.assertEqual(len(server.routes), 1)

    async def test_queue_status_event_refreshes_without_polling(self):
        sent = []
        server = self.make_server(sent)
        module.install(server)
        server.prompt_queue.queued = [item("late")]
        server.send_sync("status", {"status": {}}, None)
        await asyncio.sleep(0.3)
        self.assertEqual(server._moobox_jobs_monitor.jobs["late"]["status"], "queued")
        self.assertTrue(any(event[0] == module.EVENT for event in sent))

    async def test_real_http_snapshot_is_read_only(self):
        from aiohttp import ClientSession
        server = self.make_server([])
        server.prompt_queue.running = [item("job")]
        module.install(server)
        server.app.add_routes(server.routes)
        runner = module.web.AppRunner(server.app)
        await runner.setup()
        site = module.web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            async with ClientSession() as session:
                async with session.get(f"http://127.0.0.1:{port}/moobox-jobs/snapshot") as response:
                    self.assertEqual(response.status, 200)
                    result = await response.json()
                    self.assertEqual(result["jobs"][0]["prompt_id"], "job")
                    self.assertNotIn("PRIVATE", json.dumps(result))
                async with session.post(f"http://127.0.0.1:{port}/moobox-jobs/snapshot") as response:
                    self.assertEqual(response.status, 405)
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    unittest.main()
