"""Smoke tests for Vertex/E4B recovery. Trim is not short-circuited locally."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from sense.catalog import Catalog, Item, Vectors
from sense.planner import (
    INSTRUCTIONS,
    VertexBusy,
    _choose_planner,
    _e4b_turn,
    _gemini_turn,
    _parse_e4b_tool_calls,
    _vertex_turn,
    health,
    run_command,
    run_similar,
)

UPLOAD_SIMILAR_NOTE = "Find similar works on vault clips. Browser uploads are not on disk for EmbeddingGemma yet."


def timeline() -> dict:
    return {
        "tracks": [
            {
                "alias": "V1",
                "name": "V1",
                "kind": "video",
                "clips": [
                    {"id": "engine-id", "alias": "c1", "type": "video", "start_s": 1, "duration_s": 8},
                ],
            },
        ]
    }


def catalog() -> Catalog:
    root = Path("/tmp")
    return Catalog(root, root, [], None, None, False)


class GuidanceTest(unittest.TestCase):
    def test_trim_guidance_is_duration_only(self) -> None:
        self.assertIn('{"op":"trim","clip_id":"...","duration_s":2}', INSTRUCTIONS)
        self.assertIn("Omit start_s unless the user asked to move the left edge.", INSTRUCTIONS)
        self.assertNotIn('{"op":"trim","clip_id":"...","start_s":0,"duration_s":2}', INSTRUCTIONS)

    def test_parse_tool_json_from_text(self) -> None:
        fenced = """Here you go
