from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import struct
import uuid
from datetime import datetime

import numpy as np
import folder_paths
from comfy.cli_args import args
from comfy_api.latest import io
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from .image_metadata import (MANIFEST, TEMP_PREFIX, embedding_names, existing_stems, expand_tokens, extract_generation, format_parameters, model_details,
                             model_stem, output_folder, parse_lora_tags, plan_names, recipe_metadata as build_recipe, shorten_embeddings, split_prefix, strip_lora_tags,
                             token_values, with_recipe, write_sidecars)
from .nodes import tag_categories

EXTENSIONS = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}
SUBSAMPLING = {"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}
# Pillow refuses a larger EXIF block in a JPEG APP1 segment.
MAX_JPEG_EXIF = 65533
HASH_CACHE = os.path.join(folder_paths.get_user_directory(), "moobox", "model_hashes.json")
# sha256 per model path, valid while size and mtime are unchanged. Kept in the user folder: model folders are never written.
_hashes: dict[str, list] | None = None


def file_sha256(path: str) -> str:
    global _hashes
    if _hashes is None:
        try:
            with open(HASH_CACHE, encoding="utf-8") as file:
                _hashes = json.load(file)
        except (OSError, ValueError):
            _hashes = {}
    stat = os.stat(path)
    key, stamp = os.path.normcase(os.path.abspath(path)), [stat.st_size, stat.st_mtime_ns]
    cached = _hashes.get(key)
    if cached and cached[:2] == stamp:
        return cached[2]
    logging.info("MooBox Save Image: hashing %s once for the image metadata.", os.path.basename(path))
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    _hashes[key] = [*stamp, digest.hexdigest()]
    os.makedirs(os.path.dirname(HASH_CACHE), exist_ok=True)
    with open(HASH_CACHE + ".tmp", "w", encoding="utf-8") as file:
        json.dump(_hashes, file)
    os.replace(HASH_CACHE + ".tmp", HASH_CACHE)
    return _hashes[key][2]


def find_model(folder: str, name: str) -> str | None:
    path = folder_paths.get_full_path(folder, name)
    if path:
        return path
    # LoRA Manager and prompt tags name models by file name without folder or extension.
    target = model_stem(name).lower()
    match = next((candidate for candidate in folder_paths.get_filename_list(folder) if model_stem(candidate).lower() == target), None)
    return folder_paths.get_full_path(folder, match) if match else None


def read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def describe(path: str) -> dict:
    base = os.path.splitext(path)[0]
    local = read_json(base + ".metadata.json") or read_json(base + ".civitai.info")
    try:
        with open(base + ".sha256", encoding="utf-8") as file:
            sidecar = file.read().split()
    except OSError:
        sidecar = []
    sha256 = sidecar[0] if sidecar and re.fullmatch(r"[0-9a-fA-F]{64}", sidecar[0]) else local.get("sha256") if isinstance(local.get("sha256"), str) else ""
    return model_details(model_stem(path), sha256 or file_sha256(path), local)


def describe_model(folder: str, name: str) -> dict:
    path = find_model(folder, name)
    return describe(path) if path else model_details(model_stem(name), "", {})


def exif_bytes(parameters: str, text_tags: dict[int, str]) -> bytes | None:
    # Written by hand: Pillow types a bytes UserComment as BYTE, which readers such as piexif return as a tuple.
    sizes = {2: 1, 4: 4, 7: 1}

    def ifd(entries, offset):
        data_start = offset + 2 + 12 * len(entries) + 4
        table, data = struct.pack(">H", len(entries)), b""
        for tag, kind, payload in entries:
            if len(payload) <= 4:
                table += struct.pack(">HHI", tag, kind, len(payload) // sizes[kind]) + payload.ljust(4, b"\0")
            else:
                table += struct.pack(">HHII", tag, kind, len(payload) // sizes[kind], data_start + len(data))
                data += payload + b"\0" * (len(payload) % 2)
        return table + b"\0\0\0\0" + data

    entries = [(tag, 2, value.encode("utf-8") + b"\0") for tag, value in sorted(text_tags.items())]
    if parameters:
        entries.append((0x8769, 4, b"\0\0\0\0"))
    if not entries:
        return None
    block = ifd(entries, 8)
    if parameters:
        entries[-1] = (0x8769, 4, struct.pack(">I", 8 + len(block)))
        block = ifd(entries, 8) + ifd([(0x9286, 7, b"UNICODE\0" + parameters.encode("utf-16be"))], 8 + len(block))
    return b"Exif\0\0MM\0\x2a" + struct.pack(">I", 8) + block


def write_image(image: Image.Image, path: str, file_format: str, parameters: str, chunks: dict[str, str], options: dict) -> None:
    if file_format == "png":
        info = PngInfo()
        if parameters:
            info.add_text("parameters", parameters)
        for key, value in chunks.items():
            info.add_text(key, value)
        image.save(path, pnginfo=info, compress_level=options["compress_level"], optimize=options["optimize_png"])
        return
    # Like ComfyUI's WebP saver: the prompt in Model (0x0110), the workflow and other extra data from Make (0x010F) down.
    tags = {0x0110: f"prompt:{chunks['prompt']}"} if "prompt" in chunks else {}
    tags.update({0x010F - offset: f"{key}:{value}" for offset, (key, value) in enumerate(item for item in chunks.items() if item[0] != "prompt")})
    exif = exif_bytes(parameters, tags)
    if file_format == "jpeg":
        dropped = []
        while exif and len(exif) > MAX_JPEG_EXIF:
            if 0x0110 in tags:
                dropped.append("prompt")
                del tags[0x0110]
            elif tags:
                dropped.append("workflow")
                tags.clear()
            else:
                dropped.append("generation parameters")
                parameters = ""
            exif = exif_bytes(parameters, tags)
        if dropped:
            logging.warning("MooBox Save Image: the metadata is too large for a JPEG; left out the %s. Save as PNG or WebP to keep it.", ", ".join(dropped))
        image.save(path, quality=options["quality"], optimize=True, subsampling=SUBSAMPLING[options["jpeg_subsampling"]], **({"exif": exif} if exif else {}))
    else:
        image.save(path, quality=options["quality"], lossless=options["lossless_webp"], method=options["webp_method"], **({"exif": exif} if exif else {}))


DEFAULT_QUALITY = 95


# Format options of both nodes, so their defaults stay identical.
def quality_input(**extra):
    return io.Int.Input("quality", default=DEFAULT_QUALITY, min=1, max=100, tooltip="JPEG and lossy WebP quality.", **extra)


def webp_method_input(**extra):
    return io.Int.Input("webp_method", default=4, min=0, max=6, tooltip="WebP effort: 0 is fastest, 6 smallest.", **extra)


def jpeg_subsampling_input(**extra):
    return io.Combo.Input("jpeg_subsampling", options=list(SUBSAMPLING), **extra)


def compress_level_input(**extra):
    return io.Int.Input("compress_level", default=4, min=0, max=9, tooltip="PNG compression level.", **extra)


def generation(hidden, width: int, height: int, easy_remix: bool, overrides: dict) -> dict:
    gen = extract_generation(hidden.prompt, str(hidden.unique_id), tag_categories())
    for name, key in (("positive", "prompt"), ("negative", "negative_prompt")):
        if overrides.get(name) is not None:
            gen[key] = overrides[name]
    if overrides.get("checkpoint"):
        gen["checkpoint"] = (overrides["checkpoint"], "checkpoints" if find_model("checkpoints", overrides["checkpoint"]) else "diffusion_models")
    if overrides.get("loras") is not None:
        gen["loras"] = parse_lora_tags(overrides["loras"])
    loras = gen.setdefault("loras", [])
    known = {model_stem(name).lower() for name, _ in loras}
    loras.extend(tag for tag in parse_lora_tags(gen.get("prompt", "")) if model_stem(tag[0]).lower() not in known)
    if easy_remix:
        gen["prompt"] = shorten_embeddings(strip_lora_tags(gen.get("prompt", "")))
        gen["negative_prompt"] = shorten_embeddings(gen.get("negative_prompt", ""))
    gen["width"], gen["height"] = width, height
    return gen


def generation_parameters(gen: dict, add_loras_to_prompt: bool, additional_data: str) -> tuple[str, str]:
    checkpoint = describe_model(gen["checkpoint"][1], gen["checkpoint"][0]) if gen.get("checkpoint") else None
    loras = [{**describe_model("loras", name), "strength": strength} for name, strength in gen["loras"]]
    embeddings = [describe(path) for name in embedding_names(gen.get("prompt", ""), gen.get("negative_prompt", "")) if (path := find_model("embeddings", name))]
    text = format_parameters(gen, checkpoint, loras, embeddings, add_loras_to_prompt, additional_data)
    return text, with_recipe(text, build_recipe(gen, checkpoint, loras))


# The save of both nodes. `options` holds the settings of the chosen format; returns the parameters text and the saved images.
def save_images(hidden, images, filename_prefix: str, file_format: str, options: dict, save: bool, embed_workflow: bool, recipe_metadata: bool,
                add_loras_to_prompt: bool, save_with_metadata: bool, counter: bool, overwrite: bool, easy_remix: bool, save_workflow_as_json: bool,
                caption_txt: bool, additional_data: str, overrides: dict) -> tuple[str, list[dict]]:
    if file_format not in EXTENSIONS or (file_format == "jpeg" and options["jpeg_subsampling"] not in SUBSAMPLING):
        raise ValueError("Unknown file format or JPEG subsampling.")
    height, width = images.shape[1], images.shape[2]
    try:
        gen = generation(hidden, width, height, easy_remix, overrides)
        parameters, with_block = generation_parameters(gen, add_loras_to_prompt, additional_data)
    except Exception:
        # An unusual graph must never cost the image: save it without generation parameters.
        logging.warning("MooBox Save Image: could not read the generation settings from the graph.", exc_info=True)
        gen, parameters, with_block = {"width": width, "height": height}, "", ""
    embedded = (with_block if recipe_metadata else parameters) if save_with_metadata and not args.disable_metadata else ""
    extra = hidden.extra_pnginfo or {}
    chunks = {}
    if embed_workflow and not args.disable_metadata:
        if hidden.prompt is not None:
            chunks["prompt"] = json.dumps(hidden.prompt)
        chunks.update((key, json.dumps(value)) for key, value in extra.items())
    caption = gen.get("prompt", "") if caption_txt else None
    workflow = extra.get("workflow") if save_workflow_as_json else None

    now = datetime.now()
    parts, name, digits = split_prefix(expand_tokens(filename_prefix, token_values(gen), now), now)
    extension = EXTENSIONS[file_format]
    if save:
        folder = output_folder(folder_paths.get_output_directory(), parts)
        names = plan_names(name, list(range(len(images))), extension, existing_stems(folder), counter, overwrite, digits)
        subfolder = os.path.join(*parts) if parts else ""
    else:
        folder, subfolder, run = folder_paths.get_temp_directory(), "", uuid.uuid4().hex[:12]
        os.makedirs(folder, exist_ok=True)
        names = [f"{TEMP_PREFIX}{run}_{index:05d}{extension}" for index in range(len(images))]
    results = []
    for index, (tensor, file) in enumerate(zip(images, names)):
        image = Image.fromarray(np.clip(255.0 * tensor.cpu().numpy(), 0, 255).astype(np.uint8))
        path = os.path.join(folder, file)
        write_image(image, path, file_format, embedded, chunks, options)
        if save:
            write_sidecars(folder, os.path.splitext(file)[0], caption, workflow)
        else:
            # What the Save button needs to name and complete this preview like a normal save of this run.
            with open(path + MANIFEST, "w", encoding="utf-8") as manifest:
                json.dump({"run": run, "index": index, "folder": parts, "name": name, "digits": digits, "counter": counter,
                           "overwrite": overwrite, "caption": caption, "workflow": workflow}, manifest)
        results.append({"filename": file, "subfolder": subfolder, "type": "output" if save else "temp"})
    return parameters, results


class MooBoxSaveImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxSaveImage",
            display_name="Save Image Advanced (MooBox)",
            category="MooBox/Utility",
            description="Saves images with A1111 parameters, the ComfyUI workflow and a LoRA Manager recipe block read from the graph.",
            is_output_node=True,
            inputs=[
                io.Image.Input("images"),
                io.String.Input("filename_prefix", default="ComfyUI", tooltip="File name, may contain subfolders. Tokens: %date%, %date:yyyy-MM-dd%, %time%, %seed%, %width%, %height%, %steps%, %cfg%, %sampler%, %scheduler%, %model%, %model:N%, %pprompt:N%, %nprompt:N%, %batch_num%, %counter%, %counter:N%."),
                io.Combo.Input("file_format", options=list(EXTENSIONS)),
                io.Boolean.Input("save", default=True, tooltip="On: save to the output folder. Off: only preview in the temp folder, with the same metadata; the Save button on the node saves the last run later."),
                io.Boolean.Input("embed_workflow", default=True, tooltip="Embed the ComfyUI prompt and workflow, so dragging a PNG or WebP into ComfyUI restores the graph. ComfyUI does not read it from a JPEG; LoRA Manager does."),
                io.Boolean.Input("recipe_metadata", default=True, tooltip="Append a LoRA Manager recipe block with LoRAs, checkpoint and generation settings."),
                io.Boolean.Input("add_loras_to_prompt", default=False, tooltip="Add <lora:name:strength> tags after the prompt in the A1111 parameters."),
                io.Boolean.Input("save_with_metadata", default=True, advanced=True, tooltip="Embed the A1111 parameters (and the recipe block). Off: no generation parameters in the file."),
                io.Boolean.Input("counter", default=True, advanced=True, tooltip="Add a counter to the file name. Off: a fixed name gets a _0001 suffix when it exists, unless overwrite is on."),
                io.Boolean.Input("overwrite", default=False, advanced=True, tooltip="With the counter off, replace a file with the same name instead of adding a suffix."),
                quality_input(advanced=True),
                io.Boolean.Input("lossless_webp", default=False, advanced=True),
                webp_method_input(advanced=True),
                jpeg_subsampling_input(advanced=True),
                compress_level_input(advanced=True),
                io.Boolean.Input("optimize_png", default=False, advanced=True, tooltip="Smallest PNG at the cost of save time."),
                io.Boolean.Input("easy_remix", default=False, advanced=True, tooltip="Remove <lora:...> tags from the saved prompt and shorten embedding paths to their names."),
                io.Boolean.Input("save_workflow_as_json", default=False, advanced=True, tooltip="Also write the workflow as <name>.json next to the image."),
                io.Boolean.Input("caption_txt", default=False, advanced=True, tooltip="Also write the prompt as <name>.txt next to the image."),
                io.String.Input("additional_data", default="", advanced=True, tooltip="Extra 'Key: value' text added to the parameters line."),
                io.String.Input("positive", optional=True, force_input=True, tooltip="Use this prompt instead of the one found in the graph."),
                io.String.Input("negative", optional=True, force_input=True, tooltip="Use this negative prompt instead of the one found in the graph."),
                io.String.Input("loras", optional=True, force_input=True, tooltip="<lora:name:strength> tags that replace the LoRAs found in the graph."),
                io.String.Input("checkpoint", optional=True, force_input=True, tooltip="Checkpoint or diffusion model file name to record instead of the one found."),
            ],
            outputs=[io.Image.Output("images"), io.String.Output("parameters")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo, io.Hidden.unique_id],
        )

    # `overrides` holds positive, negative, loras and checkpoint when connected. It also takes inputs of older versions
    # (seed, steps, cfg, sampler_name, scheduler): ComfyUI still passes a link a saved workflow keeps to them.
    @classmethod
    def execute(cls, images, filename_prefix, file_format, save, embed_workflow, recipe_metadata, add_loras_to_prompt, save_with_metadata, counter, overwrite,
                quality, lossless_webp, webp_method, jpeg_subsampling, compress_level, optimize_png, easy_remix, save_workflow_as_json, caption_txt,
                additional_data, **overrides) -> io.NodeOutput:
        options = {"quality": quality, "lossless_webp": lossless_webp, "webp_method": webp_method, "jpeg_subsampling": jpeg_subsampling,
                   "compress_level": compress_level, "optimize_png": optimize_png}
        parameters, results = save_images(cls.hidden, images, filename_prefix, file_format, options, save, embed_workflow, recipe_metadata, add_loras_to_prompt,
                                          save_with_metadata, counter, overwrite, easy_remix, save_workflow_as_json, caption_txt, additional_data, overrides)
        return io.NodeOutput(images, parameters, ui={"images": results})


# The fixed settings of Save Image (MooBox); the advanced node exposes them all.
SIMPLE_SETTINGS = {"save": True, "embed_workflow": False, "recipe_metadata": True, "add_loras_to_prompt": True, "save_with_metadata": True, "counter": True,
                   "overwrite": False, "easy_remix": False, "save_workflow_as_json": False, "caption_txt": False, "additional_data": "", "overrides": {}}


class MooBoxSaveImageSimple(io.ComfyNode):
    # Not a subclass of MooBoxSaveImage: ComfyUI caches the outputs on the class, and a subclass would inherit them.
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxSaveImageSimple",
            display_name="Save Image (MooBox)",
            category="MooBox/Utility",
            description="Saves images with A1111 parameters and a LoRA Manager recipe block read from the graph. Without the ComfyUI workflow.",
            is_output_node=True,
            inputs=[
                io.Image.Input("images"),
                io.String.Input("filename_prefix", default="ComfyUI", tooltip="File name, may contain subfolders. Tokens: %date%, %date:yyyy-MM-dd%, %time%, %seed%, %width%, %height%, %steps%, %cfg%, %sampler%, %scheduler%, %model%, %model:N%, %pprompt:N%, %nprompt:N%, %batch_num%, %counter%, %counter:N%."),
                # Each format shows only its own options; ComfyUI keeps the values of the others while the node is open.
                io.DynamicCombo.Input("file_format", options=[
                    io.DynamicCombo.Option("png", [compress_level_input()]),
                    io.DynamicCombo.Option("jpeg", [quality_input(), jpeg_subsampling_input()]),
                    io.DynamicCombo.Option("webp", [
                        io.DynamicCombo.Input("lossless_webp", options=[io.DynamicCombo.Option("off", [quality_input()]), io.DynamicCombo.Option("on", [])]),
                        webp_method_input(),
                    ]),
                ]),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, images, filename_prefix, file_format: dict) -> io.NodeOutput:
        # file_format is {"file_format": "webp", "lossless_webp": {"lossless_webp": "off", "quality": 95}, "webp_method": 4} and the like.
        lossless = file_format.get("lossless_webp", {})
        options = {"quality": DEFAULT_QUALITY, **file_format, **lossless, "lossless_webp": lossless.get("lossless_webp") == "on", "optimize_png": False}
        _, results = save_images(cls.hidden, images, filename_prefix, file_format["file_format"], options, **SIMPLE_SETTINGS)
        return io.NodeOutput(ui={"images": results})
