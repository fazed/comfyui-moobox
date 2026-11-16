import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class Output:
    def __init__(self, *result, ui=None):
        self.result = result
        self.ui = ui


root = Path(__file__).resolve().parents[1]
package = types.ModuleType("moobox_test_pack")
package.__path__ = [str(root)]
native = types.ModuleType("nodes")
native.NODE_CLASS_MAPPINGS = {}
native.LoraLoader = Mock()
paths = types.ModuleType("folder_paths")
paths.get_full_path_or_raise = Mock(return_value="/models/alpha.safetensors")
paths.get_user_directory = Mock(return_value="/user")
api = types.ModuleType("comfy_api.latest")
api.io = types.SimpleNamespace(ComfyNode=object, NodeOutput=Output)
with patch.dict(sys.modules, {"moobox_test_pack": package, "nodes": native, "folder_paths": paths, "comfy_api.latest": api}):
    spec = importlib.util.spec_from_file_location("moobox_test_pack.nodes", root / "nodes.py")
    pack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pack)


class LoaderTests(unittest.TestCase):
    def setUp(self):
        native.NODE_CLASS_MAPPINGS.clear()
        native.LoraLoader.reset_mock()
        native.LoraLoader.return_value.load_lora = Mock(return_value=("patched_model", "patched_clip"))
        paths.get_full_path_or_raise.reset_mock()

    def test_native_contract_and_disabled_entries(self):
        entries = [{"name": "alpha.safetensors", "strength": 0.4, "clipStrength": 0.6, "words": ["alpha"]}, {"name": "disabled.safetensors", "active": False}]
        output = pack.MooBoxLoraLoader.execute("model", json.dumps(entries), clip="clip")
        native.LoraLoader.return_value.load_lora.assert_called_once_with("model", "clip", "alpha.safetensors", 0.4, 0.6)
        self.assertEqual(output.result[:3], ("patched_model", "patched_clip", "alpha"))

    def test_empty_list_allows_model_only(self):
        output = pack.MooBoxLoraLoader.execute("model", "[]")
        self.assertEqual(output.result, ("model", None, "", ""))

    def test_optional_manager_uses_registered_public_node_contract(self):
        instance = types.SimpleNamespace(FUNCTION="load_loras", load_loras=Mock(return_value=("m", "c", "words", "loaded")))
        native.NODE_CLASS_MAPPINGS["Lora Loader (LoraManager)"] = Mock(return_value=instance)
        output = pack.MooBoxLoraLoader.execute("model", "[]", loader="LoRA Manager")
        self.assertEqual(output.result, ("m", "c", "words", "loaded"))
        instance.load_loras.assert_called_once_with(model="model", text="", loras=[], clip=None)

    def test_missing_manager_fails_with_actionable_error(self):
        with self.assertRaisesRegex(RuntimeError, "choose the ComfyUI loader"):
            pack.MooBoxLoraLoader.execute("model", "[]", loader="LoRA Manager")

    def test_path_traversal_is_rejected_at_loading_boundary(self):
        for name in ("../outside.safetensors", "folder/../../outside.safetensors", "/outside.safetensors"):
            with self.assertRaises(ValueError):
                pack.MooBoxLoraLoader.execute("model", json.dumps([{"name": name}]))
        paths.get_full_path_or_raise.assert_not_called()

    def test_empty_connected_source_does_not_reuse_stale_manual_source(self):
        result = pack.MooBoxTriggerWords.execute('{"source":"old","groups":[]}', trigger_words="")
        self.assertEqual(result.result, ("",))


if __name__ == "__main__":
    unittest.main()


class SeedTests(unittest.TestCase):
    def test_outputs_are_padded_to_the_declared_slots(self):
        output = pack.MooBoxSeeds.execute("[5, 7]")
        self.assertEqual(output.result[:3], (5, 7, 0))
        self.assertEqual(len(output.result), pack.MAX_SEEDS)

    def test_rejects_empty_list(self):
        with self.assertRaises(ValueError):
            pack.MooBoxSeeds.execute("[]")


class GroupsToggleTests(unittest.TestCase):
    def test_runs_without_output(self):
        output = pack.MooBoxGroupsToggle.execute("bypass", "", "", "position", True, "(all)")
        self.assertEqual(output.result, ())
