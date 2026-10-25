"""Tool loop. DigitalOcean Gemma when a key exists, then Gemini, then Vertex, then local E4B. No invented edits."""

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

from sense.catalog import LIBRARY_CAP, Catalog, Item
from sense.dictation_upload import ParakeetUnavailable, parakeet_text
from sense.retrieve import (
    CosineRank,
    cosine,
    infer_modality,
    lexical,
    matching_row,
    query_input,
    with_unjoined_index_items,
)

INSTRUCTIONS = """You edit a timeline by calling tools. For trim, split, cut, move, remove, rotate, volume, text, crossfade, or other edits on clips already on the timeline, call apply_ops right away. Do not call search_vault for those. Search the library only when the user asks to find footage, or before you place new media that is not already on the timeline. After that search, place the clip with add_clip. Prefer vault_id values from search_vault or similar. You may also use a vault_id the user typed if it is in the library. Do not invent ids.

V1 and V2 take video. A1 takes audio. T1 takes text through add_text. Track names are the strings V1, V2, A1, T1. Never use numbers for tracks.

Times are seconds. The stage is usually 1080 by 1920 at 30 fps. Change the stage only when asked.

apply_ops is the only way to edit. Put the whole change in one apply_ops call. get_timeline shows the current cut.

Allowed ops (exact names):
- {"op":"add_clip","vault_id":"video/example.mp4","track":"V1","start_s":0,"duration_s":3}
- {"op":"add_text","content":"Hello","track":"T1","start_s":0,"duration_s":2}
- {"op":"set_stage","width":1080,"height":1920}
- {"op":"trim","clip_id":"...","duration_s":2}
- {"op":"split","clip_id":"...","at_s":1}
- {"op":"move","clip_id":"...","track":"V1","start_s":1}
- {"op":"remove","clip_id":"..."}
- {"op":"set_volume","clip_id":"...","volume":0.8}
- {"op":"update_text","clip_id":"...","content":"Hi"}
- {"op":"crossfade","from_clip_id":"...","to_clip_id":"...","duration_s":0.5}
- {"op":"set_transform","clip_id":"...","rotation":180}
- {"op":"set_transform","clip_id":"...","scale":2}
- {"op":"set_transform","clip_id":"...","x":0.5,"y":0.4}
- {"op":"set_motion","clip_id":"...","property":"rotation","from":30,"to":60,"duration_s":3}
- {"op":"set_motion","clip_id":"...","property":"scale","keys":[{"t_s":0,"value":1},{"t_s":3,"value":2}]}

set_transform rotation is an absolute angle in degrees clockwise. The host stores radians. 180 turns the picture upside down. scale replaces the clip scale. Read the clip's current scale on the timeline. To zoom in, set scale higher than that number. x and y place the clip anchor on the stage, from 0 to 1. y 0 is the top and y 1 is the bottom. x 0 is the left and x 1 is the right. Omit any field you are not changing. Use set_transform for a static rotate, zoom, or position. Do not search the library for those.

"make it larger and put it in the center" is one set_transform on the selected clip: scale higher than that clip's current scale, plus x 0.5 and y 0.5. Center is 0.5, 0.5. Top-left is 0, 0. Top-right is 1, 0. Bottom-left is 0, 1. Bottom-right is 1, 1. Larger, bigger, and zoom in raise scale. Smaller and zoom out lower it, and scale stays positive. "move it left a bit" lowers x by about 0.1. Right raises x. Up lowers y. Down raises y. "rotate 90" is {"op":"set_transform","clip_id":"...","rotation":90}. "flip upside down" is rotation 180. Never invent op names such as scale, zoom, center, position, resize, move_to, or rotate. Those edits are set_transform.

set_motion animates one property. property is rotation, scale, x, y, or opacity. rotation is degrees clockwise. scale is the same zoom field as set_transform. x and y are stage positions from 0 to 1. opacity is from 0 to 1. Use from, to, and duration_s, or keys with t_s and value. t_s is seconds from the clip start. Send at least two keys. "rotate from 30 to 60 over 3 seconds" and "zoom from 1 to 2 over 3s" are set_motion. A pan while zooming is two set_motion ops. A static set_transform clears motion on the fields it sets.

To extend a rotation, zoom, pan, or other animation to N seconds, send set_motion for that property. Keep the current from and to values and set duration_s to N. "extend the rotation to 8 seconds" is set_motion, not trim. A still or image has no extra source media. Do not trim it to lengthen the animation. The host grows the still's timeline duration to cover the motion. trim changes a video or audio in-point or out-point inside the file, and it cannot run past that file.

When the prompt lists Selected clip_ids, those clips are selected. Prefer those ids for trim, set_transform, set_motion, remove, and split. Cut alone means split. at_s is seconds on the timeline. When the prompt lists a Playhead time, "here" is that time.

"split the video here and delete the right part", "cut here and delete the right", "split and keep the left", and "remove everything after the cut" are two ops in this order: split at the playhead, then remove only the new right half.
{"op":"split","clip_id":"...","at_s":1.5,"right_id":"right-half"}
{"op":"remove","clip_id":"right-half"}
Removing the original clip_id after a split deletes both halves. "keep the right", "delete the left", and "remove everything before the cut" use left_id the same way, then remove that alias.

When trimming to a new length, send duration_s only. Omit start_s unless the user asked to move the left edge.

Titles and captions are text overlays on T1, not library media. Add them directly with add_text; no search is needed. For "add title Hello at the start for 2 seconds", use {"op":"add_text","clip_id":"title1","content":"Hello","track":"T1","start_s":0,"duration_s":2}.
To change an existing title, use its id from the timeline with update_text. Supported fields are content, start_s, duration_s, font_size, color, x, y, background, background_opacity. Omit fields that should stay unchanged. Remove a title with remove and its clip_id. Do not create a replacement when asked to edit an existing title.
Text start_s must be non-negative and duration_s positive. x and y are normalized stage coordinates from 0 to 1; defaults are x=0.5, y=0.18. font_size is positive pixels. background_opacity ranges from 0 to 1. Use readable monochrome text by default.

For a crossfade or dissolve, use crossfade with the two existing adjacent video clip ids, in timeline order, on the same video track. duration_s defaults to 0.5 seconds. Do not move or trim the clips to create an overlap. Keep hard cuts unless a transition is requested.

When the user asks to find footage, call search_vault and do not edit unless they also asked for an edit.

The user does not see your prose. They see the library and the timeline."""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_vault",
        "description": "Find footage in the library by meaning or, if embeddings are offline, by name. Returns real vault ids. Do not use this to trim, split, cut, move, remove, rotate, zoom, scale, change volume, edit text, or crossfade. To place new media, search first, then add_clip.",
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
        "description": "Find video, audio, and image near a known vault id. Describe that item, then search every kind.",
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
        "description": "Queue timeline edits for the host as one undo step. Call this for trim, split, move, remove, set_volume, add_text, update_text, crossfade, set_transform, set_motion, and add_clip. set_transform rotation is degrees clockwise. set_transform scale replaces the clip scale. set_transform x and y are stage positions from 0 to 1. Larger, center, zoom, and rotate are set_transform, not new op names. A split that deletes one side also removes that split's right_id or left_id. set_motion animates rotation, scale, x, y, or opacity from one value to another. To extend an existing animation to N seconds, send set_motion with the same endpoints and duration_s N. Do not trim a still to lengthen an animation. Titles use add_text on T1. Never invent op names.",
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
    command: str = ""
    playhead_s: float | None = None
    selected_clip_ids: list[str] = field(default_factory=list)
    edit_errors: list[str] = field(default_factory=list)
    hits: list[Item] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)
    ops: list[dict[str, Any]] = field(default_factory=list)
    label: str | None = None
    mode: str | None = None
    notes: list[str] = field(default_factory=list)
    low_score: bool = False


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
        "do_configured": do_configured(),
        "do_model": _do_model(),
        "gemini_configured": gemini_configured(),
        "gemini_model": _gemini_model(),
        "mlx_url": mlx_origin(),
        "e4b_url": e4b_url(),
    }


def library_payload(catalog: Catalog) -> dict[str, Any]:
    items = [public_hit(item, {}, {}) for item in catalog.items[:LIBRARY_CAP]]
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
    state.command = command
    state.selected_clip_ids = _selected_ids(body)
    state.playhead_s = _optional_time(body.get("playhead_s"))
    if state.playhead_s is None:
        state.playhead_s = _optional_time(state.timeline.get("playhead_s"))
    if state.playhead_s is not None:
        state.timeline = {**state.timeline, "playhead_s": state.playhead_s}
    planner = await _choose_planner()
    if planner is None:
        if _blocks_search(command):
            return _result("Planner not loaded. No edits were applied.", [], [], None, "offline")
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
    if state.ops:
        state.edit_errors.clear()
    elif state.edit_errors or _blocks_search(command):
        state.hits.clear()
        state.scores.clear()
        name_note = _name_note(state.catalog)
        state.notes = [note for note in state.notes if note != name_note]
        for error in state.edit_errors:
            if error not in state.notes:
                state.notes.append(error)
    if not state.hits and not state.ops and _wants_search_fallback(command):
        found, mode = await _search(state, command, None, 8)
        _take_hits(state, found, mode)
    note = " ".join(dict.fromkeys(state.notes)).strip()
    planner_name = _planner_name(planner)
    if not note and not state.ops and not state.hits:
        note = _LOW_SCORE_NOTE if state.low_score else "No edits."
    return _result(note, state.hits, state.ops, state.label, planner_name, state)


