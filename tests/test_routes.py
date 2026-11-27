import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from aiohttp import web

root = Path(__file__).resolve().parents[1]
folder = tempfile.mkdtemp()
package = types.ModuleType("moobox_routes_pack")
package.__path__ = [str(root)]
utils = types.ModuleType("comfy.utils")
utils.safetensors_header = Mock()
management = types.ModuleType("comfy.model_management")
comfy = types.ModuleType("comfy")
comfy.utils = utils
comfy.model_management = management
torch = types.ModuleType("torch")
torch.device = lambda kind: types.SimpleNamespace(type=kind)
paths = types.ModuleType("folder_paths")
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))
jobs = types.ModuleType("moobox_routes_pack.jobs")
jobs.install = Mock()
pack_nodes = types.ModuleType("moobox_routes_pack.nodes")
pack_nodes.TAGS_FILE = os.path.join(folder, "moobox", "tags.csv")
pack_nodes.resolve_lora = Mock(side_effect=lambda name: f"/loras/{name}")
modules = {"moobox_routes_pack": package, "comfy": comfy, "comfy.utils": utils, "comfy.model_management": management, "torch": torch,
           "folder_paths": paths, "server": server,
           "moobox_routes_pack.jobs": jobs, "moobox_routes_pack.nodes": pack_nodes}
with patch.dict(sys.modules, modules):
    spec = importlib.util.spec_from_file_location("moobox_routes_pack.routes", root / "routes.py")
    routes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(routes)


def tearDownModule():
    shutil.rmtree(folder)


class Upload:
    def __init__(self, data, content_length):
        self.data = data
        self.content_length = content_length

    async def read(self):
        return self.data


class TagRouteTests(unittest.TestCase):
    def test_put_saves_atomically(self):
        response = asyncio.run(routes.put_tags(Upload(b"1girl,0,5\n", 10)))
        self.assertEqual(json.loads(response.text), {"bytes": 10})
        with open(pack_nodes.TAGS_FILE, "rb") as file:
            self.assertEqual(file.read(), b"1girl,0,5\n")
        self.assertFalse(os.path.exists(pack_nodes.TAGS_FILE + ".tmp"))

    def test_put_is_capped_like_the_download(self):
        with patch.object(routes, "MAX_TAGS_BYTES", 4):
            with self.assertRaises(web.HTTPRequestEntityTooLarge):
                asyncio.run(routes.put_tags(Upload(b"12345", 5)))
            with self.assertRaises(web.HTTPRequestEntityTooLarge):
                asyncio.run(routes.put_tags(Upload(b"12345", None)))


class EmbeddedWordsTests(unittest.TestCase):
    def test_reads_known_metadata_keys(self):
        utils.safetensors_header.return_value = json.dumps({"__metadata__": {"ss_trigger_words": ["alpha", " ", 3]}}).encode()
        self.assertEqual(routes.embedded_words("a.safetensors"), ["alpha"])
        utils.safetensors_header.return_value = json.dumps({"__metadata__": {"trainedWords": "beta"}}).encode()
        self.assertEqual(routes.embedded_words("a.safetensors"), ["beta"])
        utils.safetensors_header.return_value = None
        self.assertEqual(routes.embedded_words("a.safetensors"), [])
        self.assertEqual(routes.embedded_words("a.ckpt"), [])


def write_lora(path, tensors):
    header = json.dumps({"__metadata__": {"ss_output_name": "x"}, **{key: {"dtype": "F16", "shape": shape, "data_offsets": [0, 0]} for key, shape in tensors.items()}}).encode()
    with open(path, "wb") as file:
        file.write(len(header).to_bytes(8, "little") + header)


def read_header(path):
    with open(path, "rb") as file:
        return file.read(int.from_bytes(file.read(8), "little"))


