from __future__ import annotations

import asyncio
import json
import os
import struct

import aiohttp
import psutil
import torch
from aiohttp import web
import comfy.model_management
import comfy.utils
import folder_paths
from server import PromptServer

from .image_metadata import export_previews
from .jobs import install as install_jobs
from .logic import lora_family
from .nodes import TAGS_FILE, resolve_lora

install_jobs(PromptServer.instance)

MAX_TAGS_BYTES = 64 * 1024 * 1024
PREVIEW_SUFFIXES = (".preview.jpeg", ".preview.jpg", ".preview.png", ".preview.webp", ".jpeg", ".jpg", ".png", ".webp")


def preview_path(name: str) -> str | None:
    base = os.path.splitext(resolve_lora(name))[0]
    return next((base + suffix for suffix in PREVIEW_SUFFIXES if os.path.isfile(base + suffix)), None)


def embedded_words(name: str) -> list[str]:
    path = resolve_lora(name)
    if not path.lower().endswith(".safetensors"):
        return []
    header = comfy.utils.safetensors_header(path)
    metadata = json.loads(header).get("__metadata__", {}) if header else {}
    value = metadata.get("ss_trigger_words") or metadata.get("trigger_words") or metadata.get("trainedWords") or []
    if isinstance(value, str):
        value = [value]
    return [word for word in value if isinstance(word, str) and word.strip()]


# Header classifications by path, valid while size and mtime are unchanged; memory only.
_families: dict[str, tuple[tuple[int, int], str]] = {}


def file_family(name: str) -> str:
    path = folder_paths.get_full_path("loras", name)
    if path is None or not path.lower().endswith(".safetensors"):
        return "Unknown"
    stat = os.stat(path)
    key = (stat.st_size, stat.st_mtime_ns)
    cached = _families.get(path)
    if cached is None or cached[0] != key:
        try:
            header = comfy.utils.safetensors_header(path)
            tensors = json.loads(header) if header else {}
        except (OSError, struct.error, ValueError):
            tensors = {}
        tensors.pop("__metadata__", None)
        cached = _families[path] = (key, lora_family(tensors))
    return cached[1]


def search_names(query: list[str], family: str) -> list[str]:
    names = [name for name in folder_paths.get_filename_list("loras") if all(word in name.casefold() for word in query)]
    return names if family == "Any" else [name for name in names if file_family(name) == family]


@PromptServer.instance.routes.get("/moobox-lora/search")
async def search(request: web.Request) -> web.Response:
    query = request.query.get("q", "").casefold().split()
    offset = request.query.get("offset", "")
    offset = int(offset) if offset.isdecimal() else 0
    matching = await asyncio.to_thread(search_names, query, request.query.get("family", "Any"))
    return web.json_response({"names": matching[offset:offset + 50], "total": len(matching)})


@PromptServer.instance.routes.get("/moobox-lora/words")
async def words(request: web.Request) -> web.Response:
    try:
        result = await asyncio.to_thread(embedded_words, request.query.get("name", ""))
    except (ValueError, FileNotFoundError) as error:
        raise web.HTTPBadRequest(text=str(error)) from error
    return web.json_response({"words": result})


@PromptServer.instance.routes.get("/moobox-lora/preview")
async def preview(request: web.Request) -> web.Response:
    try:
        path = await asyncio.to_thread(preview_path, request.query.get("name", ""))
    except (ValueError, FileNotFoundError) as error:
        raise web.HTTPBadRequest(text=str(error)) from error
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "max-age=300"})


@PromptServer.instance.routes.post("/moobox-save/export")
async def export_saved(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        images = body.get("images") if isinstance(body, dict) else None
        saved = await asyncio.to_thread(export_previews, folder_paths.get_temp_directory(), folder_paths.get_output_directory(), images)
    # Returned, not raised: ComfyUI's middleware replaces the text of a raised HTTP error with a generic one.
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except FileExistsError as error:
        return web.json_response({"error": str(error)}, status=409)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"saved": saved})


# cpu_percent(interval=None) measures since the previous call; this first call sets the baseline.
psutil.cpu_percent(interval=None)


def memory_usage(device) -> dict[str, int]:
    total = comfy.model_management.get_total_memory(device)
    return {"used": total - comfy.model_management.get_free_memory(device), "total": total}


@PromptServer.instance.routes.get("/moobox-system")
async def system(request: web.Request) -> web.Response:
    device = comfy.model_management.get_torch_device()
    return web.json_response({
        "cpu": psutil.cpu_percent(interval=None),
        "ram": memory_usage(torch.device("cpu")),
        "vram": None if device.type == "cpu" else memory_usage(device),
    })


def save_tags(data: bytes) -> None:
    os.makedirs(os.path.dirname(TAGS_FILE), exist_ok=True)
    with open(TAGS_FILE + ".tmp", "wb") as file:
        file.write(data)
    os.replace(TAGS_FILE + ".tmp", TAGS_FILE)


@PromptServer.instance.routes.get("/moobox-tags")
async def get_tags(request: web.Request) -> web.Response:
    if not os.path.isfile(TAGS_FILE):
        raise web.HTTPNotFound()
    return web.FileResponse(TAGS_FILE, headers={"Cache-Control": "no-cache"})


@PromptServer.instance.routes.put("/moobox-tags")
async def put_tags(request: web.Request) -> web.Response:
    if (request.content_length or 0) > MAX_TAGS_BYTES:
        raise web.HTTPRequestEntityTooLarge(MAX_TAGS_BYTES, request.content_length)
    data = await request.read()
    if len(data) > MAX_TAGS_BYTES:
        raise web.HTTPRequestEntityTooLarge(MAX_TAGS_BYTES, len(data))
    await asyncio.to_thread(save_tags, data)
    return web.json_response({"bytes": len(data)})


@PromptServer.instance.routes.post("/moobox-tags/download")
async def download_tags(request: web.Request) -> web.Response:
    url = (await request.json()).get("url", "")
    if not url.startswith(("http://", "https://")):
        raise web.HTTPBadRequest(text="URL must start with http:// or https://")
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
            async with session.get(url) as response:
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.content.iter_chunked(1 << 20):
                    data += chunk
                    if len(data) > MAX_TAGS_BYTES:
                        raise web.HTTPRequestEntityTooLarge(MAX_TAGS_BYTES, len(data))
    except aiohttp.ClientError as error:
        raise web.HTTPBadGateway(text=str(error)) from error
    await asyncio.to_thread(save_tags, data)
    return web.json_response({"bytes": len(data)})
