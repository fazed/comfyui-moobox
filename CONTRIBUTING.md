# Contributing to MooBox

Thanks for helping out. Please also read [AGENTS.md](AGENTS.md), which holds the fixed design rules of this pack.

## Layout

| File | Contents |
| --- | --- |
| `__init__.py` | Registers all nodes with ComfyUI (`get_node_list`). |
| `nodes.py` | Node classes (V3 schemas): LoRA Loader, Trigger Words, tag prompts, Seeds. |
| `compare.py` | Image Compare node. |
| `logic.py` | Pure logic without ComfyUI imports (tags, trigger words, prompts), easy to test. |
| `routes.py` | Local HTTP endpoints (`/moobox-lora/...`, `/moobox-tags`). |
| `web/` | Frontend. `widgets.js` (loader and triggers), `seeds.js`, `groups.js` and `groupstate.js` (Groups Toggle), `compare.js`, `autocomplete.js`, `tags.js`, `tagprompt.js`, `state.js`, `manager.js`, `styles.css`. |
| `migrate_workflow.py` | Converts an exported workflow into a copy that uses the MooBox nodes. |
| `tests/` | Python tests (`test_*.py`) and JavaScript tests (`*.test.mjs`). |

## Running the tests

From this folder, after every behavior change:

```bash
python -m unittest discover -s tests -p "test_*.py"
node --experimental-vm-modules --test tests/*.test.mjs
```

## Adding a node

1. Add a class based on `io.ComfyNode` to `nodes.py` (or its own file) with a V3 schema (`define_schema` and `execute`).
2. Add it to `get_node_list` in `__init__.py`.
3. If the node has its own widget, give the input `extra_dict={"widgetType": "MOOBOX_..."}` and register that widget in a `getCustomWidgets()` in `web/`. Use `socketless=True` if the field should not get an input socket.
4. Put pure logic in `logic.py` and add a test for it.
5. Describe the node briefly in the README.

## Things to keep in mind

- Node IDs and saved widget names stay stable, otherwise existing workflows break.
- No internet access. The only exception is the tag download the user starts themselves.
- Do not touch ComfyUI itself or other node packs. Use their public nodes and APIs.
- Test frontend changes in both Nodes 2.0 (Vue) and the classic view.
- Keep changes small and focused: one behavior change per commit, with a short, direct commit title (`Fix ...`, `Add ...`).
