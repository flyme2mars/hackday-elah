"""Tool loop. Gemini API, then Vertex MaaS, then local E4B. No invented edits when all are down."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from sense.catalog import Catalog, Item
from sense.retrieve import cosine, lexical

INSTRUCTIONS = """You edit a timeline by calling tools. Search the library before you place media. Prefer vault_id values from search_vault or similar. You may also use a vault_id the user typed if it is in the library. Do not invent ids.

V1 and V2 take video. A1 takes audio. T1 takes text through add_text. Track names are the strings V1, V2, A1, T1. Never use numbers for tracks.

Times are seconds. The stage is usually 1080 by 1920 at 30 fps. Change the stage only when asked.

apply_ops is the only way to edit. Put the whole change in one apply_ops call. get_timeline shows the current cut.

Allowed ops (exact names):
- {"op":"add_clip","vault_id":"video/example.mp4","track":"V1","start_s":0,"duration_s":3}
- {"op":"add_text","content":"Hello","track":"T1","start_s":0,"duration_s":2}
- {"op":"set_stage","width":1080,"height":1920}
- {"op":"trim","clip_id":"...","duration_s":2}
- {"op":"move","clip_id":"...","track":"V1","start_s":1}
- {"op":"remove","clip_id":"..."}
- {"op":"set_volume","clip_id":"...","volume":0.8}
- {"op":"update_text","clip_id":"...","content":"Hi"}
- {"op":"set_transform","clip_id":"...","rotation":180}

set_transform rotation is degrees clockwise. 180 turns the picture upside down. Use it only when the user asked to rotate.

When trimming to a new length, send duration_s only. Omit start_s unless the user asked to move the left edge.

When the user asks to find footage, call search_vault and do not edit unless they also asked for an edit.

