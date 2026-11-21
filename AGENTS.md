# MooBox

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout of this pack and how to add a node.

- Keep all custom behavior in this pack. Do not edit third-party packs or ComfyUI core.
- Keep node IDs and saved widget names stable. New nodes use V3 schemas.
- Never import LoRA Manager's private Python modules, JavaScript, CSS, or bundles. The one exception is its documented third-party adapter module `lora_node_adapters.js` (served as `/extensions/comfyui-lora-manager/` or `/extensions/ComfyUI-Lora-Manager/`), loaded with an optional dynamic `import()`.
- Optional integration uses its registered node interface, that adapter module and local HTTP endpoints only.
- Browser links may use the manager's existing detail-navigation session keys in a new tab; never change filters in the originating canvas tab. The detail overlay is opened by clicking the single filtered card in a same-origin frame; touch no other manager DOM. When a HEAD probe of `/lm-ui/` answers 2xx, link to the modern UI's `lm-ui/loras?open=<file_path>` route instead (`web/modernui.js`).
- Keep the native ComfyUI loader usable without LoRA Manager.
- Keep trigger selections, including temporarily absent groups, in workflow widget state.
- No Internet access, model downloads, or writes to model files or metadata. The only exception is the tag list download, which runs only when the user clicks Download in the tag autocomplete settings.
- Tag autocomplete attaches to textareas through document-level listeners so it works in Nodes 2.0 (Vue) and legacy nodes; never hook widget constructors.
- The jobs monitor only observes. Stopping is limited to jobs of this browser tab and goes through ComfyUI's own cancel endpoint; external jobs stay read-only.
- No polling timers and no document-wide click or key listeners to refresh the UI: ComfyUI reports no group, position or mode changes. Refresh on creation, load, widget callbacks, the node's own actions and a Refresh button. The system stats meter in the top bar is the single allowed timer and only fetches while the document is visible. Every listener, timer, observer, popup or menu a node starts is removed in `onRemoved` or `onRemove` and that removal is tested.
- Compute which nodes are inside a group from `pos` and `size`; `recomputeInsideNodes` and `boundingRect` are wrong for subgraphs that were never opened.
- Append new widgets at the end, never reorder `widgets_values`, and ship the conversion in `migrate_workflow.py` with any change that alters what saved values mean.
- Do side effects such as advancing seeds only after ComfyUI accepted the prompt.
- Read the lessons in CONTRIBUTING.md before writing a node, and test every change yourself in both Nodes 2.0 and the classic view, or state what you could not test.
- Run the Python and JavaScript tests documented in README.md after behavior changes.
- Do not migrate or overwrite user workflows automatically; the converter writes new files.
