# Node ideas

Backlog of nodes to build later. Each idea is self-contained: an agent or contributor can pick one up without any other context.

## Before you start

- Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) first. They hold the design rules and the steps to add a node.
- Use V3 schemas, keep node IDs and widget names stable, and make no internet requests.
- Reuse native ComfyUI nodes where possible. Add a new node only where the idea below says so.
- Put pure logic in `logic.py` with tests in `tests/test_logic.py`. Add node tests to `tests/test_nodes.py`. Describe the node in `README.md`.
- Category for prompt nodes: `MooBox/Prompt`. Other nodes: `MooBox/Utility`.

## Source of the ideas

Inspired by the feature list (README only) of [ComfyUI-EasyIllustrious](https://github.com/regiellis/ComfyUI-EasyIllustrious) by regiellis (MIT, beta, 93 stars, last commit April 2026). Only the README was read (the sections on nodes, smart scene options, configuration, troubleshooting and regional prompting). Its source code was not read, and its claims are unverified. Implement every idea independently from the descriptions below. Do not copy code from that repository.

## 1. Negative presets

Extend or accompany `MooBoxIllustriousTags` (`nodes.py`, `order_illustrious` in `logic.py`). Today it only orders positive tags.

- New node **Negative Prompt (MooBox)**, category `MooBox/Prompt`.
- Inputs: `preset` combo (`standard`, `anime_clean`, `aggressive`, `photoreal`, `custom`), `custom` multiline string (used when preset is `custom`, appended otherwise), optional `extra` string (`force_input`).
- Output: one formatted tag string (reuse `format_tags` / `join_prompt` from `logic.py` so duplicates are removed).
- Keep the preset tag lists as plain constants in `logic.py`. Keep them short and editable.
- Tests: each preset returns its tags, `custom` is appended, duplicates are collapsed, empty input gives an empty string.

## 2. Quality block with weighting

Extend the existing `quality_tags` handling in `order_illustrious`.

- Add optional inputs to `MooBoxIllustriousTags`: `quality_weight` (default 1.0, which changes nothing, so existing workflows stay compatible) and `weight_style` combo (`auto`, `grouped`, `per token`).
- Reference behavior: `grouped` gives `(masterpiece, best quality, highres:1.2)`, `per token` gives `(masterpiece:1.2), (best quality:1.2), (highres:1.2)`, and `auto` uses grouped for 4 tokens or fewer and per token otherwise.
- Check how `format_tags` already treats bracket groups so the output is not split apart.
- Tests: weight 1.0 equals current output, each style produces the strings above, front/end placement still works.

## 3. Token budget

- New node **Token Budget (MooBox)**, category `MooBox/Prompt`.
- Inputs: `tags` string (`force_input`), `max_tokens` int (default 75, min 1), `mode` combo (`truncate`, `report only`).
- Behavior: count tokens approximately per comma-separated tag (document the approximation, for example words plus punctuation). When over budget in `truncate` mode, drop tags from the end but never drop quality/count tags (use the same grouping as `order_illustrious`).
- Outputs: `tags` (the result) and `report` (which tags were dropped, as a short string).
- Optional `exact_count` behavior from the reference: enforce exactly N comma-separated tags by truncating the overflow. Padding with filler tags is optional and off by default, because padding changes the image.
- Do not load a tokenizer or any model. This is a cheap estimate. Make the limitation clear in the tooltip.

## 4. Regional prompt list

Native ComfyUI nodes already do the masking and conditioning, so only add a node if it reduces wiring. Check what exists first (`ConditioningSetMask`, `ConditioningCombine`).

- Candidate node **Regions (MooBox)**: an `io.Autogrow` of region entries, each with `mask`, `conditioning`, `strength`, and start/end percent, producing one combined `CONDITIONING`. Use `ConditioningSetMask` and `ConditioningSetTimestepRange` internally.
- Skip this idea if the native nodes already give a comparable result in three nodes or fewer.

## 5. Sampler presets

- Card for a small node or a documented settings table, not a new sampler. Native `KSampler` stays the sampler.
- Candidate node **Sampler Preset (MooBox)**: a combo of presets that outputs `steps` (int), `cfg` (float), `sampler_name`, `scheduler`, and `width`/`height`, so one node feeds an existing `KSampler` and `EmptyLatentImage`.
- Suggested Illustrious/SDXL defaults to start from (unverified, tune by testing): CFG 4.0 to 6.5 (about 5.0), steps 24 to 28 (30+ at high resolution), sampler `euler_ancestral` or `dpmpp_2m` with scheduler `karras`, resolutions 832x1216, 1216x832, 1344x768 and 1024x1024.
- Extra tip from the reference: soft or foggy images call for CFG 5.5 to 6.5 and 28 to 35 steps. Oversaturated images call for CFG 4.0 to 4.5 and the `karras` scheduler at high resolution.
- Outputs must use the native types (`COMBO` values from `comfy.samplers`) so they connect to `KSampler` without conversion.

## Not worth building

- Character/artist databases (the tag autocomplete with `user/moobox/tags.csv` covers this), Pony tokens, color correction, outpaint, custom CLIP encoders, custom VAE nodes. Native ComfyUI nodes are enough.
- The reference's own inpaint mode in its VAE Encode node. ComfyUI's native inpaint nodes cover it.
- The reference's "Dynamic Thresholding" setting is mentioned without detail. Check for a separate extension before building anything.
- The reference README mentions network access for database updates. This pack must not do that.
