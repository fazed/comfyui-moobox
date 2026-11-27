import importlib
import importlib.util
import json
import os
import re
import struct
import sys
import tempfile
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
package = types.ModuleType("moobox_save_pack")
package.__path__ = [str(root)]
sys.modules["moobox_save_pack"] = package
meta = importlib.import_module("moobox_save_pack.image_metadata")
NOW = datetime(2026, 11, 28, 9, 5, 7)


def graph(**extra):
    # Checkpoint -> two LoRAs -> KSampler -> VAEDecode -> Save (node "9").
    nodes = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sdxl/base.safetensors"}},
        "2": {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": "style.safetensors", "strength_model": 0.8, "strength_clip": 1}},
        "3": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": "detail/eyes.safetensors", "strength_model": 0.5}},
        "4": {"class_type": "CLIPSetLastLayer", "inputs": {"clip": ["2", 1], "stop_at_clip_layer": -2}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": "1girl, smile"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": "lowres"}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["10", 0],
                                                   "seed": 42, "steps": 28, "cfg": 5.5, "sampler_name": "euler_ancestral", "scheduler": "karras", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}},
        "9": {"class_type": "MooBoxSaveImage", "inputs": {"images": ["8", 0]}},
        "10": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    }
    nodes.update(extra)
    return nodes


def extract(prompt, categories=None):
    return meta.extract_generation(prompt, "9", categories or {})


def details(name, sha="", version=0, base="", air="", strength=None):
    result = meta.model_details(name, sha, {"civitai": {"id": version, "modelId": 7, "name": "v1", "baseModel": base, "air": air, "model": {"name": name.title()}}} if version else {})
    return result if strength is None else {**result, "strength": strength}


