from __future__ import annotations

import json
import os
import re
from collections import Counter, deque
from datetime import datetime

from .logic import filter_words, format_tags, join_prompt, order_illustrious, read_state

# Reads the API prompt graph to describe how an image was made, and plans file names for MooBox Save Image.
# Nothing here imports ComfyUI, so it runs in the tests as is.

MAX_DEPTH = 32
SAMPLER_NODES = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"}
# Inputs of a sampler that link to the nodes holding its seed, guider, sampler name and schedule.
SAMPLER_HELPERS = ("noise", "guider", "sampler", "sigmas")
ENCODER_TEXT_INPUTS = ("text", "prompt", "text_g", "t5xxl")
MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".pkl", ".sft", ".gguf")
LORA_TAG = re.compile(r"<lora:([^:<>]+):([^:<>]+)(?::[^:<>]*)?>", re.IGNORECASE)
# ComfyUI's tokenizer only reads `embedding:` after whitespace or an opening bracket.
EMBEDDING = re.compile(r"(?<![^\s(\[{])embedding:([^\s:<>\[\]{}(),]+)")
CIVITAI_SAMPLERS = {
    "euler": "Euler", "euler_ancestral": "Euler a", "lms": "LMS", "heun": "Heun", "dpm_2": "DPM2", "dpm_2_ancestral": "DPM2 a",
    "dpmpp_2s_ancestral": "DPM++ 2S a", "dpmpp_2m": "DPM++ 2M", "dpmpp_sde": "DPM++ SDE", "dpmpp_sde_gpu": "DPM++ SDE",
    "dpmpp_2m_sde": "DPM++ 2M SDE", "dpmpp_2m_sde_gpu": "DPM++ 2M SDE", "dpmpp_3m_sde": "DPM++ 3M SDE", "dpm_fast": "DPM fast",
    "dpm_adaptive": "DPM adaptive", "ddim": "DDIM", "plms": "PLMS", "uni_pc": "UniPC", "uni_pc_bh2": "UniPC", "lcm": "LCM",
}
CIVITAI_SCHEDULERS = {"karras": "Karras", "exponential": "Exponential", "sgm_uniform": "SGM Uniform", "simple": "Simple", "beta": "Beta"}


def is_link(value) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int)


def lora_entries(value) -> list:
    # LoRA Manager stores its list either bare or as {"__value__": [...]}.
    value = read_state(value) if isinstance(value, str) else value
    return value.get("__value__", []) if isinstance(value, dict) else value if isinstance(value, list) else []


def concatenate(graph, inputs, index):
    parts = [graph.text(inputs.get(name, "")) for name in ("delimiter", "string_a", "string_b")]
    return None if None in parts else parts[0].join(parts[1:])


def tag_text_prompt(graph, inputs, index):
    tags, natural = graph.text(inputs.get("tags", "")), graph.text(inputs.get("natural_text", ""))
    if tags is None or natural is None:
        return None
    parts = (format_tags(tags), natural.strip())
    return (join_prompt(*(parts if inputs.get("order") != "text first" else parts[::-1])), *parts)[index]


def illustrious_tags(graph, inputs, index):
    tags, words = graph.text(inputs.get("tags", "")), graph.text(inputs.get("trigger_words", ""))
    return None if tags is None or words is None else order_illustrious(join_prompt(tags, words), graph.categories, inputs.get("quality_tags") != "end")


def trigger_words(graph, inputs, index):
    selection = read_state(graph.value(inputs.get("selection", "{}")))
    source = graph.text(inputs["trigger_words"]) if "trigger_words" in inputs else selection.get("source", "")
    return None if source is None else filter_words(source, selection, bool(graph.value(inputs.get("default_active", False))))


def loader_words(graph, inputs, index):
    if index != 2 or graph.value(inputs.get("loader", "ComfyUI")) != "ComfyUI":
        return None
    entries = [entry for entry in lora_entries(graph.value(inputs.get("loras", "[]"))) if entry.get("active", True)]
    return ",, ".join(word for entry in entries for word in entry.get("words", []))


