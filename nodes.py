from __future__ import annotations

import json
import os
import random

import folder_paths
import nodes
from comfy_api.latest import io

from .logic import ILLUSTRIOUS_RESOLUTIONS, filter_words, format_tags, join_prompt, order_illustrious, read_categories, read_state

TAGS_FILE = os.path.join(folder_paths.get_user_directory(), "moobox", "tags.csv")
_categories = (None, {})
# Default for optional lazy inputs: tells "not connected" apart from None ("connected, not yet evaluated").
_MISSING = object()


def tag_categories() -> dict[str, int]:
    global _categories
    mtime = os.path.getmtime(TAGS_FILE) if os.path.isfile(TAGS_FILE) else None
    if _categories[0] != mtime:
        text = ""
        if mtime is not None:
            with open(TAGS_FILE, encoding="utf-8") as file:
                text = file.read()
        _categories = (mtime, read_categories(text))
    return _categories[1]


def resolve_lora(name: str) -> str:
    if name.startswith(("/", "\\")) or os.path.isabs(name) or os.path.splitdrive(name)[0] or ".." in name.replace("\\", "/").split("/"):
        raise ValueError("Choose a LoRA from ComfyUI's configured LoRA folders.")
    return folder_paths.get_full_path_or_raise("loras", name)


class MooBoxLoraLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxLoraLoader",
            display_name="LoRA Loader (MooBox)",
            category="MooBox/LoRA",
            inputs=[
                io.Model.Input("model"),
                io.String.Input("loras", default="[]", extra_dict={"widgetType": "MOOBOX_LORAS"}),
                io.Clip.Input("clip", optional=True),
                io.Combo.Input("loader", options=["ComfyUI", "LoRA Manager"], default="ComfyUI", advanced=True),
                io.Combo.Input("family", options=["Any", "SDXL", "Anima", "Krea 2", "MOSS", "Unknown"], default="Any", optional=True, socketless=True,
                               tooltip="Only show LoRAs of this model family in the search, read from the file header. SDXL also covers Illustrious, NoobAI, Pony and SD 1.5. Unknown lists files that match no family. Search filter only; added LoRAs are kept."),
            ],
            outputs=[io.Model.Output("MODEL"), io.Clip.Output("CLIP"), io.String.Output("trigger_words"), io.String.Output("loaded_loras")],
        )

    @classmethod
    def execute(cls, model, loras, clip=None, loader="ComfyUI", family="Any"):
        if loader not in ("ComfyUI", "LoRA Manager"):
            raise ValueError("Unknown LoRA loader.")
        entries = read_state(loras)
        if loader == "LoRA Manager":
            manager = nodes.NODE_CLASS_MAPPINGS.get("Lora Loader (LoraManager)")
            if manager is None:
                raise RuntimeError("LoRA Manager is unavailable. Install it or choose the ComfyUI loader.")
            instance = manager()
            result = getattr(instance, instance.FUNCTION)(model=model, text="", loras=entries, clip=clip)
            return io.NodeOutput(*result, ui={"trigger_words": [result[2]]})

        native = nodes.LoraLoader()
        loaded = []
        words = []
        for entry in entries:
            if not entry.get("active", True):
                continue
            name = entry["name"]
            resolve_lora(name)
            strength = float(entry.get("strength", 1))
            clip_strength = float(entry.get("clipStrength", strength))
            model, clip = native.load_lora(model, clip, name, strength, clip_strength)
            loaded.append(f"<lora:{name}:{strength:g}:{clip_strength:g}>")
            words.extend(entry.get("words", []))
        message = ",, ".join(words)
        return io.NodeOutput(model, clip, message, " ".join(loaded), ui={"trigger_words": [message]})


class MooBoxTriggerWords(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxTriggerWords",
            display_name="Trigger Words (MooBox)",
            category="MooBox/LoRA",
            inputs=[
                io.String.Input("selection", default='{"source":"","groups":[]}', extra_dict={"widgetType": "MOOBOX_TRIGGERS"}),
                io.Boolean.Input("default_active", default=False, tooltip="Initial state of new groups. Existing selections are kept."),
                io.String.Input("trigger_words", optional=True, force_input=True),
            ],
            outputs=[io.String.Output("filtered_trigger_words")],
        )

    @classmethod
    def execute(cls, selection, default_active=False, trigger_words=None):
        state = read_state(selection)
        source = state.get("source", "") if trigger_words is None else trigger_words
        return io.NodeOutput(filter_words(source, state, default_active), ui={"source": [source]})


class MooBoxTagPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxTagPrompt",
            display_name="Tag Prompt (MooBox)",
            category="MooBox/Prompt",
            inputs=[io.String.Input("tags", default="", extra_dict={"widgetType": "MOOBOX_TAGS"})],
            outputs=[io.String.Output("tags")],
        )

    @classmethod
    def execute(cls, tags):
        return io.NodeOutput(format_tags(tags))


class MooBoxTagTextPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxTagTextPrompt",
            display_name="Tag + Text Prompt (MooBox)",
            category="MooBox/Prompt",
            inputs=[
                io.String.Input("tags", default="", extra_dict={"widgetType": "MOOBOX_TAGS"}),
                io.String.Input("natural_text", default="", multiline=True),
                io.Combo.Input("order", options=["tags first", "text first"]),
            ],
            outputs=[io.String.Output("prompt"), io.String.Output("tags"), io.String.Output("natural_language")],
        )

    @classmethod
    def execute(cls, tags, natural_text, order):
        parts = (format_tags(tags), natural_text.strip())
        return io.NodeOutput(join_prompt(*(parts if order == "tags first" else parts[::-1])), *parts)