```json
[{"name":"apply_ops","arguments":{"label":"Trim to 2s","ops":[{"op":"trim","clip_id":"c1","duration_s":2}]}}]
```"""
        calls = _parse_e4b_tool_calls(fenced)
        self.assertEqual(calls[0].name, "apply_ops")
        self.assertEqual(calls[0].args["ops"][0]["duration_s"], 2)
        loose = _parse_e4b_tool_calls('[{"op":"trim","clip_id":"c1","duration_s":2}]')
        self.assertEqual(loose[0].name, "apply_ops")
        self.assertEqual(loose[0].args["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 2}])


class _Response:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> dict:
        return self._body


class _Client:
    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    async def __aenter__(self) -> _Client:
        return self

    async def __aexit__(self, *args: object) -> bool:
        del args
        return False

    async def post(self, url: str, **kwargs: object) -> _Response:
        del kwargs
        if "generateContent" in url:
            return _Response(429, {})
        return _Response(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": (
                                '{"name":"apply_ops","arguments":{"label":"Trim to 2s",'
                                '"ops":[{"op":"trim","clip_id":"c1","duration_s":2}]}}'
                            ),
                        }
                    }
                ]
            },
        )


class _VertexOk(_Client):
    async def post(self, url: str, **kwargs: object) -> _Response:
        if "generateContent" in url:
            return _Response(
                200,
                {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {
                                        "functionCall": {
                                            "name": "apply_ops",
                                            "args": {
                                                "label": "Trim to 2s",
                                                "ops": [{"op": "trim", "clip_id": "c1", "duration_s": 2}],
                                            },
                                        }
                                    }
                                ],
                            }
                        }
                    ]
                },
            )
        return await super().post(url, **kwargs)


class RecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_vertex_429_raises_busy(self) -> None:
        with (
            patch("sense.planner._vertex_token", return_value="token"),
            patch("sense.planner.httpx.AsyncClient", _Client),
        ):
            with self.assertRaises(VertexBusy):
                await _vertex_turn([], [])

    async def test_run_command_local_trim_skips_models(self) -> None:
        """Trim is not a local regex. With no model, ops stay empty and planner is not local."""

        async def no_planner() -> None:
            return None

        with patch("sense.planner._choose_planner", no_planner):
            offline = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertNotEqual(offline["planner"], "local")
        self.assertEqual(offline["planner"], "offline")
        self.assertEqual(offline["ops"], [])

        async def use_vertex() -> object:
            return _vertex_turn

        with (
            patch("sense.planner._choose_planner", use_vertex),
            patch("sense.planner._vertex_token", return_value="token"),
            patch("sense.planner.httpx.AsyncClient", _VertexOk),
        ):
            served = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertNotEqual(served["planner"], "local")
        self.assertEqual(served["planner"], "vertex")
        self.assertEqual(served["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 2}])

    async def test_vertex_busy_falls_back_to_e4b_text(self) -> None:
        async def use_vertex() -> object:
            return _vertex_turn

        with (
            patch("sense.planner._choose_planner", use_vertex),
            patch("sense.planner._vertex_token", return_value="token"),
            patch("sense.planner.httpx.AsyncClient", _Client),
        ):
            result = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertEqual(result["planner"], "e4b")
        self.assertNotEqual(result["planner"], "local")
        self.assertIn("Vertex busy; using local E4B.", result["note"])
        self.assertEqual(result["ops"][0]["op"], "trim")
        self.assertEqual(result["ops"][0]["clip_id"], "c1")

    async def test_e4b_turn_promotes_text_to_tool_calls(self) -> None:
        with patch("sense.planner.httpx.AsyncClient", _Client):
            calls, _contents, messages = await _e4b_turn([], [{"role": "user", "content": "trim"}])
        self.assertEqual(calls[0].name, "apply_ops")
        self.assertEqual(messages[-1]["tool_calls"][0]["function"]["name"], "apply_ops")
        self.assertIsNone(messages[-1]["content"])


class SimilarTest(unittest.IsolatedAsyncioTestCase):
    async def test_upload_and_missing_ids_do_not_blame_the_model(self) -> None:
        beach = Item("video/beach", "Beach", "video", Path("/tmp/beach.mp4"), 3.0, True)
        matrix = np.asarray([[1.0, 0.0]], dtype="float32")
        loaded = Catalog(
            Path("/tmp"),
            Path("/tmp"),
            [beach],
            None,
            Vectors(["video/beach"], matrix, ["video/beach"]),
            False,
        )
        for vault_id in ("upload/phone.mp4", "video/c2339"):
            result = await run_similar(
                loaded,
                {
                    "vault_id": vault_id,
                    "library": [{"vault_id": vault_id, "name": "Phone", "kind": "video", "duration_s": 4, "src": "/x"}],
                },
            )
            self.assertEqual(result["note"], UPLOAD_SIMILAR_NOTE)
            self.assertNotIn("Embedding model is not loaded", result["note"])
            self.assertEqual(result["hits"], {"video": [], "audio": [], "image": []})

    async def test_vault_index_cosine_still_matches(self) -> None:
        beach = Item("video/beach", "Beach", "video", Path("/tmp/beach.mp4"), 3.0, True)
        phone = Item("video/c2339", "Phone", "video", Path("/tmp/phone.mp4"), 4.0, True)
        matrix = np.asarray([[1.0, 0.0], [0.9, 0.1]], dtype="float32")
        loaded = Catalog(
            Path("/tmp"),
            Path("/tmp"),
            [beach, phone],
            None,
            Vectors(["video/beach", "video/c2339"], matrix, ["video/beach", "video/c2339"]),
            False,
        )
        result = await run_similar(loaded, {"vault_id": "video/c2339", "k": 5})
        self.assertEqual(result["mode"], "embedding")
        self.assertNotIn("Embedding model is not loaded", result["note"])
        self.assertEqual([hit["vault_id"] for hit in result["hits"]["video"]], ["video/beach"])


def _blank_cloud_env(**extra: str) -> dict[str, str]:
    base = {
        "GEMINI_API_KEY": "",
        "GOOGLE_API_KEY": "",
        "SENSE_GEMINI_API_KEY": "",
        "SENSE_GEMINI": "1",
        "SENSE_VERTEX": "1",
        "GEMINI_MODEL": "",
    }
    base.update(extra)
    return base


def _apply_ops_body() -> dict:
    return {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {
                            "functionCall": {
                                "name": "apply_ops",
                                "args": {
                                    "label": "Trim to 2s",
                                    "ops": [{"op": "trim", "clip_id": "c1", "duration_s": 2}],
                                },
                            }
                        }
                    ],
                }
            }
        ]
    }


class _GeminiRoute:
    """429 on the Gemini host, a function call on Vertex, E4B text elsewhere."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    async def __aenter__(self) -> _GeminiRoute:
        return self

    async def __aexit__(self, *args: object) -> bool:
        del args
        return False

    async def post(self, url: str, **kwargs: object) -> _Response:
        headers = kwargs.get("headers")
        header_map = headers if isinstance(headers, dict) else {}
        _GeminiRoute.seen.append((url, header_map))
        if "generativelanguage.googleapis.com" in url:
            return _Response(429, {})
        if "aiplatform.googleapis.com" in url:
            return _Response(200, _apply_ops_body())
        return _Response(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": (
                                '{"name":"apply_ops","arguments":{"label":"Trim to 2s",'
                                '"ops":[{"op":"trim","clip_id":"c1","duration_s":2}]}}'
                            ),
                        }
                    }
                ]
            },
        )


_GeminiRoute.seen = []  # type: ignore[attr-defined]


class _GeminiOk(_GeminiRoute):
    async def post(self, url: str, **kwargs: object) -> _Response:
        headers = kwargs.get("headers")
        header_map = headers if isinstance(headers, dict) else {}
        body = kwargs.get("json")
        _GeminiOk.seen.append((url, header_map, body))
        return _Response(200, _apply_ops_body())


_GeminiOk.seen = []  # type: ignore[attr-defined]