class GraphTests(unittest.TestCase):
    def test_plain_ksampler_with_two_loras(self):
        self.assertEqual(extract(graph()), {
            "seed": 42, "steps": 28, "cfg": 5.5, "sampler": "euler_ancestral", "scheduler": "karras", "prompt": "1girl, smile", "negative_prompt": "lowres",
            "clip_skip": 2, "checkpoint": ("sdxl/base.safetensors", "checkpoints"), "loras": [("style.safetensors", 0.8), ("detail/eyes.safetensors", 0.5)],
        })

    def test_linked_text_seed_and_moobox_prompt_nodes(self):
        prompt = graph(**{
            "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": ["11", 0]}},
            "11": {"class_type": "StringConcatenate", "inputs": {"string_a": ["12", 0], "string_b": ["13", 0], "delimiter": ", "}},
            "12": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "masterpiece"}},
            "13": {"class_type": "MooBoxTagPrompt", "inputs": {"tags": "smile,\nsmile, 1girl"}},
            "14": {"class_type": "MooBoxSeeds", "inputs": {"seeds": "[5, 7]"}},
        })
        prompt["7"]["inputs"]["seed"] = ["14", 1]
        result = extract(prompt)
        self.assertEqual((result["prompt"], result["seed"]), ("masterpiece, smile, 1girl", 7))

    def test_illustrious_tags_use_the_tag_categories(self):
        prompt = graph(**{"5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": ["11", 0]}},
                          "11": {"class_type": "MooBoxIllustriousTags", "inputs": {"tags": "hatsune miku, masterpiece, 1girl", "quality_tags": "front"}}})
        self.assertEqual(extract(prompt, {"hatsune_miku": 4})["prompt"], "masterpiece, 1girl, hatsune miku")

    def test_cycles_end_without_hanging(self):
        prompt = graph(**{
            "2": {"class_type": "LoraLoader", "inputs": {"model": ["3", 0], "clip": ["1", 1], "lora_name": "style.safetensors", "strength_model": 0.8}},
            "5": {"class_type": "ConditioningCombine", "inputs": {"conditioning_1": ["15", 0], "conditioning_2": ["16", 0]}},
            "15": {"class_type": "ConditioningCombine", "inputs": {"conditioning_1": ["5", 0], "conditioning_2": ["16", 0]}},
            "16": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 0], "text": ["17", 0]}},
            "17": {"class_type": "StringConcatenate", "inputs": {"string_a": ["17", 0], "string_b": "x", "delimiter": ""}},
        })
        result = extract(prompt)
        self.assertNotIn("checkpoint", result)
        self.assertNotIn("prompt", result)
        self.assertEqual(result["loras"], [("style.safetensors", 0.8), ("detail/eyes.safetensors", 0.5)])

    def test_unknown_nodes_leave_fields_out(self):
        prompt = graph(**{"5": {"class_type": "SomeCustomEncoder", "inputs": {"magic": ["4", 0]}},
                          "1": {"class_type": "MysteryLoader", "inputs": {"path": "x"}}})
        result = extract(prompt)
        self.assertNotIn("prompt", result)
        self.assertNotIn("checkpoint", result)
        self.assertEqual(result["negative_prompt"], "lowres")
        self.assertEqual(extract({"9": {"class_type": "MooBoxSaveImage", "inputs": {"images": ["404", 0]}}}), {})
        self.assertEqual(meta.extract_generation(None, "9", {}), {})

    def test_hires_pass_and_detailer_keep_the_base_sampler(self):
        prompt = graph(**{
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["18", 0], "vae": ["1", 2]}},
            "18": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
                                                        "seed": 1, "steps": 12, "cfg": 4, "sampler_name": "euler", "scheduler": "normal", "denoise": 0.45}},
        })
        self.assertEqual((extract(prompt)["seed"], extract(prompt)["steps"]), (42, 28))

    def test_sampler_custom_advanced_reads_its_helper_nodes(self):
        prompt = graph(**{
            "7": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["20", 0], "guider": ["21", 0], "sampler": ["22", 0], "sigmas": ["23", 0], "latent_image": ["10", 0]}},
            "20": {"class_type": "RandomNoise", "inputs": {"noise_seed": 99}},
            "21": {"class_type": "CFGGuider", "inputs": {"model": ["3", 0], "positive": ["5", 0], "negative": ["24", 0], "cfg": 3.5}},
            "22": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "dpmpp_2m"}},
            "23": {"class_type": "BasicScheduler", "inputs": {"model": ["3", 0], "scheduler": "simple", "steps": 20, "denoise": 1.0}},
            "24": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        })
        result = extract(prompt)
        self.assertEqual({key: result.get(key) for key in ("seed", "cfg", "sampler", "scheduler", "steps", "prompt", "negative_prompt")},
                         {"seed": 99, "cfg": 3.5, "sampler": "dpmpp_2m", "scheduler": "simple", "steps": 20, "prompt": "1girl, smile", "negative_prompt": ""})

    def test_moobox_lora_manager_and_rgthree_loaders(self):
        moobox = json.dumps([{"name": "a.safetensors", "strength": 0.7}, {"name": "off.safetensors", "active": False}])
        prompt = graph(**{
            "2": {"class_type": "MooBoxLoraLoader", "inputs": {"model": ["30", 0], "loras": moobox}},
            "30": {"class_type": "Lora Loader (LoraManager)", "inputs": {"model": ["31", 0], "lora_stack": ["32", 0], "loras": {"__value__": [{"name": "b", "strength": 1.0, "active": True}]}}},
            "32": {"class_type": "Lora Stacker (LoraManager)", "inputs": {"loras": [{"name": "c", "strength": 0.3, "active": True}]}},
            "31": {"class_type": "Power Lora Loader (rgthree)", "inputs": {"model": ["1", 0], "lora_1": {"on": True, "lora": "d.safetensors", "strength": 0.9}, "lora_2": {"on": False, "lora": "e.safetensors", "strength": 1}}},
        })
        self.assertEqual(extract(prompt)["loras"], [("d.safetensors", 0.9), ("c", 0.3), ("b", 1.0), ("a.safetensors", 0.7), ("detail/eyes.safetensors", 0.5)])

    def test_unet_loader_and_lora_manager_prompt(self):
        prompt = graph(**{"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux.safetensors", "weight_dtype": "default"}},
                          "5": {"class_type": "Prompt (LoraManager)", "inputs": {"clip": ["4", 0], "text": "a cat", "trigger_words1": "trig"}}})
        result = extract(prompt)
        self.assertEqual((result["checkpoint"], result["prompt"]), (("flux.safetensors", "diffusion_models"), "trig, a cat"))