class FamilySearchTests(unittest.TestCase):
    def setUp(self):
        self.loras = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.loras)
        write_lora(os.path.join(self.loras, "anima_style.safetensors"), {"lora_unet_blocks_0_self_attn_q_proj.lora_down.weight": [16, 2048]})
        write_lora(os.path.join(self.loras, "sdxl_style.safetensors"), {"lora_unet_input_blocks_4_1_proj_in.lora_down.weight": [8, 640]})
        write_lora(os.path.join(self.loras, "krea_style.safetensors"), {"diffusion_model.blocks.0.attn.wq.lora_A.weight": [16, 6144]})
        write_lora(os.path.join(self.loras, "odd_style.safetensors"), {"something.weight": [4, 4]})
        with open(os.path.join(self.loras, "broken_style.safetensors"), "wb") as file:
            file.write(b"\x01")
        names = sorted(os.listdir(self.loras))
        routes._families.clear()
        patches = [
            patch.object(paths, "get_filename_list", Mock(return_value=names), create=True),
            patch.object(paths, "get_full_path", Mock(side_effect=lambda folder, name: os.path.join(self.loras, name)), create=True),
            patch.object(utils, "safetensors_header", Mock(side_effect=read_header)),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def search(self, **query):
        return json.loads(asyncio.run(routes.search(types.SimpleNamespace(query=query))).text)

    def test_any_or_absent_family_keeps_every_match_without_reading_headers(self):
        self.assertEqual(self.search(q="style")["total"], 5)
        self.assertEqual(self.search(q="style", family="Any")["total"], 5)
        utils.safetensors_header.assert_not_called()

    def test_family_filters_by_header_and_unknown_keeps_the_rest(self):
        self.assertEqual(self.search(q="style", family="SDXL"), {"names": ["sdxl_style.safetensors"], "total": 1})
        self.assertEqual(self.search(q="style", family="Anima")["names"], ["anima_style.safetensors"])
        self.assertEqual(self.search(q="style", family="Krea 2")["names"], ["krea_style.safetensors"])
        self.assertEqual(self.search(q="style", family="MOSS")["names"], [])
        self.assertEqual(self.search(q="style", family="Unknown")["names"], ["broken_style.safetensors", "odd_style.safetensors"])

    def test_only_query_matches_are_read_and_cached_until_the_file_changes(self):
        self.search(q="anima", family="SDXL")
        self.assertEqual(utils.safetensors_header.call_count, 1)
        self.search(q="anima", family="Anima")
        self.assertEqual(utils.safetensors_header.call_count, 1)
        path = os.path.join(self.loras, "anima_style.safetensors")
        write_lora(path, {"lora_unet_output_blocks_0_proj_in.lora_down.weight": [8, 1280], "pad": [1, 1]})
        self.assertEqual(self.search(q="anima", family="SDXL")["names"], ["anima_style.safetensors"])
        self.assertEqual(utils.safetensors_header.call_count, 2)


class SearchPagingTests(unittest.TestCase):
    def setUp(self):
        self.names = [f"style_{index:03}.safetensors" for index in range(120)] + ["other.safetensors"]
        routes._families.clear()
        patches = [
            patch.object(paths, "get_filename_list", Mock(return_value=self.names), create=True),
            patch.object(routes, "file_family", Mock(side_effect=lambda name: "SDXL" if int(name[6:9]) % 2 else "Anima")),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def search(self, **query):
        return json.loads(asyncio.run(routes.search(types.SimpleNamespace(query=query))).text)

    def test_offset_slices_pages_of_fifty_with_the_full_total(self):
        self.assertEqual(self.search(q="style"), {"names": self.names[:50], "total": 120})
        self.assertEqual(self.search(q="style", offset="50"), {"names": self.names[50:100], "total": 120})
        self.assertEqual(self.search(q="style", offset="100"), {"names": self.names[100:120], "total": 120})

    def test_family_total_is_exact_and_pages_follow_the_filtered_list(self):
        sdxl = [name for name in self.names[:120] if int(name[6:9]) % 2]
        self.assertEqual(self.search(q="style", family="SDXL"), {"names": sdxl[:50], "total": 60})
        self.assertEqual(self.search(q="style", family="SDXL", offset="50"), {"names": sdxl[50:], "total": 60})

    def test_offset_past_the_end_returns_no_names(self):
        self.assertEqual(self.search(q="style", offset="500"), {"names": [], "total": 120})

    def test_garbage_offset_behaves_as_zero(self):
        for offset in ("", "abc", "-5", "1.5", " 3"):
            self.assertEqual(self.search(q="style", offset=offset)["names"], self.names[:50], offset)


class SystemRouteTests(unittest.TestCase):
    def system(self, device):
        memory = {"cpu": (32, 20), "cuda": (24, 6)}
        with patch.object(management, "get_torch_device", Mock(return_value=types.SimpleNamespace(type=device)), create=True), \
                patch.object(management, "get_total_memory", Mock(side_effect=lambda dev: memory[dev.type][0]), create=True), \
                patch.object(management, "get_free_memory", Mock(side_effect=lambda dev: memory[dev.type][1]), create=True), \
                patch.object(routes.psutil, "cpu_percent", Mock(return_value=12.5)) as cpu:
            result = json.loads(asyncio.run(routes.system(None)).text)
        cpu.assert_called_once_with(interval=None)
        return result

    def test_reports_cpu_ram_and_vram_of_the_primary_device(self):
        self.assertEqual(self.system("cuda"), {"cpu": 12.5, "ram": {"used": 12, "total": 32}, "vram": {"used": 18, "total": 24}})

    def test_cpu_device_has_no_vram(self):
        self.assertEqual(self.system("cpu")["vram"], None)


class JsonRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class SaveExportRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp, self.output = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.temp)
        self.addCleanup(shutil.rmtree, self.output)
        for item in (patch.object(paths, "get_temp_directory", Mock(return_value=self.temp), create=True),
                     patch.object(paths, "get_output_directory", Mock(return_value=self.output), create=True)):
            item.start()
            self.addCleanup(item.stop)
        self.image = {"filename": "MooBoxSave_0123456789ab_00000.png", "subfolder": "", "type": "temp"}
        with open(os.path.join(self.temp, self.image["filename"]), "wb") as file:
            file.write(b"png bytes")
        with open(os.path.join(self.temp, self.image["filename"] + ".export.json"), "w") as file:
            json.dump({"run": "0123456789ab", "index": 0, "folder": [], "name": "Pic", "digits": 5, "counter": False, "overwrite": False, "caption": None, "workflow": None}, file)

    def export(self, body):
        return asyncio.run(routes.export_saved(JsonRequest(body)))

    def test_saves_the_preview_and_returns_the_output_files(self):
        self.assertEqual(json.loads(self.export({"images": [self.image]}).text), {"saved": [{"filename": "Pic.png", "subfolder": "", "type": "output"}]})
        with open(os.path.join(self.output, "Pic.png"), "rb") as file:
            self.assertEqual(file.read(), b"png bytes")

    def test_bad_requests_and_traversal_are_rejected(self):
        for body in ({}, [], {"images": "x"}, {"images": [{**self.image, "filename": "..\\..\\secret.png"}]}, {"images": [{**self.image, "type": "output"}]}):
            response = self.export(body)
            self.assertEqual(response.status, 400, body)
            self.assertTrue(json.loads(response.text)["error"])
        self.assertEqual(os.listdir(self.output), [])

    # Returned instead of raised, so ComfyUI's middleware keeps the message.
    def test_gone_preview_is_not_found_with_a_clear_message(self):
        os.remove(os.path.join(self.temp, self.image["filename"]))
        response = self.export({"images": [self.image]})
        self.assertEqual(response.status, 404)
        self.assertIn("Run the workflow again", json.loads(response.text)["error"])


if __name__ == "__main__":
    unittest.main()
