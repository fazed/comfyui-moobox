from __future__ import annotations

import json
import math
import re


def split_words(text: str, groups: bool = False) -> list[str]:
    result = []
    current = []
    depth = 0
    escaped = False
    index = 0
    while index < len(text):
        char = text[index]
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            current.append(char)
            escaped = True
        elif char == "(":
            depth += 1
            current.append(char)
        elif char == ")":
            depth = max(0, depth - 1)
            current.append(char)
        elif char == "," and depth == 0 and (not groups or text[index:index + 2] == ",,"):
            value = "".join(current).strip()
            if value:
                result.append(value)
            current = []
            while index + 1 < len(text) and text[index + 1] == ",":
                index += 1
        else:
            current.append(char)
        index += 1
    value = "".join(current).strip()
    if value:
        result.append(value)
    return result


def read_state(value: str | dict | list) -> dict | list:
    return json.loads(value) if isinstance(value, str) else value


def filter_words(source: str, selection: str | dict, default_active: bool) -> str:
    state = read_state(selection)
    saved = {}
    for group in state.get("groups", []):
        saved.setdefault(group["text"], []).append(group)
    output = []
    for text in split_words(source, groups=True):
        queue = saved.get(text, [])
        group = queue.pop(0) if queue else {"active": default_active, "items": [], "strength": 1}
        if not group.get("active", True):
            continue
        items = {}
        for item in group.get("items", []):
            items.setdefault(item["text"], []).append(item)
        active_words = []
        for word in split_words(text):
            queue = items.get(word, [])
            item = queue.pop(0) if queue else {"active": True}
            if item.get("active", True):
                strength = item.get("strength")
                active_words.append(word if strength is None or float(strength) == 1 else f"({word}:{float(strength):g})")
        if active_words:
            text = ", ".join(active_words)
            strength = float(group.get("strength", 1))
            output.append(text if strength == 1 else f"({text}:{strength:g})")
    return ", ".join(output)


def format_tags(text: str) -> str:
    seen = set()
    tags = []
    for tag in split_words(text.replace("\r", "").replace("\n", ",")):
        tag = " ".join(tag.split())
        if tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    return ", ".join(tags)


def join_prompt(first: str, second: str) -> str:
    parts = [part.strip() for part in (first, second) if part.strip()]
    if len(parts) == 2:
        return parts[0] + (" " if parts[0][-1] in ".!?" else ", ") + parts[1]
    return "".join(parts)


QUALITY_TAGS = {
    "masterpiece", "best_quality", "amazing_quality", "great_quality", "good_quality", "normal_quality", "low_quality", "worst_quality",
    "very_aesthetic", "aesthetic", "displeasing", "very_displeasing", "absurdres", "highres", "newest", "recent", "mid", "early", "old", "oldest",
    "general", "safe", "sensitive", "questionable", "nsfw", "explicit",
}
COUNT_TAG = re.compile(r"\d+\+?(girls?|boys?|others?)|solo|no_humans|multiple_(girls|boys|others)")
YEAR_TAG = re.compile(r"year_\d{4}")
# Danbooru category ids from the tag list: 0 general, 1 artist, 3 copyright, 4 character, 5 meta.
CATEGORY_BUCKET = {1: 4, 3: 3, 4: 2, 5: 6}


def tag_key(tag: str) -> str:
    match = re.fullmatch(r"\(+(.*?)(?::[\d.]+)?\)+", tag)
    inner = match.group(1) if match else tag
    return inner.replace("\\(", "(").replace("\\)", ")").strip().casefold().replace(" ", "_")


def read_categories(text: str) -> dict[str, int]:
    categories = {}
    for line in text.splitlines():
        fields = line.split(",", 3)
        if len(fields) >= 3 and fields[1].strip().isdigit():
            categories[fields[0].strip().casefold()] = int(fields[1])
    return categories


def order_illustrious(text: str, categories: dict[str, int], quality_first: bool = True) -> str:
    def bucket(tag: str) -> int:
        key = tag_key(tag)
        if key in QUALITY_TAGS or YEAR_TAG.fullmatch(key):
            return 0 if quality_first else 8
        if COUNT_TAG.fullmatch(key):
            return 1
        return CATEGORY_BUCKET.get(categories[key], 5) if key in categories else 7

    return ", ".join(sorted(split_words(format_tags(text)), key=bucket))


# Checked in order: the specific layouts first, then the shared SD/SDXL UNet names.
LORA_FAMILY_KEYS = (
    ("Krea 2", re.compile(r"diffusion_model\.blocks\.\d+\.attn\.wq\.lora_A\.weight$"), 6144),
    ("MOSS", re.compile(r"lora_unet_layers_\d+_proj_q\.lora_down\.weight$"), 3072),
    ("Anima", re.compile(r"lora_unet_blocks_\d+_(self|cross)_attn_q_proj\.lora_down\.weight$"), 2048),
)
SD_UNET_PARTS = ("lora_unet_input_blocks", "lora_unet_middle_block", "lora_unet_output_blocks", "lora_unet_down_blocks", "lora_unet_up_blocks", "lora_unet_mid_block")


def lora_family(header: dict) -> str:
    for family, pattern, width in LORA_FAMILY_KEYS:
        for key, value in header.items():
            shape = value.get("shape") if isinstance(value, dict) else None
            if pattern.search(key) and isinstance(shape, list) and len(shape) > 1 and shape[1] == width:
                return family
    if any(part in key for key in header for part in SD_UNET_PARTS):
        return "SDXL"
    return "Unknown"


def resolution_label(width: int, height: int) -> str:
    shape = "Square" if width == height else "Portrait" if width < height else "Landscape"
    divisor = math.gcd(width, height)
    return f"{shape} {width} x {height} ({width // divisor}:{height // divisor})"


ILLUSTRIOUS_RESOLUTIONS = {
    resolution_label(width, height): (width, height)
    for width, height in ((1024, 1024), (832, 1216), (896, 1152), (768, 1344), (1216, 832), (1152, 896), (1344, 768))
}
