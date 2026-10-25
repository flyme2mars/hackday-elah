"""Vault catalog. Ids come from an index file, a real path, or a bundled filename."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

MEDIA_EXT = {
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".mkv": "video",
    ".m4v": "video",
    ".m4a": "audio",
    ".wav": "audio",
    ".mp3": "audio",
    ".aac": "audio",
    ".flac": "audio",
    ".ogg": "audio",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".gif": "image",
}

SKIP_DIRS = {".git", "node_modules", ".cache", "__pycache__", ".venv"}
LIBRARY_CAP = 300
SCAN_CAP = 5000

BUNDLED = (
    ("flower.mp4", "video", "Flower", 5.005, "public/samples/flower.mp4"),
    ("bunny.mp4", "video", "Bunny", 8.0, "public/samples/bunny.mp4"),
    ("bed.m4a", "audio", "Bed", 8.0, "public/samples/bed.m4a"),
)


@dataclass(frozen=True)
class Item:
    id: str
    name: str
    kind: str
    path: Path | None
    duration_s: float | None
    servable: bool


@dataclass
class Vectors:
    ids: list[str]
    matrix: object
    keys: list[str]
    error: str | None = None


class Catalog:
    def __init__(self, root: Path, repo: Path, items: list[Item], index_json: Path | None, vectors: Vectors | None, truncated: bool):
        self.root = root
        self.repo = repo
        self.items = items
        self.index_json = index_json
        self.vectors = vectors
        self.truncated = truncated
        self.by_id = {item.id: item for item in items}

    @classmethod
    def load(cls) -> Catalog:
        repo = Path(__file__).resolve().parents[1]
        raw = os.environ.get("SENSE_VAULT", str(Path.home() / "HackDayVault"))
        root = Path(raw).expanduser()
        items: list[Item] = []
        index_json: Path | None = None
        truncated = False
        if root.is_dir():
            index_json = newest(root, "vault_index_*.json")
            if index_json is not None:
                items, truncated = items_from_json(root, index_json)
            if not items:
                items, truncated = items_from_scan(root)
        npz = newest(root, "vault_index_*.npz") if root.is_dir() else None
        vectors = load_vectors(npz) if npz is not None else None
        return cls(root, repo, items, index_json, vectors, truncated)

    def bundled(self) -> list[Item]:
        found: list[Item] = []
        for vault_id, kind, name, duration, rel in BUNDLED:
            path = self.repo / rel
            if path.is_file():
                found.append(Item(vault_id, name, kind, path, duration, False))
        return found

    def item_for_tool(self, vault_id: str) -> Item | None:
        item = self.by_id.get(vault_id)
        if item is not None:
            return item
        for bundled in self.bundled():
            if bundled.id == vault_id:
                return bundled
        return None


def newest(root: Path, pattern: str) -> Path | None:
    matches = [path for path in root.glob(pattern) if path.is_file()]
    nested = [path for path in root.glob(f"**/{pattern}") if path.is_file() and path not in matches]
    matches.extend(nested)
    if not matches:
        return None
    return max(matches, key=lambda path: path.stat().st_mtime)


def items_from_json(root: Path, path: Path) -> tuple[list[Item], bool]:
    import json

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [], False
    records = data if isinstance(data, list) else None
    if records is None and isinstance(data, dict):
        for key in ("items", "assets", "clips", "records"):
            if isinstance(data.get(key), list):
                records = data[key]
                break
    if not records:
        return [], False
    items: list[Item] = []
    seen: set[str] = set()
    truncated = len(records) > SCAN_CAP
    for record in records[:SCAN_CAP]:
        item = item_from_record(root, record)
        if item is None or item.id in seen:
            continue
        seen.add(item.id)
        items.append(item)
    return items, truncated


def item_from_record(root: Path, record: object) -> Item | None:
    if not isinstance(record, dict):
        return None
    raw_path = record.get("path") or record.get("file") or record.get("src")
    path = resolve_under(root, raw_path) if isinstance(raw_path, str) else None
    raw_id = record.get("id") or record.get("vault_id")
    root_resolved = root.resolve()
    if isinstance(raw_id, str) and raw_id.strip():
        candidate = raw_id.strip().replace("\\", "/")
        try:
            as_path = Path(candidate).expanduser()
            if as_path.is_absolute():
                resolved = as_path.resolve()
                if resolved.is_relative_to(root_resolved):
                    raw_id = resolved.relative_to(root_resolved).as_posix()
                else:
                    raw_id = candidate
            else:
                raw_id = candidate.lstrip("./")
        except (OSError, ValueError):
            raw_id = candidate
    else:
        if path is None:
            return None
        raw_id = path.relative_to(root_resolved).as_posix()
    kind = record.get("kind") or record.get("modality")
    if isinstance(kind, str) and kind.lower() in ("still", "stills", "photo", "picture"):
        kind = "image"
    if not isinstance(kind, str) or kind not in ("video", "audio", "image"):
        kind = MEDIA_EXT.get(path.suffix.lower(), "") if path is not None else ""
    if kind not in ("video", "audio", "image"):
        return None
    name = record.get("name") or record.get("label")
    if not isinstance(name, str) or not name.strip():
        name = path.name if path is not None else Path(raw_id).name
    duration = record.get("duration_s", record.get("duration"))
    duration_s = float(duration) if isinstance(duration, (int, float)) and not isinstance(duration, bool) else None
    return Item(raw_id, name.strip(), kind, path, duration_s, path is not None)


def items_from_scan(root: Path) -> tuple[list[Item], bool]:
    items: list[Item] = []
    truncated = False
    root_resolved = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root_resolved):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS and not name.startswith(".")]
        for filename in filenames:
            if filename.startswith("."):
                continue
            kind = MEDIA_EXT.get(Path(filename).suffix.lower())
            if kind is None:
                continue
            path = (Path(dirpath) / filename).resolve()
            if not path.is_file() or not path.is_relative_to(root_resolved):
                continue
            rel = path.relative_to(root_resolved).as_posix()
            items.append(Item(rel, path.stem, kind, path, None, True))
            if len(items) >= SCAN_CAP:
                truncated = True
                return items, truncated
    return items, truncated


def resolve_under(root: Path, raw: str) -> Path | None:
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    root_resolved = root.resolve()
    if not resolved.is_file() or not resolved.is_relative_to(root_resolved):
        return None
    return resolved


def load_vectors(path: Path) -> Vectors:
    try:
        import numpy as np
    except ImportError:
        return Vectors([], None, [], "numpy is not installed")
    try:
        # Object string ids need pickle; float embeddings do not care.
        data = np.load(path, allow_pickle=True)
        keys = list(data.files)
        id_key = next((key for key in ("ids", "vault_ids", "vault_id", "names") if key in data.files), None)
        emb_key = next((key for key in ("embeddings", "vectors", "emb", "X") if key in data.files), None)
        if id_key is None or emb_key is None:
            return Vectors([], None, keys, "index is missing ids or embeddings")
        matrix = np.asarray(data[emb_key], dtype="float32")
        raw_ids = data[id_key]
        if matrix.ndim != 2 or len(raw_ids) != matrix.shape[0]:
            return Vectors([], None, keys, "index shape does not match ids")
        ids = [_as_str(value) for value in raw_ids]
        return Vectors(ids, matrix, keys, None)
    except Exception as error:
        return Vectors([], None, [], f"could not read {path.name}: {error}")


def _as_str(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)
