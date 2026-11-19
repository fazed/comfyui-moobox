# MooBox

A custom ComfyUI node pack with a searchable LoRA loader, stable trigger word selections,
tag autocomplete for prompts, an image comparer, a multi-seed node and a jobs monitor.
Updating LoRA Manager never replaces files in this folder, and LoRA Manager is optional.

## Installation

Windows (PowerShell):

```powershell
cd ComfyUI\custom_nodes
git clone https://github.com/fazed/comfyui-moobox
```

Linux and macOS:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/fazed/comfyui-moobox
```

Restart ComfyUI afterwards. No extra packages or build step are needed.

## Nodes

### MooBox / LoRA

- **LoRA Loader (MooBox)**: type a name, click a result or press Enter.
  Cards show the file name and folder, with clear on/off switches;
  × removes a LoRA. The labelled Model and CLIP strengths can be tied together with **Linked**.
  Existing different strengths are left unchanged when a workflow loads.
  **↗ Manager** opens the selected LoRA in a separate browser tab or window.
  If several files share a name, you can pick the right folder.
- **Trigger Words (MooBox)**: connect the loader's `trigger_words`. Toggle whole groups
  or single words and adjust the group weight if you like.
  Groups that temporarily disappear keep their selection when they come back;
  **Forget N absent** removes those saved selections.
  When the connected loader is bypassed or muted, no trigger words are output.
  The source input is collapsible; active counts stay visible.
- **Image Compare (MooBox)**: connect two or more images (a new input appears
  automatically). Use the A and B dropdowns to choose which two to compare
  (⇄ swaps them; the first two connected are the default) and pick a mode:
  **A/B**, **Slider**, **Blend**, **Difference** or **Blink**
  (ⓘ explains the chosen mode). Run the workflow to compare. The results are not stored
  in the workflow: reloading it (also undo) shows them again only after the next run.

### MooBox / Utility

- **Seeds (MooBox)**: manage up to 16 seeds, each with its own `seed_N` output
  (always at least one). Every row has:
  - a seed field. The icon inside it opens a menu with what happens after a run:
    **Fixed**, **Increment**, **Decrement** or **Randomize**;
  - **🔁** random each time (`-1`);
  - **✨** pick a new random seed once and keep it;
  - **♻** use the last used seed (hover to see the value);
  - **×** remove the row.

  The **All seeds** box above the rows applies 🔁, ✨ or ♻ to every row at once.
  `-1` is replaced when the workflow is queued, so image metadata contains the real seed
  (also for Seeds nodes inside subgraphs). Only `-1` means random; other negative values are refused.
  Seeds advance only after ComfyUI accepted the prompt. A prompt sent through the API that
  still holds `-1` gets a new random seed from the server on every run.

- **Groups Toggle (MooBox)**: one switch per group in the workflow. Switching a group off
  bypasses (or mutes, via `action`) its active nodes; switching it on makes the nodes in that mode
  active again, so a node muted inside a bypass group stays muted. A node you bypassed by hand inside
  a bypass group cannot be told apart and is switched on as well.
  `match_title` (a case-insensitive substring or regular expression) and `match_colors` (ComfyUI color names or hex,
  comma separated) limit the list, `sort` is by position or alphanumeric, → jumps to the group.
  `root graph` (default on) lists the groups of the graph the node is in. Switched off, it lists the groups
  inside subgraphs instead, with the subgraph name above them, so a detailer group can be switched from
  the root view; the `subgraph` list (filled in by the editor) limits that to one subgraph and the
  subgraphs inside it. A subgraph used by several nodes is one shared definition, so switching its
  groups affects every copy.
  A group counts as on while at least one of its nodes is active. The node itself never runs
  and is never toggled by its own group.

- **Image Switch (MooBox)**: outputs `on_true` or `on_false` depending on `switch`. Only the
  selected branch runs, and the other branch need not be connected; if the selected branch is not
  connected, the run stops with a clear error naming that input. Unlike the core If/Else Switch its types are fixed to IMAGE, so running
  the workflow does not change the saved workflow.

- **Preview Images (MooBox)**: connect one or more images (a new input appears automatically);
  every image of every input, batches included, is shown in the node one at a time in input order.
  The arrow buttons step through them and wrap around at the ends; the counter shows the position.
  A new run starts at the first image again. Like Image Compare, the previews are not stored in the
  workflow and only show again after the next run.
  Switch on **add to assets** to also add the images to the assets panel; in the classic view
  they then also show as ComfyUI's own preview.

### MooBox / Prompt

Type in a text field of a node (Nodes 2.0 and classic) and suggestions from your
tag list appear, sorted by popularity; aliases are found too. ↑/↓ selects, Tab or Enter
inserts, Esc closes. Not active inside `<lora:...>`. Settings are under
**Settings → MooBox → Tag autocomplete**: on/off, minimum characters, number of
suggestions, spaces instead of underscores (default on; `score_` tags and `^_^` keep
their underscore), escaping `( )` and a trailing comma after the tag.
The tag list is loaded the first time you type in such a field, not on page load.

- **Tag Prompt (MooBox)**: type in the input field at the top, pick a suggestion
  (or press Enter for your own text) and the tag is added. The text field below stays
  freely editable and formats itself when you leave it: comma + space, no double spaces,
  empty tags and duplicate tags removed. The output is the same formatted text;
  bracket groups such as `(a, b:1.2)` stay intact.
- **Tag + Text Prompt (MooBox)**: same tag input plus a `natural_text` input (without
  autocomplete) and an `order` choice: *tags first* or *text first*. Outputs: `prompt`
  (combined), `tags` and `natural_language`. The parts are joined with `, `, or with a
  space if the first part ends in `.`, `!` or `?`.
- **Illustrious Tags (MooBox)**: puts tags in a fixed order: quality/year/rating,
  count (`1girl`, `solo`), character, series, artist, general, meta. Your order is kept
  within a group; `quality_tags` chooses *front* or *end*. Character/series/artist/meta
  come from the `type` column of the loaded tag list (a1111 format); without that list,
  unknown tags (such as LoRA trigger words) go last, before the quality tags if those
  are at the end. The optional `trigger_words` input is sorted along.

### Jobs

A **Jobs** tab in the sidebar and a thin progress line at the top of the window and/or under
the Jobs sidebar icon (**Settings → MooBox → Jobs → Progress bar position**, default both).
Jobs started from this browser tab are **Local builds**: you can stop a running build
or remove a queued one. Jobs from other clients (API agents, another tab) are
**External jobs** and stay read-only. Each group has a **History** dropdown with one
collapsible entry per run; open a run to see its steps.

A small **jobs widget** sits in the top action bar: a progress meter with the current node and
counts of local and external jobs. Click it to open the Jobs tab, drag its grip to float it
anywhere (remembered), drop it on the action bar or double-click the grip to dock it again. It can be hidden under
**Settings → MooBox → Jobs → Widget**.

The progress line shows the running local build, otherwise a running external job
(teal). Click it to open the Jobs tab. It is an estimate based on finished nodes,
never remaining time. Only node ids, titles, class types, status and progress are shared
with other clients; inputs, outputs and errors are not, and client ids only as a hash.

### Tag list

The list is stored locally in `user/moobox/tags.csv`. Fill it through the
**Tag list** setting: paste the whole list and click **Save list**, or click
**Download from URL** (only then is the configured URL fetched; the default URL is the
a1111-tagcomplete `danbooru.csv`). Formats: `tag`, `tag,count` or
`tag,type,count,"alias1,alias2"`. A list larger than 256 KB is not shown in the setting;
paste a complete new list to replace it.

## LoRA loader details

A new loader node defaults to **LoRA Manager** if it is installed, otherwise to ComfyUI,
and the LoRA Manager option cannot be selected. Saved workflows keep their own choice.
The default loader uses ComfyUI's own LoRA loader and configured LoRA folders.
The advanced setting **loader → LoRA Manager** uses the registered LoRA Manager node for
its extra model folders and special model support. Only that optional link requires
LoRA Manager; changes to that node or its local API may later require an update of the link.
The browser link uses LoRA Manager's existing model navigation in the new tab; filters
in your ComfyUI tab are not changed.
When LoRA Manager is installed, its **Send to ComfyUI** button can target the MooBox loader
through LoRA Manager's adapter API (append or replace; a LoRA already in the list is switched
on with the sent strength), and connected TriggerWord Toggle nodes follow the active LoRAs.

Trigger words are stored in the workflow when added. With the default loader, the
safetensors metadata is read first, then LoRA Manager's local metadata API if available.
No internet requests are made and no model files or metadata are modified.
Manual trigger word input is possible as well.

## Existing workflows

The original nodes and workflows are never changed automatically. Replace the two nodes
by hand, or make a separate copy of an exported workflow:

```powershell
python migrate_workflow.py "C:\path\to\workflow.json"
```

```bash
python3 migrate_workflow.py /path/to/workflow.json
```

This writes `workflow-moobox.json`, keeps the connections and selections and sets the
converted loaders to **LoRA Manager**. rgthree's Fast Groups Bypasser and Muter become
**Groups Toggle** (those with a connected output are left alone), Seed becomes **Seeds** (one
seed, same value; increment and decrement of the last seed become -1) and Image Comparer becomes
**Image Compare**; rgthree nodes that were not converted are listed. The original workflow is left untouched.
A loader with a connected text or `lora_stack` input is refused and needs manual conversion;
nothing is written then, and an existing output file is never overwritten. rgthree settings
without a MooBox equivalent (toggle restriction, navigation, custom sort alphabet, seed range) are listed.

Keep a backup of this folder. ComfyUI updates may, as with other node packs, require changes.

## Tests

```bash
python -m unittest discover -s tests -p "test_*.py"
node --experimental-vm-modules --test tests/*.test.mjs
```

Without Node.js, `bun test tests` runs the same JavaScript tests. The Python tests need an
interpreter with `aiohttp`, such as ComfyUI's own (for example `.venv\Scripts\python.exe`).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout of the pack and how to add a node.

## License

[MIT](LICENSE)