_UPLOAD_SIMILAR_NOTE = "Find similar works on vault clips. Browser uploads are not on disk for EmbeddingGemma yet."
_LOW_SCORE_NOTE = "Nothing confident enough."
_DESCRIBE_FAIL_NOTE = "Could not describe this clip."
_DEFAULT_MIN_SCORE = 0.50
_SEARCH_KINDS = ("video", "audio", "image")
_DESCRIBE_STILL_LIMIT = 1_500_000


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
    return {"note": _similar_note(state, catalog, found, mode), "mode": mode, "hits": _classify(state)}


def thumb_path(catalog: Catalog, vault_id: str) -> Path | None:
    item = catalog.resolve_media(vault_id)
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
    item = catalog.resolve_media(vault_id)
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
    base = catalog.items if catalog.items else visible
    corpus = with_unjoined_index_items(catalog.root, base, catalog.vectors)
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
    selected = ""
    if state.selected_clip_ids:
        joined = ", ".join(state.selected_clip_ids)
        selected = f"\nSelected clip_ids: {joined}. Prefer these ids for trim, rotate, motion, remove, and split."
    playhead = ""
    if state.playhead_s is not None:
        playhead = f"\nPlayhead: {state.playhead_s:.3f}s. Use this for \"here\"."
    return f"Library:\n{library}{extra}\n\nTimeline:\n{timeline}{playhead}{selected}\n\nCommand: {command}"


def _compact_timeline(timeline: dict[str, Any]) -> dict[str, Any]:
    tracks = []
    for track in timeline.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        clips = []
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                continue
            row = {
                "id": clip.get("alias") or clip.get("id"),
                "vault_id": clip.get("vault_id"),
                "type": clip.get("type"),
                "name": clip.get("name"),
                "start_s": clip.get("start_s"),
                "duration_s": clip.get("duration_s"),
                "content": clip.get("content"),
            }
            for key in ("rotation_deg", "scale", "x", "y"):
                value = clip.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    row[key] = value
            motion = clip.get("motion")
            if isinstance(motion, dict):
                row["motion"] = motion
            clips.append(row)
        tracks.append({"track": track.get("alias") or track.get("name"), "kind": track.get("kind"), "clips": clips})
    compact: dict[str, Any] = {"stage": timeline.get("stage"), "duration_s": timeline.get("duration_s"), "tracks": tracks}
    playhead = _optional_time(timeline.get("playhead_s"))
    if playhead is not None:
        compact["playhead_s"] = playhead
    return compact


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
    if planner is _do_turn:
        return "do"
    if planner is _gemini_turn:
        return "gemini"
    if planner is _vertex_turn:
        return "vertex"
    if planner is _e4b_turn:
        return "e4b"
    return "offline"


def _after_busy(planner: object) -> tuple[object | None, str]:
    """DigitalOcean 401/402/403/429/503 tries Gemini, then Vertex, then local E4B.
    Gemini 402/429/503 tries Vertex, then local E4B. Vertex 429/503 tries E4B."""
    if planner is _do_turn:
        if _gemini_enabled():
            return _gemini_turn, "DigitalOcean busy; trying Gemini."
        if _vertex_enabled():
            return _vertex_turn, "DigitalOcean busy; trying Vertex."
        return _e4b_turn, "DigitalOcean busy; using local E4B."
    if planner is _gemini_turn:
        if _vertex_enabled():
            return _vertex_turn, "Gemini API busy; trying Vertex."
        return _e4b_turn, "Gemini API busy; using local E4B."
    if planner is _vertex_turn:
        return _e4b_turn, "Vertex busy; using local E4B."
    return None, ""


async def _choose_planner():
    if _do_enabled():
        return _do_turn
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


def _openai_chat_body(model: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": model,
        "messages": messages,
        "tools": [{"type": "function", "function": tool} for tool in TOOLS],
        "tool_choice": "auto",
        "temperature": 0.2,
    }


def _absorb_openai_message(data: dict[str, Any], messages: list[dict[str, Any]]) -> list[Call]:
    """Read an OpenAI chat completion into the same tool calls the Gemini loop uses."""
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
    return calls


_DO_BUSY = frozenset({401, 402, 403, 429, 503})


async def _do_turn(contents: list[dict[str, Any]], messages: list[dict[str, Any]]):
    key = _do_api_key()
    if not key:
        raise RuntimeError("DigitalOcean model key is not configured.")
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            do_url(),
            headers={"Authorization": f"Bearer {key}"},
            json=_openai_chat_body(_do_model(), messages),
        )
    # 401/403 auth, 402 billing, 429/503 capacity. Same fall-through as a busy Gemini call.
    if response.status_code in _DO_BUSY:
        raise VertexBusy(f"DigitalOcean returned {response.status_code}.")
    if response.status_code >= 400:
        raise RuntimeError(f"DigitalOcean returned {response.status_code}.")
    return _absorb_openai_message(response.json(), messages), contents, messages


async def _e4b_turn(contents: list[dict[str, Any]], messages: list[dict[str, Any]]):
    payload = _openai_chat_body(os.environ.get("SENSE_E4B_MODEL", "gemma-e4b"), messages)
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(e4b_url(), json=payload)
    if response.status_code >= 400:
        raise RuntimeError(f"Local model returned {response.status_code}.")
    return _absorb_openai_message(response.json(), messages), contents, messages


async def _execute(state: TurnState, call: Call) -> tuple[dict[str, Any], bytes | None]:
    name = call.name
    args = call.args
    try:
        if name == "search_vault":
            if _blocks_search(state.command):
                return {"error": "This edits the timeline. Call apply_ops and do not search."}, None
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
            ops = fan_selected_ops(
                validate_ops(
                    args.get("ops"),
                    state.allow,
                    state.timeline,
                    state.command,
                    state.playhead_s,
                    state.selected_clip_ids,
                ),
                state.selected_clip_ids,
            )
            ops = steer_extend_animation(state.command, state.timeline, ops, state.selected_clip_ids)
            label = args.get("label")
            state.ops = ops
            state.label = label.strip()[:80] if isinstance(label, str) and label.strip() else "Edit"
            return {"ok": True, "op_count": len(ops), "label": state.label}, None
        return {"error": f"Unknown tool {name}."}, None
    except OpError as error:
        if name == "apply_ops":
            state.edit_errors.append(str(error))
        else:
            state.notes.append(str(error))
        return {"error": str(error)}, None
    except Exception as error:
        state.notes.append(_short(error))
        return {"error": _short(error)}, None


async def _search(state: TurnState, query: str, modality: str | None, k: int) -> tuple[list[Item], str]:
    kind = infer_modality(query, modality)
    vector = await _embed_text(query) if _vectors_ready(state.catalog) else None
    if kind is None:
        return _rank_each_kind(state, query, k, vector)
    return _rank(state, query, kind, k, vector)


def _rank_each_kind(
    state: TurnState,
    query: str,
    k: int,
    vector: list[float] | None,
) -> tuple[list[Item], str]:
    found: list[Item] = []
    embedding = False
    dropped = False
    for kind in _SEARCH_KINDS:
        rows, mode = _rank(state, query, kind, k, vector)
        if mode == "embedding":
            embedding = True
        if state.low_score:
            dropped = True
        found.extend(rows)
    state.low_score = embedding and not found and dropped
    if embedding:
        return found, "embedding"
    return found, "name"


def _rank(state: TurnState, query: str, modality: str | None, k: int, vector: list[float] | None) -> tuple[list[Item], str]:
    vectors = state.catalog.vectors
    if vector is not None and vectors is not None and vectors.matrix is not None:
        ranked = cosine(vectors.ids, vectors.matrix, vector, state.by_id, modality, k)
        covered = _covered_hits(state, ranked)
        if covered is not None:
            return covered, "embedding"
    state.low_score = False
    found = lexical(state.corpus, query, modality, k)
    for item in found:
        state.scores.pop(item.id, None)
    return found, "name"


