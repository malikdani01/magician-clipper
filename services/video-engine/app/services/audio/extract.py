"""Audio extraction via ffmpeg (master prompt §9.2).

Extracts a mono 16 kHz WAV track suitable for transcription
(faster-whisper, Phase 3). The source file is never modified.
"""

from __future__ import annotations

import os
import subprocess
import uuid

from app.core.config import settings
from app.services.media_probe.probe import probe_media


class AudioExtractionError(Exception):
    """Raised when ffmpeg cannot extract audio (e.g. no audio stream)."""

    def __init__(self, message: str, code: str = "audio_extraction_failed") -> None:
        super().__init__(message)
        self.code = code


SAMPLE_RATE = 16000
CHANNELS = 1


def extract_audio(source_path: str, job_id: str | None = None) -> dict:
    """Extract mono 16 kHz WAV from ``source_path``.

    Returns a dict with: audio_path, duration_seconds, sample_rate,
    channels, size_bytes.
    """
    if not settings.ffmpeg_path:
        raise AudioExtractionError(
            "ffmpeg binary not found on this system", "ffmpeg_missing"
        )
    settings.ensure_dirs()
    out_name = f"{job_id or uuid.uuid4().hex}.wav"
    out_path = os.path.join(settings.audio_dir, out_name)
    cmd = [
        settings.ffmpeg_path,
        "-y",
        "-v", "error",
        "-i", source_path,
        "-vn",
        "-ac", str(CHANNELS),
        "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        raise AudioExtractionError(
            "ffmpeg audio extraction timed out after 600s", "audio_timeout"
        )
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip() or "unknown ffmpeg error"
        raise AudioExtractionError(f"ffmpeg failed: {detail}", "audio_extraction_failed")
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise AudioExtractionError(
            "ffmpeg produced no audio output (file may have no audio stream)",
            "audio_no_output",
        )
    # Real duration/size of the extracted WAV, via ffprobe.
    meta = probe_media(out_path)
    return {
        "audio_path": out_path,
        "duration_seconds": meta.get("duration_seconds"),
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "size_bytes": os.path.getsize(out_path),
    }
