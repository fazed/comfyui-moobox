import { libraryPath, modernLoraPath, modernUiAvailable } from "./modernui.js";

function modelKey(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\.(safetensors|ckpt|pt|bin)$/i, "").replace(/\/+$/, "");
}

export function managerMatches(models, name) {
  const wanted = modelKey(name).toLowerCase();
  return models.filter((model) => {
    const paths = [model.file_path, [model.folder, model.file_name].filter(Boolean).join("/")];
    return paths.some((path) => {
      const key = modelKey(path).toLowerCase();
      return key === wanted || key.endsWith("/" + wanted);
    });
  });
}

export function prepareManagerNavigation(storage, model) {
  if (!/^[a-f\d]{64}$/i.test(model.sha256 || "")) throw new Error("LoRA Manager has no file hash for this model. Rescan it in the library first.");
  // The manager's existing recipe-to-model navigation opens a single model.
  // These keys are written only inside the new browser tab, never the canvas tab.
  storage.removeItem("lora_manager_recipe_to_lora_filterLoraHashes");
  storage.setItem("lora_manager_recipe_to_lora_filterLoraHash", model.sha256.toLowerCase());
  storage.setItem("lora_manager_viewLoraDetail", "true");
  storage.setItem("lora_manager_filterRecipeName", "MooBox");
}

// LoRA Manager sets pendingLoraHash for the single filtered model but never opens it,
// so the manager page is shown in a same-origin frame and its only card is clicked.
export function clickDetailCard(doc) {
  const cards = doc?.querySelectorAll("#modelGrid .model-card") || [];
  if (cards.length !== 1) return false;
  (cards[0].querySelector(".card-preview") || cards[0]).click();
  return true;
}

function showLibraryDetail(url) {
  const frame = document.createElement("iframe");
  frame.className = "mb-manager-frame";
  frame.title = "LoRA Manager";
  frame.src = url;
  document.body.className = "";
  document.body.replaceChildren(frame);
  const started = Date.now();
  const timer = setInterval(() => {
    let opened = false;
    try { opened = clickDetailCard(frame.contentDocument); } catch { /* frame not ready */ }
    if (opened || Date.now() - started > 15000) clearInterval(timer);
  }, 250);
}

export async function openManagerPage() {
  const base = new URL("../../", import.meta.url);
  const library = new URL(libraryPath(false), base);
  const modern = modernUiAvailable(base);
  const name = new URLSearchParams(window.location.search).get("name");
  if (!name) { window.location.replace(new URL(libraryPath(await modern), base).href); return; }
  const status = document.getElementById("status");
  const choices = document.getElementById("choices");
  const fallback = document.getElementById("library");
  fallback.href = library.href;
  modern.then((found) => { fallback.href = new URL(libraryPath(found), base).href; });
  status.textContent = `Finding ${name} in LoRA Manager…`;
  // The modern UI opens a model from its file path; the classic page needs the hash handoff below.
  const navigate = async (model) => {
    const deepLink = modernLoraPath(model.file_path);
    if (deepLink && await modern) { window.location.replace(new URL(deepLink, base).href); return; }
    try {
      prepareManagerNavigation(sessionStorage, model);
      showLibraryDetail(library.href);
    } catch (error) { status.textContent = error.message; }
  };
  try {
    const params = new URLSearchParams({ search: modelKey(name).split("/").pop(), search_modelname: "false", page_size: "100", page: "1" });
    const models = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      params.set("page", page);
      const response = await fetch(new URL(`api/lm/loras/list?${params}`, base));
      if (!response.ok) throw new Error("LoRA Manager is unavailable. Check that its node pack is installed and running.");
      const data = await response.json();
      models.push(...data.items);
      pages = data.total_pages || 1;
    }
    const matches = managerMatches(models, name);
    if (matches.length === 1) { navigate(matches[0]); return; }
    if (!matches.length) { status.textContent = "This LoRA is not indexed in LoRA Manager yet. Open the library and rescan its model folder."; return; }
    status.textContent = "Several files have this name. Choose the one you want to open:";
    for (const model of matches) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = model.file_path || [model.folder, model.file_name].filter(Boolean).join("/");
      choice.addEventListener("click", () => navigate(model));
      choices.append(choice);
    }
  } catch (error) { status.textContent = error.message; }
}
