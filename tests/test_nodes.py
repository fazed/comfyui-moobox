import importlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import torch
from PIL import Image


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

    def test_api_random_seed_is_replaced_and_reruns(self):
        output = pack.MooBoxSeeds.execute("[-1, 5]")
        self.assertTrue(0 <= output.result[0] < pack.MAX_RANDOM)
        self.assertEqual(output.result[1], 5)
        fingerprint = pack.MooBoxSeeds.fingerprint_inputs("[-1, 5]")
        self.assertNotEqual(fingerprint, fingerprint)
        self.assertEqual(pack.MooBoxSeeds.fingerprint_inputs("[3, 5]"), "[3, 5]")


class GroupsToggleTests(unittest.TestCase):
    def test_runs_without_output(self):
        output = pack.MooBoxGroupsToggle.execute("bypass", "", "", "position", True, "(all)")
        self.assertEqual(output.result, ())


class ImageSwitchTests(unittest.TestCase):
    def test_returns_selected_input(self):
        self.assertEqual(pack.MooBoxImageSwitch.execute(True, on_false="a", on_true="b").result, ("b",))
        self.assertEqual(pack.MooBoxImageSwitch.execute(False, on_false="a", on_true="b").result, ("a",))

    def test_requests_only_the_selected_branch(self):
        # None means connected but not yet evaluated.
        self.assertEqual(pack.MooBoxImageSwitch.check_lazy_status(True, on_false=None, on_true=None), ["on_true"])
        self.assertEqual(pack.MooBoxImageSwitch.check_lazy_status(False, on_false=None, on_true=None), ["on_false"])
        self.assertEqual(pack.MooBoxImageSwitch.check_lazy_status(True, on_true=None), ["on_true"])
        self.assertEqual(pack.MooBoxImageSwitch.check_lazy_status(False, on_false=None), ["on_false"])

    def test_never_requests_an_unconnected_branch(self):
        # ComfyUI leaves unconnected inputs out of the kwargs; requesting one fails the whole prompt.
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(True))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(False))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(True, on_false=pack._MISSING, on_true=pack._MISSING))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(True, on_false=None))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(False, on_true=None))

    def test_requests_nothing_once_selected_branch_is_available(self):
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(True, on_false=None, on_true="b"))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(False, on_false="a", on_true=None))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(True, on_true="b"))
        self.assertIsNone(pack.MooBoxImageSwitch.check_lazy_status(False, on_false="a"))

    def test_unconnected_selected_branch_raises(self):
        with self.assertRaisesRegex(ValueError, "on_true is not connected"):
            pack.MooBoxImageSwitch.execute(True, on_false="a")
        with self.assertRaisesRegex(ValueError, "on_false is not connected"):
            pack.MooBoxImageSwitch.execute(False, on_true="b")
        with self.assertRaisesRegex(ValueError, "on_true is not connected"):
            pack.MooBoxImageSwitch.execute(True, on_false="a", on_true=pack._MISSING)
        with self.assertRaisesRegex(ValueError, "on_false is not connected"):
            pack.MooBoxImageSwitch.execute(False)

    def test_unselected_branch_need_not_be_connected(self):
        self.assertEqual(pack.MooBoxImageSwitch.execute(True, on_true="b").result, ("b",))
        self.assertEqual(pack.MooBoxImageSwitch.execute(False, on_false="a").result, ("a",))

    def test_returns_selected_value_as_is(self):
        image = object()
        self.assertIs(pack.MooBoxImageSwitch.execute(True, on_false="a", on_true=image).result[0], image)
        self.assertEqual(pack.MooBoxImageSwitch.execute(False, on_false=[1, 2], on_true="b").result, ([1, 2],))
        self.assertEqual(pack.MooBoxImageSwitch.execute(False, on_false=0, on_true="b").result, (0,))


class IllustriousResolutionTests(unittest.TestCase):
    def test_outputs_width_and_height(self):
        self.assertEqual(pack.MooBoxIllustriousResolution.execute("Portrait 832 x 1216 (13:19)").result, (832, 1216))
        self.assertEqual(pack.MooBoxIllustriousResolution.execute("Landscape 1344 x 768 (7:4)").result, (1344, 768))
        self.assertEqual(pack.MooBoxIllustriousResolution.execute("Square 1024 x 1024 (1:1)").result, (1024, 1024))

    def test_unknown_label_raises(self):
        with self.assertRaises(KeyError):
            pack.MooBoxIllustriousResolution.execute("Square 512 x 512")


class PreviewImagesTests(unittest.TestCase):
    # Loads compare.py against the real ComfyUI API so the previews are really written.
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(root.parents[1]))
        spec = importlib.util.spec_from_file_location("moobox_test_compare", root / "compare.py")
        cls.compare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.compare)
        cls.paths = importlib.import_module("folder_paths")
        cls.io = importlib.import_module("comfy_api.latest").io

    def test_schema_is_v3_output_node_with_autogrow_images(self):
        schema = self.compare.MooBoxPreviewImages.define_schema()
        self.assertEqual((schema.node_id, schema.category, schema.is_output_node, schema.outputs), ("MooBoxPreviewImages", "MooBox/Utility", True, []))
        self.assertIsInstance(schema.inputs[0], self.io.Autogrow.Input)
        template = schema.inputs[0].template
        self.assertIsInstance(template.input, self.io.Image.Input)
        self.assertEqual((template.prefix, template.min, template.max), ("image", 1, 100))
        switch = schema.inputs[1]
        self.assertIsInstance(switch, self.io.Boolean.Input)
        self.assertEqual((len(schema.inputs), switch.id, switch.display_name, switch.default), (2, "add_to_assets", "add to assets", False))

    def test_all_images_of_all_inputs_are_saved_in_input_order(self):
        first, second = torch.rand(2, 8, 8, 3), torch.rand(3, 16, 12, 3)
        with tempfile.TemporaryDirectory() as temp, patch.object(self.paths, "temp_directory", temp):
            files = self.compare.MooBoxPreviewImages.execute({"image1": second, "image0": first}).ui["previews"]
            self.assertEqual([file["type"] for file in files], ["temp"] * 5)
            self.assertEqual(len({file["filename"] for file in files}), 5)
            sizes = []
            for file in files:
                with Image.open(Path(temp, file["subfolder"], file["filename"])) as image:
                    sizes.append(image.size)
        self.assertEqual(sizes, [(8, 8)] * 2 + [(12, 16)] * 3)

    def test_add_to_assets_also_returns_the_previews_as_images(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(self.paths, "temp_directory", temp):
            output = self.compare.MooBoxPreviewImages.execute({"image0": torch.rand(2, 8, 8, 3)}, add_to_assets=True).ui
        self.assertEqual(sorted(output), ["images", "previews"])
        self.assertEqual(len(output["previews"]), 2)
        self.assertEqual(output["images"], output["previews"])
