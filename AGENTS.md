# MooBox

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout of this pack and how to add a node.

- Keep all custom behavior in this pack. Do not edit third-party packs or ComfyUI core.
- Keep node IDs and saved widget names stable. New nodes use V3 schemas.
- Never import LoRA Manager's private Python modules, JavaScript, CSS, or bundles.
- Optional integration uses its registered node interface and local HTTP endpoints only.
- Browser links may use the manager's existing detail-navigation session keys in a new tab; never change filters in the originating canvas tab. The detail overlay is opened by clicking the single filtered card in a same-origin frame; touch no other manager DOM.
- Keep the native ComfyUI loader usable without LoRA Manager.
- Keep trigger selections, including temporarily absent groups, in workflow widget state.
- No Internet access, model downloads, or writes to model files or metadata. The only exception is the tag list download, which runs only when the user clicks Download in the tag autocomplete settings.
- Tag autocomplete attaches to textareas through document-level listeners so it works in Nodes 2.0 (Vue) and legacy nodes; never hook widget constructors.
- The jobs monitor only observes. Stopping is limited to jobs of this browser tab and goes through ComfyUI's own cancel endpoint; external jobs stay read-only.
- Run the Python and JavaScript tests documented in README.md after behavior changes.
- Do not migrate or overwrite user workflows automatically; the converter writes new files.
