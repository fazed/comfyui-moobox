from __future__ import annotations

import json
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
