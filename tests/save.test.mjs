import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GONE, exportableImages, exportMessage, exportVisible, lastRunImages, previewRefs } from '../web/savestate.js';

test('the save button only shows while the save toggle is off', () => {
  assert.equal(exportVisible(false), true);
  assert.equal(exportVisible(true), false);
  assert.equal(exportVisible(undefined), false);
});

test('only temp previews of this node are sent to the export route', () => {
  const preview = { filename: 'MooBoxSave_0123456789ab_00000.png', subfolder: '', type: 'temp' };
  assert.deepEqual(exportableImages([preview, { ...preview, type: 'output' }, { ...preview, filename: 'ComfyUI_temp_x.png' }, { ...preview, subfolder: 'a' }, null]), [preview]);
  assert.deepEqual(exportableImages(undefined), []);
});

test('the last run comes from the live results, else from the previews kept in node.properties', () => {
  const preview = { filename: 'MooBoxSave_0123456789ab_00000.png', subfolder: '', type: 'temp' };
  assert.deepEqual(previewRefs([{ ...preview, id: 'x', metadata: { width: 8 } }, { ...preview, type: 'output' }]), [preview]);
  assert.deepEqual(lastRunImages(undefined, [preview]), [preview]);
  assert.deepEqual(lastRunImages([], [preview]), []);
  assert.deepEqual(lastRunImages(undefined, undefined), []);
});

test('export responses become a success or error message', () => {
  const saved = JSON.stringify({ saved: [{ filename: 'a.png', subfolder: 'run', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }] });
  assert.deepEqual(exportMessage(200, saved), { state: 'ok', message: 'Saved run/a.png, b.png' });
  // ComfyUI's middleware may replace the server text with a generic JSON body; a 404 still reads clearly.
  assert.deepEqual(exportMessage(404, '{"success": false, "error": "404: Not Found"}'), { state: 'error', message: GONE });
  assert.match(GONE, /Run the workflow again/);
  assert.deepEqual(exportMessage(409, '{"error": "Pic.png already exists; nothing was overwritten."}'), { state: 'error', message: 'Pic.png already exists; nothing was overwritten.' });
  assert.deepEqual(exportMessage(400, 'plain text'), { state: 'error', message: 'plain text' });
  assert.deepEqual(exportMessage(500, ''), { state: 'error', message: 'Saving failed (HTTP 500).' });
});

test('the save widget uses mb- classes, the shared icon helper and colours from tokens.css only', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const source = await read('../web/save.js');
  assert.match(source, /glyph\("save"\)/);
  assert.match(await read('../web/icons.js'), /\bsave: \[/);
  assert.match(await read('../web/moobox.css'), /css\/save\.css/);
  assert.doesNotMatch(await read('../web/css/save.css'), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/i);
  assert.doesNotMatch(source, /setInterval|document\.addEventListener|window\.addEventListener/);
});
