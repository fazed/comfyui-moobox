from __future__ import annotations

import asyncio
import json
import os

import aiohttp
from aiohttp import web
import comfy.utils
import folder_paths
from server import PromptServer

from .nodes import TAGS_FILE, resolve_lora


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


@PromptServer.instance.routes.get("/moobox-lora/search")
async def search(request: web.Request) -> web.Response:
    query = request.query.get("q", "").casefold().split()
    names = await asyncio.to_thread(folder_paths.get_filename_list, "loras")
    matching = [name for name in names if all(word in name.casefold() for word in query)]
    return web.json_response({"names": matching[:50], "total": len(matching)})


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


def save_tags(data: bytes) -> None:
    os.makedirs(os.path.dirname(TAGS_FILE), exist_ok=True)
    with open(TAGS_FILE, "wb") as file:
        file.write(data)


@PromptServer.instance.routes.get("/moobox-tags")
async def get_tags(request: web.Request) -> web.Response:
    if not os.path.isfile(TAGS_FILE):
        raise web.HTTPNotFound()
    return web.FileResponse(TAGS_FILE, headers={"Cache-Control": "no-cache"})


@PromptServer.instance.routes.put("/moobox-tags")
async def put_tags(request: web.Request) -> web.Response:
    data = await request.read()
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