The user does not see your prose. They see the library and the timeline."""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_vault",
        "description": "Search the library by meaning or, if embeddings are offline, by name. Returns real vault ids.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "modality": {"type": "string", "enum": ["video", "audio", "image"]},
                "k": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "similar",
        "description": "Find library items near a known vault id or path.",
        "parameters": {
            "type": "object",
            "properties": {
                "vault_id": {"type": "string"},
                "modality": {"type": "string", "enum": ["video", "audio", "image"]},
                "k": {"type": "integer"},
            },
            "required": ["vault_id"],
        },
    },
    {
        "name": "get_frame",
        "description": "Read one JPEG frame from a known video or image. The next turn can see the image.",
        "parameters": {
            "type": "object",
            "properties": {
                "vault_id": {"type": "string"},
                "t_s": {"type": "number"},
            },
            "required": ["vault_id", "t_s"],
        },
    },
    {
        "name": "transcribe",
        "description": "Transcribe speech from a known audio or video file with Parakeet.",
        "parameters": {
            "type": "object",
            "properties": {
                "vault_id": {"type": "string"},
                "start_s": {"type": "number"},
                "end_s": {"type": "number"},
            },
            "required": ["vault_id"],
        },
    },
    {
        "name": "get_timeline",
        "description": "Read the current timeline snapshot in seconds.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "apply_ops",
        "description": "Queue timeline edits for the host. They run as one undo step after this command. Use op add_clip with track V1/V2/A1 and a real vault_id. Never invent op names.",
        "parameters": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "ops": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["ops"],
        },
    },
]

TRACKS = {"V1", "V2", "A1", "T1"}
_mlx_cache: tuple[float, bool] = (0.0, False)
_vertex_cache: tuple[float, str | None] = (0.0, None)


@dataclass
class Call:
    name: str
    args: dict[str, Any]
    call_id: str = ""


@dataclass
class TurnState:
    catalog: Catalog
    corpus: list[Item]
    by_id: dict[str, Item]
    src_by_id: dict[str, str]
    duration_by_id: dict[str, float]
    allow: set[str]
    timeline: dict[str, Any]
    hits: list[Item] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)
    ops: list[dict[str, Any]] = field(default_factory=list)
    label: str | None = None
    mode: str | None = None
    notes: list[str] = field(default_factory=list)


def health(catalog: Catalog) -> dict[str, Any]:
    vectors = catalog.vectors
    if vectors is None:
        embeddings = "offline"
        keys: list[str] = []
        error = None
    elif vectors.error or vectors.matrix is None:
        embeddings = "mismatch" if vectors.keys else "offline"
        keys = vectors.keys
        error = vectors.error
    else:
        embeddings = "index"
        keys = vectors.keys
        error = None
    return {
        "vault": str(catalog.root),
        "vault_present": catalog.root.is_dir(),
        "index_json": str(catalog.index_json) if catalog.index_json else None,
        "embeddings": embeddings,
        "npz_keys": keys,
        "npz_error": error,
        "item_count": len(catalog.items),
        "truncated": catalog.truncated,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "vertex_project": os.environ.get("GOOGLE_CLOUD_PROJECT", "hackathon1-512618"),
        "vertex_model": os.environ.get("VERTEX_MODEL", "gemma-4-26b-a4b-it-maas"),
        "vertex_credentials": adc_present(),
        "gemini_configured": gemini_configured(),
        "gemini_model": _gemini_model(),
        "mlx_url": mlx_origin(),
        "e4b_url": e4b_url(),
    }


def library_payload(catalog: Catalog) -> dict[str, Any]:
    items = [public_hit(item, {}, {}) for item in catalog.items[:300]]
    return {
        "vault": str(catalog.root),
        "present": catalog.root.is_dir(),
        "embeddings": health(catalog)["embeddings"],
        "items": [item for item in items if item["src"]],
    }


async def run_command(catalog: Catalog, body: dict[str, Any]) -> dict[str, Any]:
    command = str(body.get("command") or "").strip()
    if not command:
        return _result("Enter a command.", [], [], None, "offline")
    if len(command) > 2000:
        command = command[:2000]
    state = _state_from(catalog, body)
    planner = await _choose_planner()
    if planner is None:
        found, mode = await _search(state, command, None, 8)
        _take_hits(state, found, mode)
        return _result(_offline_note(catalog, mode, bool(found)), state.hits, [], None, "offline", state)

    user = _prompt(state, command)
    contents: list[dict[str, Any]] = [{"role": "user", "parts": [{"text": f"{INSTRUCTIONS}\n\n{user}"}]}]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": INSTRUCTIONS},
        {"role": "user", "content": user},
    ]
    try:
        for _ in range(5):
            while True:
                try:
                    calls, contents, messages = await planner(contents, messages)
                    break
                except VertexBusy:
                    nxt, busy_note = _after_busy(planner)
                    if nxt is None:
                        raise
                    state.notes.append(busy_note)
                    planner = nxt
            if not calls:
                break
            calls.sort(key=lambda call: call.name == "apply_ops")
            tool_parts: list[dict[str, Any]] = []
            tool_messages: list[dict[str, Any]] = []
            images: list[bytes] = []
            for call in calls:
                payload, image = await _execute(state, call)
                tool_parts.append({"functionResponse": {"name": call.name, "response": payload}})
                if image is not None:
                    images.append(image)
                    mime = payload.get("mime") if isinstance(payload.get("mime"), str) else "image/jpeg"
                    tool_parts.append({"inlineData": {"mimeType": mime, "data": _b64(image)}})
                tool_messages.append({
                    "role": "tool",
                    "tool_call_id": call.call_id or call.name,
                    "content": json.dumps(payload),
                })
            if state.ops:
                break
            contents.append({"role": "user", "parts": tool_parts})
            messages.extend(tool_messages)
            if images:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Frame from get_frame."},
                        *[{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{_b64(image)}"}} for image in images],
                    ],
                })
    except Exception as error:
        state.notes.append(_short(error))
    if not state.hits and not state.ops:
        found, mode = await _search(state, command, None, 8)
        _take_hits(state, found, mode)
    note = " ".join(dict.fromkeys(state.notes)).strip()
    planner_name = _planner_name(planner)
    if not note and not state.ops and not state.hits:
        note = "No edits."
    return _result(note, state.hits, state.ops, state.label, planner_name, state)


_UPLOAD_SIMILAR_NOTE = "Find similar works on vault clips. Browser uploads are not on disk for EmbeddingGemma yet."


def _similar_needs_vault_file(catalog: Catalog, vault_id: str) -> bool:
    if vault_id.startswith("upload/"):
        return True
    return catalog.item_for_tool(vault_id) is None


async def run_similar(catalog: Catalog, body: dict[str, Any]) -> dict[str, Any]:
    state = _state_from(catalog, body)
    vault_id = str(body.get("vault_id") or "").strip()
    if _similar_needs_vault_file(catalog, vault_id):
        return {
            "note": _UPLOAD_SIMILAR_NOTE,
            "mode": "name",
            "hits": {"video": [], "audio": [], "image": []},
        }
    modality = _modality(body.get("modality"))
    k = _k(body.get("k"))
    found, mode = await _similar(state, vault_id, modality, k)
    _take_hits(state, found, mode)
    if not found:
        if mode == "embedding":
            note = "No similar files."
        elif _vectors_ready(catalog):
            note = "No similar files. Embedding model is not loaded."
        else:
            note = "No similar files. Embeddings are offline."
    elif mode == "name":
        note = _name_note(catalog)
    else:
        note = ""
    return {"note": note, "mode": mode, "hits": _classify(state)}


def thumb_path(catalog: Catalog, vault_id: str) -> Path | None:
    item = catalog.by_id.get(vault_id)
    if item is None or not item.servable or item.path is None:
        return None
    if item.kind == "image":
        return item.path
    if item.kind != "video" or shutil.which("ffmpeg") is None:
        return None
    cache = catalog.repo / "sense" / ".cache" / "thumbs"
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / f"{_safe_name(vault_id)}.jpg"
    if dest.is_file() and dest.stat().st_mtime >= item.path.stat().st_mtime:
        return dest
    proc = subprocess.run(
        ["ffmpeg", "-y", "-ss", "0.4", "-i", str(item.path), "-frames:v", "1", "-vf", "scale=160:-2", "-q:v", "5", str(dest)],
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or not dest.is_file():
        dest.unlink(missing_ok=True)
        return None
    return dest


def media_path(catalog: Catalog, vault_id: str) -> Path | None:
    item = catalog.by_id.get(vault_id)
    if item is None or not item.servable or item.path is None:
        return None
    return item.path


def _state_from(catalog: Catalog, body: dict[str, Any]) -> TurnState:
    library = body.get("library") if isinstance(body.get("library"), list) else []
    timeline = body.get("timeline") if isinstance(body.get("timeline"), dict) else {}
    src_by_id: dict[str, str] = {}
    duration_by_id: dict[str, float] = {}
    visible: list[Item] = []
    bundled = {item.id: item for item in catalog.bundled()}
    use_bundled = len(catalog.items) == 0
    for row in library:
        if not isinstance(row, dict):
            continue
        vault_id = row.get("vault_id")
        if not isinstance(vault_id, str) or not vault_id.strip():
            continue
        vault_id = vault_id.strip()
        item = catalog.by_id.get(vault_id)
        if item is None and use_bundled:
            item = bundled.get(vault_id)
        if item is None:
            continue
        visible.append(item)
        if isinstance(row.get("src"), str) and row["src"]:
            src_by_id[vault_id] = row["src"]
        if isinstance(row.get("duration_s"), (int, float)) and not isinstance(row.get("duration_s"), bool):
            duration_by_id[vault_id] = float(row["duration_s"])
    corpus = catalog.items if catalog.items else visible
    by_id = {item.id: item for item in corpus}
    # Ids the model may place: ones already on the timeline, plus later search and similar hits.
    allow = _timeline_vault_ids(timeline)
    allow.update(item.id for item in corpus)
    return TurnState(catalog, corpus, by_id, src_by_id, duration_by_id, allow, timeline)


def _timeline_vault_ids(timeline: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for track in timeline.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips") or []:
            if isinstance(clip, dict) and isinstance(clip.get("vault_id"), str):
                found.add(clip["vault_id"])
    return found


def _prompt(state: TurnState, command: str) -> str:
    lines = []
    for item in state.corpus[:30]:
        duration = f"{item.duration_s:.2f}s" if item.duration_s is not None else "unknown length"
        lines.append(f"{item.id} | {item.kind} | {item.name} | {duration}")
    extra = ""
    if len(state.corpus) > 30:
        extra = f"\n{len(state.corpus) - 30} more. Use search_vault."
    library = "\n".join(lines) if lines else "Library is empty."
    timeline = json.dumps(_compact_timeline(state.timeline), ensure_ascii=True)
    return f"Library:\n{library}{extra}\n\nTimeline:\n{timeline}\n\nCommand: {command}"


def _compact_timeline(timeline: dict[str, Any]) -> dict[str, Any]:
    tracks = []
    for track in timeline.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        clips = []
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                continue
            clips.append({
                "id": clip.get("alias") or clip.get("id"),
                "vault_id": clip.get("vault_id"),
                "type": clip.get("type"),
                "name": clip.get("name"),
                "start_s": clip.get("start_s"),
                "duration_s": clip.get("duration_s"),
                "content": clip.get("content"),
            })
        tracks.append({"track": track.get("alias") or track.get("name"), "kind": track.get("kind"), "clips": clips})
    return {"stage": timeline.get("stage"), "duration_s": timeline.get("duration_s"), "tracks": tracks}


def _parse_e4b_tool_calls(content: object) -> list[Call]:
    """Lift tool JSON out of an E4B message that arrived as plain text."""
    text = _content_text(content).strip()
    if not text:
        return []
    parsed = _load_tool_json(text)
    rows = parsed if isinstance(parsed, list) else [parsed] if isinstance(parsed, dict) else []
    calls: list[Call] = []
    loose_ops: list[dict[str, Any]] = []
    for row in rows:
        if (
            isinstance(row, dict)
            and isinstance(row.get("op"), str)
            and "name" not in row
            and "function" not in row
        ):
            loose_ops.append(row)
            continue
        call = _call_from_tool_row(row, len(calls))
        if call is not None and call.name:
            calls.append(call)
    if loose_ops:
        calls.append(Call("apply_ops", {"ops": loose_ops}, f"call_{len(calls)}"))
    return calls


def _call_from_tool_row(row: object, index: int) -> Call | None:
    if not isinstance(row, dict):
        return None
    if isinstance(row.get("op"), str) and "name" not in row:
        return Call("apply_ops", {"ops": [row]}, f"call_{index}")
    if isinstance(row.get("ops"), list) and "name" not in row and "function" not in row:
        args: dict[str, Any] = {"ops": row["ops"]}
        if isinstance(row.get("label"), str):
            args["label"] = row["label"]
        return Call("apply_ops", args, f"call_{index}")
    function = row.get("function") if isinstance(row.get("function"), dict) else {}
    name = row.get("name") or function.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    raw_args = row.get("arguments")
    if raw_args is None:
        raw_args = row.get("args") if "args" in row else function.get("arguments")
    return Call(name.strip(), _args(raw_args), str(row.get("id") or f"call_{index}"))


def _load_tool_json(text: str) -> object | None:
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidates: list[str] = []
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text.strip())
    match = re.search(r"(\[[\s\S]*\]|\{[\s\S]*\})", text)
    if match:
        candidates.append(match.group(1))
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return ""


def _planner_name(planner: object) -> str:
    if planner is _gemini_turn:
        return "gemini"
    if planner is _vertex_turn:
        return "vertex"
    if planner is _e4b_turn:
        return "e4b"
    return "offline"


def _after_busy(planner: object) -> tuple[object | None, str]:
    """Gemini 402/429/503 tries Vertex, then local E4B. Vertex 429/503 tries E4B."""
    if planner is _gemini_turn:
        if _vertex_enabled():
            return _vertex_turn, "Gemini API busy; trying Vertex."
        return _e4b_turn, "Gemini API busy; using local E4B."
    if planner is _vertex_turn:
        return _e4b_turn, "Vertex busy; using local E4B."
    return None, ""


async def _choose_planner():
    if _gemini_enabled():
        return _gemini_turn
    if _vertex_enabled():
        return _vertex_turn
    if await _mlx_up():
        return _e4b_turn
    return None


def _generate_content_body(contents: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "contents": contents,
        "tools": [{"functionDeclarations": TOOLS}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }


def _absorb_generate_content(data: dict[str, Any], contents: list[dict[str, Any]]) -> list[Call]:
    candidate = (data.get("candidates") or [{}])[0]
    content = candidate.get("content") or {}
    parts = content.get("parts") or []
    contents.append(content if content.get("role") else {"role": "model", "parts": parts})
    calls: list[Call] = []
    for index, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        raw = part.get("functionCall") or part.get("function_call")
        if not isinstance(raw, dict):
            continue
        calls.append(Call(str(raw.get("name") or ""), _args(raw.get("args")), f"call_{index}"))
    return calls


async def _gemini_turn(contents: list[dict[str, Any]], messages: list[dict[str, Any]]):
    key = _gemini_api_key()
    if not key:
        raise RuntimeError("Gemini API key is not configured.")
    url = _gemini_url()
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, headers={"x-goog-api-key": key}, json=_generate_content_body(contents))
    # 402 = AI Studio prepaid depleted; 429/503 = capacity. Fall through to Vertex/E4B.
    if response.status_code in (402, 429, 503):
        raise VertexBusy(f"Gemini API returned {response.status_code}.")
    if response.status_code >= 400:
        raise RuntimeError(f"Gemini API returned {response.status_code}.")
    return _absorb_generate_content(response.json(), contents), contents, messages


async def _vertex_turn(contents: list[dict[str, Any]], messages: list[dict[str, Any]]):
    token = _vertex_token()
    if not token:
        raise RuntimeError("Vertex credentials are not available.")
    url = _vertex_url()
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, headers={"Authorization": f"Bearer {token}"}, json=_generate_content_body(contents))
    if response.status_code in (429, 503):
        raise VertexBusy(f"Vertex returned {response.status_code}.")
    if response.status_code >= 400:
        raise RuntimeError(f"Vertex returned {response.status_code}.")
    return _absorb_generate_content(response.json(), contents), contents, messages


async def _e4b_turn(contents: list[dict[str, Any]], messages: list[dict[str, Any]]):
    payload = {
        "model": os.environ.get("SENSE_E4B_MODEL", "gemma-e4b"),
        "messages": messages,
        "tools": [{"type": "function", "function": tool} for tool in TOOLS],
        "tool_choice": "auto",
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(e4b_url(), json=payload)
    if response.status_code >= 400:
        raise RuntimeError(f"Local model returned {response.status_code}.")
    data = response.json()
    choice = (data.get("choices") or [{}])[0]
    message = dict(choice.get("message") or {})
    calls: list[Call] = []
    for index, tool_call in enumerate(message.get("tool_calls") or []):
        function = tool_call.get("function") or {}
        calls.append(Call(str(function.get("name") or ""), _args(function.get("arguments")), str(tool_call.get("id") or f"call_{index}")))
    legacy = message.get("function_call")
    if isinstance(legacy, dict) and not calls:
        calls.append(Call(str(legacy.get("name") or ""), _args(legacy.get("arguments")), "call_0"))
    if not calls:
        calls = _parse_e4b_tool_calls(message.get("content"))
        if calls:
            message["tool_calls"] = [
                {
                    "id": call.call_id or f"call_{index}",
                    "type": "function",
                    "function": {"name": call.name, "arguments": json.dumps(call.args)},
                }
                for index, call in enumerate(calls)
            ]
            message["content"] = None
    messages.append(message)
    return calls, contents, messages


async def _execute(state: TurnState, call: Call) -> tuple[dict[str, Any], bytes | None]:
    name = call.name
    args = call.args
    try:
        if name == "search_vault":
            found, mode = await _search(state, str(args.get("query") or ""), _modality(args.get("modality")), _k(args.get("k")))
            _take_hits(state, found, mode)
            return {"mode": mode, "hits": [_model_hit(state, item) for item in found]}, None
        if name == "similar":
            found, mode = await _similar(state, str(args.get("vault_id") or ""), _modality(args.get("modality")), _k(args.get("k")))
            _take_hits(state, found, mode)
            return {"mode": mode, "source": args.get("vault_id"), "hits": [_model_hit(state, item) for item in found]}, None
        if name == "get_timeline":
            return {"timeline": _compact_timeline(state.timeline), "pending_ops": bool(state.ops)}, None
        if name == "get_frame":
            return await _frame(state, str(args.get("vault_id") or ""), args.get("t_s"))
        if name == "transcribe":
            return await _transcribe(state, str(args.get("vault_id") or ""), args.get("start_s"), args.get("end_s")), None
        if name == "apply_ops":
            ops = validate_ops(args.get("ops"), state.allow)
            label = args.get("label")
            state.ops = ops
            state.label = label.strip()[:80] if isinstance(label, str) and label.strip() else "Edit"
            return {"ok": True, "op_count": len(ops), "label": state.label}, None
        return {"error": f"Unknown tool {name}."}, None
    except OpError as error:
        return {"error": str(error)}, None
    except Exception as error:
        return {"error": _short(error)}, None


async def _search(state: TurnState, query: str, modality: str | None, k: int) -> tuple[list[Item], str]:
    vector = await _embed_text(query) if _vectors_ready(state.catalog) else None
    if vector is not None and state.catalog.vectors is not None:
        ranked = cosine(state.catalog.vectors.ids, state.catalog.vectors.matrix, vector, state.by_id, modality, k)
        if ranked is not None:
            for item, score in ranked:
                state.scores[item.id] = score
            return [item for item, _ in ranked], "embedding"
    return lexical(state.corpus, query, modality, k), "name"


async def _similar(state: TurnState, vault_id: str, modality: str | None, k: int) -> tuple[list[Item], str]:
    source = state.by_id.get(vault_id) or state.catalog.item_for_tool(vault_id)
    if source is None:
        state.notes.append("That clip is not in the library.")
        return [], "name"
    if _vectors_ready(state.catalog) and state.catalog.vectors is not None:
        row = {item_id: index for index, item_id in enumerate(state.catalog.vectors.ids)}
        if vault_id in row:
            matrix = state.catalog.vectors.matrix
            vector = [float(value) for value in matrix[row[vault_id]]]
            ranked = cosine(state.catalog.vectors.ids, matrix, vector, state.by_id, modality, k, {vault_id})
            if ranked is not None:
                for item, score in ranked:
                    state.scores[item.id] = score
                return [item for item, _ in ranked], "embedding"
        embedded = await _embed_media(source)
        if embedded is not None:
            ranked = cosine(state.catalog.vectors.ids, state.catalog.vectors.matrix, embedded, state.by_id, modality, k, {vault_id})
            if ranked is not None:
                for item, score in ranked:
                    state.scores[item.id] = score
                return [item for item, _ in ranked], "embedding"
    return lexical(state.corpus, source.name, modality, k, {vault_id}), "name"


async def _frame(state: TurnState, vault_id: str, t_s: object) -> tuple[dict[str, Any], bytes | None]:
    if vault_id not in state.allow and vault_id not in state.by_id:
        return {"ok": False, "error": "Unknown vault_id."}, None
    item = state.catalog.item_for_tool(vault_id)
    if item is None or item.path is None:
        return {"ok": False, "error": "No file for that id."}, None
    if not isinstance(t_s, (int, float)) or isinstance(t_s, bool) or t_s < 0:
        return {"ok": False, "error": "t_s must be a number of seconds."}, None
    if item.kind == "image":
        suffix = item.path.suffix.lower()
        mime = "image/png" if suffix == ".png" else "image/webp" if suffix == ".webp" else "image/jpeg"
        return {"ok": True, "vault_id": vault_id, "t_s": float(t_s), "mime": mime}, item.path.read_bytes()
    if shutil.which("ffmpeg") is None:
        return {"ok": False, "error": "ffmpeg is not installed."}, None
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{float(t_s):.3f}", "-i", str(item.path), "-frames:v", "1", "-q:v", "3", "-f", "image2", "pipe:1"],
        capture_output=True,
        timeout=25,
    )
    if proc.returncode != 0 or not proc.stdout:
        return {"ok": False, "error": "Could not read a frame."}, None
    state.allow.add(vault_id)
    return {"ok": True, "vault_id": vault_id, "t_s": float(t_s), "mime": "image/jpeg"}, proc.stdout


async def _transcribe(state: TurnState, vault_id: str, start_s: object, end_s: object) -> dict[str, Any]:
    if vault_id not in state.allow and vault_id not in state.by_id:
        return {"ok": False, "error": "Unknown vault_id."}
    item = state.catalog.item_for_tool(vault_id)
    if item is None or item.path is None:
        return {"ok": False, "error": "No file for that id."}
    if not await _mlx_up():
        return {"ok": False, "error": "Parakeet is not loaded."}
    url = os.environ.get("SENSE_MLX_TRANSCRIBE_URL", f"{mlx_origin()}/v1/audio/transcriptions")
    payload: dict[str, Any] = {"path": str(item.path), "model": os.environ.get("SENSE_ASR_MODEL", "parakeet")}
    if isinstance(start_s, (int, float)) and not isinstance(start_s, bool):
        payload["start_s"] = float(start_s)
    if isinstance(end_s, (int, float)) and not isinstance(end_s, bool):
        payload["end_s"] = float(end_s)
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(url, json=payload)
    if response.status_code >= 400:
        return {"ok": False, "error": "Parakeet is not loaded."}
    data = response.json()
    text = data.get("text") or data.get("transcript") or ""
    if not isinstance(text, str):
        return {"ok": False, "error": "Parakeet returned no text."}
    return {"ok": True, "text": text[:4000]}


def _take_hits(state: TurnState, items: list[Item], mode: str) -> None:
    state.mode = mode
    seen = {item.id for item in state.hits}
    for item in items:
        state.allow.add(item.id)
        if item.id not in seen:
            state.hits.append(item)
            seen.add(item.id)
    if mode == "name" and items:
        note = _name_note(state.catalog)
        if note not in state.notes:
            state.notes.append(note)


def _model_hit(state: TurnState, item: Item) -> dict[str, Any]:
    hit: dict[str, Any] = {"vault_id": item.id, "name": item.name, "kind": item.kind, "duration_s": item.duration_s}
    if item.id in state.scores:
        hit["score"] = round(state.scores[item.id], 4)
    return hit


def _classify(state: TurnState) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {"video": [], "audio": [], "image": []}
    for item in state.hits:
        kind = item.kind if item.kind in grouped else "video"
        grouped[kind].append(public_hit(item, state.src_by_id, state.scores, state.duration_by_id))
    return grouped


def public_hit(item: Item, src_by_id: dict[str, str], scores: dict[str, float], duration_by_id: dict[str, float] | None = None) -> dict[str, Any]:
    src = src_by_id.get(item.id) or (f"/media?id={quote(item.id, safe='')}" if item.servable else "")
    thumb = f"/thumb?id={quote(item.id, safe='')}" if item.servable and item.kind in ("video", "image") else None
    duration = item.duration_s
    if duration is None and duration_by_id and item.id in duration_by_id:
        duration = duration_by_id[item.id]
    hit: dict[str, Any] = {
        "vault_id": item.id,
        "name": item.name,
        "kind": item.kind,
        "duration_s": duration,
        "src": src,
        "thumb": thumb,
    }
    if item.id in scores:
        hit["score"] = round(scores[item.id], 4)
    return hit


def _result(note: str, hits: list[Item], ops: list[dict[str, Any]], label: str | None, planner: str, state: TurnState | None = None) -> dict[str, Any]:
    grouped = _classify(state) if state is not None else {"video": [], "audio": [], "image": []}
    if state is None:
        for item in hits:
            kind = item.kind if item.kind in grouped else "video"
            grouped[kind].append(public_hit(item, {}, {}))
    return {"note": note, "planner": planner, "hits": grouped, "ops": ops, "ops_label": label}


def _name_note(catalog: Catalog) -> str:
    if _vectors_ready(catalog):
        return "Embedding model is not loaded. Showing name matches."
    return "Embeddings are offline. Showing name matches."


def _offline_note(catalog: Catalog, mode: str, found: bool) -> str:
    if not found:
        if _vectors_ready(catalog):
            return "Planner not loaded. No library match."
        return "Planner not loaded. No library match. Embeddings are offline."
    if mode == "name":
        return f"Planner not loaded. {_name_note(catalog)}"
    return "Planner not loaded."


async def search_only(catalog: Catalog, body: dict[str, Any]) -> dict[str, Any]:
    state = _state_from(catalog, body)
    query = str(body.get("query") or body.get("command") or "")
    found, mode = await _search(state, query, _modality(body.get("modality")), _k(body.get("k")))
    _take_hits(state, found, mode)
    if not found:
        note = "No library match." if _vectors_ready(catalog) else "No library match. Embeddings are offline."
    elif mode == "name":
        note = _name_note(catalog)
    else:
        note = ""
    return {"note": note, "mode": mode, "hits": _classify(state)}


class VertexBusy(RuntimeError):
    """Gemini API or Vertex Gemma is out of capacity (HTTP 429 or 503)."""


class OpError(Exception):
    pass


def validate_ops(raw: object, allow: set[str]) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise OpError("ops must be a non-empty list.")
    if len(raw) > 40:
        raise OpError("Too many ops.")
    return [_validate_op(op, allow) for op in raw]


def _validate_op(raw: object, allow: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OpError("Each op must be an object.")
    name = raw.get("op")
    if name == "set_stage":
        return {"op": "set_stage", "width": _req_num(raw, "width"), "height": _req_num(raw, "height")}
    if name == "add_clip":
        vault_id = _req_str(raw, "vault_id")
        if vault_id not in allow:
            matches = [vid for vid in allow if vid.endswith("/" + vault_id) or vid == vault_id]
            if len(matches) == 1:
                vault_id = matches[0]
            else:
                raise OpError(f"vault_id {vault_id} is not in the library results.")
        track_raw = raw.get("track")
        if isinstance(track_raw, int) and not isinstance(track_raw, bool):
            track = {0: "V1", 1: "V2", 2: "A1"}.get(track_raw)
            if track is None:
                raise OpError("add_clip track must be V1, V2, or A1.")
        else:
            track = _req_str(raw, "track").strip().upper()
        if track not in {"V1", "V2", "A1"}:
            raise OpError("add_clip track must be V1, V2, or A1.")
        op: dict[str, Any] = {"op": "add_clip", "vault_id": vault_id, "track": track, "start_s": _req_num(raw, "start_s")}
        _copy_optional(raw, op, ("duration_s", "in_s"), ("name", "clip_id"))
        return op
    if name == "add_text":
        if "content" not in raw and isinstance(raw.get("text"), str):
            raw = {**raw, "content": raw["text"]}
        op = {
            "op": "add_text",
            "content": _req_str(raw, "content"),
            "start_s": _req_num(raw, "start_s"),
            "duration_s": _req_num(raw, "duration_s"),
        }
        if "track" in raw and raw["track"] is not None:
            track = _req_str(raw, "track")
            if track != "T1":
                raise OpError("add_text track must be T1.")
            op["track"] = track
        _copy_optional(raw, op, ("x", "y", "font_size", "background_opacity"), ("clip_id", "name", "color", "background"))
        return op
    if name == "trim":
        op = {"op": "trim", "clip_id": _req_str(raw, "clip_id")}
        _copy_optional(raw, op, ("start_s", "duration_s", "in_s"), ())
        if len(op) == 2:
            raise OpError("trim needs start_s, duration_s, or in_s.")
        return op
    if name == "split":
        op = {"op": "split", "clip_id": _req_str(raw, "clip_id"), "at_s": _req_num(raw, "at_s")}
        _copy_optional(raw, op, (), ("left_id", "right_id"))
        return op
    if name == "move":
        op = {"op": "move", "clip_id": _req_str(raw, "clip_id"), "start_s": _req_num(raw, "start_s")}
        if "track" in raw and raw["track"] is not None:
            track = _req_str(raw, "track")
            if track not in TRACKS:
                raise OpError("Unknown track.")
            op["track"] = track
        return op
    if name == "remove":
        return {"op": "remove", "clip_id": _req_str(raw, "clip_id")}
    if name == "set_transform":
        return {"op": "set_transform", "clip_id": _req_str(raw, "clip_id"), "rotation": _req_num(raw, "rotation")}
    if name == "set_volume":
        volume = _req_num(raw, "volume")
        if volume < 0 or volume > 1:
            raise OpError("volume must be between 0 and 1.")
        return {"op": "set_volume", "clip_id": _req_str(raw, "clip_id"), "volume": volume}
    if name == "update_text":
        if "content" not in raw and isinstance(raw.get("text"), str):
            raw = {**raw, "content": raw["text"]}
        op = {"op": "update_text", "clip_id": _req_str(raw, "clip_id")}
        _copy_optional(raw, op, ("font_size", "x", "y"), ("content", "color"))
        if len(op) == 2:
            raise OpError("update_text needs a field to change.")
        return op
    raise OpError("Unknown op.")


def _copy_optional(raw: dict[str, Any], op: dict[str, Any], numbers: tuple[str, ...], strings: tuple[str, ...]) -> None:
    for key in numbers:
        if key in raw and raw[key] is not None:
            op[key] = _req_num(raw, key)
    for key in strings:
        if key in raw and raw[key] is not None:
            op[key] = _req_str(raw, key)


def _req_str(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise OpError(f"{key} is required.")
    if len(value) > 500:
        raise OpError(f"{key} is too long.")
    return value.strip()


def _req_num(raw: dict[str, Any], key: str) -> float:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OpError(f"{key} must be a number.")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise OpError(f"{key} must be finite.")
    return number


def _modality(value: object) -> str | None:
    if value in ("video", "audio", "image"):
        return str(value)
    return None


def _k(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 5
    return max(1, min(12, int(value)))


def _args(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _vectors_ready(catalog: Catalog) -> bool:
    vectors = catalog.vectors
    return vectors is not None and vectors.matrix is not None and not vectors.error


def _gemini_model() -> str:
    model = os.environ.get("GEMINI_MODEL", "gemma-4-26b-a4b-it").strip()
    return model or "gemma-4-26b-a4b-it"


def _gemini_url() -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{_gemini_model()}:generateContent"


def _gemini_api_key() -> str | None:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "SENSE_GEMINI_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def gemini_configured() -> bool:
    """True when an API key env var is set. The key itself is never returned."""
    return _gemini_api_key() is not None


def _gemini_enabled() -> bool:
    return os.environ.get("SENSE_GEMINI", "1") != "0" and gemini_configured()


def _vertex_enabled() -> bool:
    return bool(adc_present() and os.environ.get("SENSE_VERTEX", "1") != "0" and _vertex_token())


def adc_present() -> bool:
    raw = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if raw and Path(raw).expanduser().is_file():
        return True
    return (Path.home() / ".config" / "gcloud" / "application_default_credentials.json").is_file()


def _vertex_token() -> str | None:
    global _vertex_cache
    now = time.time()
    if now < _vertex_cache[0]:
        return _vertex_cache[1]
    token: str | None = None
    try:
        import google.auth
        from google.auth.transport.requests import Request

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(Request())
        token = creds.token
    except Exception:
        token = None
    _vertex_cache = (now + (240 if token else 20), token)
    return token


def _vertex_url() -> str:
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "hackathon1-512618")
    location = os.environ.get("VERTEX_LOCATION", "global")
    model = os.environ.get("VERTEX_MODEL", "gemma-4-26b-a4b-it-maas")
    if location == "global":
        host = "https://aiplatform.googleapis.com"
    else:
        host = f"https://{location}-aiplatform.googleapis.com"
    return f"{host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent"


def mlx_origin() -> str:
    explicit = os.environ.get("SENSE_MLX_URL", "http://127.0.0.1:8787")
    parsed = urlparse(explicit)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return explicit.rstrip("/")


def e4b_url() -> str:
    return os.environ.get("SENSE_E4B_URL", f"{mlx_origin()}/v1/chat/completions")


async def _mlx_up() -> bool:
    global _mlx_cache
    now = time.time()
    if now < _mlx_cache[0]:
        return _mlx_cache[1]
    up = False
    try:
        async with httpx.AsyncClient(timeout=0.6) as client:
            await client.get(f"{mlx_origin()}/health")
        up = True
    except httpx.HTTPError:
        up = False
    _mlx_cache = (now + 5, up)
    return up


async def _embed_text(text: str) -> list[float] | None:
    if not text.strip() or not await _mlx_up():
        return None
    url = os.environ.get("SENSE_MLX_EMBED_URL", f"{mlx_origin()}/v1/embeddings")
    payload = {"model": os.environ.get("SENSE_EMBED_MODEL", "embeddinggemma"), "input": text}
    return await _post_embedding(url, payload)


async def _embed_media(item: Item) -> list[float] | None:
    if item.path is None or not await _mlx_up():
        return None
    url = os.environ.get("SENSE_MLX_MEDIA_EMBED_URL", f"{mlx_origin()}/v1/media/embed")
    payload = {"model": os.environ.get("SENSE_EMBED_MODEL", "embeddinggemma"), "path": str(item.path), "modality": item.kind}
    return await _post_embedding(url, payload)


async def _post_embedding(url: str, payload: dict[str, Any]) -> list[float] | None:
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(url, json=payload)
        if response.status_code >= 400:
            return None
        return _parse_embedding(response.json())
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        return None


def _parse_embedding(body: object) -> list[float] | None:
    if not isinstance(body, dict):
        return None
    raw = body.get("embedding") or body.get("vector")
    data = body.get("data")
    if raw is None and isinstance(data, list) and data and isinstance(data[0], dict):
        raw = data[0].get("embedding")
    if not isinstance(raw, list) or not raw:
        return None
    try:
        return [float(value) for value in raw]
    except (TypeError, ValueError):
        return None


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


def _safe_name(vault_id: str) -> str:
    import hashlib

    return hashlib.sha1(vault_id.encode("utf-8")).hexdigest()


def _short(error: Exception) -> str:
    text = str(error).replace("\n", " ").strip()
    return text[:180] or error.__class__.__name__