MAX_SEEDS = 16
MAX_RANDOM = 2 ** 50


class MooBoxSeeds(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxSeeds",
            display_name="Seeds (MooBox)",
            category="MooBox/Utility",
            inputs=[io.String.Input("seeds", default="[-1]", socketless=True, extra_dict={"widgetType": "MOOBOX_SEEDS"})],
            outputs=[io.Int.Output(f"seed_{i}") for i in range(1, MAX_SEEDS + 1)],
        )

    # The editor replaces -1 when queueing; API prompts that still hold -1 get a new random seed on every run.
    @classmethod
    def fingerprint_inputs(cls, seeds):
        return float("nan") if -1 in json.loads(seeds) else seeds

    @classmethod
    def execute(cls, seeds):
        values = [random.randrange(MAX_RANDOM) if seed == -1 else seed for seed in map(int, json.loads(seeds))]
        if not 1 <= len(values) <= MAX_SEEDS:
            raise ValueError(f"Use 1 to {MAX_SEEDS} seeds.")
        return io.NodeOutput(*values, *[0] * (MAX_SEEDS - len(values)))


class MooBoxIllustriousTags(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxIllustriousTags",
            display_name="Illustrious Tags (MooBox)",
            category="MooBox/Prompt",
            inputs=[
                io.String.Input("tags", default="", extra_dict={"widgetType": "MOOBOX_TAGS"}),
                io.Combo.Input("quality_tags", options=["front", "end"], tooltip="Where quality, year and rating tags go. The rest is ordered: count, character, series, artist, general, meta, then tags missing from the tag list (such as LoRA trigger words)."),
                io.String.Input("trigger_words", optional=True, force_input=True),
            ],
            outputs=[io.String.Output("tags")],
        )

    @classmethod
    def execute(cls, tags, quality_tags, trigger_words=None):
        return io.NodeOutput(order_illustrious(join_prompt(tags, trigger_words or ""), tag_categories(), quality_tags == "front"))


class MooBoxGroupsToggle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxGroupsToggle",
            display_name="Groups Toggle (MooBox)",
            category="MooBox/Utility",
            description="One switch per group to bypass or mute all nodes in it. Frontend only; never runs.",
            inputs=[
                io.Combo.Input("action", options=["bypass", "mute"], tooltip="What switching a group off does to its nodes."),
                io.String.Input("match_title", default="", tooltip="Only show groups whose title matches this text or regular expression."),
                io.String.Input("match_colors", default="", tooltip="Only show groups with these colors: ComfyUI color names or hex values, comma separated."),
                io.Combo.Input("sort", options=["position", "alphanumeric"]),
                io.Boolean.Input("root_graph", display_name="root graph", default=True, tooltip="On: list the groups of the graph this node is in. Off: list the groups inside subgraphs instead and choose one below."),
                io.Combo.Input("match_subgraph", display_name="subgraph", options=["(all)"], tooltip="Only list the groups of this subgraph and the subgraphs inside it. The list is filled in by the editor."),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, action, match_title, match_colors, sort, root_graph, match_subgraph):
        return io.NodeOutput()


# Fixed IMAGE types: core's ComfySwitchNode resolves its "*" types on queue, which changes the saved workflow after every run.
class MooBoxImageSwitch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxImageSwitch",
            display_name="Image Switch (MooBox)",
            category="MooBox/Utility",
            description="Passes on_true or on_false through. Only the selected branch runs.",
            inputs=[
                io.Boolean.Input("switch", default=False),
                io.Image.Input("on_false", lazy=True, optional=True),
                io.Image.Input("on_true", lazy=True, optional=True),
            ],
            outputs=[io.Image.Output()],
        )

    # ComfyUI passes None for a connected but not yet evaluated lazy input and leaves out an
    # unconnected one, so _MISSING means "not connected". Requesting an unconnected input fails the prompt.
    @classmethod
    def check_lazy_status(cls, switch, on_false=_MISSING, on_true=_MISSING):
        name, value = ("on_true", on_true) if switch else ("on_false", on_false)
        if value is None:
            return [name]
        return None

    @classmethod
    def execute(cls, switch, on_false=_MISSING, on_true=_MISSING):
        name, value = ("on_true", on_true) if switch else ("on_false", on_false)
        if value is _MISSING:
            raise ValueError(f"Image Switch: switch is {'on' if switch else 'off'} but {name} is not connected.")
        return io.NodeOutput(value)


class MooBoxIllustriousResolution(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MooBoxIllustriousResolution",
            display_name="Illustrious Resolution (MooBox)",
            category="MooBox/Utility",
            inputs=[io.Combo.Input("resolution", options=list(ILLUSTRIOUS_RESOLUTIONS), default="Portrait 832 x 1216 (13:19)")],
            outputs=[io.Int.Output("width"), io.Int.Output("height")],
        )

    @classmethod
    def execute(cls, resolution):
        return io.NodeOutput(*ILLUSTRIOUS_RESOLUTIONS[resolution])