def _similar_note(state: TurnState, catalog: Catalog, found: list[Item], mode: str) -> str:
    if not found:
        if state.low_score:
            primary = _LOW_SCORE_NOTE
        elif mode == "embedding":
            primary = "No similar files."
        elif _vectors_ready(catalog):
            primary = "No similar files. Embedding model is not loaded."
        else:
            primary = "No similar files. Embeddings are offline."
    elif mode == "name":
        primary = _name_note(catalog)
    else:
        primary = ""
    notes: list[str] = []
    for note in state.notes:
        if note and note not in notes and note != primary:
            notes.append(note)
    if primary:
        notes.append(primary)
    return " ".join(notes)


async def _similar(state: TurnState, vault_id: str, modality: str | None, k: int) -> tuple[list[Item], str]:
    source = state.by_id.get(vault_id) or state.catalog.item_for_tool(vault_id)
    if source is None:
        state.notes.append("That clip is not in the library.")
        return [], "name"
    kinds = (modality,) if modality in _SEARCH_KINDS else _SEARCH_KINDS
    exclude = {vault_id, source.id}
    description, describe_note = await _describe_media(state, source)
    if describe_note and describe_note not in state.notes:
        state.notes.append(describe_note)
    text_vector = await _embed_text(description) if description and _vectors_ready(state.catalog) else None
    neighbor = await _neighbor_vector(state, vault_id, source)
    found = _merge_similar(state, [text_vector, neighbor], kinds, k, exclude)
    if found is not None:
        return found, "embedding"
    query = description or source.name
    rows: list[Item] = []
    seen: set[str] = set()
    for kind in kinds:
        for item in lexical(state.corpus, query, kind, k, exclude):
            if item.id in seen:
                continue
            seen.add(item.id)
            state.scores.pop(item.id, None)
            rows.append(item)
    state.low_score = False
    return rows, "name"


async def _describe_media(state: TurnState, source: Item) -> tuple[str | None, str | None]:
    """Ask Gemma for a search line. (None, None) when no planner is configured."""
    try:
        planner = await _choose_planner()
    except Exception:
        return None, _DESCRIBE_FAIL_NOTE
    if planner is None:
        return None, None
    try:
        image = _describe_still(state.catalog, source) if source.kind in ("video", "image") else None
        hint = await _transcript_hint(state, source) if source.kind == "audio" else None
        prompt = _describe_prompt(source, hint)
    except Exception:
        return None, _DESCRIBE_FAIL_NOTE
    seen: set[object] = set()
    while planner is not None and planner not in seen:
        seen.add(planner)
        try:
            text = _clean_description(await _describe_once(planner, prompt, image))
            if text:
                return text, None
        except Exception:
            pass
        planner, _busy = _after_busy(planner)
    return None, _DESCRIBE_FAIL_NOTE


def _describe_prompt(source: Item, hint: str | None) -> str:
    lines = [
        "Write one search line for this library item.",
        "Name the subject, the place, and the action.",
        "Plain words only.",
        f"File name: {source.name}",
        f"Kind: {source.kind}",
    ]
    if hint:
        lines.append(hint)
    return "\n".join(lines)


def _clean_description(text: str) -> str | None:
    line = " ".join(text.split()).strip().strip("\"'`")
    if len(line) > 240:
        trimmed = line[:240].rsplit(" ", 1)[0].strip()
        line = trimmed or line[:240].strip()
    if len(line) < 3:
        return None
    return line


def _describe_still(catalog: Catalog, source: Item) -> tuple[bytes, str] | None:
    path = thumb_path(catalog, source.id)
    if path is None:
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None
    suffix = path.suffix.lower()
    mime = {".png": "image/png", ".webp": "image/webp"}.get(suffix, "image/jpeg")
    if len(data) <= _DESCRIBE_STILL_LIMIT:
        return data, mime
    shrunk = _shrink_still(catalog, source.id, path)
    if not shrunk:
        return None
    return shrunk, "image/jpeg"


def _shrink_still(catalog: Catalog, vault_id: str, path: Path) -> bytes | None:
    if shutil.which("ffmpeg") is None:
        return None
    cache = catalog.repo / "sense" / ".cache" / "thumbs"
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    dest = cache / f"{_safe_name(vault_id)}-describe.jpg"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(path), "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", str(dest)],
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or not dest.is_file():
        dest.unlink(missing_ok=True)
        return None
    try:
        data = dest.read_bytes()
    except OSError:
        return None
    if not data or len(data) > _DESCRIBE_STILL_LIMIT:
        return None
    return data


async def _transcript_hint(state: TurnState, source: Item) -> str | None:
    if source.path is None:
        return None
    try:
        result = await _transcribe(state, source.id, None, None)
    except Exception:
        return None
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str) or not text.strip():
        return None
    return f"Transcript: {' '.join(text.split())[:800]}"


async def _describe_once(planner: object, prompt: str, image: tuple[bytes, str] | None) -> str:
    if planner is _gemini_turn or planner is _vertex_turn:
        return await _describe_generate(planner, prompt, image)
    if planner is _do_turn or planner is _e4b_turn:
        return await _describe_chat(planner, prompt, image)
    raise RuntimeError("No describe planner.")


def _describe_parts(prompt: str, image: tuple[bytes, str] | None) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image is not None:
        data, mime = image
        parts.append({"inlineData": {"mimeType": mime, "data": _b64(data)}})
    return parts


def _describe_user_content(prompt: str, image: tuple[bytes, str] | None) -> str | list[dict[str, Any]]:
    if image is None:
        return prompt
    data, mime = image
    return [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{_b64(data)}"}},
    ]


async def _describe_generate(planner: object, prompt: str, image: tuple[bytes, str] | None) -> str:
    if planner is _gemini_turn:
        key = _gemini_api_key()
        if not key:
            raise RuntimeError("Gemini API key is not configured.")
        url = _gemini_url()
        headers = {"x-goog-api-key": key}
        busy = (402, 429, 503)
    else:
        token = _vertex_token()
        if not token:
            raise RuntimeError("Vertex credentials are not available.")
        url = _vertex_url()
        headers = {"Authorization": f"Bearer {token}"}
        busy = (429, 503)
    payload = {
        "contents": [{"role": "user", "parts": _describe_parts(prompt, image)}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 120},
    }
    response = await _post_json(url, headers, payload)
    if response.status_code in busy:
        raise VertexBusy(f"describe returned {response.status_code}.")
    if response.status_code >= 400:
        raise RuntimeError(f"describe returned {response.status_code}.")
    return _gemini_response_text(response.json())


async def _describe_chat(planner: object, prompt: str, image: tuple[bytes, str] | None) -> str:
    if planner is _do_turn:
        key = _do_api_key()
        if not key:
            raise RuntimeError("DigitalOcean model key is not configured.")
        url = do_url()
        headers = {"Authorization": f"Bearer {key}"}
        model = _do_model()
        busy = _DO_BUSY
    else:
        url = e4b_url()
        headers = {}
        model = os.environ.get("SENSE_E4B_MODEL", "gemma-e4b")
        busy = frozenset()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": _describe_user_content(prompt, image)}],
        "temperature": 0.2,
        "max_tokens": 120,
    }
    response = await _post_json(url, headers, payload)
    if response.status_code in busy:
        raise VertexBusy(f"describe returned {response.status_code}.")
    if response.status_code >= 400:
        raise RuntimeError(f"describe returned {response.status_code}.")
    return _openai_response_text(response.json())


async def _post_json(url: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
    async with httpx.AsyncClient(timeout=40) as client:
        return await client.post(url, headers=headers, json=payload)


def _gemini_response_text(data: object) -> str:
    if not isinstance(data, dict):
        return ""
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        return ""
    content = candidates[0].get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return ""
    texts = [part["text"] for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)]
    return " ".join(texts).strip()


def _openai_response_text(data: object) -> str:
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return ""
    return _content_text(message.get("content")).strip()


async def _neighbor_vector(state: TurnState, vault_id: str, source: Item) -> list[float] | None:
    vectors = state.catalog.vectors
    if not _vectors_ready(state.catalog) or vectors is None or vectors.matrix is None:
        return None
    row = matching_row(vectors.ids, vault_id)
    if row is None:
        row = matching_row(vectors.ids, source.id)
    if row is not None:
        return [float(value) for value in vectors.matrix[row]]
    return await _embed_media(source)


