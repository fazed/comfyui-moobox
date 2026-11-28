// The Save button of Save Image Advanced (MooBox) only exists while the save toggle is off.
export const exportVisible = (save) => save === false;

// The temp previews of the last run that the export route accepts.
export const exportableImages = (images) =>
  (Array.isArray(images) ? images : []).filter((image) => image?.type === "temp" && image.subfolder === "" && /^MooBoxSave_/.test(image.filename ?? ""));

// What node.properties keeps of the last run: just enough to name each temp preview.
export const previewRefs = (images) => exportableImages(images).map(({ filename, subfolder, type }) => ({ filename, subfolder, type }));

// The last run's images: the live results when ComfyUI still has them, else the previews kept in node.properties.
export const lastRunImages = (outputImages, savedPreviews) => (Array.isArray(outputImages) ? outputImages : previewRefs(savedPreviews));

// The button's state and message for an export response.
export function exportMessage(status, text) {
  if (status === 200) {
    const saved = JSON.parse(text).saved ?? [];
    const names = saved.map((file) => (file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename));
    return { state: "ok", message: `Saved ${names.join(", ")}` };
  }
  // The export route answers 404 only when a preview is gone; the server text may be ComfyUI's generic one.
  if (status === 404) return { state: "error", message: GONE };
  let message = text.trim();
  try {
    message = JSON.parse(text).error || message;
  } catch {
    // Not JSON: show the text as is.
  }
  return { state: "error", message: message || `Saving failed (HTTP ${status}).` };
}

export const GONE = "The preview is gone, probably because ComfyUI restarted. Run the workflow again.";