class TextTests(unittest.TestCase):
    def test_lora_tags_and_embeddings(self):
        text = "1girl, <lora:style:0.8>, embedding:neg/EasyNegative.pt, (embedding:good:1.2), <lora:x:bad>"
        self.assertEqual(meta.parse_lora_tags(text), [("style", 0.8)])
        self.assertEqual(meta.embedding_names(text), ["neg/EasyNegative.pt", "good"])
        self.assertEqual(meta.shorten_embeddings(meta.strip_lora_tags(text)), "1girl, embedding:EasyNegative, (embedding:good:1.2)")
        self.assertEqual(meta.model_stem("loras\\sub\\foo_v1.5"), "foo_v1.5")
        self.assertEqual(meta.model_stem("sub/foo_v1.5.safetensors"), "foo_v1.5")

    def test_model_details_from_lora_manager_and_civitai_info(self):
        manager = {"sha256": "AB" * 32, "base_model": "Illustrious", "model_name": "Local", "civitai": {"id": 3, "modelId": 2, "name": "V1", "air": "urn:air:sdxl:lora:civitai:2@3", "model": {"name": "Silver"}}}
        self.assertEqual(meta.model_details("file", "", manager), {"file_name": "file", "sha256": "ab" * 32, "model_id": 2, "version_id": 3, "model_name": "Silver",
                                                                   "version_name": "V1", "base_model": "Illustrious", "air": "urn:air:sdxl:lora:civitai:2@3"})
        info = meta.model_details("file", "cd" * 32, {"id": 5, "modelId": 4, "name": "V2", "baseModel": "SDXL 1.0", "model": {"name": "Ckpt"}})
        self.assertEqual((info["version_id"], info["model_id"], info["base_model"], info["sha256"]), (5, 4, "SDXL 1.0", "cd" * 32))
        self.assertEqual(meta.model_details("file", "", {})["model_name"], "file")


class FormatTests(unittest.TestCase):
    gen = {"prompt": "1girl, smile", "negative_prompt": "lowres", "steps": 28, "cfg": 5.5, "seed": 42, "sampler": "euler_ancestral", "scheduler": "karras",
           "width": 832, "height": 1216, "clip_skip": 2}

    def test_a1111_layout(self):
        checkpoint = details("base, v2", "ab" * 32, version=11, air="urn:air:sdxl:checkpoint:civitai:7@11")
        loras = [details("style", "cd" * 32, version=12, strength=0.8), details("eyes{x}", "ef" * 32, strength=0.5)]
        text = meta.format_parameters(self.gen, checkpoint, loras, [], True, "Hires upscale: 1.5,\nfoo")
        self.assertEqual(text, (
            "1girl, smile\n<lora:style:0.8> <lora:eyes{x}:0.5>\nNegative prompt: lowres\n"
            "Steps: 28, Sampler: Euler a Karras, CFG scale: 5.5, Seed: 42, Size: 832x1216, Clip skip: 2, engine: ComfyUI, Hires upscale: 1.5, foo, "
            "Model hash: ABABABABAB, Model: base v2, "
            'Hashes: {"model":"ABABABABAB","LORA:style":"CDCDCDCDCD","LORA:eyesx":"EFEFEFEFEF"}, Version: ComfyUI, '
            'Civitai resources: [{"air":"urn:air:sdxl:checkpoint:civitai:7@11","versionName":"v1"},{"type":"lora","modelVersionId":12,"weight":0.8,"versionName":"v1"}]'))

    def test_minimal_text_has_no_empty_fields(self):
        self.assertEqual(meta.format_parameters({"width": 64, "height": 64}, None, [], [], False, ""), "\nSize: 64x64, engine: ComfyUI, Version: ComfyUI")

    def test_recipe_block_is_the_last_single_line(self):
        checkpoint = details("base", "ab" * 32, version=11, base="SDXL 1.0")
        loras = [details("style", "cd" * 32, version=12, base="Illustrious", strength=0.8), details("eyes", "", strength=0.5)]
        recipe = meta.recipe_metadata({**self.gen, "denoise": 0.6}, checkpoint, loras)
        text = meta.with_recipe("params", recipe)
        self.assertTrue(text.startswith("params \n Recipe metadata: {"))
        self.assertTrue(text.endswith("}"))
        self.assertNotIn("\n", text.split("Recipe metadata: ")[1])
        self.assertEqual(json.loads(text.split("Recipe metadata: ")[1]), recipe)
        self.assertEqual(recipe["loras"][1], {"file_name": "eyes", "hash": "", "strength": 0.5, "modelVersionId": 0, "modelName": "eyes", "modelVersionName": ""})
        self.assertEqual(recipe["checkpoint"]["name"], recipe["checkpoint"]["modelName"])
        self.assertEqual((recipe["title"], recipe["base_model"], recipe["tags"]), ("style-0.80_eyes-0.50", "Illustrious", []))
        self.assertEqual(recipe["gen_params"], {"prompt": "1girl, smile", "negative_prompt": "lowres", "steps": 28, "cfg_scale": 5.5, "seed": 42, "clip_skip": 2,
                                                "denoising_strength": 0.6, "sampler": "Euler a Karras", "size": "832x1216"})