def seeds(graph, inputs, index):
    values = read_state(graph.value(inputs.get("seeds", "[]")))
    return values[index] if index < len(values) and values[index] != -1 else None


def lm_prompt(graph, inputs, index=0):
    parts = [graph.text(value) for name, value in inputs.items() if name.startswith("trigger_words")] + [graph.text(inputs.get("text", ""))]
    return None if None in parts else ", ".join(part for part in parts if part)


# Nodes whose output value can be worked out from their inputs: (graph, inputs, output index) -> value or None.
VALUE_NODES = {
    "StringConcatenate": concatenate,
    "MooBoxSeeds": seeds,
    "MooBoxTagPrompt": lambda graph, inputs, index: None if (tags := graph.text(inputs.get("tags", ""))) is None else format_tags(tags),
    "MooBoxTagTextPrompt": tag_text_prompt,
    "MooBoxIllustriousTags": illustrious_tags,
    "MooBoxTriggerWords": trigger_words,
    "MooBoxLoraLoader": loader_words,
    "Prompt (LoraManager)": lambda graph, inputs, index: lm_prompt(graph, inputs) if index == 1 else None,
}
# Conditioning nodes that build their text from more than one input.
ENCODERS = {"Prompt (LoraManager)": lm_prompt}


def moobox_loras(graph, inputs):
    return [(entry.get("name"), entry.get("strength", 1)) for entry in lora_entries(graph.value(inputs.get("loras", "[]"))) if entry.get("active", True)]


def manager_loras(graph, inputs):
    stacked = graph.node_loras(graph.node(inputs["lora_stack"])) if is_link(inputs.get("lora_stack")) else []
    return stacked + moobox_loras(graph, inputs)


# Nodes that apply several LoRAs: (graph, inputs) -> [(name, strength)].
LORA_NODES = {"MooBoxLoraLoader": moobox_loras, "Lora Loader (LoraManager)": manager_loras, "Lora Stacker (LoraManager)": manager_loras}


