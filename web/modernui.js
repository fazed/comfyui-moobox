// LoRA Manager (our fork) may serve a modern UI at /lm-ui/. It answers 503 while its
// bundle is not built and 404 on a backend without the route; the classic /loras page
// always exists. Paths are relative to the ComfyUI root so a reverse-proxy prefix stays.

let probe = null;

export function libraryPath(modern) {
  return modern === true ? "lm-ui/loras" : "loras";
}

// The modern UI matches ?open= exactly against the library's forward-slash file_path.
export function modernLoraPath(filePath) {
  if (!filePath) return null;
  return `lm-ui/loras?open=${encodeURIComponent(String(filePath).replaceAll("\\", "/"))}`;
}

// One HEAD probe per page load, cached. Only a 2xx answer counts as modern. A probe that
// has not answered within timeoutMs counts as classic for this call but keeps running.
export async function modernUiAvailable(base, fetchFn = globalThis.fetch, timeoutMs = 3000) {
  probe ??= Promise.resolve()
    .then(() => fetchFn(new URL("lm-ui/", base), { method: "HEAD", cache: "no-store" }))
    .then((response) => Boolean(response?.ok), () => false);
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
  try {
    return await Promise.race([probe, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function resetModernUiProbe() {
  probe = null;
}
