from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from sense.catalog import LIBRARY_CAP, Catalog, Item, Vectors, load_vectors
from sense.planner import Call, _embed_text, library_payload, media_path, run_command, run_similar, search_only
from sense.retrieve import cosine

UPLOAD_SIMILAR_NOTE = "Find similar works on vault clips. Browser uploads are not on disk for EmbeddingGemma yet."


def _item(vault_id: str, name: str, kind: str) -> Item:
    return Item(vault_id, name, kind, Path("/tmp") / Path(vault_id).name, 4.0, True)


def library_catalog() -> Catalog:
    beach = _item("video/beach.mp4", "Beach", "video")
    phone = _item("video/c2339.mp4", "c2339", "video")
    ocean_audio = _item("audio/ocean.m4a", "ocean", "audio")
    phone_still = _item("stills/phone.jpg", "phone", "image")
    items = [beach, phone, ocean_audio, phone_still]
    matrix = np.asarray(
        [
            [0.9, 0.2],
            [0.2, 0.45],
            [1.0, 0.0],
            [0.0, 1.0],
        ],
        dtype="float32",
    )
    ids = [item.id for item in items]
    return Catalog(Path("/tmp"), Path("/tmp"), items, None, Vectors(ids, matrix, ids), False)


def _loaded(items: list[Item], rows: list[list[float]]) -> Catalog:
    matrix = np.asarray(rows, dtype="float32")
    ids = [item.id for item in items]
    return Catalog(Path("/tmp"), Path("/tmp"), items, None, Vectors(ids, matrix, ids), False)


def offline_catalog() -> Catalog:
    loaded = library_catalog()
    return Catalog(loaded.root, loaded.repo, loaded.items, None, None, False)


def alias_catalog() -> Catalog:
    beach = _item("video/beach.mp4", "Beach", "video")
    phone = _item("video/c2339.mp4", "Phone", "video")
    items = [beach, phone]
    matrix = np.asarray([[1.0, 0.0], [0.9, 0.1]], dtype="float32")
    return Catalog(
        Path("/tmp"),
        Path("/tmp"),
        items,
        None,
        Vectors(["video/beach", "video/c2339"], matrix, ["video/beach", "video/c2339"]),
        False,
    )


def timeline() -> dict:
    return {
        "tracks": [
            {
                "alias": "V1",
                "name": "V1",
                "kind": "video",
                "clips": [{"id": "engine-id", "alias": "c1", "type": "video", "start_s": 1, "duration_s": 8}],
            },
        ]
    }


async def _axis(_text: str) -> list[float]:
    return [1.0, 0.0]


async def _ocean_or_phone(text: str) -> list[float] | None:
    lowered = text.lower()
    if "phone" in lowered:
        return [0.0, 1.0]
    return [1.0, 0.0]


def _ids(result: dict, kind: str) -> list[str]:
    return [hit["vault_id"] for hit in result["hits"][kind]]


def _scores(result: dict, kind: str) -> list[float]:
    return [hit["score"] for hit in result["hits"][kind]]


class _EmbedClient:
    payloads: list[dict] = []

    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    async def __aenter__(self) -> _EmbedClient:
        return self

    async def __aexit__(self, *args: object) -> bool:
        del args
        return False

    async def post(self, url: str, json: dict | None = None, **kwargs: object) -> _Response:
        del url, kwargs
        if json is not None:
            _EmbedClient.payloads.append(json)
        return _Response(200, {"data": [{"embedding": [1.0, 0.0, 0.0]}]})


