# MooBox

A custom ComfyUI node pack with a searchable LoRA loader, stable trigger word selections,
tag autocomplete for prompts, an image comparer and a multi-seed node.
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
  Groups that temporarily disappear keep their selection when they come back.
  The source input is collapsible; active counts stay visible.
- **Image Compare (MooBox)**: connect two or more images (a new input appears
  automatically). Use the A and B dropdowns to choose which two to compare
  (⇄ swaps them; the first two connected are the default) and pick a mode:
  **A/B**, **Slider**, **Blend**, **Difference** or **Blink**
  (ⓘ explains the chosen mode). Run the workflow to compare.

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
  `-1` is replaced when the workflow is queued, so image metadata contains the real seed.

- **Groups Toggle (MooBox)**: one switch per group in the workflow. Switching a group off
  bypasses (or mutes, via `action`) every node inside it; switching it on makes them active again.
  `match_title` (text or regular expression) and `match_colors` (ComfyUI color names or hex,
  comma separated) limit the list, `sort` is by position or alphanumeric, → jumps to the group.
  With `all_graphs` (default on) the groups inside subgraphs are listed too, with the subgraph name
  next to them, so a detailer group can be switched from the root view. `match_subgraph` is a list of the subgraph names (filled in by the editor) that limits it to one
  subgraph and the subgraphs inside it; the root graph is then left out. `(all)` lists everything. A subgraph used by several
  nodes is one shared definition, so switching its groups affects every copy.
  A group counts as on while at least one of its nodes is active. The node itself never runs
  and is never toggled by its own group.

### MooBox / Prompt

Type in a text field of a node (Nodes 2.0 and classic) and suggestions from your
tag list appear, sorted by popularity; aliases are found too. ↑/↓ selects, Tab or Enter
inserts, Esc closes. Not active inside `<lora:...>`. Settings are under
**Settings → MooBox → Tag autocomplete**: on/off, minimum characters, number of
suggestions, spaces instead of underscores (default on; `score_` tags and `^_^` keep
their underscore), escaping `( )` and a trailing comma after the tag.

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

### Tag list

The list is stored locally in `user/moobox/tags.csv`. Fill it through the
**Tag list** setting: paste the whole list and click **Save list**, or click
**Download from URL** (only then is the configured URL fetched; the default URL is the
a1111-tagcomplete `danbooru.csv`). Formats: `tag`, `tag,count` or
`tag,type,count,"alias1,alias2"`.

## LoRA loader details

A new loader node defaults to **LoRA Manager** if it is installed, otherwise to ComfyUI,
and the LoRA Manager option cannot be selected. Saved workflows keep their own choice.
The default loader uses ComfyUI's own LoRA loader and configured LoRA folders.
The advanced setting **loader → LoRA Manager** uses the registered LoRA Manager node for
its extra model folders and special model support. Only that optional link requires
LoRA Manager; changes to that node or its local API may later require an update of the link.
The browser link uses LoRA Manager's existing model navigation in the new tab; filters
in your ComfyUI tab are not changed.

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
**Groups Toggle** (those with a connected output are left alone); other rgthree nodes are listed. The original workflow is left untouched.
A connected text input needs manual conversion.

Keep a backup of this folder. ComfyUI updates may, as with other node packs, require changes.

## Tests

```bash
python -m unittest discover -s tests -p "test_*.py"
node --experimental-vm-modules --test tests/*.test.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout of the pack and how to add a node.

## License

[MIT](LICENSE)
