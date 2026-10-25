"""Lexical match, and cosine match when a real embedding matrix is loaded."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

from sense.catalog import MEDIA_EXT, Item, Vectors, normalize_kind, resolve_under

_TOKEN = re.compile(r"[a-z0-9]+")

EMBEDDINGGEMMA_RETRIEVAL_QUERY = "task: search result | query: "
_QUERY_NOISE = frozenset({
    "find", "search", "look", "for", "show", "me", "please",
    "footage", "clip", "clips", "video", "videos", "of", "the", "a", "an",
    "some", "any", "like", "this", "that", "with",
})
_VIDEO = frozenset({"video", "videos", "footage", "clip", "clips", "movie", "film", "shot", "shots"})
_AUDIO = frozenset({"audio", "sound", "music", "song", "songs", "soundtrack", "voiceover", "narration"})
_IMAGE = frozenset({"image", "images", "photo", "photos", "picture", "pictures", "still", "stills"})


@dataclass(frozen=True)
class CosineRank:
    hits: list[tuple[Item, float]]
    joined: int


def lexical(items: list[Item], query: str, modality: str | None, k: int, exclude: set[str] | None = None) -> list[Item]:
    tokens = [token for token in _TOKEN.findall(query.lower()) if len(token) > 1]
    if not tokens:
        return []
    scored: list[tuple[int, str, Item]] = []
    for item in items:
        if modality and item.kind != modality:
            continue
        if exclude and item.id in exclude:
            continue
        hay = set(_TOKEN.findall(f"{item.name} {item.id}".lower()))
        score = sum(1 for token in tokens if _hit(hay, token))
        if score:
            scored.append((score, item.name.lower(), item))
    scored.sort(key=lambda row: (-row[0], row[1]))
    return [item for _, _, item in scored[:k]]


def query_input(text: str) -> str:
    raw = " ".join(text.split())
    if not raw:
        return ""
    if raw.lower().startswith("task:"):
        return raw
    kept = [token for token in _TOKEN.findall(raw.lower()) if token not in _QUERY_NOISE]
    body = " ".join(kept) if kept else raw
    return f"{EMBEDDINGGEMMA_RETRIEVAL_QUERY}{body}"


def infer_modality(query: str, explicit: object = None) -> str | None:
    named = _named_modality(explicit)
    if named is not None:
        return named
    tokens = set(_TOKEN.findall(query.lower()))
    if tokens & _IMAGE:
        return "image"
    if tokens & _AUDIO:
        return "audio"
    if tokens & _VIDEO:
        return "video"
    return None


def with_unjoined_index_items(root: Path, items: list[Item], vectors: Vectors | None) -> list[Item]:
    if vectors is None or vectors.matrix is None or not vectors.ids:
        return items
    lookup = _build_lookup({item.id: item for item in items})
    extras: list[Item] = []
    seen = {item.id for item in items}
    kinds = vectors.kinds
    for index, raw_id in enumerate(vectors.ids):
        if raw_id in seen or _resolve_item(raw_id, lookup) is not None:
            continue
        raw_kind = kinds[index] if kinds is not None and index < len(kinds) and kinds[index] else None
        item = _item_for_index_id(root, raw_id, normalize_kind(raw_kind) if raw_kind else None)
        if item is None or item.id in seen:
            continue
        seen.add(item.id)
        extras.append(item)
        for alias in _alias_keys(item.id):
            lookup.setdefault(alias, item)
    if not extras:
        return items
    return [*items, *extras]


def _item_for_index_id(root: Path, vault_id: str, kind: str | None) -> Item | None:
    path = resolve_under(root, vault_id)
    if kind not in ("video", "audio", "image"):
        suffix = path.suffix.lower() if path is not None else Path(vault_id).suffix.lower()
        kind = MEDIA_EXT.get(suffix)
    if kind not in ("video", "audio", "image"):
        return None
    name = Path(vault_id).stem or vault_id
    return Item(vault_id, name, kind, path, None, path is not None)


def matching_row(ids: list[str], vault_id: str) -> int | None:
    norm = _norm_id(vault_id)
    exact = [index for index, raw in enumerate(ids) if raw == vault_id or _norm_id(raw) == norm]
    if exact:
        return exact[0]
    wanted = set(_alias_keys(vault_id))
    found = [index for index, raw in enumerate(ids) if wanted & set(_alias_keys(raw))]
    if len(found) == 1:
        return found[0]
    return None


def cosine(
    ids: list[str],
    matrix: object,
    query: list[float],
    items_by_id: dict[str, Item],
    modality: str | None,
    k: int,
    exclude: set[str] | None = None,
) -> CosineRank | None:
    try:
        import numpy as np
    except ImportError:
        return None
    vector = np.asarray(query, dtype="float32")
    if vector.ndim != 1 or vector.shape[0] != matrix.shape[1]:
        return None
    denom = float(np.linalg.norm(vector))
    if denom == 0 or math.isnan(denom):
        return None
    vector = vector / denom
    norms = np.linalg.norm(matrix, axis=1)
    safe = np.maximum(norms, 1e-9)
    scores = (matrix / safe[:, None]) @ vector
    order = np.argsort(-scores)
    lookup = _build_lookup(items_by_id)
    hits: list[tuple[Item, float]] = []
    seen: set[str] = set()
    joined = 0
    for index in order:
        raw_id = ids[int(index)]
        item = _resolve_item(raw_id, lookup)
        if item is None:
            continue
        joined += 1
        if exclude and (raw_id in exclude or item.id in exclude):
            continue
        if item.id in seen:
            continue
        if modality and item.kind != modality:
            continue
        score = float(scores[int(index)])
        if math.isnan(score):
            continue
        seen.add(item.id)
        hits.append((item, score))
        if len(hits) >= k:
            break
    return CosineRank(hits, joined)


def _hit(hay: set[str], token: str) -> bool:
    if token in hay:
        return True
    if len(token) < 4:
        return False
    return any(word.startswith(token) or token.startswith(word) for word in hay if len(word) >= 4)


def _named_modality(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    token = value.strip().lower()
    if token in _VIDEO:
        return "video"
    if token in _AUDIO:
        return "audio"
    if token in _IMAGE:
        return "image"
    return None


def _norm_id(vault_id: str) -> str:
    return vault_id.replace("\\", "/").strip().lstrip("./")


def _alias_keys(vault_id: str) -> tuple[str, ...]:
    norm = _norm_id(vault_id)
    filename = norm.rsplit("/", 1)[-1]
    parent = norm[: -len(filename)].rstrip("/") if "/" in norm else ""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    keys = [norm]
    path_stem = f"{parent}/{stem}" if parent else stem
    if path_stem not in keys:
        keys.append(path_stem)
    if stem not in keys:
        keys.append(stem)
    return tuple(keys)


def _build_lookup(items_by_id: dict[str, Item]) -> dict[str, Item]:
    buckets: dict[str, dict[str, Item]] = {}
    for key, item in items_by_id.items():
        for alias in _alias_keys(key):
            buckets.setdefault(alias, {})[item.id] = item
    lookup: dict[str, Item] = {}
    for alias, items in buckets.items():
        if len(items) == 1:
            lookup[alias] = next(iter(items.values()))
    return lookup


def _resolve_item(vault_id: str, lookup: dict[str, Item]) -> Item | None:
    for key in _alias_keys(vault_id):
        item = lookup.get(key)
        if item is not None:
            return item
    return None
