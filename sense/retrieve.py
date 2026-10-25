"""Lexical match, and cosine match when a real embedding matrix is loaded."""

from __future__ import annotations

import math
import re

from sense.catalog import Item

_TOKEN = re.compile(r"[a-z0-9]+")


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


def cosine(ids: list[str], matrix: object, query: list[float], items_by_id: dict[str, Item], modality: str | None, k: int, exclude: set[str] | None = None) -> list[tuple[Item, float]] | None:
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
    hits: list[tuple[Item, float]] = []
    for index in order:
        vault_id = ids[int(index)]
        if exclude and vault_id in exclude:
            continue
        item = items_by_id.get(vault_id)
        if item is None:
            continue
        if modality and item.kind != modality:
            continue
        score = float(scores[int(index)])
        if math.isnan(score):
            continue
        hits.append((item, score))
        if len(hits) >= k:
            break
    return hits


def _hit(hay: set[str], token: str) -> bool:
    if token in hay:
        return True
    if len(token) < 4:
        return False
    return any(word.startswith(token) or token.startswith(word) for word in hay if len(word) >= 4)
