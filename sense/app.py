"""FastAPI sense worker. Bind to 127.0.0.1:8765. The Vite app proxies /api here."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse

from sense.catalog import Catalog
from sense.planner import health, library_payload, media_path, run_command, run_similar, search_only, thumb_path

app = FastAPI(title="sense")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:43123",
        "http://localhost:43123",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

catalog = Catalog.load()


@app.get("/health")
def get_health() -> dict:
    return health(catalog)


@app.get("/library")
def get_library() -> dict:
    return library_payload(catalog)


@app.post("/v1/command")
async def post_command(request: Request) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected an object.")
    return await run_command(catalog, body)


@app.post("/similar")
async def post_similar(request: Request) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected an object.")
    return await run_similar(catalog, body)


@app.post("/search")
async def post_search(request: Request) -> dict:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected an object.")
    return await search_only(catalog, body)


@app.get("/media")
def get_media(request: Request, id: str) -> Response:
    path = media_path(catalog, id)
    if path is None:
        raise HTTPException(status_code=404, detail="Not in the vault.")
    return _file(path, request)


@app.get("/thumb")
def get_thumb(id: str) -> Response:
    path = thumb_path(catalog, id)
    if path is None:
        raise HTTPException(status_code=404, detail="No thumb.")
    media_type = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else mimetypes.guess_type(path.name)[0]
    return FileResponse(path, media_type=media_type or "application/octet-stream")


def _file(path: Path, request: Request) -> Response:
    size = path.stat().st_size
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
    if not range_header.startswith("bytes="):
        raise HTTPException(status_code=416)
    start_s, _, end_s = range_header.removeprefix("bytes=").partition("-")
    try:
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except ValueError as error:
        raise HTTPException(status_code=416) from error
    end = min(end, size - 1)
    if start < 0 or start > end:
        raise HTTPException(status_code=416)
    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    return StreamingResponse(_chunks(path, start, end), status_code=206, media_type=media_type, headers=headers)


def _chunks(path: Path, start: int, end: int):
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