class GeminiTest(unittest.IsolatedAsyncioTestCase):
    async def test_choose_order(self) -> None:
        async def mlx_up() -> bool:
            return True

        async def mlx_down() -> bool:
            return False

        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY="studio-key")),
            patch("sense.planner._vertex_enabled", return_value=True),
            patch("sense.planner._mlx_up", mlx_up),
        ):
            self.assertIs(await _choose_planner(), _gemini_turn)

        with (
            patch.dict(os.environ, _blank_cloud_env(GOOGLE_API_KEY="studio-key", SENSE_GEMINI="1")),
            patch("sense.planner._vertex_enabled", return_value=True),
            patch("sense.planner._mlx_up", mlx_up),
        ):
            self.assertIs(await _choose_planner(), _gemini_turn)

        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY="studio-key", SENSE_GEMINI="0")),
            patch("sense.planner._vertex_enabled", return_value=True),
            patch("sense.planner._mlx_up", mlx_down),
        ):
            self.assertIs(await _choose_planner(), _vertex_turn)

        with (
            patch.dict(os.environ, _blank_cloud_env(SENSE_VERTEX="0")),
            patch("sense.planner._vertex_enabled", return_value=False),
            patch("sense.planner._mlx_up", mlx_up),
        ):
            self.assertIs(await _choose_planner(), _e4b_turn)

        with (
            patch.dict(os.environ, _blank_cloud_env()),
            patch("sense.planner._vertex_enabled", return_value=False),
            patch("sense.planner._mlx_up", mlx_down),
        ):
            self.assertIsNone(await _choose_planner())

    def test_health_hides_the_key(self) -> None:
        secret = "studio-key-not-for-logs"
        with patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY=secret)):
            body = health(catalog())
        self.assertIs(body["gemini_configured"], True)
        self.assertEqual(body["gemini_model"], "gemma-4-26b-a4b-it")
        self.assertNotIn(secret, json.dumps(body))
        with patch.dict(os.environ, _blank_cloud_env()):
            self.assertIs(health(catalog())["gemini_configured"], False)

    async def test_gemini_turn_posts_generate_content(self) -> None:
        secret = "studio-key"
        _GeminiOk.seen = []
        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY=secret)),
            patch("sense.planner.httpx.AsyncClient", _GeminiOk),
        ):
            calls, _contents, _messages = await _gemini_turn([{"role": "user", "parts": [{"text": "trim"}]}], [])
        self.assertEqual(calls[0].name, "apply_ops")
        url, headers, body = _GeminiOk.seen[0]
        self.assertEqual(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent",
        )
        self.assertNotIn(secret, url)
        self.assertNotIn("-maas", url)
        self.assertEqual(headers.get("x-goog-api-key"), secret)
        declarations = body["tools"][0]["functionDeclarations"]
        self.assertIn("apply_ops", [item["name"] for item in declarations])

    async def test_gemini_429_raises_busy_without_the_key(self) -> None:
        secret = "studio-key"
        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY=secret)),
            patch("sense.planner.httpx.AsyncClient", _GeminiRoute),
        ):
            with self.assertRaises(VertexBusy) as caught:
                await _gemini_turn([], [])
        self.assertNotIn(secret, str(caught.exception))

    async def test_run_command_uses_gemini(self) -> None:
        async def use_gemini() -> object:
            return _gemini_turn

        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY="studio-key")),
            patch("sense.planner._choose_planner", use_gemini),
            patch("sense.planner.httpx.AsyncClient", _GeminiOk),
        ):
            result = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertEqual(result["planner"], "gemini")
        self.assertEqual(result["ops"], [{"op": "trim", "clip_id": "c1", "duration_s": 2}])

    async def test_gemini_busy_tries_vertex_then_e4b(self) -> None:
        async def use_gemini() -> object:
            return _gemini_turn

        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY="studio-key")),
            patch("sense.planner._choose_planner", use_gemini),
            patch("sense.planner._vertex_enabled", return_value=True),
            patch("sense.planner._vertex_token", return_value="token"),
            patch("sense.planner.httpx.AsyncClient", _GeminiRoute),
        ):
            via_vertex = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertEqual(via_vertex["planner"], "vertex")
        self.assertIn("Gemini API busy; trying Vertex.", via_vertex["note"])
        self.assertEqual(via_vertex["ops"][0]["op"], "trim")

        with (
            patch.dict(os.environ, _blank_cloud_env(GEMINI_API_KEY="studio-key")),
            patch("sense.planner._choose_planner", use_gemini),
            patch("sense.planner._vertex_enabled", return_value=False),
            patch("sense.planner.httpx.AsyncClient", _GeminiRoute),
        ):
            via_e4b = await run_command(
                catalog(),
                {"command": "trim this video to 2 sec", "timeline": timeline(), "library": []},
            )
        self.assertEqual(via_e4b["planner"], "e4b")
        self.assertIn("Gemini API busy; using local E4B.", via_e4b["note"])
        self.assertNotIn("Embedding model is not loaded", via_e4b["note"])
        self.assertEqual(via_e4b["ops"][0]["op"], "trim")


if __name__ == "__main__":
    unittest.main()
