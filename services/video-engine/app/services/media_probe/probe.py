"""Media probing via ffprobe (master prompt §9.1).

Runs ffprobe as a subprocess, parses its JSON output and returns real
metadata. Raises ``ProbeError`` with a useful message for corrupt or
unsupported files — never a silent success.
"""

from __future__ import annotations

import json
import subprocess

from app.core.config import settings


class ProbeError(Exception):
    """Raised when ffprobe cannot read the file (corrupt/unsupported)."""

    def __init__(self, message: str, code: str = "probe_failed") -> None:
        super().__init__(message)
        self.code = code


def _parse_fps(raw: str | None) -> float | None:
    """ffprobe reports frame rate as '30000/1001' — convert to float."""
    if not raw:
        return None
    try:
        if "/" in raw:
            num, den = raw.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else None
        return float(raw)
    except (ValueError, ZeroDivisionError):
        return None


def probe_media(path: str) -> dict:
    """Probe ``path`` with ffprobe and return real metadata.

    Returns a dict with: duration_seconds, width, height, fps,
    video_codec, audio_codec, audio_streams, bitrate, format, size_bytes.
    """
    if not settings.ffprobe_path:
        raise ProbeError("ffprobe binary not found on this system", "ffprobe_missing")
    cmd = [
        settings.ffprobe_path,
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ProbeError("ffprobe timed out after 120s", "probe_timeout")
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip() or "unknown ffprobe error"
        raise ProbeError(f"ffprobe failed: {detail}", "probe_failed")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe returned invalid JSON: {exc}", "probe_bad_output")

    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

    duration = fmt.get("duration")
    try:
        duration_f = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_f = None
    bitrate = fmt.get("bit_rate")
    try:
        bitrate_i = int(bitrate) if bitrate is not None else None
    except (TypeError, ValueError):
        bitrate_i = None
    size = fmt.get("size")
    try:
        size_i = int(size) if size is not None else None
    except (TypeError, ValueError):
        size_i = None

    return {
        "duration_seconds": duration_f,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": _parse_fps(video.get("avg_frame_rate") or video.get("r_frame_rate"))
        if video
        else None,
        "video_codec": video.get("codec_name") if video else None,
        "audio_codec": audio_streams[0].get("codec_name") if audio_streams else None,
        "audio_streams": len(audio_streams),
        "bitrate": bitrate_i,
        "format": fmt.get("format_name"),
        "size_bytes": size_i,
    }