def _merge_similar(
    state: TurnState,
    query_vectors: list[list[float] | None],
    kinds: tuple[str, ...],
    k: int,
    exclude: set[str],
) -> list[Item] | None:
    """Per-kind top hits above the search floor. None when no query vector joined the index."""
    vectors = state.catalog.vectors
    if vectors is None or vectors.matrix is None:
        return None
    if all(vector is None for vector in query_vectors):
        return None
    best: dict[str, tuple[Item, float]] = {}
    ran = False
    saw_raw = False
    minimum = min_cosine_score()
    for vector in query_vectors:
        if vector is None:
            continue
        for kind in kinds:
            ranked = cosine(vectors.ids, vectors.matrix, vector, state.by_id, kind, k, exclude)
            if ranked is None or ranked.joined == 0:
                continue
            ran = True
            if ranked.hits:
                saw_raw = True
            for item, score in ranked.hits:
                if score < minimum:
                    continue
                previous = best.get(item.id)
                if previous is None or score > previous[1]:
                    best[item.id] = (item, score)
    if not ran:
        return None
    grouped: dict[str, list[tuple[Item, float]]] = {kind: [] for kind in kinds}
    for item, score in best.values():
        grouped.setdefault(item.kind, []).append((item, score))
    found: list[Item] = []
    for kind in kinds:
        rows = grouped.get(kind) or []
        rows.sort(key=lambda pair: (-pair[1], pair[0].name.lower(), pair[0].id))
        for item, score in rows[:k]:
            state.scores[item.id] = score
            found.append(item)
    state.low_score = saw_raw and not found
    return found


def min_cosine_score() -> float:
    raw = os.environ.get("SENSE_MIN_SCORE")
    if raw is None or not raw.strip():
        return _DEFAULT_MIN_SCORE
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_MIN_SCORE
    if not -1.0 <= value <= 1.0:
        return _DEFAULT_MIN_SCORE
    return value


def _covered_hits(state: TurnState, ranked: CosineRank | None) -> list[Item] | None:
    if ranked is None or ranked.joined == 0:
        return None
    minimum = min_cosine_score()
    kept: list[Item] = []
    for item, score in ranked.hits:
        if score < minimum:
            continue
        state.scores[item.id] = score
        kept.append(item)
    state.low_score = bool(ranked.hits) and not kept
    return kept


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
    start = float(start_s) if isinstance(start_s, (int, float)) and not isinstance(start_s, bool) else None
    end = float(end_s) if isinstance(end_s, (int, float)) and not isinstance(end_s, bool) else None
    try:
        text = await parakeet_text(item.path, start_s=start, end_s=end)
    except ParakeetUnavailable:
        return {"ok": False, "error": "Parakeet is not loaded."}
    return {"ok": True, "text": text}


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
        if state.low_score:
            note = _LOW_SCORE_NOTE
        elif _vectors_ready(catalog):
            note = "No library match."
        else:
            note = "No library match. Embeddings are offline."
    elif mode == "name":
        note = _name_note(catalog)
    else:
        note = ""
    return {"note": note, "mode": mode, "hits": _classify(state)}


class VertexBusy(RuntimeError):
    """A cloud planner should fall through: DigitalOcean auth or capacity, or Gemini/Vertex 402/429/503."""


class OpError(Exception):
    pass


_KNOWN_OPS = frozenset({
    "crossfade", "set_stage", "add_clip", "add_text", "trim", "split", "move",
    "remove", "set_volume", "set_transform", "set_motion", "update_text",
})
_TRANSFORM_NAMES = frozenset({
    "scale", "set_scale", "resize", "set_zoom", "zoom", "zoom_in", "zoomin",
    "zoom_out", "zoomout", "larger", "bigger", "smaller", "make_larger",
    "make_smaller", "enlarge", "shrink", "center", "centre", "set_center",
    "set_centre", "position", "set_position", "move_to", "moveto", "set_xy",
    "translate", "nudge", "rotate", "rotation", "set_rotation", "set_rotate",
    "flip", "turn", "transform", "settransform", "top_left", "top_right",
    "bottom_left", "bottom_right",
})
_SCALE_UP_NAMES = frozenset({
    "zoom_in", "zoomin", "larger", "bigger", "make_larger", "enlarge",
})
_SCALE_DOWN_NAMES = frozenset({
    "zoom_out", "zoomout", "smaller", "make_smaller", "shrink",
})
_SCALE_UP_WORDS = frozenset({
    "larger", "bigger", "enlarge", "in", "zoom_in", "zoomin", "up",
})
_SCALE_DOWN_WORDS = frozenset({
    "smaller", "shrink", "out", "zoom_out", "zoomout", "down",
})
_ANCHORS: dict[str, tuple[float | None, float | None]] = {
    "center": (0.5, 0.5),
    "centre": (0.5, 0.5),
    "middle": (0.5, 0.5),
    "top left": (0.0, 0.0),
    "top-left": (0.0, 0.0),
    "topleft": (0.0, 0.0),
    "upper left": (0.0, 0.0),
    "top right": (1.0, 0.0),
    "top-right": (1.0, 0.0),
    "topright": (1.0, 0.0),
    "upper right": (1.0, 0.0),
    "bottom left": (0.0, 1.0),
    "bottom-left": (0.0, 1.0),
    "bottomleft": (0.0, 1.0),
    "lower left": (0.0, 1.0),
    "bottom right": (1.0, 1.0),
    "bottom-right": (1.0, 1.0),
    "bottomright": (1.0, 1.0),
    "lower right": (1.0, 1.0),
    "top": (None, 0.0),
    "bottom": (None, 1.0),
    "left": (0.0, None),
    "right": (1.0, None),
}
_NAME_ANCHORS = {
    "center": (0.5, 0.5),
    "centre": (0.5, 0.5),
    "set_center": (0.5, 0.5),
    "set_centre": (0.5, 0.5),
    "top_left": (0.0, 0.0),
    "top_right": (1.0, 0.0),
    "bottom_left": (0.0, 1.0),
    "bottom_right": (1.0, 1.0),
}
_MOTION_FROM_NAME = {
    "zoom": "scale",
    "zoom_in": "scale",
    "zoom_out": "scale",
    "scale": "scale",
    "resize": "scale",
    "rotate": "rotation",
    "rotation": "rotation",
    "turn": "rotation",
    "pan": "x",
    "fade": "opacity",
}
_LAYOUT_RE = re.compile(
    r"\b(?:larger|bigger|smaller|enlarge|shrink|zoom|center|centre|rotate|rotation|upside|scale|flip)\b"
    r"|\b(?:move|nudge)\s+(?:it|this|that|the\s+\w+\s+)?(?:left|right|up|down)\b"
    r"|\b(?:put|place)\s+(?:it|this|that|the\s+(?:clip|video|image|title|text))\b[^.]{0,40}\b(?:center|centre|middle|left|right|top|bottom)\b",
    re.IGNORECASE,
)
_SCALE_STEP = 1.5
_NUDGE = 0.1


def _prepare_model_ops(
    raw: list[object],
    timeline: dict[str, Any],
    command: str,
    playhead_s: float | None,
    selected: list[str],
) -> list[object]:
    ops: list[object] = []
    for item in raw:
        if isinstance(item, dict):
            ops.append(_alias_op(item, timeline, command, selected))
        else:
            ops.append(item)
    ops = _apply_layout_intent(ops, command, timeline, selected)
    return _ensure_side_cut(ops, command, timeline, playhead_s, selected)


def _alias_op(raw: dict[str, Any], timeline: dict[str, Any], command: str, selected: list[str]) -> dict[str, Any]:
    name = raw.get("op")
    if not isinstance(name, str):
        return raw
    key = re.sub(r"[\s\-]+", "_", name.strip().lower())
    if key in _KNOWN_OPS:
        if key == "set_transform":
            return _as_transform(raw, key, timeline, command, selected)
        if key == "set_motion":
            copied = dict(raw)
            if copied.get("property") == "zoom":
                copied["property"] = "scale"
            return copied
        if key == "split":
            return _alias_split(raw)
        return raw
    if key in {"delete", "delete_clip"}:
        return {**raw, "op": "remove"}
    if key in {"delete_right", "remove_right", "drop_right", "delete_left", "remove_left", "drop_left"}:
        return {**raw, "op": "remove"}
    if key in {"cut", "split_clip"}:
        return _alias_split({**raw, "op": "split"})
    if _looks_like_motion(raw) and (key in _TRANSFORM_NAMES or key in {"animate", "pan", "fade"}):
        return _as_motion(raw, key, selected)
    if key in _TRANSFORM_NAMES or _unknown_transform(key, raw):
        return _as_transform(raw, key, timeline, command, selected)
    return raw


def _alias_split(raw: dict[str, Any]) -> dict[str, Any]:
    out = dict(raw)
    out["op"] = "split"
    if out.get("at_s") is None:
        for alias in ("time", "time_s", "playhead_s", "t"):
            if out.get(alias) is not None:
                out["at_s"] = out[alias]
                break
    return out


def _unknown_transform(key: str, raw: dict[str, Any]) -> bool:
    if re.search(r"scale|zoom|resize|center|centre|position|rotate|transform|larger|smaller|nudge|flip", key):
        return True
    fields = ("scale", "zoom", "rotation", "degrees", "angle", "rotation_deg", "x", "y", "position", "pos")
    return any(field in raw and raw[field] is not None for field in fields)