class Graph:
    def __init__(self, prompt: dict, categories: dict[str, int]):
        self.prompt = prompt if isinstance(prompt, dict) else {}
        self.categories = categories
        self.depth = 0

    def node(self, link) -> dict | None:
        node = self.prompt.get(link[0]) if is_link(link) else None
        return node if isinstance(node, dict) and isinstance(node.get("inputs"), dict) else None

    # A widget value, or the value behind a link to a node that is known or passes one input through.
    def value(self, value, names: tuple[str, ...] = ()):
        if not is_link(value):
            return value
        node = self.node(value)
        if node is None or self.depth >= MAX_DEPTH:
            return None
        self.depth += 1
        inputs = node["inputs"]
        reader = VALUE_NODES.get(node.get("class_type"))
        if reader:
            result = reader(self, inputs, value[1])
        else:
            name = next((name for name in (*names, "value") if name in inputs), None) if value[1] == 0 else None
            result = None if name is None else self.value(inputs[name], names)
        self.depth -= 1
        return result

    def text(self, value) -> str | None:
        result = self.value(value, ("text", "string", "value", "prompt"))
        return result if isinstance(result, str) else None

    def number(self, value, names: tuple[str, ...]):
        result = self.value(value, names)
        return result if isinstance(result, (int, float)) and not isinstance(result, bool) else None

    # Texts of the encoders behind a conditioning link, following inputs named after the role or "cond*".
    def texts(self, link, role: str, found: list, encoders: list, seen: set) -> None:
        node = self.node(link)
        if node is None or link[0] in seen or len(seen) > 256:
            return
        seen.add(link[0])
        inputs, kind = node["inputs"], node.get("class_type")
        if kind == "ConditioningZeroOut":
            found.append("")
            return
        name = next((name for name in ENCODER_TEXT_INPUTS if name in inputs), None) if "clip" in inputs else None
        if kind in ENCODERS or name:
            found.append(ENCODERS[kind](self, inputs) if kind in ENCODERS else self.text(inputs[name]))
            encoders.append(inputs)
            return
        links = [inputs[role]] if is_link(inputs.get(role)) else [value for key, value in inputs.items() if key.startswith("cond") and is_link(value)]
        for item in links:
            self.texts(item, role, found, encoders, seen)

    def prompt_text(self, link, role: str, encoders: list) -> str | None:
        found = []
        self.texts(link, role, found, encoders, set())
        if not found or None in found:
            return None
        return ", ".join(dict.fromkeys(text.strip() for text in found if text.strip()))

    def node_loras(self, node: dict | None) -> list:
        if node is None:
            return []
        inputs = node["inputs"]
        reader = LORA_NODES.get(node.get("class_type"))
        if reader:
            entries = reader(self, inputs)
        elif "lora_name" in inputs:
            entries = [(self.value(inputs["lora_name"], ("lora_name",)), self.number(inputs.get("strength_model", 1), ("strength_model",)))]
        else:
            # rgthree's Power Lora Loader keeps one {"on", "lora", "strength"} dict per row.
            entries = [(row.get("lora"), row.get("strength", 1)) for key, row in inputs.items()
                       if key.startswith("lora_") and isinstance(row, dict) and row.get("on", True) and "lora" in row]
        result = []
        for name, strength in entries:
            try:
                strength = float(strength)
            except (TypeError, ValueError):
                continue
            if isinstance(name, str) and name and name != "None" and strength:
                result.append((name, strength))
        return result

    # Walks the model input upstream through LoRA loaders to the checkpoint or diffusion model loader.
    def model_chain(self, link) -> tuple[tuple[str, str] | None, list]:
        loras, seen = [], set()
        while (node := self.node(link)) and link[0] not in seen:
            seen.add(link[0])
            inputs = node["inputs"]
            for name, folder in (("ckpt_name", "checkpoints"), ("unet_name", "diffusion_models")):
                if name in inputs:
                    model = self.value(inputs[name], (name,))
                    return ((model, folder) if isinstance(model, str) else None), loras
            loras[:0] = self.node_loras(node)
            link = inputs.get("model")
        return None, loras

    def clip_skip(self, link) -> int | None:
        seen = set()
        while (node := self.node(link)) and link[0] not in seen:
            seen.add(link[0])
            if node.get("class_type") == "CLIPSetLastLayer":
                layer = self.number(node["inputs"].get("stop_at_clip_layer"), ("stop_at_clip_layer",))
                return None if layer is None else abs(int(layer))
            link = node["inputs"].get("clip")
        return None

    def samplers(self, link) -> list[tuple[int, dict]]:
        queue, seen, found = deque([(link, 0)]), set(), []
        while queue:
            link, distance = queue.popleft()
            node = self.node(link)
            if node is None or link[0] in seen:
                continue
            seen.add(link[0])
            if node.get("class_type") in SAMPLER_NODES:
                found.append((distance, node))
            queue.extend((value, distance + 1) for value in node["inputs"].values() if is_link(value))
        return found

    def sampler_settings(self, node: dict) -> dict:
        inputs = node["inputs"]
        sources = [inputs] + [helper["inputs"] for name in SAMPLER_HELPERS if (helper := self.node(inputs.get(name)))]

        def field(*names, number=True):
            for source in sources:
                for name in names:
                    if name in source:
                        value = self.number(source[name], names) if number else self.value(source[name], names)
                        if value is not None:
                            return value
            return None

        def link(*names):
            return next((source[name] for source in sources for name in names if is_link(source.get(name))), None)

        steps = field("steps")
        denoise = field("denoise")
        start = field("start_at_step")
        if denoise is None and start and steps:
            denoise = max(0.0, 1 - start / steps)
        return {
            "seed": field("seed", "noise_seed"), "steps": steps, "cfg": field("cfg"), "denoise": denoise,
            "sampler": field("sampler_name", number=False), "scheduler": field("scheduler", number=False),
            "positive": link("positive", "conditioning"), "negative": link("negative"), "model": link("model"),
        }


