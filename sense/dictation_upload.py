"""Browser dictation audio. One clip in, one Parakeet transcript out.

The MLX worker transcribes a file path (`POST /v1/audio/transcriptions`).
This module writes the upload to a temp file, turns non-wav audio into
16 kHz mono wav when ffmpeg is present, and posts that path. Parakeet
TDT is batch-only, so there are no partial transcripts.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx

# MediaRecorder labels. The parameter after ';' is codecs, not a new type.
_SUFFIXES = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/mp4a-latm": ".m4a",
    "audio/aac": ".aac",
}

_DEFAULT_MAX_BYTES = 8_000_000


class ParakeetUnavailable(Exception):
    """Local MLX Parakeet did not answer. Callers may fall back."""


class DictationRejected(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def max_bytes() -> int:
    raw = os.environ.get("SENSE_DICTATION_MAX_BYTES", str(_DEFAULT_MAX_BYTES))
    try:
        return max(1, int(raw))
    except ValueError:
        return _DEFAULT_MAX_BYTES


def audio_suffix(content_type: str) -> str | None:
    mime = content_type.split(";", 1)[0].strip().lower()
    return _SUFFIXES.get(mime)


def transcribe_url() -> str:
    explicit = os.environ.get("SENSE_MLX_TRANSCRIBE_URL")
    if explicit:
        return explicit
    origin = os.environ.get("SENSE_MLX_URL", "http://127.0.0.1:8787").rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme and parsed.netloc:
        origin = f"{parsed.scheme}://{parsed.netloc}"
    return f"{origin}/v1/audio/transcriptions"


def speech_file(src: Path) -> Path:
    """16 kHz mono wav when ffmpeg can make one. Otherwise the original file."""
    if src.suffix.lower() == ".wav":
        return src
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return src
    dest = src.with_suffix(".wav")
    try:
        proc = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", "-f", "wav", str(dest)],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return src
    if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        return src
    return dest


async def parakeet_text(
    path: Path,
    *,
    start_s: float | None = None,
    end_s: float | None = None,
    timeout: float = 120,
) -> str:
    payload: dict[str, object] = {
        "path": str(path),
        "model": os.environ.get("SENSE_ASR_MODEL", "parakeet"),
    }
    if start_s is not None:
        payload["start_s"] = start_s
    if end_s is not None:
        payload["end_s"] = end_s
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(transcribe_url(), json=payload)
    except httpx.HTTPError as error:
        raise ParakeetUnavailable from error
    if response.status_code >= 400:
        raise ParakeetUnavailable
    try:
        data = response.json()
    except ValueError as error:
        raise ParakeetUnavailable from error
    if not isinstance(data, dict):
        raise ParakeetUnavailable
    text = data.get("text") or data.get("transcript") or ""
    if not isinstance(text, str):
        raise ParakeetUnavailable
    return text[:4000]


async def transcribe_upload(data: bytes, content_type: str) -> str:
    if content_type.lower().startswith("multipart/"):
        raise DictationRejected(415, "Send the audio bytes with an audio content type.")
    suffix = audio_suffix(content_type)
    if suffix is None:
        raise DictationRejected(415, "Send webm, wav, ogg, or m4a audio.")
    if not data:
        raise DictationRejected(400, "Expected an audio recording.")
    if len(data) > max_bytes():
        raise DictationRejected(413, "Recording is too long.")
    with tempfile.TemporaryDirectory(prefix="sense-dictation-") as directory:
        src = Path(directory) / f"take{suffix}"
        src.write_bytes(data)
        try:
            return await parakeet_text(speech_file(src), timeout=60)
        except ParakeetUnavailable as error:
            raise DictationRejected(503, "Parakeet is not loaded.") from error