def _looks_like_motion(raw: dict[str, Any]) -> bool:
    keys = raw.get("keys")
    if isinstance(keys, list) and len(keys) >= 2:
        return True
    return all(raw.get(key) is not None for key in ("from", "to", "duration_s"))


def _as_motion(raw: dict[str, Any], key: str, selected: list[str]) -> dict[str, Any]:
    prop = raw.get("property")
    if prop == "zoom":
        prop = "scale"
    if not isinstance(prop, str) or not prop.strip():
        prop = _MOTION_FROM_NAME.get(key, "")
    out: dict[str, Any] = {"op": "set_motion", "property": prop}
    clip_id = _text_id(raw.get("clip_id")) or _text_id(raw.get("id"))
    if len(selected) == 1:
        clip_id = selected[0]
    if clip_id:
        out["clip_id"] = clip_id
    for field in ("from", "to", "duration_s", "keys"):
        if field in raw and raw[field] is not None:
            out[field] = raw[field]
    return out


def _as_transform(
    raw: dict[str, Any],
    key: str,
    timeline: dict[str, Any],
    command: str,
    selected: list[str],
) -> dict[str, Any]:
    out: dict[str, Any] = {"op": "set_transform"}
    clip_id = _text_id(raw.get("clip_id")) or _text_id(raw.get("id")) or _text_id(raw.get("target"))
    if len(selected) == 1:
        clip_id = selected[0]
    if clip_id:
        out["clip_id"] = clip_id
    current_scale = _clip_metric(timeline, clip_id, "scale", 1.0)
    if key in {"flip", "upside_down"} or _text_says_upside(raw):
        out["rotation"] = 180.0
    else:
        rotation = _first_present(raw, ("rotation", "degrees", "angle", "deg", "rotation_deg"))
        number = _finite_or_none(rotation)
        if number is not None:
            out["rotation"] = number
    scale_raw = _first_present(raw, ("scale", "zoom", "factor", "size"))
    scale = _scale_value(scale_raw, current_scale)
    if scale is None and key in _SCALE_UP_NAMES:
        scale = _bumped_scale(current_scale, "up")
    if scale is None and key in _SCALE_DOWN_NAMES:
        scale = _bumped_scale(current_scale, "down")
    if scale is not None:
        out["scale"] = scale
    if key in _NAME_ANCHORS:
        _write_anchor(out, _NAME_ANCHORS[key])
    _apply_anchor(out, raw)
    for axis in ("x", "y"):
        value = raw.get(axis)
        if value is None:
            continue
        number = _finite_or_none(value)
        if number is not None:
            out[axis] = number
        elif isinstance(value, str):
            _apply_anchor(out, {"position": value})
    _apply_nudge(out, raw, timeline, command)
    return out


def _apply_layout_intent(
    ops: list[object],
    command: str,
    timeline: dict[str, Any],
    selected: list[str],
) -> list[object]:
    intent = _layout_intent(command)
    if not intent:
        return ops
    transforms = [op for op in ops if isinstance(op, dict) and op.get("op") == "set_transform"]
    if not transforms:
        return ops
    clip_id = _text_id(transforms[0].get("clip_id"))
    if len(selected) == 1:
        clip_id = selected[0]
        for op in transforms:
            op["clip_id"] = clip_id
    current = _clip_metric(timeline, clip_id, "scale", 1.0)
    direction = intent.get("scale")
    if direction == "up" and not any(_scale_compared(op, current, "up") for op in transforms):
        host = next((op for op in transforms if "scale" not in op), transforms[0])
        host["scale"] = _bumped_scale(current, "up")
    elif direction == "down" and not any(_scale_compared(op, current, "down") for op in transforms):
        host = next((op for op in transforms if "scale" not in op), transforms[0])
        host["scale"] = _bumped_scale(current, "down")
    if "x" in intent and not any("x" in op for op in transforms):
        transforms[0]["x"] = intent["x"]
    if "y" in intent and not any("y" in op for op in transforms):
        transforms[0]["y"] = intent["y"]
    if "rotation" in intent and not any("rotation" in op for op in transforms):
        transforms[0]["rotation"] = intent["rotation"]
    nudge = intent.get("nudge")
    if nudge in {"left", "right"} and not any("x" in op for op in transforms):
        _apply_nudge(transforms[0], {"direction": nudge}, timeline, "")
    elif nudge in {"up", "down"} and not any("y" in op for op in transforms):
        _apply_nudge(transforms[0], {"direction": nudge}, timeline, "")
    return ops


def _layout_intent(command: str) -> dict[str, Any]:
    text = command.lower()
    intent: dict[str, Any] = {}
    for phrase, pair in (
        ("top left", (0.0, 0.0)),
        ("top-left", (0.0, 0.0)),
        ("upper left", (0.0, 0.0)),
        ("top right", (1.0, 0.0)),
        ("top-right", (1.0, 0.0)),
        ("upper right", (1.0, 0.0)),
        ("bottom left", (0.0, 1.0)),
        ("bottom-left", (0.0, 1.0)),
        ("lower left", (0.0, 1.0)),
        ("bottom right", (1.0, 1.0)),
        ("bottom-right", (1.0, 1.0)),
        ("lower right", (1.0, 1.0)),
    ):
        if phrase in text:
            intent["x"], intent["y"] = pair
            break
    if "x" not in intent and re.search(r"\b(center|centre|middle)\b", text):
        intent["x"] = 0.5
        intent["y"] = 0.5
    if re.search(r"\b(larger|bigger|enlarge)\b|\bzoom\s+in\b", text):
        intent["scale"] = "up"
    elif re.search(r"\b(smaller|shrink)\b|\bzoom\s+out\b", text):
        intent["scale"] = "down"
    if re.search(r"\bupside\s+down\b|\bflip\b", text):
        intent["rotation"] = 180.0
    elif not re.search(r"\bfrom\b.+\bto\b", text):
        match = re.search(r"\brotate\b[^\d\-]{0,40}(-?\d+(?:\.\d+)?)", text)
        if match:
            intent["rotation"] = float(match.group(1))
    if re.search(r"\b(a bit|a little|slightly|nudge)\b", text):
        for word in ("left", "right", "up", "down"):
            if re.search(rf"\b{word}\b", text):
                intent["nudge"] = word
                break
    return intent


def _ensure_side_cut(
    ops: list[object],
    command: str,
    timeline: dict[str, Any],
    playhead: float | None,
    selected: list[str],
) -> list[object]:
    side = _discarded_side(command)
    if side is None:
        return ops
    wants_cut = re.search(r"\b(?:split|cut)\b", command.lower()) is not None
    has_split = any(isinstance(op, dict) and op.get("op") == "split" for op in ops)
    if not wants_cut and not has_split:
        return ops
    field = "right_id" if side == "right" else "left_id"
    base = "right-half" if side == "right" else "left-half"
    working: list[Any] = [dict(op) if isinstance(op, dict) else op for op in ops]
    if not has_split:
        clip_id = _cut_target(timeline, playhead, selected)
        at = _split_at({}, command, playhead, timeline, clip_id) if clip_id else None
        if clip_id and at is not None:
            working.append({"op": "split", "clip_id": clip_id, "at_s": at})
    used: set[str] = set()
    planned: list[dict[str, Any]] = []
    for op in working:
        if not isinstance(op, dict) or op.get("op") != "split":
            continue
        clip_id = _text_id(op.get("clip_id"))
        if clip_id is None:
            continue
        if len(selected) == 1:
            clip_id = selected[0]
        at = _split_at(op, command, playhead, timeline, clip_id)
        existing = _text_id(op.get(field))
        side_id = existing if existing else _unique_side(base, used)
        used.add(side_id)
        updated = {**op, "op": "split", "clip_id": clip_id, field: side_id}
        if at is not None:
            updated["at_s"] = at
        op.clear()
        op.update(updated)
        planned.append(op)
    if not planned:
        return working
    parent_side = {op.get("clip_id"): op.get(field) for op in planned}
    side_ids = {side_id for side_id in parent_side.values() if isinstance(side_id, str)}
    known = _known_clip_ids(timeline)

    def side_remove_target(op: dict[str, Any]) -> str | None:
        if op.get("op") != "remove":
            return None
        cid = op.get("clip_id")
        if not isinstance(cid, str):
            return None
        if cid in side_ids:
            return cid
        if cid in parent_side and isinstance(parent_side[cid], str):
            return parent_side[cid]
        if cid not in known and len(side_ids) == 1:
            return next(iter(side_ids))
        return None

    output: list[Any] = []
    emitted: set[str] = set()
    planned_ids = {id(op) for op in planned}
    for op in working:
        if isinstance(op, dict) and id(op) in planned_ids:
            output.append(op)
            side_id = parent_side.get(op.get("clip_id"))
            if isinstance(side_id, str) and side_id not in emitted:
                output.append({"op": "remove", "clip_id": side_id})
                emitted.add(side_id)
            continue
        if isinstance(op, dict) and side_remove_target(op) is not None:
            continue
        output.append(op)
    return output


