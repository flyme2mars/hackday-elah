"""Upload dictation posts a temp path to local Parakeet and returns text."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from sense.app import app


class _Response:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> dict:
        return self._body


class _Capture:
    def __init__(self, status: int, body: dict) -> None:
        self.status = status
        self.body = body
        self.calls: list[tuple[str, dict]] = []

    async def __aenter__(self) -> _Capture:
        return self

    async def __aexit__(self, *args: object) -> bool:
        del args
        return False

    async def post(self, url: str, **kwargs: object) -> _Response:
        payload = kwargs.get("json")
        assert isinstance(payload, dict)
        path = Path(str(payload["path"]))
        assert path.is_file()
        self.calls.append((url, {"json": dict(payload), "bytes": path.read_bytes()}))
        return _Response(self.status, self.body)


class DictationUploadTest(unittest.TestCase):
    def setUp(self) -> None:
        self._env = patch.dict(
            os.environ,
            {"SENSE_MLX_TRANSCRIBE_URL": "http://127.0.0.1:8787/v1/audio/transcriptions"},
        )
        self._env.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self._env.stop()

    def test_webm_upload_returns_parakeet_text_and_posts_the_file(self) -> None:
        audio = b"\x1a\x45\xdf\xa3fake-webm"
        capture = _Capture(200, {"text": "trim the flower"})
        with (
            patch("sense.dictation_upload.shutil.which", return_value=None),
            patch("sense.dictation_upload.httpx.AsyncClient", lambda *args, **kwargs: capture),
        ):
            response = self.client.post(
                "/v1/dictation",
                content=audio,
                headers={"content-type": "audio/webm;codecs=opus"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "trim the flower"})
        self.assertEqual(len(capture.calls), 1)
        url, sent = capture.calls[0]
        self.assertEqual(url, "http://127.0.0.1:8787/v1/audio/transcriptions")
        self.assertEqual(sent["json"]["model"], "parakeet")
        self.assertTrue(str(sent["json"]["path"]).endswith(".webm"))
        self.assertEqual(sent["bytes"], audio)
        self.assertNotIn("start_s", sent["json"])

    def test_transcript_field_is_accepted(self) -> None:
        capture = _Capture(200, {"transcript": "cut the clip"})
        with (
            patch("sense.dictation_upload.shutil.which", return_value=None),
            patch("sense.dictation_upload.httpx.AsyncClient", lambda *args, **kwargs: capture),
        ):
            response = self.client.post(
                "/v1/dictation",
                content=b"RIFF",
                headers={"content-type": "audio/wav"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "cut the clip"})
        self.assertTrue(str(capture.calls[0][1]["json"]["path"]).endswith(".wav"))

    def test_mlx_error_is_parakeet_unavailable(self) -> None:
        capture = _Capture(503, {"error": "busy"})
        with patch("sense.dictation_upload.httpx.AsyncClient", lambda *args, **kwargs: capture):
            response = self.client.post(
                "/v1/dictation",
                content=b"abc",
                headers={"content-type": "audio/ogg"},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Parakeet is not loaded.")

    def test_empty_recording_is_rejected_before_mlx(self) -> None:
        def fail(*args: object, **kwargs: object) -> object:
            del args, kwargs
            raise AssertionError("mlx should not be called")

        with patch("sense.dictation_upload.httpx.AsyncClient", fail):
            response = self.client.post(
                "/v1/dictation",
                content=b"",
                headers={"content-type": "audio/webm"},
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Expected an audio recording.")

    def test_unknown_type_is_rejected_before_mlx(self) -> None:
        def fail(*args: object, **kwargs: object) -> object:
            del args, kwargs
            raise AssertionError("mlx should not be called")

        with patch("sense.dictation_upload.httpx.AsyncClient", fail):
            response = self.client.post(
                "/v1/dictation",
                content=b"hello",
                headers={"content-type": "text/plain"},
            )
        self.assertEqual(response.status_code, 415)

    def test_ffmpeg_wav_is_what_parakeet_reads(self) -> None:
        audio = b"\x1a\x45\xdf\xa3fake-webm"
        capture = _Capture(200, {"text": "add a title"})

        def fake_ffmpeg(cmd: list[str], **kwargs: object) -> object:
            del kwargs
            dest = Path(cmd[-1])
            dest.write_bytes(b"RIFFwav")

            class _Proc:
                returncode = 0

            return _Proc()

        with (
            patch("sense.dictation_upload.shutil.which", return_value="/usr/bin/ffmpeg"),
            patch("sense.dictation_upload.subprocess.run", fake_ffmpeg),
            patch("sense.dictation_upload.httpx.AsyncClient", lambda *args, **kwargs: capture),
        ):
            response = self.client.post(
                "/v1/dictation",
                content=audio,
                headers={"content-type": "audio/webm"},
            )
        self.assertEqual(response.status_code, 200)
        sent = capture.calls[0][1]
        self.assertTrue(str(sent["json"]["path"]).endswith(".wav"))
        self.assertEqual(sent["bytes"], b"RIFFwav")

    def test_oversize_recording_is_rejected(self) -> None:
        with patch.dict(os.environ, {"SENSE_DICTATION_MAX_BYTES": "4"}):
            response = self.client.post(
                "/v1/dictation",
                content=b"12345",
                headers={"content-type": "audio/webm"},
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Recording is too long.")
