from __future__ import annotations

import argparse
import copy
import json
import re
from collections import defaultdict, deque
from pathlib import Path

from logic import split_words


GROUP_NODES = {"Fast Groups Bypasser (rgthree)": "bypass", "Fast Groups Muter (rgthree)": "mute"}


def unweight(text: str) -> tuple[str, float]:
    match = re.fullmatch(r"\((.+):(-?[\d.]+)\)", text.strip())
    return (match[1], float(match[2])) if match else (text, 1)


def convert_workflow(workflow: dict) -> tuple[dict, int]:
    result = copy.deepcopy(workflow)
    count = 0

    def convert(graph):
        nonlocal count
        for node in graph.get("nodes", []):
            kind = node.get("type")
            if kind in GROUP_NODES and not any(output.get("links") for output in node.get("outputs", [])):
                properties = node.setdefault("properties", {})
                sort = properties.get("sort")
                node["type"] = "MooBoxGroupsToggle"
                node["inputs"] = []
                node["outputs"] = []
                node["widgets_values"] = [GROUP_NODES[kind], properties.get("matchTitle", ""), properties.get("matchColors", ""), "alphanumeric" if sort == "alphanumeric" else "position", properties.get("showAllGraphs", True), "(all)"]
                node["properties"] = {"Node name for S&R": node["type"]}
                count += 1
                continue
            if kind not in ("Lora Loader (LoraManager)", "TriggerWord Toggle (LoraManager)"):
                continue
            values = node.get("widgets_values", [])
            names = node.get("properties", {}).get("__lm_widget_ids", [])
            named = dict(zip(names, values))
            named.update(node.get("widgets_values_named", {}))
            if kind == "Lora Loader (LoraManager)":
                if any(item.get("name") == "text" and item.get("link") is not None for item in node.get("inputs", [])):
                    raise ValueError("A LoRA Loader has a linked text input; convert that node manually.")
                entries = named.get("loras")
                if entries is None:
                    entries = next((value for value in reversed(values) if isinstance(value, list)), [])
                if isinstance(entries, str):
                    entries = json.loads(entries)
                node["type"] = "MooBoxLoraLoader"
                node["widgets_values"] = [json.dumps(entries), "LoRA Manager"]
                node["widgets_values_named"] = {"loras": json.dumps(entries), "loader": "LoRA Manager"}
            else:
                group_mode = named.get("group_mode", values[0] if values else True)
                default_active = named.get("default_active", values[1] if len(values) > 1 else True)
                tags = named.get("toggle_trigger_words", values[3] if len(values) > 3 else [])
                source = named.get("orinalMessage", values[4] if len(values) > 4 else "")
                if isinstance(tags, str):
                    tags = json.loads(tags)
                if not source:
                    source = ",, ".join(unweight(tag["text"])[0] for tag in tags)
                if group_mode:
                    groups = []
                    for tag in tags:
                        text, strength = unweight(tag["text"])
                        groups.append({"text": text, "active": tag.get("active", True), "strength": tag.get("strength") if tag.get("strength") is not None else strength,
                                       "items": tag.get("items", [{"text": word, "active": True} for word in split_words(text)]), "present": True})
                else:
                    states = defaultdict(deque)
                    for tag in tags:
                        text, strength = unweight(tag["text"])
                        states[text].append({**tag, "text": text, "strength": tag.get("strength") if tag.get("strength") is not None else strength})
                    groups = []
                    for text in split_words(source, groups=True):
                        items = [states[word].popleft() if states[word] else {"text": word, "active": default_active} for word in split_words(text)]
                        groups.append({"text": text, "active": True, "strength": 1, "items": items, "present": True})
                state = json.dumps({"source": source, "groups": groups})
                node["type"] = "MooBoxTriggerWords"
                node["widgets_values"] = [state, default_active]
                node["widgets_values_named"] = {"selection": state, "default_active": default_active}
            properties = node.setdefault("properties", {})
            for key in ("__lm_widget_ids", "cnr_id", "aux_id", "ver"):
                properties.pop(key, None)
            properties["Node name for S&R"] = node["type"]
            count += 1
        subgraphs = graph.get("definitions", {}).get("subgraphs", [])
        for subgraph in subgraphs.values() if isinstance(subgraphs, dict) else subgraphs:
            convert(subgraph)

    convert(result)
    return result, count


def main():
    parser = argparse.ArgumentParser(description="Make a separate MooBox copy of an exported ComfyUI workflow.")
    parser.add_argument("workflow", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.workflow.with_name(args.workflow.stem + "-moobox.json")
    converted, count = convert_workflow(json.loads(args.workflow.read_text(encoding="utf-8-sig")))
    with output.open("x", encoding="utf-8") as handle:
        json.dump(converted, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"Converted {count} nodes: {output}")
    left = sorted({match for match in re.findall(r'"type": "([^"]*\(rgthree\))"', output.read_text(encoding="utf-8"))})
    if left:
        print("Still rgthree (no MooBox replacement): " + ", ".join(left))


if __name__ == "__main__":
    main()