def _discarded_side(command: str) -> str | None:
    text = " ".join(command.lower().split())
    keep_left = re.search(r"\bkeep\b.{0,40}\bleft\b", text) is not None
    keep_right = re.search(r"\bkeep\b.{0,40}\bright\b", text) is not None
    if keep_left and not keep_right:
        return "right"
    if keep_right and not keep_left:
        return "left"
    if re.search(r"\b(?:delete|remove|drop|discard|trash)\b.{0,40}\bright\b", text):
        return "right"
    if re.search(r"\b(?:delete|remove|drop|discard|trash)\b.{0,40}\bleft\b", text):
        return "left"
    if re.search(r"\b(?:everything|the rest|rest)\b.{0,24}\bafter\b|\bafter the cut\b", text):
        return "right"
    if re.search(r"\b(?:everything|the rest|rest)\b.{0,24}\bbefore\b|\bbefore the cut\b", text):
        return "left"
    return None


def _split_at(
    op: dict[str, Any],
    command: str,
    playhead: float | None,
    timeline: dict[str, Any],
    clip_id: str | None,
) -> float | None:
    if clip_id and _mentions_here(command) and _inside(playhead, timeline, clip_id):
        return float(playhead) if playhead is not None else None
    existing = _finite_or_none(op.get("at_s"))
    if existing is not None:
        return existing
    if clip_id and _inside(playhead, timeline, clip_id):
        return float(playhead) if playhead is not None else None
    span = _span(_clip_record(timeline, clip_id) if clip_id else None)
    if span is None:
        return None
    start, end = span
    return (start + end) / 2


def _mentions_here(command: str) -> bool:
    return re.search(r"\b(?:here|playhead)\b", command.lower()) is not None


def _cut_target(timeline: dict[str, Any], playhead: float | None, selected: list[str]) -> str | None:
    if len(selected) == 1:
        return selected[0]
    under = _clip_under_playhead(timeline, playhead)
    if under:
        return under
    for clip in _iter_clips(timeline):
        if clip.get("type") == "video":
            return _text_id(clip.get("alias")) or _text_id(clip.get("id"))
    for clip in _iter_clips(timeline):
        found = _text_id(clip.get("alias")) or _text_id(clip.get("id"))
        if found:
            return found
    return None


def _clip_under_playhead(timeline: dict[str, Any], playhead: float | None) -> str | None:
    if playhead is None:
        return None
    fallback: str | None = None
    for clip in _iter_clips(timeline):
        span = _span(clip)
        if span is None or not (span[0] < playhead < span[1]):
            continue
        found = _text_id(clip.get("alias")) or _text_id(clip.get("id"))
        if clip.get("type") == "video" and found:
            return found
        fallback = fallback or found
    return fallback


def _inside(playhead: float | None, timeline: dict[str, Any], clip_id: str) -> bool:
    if playhead is None:
        return False
    span = _span(_clip_record(timeline, clip_id))
    if span is None:
        return False
    start, end = span
    return start < playhead < end


def _clip_record(timeline: dict[str, Any], clip_id: str | None) -> dict[str, Any] | None:
    if not clip_id:
        return None
    for clip in _iter_clips(timeline):
        if clip_id in {clip.get("id"), clip.get("alias")}:
            return clip
    return None


def _iter_clips(timeline: dict[str, Any]):
    for track in timeline.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips") or []:
            if isinstance(clip, dict):
                yield clip


def _span(clip: dict[str, Any] | None) -> tuple[float, float] | None:
    if clip is None:
        return None
    start = _finite_or_none(clip.get("start_s"))
    duration = _finite_or_none(clip.get("duration_s"))
    if start is None or duration is None or duration <= 0:
        return None
    return start, start + duration