class NamingTests(unittest.TestCase):
    values = {"seed": 42, "width": 832, "height": 1216, "steps": 28, "cfg": "5.5", "sampler": "euler", "scheduler": "karras", "model": "base", "pprompt": 'a "cat"\non/a mat', "nprompt": None}

    def test_tokens(self):
        expand = lambda text: meta.expand_tokens(text, self.values, NOW)
        self.assertEqual(expand("%date%/%model%_%seed%_%width%x%height%"), "2026-11-28/base_42_832x1216")
        self.assertEqual(expand("%date:yyMMdd-hhmmss%_%time%_%year%%month%"), "261128-090507_090507_202611")
        self.assertEqual(expand("%pprompt:9%|%nprompt%|%model:2%|%cfg%|%unknown%|%batch_num%|%counter:3%"), "a cat ona||ba|5.5|%unknown%|%batch_num%|%counter:3%")

    def test_prefix_is_split_sanitised_and_kept_inside(self):
        self.assertEqual(meta.split_prefix("out/sub: x/name?_%counter:3%", NOW), (["out", "sub x"], "name_%counter%", 3))
        self.assertEqual(meta.split_prefix("folder/", NOW), (["folder"], "20261128-090507", 5))
        for prefix in ("../x", "a/../../x", "/abs", "C:/x", "\\\\server\\x", "a\\..\\x"):
            with self.assertRaises(ValueError, msg=prefix):
                meta.split_prefix(prefix, NOW)

    def test_counter_continues_after_existing_files(self):
        stems = {"comfyui_00007_", "comfyui_00002_", "other_00099_"}
        self.assertEqual(meta.plan_names("ComfyUI", [0, 1], ".png", stems, True, False), ["ComfyUI_00008_.png", "ComfyUI_00009_.png"])
        self.assertEqual(meta.plan_names("img_%counter%_%batch_num%", [0, 1], ".webp", {"img_004_0"}, False, False, 3), ["img_005_0.webp", "img_006_1.webp"])

    def test_counter_off_dedupes_overwrites_and_forces_a_counter_for_batches(self):
        self.assertEqual(meta.plan_names("Name", [0], ".png", {"name", "name_0001"}, False, False), ["Name_0002.png"])
        self.assertEqual(meta.plan_names("Name", [0], ".png", {"name"}, False, True), ["Name.png"])
        self.assertEqual(meta.plan_names("Name", [0, 1], ".png", set(), False, False), ["Name_00001_.png", "Name_00002_.png"])
        self.assertEqual(meta.plan_names("Name_%batch_num%", [0, 1], ".png", {"name_1"}, False, False), ["Name_0.png", "Name_1_0001.png"])

    def test_output_folder_rejects_escapes(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(meta.output_folder(folder, ["a", "b"]), os.path.join(folder, "a", "b"))
            with self.assertRaises(ValueError):
                meta.output_folder(folder, ["..", "x"])


def manifest(run="0123456789ab", index=0, **extra):
    return {"run": run, "index": index, "folder": ["sub"], "name": "Pic", "digits": 5, "counter": False, "overwrite": False, "caption": "a cat", "workflow": {"nodes": []}, **extra}


def temp_preview(folder, index=0, data=b"\x89PNG data", **extra):
    name = f"MooBoxSave_{extra.get('run', '0123456789ab')}_{index:05d}.png"
    with open(os.path.join(folder, name), "wb") as file:
        file.write(data)
    with open(os.path.join(folder, name + meta.MANIFEST), "w") as file:
        json.dump(manifest(index=index, **extra), file)
    return {"filename": name, "subfolder": "", "type": "temp"}


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp, self.output = tempfile.mkdtemp(), tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp)
        shutil.rmtree(self.output)

    def test_copies_bytes_names_like_a_save_and_writes_sidecars(self):
        images = [temp_preview(self.temp, 0, b"first"), temp_preview(self.temp, 1, b"second")]
        saved = meta.export_previews(self.temp, self.output, images)
        self.assertEqual(saved, [{"filename": "Pic_00001_.png", "subfolder": "sub", "type": "output"}, {"filename": "Pic_00002_.png", "subfolder": "sub", "type": "output"}])
        folder = os.path.join(self.output, "sub")
        with open(os.path.join(folder, "Pic_00002_.png"), "rb") as file:
            self.assertEqual(file.read(), b"second")
        with open(os.path.join(folder, "Pic_00001_.txt"), encoding="utf-8") as file:
            self.assertEqual(file.read(), "a cat")
        self.assertTrue(os.path.isfile(os.path.join(folder, "Pic_00001_.json")))
        # A second export of the same image never replaces the first.
        self.assertEqual(meta.export_previews(self.temp, self.output, images[:1])[0]["filename"], "Pic.png")
        self.assertEqual(meta.export_previews(self.temp, self.output, images[:1])[0]["filename"], "Pic_0001.png")

    def test_overwrite_mode_replaces_the_fixed_name(self):
        image = temp_preview(self.temp, 0, b"new", overwrite=True, caption=None, workflow=None)
        os.makedirs(os.path.join(self.output, "sub"))
        with open(os.path.join(self.output, "sub", "Pic.png"), "wb") as file:
            file.write(b"old")
        self.assertEqual(meta.export_previews(self.temp, self.output, [image])[0]["filename"], "Pic.png")
        with open(os.path.join(self.output, "sub", "Pic.png"), "rb") as file:
            self.assertEqual(file.read(), b"new")
        self.assertEqual(sorted(os.listdir(os.path.join(self.output, "sub"))), ["Pic.png"])

    def test_rejects_anything_but_this_nodes_temp_previews(self):
        good = temp_preview(self.temp)
        bad = [[], None, "x", [{"filename": "../x.png", "subfolder": "", "type": "temp"}], [{**good, "type": "output"}], [{**good, "subfolder": "sub"}],
               [{**good, "filename": "ComfyUI_temp_abcde_00001_.png"}], [{**good, "filename": good["filename"] + meta.MANIFEST}],
               [{**good, "filename": "C:\\" + good["filename"]}], [good, temp_preview(self.temp, 1, run="ba9876543210")]]
        for images in bad:
            with self.assertRaises(ValueError, msg=images):
                meta.export_previews(self.temp, self.output, images)
        self.assertEqual(os.listdir(self.output), [])

    def test_missing_preview_reports_that_it_is_gone(self):
        image = temp_preview(self.temp)
        os.remove(os.path.join(self.temp, image["filename"]))
        with self.assertRaisesRegex(FileNotFoundError, "Run the workflow again"):
            meta.export_previews(self.temp, self.output, [image])


