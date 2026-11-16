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
comfy = types.ModuleType("comfy")
comfy.utils = utils
paths = types.ModuleType("folder_paths")
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))
jobs = types.ModuleType("moobox_routes_pack.jobs")
jobs.install = Mock()
pack_nodes = types.ModuleType("moobox_routes_pack.nodes")
pack_nodes.TAGS_FILE = os.path.join(folder, "moobox", "tags.csv")
pack_nodes.resolve_lora = Mock(side_effect=lambda name: f"/loras/{name}")
modules = {"moobox_routes_pack": package, "comfy": comfy, "comfy.utils": utils, "folder_paths": paths, "server": server,
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


if __name__ == "__main__":
    unittest.main()