def extract_generation(prompt: dict, node_id: str, categories: dict[str, int]) -> dict:
    graph = Graph(prompt, categories)
    own = graph.prompt.get(node_id)
    images = own.get("inputs", {}).get("images") if isinstance(own, dict) else None
    candidates = [(graph.sampler_settings(node), distance) for distance, node in graph.samplers(images)] if is_link(images) else []
    if not candidates:
        return {}
    # The base pass: the highest denoise, then the sampler furthest upstream (hires fix and detailers come later).
    settings = max(candidates, key=lambda item: (item[0]["denoise"] if item[0]["denoise"] is not None else 1.0, item[1]))[0]
    encoders = []
    result = {key: settings[key] for key in ("seed", "steps", "cfg", "sampler", "scheduler")}
    result["denoise"] = settings["denoise"] if settings["denoise"] is not None and settings["denoise"] < 1 else None
    result["prompt"] = graph.prompt_text(settings["positive"], "positive", encoders) if settings["positive"] else None
    result["negative_prompt"] = graph.prompt_text(settings["negative"], "negative", []) if settings["negative"] else None
    result["clip_skip"] = graph.clip_skip(encoders[0].get("clip")) if encoders else None
    result["checkpoint"], result["loras"] = graph.model_chain(settings["model"])
    return {key: value for key, value in result.items() if value is not None and value != []}