class SaveNodeTests(unittest.TestCase):
    # Loads save_image.py against the real ComfyUI API and Pillow, so files are really written and read back.
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(root.parents[1]))
        stub = types.ModuleType("moobox_save_pack.nodes")
        stub.tag_categories = lambda: {}
        sys.modules["moobox_save_pack.nodes"] = stub
        cls.save = importlib.import_module("moobox_save_pack.save_image")
        cls.paths = importlib.import_module("folder_paths")
        global torch, Image
        import torch
        from PIL import Image

    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.output, self.temp, self.models = (os.path.join(self.folder, name) for name in ("output", "temp", "models"))
        os.makedirs(self.models)
        for name in ("base.safetensors", "style.safetensors", "detail/eyes.safetensors"):
            os.makedirs(os.path.dirname(os.path.join(self.models, name)), exist_ok=True)
            with open(os.path.join(self.models, name), "wb") as file:
                file.write(name.encode())
        with open(os.path.join(self.models, "style.metadata.json"), "w") as file:
            json.dump({"sha256": "AB" * 32, "base_model": "Illustrious", "civitai": {"id": 12, "modelId": 6, "name": "V1", "model": {"name": "Style"}}}, file)
        full = lambda folder, name: path if os.path.isfile(path := os.path.join(self.models, name.replace("\\", "/"))) else None
        listed = lambda folder: ["base.safetensors", "style.safetensors", "detail/eyes.safetensors"]
        patches = [patch.object(self.paths, "get_output_directory", lambda: self.output), patch.object(self.paths, "get_temp_directory", lambda: self.temp),
                   patch.object(self.paths, "get_full_path", full), patch.object(self.paths, "get_filename_list", listed),
                   patch.object(self.save, "HASH_CACHE", os.path.join(self.folder, "hashes.json")), patch.object(self.save, "_hashes", None)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        prompt = graph()
        prompt["1"]["inputs"]["ckpt_name"] = "base.safetensors"
        self.save.MooBoxSaveImage.hidden = types.SimpleNamespace(prompt=prompt, extra_pnginfo={"workflow": {"nodes": [1, 2]}}, unique_id="9")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.folder)

    def run_node(self, count=1, **options):
        settings = dict(filename_prefix="run/%model%_%seed%", file_format="png", save=True, embed_workflow=True, recipe_metadata=True, add_loras_to_prompt=False,
                        save_with_metadata=True, counter=True, overwrite=False, quality=90, lossless_webp=False, webp_method=4, jpeg_subsampling="4:2:0",
                        compress_level=4, optimize_png=False, easy_remix=False, save_workflow_as_json=False, caption_txt=False, additional_data="")
        settings.update(options)
        return self.save.MooBoxSaveImage.execute(torch.rand(count, 16, 24, 3), **settings)

    def exif_text(self, image):
        exif = image.getexif()
        comment = exif.get_ifd(0x8769).get(0x9286, b"")
        return exif.get(0x010F, ""), exif.get(0x0110, ""), comment[8:].decode("utf-16be") if comment.startswith(b"UNICODE\0") else ""

    def test_png_carries_parameters_recipe_prompt_and_workflow(self):
        output = self.run_node()
        self.assertEqual(output.ui, {"images": [{"filename": "base_42_00001_.png", "subfolder": "run", "type": "output"}]})
        with Image.open(os.path.join(self.output, "run", "base_42_00001_.png")) as image:
            image.load()
            info = dict(image.info)
        self.assertEqual(json.loads(info["workflow"]), {"nodes": [1, 2]})
        self.assertEqual(json.loads(info["prompt"])["7"]["inputs"]["seed"], 42)
        self.assertTrue(info["parameters"].startswith(output.result[1] + " \n Recipe metadata: {"))
        self.assertIn("Size: 24x16", output.result[1])
        self.assertIn('"LORA:style":"ABABABABAB"', output.result[1])
        self.assertIn('Civitai resources: [{"type":"lora","modelVersionId":12,"weight":0.8,"versionName":"V1"}]', output.result[1])
        recipe = json.loads(info["parameters"].split("Recipe metadata: ")[1])
        import hashlib
        self.assertEqual(recipe["checkpoint"]["hash"], hashlib.sha256(b"base.safetensors").hexdigest())
        self.assertEqual([lora["file_name"] for lora in recipe["loras"]], ["style", "eyes"])
        self.assertEqual(recipe["loras"][0]["modelVersionId"], 12)
        with open(os.path.join(self.folder, "hashes.json")) as file:
            self.assertEqual(len(json.load(file)), 2)

    def test_webp_and_jpeg_store_metadata_in_exif(self):
        for file_format in ("webp", "jpeg"):
            output = self.run_node(file_format=file_format)
            with Image.open(os.path.join(self.output, "run", output.ui["images"][0]["filename"])) as image:
                make, model, comment = self.exif_text(image)
            self.assertTrue(make.startswith("workflow:"), file_format)
            self.assertEqual(json.loads(model[len("prompt:"):])["9"]["class_type"], "MooBoxSaveImage")
            self.assertIn("Recipe metadata: {", comment)

    def test_jpeg_drops_prompt_then_workflow_when_too_large(self):
        self.save.MooBoxSaveImage.hidden.extra_pnginfo = {"workflow": {"big": "x" * 40000}}
        self.save.MooBoxSaveImage.hidden.prompt["99"] = {"class_type": "Note", "inputs": {"text": "y" * 40000}}
        with self.assertLogs(level="WARNING") as logs:
            output = self.run_node(file_format="jpeg")
        self.assertIn("left out the prompt", logs.output[0])
        with Image.open(os.path.join(self.output, "run", output.ui["images"][0]["filename"])) as image:
            make, model, comment = self.exif_text(image)
        self.assertEqual(model, "")
        self.assertTrue(make.startswith("workflow:"))
        self.assertIn("Steps: 28", comment)

    def test_toggles_sidecars_and_batches(self):
        output = self.run_node(count=2, filename_prefix="Fixed", counter=False, embed_workflow=False, recipe_metadata=False, caption_txt=True,
                               save_workflow_as_json=True, add_loras_to_prompt=True, easy_remix=True)
        self.assertEqual([image["filename"] for image in output.ui["images"]], ["Fixed_00001_.png", "Fixed_00002_.png"])
        self.assertEqual(sorted(os.listdir(self.output)), ["Fixed_00001_.json", "Fixed_00001_.png", "Fixed_00001_.txt", "Fixed_00002_.json", "Fixed_00002_.png", "Fixed_00002_.txt"])
        with Image.open(os.path.join(self.output, "Fixed_00001_.png")) as image:
            image.load()
            self.assertEqual(sorted(image.info), ["parameters"])
            self.assertNotIn("Recipe metadata", image.info["parameters"])
            self.assertIn("<lora:style:0.8> <lora:eyes:0.5>", image.info["parameters"])

    def test_without_metadata_and_with_overrides(self):
        output = self.run_node(save_with_metadata=False, embed_workflow=False, positive="override", seed=7, loras="<lora:style:0.3>")
        self.assertTrue(output.result[1].startswith("override\nNegative prompt: lowres\n"))
        self.assertIn("Seed: 7", output.result[1])
        self.assertIn('weight":0.3', output.result[1])
        with Image.open(os.path.join(self.output, "run", "base_7_00001_.png")) as image:
            image.load()
            self.assertEqual(image.info.get("parameters"), None)

    def test_broken_graph_still_saves_the_image(self):
        self.save.MooBoxSaveImage.hidden.prompt["2"]["inputs"]["strength_model"] = {"weird": True}
        with patch.object(self.save, "extract_generation", side_effect=RuntimeError("boom")), self.assertLogs(level="WARNING"):
            output = self.run_node(filename_prefix="safe")
        self.assertEqual(output.result[1], "")
        self.assertTrue(os.path.isfile(os.path.join(self.output, "safe_00001_.png")))

    def test_traversal_in_the_prefix_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_node(filename_prefix="../escape")

    def test_save_off_previews_in_temp_with_full_metadata_and_exports_later(self):
        output = self.run_node(count=2, save=False, caption_txt=True, file_format="webp")
        images = output.ui["images"]
        self.assertEqual([image["type"] for image in images], ["temp", "temp"])
        self.assertFalse(os.path.exists(self.output))
        with Image.open(os.path.join(self.temp, images[0]["filename"])) as image:
            self.assertIn("Recipe metadata: {", self.exif_text(image)[2])
        saved = meta.export_previews(self.temp, self.output, images)
        self.assertEqual([file["filename"] for file in saved], ["base_42_00001_.webp", "base_42_00002_.webp"])
        for image, file in zip(images, saved):
            with open(os.path.join(self.temp, image["filename"]), "rb") as source, open(os.path.join(self.output, "run", file["filename"]), "rb") as target:
                self.assertEqual(source.read(), target.read())
        self.assertTrue(os.path.isfile(os.path.join(self.output, "run", "base_42_00001_.txt")))


    def test_user_comment_is_typed_undefined(self):
        data = self.save.exif_bytes("héllo", {0x010F: "workflow:{}"})
        self.assertTrue(data.startswith(b"Exif\0\0MM\0*"))
        # 7 is UNDEFINED; Pillow would write BYTE, which piexif-based readers turn into a tuple.
        self.assertIn(struct.pack(">HH", 0x9286, 7), data)
        self.assertIsNone(self.save.exif_bytes("", {}))


if __name__ == "__main__":
    unittest.main()