def _known_clip_ids(timeline: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for clip in _iter_clips(timeline):
        for key in ("id", "alias"):
            text = _text_id(clip.get(key))
            if text:
                found.add(text)
    return found


def _clip_metric(timeline: dict[str, Any], clip_id: str | None, key: str, default: float) -> float:
    clip = _clip_record(timeline, clip_id)
    if clip is None:
        return default
    number = _finite_or_none(clip.get(key))
    if number is None or (key == "scale" and number <= 0):
        return default
    return number


def _scale_value(value: object, current: float) -> float | None:
    if isinstance(value, str):
        word = value.strip().lower().replace("-", "_").replace(" ", "_")
        if word in _SCALE_UP_WORDS:
            return _bumped_scale(current, "up")
        if word in _SCALE_DOWN_WORDS:
            return _bumped_scale(current, "down")
    return _finite_or_none(value)


def _bumped_scale(current: float, direction: str) -> float:
    base = current if current > 0 else 1.0
    if direction == "down":
        nxt = base / _SCALE_STEP
        return nxt if 0 < nxt < base else base * 0.5
    return base * _SCALE_STEP


def _scale_compared(op: dict[str, Any], current: float, direction: str) -> bool:
    scale = _finite_or_none(op.get("scale"))
    if scale is None or scale <= 0:
        return False
    if direction == "down":
        return scale < current
    return scale > current


def _apply_anchor(out: dict[str, Any], raw: dict[str, Any]) -> None:
    for key in ("position", "pos", "anchor", "place"):
        value = raw.get(key)
        if isinstance(value, str):
            pair = _anchor_pair(value)
            if pair is not None:
                _write_anchor(out, pair)
                return


def _anchor_pair(value: str) -> tuple[float | None, float | None] | None:
    word = " ".join(value.strip().lower().replace("_", " ").split())
    return _ANCHORS.get(word) or _ANCHORS.get(word.replace(" ", "-")) or _ANCHORS.get(word.replace(" ", ""))


def _write_anchor(out: dict[str, Any], pair: tuple[float | None, float | None]) -> None:
    x, y = pair
    if x is not None:
        out["x"] = x
    if y is not None:
        out["y"] = y


def _apply_nudge(out: dict[str, Any], raw: dict[str, Any], timeline: dict[str, Any], command: str) -> None:
    direction = _nudge_direction(raw, command)
    if direction is None:
        return
    clip_id = _text_id(out.get("clip_id"))
    if direction in {"left", "right"} and _finite_or_none(raw.get("x")) is None:
        current = _clip_metric(timeline, clip_id, "x", 0.5)
        delta = -_NUDGE if direction == "left" else _NUDGE
        out["x"] = _clamp01(current + delta)
    elif direction in {"up", "down"} and _finite_or_none(raw.get("y")) is None:
        current = _clip_metric(timeline, clip_id, "y", 0.5)
        delta = -_NUDGE if direction == "up" else _NUDGE
        out["y"] = _clamp01(current + delta)


def _nudge_direction(raw: dict[str, Any], command: str) -> str | None:
    direction = raw.get("direction") or raw.get("dir")
    if isinstance(direction, str) and direction.strip().lower() in {"left", "right", "up", "down"}:
        return direction.strip().lower()
    blob = f"{raw.get('op', '')} {command}".lower()
    if re.search(r"\b(?:a bit|a little|slightly|nudge)\b", blob) is None:
        return None
    match = re.search(r"\b(left|right|up|down)\b", blob)
    return match.group(1) if match else None


def _text_says_upside(raw: dict[str, Any]) -> bool:
    for key in ("direction", "rotation", "position", "flip"):
        value = raw.get(key)
        if isinstance(value, str) and "upside" in value.lower():
            return True
    return False


def _first_present(raw: dict[str, Any], keys: tuple[str, ...]) -> object:
    for key in keys:
        if key in raw and raw[key] is not None:
            return raw[key]
    return None


def _text_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _unique_side(base: str, used: set[str]) -> str:
    if base not in used:
        return base
    number = 2
    while f"{base}-{number}" in used:
        number += 1
    return f"{base}-{number}"


def _split_side_ids(ops: list[dict[str, Any]]) -> set[str]:
    found: set[str] = set()
    for op in ops:
        if op.get("op") != "split":
            continue
        for key in ("left_id", "right_id"):
            text = _text_id(op.get(key))
            if text:
                found.add(text)
    return found


def _fanned_side_id(ops: list[dict[str, Any]], side_id: str, target: str) -> str:
    for op in ops:
        if op.get("op") != "split":
            continue
        if op.get("right_id") == side_id:
            return f"{target}__right"
        if op.get("left_id") == side_id:
            return f"{target}__left"
    return side_id


def _is_layout_edit(text: str) -> bool:
    return _LAYOUT_RE.search(text) is not None


def _optional_time(value: object) -> float | None:
    number = _finite_or_none(value)
    if number is None or number < 0:
        return None
    return number


def _finite_or_none(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = float(text)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and value == value and value not in (float("inf"), float("-inf")):
        return float(value)
    return None


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def validate_ops(
    raw: object,
    allow: set[str],
    timeline: dict[str, Any] | None = None,
    command: str = "",
    playhead_s: float | None = None,
    selected: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise OpError("ops must be a non-empty list.")
    if len(raw) > 40:
        raise OpError("Too many ops.")
    prepared = _prepare_model_ops(raw, timeline or {}, command, playhead_s, selected or [])
    if len(prepared) > 40:
        raise OpError("Too many ops.")
    return [_validate_op(op, allow) for op in prepared]


def _validate_op(raw: object, allow: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OpError("Each op must be an object.")
    name = raw.get("op")
    if name == "crossfade":
        op = {"op": "crossfade", "from_clip_id": _req_str(raw, "from_clip_id"), "to_clip_id": _req_str(raw, "to_clip_id")}
        _copy_optional(raw, op, ("duration_s",), ())
        if op.get("duration_s", 0.5) <= 0:
            raise OpError("crossfade duration_s must be positive.")
        if op["from_clip_id"] == op["to_clip_id"]:
            raise OpError("crossfade needs two different clips.")
        return op
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
        _validate_text_fields(op)
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
        op = {"op": "set_transform", "clip_id": _req_str(raw, "clip_id")}
        _copy_optional(raw, op, ("rotation", "scale", "x", "y"), ())
        if not any(key in op for key in ("rotation", "scale", "x", "y")):
            raise OpError("set_transform needs rotation, scale, x, or y.")
        if "scale" in op and op["scale"] <= 0:
            raise OpError("scale must be positive.")
        for key in ("x", "y"):
            if key in op and not 0 <= op[key] <= 1:
                raise OpError(f"{key} must be between 0 and 1.")
        return op
    if name == "set_motion":
        property_name = _req_str(raw, "property")
        if property_name == "zoom":
            property_name = "scale"
        if property_name not in {"rotation", "scale", "x", "y", "opacity"}:
            raise OpError("property must be rotation, scale, x, y, or opacity.")
        keys = _motion_keys(raw)
        for key in keys:
            if key["t_s"] < 0:
                raise OpError("Motion times must be non-negative.")
            _check_motion_value(property_name, key["value"])
        keys.sort(key=lambda key: key["t_s"])
        return {"op": "set_motion", "clip_id": _req_str(raw, "clip_id"), "property": property_name, "keys": keys}
    if name == "set_volume":
        volume = _req_num(raw, "volume")
        if volume < 0 or volume > 1:
            raise OpError("volume must be between 0 and 1.")
        return {"op": "set_volume", "clip_id": _req_str(raw, "clip_id"), "volume": volume}
    if name == "update_text":
        if "content" not in raw and isinstance(raw.get("text"), str):
            raw = {**raw, "content": raw["text"]}
        op = {"op": "update_text", "clip_id": _req_str(raw, "clip_id")}
        _copy_optional(raw, op, ("start_s", "duration_s", "font_size", "x", "y", "background_opacity"), ("content", "color", "background"))
        _validate_text_fields(op)
        if len(op) == 2:
            raise OpError("update_text needs a field to change.")
        return op
    raise OpError("Unknown op.")


def _validate_text_fields(op: dict[str, Any]) -> None:
    for key in ("start_s", "duration_s", "font_size"):
        if key in op and (op[key] < 0 or (key != "start_s" and op[key] == 0)):
            raise OpError(f"{key} must be {'non-negative' if key == 'start_s' else 'positive'}.")
    for key in ("x", "y", "background_opacity"):
        if key in op and not 0 <= op[key] <= 1:
            raise OpError(f"{key} must be between 0 and 1.")


def _motion_keys(raw: dict[str, Any]) -> list[dict[str, float]]:
    if "keys" in raw and raw["keys"] is not None:
        keys = raw["keys"]
        if not isinstance(keys, list) or not 2 <= len(keys) <= 16:
            raise OpError("set_motion needs two to sixteen keys.")
        parsed: list[dict[str, float]] = []
        for item in keys:
            if not isinstance(item, dict):
                raise OpError("Each key needs t_s and value.")
            parsed.append({"t_s": _req_num(item, "t_s"), "value": _req_num(item, "value")})
        return parsed
    if all(raw.get(key) is not None for key in ("from", "to", "duration_s")):
        duration = _req_num(raw, "duration_s")
        if duration <= 0:
            raise OpError("duration_s must be positive.")
        return [{"t_s": 0.0, "value": _req_num(raw, "from")}, {"t_s": duration, "value": _req_num(raw, "to")}]
    raise OpError("set_motion needs keys, or from, to, and duration_s.")


def _check_motion_value(property_name: str, value: float) -> None:
    if property_name == "scale" and value <= 0:
        raise OpError("scale must be positive.")
    if property_name in {"x", "y", "opacity"} and not 0 <= value <= 1:
        raise OpError(f"{property_name} must be between 0 and 1.")


def _copy_optional(raw: dict[str, Any], op: dict[str, Any], numbers: tuple[str, ...], strings: tuple[str, ...]) -> None:
    for key in numbers:
        if key in raw and raw[key] is not None:
            op[key] = _req_num(raw, key)
    for key in strings:
        if key in raw and raw[key] is not None:
            op[key] = _req_str(raw, key)



_EDIT_TOKENS = (
    "trim", "cut", "split", "move", "remove", "delete", "rotate", "rotation", "volume",
    "mute", "text", "title", "caption", "subtitle", "export", "fade", "crossfade", "speed", "zoom", "scale",
    "pan", "opacity", "animate", "animation", "extend", "lengthen", "spin",
    "larger", "bigger", "smaller", "center", "centre", "flip",
)
_FIND_TOKENS = ("find", "search", "look for", "show me", "footage", "clip of", "video of")
_SELECTION_OPS = frozenset({"trim", "set_transform", "set_motion", "remove", "split"})
_PLACE_RE = re.compile(r"\b(?:place|put|drop|insert)\b|\badd\b(?!\s+(?:a\s+)?(?:title|text|caption|subtitle)s?\b)")


def _has_token(text: str, token: str) -> bool:
    if " " in token:
        return token in text
    return re.search(rf"\b{re.escape(token)}\b", text) is not None


def _has_any(text: str, tokens: tuple[str, ...]) -> bool:
    return any(_has_token(text, token) for token in tokens)


def _wants_place(text: str) -> bool:
    if re.search(r"\b(?:place|add|insert|drop)\b", text):
        return _PLACE_RE.search(text) is not None
    if _is_layout_edit(text) and not _has_any(text, _FIND_TOKENS):
        return False
    return _PLACE_RE.search(text) is not None


def _blocks_search(command: str) -> bool:
    text = command.lower()
    if _wants_place(text) or _has_any(text, _FIND_TOKENS):
        return False
    if _is_layout_edit(text):
        return True
    return _has_any(text, _EDIT_TOKENS)


def _wants_search_fallback(command: str) -> bool:
    text = command.lower()
    if _has_any(text, _EDIT_TOKENS):
        return False
    return _has_any(text, _FIND_TOKENS)


def _selected_ids(body: dict[str, Any]) -> list[str]:
    raw = body.get("selected_clip_ids")
    if not isinstance(raw, list):
        return []
    ids: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        clip_id = item.strip()
        if clip_id and clip_id not in ids:
            ids.append(clip_id)
        if len(ids) == 40:
            break
    return ids


def fan_selected_ops(ops: list[dict[str, Any]], selected: list[str]) -> list[dict[str, Any]]:
    """Copy selection ops onto every selected id when several clips are selected.

    One selected id keeps the miss-only rule: rewrite a foreign clip_id, and
    leave an id that is already selected alone. Two or more selected ids also
    rewrite an op that already names one of them. move is never copied.
    A remove of a split's left_id or right_id stays on that half. Rewriting it
    to the parent clip deletes both halves.
    """
    if not selected:
        return ops
    chosen = set(selected)
    multi = len(selected) >= 2
    side_ids = _split_side_ids(ops)
    rewritten: list[dict[str, Any]] = []
    for op in ops:
        name = op.get("op")
        clip_id = op.get("clip_id")
        if isinstance(clip_id, str) and clip_id in side_ids:
            if not multi:
                rewritten.append(op)
                continue
            for target in selected:
                rewritten.append({**op, "clip_id": _fanned_side_id(ops, clip_id, target)})
            continue
        if name not in _SELECTION_OPS or not isinstance(clip_id, str) or (clip_id in chosen and not multi):
            rewritten.append(op)
            continue
        for target in selected:
            cloned = {**op, "clip_id": target}
            if name == "split" and multi:
                for key, label in (("right_id", "right"), ("left_id", "left")):
                    current = op.get(key)
                    if isinstance(current, str) and current in side_ids:
                        cloned[key] = f"{target}__{label}"
            rewritten.append(cloned)
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for op in rewritten:
        key = json.dumps(op, sort_keys=True, separators=(",", ":"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(op)
    return unique


_EXTEND_ANIMATION_RE = re.compile(
    r"\b(?:extend|lengthen|stretch|make)\b.{0,60}?\b(rotation|spin|turning|turn|animation|motion|zoom|scale|pan|opacity|fade)\b.{0,40}?\b(\d+(?:\.\d+)?)\s*(?:seconds|second|secs|sec|s)\b",
    re.IGNORECASE,
)
_EXTEND_KIND = {
    "rotation": "rotation",
    "spin": "rotation",
    "turn": "rotation",
    "turning": "rotation",
    "zoom": "scale",
    "scale": "scale",
    "pan": "pan",
    "opacity": "opacity",
    "fade": "opacity",
    "animation": "all",
    "motion": "all",
}
_MOTION_NAMES = ("rotation", "scale", "x", "y", "opacity")


def steer_extend_animation(
    command: str,
    timeline: dict[str, Any],
    ops: list[dict[str, Any]],
    selected: list[str],
) -> list[dict[str, Any]]:
    """Map "extend the rotation to N seconds" onto set_motion.

    A duration trim cannot lengthen a still: its source window is the placed
    length. Keep the current endpoints and stretch the key times to N. The host
    then grows an image, or a video out-point that still fits in the file.
    """
    parsed = _parse_extend_animation(command)
    if parsed is None:
        return ops
    kind, duration = parsed
    clip_ids: list[str] = []
    for clip_id in selected:
        if clip_id not in clip_ids:
            clip_ids.append(clip_id)
    if not clip_ids:
        for op in ops:
            clip_id = op.get("clip_id")
            if isinstance(clip_id, str) and clip_id not in clip_ids and op.get("op") in {"trim", "set_motion", "set_transform"}:
                clip_ids.append(clip_id)
    if not clip_ids:
        for clip in _iter_timeline_clips(timeline):
            alias = clip.get("alias") if isinstance(clip.get("alias"), str) and clip.get("alias") else clip.get("id")
            if isinstance(alias, str) and alias not in clip_ids:
                clip_ids.append(alias)
    motions: list[tuple[str, str, list[dict[str, float]]]] = []
    for clip_id in clip_ids:
        for prop in _extend_properties(kind, timeline, ops, clip_id):
            keys = _op_motion_keys(ops, clip_id, prop) or _timeline_motion_keys(timeline, clip_id, prop)
            if not keys:
                continue
            motions.append((clip_id, prop, _stretch_motion_keys(keys, duration)))
    if not motions:
        return ops
    kept: list[dict[str, Any]] = []
    for op in ops:
        if op.get("op") == "set_motion" and any(op.get("clip_id") == clip_id and op.get("property") == prop for clip_id, prop, _keys in motions):
            continue
        if op.get("op") == "trim" and _matches_extend_trim(op, duration):
            continue
        kept.append(op)
    for clip_id, prop, keys in motions:
        kept.append({"op": "set_motion", "clip_id": clip_id, "property": prop, "keys": keys})
    return kept


def _parse_extend_animation(command: str) -> tuple[str, float] | None:
    match = _EXTEND_ANIMATION_RE.search(command)
    if match is None:
        return None
    kind = _EXTEND_KIND.get(match.group(1).lower())
    if kind is None:
        return None
    duration = float(match.group(2))
    if duration <= 0:
        return None
    return kind, duration


def _extend_properties(kind: str, timeline: dict[str, Any], ops: list[dict[str, Any]], clip_id: str) -> list[str]:
    if kind == "all":
        names = _MOTION_NAMES
    elif kind == "pan":
        names = ("x", "y")
    else:
        names = (kind,)
    return [name for name in names if _op_motion_keys(ops, clip_id, name) or _timeline_motion_keys(timeline, clip_id, name)]


def _iter_timeline_clips(timeline: dict[str, Any]) -> list[dict[str, Any]]:
    clips: list[dict[str, Any]] = []
    tracks = timeline.get("tracks") if isinstance(timeline, dict) else None
    if not isinstance(tracks, list):
        return clips
    for track in tracks:
        if not isinstance(track, dict):
            continue
        rows = track.get("clips")
        if not isinstance(rows, list):
            continue
        for clip in rows:
            if isinstance(clip, dict):
                clips.append(clip)
    return clips


def _clip_matches(clip: dict[str, Any], clip_id: str) -> bool:
    return clip.get("alias") == clip_id or clip.get("id") == clip_id


def _timeline_motion_keys(timeline: dict[str, Any], clip_id: str, prop: str) -> list[dict[str, float]] | None:
    for clip in _iter_timeline_clips(timeline):
        if not _clip_matches(clip, clip_id):
            continue
        motion = clip.get("motion")
        if not isinstance(motion, dict):
            return None
        return _motion_key_rows(motion.get(prop))
    return None


def _op_motion_keys(ops: list[dict[str, Any]], clip_id: str, prop: str) -> list[dict[str, float]] | None:
    found: list[dict[str, float]] | None = None
    for op in ops:
        if op.get("op") == "set_motion" and op.get("clip_id") == clip_id and op.get("property") == prop:
            found = _motion_key_rows(op.get("keys")) or found
    return found


def _motion_key_rows(raw: object) -> list[dict[str, float]] | None:
    if not isinstance(raw, list) or len(raw) < 2:
        return None
    keys: list[dict[str, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        t_s = item.get("t_s", item.get("t"))
        value = item.get("value")
        if isinstance(t_s, bool) or isinstance(value, bool):
            return None
        if not isinstance(t_s, (int, float)) or not isinstance(value, (int, float)):
            return None
        keys.append({"t_s": float(t_s), "value": float(value)})
    keys.sort(key=lambda key: key["t_s"])
    return keys


def _stretch_motion_keys(keys: list[dict[str, float]], duration: float) -> list[dict[str, float]]:
    ordered = sorted(keys, key=lambda key: key["t_s"])
    last = ordered[-1]["t_s"]
    if last <= 0 or abs(last - duration) < 1e-9:
        stretched = [{"t_s": key["t_s"], "value": key["value"]} for key in ordered]
        stretched[-1]["t_s"] = duration
        return stretched
    scale = duration / last
    stretched = [{"t_s": key["t_s"] * scale, "value": key["value"]} for key in ordered]
    stretched[-1]["t_s"] = duration
    return stretched


def _matches_extend_trim(op: dict[str, Any], duration: float) -> bool:
    if op.get("op") != "trim" or "in_s" in op:
        return False
    start = op.get("start_s")
    if start not in (None, 0, 0.0):
        return False
    span = op.get("duration_s")
    if isinstance(span, bool) or not isinstance(span, (int, float)):
        return False
    return abs(float(span) - duration) < 1e-6


def _req_str(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise OpError(f"{key} is required.")
    if len(value) > 500:
        raise OpError(f"{key} is too long.")
    return value.strip()


def _req_num(raw: dict[str, Any], key: str) -> float:
    value = raw.get(key)
    if isinstance(value, bool):
        raise OpError(f"{key} must be a number.")
    if isinstance(value, str):
        value = value.strip()
        if not value:
            raise OpError(f"{key} must be a number.")
        try:
            value = float(value)
        except ValueError as error:
            raise OpError(f"{key} must be a number.") from error
    if not isinstance(value, (int, float)):
        raise OpError(f"{key} must be a number.")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise OpError(f"{key} must be finite.")
    return number


def _modality(value: object) -> str | None:
    return infer_modality("", value)


def _k(value: object) -> int:
    number = value
    if isinstance(number, str):
        try:
            number = float(number.strip())
        except ValueError:
            number = None
    if isinstance(number, bool) or not isinstance(number, (int, float)):
        return 8
    if number != number or number in (float("inf"), float("-inf")):
        return 8
    return max(1, min(12, int(number)))


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


def _do_model() -> str:
    model = os.environ.get("SENSE_DO_MODEL", "gemma-4-31B-it").strip()
    return model or "gemma-4-31B-it"


def do_url() -> str:
    url = os.environ.get("SENSE_DO_URL", "").strip()
    return url or "https://inference.do-ai.run/v1/chat/completions"


def _do_api_key() -> str | None:
    value = os.environ.get("DO_MODEL_KEY", "").strip()
    return value or None


def do_configured() -> bool:
    """True when DO_MODEL_KEY is set. The key itself is never returned."""
    return _do_api_key() is not None


def _do_enabled() -> bool:
    return os.environ.get("SENSE_DO", "1") != "0" and do_configured()


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
    prompt = query_input(text)
    if not prompt or not await _mlx_up():
        return None
    url = os.environ.get("SENSE_MLX_EMBED_URL", f"{mlx_origin()}/v1/embeddings")
    payload = {"model": os.environ.get("SENSE_EMBED_MODEL", "embeddinggemma"), "input": prompt}
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