def model_stem(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return base[:-len(ext)] if (ext := os.path.splitext(base)[1].lower()) in MODEL_EXTENSIONS else base


def parse_lora_tags(text: str) -> list[tuple[str, float]]:
    result = []
    for name, strength in LORA_TAG.findall(text or ""):
        try:
            result.append((name.strip(), float(strength)))
        except ValueError:
            continue
    return result


def strip_lora_tags(text: str) -> str:
    text = LORA_TAG.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", re.sub(r"(,\s*){2,}", ", ", text)).strip(" ,\n")


def embedding_names(*texts: str) -> list[str]:
    return list(dict.fromkeys(name for text in texts for name in (match.group(1) for match in EMBEDDING.finditer(text or ""))))


def shorten_embeddings(text: str) -> str:
    return EMBEDDING.sub(lambda match: "embedding:" + model_stem(match.group(1)), text)


# Normalises LoRA Manager's <model>.metadata.json or a <model>.civitai.info into the fields the formats need.
def model_details(file_name: str, sha256: str, local: dict) -> dict:
    civitai = local.get("civitai") if isinstance(local.get("civitai"), dict) else local if "modelId" in local else {}
    model = civitai.get("model") if isinstance(civitai.get("model"), dict) else {}

    def number(value):
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    return {
        "file_name": file_name,
        "sha256": (sha256 or local.get("sha256") or "").lower(),
        "model_id": number(civitai.get("modelId") or model.get("id")),
        "version_id": number(civitai.get("id")),
        "model_name": model.get("name") or local.get("model_name") or file_name,
        "version_name": civitai.get("name") or "",
        "base_model": local.get("base_model") or civitai.get("baseModel") or "",
        "air": civitai.get("air") or "",
    }


def sampler_label(sampler, scheduler) -> str:
    name = CIVITAI_SAMPLERS.get(sampler, str(sampler))
    if scheduler in (None, "", "normal"):
        return name
    return f"{name} {CIVITAI_SCHEDULERS.get(scheduler, scheduler)}" if sampler in CIVITAI_SAMPLERS else f"{sampler}_{scheduler}"


def plain(value) -> str:
    # Values inside the comma separated parameter line: a comma or line break would cut the value short.
    return re.sub(r"\s*[,\n\r]+\s*", " ", str(value)).strip()


def number_text(value) -> str:
    return f"{value:g}" if isinstance(value, float) else str(value)


def civitai_resource(details: dict, kind: str, weight=None) -> dict | None:
    if details["version_id"] <= 0:
        return None
    resource = {"air": details["air"]} if details["air"] else {"type": kind, "modelVersionId": details["version_id"]}
    if weight is not None:
        resource["weight"] = weight
    if details["version_name"]:
        resource["versionName"] = details["version_name"]
    return resource


def format_parameters(gen: dict, checkpoint: dict | None, loras: list[dict], embeddings: list[dict], add_loras_to_prompt: bool, additional_data: str) -> str:
    prompt = gen.get("prompt", "")
    if add_loras_to_prompt and loras:
        tags = " ".join(f"<lora:{lora['file_name']}:{lora['strength']:g}>" for lora in loras)
        prompt = f"{prompt}\n{tags}" if prompt else tags
    lines = [prompt]
    if gen.get("negative_prompt"):
        lines.append(f"Negative prompt: {gen['negative_prompt']}")
    params = []
    if gen.get("steps") is not None:
        params.append(f"Steps: {gen['steps']}")
    if gen.get("sampler"):
        params.append(f"Sampler: {plain(sampler_label(gen['sampler'], gen.get('scheduler')))}")
    if gen.get("cfg") is not None:
        params.append(f"CFG scale: {number_text(gen['cfg'])}")
    if gen.get("seed") is not None:
        params.append(f"Seed: {gen['seed']}")
    if gen.get("width") and gen.get("height"):
        params.append(f"Size: {gen['width']}x{gen['height']}")
    if gen.get("clip_skip") is not None:
        params.append(f"Clip skip: {gen['clip_skip']}")
    if gen.get("denoise") is not None:
        params.append(f"Denoising strength: {gen['denoise']:g}")
    params.append("engine: ComfyUI")
    if additional_data.strip():
        params.append(" ".join(additional_data.split()))
    hashes, resources = {}, []
    if checkpoint:
        if checkpoint["sha256"]:
            params.append(f"Model hash: {checkpoint['sha256'][:10].upper()}")
            hashes["model"] = checkpoint["sha256"][:10].upper()
        params.append(f"Model: {plain(checkpoint['file_name'])}")
        resources.append(civitai_resource(checkpoint, "checkpoint"))
    for lora in loras:
        if lora["sha256"]:
            hashes[f"LORA:{lora['file_name']}"] = lora["sha256"][:10].upper()
        resources.append(civitai_resource(lora, "lora", lora["strength"]))
    for embedding in embeddings:
        resource = civitai_resource(embedding, "embedding")
        if resource is None and embedding["sha256"]:
            hashes[f"embed:{embedding['file_name']}"] = embedding["sha256"][:10].upper()
        resources.append(resource)
    if hashes:
        # The readers cut the Hashes JSON at the first "}".
        hashes = {re.sub(r"[{}]", "", key): value for key, value in hashes.items()}
        params.append(f"Hashes: {json.dumps(hashes, separators=(',', ':'))}")
    params.append("Version: ComfyUI")
    resources = [resource for resource in resources if resource]
    if resources:
        params.append(f"Civitai resources: {json.dumps(resources, separators=(',', ':'))}")
    lines.append(", ".join(params))
    return "\n".join(lines)


# The block LoRA Manager's recipe import reads first (its recipe_format parser).
def recipe_metadata(gen: dict, checkpoint: dict | None, loras: list[dict]) -> dict:
    keys = {"prompt": "prompt", "negative_prompt": "negative_prompt", "steps": "steps", "cfg": "cfg_scale", "seed": "seed", "clip_skip": "clip_skip", "denoise": "denoising_strength"}
    params = {target: gen[source] for source, target in keys.items() if gen.get(source) is not None}
    if gen.get("sampler"):
        params["sampler"] = sampler_label(gen["sampler"], gen.get("scheduler"))
    if gen.get("width") and gen.get("height"):
        params["size"] = f"{gen['width']}x{gen['height']}"
    bases = Counter(lora["base_model"] for lora in loras if lora["base_model"])
    recipe = {
        "title": "_".join(f"{lora['file_name']}-{lora['strength']:.2f}" for lora in loras[:3]) or (checkpoint["file_name"] if checkpoint else ""),
        "base_model": bases.most_common(1)[0][0] if bases else (checkpoint["base_model"] if checkpoint else ""),
        "loras": [{
            "file_name": lora["file_name"], "hash": lora["sha256"], "strength": float(lora["strength"]), "modelVersionId": lora["version_id"],
            "modelName": lora["model_name"], "modelVersionName": lora["version_name"],
        } for lora in loras],
        "gen_params": params,
        "tags": [],
    }
    if checkpoint:
        recipe["checkpoint"] = {
            "type": "checkpoint", "modelId": checkpoint["model_id"], "modelVersionId": checkpoint["version_id"],
            "name": checkpoint["model_name"], "version": checkpoint["version_name"],
            "modelName": checkpoint["model_name"], "modelVersionName": checkpoint["version_name"],
            "hash": checkpoint["sha256"], "file_name": checkpoint["file_name"], "baseModel": checkpoint["base_model"],
        }
    return recipe


def with_recipe(parameters: str, recipe: dict) -> str:
    # Last in the text and on one line: the reader matches "Recipe metadata: {" up to the final "}".
    return f"{parameters} \n Recipe metadata: {json.dumps(recipe)}"


TOKEN = re.compile(r"%(\w+)(?::([^%]*))?%")
DATE_PART = re.compile(r"yyyy|yy|MM|dd|hh|mm|ss")
DATE_CODES = {"yyyy": "%Y", "yy": "%y", "MM": "%m", "dd": "%d", "hh": "%H", "mm": "%M", "ss": "%S"}
CORE_DATE_TOKENS = {"year": "%Y", "month": "%m", "day": "%d", "hour": "%H", "minute": "%M", "second": "%S"}


def sanitize(text: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", " ".join(str(text).split()))
    return text.strip(" .")


def token_values(gen: dict) -> dict:
    checkpoint = gen.get("checkpoint")
    return {
        "seed": gen.get("seed"), "width": gen.get("width"), "height": gen.get("height"), "steps": gen.get("steps"),
        "cfg": number_text(gen["cfg"]) if gen.get("cfg") is not None else None, "sampler": gen.get("sampler"), "scheduler": gen.get("scheduler"),
        "model": model_stem(checkpoint[0]) if checkpoint else None, "pprompt": gen.get("prompt"), "nprompt": gen.get("negative_prompt"),
    }


# Fills in every token except %counter% and %batch_num%, which depend on the files already saved.
def expand_tokens(template: str, values: dict, now: datetime) -> str:
    def replace(match):
        key, argument = match.group(1), match.group(2)
        if key in ("date", "time"):
            pattern = argument or ("yyyy-MM-dd" if key == "date" else "hhmmss")
            return DATE_PART.sub(lambda part: now.strftime(DATE_CODES[part.group(0)]), pattern)
        if key in CORE_DATE_TOKENS and argument is None:
            return now.strftime(CORE_DATE_TOKENS[key])
        if key not in values:
            return match.group(0)
        text = sanitize(values[key] if values[key] is not None else "")
        return text[:int(argument)].strip() if argument and argument.isdigit() else text

    return TOKEN.sub(replace, template)


# Splits an expanded prefix into safe subfolder parts, the file name and the counter width.
def split_prefix(prefix: str, now: datetime) -> tuple[list[str], str, int]:
    digits = 5
    match = re.search(r"%counter(?::(\d+))?%", prefix)
    if match:
        digits = min(int(match.group(1) or 5), 12)
        prefix = prefix.replace(match.group(0), "%counter%")
    parts = prefix.replace("\\", "/").split("/")
    if prefix.startswith(("/", "\\")) or re.match(r"[A-Za-z]:", prefix) or any(part.strip() == ".." for part in parts):
        raise ValueError("filename_prefix must stay inside the output folder.")
    parts = [sanitize(part) for part in parts]
    name = parts.pop() or now.strftime("%Y%m%d-%H%M%S")
    return [part for part in parts if part], name, digits


def inside(root: str, path: str) -> bool:
    root, path = os.path.realpath(root), os.path.realpath(path)
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:
        return False


def output_folder(root: str, parts: list[str]) -> str:
    path = os.path.join(root, *parts)
    if not inside(root, path):
        raise ValueError("filename_prefix must stay inside the output folder.")
    os.makedirs(path, exist_ok=True)
    return path


def existing_stems(folder: str) -> set[str]:
    return {os.path.splitext(name)[0].lower() for name in os.listdir(folder)}


# File names for the images of one run. `indexes` are their batch numbers; `stems` the lower case names already in the folder.
def plan_names(name: str, indexes: list[int], extension: str, stems: set[str], counter: bool, overwrite: bool, digits: int = 5) -> list[str]:
    if counter or "%counter%" in name or (len(indexes) > 1 and "%batch_num%" not in name):
        template = name if "%counter%" in name else f"{name}_%counter%_"
        pattern = re.compile(re.escape(template.lower()).replace("%batch_num%", r"\d+").replace("%counter%", r"(\d+)"))
        start = max((int(found.group(1)) for stem in stems if (found := pattern.fullmatch(stem))), default=0) + 1
        return [template.replace("%batch_num%", str(index)).replace("%counter%", f"{start + offset:0{digits}d}") + extension
                for offset, index in enumerate(indexes)]
    names, taken = [], set(stems)
    for index in indexes:
        stem = candidate = name.replace("%batch_num%", str(index))
        suffix = 0
        while not overwrite and candidate.lower() in taken:
            suffix += 1
            candidate = f"{stem}_{suffix:04d}"
        taken.add(candidate.lower())
        names.append(candidate + extension)
    return names


def write_sidecars(folder: str, stem: str, caption: str | None, workflow) -> None:
    if caption is not None:
        with open(os.path.join(folder, stem + ".txt"), "w", encoding="utf-8") as file:
            file.write(caption)
    if workflow is not None:
        with open(os.path.join(folder, stem + ".json"), "w", encoding="utf-8") as file:
            json.dump(workflow, file, ensure_ascii=False, indent=2)


TEMP_PREFIX = "MooBoxSave_"
TEMP_NAME = re.compile(TEMP_PREFIX + r"[0-9a-f]{12}_\d{5}\.(png|jpg|webp)")
MANIFEST = ".export.json"


# Copies the temp previews of one Save Image run to the output folder, named as a normal save of that run would be.
def export_previews(temp_dir: str, output_dir: str, images) -> list[dict]:
    if not isinstance(images, list) or not images:
        raise ValueError("Nothing to save.")
    jobs = []
    for image in images:
        image = image if isinstance(image, dict) else {}
        filename = image.get("filename")
        if image.get("type") != "temp" or image.get("subfolder", "") != "" or not isinstance(filename, str) or not TEMP_NAME.fullmatch(filename):
            raise ValueError("Only the temp previews of MooBox Save Image can be saved.")
        path = os.path.join(temp_dir, filename)
        try:
            with open(path + MANIFEST, encoding="utf-8") as file:
                manifest = json.load(file)
        except FileNotFoundError:
            manifest = None
        if manifest is None or not os.path.isfile(path):
            raise FileNotFoundError("The preview is gone, probably because ComfyUI restarted. Run the workflow again.")
        jobs.append((path, manifest))
    first = jobs[0][1]
    if any(manifest["run"] != first["run"] for _, manifest in jobs):
        raise ValueError("Save the images of one run at a time.")
    folder = output_folder(output_dir, first["folder"])
    extension = os.path.splitext(jobs[0][0])[1]
    names = plan_names(first["name"], [manifest["index"] for _, manifest in jobs], extension, existing_stems(folder), first["counter"], first["overwrite"], first["digits"])
    saved = []
    for (path, manifest), name in zip(jobs, names):
        try:
            with open(path, "rb") as source, open(os.path.join(folder, name), "wb" if first["overwrite"] else "xb") as target:
                target.write(source.read())
        except FileExistsError as error:
            raise FileExistsError(f"{name} already exists; nothing was overwritten.") from error
        write_sidecars(folder, os.path.splitext(name)[0], manifest["caption"], manifest["workflow"])
        saved.append({"filename": name, "subfolder": os.path.join(*first["folder"]) if first["folder"] else "", "type": "output"})
    return saved
