# Contributing to MooBox

Thanks for helping out. Please also read [AGENTS.md](AGENTS.md), which holds the fixed design rules of this pack.

## Layout

| File | Contents |
| --- | --- |
| `__init__.py` | Registers all nodes with ComfyUI (`get_node_list`). |
| `nodes.py` | Node classes (V3 schemas): LoRA Loader, Trigger Words, tag prompts, Seeds. |
| `compare.py` | Image Compare and Preview Images nodes. |
| `logic.py` | Pure logic without ComfyUI imports (tags, trigger words, prompts), easy to test. |
| `jobs.py` | Read-only job monitor (snapshot route and `moobox_jobs.snapshot` event). |
| `routes.py` | Local HTTP endpoints (`/moobox-lora/...`, `/moobox-tags`). |
| `web/` | Frontend. `widgets.js` (loader and triggers), `seeds.js` and `seedstate.js` (Seeds), `groups.js` and `groupstate.js` (Groups Toggle), `jobs.js` and `jobspanel.js` (Jobs tab and top bar), `jobswidget.js` (jobs widget in the action bar), `compare.js` and `compare.css`, `preview.js` and `previewstate.js` (Preview Images), `autocomplete.js`, `tags.js`, `tagprompt.js`, `state.js`, `manager.js`, `styles.css` (linked once through `styles.js`), `jobs.css`. Modules named `*state.js` hold pure logic and are tested without ComfyUI. |
| `migrate_workflow.py` | Converts an exported workflow into a copy that uses the MooBox nodes. |
| `tests/` | Python tests (`test_*.py`) and JavaScript tests (`*.test.mjs`). |

## Running the tests

From this folder, after every behavior change:

```bash
python -m unittest discover -s tests -p "test_*.py"
node --experimental-vm-modules --test tests/*.test.mjs
```

`bun test tests` is an alternative for the JavaScript tests. Run the Python tests with an
interpreter that has `aiohttp`, such as ComfyUI's own `.venv`.

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

## Lessons for writing nodes

These come from bugs we already had. Check them before you start and again before you call a node done.

**Refreshing and cleanup**
- Do not poll with `setInterval` and do not listen to every click or key on the document to refresh a node. ComfyUI sends no event when a group, a node position or a node mode changes. Refresh on creation, on workflow load (`afterConfigureGraph`, `onConfigure`, `onAdded`), when a widget changes (`widget.callback`), after the node's own actions and on an explicit Refresh button.
- Everything a node starts has an owner that stops it: listeners on `document`, `window` or `api`, timers, observers, popups and menus appended to `document.body`. Clean up in `node.onRemoved` or `widget.onRemove`, and test it: add the node, remove it and check nothing is left. Also check what happens when a popup or menu is open while the node is removed.
- Debounce with a single timer that you clear on input and on removal. A debounce is not polling, but it still needs that cleanup.
- Move repeating animations to CSS (`@keyframes`) so the browser pauses them when the tab is hidden.

**Graph and subgraphs**
- Do not trust `group.recomputeInsideNodes()` or `node.boundingRect` for a subgraph that was never opened: sizes are not computed yet and the first group claims every node. Compute membership from `pos` and `size` (`nodesInside` in `web/groupstate.js`).
- Nodes can sit in a subgraph (ids like `12:34`) and a subgraph definition can be shared by several instances. Handle both whenever you read or write the saved workflow, and say so in the README when switching something affects every copy.
- A bypassed or muted node removes its links from the prompt. A node that falls back to saved text when its input is missing will then send stale values. Decide what it should output in that case.

**Saved workflows**
- Append new widgets at the end and never reorder `widgets_values`; keep widget names stable. When a change makes old values mean something else, ship the conversion in `migrate_workflow.py` with the change.
- State that must survive a reload belongs in a widget value. Say in the README what does not survive (for example Image Compare results).
- Saved entries that can pile up (such as trigger groups that are no longer present) need a way to forget them.

**Behaviour at the edges**
- Do side effects such as advancing a seed only after ComfyUI accepted the prompt. A rejected prompt (HTTP 400) must change nothing.
- Think about every route into a node: the editor, the API without the frontend, bypassed or muted nodes, pasted and cloned nodes, undo and redo, workflows saved by an older version.
- Do not reject user input that the downstream node can use; only refuse what would break it.

**Performance**
- Measure before you optimise, keep the numbers in the commit message and fix only what the numbers justify. Load big data (such as the tag list) lazily, only when the feature is on, and let HTTP revalidate it instead of `no-store`.
- Load shared assets once (`web/styles.js`), remove CSS and code that nothing uses (grep to prove it) and avoid rebuilding DOM or re-syncing other widgets when nothing relevant changed.

**Tests**
- Put pure logic in `logic.py` or a `*state.js` module so it runs without ComfyUI, and test the behaviour you changed, including the failing case.
- Python tests need an interpreter with `aiohttp` (ComfyUI's `.venv`); JavaScript tests run with `bun test tests` when Node.js is not installed.
- Test both Nodes 2.0 and the classic view, and the light theme, or write down that you did not.