class _Response:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class RetrieveRankingTest(unittest.IsolatedAsyncioTestCase):
    async def test_ocean_and_phone_prefer_cosine_over_filename(self) -> None:
        with patch("sense.planner._embed_text", _ocean_or_phone):
            ocean = await search_only(library_catalog(), {"query": "ocean"})
            phone = await search_only(library_catalog(), {"query": "phone"})
            footage = await search_only(library_catalog(), {"query": "find ocean footage"})
            photo = await search_only(library_catalog(), {"query": "photo of a phone"})

        self.assertEqual(ocean["mode"], "embedding")
        self.assertEqual(_ids(ocean, "video"), ["video/beach.mp4"])
        self.assertGreater(_scores(ocean, "video")[0], 0.9)
        self.assertEqual(_ids(ocean, "audio"), ["audio/ocean.m4a"])
        self.assertGreater(_scores(ocean, "audio")[0], 0.9)
        self.assertEqual(ocean["hits"]["image"], [])
        self.assertEqual(ocean["note"], "")

        self.assertEqual(_ids(phone, "video"), ["video/c2339.mp4"])
        self.assertGreater(_scores(phone, "video")[0], 0.9)
        self.assertEqual(_ids(phone, "image"), ["stills/phone.jpg"])
        self.assertGreater(_scores(phone, "image")[0], 0.9)

        self.assertEqual(_ids(footage, "video"), ["video/beach.mp4"])
        self.assertGreater(_scores(footage, "video")[0], 0.9)
        self.assertEqual(footage["hits"]["audio"], [])
        self.assertEqual(footage["hits"]["image"], [])
        self.assertIn("score", footage["hits"]["video"][0])

        self.assertEqual(_ids(photo, "image"), ["stills/phone.jpg"])
        self.assertEqual(photo["hits"]["video"], [])
        self.assertGreater(_scores(photo, "image")[0], 0.9)

    async def test_offline_and_failed_embed_publish_no_score(self) -> None:
        offline = await search_only(offline_catalog(), {"query": "ocean"})
        self.assertEqual(offline["mode"], "name")
        self.assertEqual(_ids(offline, "audio"), ["audio/ocean.m4a"])
        self.assertEqual(offline["hits"]["video"], [])
        self.assertNotIn("score", offline["hits"]["audio"][0])
        self.assertIn("Embeddings are offline", offline["note"])

        async def embed_down(_text: str) -> None:
            return None

        with patch("sense.planner._embed_text", embed_down):
            named = await search_only(library_catalog(), {"query": "find beach footage"})
        self.assertEqual(named["mode"], "name")
        self.assertEqual(_ids(named, "video"), ["video/beach.mp4"])
        self.assertNotIn("score", named["hits"]["video"][0])
        self.assertIn("Embedding model is not loaded", named["note"])

    async def test_upload_similar_does_not_invent_a_score(self) -> None:
        result = await run_similar(library_catalog(), {"vault_id": "upload/phone.mp4", "library": []})
        self.assertEqual(result["note"], UPLOAD_SIMILAR_NOTE)
        self.assertEqual(result["mode"], "name")
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})

    async def test_similar_joins_extension_alias_for_c2339(self) -> None:
        result = await run_similar(alias_catalog(), {"vault_id": "video/c2339.mp4"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(_ids(result, "video"), ["video/beach.mp4"])
        self.assertGreater(_scores(result, "video")[0], 0.9)
        self.assertNotIn("Embedding model is not loaded", result["note"])
        self.assertEqual(result["hits"]["audio"], [])

    async def test_default_k_and_string_k(self) -> None:
        items = [_item(f"video/v{index}.mp4", f"v{index}", "video") for index in range(9)]
        rows = [[1.0 - (index * 0.05), 0.05] for index in range(9)]
        matrix = np.asarray(rows, dtype="float32")
        ids = [item.id for item in items]
        loaded = Catalog(Path("/tmp"), Path("/tmp"), items, None, Vectors(ids, matrix, ids), False)

        async def embed(_text: str) -> list[float]:
            return [1.0, 0.0]

        with patch("sense.planner._embed_text", embed):
            defaulted = await search_only(loaded, {"query": "wave"})
            limited = await search_only(loaded, {"query": "wave", "k": "3"})
            garbage = await search_only(loaded, {"query": "wave", "k": "Infinity"})
        self.assertEqual(len(defaulted["hits"]["video"]), 8)
        self.assertEqual(len(garbage["hits"]["video"]), 8)
        self.assertEqual(_ids(defaulted, "video")[0], "video/v0.mp4")
        self.assertEqual(_ids(limited, "video"), ["video/v0.mp4", "video/v1.mp4", "video/v2.mp4"])

    async def test_unjoined_index_falls_back_to_names_without_scores(self) -> None:
        beach = _item("video/beach.mp4", "Beach", "video")
        matrix = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype="float32")
        loaded = Catalog(
            Path("/tmp"),
            Path("/tmp"),
            [beach],
            None,
            Vectors(["other/a", "other/b"], matrix, ["other/a", "other/b"]),
            False,
        )

        async def embed(_text: str) -> list[float]:
            return [1.0, 0.0]

        with patch("sense.planner._embed_text", embed):
            result = await search_only(loaded, {"query": "beach"})
        self.assertEqual(result["mode"], "name")
        self.assertEqual(_ids(result, "video"), ["video/beach.mp4"])
        self.assertNotIn("score", result["hits"]["video"][0])

    async def test_embed_query_uses_embeddinggemma_prefix(self) -> None:
        _EmbedClient.payloads = []

        async def mlx_up() -> bool:
            return True

        with (
            patch("sense.planner._mlx_up", mlx_up),
            patch("sense.planner.httpx.AsyncClient", _EmbedClient),
        ):
            ocean = await _embed_text("find ocean footage")
            phone = await _embed_text("phone")
        self.assertEqual(ocean, [1.0, 0.0, 0.0])
        self.assertEqual(phone, [1.0, 0.0, 0.0])
        self.assertEqual(
            [row["input"] for row in _EmbedClient.payloads],
            [
                "task: search result | query: ocean",
                "task: search result | query: phone",
            ],
        )
        self.assertTrue(all(row["model"] == "embeddinggemma" for row in _EmbedClient.payloads))

    def test_cosine_orders_beach_ahead_of_a_filename_hit(self) -> None:
        beach = _item("video/beach.mp4", "Beach", "video")
        ocean_audio = _item("audio/ocean.m4a", "ocean", "audio")
        by_id = {beach.id: beach, ocean_audio.id: ocean_audio}
        matrix = np.asarray([[0.9, 0.2], [1.0, 0.0]], dtype="float32")
        ranked = cosine(
            ["video/beach", "audio/ocean"],
            matrix,
            [1.0, 0.0],
            by_id,
            "video",
            5,
        )
        self.assertIsNotNone(ranked)
        assert ranked is not None
        self.assertGreater(ranked.joined, 0)
        self.assertEqual([item.id for item, _score in ranked.hits], ["video/beach.mp4"])
        self.assertGreater(ranked.hits[0][1], 0.9)

    async def test_embedding_search_drops_a_low_cosine_that_matches_the_name(self) -> None:
        near = _item("video/near.mp4", "near", "video")
        ocean = _item("video/ocean.mp4", "ocean", "video")
        loaded = _loaded([near, ocean], [[1.0, 0.0], [0.0, 1.0]])
        with patch("sense.planner._embed_text", _axis):
            result = await search_only(loaded, {"query": "ocean"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(_ids(result, "video"), ["video/near.mp4"])
        self.assertIn("score", result["hits"]["video"][0])
        self.assertGreater(result["hits"]["video"][0]["score"], 0.9)
        self.assertEqual(result["hits"]["audio"], [])
        self.assertEqual(result["hits"]["image"], [])

    async def test_every_cosine_below_the_floor_skips_name_matches(self) -> None:
        ocean = _item("video/ocean.mp4", "ocean", "video")
        other = _item("video/other.mp4", "other", "video")
        loaded = _loaded([ocean, other], [[0.0, 1.0], [0.0, 1.0]])
        with patch("sense.planner._embed_text", _axis):
            result = await search_only(loaded, {"query": "ocean"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
        self.assertEqual(result["note"], "Nothing confident enough.")

    async def test_offline_similar_publishes_no_score(self) -> None:
        beach = _item("video/beach.mp4", "Beach", "video")
        shore = _item("video/shore.mp4", "beach shore", "video")
        loaded = Catalog(Path("/tmp"), Path("/tmp"), [beach, shore], None, None, False)
        result = await run_similar(loaded, {"vault_id": "video/beach.mp4"})
        self.assertEqual(result["mode"], "name")
        self.assertEqual(_ids(result, "video"), ["video/shore.mp4"])
        self.assertNotIn("score", result["hits"]["video"][0])
        self.assertIn("Embeddings are offline", result["note"])

    async def test_min_score_env_on_the_ocean_catalog(self) -> None:
        with (
            patch("sense.planner._embed_text", _ocean_or_phone),
            patch.dict(os.environ, {"SENSE_MIN_SCORE": "0.90"}),
        ):
            strict = await search_only(library_catalog(), {"query": "ocean"})
        self.assertEqual(strict["mode"], "embedding")
        self.assertEqual(_ids(strict, "video"), ["video/beach.mp4"])
        self.assertGreater(_scores(strict, "video")[0], 0.9)
        self.assertEqual(_ids(strict, "audio"), ["audio/ocean.m4a"])
        self.assertNotIn("video/c2339.mp4", _ids(strict, "video"))

        with (
            patch("sense.planner._embed_text", _ocean_or_phone),
            patch.dict(os.environ, {"SENSE_MIN_SCORE": "nope"}),
        ):
            both = await search_only(library_catalog(), {"query": "ocean"})
        self.assertEqual(both["mode"], "embedding")
        self.assertEqual(_ids(both, "video"), ["video/beach.mp4"])
        self.assertEqual(_ids(both, "audio"), ["audio/ocean.m4a"])
        self.assertNotIn("video/c2339.mp4", _ids(both, "video"))

    async def test_similar_drops_a_neighbor_below_the_floor(self) -> None:
        anchor = _item("video/anchor.mp4", "anchor", "video")
        near = _item("video/near.mp4", "near", "video")
        ocean = _item("video/ocean.mp4", "ocean", "video")
        loaded = _loaded([anchor, near, ocean], [[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
        result = await run_similar(loaded, {"vault_id": "video/anchor.mp4"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(_ids(result, "video"), ["video/near.mp4"])
        self.assertIn("score", result["hits"]["video"][0])
        self.assertGreater(result["hits"]["video"][0]["score"], 0.9)

    async def test_similar_below_the_floor_notes_nothing_confident(self) -> None:
        anchor = _item("video/anchor.mp4", "anchor", "video")
        ocean = _item("video/ocean.mp4", "ocean", "video")
        loaded = _loaded([anchor, ocean], [[1.0, 0.0], [0.0, 1.0]])
        result = await run_similar(loaded, {"vault_id": "video/anchor.mp4"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
        self.assertEqual(result["note"], "Nothing confident enough.")

    async def test_unscoped_search_keeps_a_confident_hit_in_each_kind(self) -> None:
        video = _item("video/wave.mp4", "wave", "video")
        audio = _item("audio/whoosh.wav", "whoosh", "audio")
        image = _item("stills/wave.jpg", "wave", "image")
        weak = _item("video/junk.mp4", "ocean", "video")
        loaded = _loaded(
            [video, audio, image, weak],
            [[1.0, 0.0], [0.92, 0.08], [0.84, 0.12], [0.0, 1.0]],
        )
        with patch("sense.planner._embed_text", _axis):
            result = await search_only(loaded, {"query": "whoosh"})
        self.assertEqual(result["mode"], "embedding")
        self.assertEqual(_ids(result, "video"), ["video/wave.mp4"])
        self.assertEqual(_ids(result, "audio"), ["audio/whoosh.wav"])
        self.assertEqual(_ids(result, "image"), ["stills/wave.jpg"])
        self.assertGreater(_scores(result, "audio")[0], 0.5)
        self.assertNotIn("video/junk.mp4", _ids(result, "video"))
        self.assertEqual(result["note"], "")

    async def test_npz_only_audio_and_still_rank_when_the_catalog_omits_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            whoosh = root / "audio" / "whoosh.wav"
            wave = root / "stills" / "wave.jpg"
            whoosh.parent.mkdir()
            wave.parent.mkdir()
            whoosh.write_bytes(b"wav")
            wave.write_bytes(b"jpg")
            beach = _item("video/beach.mp4", "Beach", "video")
            ids = ["video/beach.mp4", "audio/whoosh.wav", "stills/wave.jpg"]
            matrix = np.asarray([[0.0, 1.0], [1.0, 0.0], [0.9, 0.1]], dtype="float32")
            vectors = Vectors(ids, matrix, ["ids", "embeddings", "modality"], None, ["video", "audio", "still"])
            loaded = Catalog(root, root, [beach], None, vectors, True)
            with patch("sense.planner._embed_text", _axis):
                result = await search_only(loaded, {"query": "whoosh"})
            self.assertEqual(_ids(result, "audio"), ["audio/whoosh.wav"])
            self.assertEqual(_ids(result, "image"), ["stills/wave.jpg"])
            self.assertEqual(result["hits"]["video"], [])
            self.assertGreater(result["hits"]["audio"][0]["score"], 0.5)
            self.assertTrue(result["hits"]["audio"][0]["src"].startswith("/media?id="))
            self.assertEqual(result["hits"]["image"][0]["kind"], "image")
            self.assertEqual(media_path(loaded, "audio/whoosh.wav"), whoosh)

            index = root / "vault_index_t.npz"
            np.savez(
                index,
                ids=np.array(["stills/wave.jpg"]),
                embeddings=np.ones((1, 2), dtype=np.float32),
                modality=np.array(["still"]),
            )
            saved = load_vectors(index)
            self.assertEqual(saved.kinds, ["image"])

    def test_library_payload_stops_at_the_cap(self) -> None:
        items = [_item(f"video/v{index}.mp4", f"v{index}", "video") for index in range(LIBRARY_CAP + 1)]
        loaded = Catalog(Path("/tmp"), Path("/tmp"), items, None, None, True)
        payload = library_payload(loaded)
        self.assertEqual(len(payload["items"]), LIBRARY_CAP)


class PlannerSeparationTest(unittest.IsolatedAsyncioTestCase):
    async def test_find_footage_searches_and_trim_applies_ops(self) -> None:
        async def find_ocean(contents: list, messages: list) -> tuple:
            return [Call("search_vault", {"query": "ocean"})], contents, messages

        async def trim(contents: list, messages: list) -> tuple:
            call = Call(
                "apply_ops",
                {"label": "Trim", "ops": [{"op": "trim", "clip_id": "c1", "duration_s": 2}]},
            )
            return [call], contents, messages

        def choose(planner: object):
            async def _choose() -> object:
                return planner

            return _choose

        with (
            patch("sense.planner._choose_planner", choose(find_ocean)),
            patch("sense.planner._embed_text", _ocean_or_phone),
        ):
            found = await run_command(
                library_catalog(),
                {"command": "find ocean footage", "timeline": timeline(), "library": []},
            )
        self.assertEqual(found["ops"], [])
        self.assertEqual(_ids(found, "video"), ["video/beach.mp4"])
        self.assertGreater(_scores(found, "video")[0], 0.9)
        self.assertEqual(_ids(found, "audio"), ["audio/ocean.m4a"])

        with patch("sense.planner._choose_planner", choose(trim)):
            edited = await run_command(
                library_catalog(),
                {"command": "trim the beach clip to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertEqual(edited["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 2.0}])
        self.assertEqual(edited["hits"], {"video": [], "audio": [], "image": []})

    async def test_find_command_uses_cosine_when_the_planner_returns_nothing(self) -> None:
        async def empty(contents: list, messages: list) -> tuple:
            return [], contents, messages

        async def choose() -> object:
            return empty

        with (
            patch("sense.planner._choose_planner", choose),
            patch("sense.planner._embed_text", _ocean_or_phone),
        ):
            result = await run_command(
                library_catalog(),
                {"command": "find ocean footage", "timeline": timeline(), "library": []},
            )
        self.assertEqual(result["ops"], [])
        self.assertEqual(_ids(result, "video")[0], "video/beach.mp4")
        self.assertIn("score", result["hits"]["video"][0])
        self.assertEqual(result["hits"]["audio"], [])

    async def test_command_search_omits_a_hit_below_the_floor(self) -> None:
        async def find_ocean(contents: list, messages: list) -> tuple:
            return [Call("search_vault", {"query": "ocean"})], contents, messages

        def choose(planner: object):
            async def _choose() -> object:
                return planner

            return _choose

        near = _item("video/near.mp4", "near", "video")
        ocean = _item("video/ocean.mp4", "ocean", "video")
        loaded = _loaded([near, ocean], [[1.0, 0.0], [0.0, 1.0]])
        with (
            patch("sense.planner._choose_planner", choose(find_ocean)),
            patch("sense.planner._embed_text", _axis),
        ):
            found = await run_command(
                loaded,
                {"command": "find ocean footage", "timeline": timeline(), "library": []},
            )
        self.assertEqual(found["ops"], [])
        self.assertEqual(_ids(found, "video"), ["video/near.mp4"])
        self.assertIn("score", found["hits"]["video"][0])
        flat = [hit["vault_id"] for kind in found["hits"].values() for hit in kind]
        self.assertNotIn("video/ocean.mp4", flat)

    async def test_command_below_the_floor_notes_nothing_confident(self) -> None:
        async def find_ocean(contents: list, messages: list) -> tuple:
            return [Call("search_vault", {"query": "ocean"})], contents, messages

        async def choose() -> object:
            return find_ocean

        ocean = _item("video/ocean.mp4", "ocean", "video")
        loaded = _loaded([ocean], [[0.0, 1.0]])
        with (
            patch("sense.planner._choose_planner", choose),
            patch("sense.planner._embed_text", _axis),
        ):
            result = await run_command(
                loaded,
                {"command": "find ocean footage", "timeline": timeline(), "library": []},
            )
        self.assertEqual(result["ops"], [])
        self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})
        self.assertEqual(result["note"], "Nothing confident enough.")


if __name__ == "__main__":
    unittest.main()
