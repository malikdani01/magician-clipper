"""Muse-connected Job System worker for Magician Clipper (Phase 3).

Polls the Laravel Job API for Queued jobs, renders their clips locally
with FFmpeg + faster-whisper + OpenCV, and uploads the finished MP4s back
to the same Job ID. Original code written for this project (no copied
clipper code, no ClipShip assets).

Flow per job:
  1. GET  /api/v1/muse/jobs?status=queued      (X-Muse-Api-Key header)
  2. PATCH /api/v1/muse/jobs/{id}/status       Queued -> Processing (claim)
  3. Get the video: uploaded file under Laravel storage/app/, or download
     the link with yt-dlp (YouTube / TikTok / Drive / direct MP4).
     YouTube LIVE streams are NEVER downloaded unbounded: a live capture is
     capped at 10 minutes of wall-clock recording (``timeout 600``) and the
     file actually written in that window is what gets processed; if it is
     unusable the job fails with the exact reason.
  4. Transcribe with faster-whisper (base model, CPU int8).
  5. Select highlights exactly per the job settings with an explainable
     score: speech density + audio coverage + sentence completeness +
     silence boundaries, audio energy only as a supporting signal
     (loudness is never treated as engagement). Windows that are mostly
     silent are never used to pad the clip count when usable windows
     exist; if none exists the shortfall is surfaced honestly.
  6. Render clips with FFmpeg (correct ratio and duration, captions burned
     in per the language setting, split streamer-top / gameplay-bottom
     layout when the job specifies it).
  7. Validate every clip with ffprobe before upload (duration within
     tolerance, expected resolution/aspect, nonzero size, audio present
     when the source has audio).
  8. POST /api/v1/muse/jobs/{id}/clips (multipart MP4 per clip), then
     PATCH status -> Ready. On ANY failure PATCH status -> Failed with the
     EXACT reason.

Security: the API key is read from backend/laravel/.env at runtime (or the
MUSE_JOB_API_KEY environment variable) and is NEVER printed, logged, or
included in any error message.

Usage:
  python3 workers/muse_worker.py --once            # process one queued job
  python3 workers/muse_worker.py --once --job-id <uuid>
  python3 workers/muse_worker.py --poll [--interval 300]
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.request
import uuid
import wave
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths / configuration
# ---------------------------------------------------------------------------

WORKER_DIR = Path(__file__).resolve().parent
ENGINE_DIR = WORKER_DIR.parent
REPO_ROOT = ENGINE_DIR.parent.parent
LARAVEL_DIR = REPO_ROOT / "backend" / "laravel"
LARAVEL_ENV = LARAVEL_DIR / ".env"
LARAVEL_STORAGE = LARAVEL_DIR / "storage" / "app"
WORK_DIR = ENGINE_DIR / "storage" / "muse-worker"
WORK_DIR.mkdir(parents=True, exist_ok=True)

LARAVEL_BASE = os.environ.get("LARAVEL_URL", "http://127.0.0.1:8000").rstrip("/")
API_BASE = f"{LARAVEL_BASE}/api/v1"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
YT_DLP = shutil.which("yt-dlp") or "/usr/local/bin/yt-dlp"

# Model: "base" is the default since 2026-11-22 (was "tiny"). Measured on
# the same 170s demo file, 3 runs each, threads=1, int8: tiny gave 52-86
# segments (words varied wildly), base gave 67/80/71 segments with
# 412/435/435 words in ~38-50s — still not bit-identical run to run
# (CTranslate2 beam search varies), but far more stable, and barely
# slower than tiny (~35s). Override with WHISPER_MODEL=small for more
# accuracy at ~3x the time; WHISPER_MODEL=tiny for the fastest runs.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
# Single-threaded transcription is the default on purpose: it reduces
# (not removes) the run-to-run variance of CTranslate2's beam search,
# which segments the SAME file differently run to run and made clip
# counts vary between runs of the same video. Override with
# WHISPER_CPU_THREADS only if you accept more variance.
WHISPER_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "1"))

# Live-stream capture cap: at most 10 minutes of wall-clock recording.
LIVE_CAPTURE_TIMEOUT_SECONDS = 600
# Bundled Haar cascade for split-layout face detection: the venv's
# cv2/data/ ships no cascade XML, so the official OpenCV cascade
# (data/haarcascade_frontalface_default.xml) is bundled with the engine
# and tried first; cv2.data is the fallback location.
BUNDLED_CASCADE = ENGINE_DIR / "data" / "haarcascade_frontalface_default.xml"
# VOD / file downloads are capped at 720p for the CPU/RAM-safe worker.
YT_DLP_FORMAT = "best[height<=720]/best[height<=720]/best"
# Direct (non-yt-dlp) downloads are capped at 2 GiB.
MAX_DIRECT_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

RATIO_TARGETS = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}

LANGUAGE_MAP = {"english": "en", "roman_urdu": "ur", "hindi": "hi", "auto": None}

# Highlight scoring weights (documented, deterministic).
# Speech density, audio coverage and sentence completeness dominate;
# silence boundaries help cut at natural pauses; audio energy is
# supporting only — loudness is NEVER treated as engagement. Audio
# coverage is the Fix-2 guard: a window that is mostly silence scores
# low no matter how dense its few spoken words are. Gameplay presence
# prefers windows where real gameplay is on screen (facecam inset small
# or absent) over full-facecam talking stretches — the reference style
# is streamer-top / gameplay-bottom, so a clip with no gameplay to show
# is a worse clip even if the speech is dense. Stability prefers windows
# that stay in ONE scene: a window spanning a facecam->gameplay switch
# cannot be split correctly with one static crop, so mixed windows score
# lower than single-scene windows.
W_DENSITY = 0.25
W_COVERAGE = 0.20
W_COMPLETENESS = 0.20
W_SILENCE = 0.05
W_ENERGY = 0.05
W_GAMEPLAY = 0.15
W_STABILITY = 0.10
# Visual-moment windows (speech-scarce sources): the score is built only
# from what a wordless window honestly has — loud audio, gameplay on
# screen, a stable scene. No speech terms: a visual moment must never
# out-score a real speech highlight on speech's own terms.
W_VISUAL_ENERGY = 0.35
W_VISUAL_GAMEPLAY = 0.35
W_VISUAL_STABILITY = 0.30

# Minimum fraction of a clip window that must contain transcribed speech
# for the window to count as usable audio (Fix 2). Windows below this
# are only ever used when NO usable window exists at all, and are then
# flagged low_audio_coverage — never presented as good highlights.
MIN_SPEECH_COVERAGE = 0.5

# Duration tolerance for validation (seconds). Exact mode is held to the
# same tolerance because FFmpeg trims on frame boundaries.
DURATION_TOLERANCE = 0.6

log = logging.getLogger("muse_worker")


# ---------------------------------------------------------------------------
# API key handling (never logged)
# ---------------------------------------------------------------------------

def load_api_key() -> str:
    """Read the Muse Job API key from the environment or backend .env."""
    key = os.environ.get("MUSE_JOB_API_KEY", "").strip()
    if key:
        return key
    if LARAVEL_ENV.exists():
        for line in LARAVEL_ENV.read_text(errors="ignore").splitlines():
            line = line.strip()
            if line.startswith("MUSE_JOB_API_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    raise RuntimeError(
        "MUSE_JOB_API_KEY is not set: expected it in the environment or in "
        f"{LARAVEL_ENV}. Generate one with `openssl rand -hex 32` and store "
        "it as MUSE_JOB_API_KEY in backend/laravel/.env (never print it)."
    )


def api_headers(key: str) -> dict:
    return {"X-Muse-Api-Key": key, "Accept": "application/json"}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def run(cmd: list[str], timeout: int | None = None) -> subprocess.CompletedProcess:
    """Run a command, capturing output. Never include secrets in cmd."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ffprobe_json(path: Path) -> dict:
    """Return ffprobe JSON for a file, or raise with the exact reason."""
    if not path.exists():
        raise RuntimeError(f"File not found for probing: {path.name}")
    proc = run([
        FFPROBE, "-v", "error", "-show_format", "-show_streams",
        "-of", "json", str(path),
    ], timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {path.name}: {(proc.stderr or '').strip()[:300]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON for {path.name}: {exc}")


def probe_summary(path: Path) -> dict:
    info = ffprobe_json(path)
    fmt = info.get("format", {})
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if video is None:
        raise RuntimeError(f"No video stream found in {path.name} (ffprobe).")
    duration = float(fmt.get("duration") or video.get("duration") or 0)
    if duration <= 0:
        raise RuntimeError(f"Could not determine duration of {path.name} (ffprobe).")
    return {
        "duration": duration,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": _fps(video),
        "video_codec": video.get("codec_name"),
        "has_audio": len(audio) > 0,
        "audio_codec": audio[0].get("codec_name") if audio else None,
        "size_bytes": path.stat().st_size,
    }


def _fps(video: dict) -> float:
    raw = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/0"
    try:
        num, den = raw.split("/")
        return float(num) / float(den) if float(den) else 0.0
    except Exception:
        return 0.0


def fmt_srt_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def escape_ffmpeg_path(path: Path) -> str:
    """Escape a path for use inside an FFmpeg filter argument."""
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


# ---------------------------------------------------------------------------
# Laravel Job API client
# ---------------------------------------------------------------------------

class JobApi:
    def __init__(self, key: str):
        import requests

        self._requests = requests
        self.key = key

    def _request(self, method: str, path: str, **kwargs):
        kwargs.setdefault("timeout", 60)
        headers = api_headers(self.key)
        headers.update(kwargs.pop("headers", {}))
        resp = self._requests.request(method, API_BASE + path, headers=headers, **kwargs)
        return resp

    def list_queued(self) -> list[dict]:
        resp = self._request("GET", "/muse/jobs?status=queued")
        if resp.status_code != 200:
            raise RuntimeError(f"List queued jobs failed: HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        return data.get("jobs", data.get("data", []))

    def get_job(self, job_id) -> dict:
        resp = self._request("GET", f"/muse/jobs/{job_id}")
        if resp.status_code != 200:
            raise RuntimeError(f"Get job {job_id} failed: HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        return data.get("job", data)

    def delete_clips(self, job_id) -> int:
        """Delete ALL clips of a job (rows + files) over the Job API.

        Used only when reclaiming a stale job: partial clips from the
        dead run must not survive next to the fresh run's clips.
        Returns the number of clips deleted.
        """
        resp = self._request("DELETE", f"/muse/jobs/{job_id}/clips")
        if resp.status_code != 200:
            raise RuntimeError(
                f"Delete clips for job {job_id} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        return int(resp.json().get("deleted", 0))

    def download_source(self, job_id, dest: Path) -> Path:
        """Download an uploaded source file over the Job API.

        Used when the worker runs on a DIFFERENT machine than the
        backend (hosted site): the local path in the job detail does not
        exist here, so the file is streamed down instead. The 10-minute
        timeout covers large uploads on a slow connection.
        """
        resp = self._request(
            "GET", f"/muse/jobs/{job_id}/source", stream=True, timeout=600
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Download job {job_id} source failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
        return dest

    def set_status(self, job_id, status: str, error_reason: str | None = None,
                   stage: str | None = None, progress: int | None = None,
                   note: str | None = None) -> dict:
        payload: dict = {"status": status}
        if error_reason is not None:
            payload["error_reason"] = error_reason[:500]
        if stage is not None:
            payload["stage"] = stage
        if progress is not None:
            payload["progress"] = progress
        if note is not None:
            payload["note"] = note[:1000]
        resp = self._request("PATCH", f"/muse/jobs/{job_id}/status", json=payload)
        if resp.status_code not in (200, 202):
            raise RuntimeError(
                f"Set job {job_id} status to {status} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        data = resp.json()
        return data.get("job", data)

    def upload_clip(self, job_id, clip_path: Path, fields: dict, thumbnail: Path | None = None) -> dict:
        files: dict = {}
        handles = []
        try:
            fh = open(clip_path, "rb")
            handles.append(fh)
            files["file"] = (clip_path.name, fh, "video/mp4")
            if thumbnail is not None and thumbnail.exists():
                th = open(thumbnail, "rb")
                handles.append(th)
                files["thumbnail"] = (thumbnail.name, th, "image/jpeg")
            resp = self._request(
                "POST", f"/muse/jobs/{job_id}/clips",
                files=files, data={k: str(v) for k, v in fields.items()},
                timeout=300,
            )
        finally:
            for h in handles:
                h.close()
        if resp.status_code not in (200, 201):
            raise RuntimeError(
                f"Upload clip {clip_path.name} for job {job_id} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        data = resp.json()
        return data.get("clip", data)

    # --- Clip re-renders (worker side) ---

    def list_rerenders(self) -> list[dict]:
        resp = self._request("GET", "/muse/rerenders")
        if resp.status_code == 404:
            # The re-render routes ship with the Stronger round; a backend
            # deployed before them (live is still on 72694ce until the
            # round is pushed) simply has no such route. That is not a
            # failure — it just means no re-renders can be queued there.
            log.warning("Re-render routes not present on this backend (HTTP 404); skipping re-render check.")
            return []
        if resp.status_code != 200:
            raise RuntimeError(f"List queued re-renders failed: HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        return data.get("rerenders", [])

    def set_rerender_status(self, rerender_id, status: str,
                            error_message: str | None = None) -> dict:
        payload: dict = {"status": status}
        if error_message is not None:
            payload["error_message"] = error_message[:500]
        resp = self._request("PATCH", f"/muse/rerenders/{rerender_id}/status", json=payload)
        if resp.status_code not in (200, 202):
            raise RuntimeError(
                f"Set re-render {rerender_id} status to {status} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        data = resp.json()
        return data.get("rerender", data)

    def upload_replacement_clip(self, clip_id, clip_path: Path, rerender_id,
                                thumbnail: Path | None = None,
                                duration_seconds: float | None = None) -> dict:
        files: dict = {}
        handles = []
        try:
            fh = open(clip_path, "rb")
            handles.append(fh)
            files["file"] = (clip_path.name, fh, "video/mp4")
            if thumbnail is not None and thumbnail.exists():
                th = open(thumbnail, "rb")
                handles.append(th)
                files["thumbnail"] = (thumbnail.name, th, "image/jpeg")
            data = {"rerender_id": str(rerender_id)}
            if duration_seconds is not None:
                data["duration_seconds"] = str(duration_seconds)
            resp = self._request(
                "POST", f"/muse/clips/{clip_id}/file",
                files=files, data=data, timeout=300,
            )
        finally:
            for h in handles:
                h.close()
        if resp.status_code not in (200, 201):
            raise RuntimeError(
                f"Upload replacement clip {clip_path.name} for clip {clip_id} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        return resp.json()


# ---------------------------------------------------------------------------
# Source acquisition
# ---------------------------------------------------------------------------

def is_youtube_live(url: str) -> bool:
    return "/live/" in url or "youtube.com/live" in url


def download_with_ytdlp(url: str, dest: Path, is_live: bool) -> Path:
    """Download a link with yt-dlp. Live streams are capped (see header).

    Returns the downloaded file path. Raises with the exact reason on
    failure. For live streams the file is whatever yt-dlp wrote inside the
    timeout window; it is validated by ffprobe by the caller.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    out_template = str(dest.with_suffix("")) + ".%(ext)s"
    cmd = [YT_DLP, "-f", YT_DLP_FORMAT, "-o", out_template, "--no-playlist",
           "--no-warnings", url]
    if is_live:
        cmd = [YT_DLP, "--live-from-start", "-f", YT_DLP_FORMAT,
               "-o", out_template, "--no-playlist", "--no-warnings", url]
        log.info("Live stream detected: capturing at most %d seconds "
                 "(timeout %d); the captured file is whatever yt-dlp writes "
                 "in that window.", LIVE_CAPTURE_TIMEOUT_SECONDS,
                 LIVE_CAPTURE_TIMEOUT_SECONDS)
        try:
            proc = run(cmd, timeout=LIVE_CAPTURE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            # timeout(1) semantics: the `timeout` here is our own wait; the
            # subprocess was killed by run()'s timeout, so the partial file
            # (if any) is what we have.
            log.info("Live capture hit the %ds cap; using the partial file "
                     "if it probes cleanly.", LIVE_CAPTURE_TIMEOUT_SECONDS)
            proc = None
        if proc is not None and proc.returncode != 0:
            raise RuntimeError(
                "yt-dlp failed for live URL: " + (proc.stderr or proc.stdout or "").strip()[-300:]
            )
    else:
        proc = run(cmd, timeout=1800)
        if proc.returncode != 0:
            raise RuntimeError(
                "yt-dlp failed for URL: " + (proc.stderr or proc.stdout or "").strip()[-300:]
            )
    candidates = sorted(dest.parent.glob(dest.stem + ".*"))
    candidates = [c for c in candidates if c.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}]
    if not candidates:
        raise RuntimeError("yt-dlp finished but produced no video file.")
    downloaded = max(candidates, key=lambda p: p.stat().st_size)
    if downloaded.resolve() != dest.resolve():
        shutil.move(str(downloaded), str(dest))
    if dest.stat().st_size == 0:
        raise RuntimeError("yt-dlp produced an empty (0-byte) file.")
    return dest


def download_direct(url: str, dest: Path) -> Path:
    """Fallback for direct video-file URLs: plain HTTP download, size-capped."""
    req = urllib.request.Request(url, headers={"User-Agent": "MagicianClipper/1.0"})
    size = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_DIRECT_DOWNLOAD_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise RuntimeError("Direct download exceeds the 2 GiB cap.")
            out.write(chunk)
    if dest.stat().st_size == 0:
        raise RuntimeError("Direct download produced an empty (0-byte) file.")
    return dest


def acquire_source(api: "JobApi", job: dict, job_dir: Path) -> tuple[Path, str]:
    """Resolve the job's video to a local file.

    Returns (local_path, note) where note documents exactly what was
    captured (uploaded file path, or download method + live cap if any).

    Uploaded sources are resolved in two ways, in order:
    1. Local path — when the worker runs on the same machine as the
       backend (dev setup), the file is already on disk.
    2. Job API download — when the worker runs on a DIFFERENT machine
       than the backend (hosted site), the local file does not exist
       here, so it is downloaded over GET /muse/jobs/{job}/source.
    """
    settings = job.get("settings") or {}
    source_type = (job.get("source_type") or settings.get("source_type") or "upload").lower()
    if source_type == "upload" or job.get("source_path"):
        rel = job.get("source_path") or settings.get("source_path")
        if not rel:
            raise RuntimeError("Job has source_type 'upload' but no source_path.")
        # Never trust a path that escapes the Laravel storage root.
        candidate = (LARAVEL_STORAGE / rel).resolve()
        if not str(candidate).startswith(str(LARAVEL_STORAGE.resolve())):
            raise RuntimeError("source_path escapes the Laravel storage root; refused.")
        if candidate.exists():
            return candidate, f"uploaded file storage/app/{rel}"
        # Remote worker: the file lives on the hosted backend, not here.
        # Download it over the Job API (same key as every other call).
        suffix = Path(rel).suffix.lower() or ".mp4"
        if suffix not in {".mp4", ".mov", ".mkv", ".webm"}:
            suffix = ".mp4"
        dest = job_dir / f"source{suffix}"
        api.download_source(job["id"], dest)
        return dest, (
            f"uploaded file downloaded over the Job API "
            f"(GET /muse/jobs/{job['id']}/source)"
        )
    url = job.get("source_url") or settings.get("source_url")
    if not url:
        raise RuntimeError("Job has no uploaded file and no source_url.")
    dest = job_dir / f"source{Path(url.split('?')[0]).suffix.lower() or '.mp4'}"
    if dest.suffix.lower() not in {".mp4", ".mov", ".mkv", ".webm"}:
        dest = job_dir / "source.mp4"
    live = is_youtube_live(url)
    # Pre-staged source (reuse path): if a local file was already placed
    # at the exact path this download would write (job_dir/source.<ext>),
    # use it instead of re-downloading the link. This covers already-
    # downloaded excerpts of the same stream (e.g. the acceptance-test
    # source concatenated from local segments). The file is still probed
    # by the caller, so a corrupt staged file fails the job with the
    # exact ffprobe reason rather than being used blindly.
    for ext in (".mp4", ".mkv", ".webm", ".mov"):
        staged = job_dir / f"source{ext}"
        if staged.exists() and staged.stat().st_size > 0:
            return staged, (
                f"pre-staged local source {staged.name} in the worker job "
                "dir (reused excerpts of the linked stream; no re-download)"
            )
    try:
        downloaded = download_with_ytdlp(url, dest, live)
        note = ("yt-dlp download of " + ("YouTube LIVE (capped at "
                f"{LIVE_CAPTURE_TIMEOUT_SECONDS}s of recording)" if live else "link"))
        return downloaded, note
    except RuntimeError as exc:
        if live:
            raise
        # Direct video-file URLs get one plain-HTTP fallback.
        if re.search(r"\.(mp4|mov|mkv|webm)(\?|$)", url, re.IGNORECASE):
            log.info("yt-dlp failed (%s); trying direct HTTP download.", str(exc)[:120])
            return download_direct(url, dest), "direct HTTP download of link (yt-dlp failed)"
        raise


# ---------------------------------------------------------------------------
# Transcription (faster-whisper, base, CPU int8)
# ---------------------------------------------------------------------------

def extract_audio(source: Path, wav_path: Path) -> None:
    """Extract a mono 16 kHz WAV whose timeline matches the video timeline.

    The ``aresample=async=1:first_pts=0`` filter fills timestamp gaps in
    the source audio with silence instead of compressing them out. Without
    it, a source whose audio drops out (e.g. a live-stream excerpt whose
    first segment carries only 16 s of audio in 90 s of video) yields a
    WAV shorter than the video, and every later transcript timestamp is
    shifted early by the missing time — captions would then be burned over
    the wrong footage. With the filter the WAV is exactly as long as the
    video and transcript times are video times.
    """
    proc = run([FFMPEG, "-y", "-v", "error", "-i", str(source),
                "-vn", "-ac", "1", "-ar", "16000",
                "-af", "aresample=async=1:first_pts=0",
                "-c:a", "pcm_s16le",
                str(wav_path)], timeout=1800)
    if proc.returncode != 0 or not wav_path.exists() or wav_path.stat().st_size == 0:
        raise RuntimeError(f"Audio extraction failed: {(proc.stderr or '').strip()[:300]}")


def load_wav_as_array(wav_path: Path):
    """Load a mono 16-bit WAV as a float32 numpy array for faster-whisper.

    Passing an ndarray to model.transcribe() skips faster-whisper's
    decode_audio(), which calls av.open(metadata_errors=...) — a keyword
    PyAV 19 removed, so faster-whisper 1.2.1 + av 19.0.2 fails with
    "open() got an unexpected keyword argument 'metadata_errors'".
    (requirements.txt also pins av<19 as a second line of defence.)
    """
    import numpy as np

    with wave.open(str(wav_path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
            raise RuntimeError(
                f"Expected a mono 16-bit 16 kHz WAV for transcription, got "
                f"{wav.getnchannels()}ch {wav.getsampwidth() * 8}-bit "
                f"{wav.getframerate()} Hz: {wav_path.name}"
            )
        frames = wav.readframes(wav.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(wav_path: Path, language: str | None) -> list[dict]:
    """Transcribe with faster-whisper base/int8. Returns word-level segments.

    Each item: {start, end, text, words: [{start, end, word}]}.
    Raises with the exact reason on failure (model download included).
    The WAV is passed as a numpy array (see load_wav_as_array).
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(f"faster-whisper is not installed in the worker venv: {exc}")
    log.info("Transcribing with faster-whisper model=%s compute=int8 threads=%d "
             "language=%s", WHISPER_MODEL, WHISPER_THREADS, language or "auto")
    model = WhisperModel(WHISPER_MODEL, device="cpu",
                         compute_type="int8", cpu_threads=WHISPER_THREADS)
    audio = load_wav_as_array(wav_path)
    segments, _info = model.transcribe(
        audio, language=language, word_timestamps=True,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
    )
    out: list[dict] = []
    for seg in segments:
        words = [{"start": float(w.start), "end": float(w.end), "word": w.word}
                 for w in (seg.words or [])]
        out.append({"start": float(seg.start), "end": float(seg.end),
                    "text": seg.text.strip(), "words": words})
    log.info("Transcription produced %d segments.", len(out))
    return out


def wav_rms_profile(wav_path: Path, window: float = 1.0) -> list[float]:
    """Per-second RMS energy of the mono 16 kHz WAV (supporting signal only)."""
    try:
        with wave.open(str(wav_path), "rb") as wav:
            n_frames = wav.getnframes()
            rate = wav.getframerate()
            frames = wav.readframes(n_frames)
    except Exception:
        return []
    import array as _array
    samples = _array.array("h")
    samples.frombytes(frames)
    if wav.getsampwidth() != 2:
        return []
    per = max(1, int(rate * window))
    profile: list[float] = []
    for i in range(0, len(samples), per):
        chunk = samples[i:i + per]
        if not chunk:
            break
        mean_sq = sum(float(s) * float(s) for s in chunk) / len(chunk)
        profile.append(math.sqrt(mean_sq) / 32768.0)
    return profile


# ---------------------------------------------------------------------------
# Highlight selection (explainable scoring)
# ---------------------------------------------------------------------------

def _sentences(segments: list[dict]) -> list[dict]:
    """Split transcript segments into sentence-ish units.

    A unit ends at [.?!] or at a segment boundary. Keeps word timings so
    windows can be cut at word boundaries (never mid-word).
    """
    units: list[dict] = []
    for seg in segments:
        words = seg["words"] or []
        if not words:
            if seg["text"]:
                units.append({"start": seg["start"], "end": seg["end"],
                              "text": seg["text"], "words": []})
            continue
        current: list[dict] = []
        for word in words:
            current.append(word)
            text = word["word"]
            if text and text.rstrip()[-1:] in ".?!":
                units.append({"start": current[0]["start"], "end": current[-1]["end"],
                              "text": " ".join(w["word"] for w in current).strip(),
                              "words": list(current)})
                current = []
        if current:
            units.append({"start": current[0]["start"], "end": current[-1]["end"],
                          "text": " ".join(w["word"] for w in current).strip(),
                          "words": list(current)})
    return units


def speech_coverage(units: list[dict], start: float, end: float) -> float:
    """Fraction of [start, end] covered by transcribed speech (Fix 2).

    Uses sentence-unit spans (word timings where present). 0.0 when the
    window contains no speech, 1.0 when the whole window is speech. A
    window extended into a silent gap to satisfy a duration mode scores
    low here even if its few spoken words are dense.
    """
    if end <= start:
        return 0.0
    covered = 0.0
    for u in units:
        lo, hi = max(u["start"], start), min(u["end"], end)
        if hi > lo:
            covered += hi - lo
    return min(1.0, covered / (end - start))


def _select_usable_windows(candidates: list[dict], count: int) -> list[dict]:
    """Pick up to ``count`` non-overlapping windows, preferring windows
    with real audio coverage (Fix 2).

    Pass 1: greedy by score among windows with coverage >=
    MIN_SPEECH_COVERAGE. Pass 2 (only if pass 1 is short): greedy by
    earliest end time among the same usable pool — the classic
    maximum-cardinality interval choice, which can find a full set of
    usable windows that score-greedy blocks (e.g. one high-scoring
    window straddling two usable ones). If the usable pool cannot fill
    the count, the shortfall is returned as-is (fewer clips, honestly)
    — a mostly-silent window is never used to pad the count. Only when
    NO window meets the coverage floor does the selector fall back to
    the best-coverage windows available, each flagged low_audio_coverage
    so it is never presented as a good highlight.
    """
    def greedy(pool: list[dict], key) -> list[dict]:
        picked: list[dict] = []
        for cand in sorted(pool, key=key):
            if len(picked) >= count:
                break
            if any(not (cand["end"] <= o["start"] or cand["start"] >= o["end"])
                   for o in picked):
                continue
            picked.append(cand)
        return picked

    usable = [c for c in candidates if c["coverage"] >= MIN_SPEECH_COVERAGE]
    if usable:
        chosen = greedy(usable, key=lambda c: (-c["score"], c["start"]))
        if len(chosen) < count:
            by_end = greedy(usable, key=lambda c: (c["end"], -c["score"]))
            if len(by_end) > len(chosen):
                for c in by_end:
                    if "coverage_priority_selection" not in c["signals"]:
                        c["signals"].append("coverage_priority_selection")
                        c["reason"] += (" Selected to maximise the number "
                                        "of usable (speech-covered) clips.")
                chosen = by_end
        return chosen
    # No usable window exists at all: use the best-coverage windows
    # available, flagged honestly — never as good highlights.
    flagged = greedy(candidates, key=lambda c: (-c["coverage"], -c["score"]))
    for c in flagged:
        c["signals"].append("low_audio_coverage")
        c["reason"] += (f" WARNING: only {c['coverage']:.0%} of this window "
                        "contains transcribed speech (mostly silent); used "
                        "only because no better-covered window exists.")
    return flagged


def _visual_moment_windows(energy_profile: list[float], source_duration: float,
                           span: float, mode: str,
                           min_s: float | None, max_s: float | None,
                           count: int,
                           occupied: list[tuple[float, float]],
                           energy_in, gameplay_in, stability_in) -> list[dict]:
    """Energy-ranked visual moments: windows centred on the loudest
    audio peaks, for sources where speech is scarce or absent.

    A window is centred on a peak second (peak + 0.5s), clamped to the
    source, and must not overlap any ``occupied`` window or another
    visual moment. Its duration honours the job's mode: exact/minimum
    need a full ``span`` (the min bound), maximum needs at least
    ``min_s`` when the job set one. Peaks that cannot fit a valid window
    are skipped — a short window is never delivered to pad the count.
    Scored only on energy/gameplay/stability and labelled
    ``visual_moment`` so the job page never presents one as a speech
    highlight. Returns at most ``count`` windows, sorted by start time.
    An all-zero (silent) energy profile yields no windows.
    """
    if count <= 0 or not energy_profile or max(energy_profile) <= 0:
        return []
    if mode in ("exact", "minimum") and span > source_duration + DURATION_TOLERANCE:
        return []
    if mode == "maximum" and min_s and min_s > source_duration + DURATION_TOLERANCE:
        return []
    # A visual window is exactly ``span`` long (the mode's bound), except
    # in maximum mode where the floor is min_s and span is the ceiling.
    length = span
    if mode == "maximum" and min_s and span < min_s:
        length = min_s
    if length > source_duration:
        length = source_duration
    if mode == "maximum" and min_s and length < min_s - DURATION_TOLERANCE:
        return []
    if mode in ("exact", "minimum") and length < span - DURATION_TOLERANCE:
        return []

    def overlaps(start: float, end: float, taken: list[tuple[float, float]]) -> bool:
        return any(not (end <= o_start or start >= o_end)
                   for (o_start, o_end) in taken)

    picked: list[dict] = []
    taken = list(occupied)
    # Loudest seconds first; ties break toward earlier in the source.
    peaks = sorted(range(len(energy_profile)),
                   key=lambda i: (-energy_profile[i], i))
    for peak in peaks:
        if len(picked) >= count:
            break
        centre = peak + 0.5
        start = max(0.0, centre - length / 2)
        end = start + length
        if end > source_duration:
            end = source_duration
            start = end - length
        if start < 0 or end - start < length - DURATION_TOLERANCE:
            continue
        if overlaps(start, end, taken):
            continue
        energy = energy_in(start, end)
        gameplay = gameplay_in(start, end)
        stability = stability_in(start, end)
        score = round(
            W_VISUAL_ENERGY * min(1.0, energy)
            + W_VISUAL_GAMEPLAY * gameplay
            + W_VISUAL_STABILITY * stability, 4)
        signals = ["visual_moment"]
        if energy > 0:
            signals.append("audio_energy")
        if gameplay >= 0.5:
            signals.append("gameplay_present")
        if stability >= 0.8:
            signals.append("single_scene")
        picked.append({
            "start": round(start, 3), "end": round(end, 3),
            "duration": round(end - start, 3), "words": 0,
            "density": 0.0, "complete": False, "coverage": 0.0,
            "silence": 0.0, "energy": energy,
            "gameplay": gameplay, "stability": stability,
            "score": score, "signals": signals, "text": "",
            "reason": (
                f"Visual moment (viral {round(score * 100)}/100): speech "
                f"was scarce in this source, so this window was picked "
                f"for its loudest audio moment — energy {energy:.2f}, "
                f"gameplay {gameplay:.2f}, scene stability {stability:.2f}. "
                f"Not a speech highlight."),
        })
        taken.append((start, end))
    picked.sort(key=lambda c: c["start"])
    return picked


def select_highlights(segments: list[dict], source_duration: float,
                      settings: dict, energy_profile: list[float],
                      face_profile: list[tuple[float, float]] | None = None) -> list[dict]:
    """Select exactly clip_count non-overlapping windows.

    Scoring (documented weights): speech density 0.25, audio coverage
    0.20, sentence completeness 0.20, silence boundaries 0.05, audio
    energy 0.05 (supporting only), gameplay presence 0.15 (real gameplay
    on screen beats a full-facecam talking stretch), scene stability
    0.10 (a window staying in one scene beats one spanning a
    facecam->gameplay switch, which one static split crop cannot serve).
    Raises if zero valid windows exist; returns fewer than requested
    only when the source genuinely has too little usable content, with
    the reason recorded on each clip. ``face_profile`` is a list of
    (time, face_area_fraction) samples; when absent the gameplay and
    stability terms are neutral (0.5).
    """
    count = int(settings.get("clip_count", 3))
    mode = (settings.get("duration_mode") or "exact").lower()
    target = float(settings.get("duration_seconds", 30))
    # The New Job form collects BOTH bounds for the non-exact modes
    # (and requires min < max): minimum mode promises clips >= min AND
    # <= max, maximum mode promises clips <= max AND >= min. Both bounds
    # are stored in the job settings; honour them here — a stored bound
    # that the selector ignores is a lie to the user.
    min_s = settings.get("duration_min_seconds")
    min_s = float(min_s) if min_s not in (None, "") else None
    max_s = settings.get("duration_max_seconds")
    max_s = float(max_s) if max_s not in (None, "") else None
    lead = float(settings.get("lead_seconds", 0.5))
    tail = float(settings.get("tail_seconds", 0.5))

    units = _sentences(segments)
    max_energy = max(energy_profile) if energy_profile else 0.0

    def energy_in(start: float, end: float) -> float:
        if not energy_profile or max_energy <= 0:
            return 0.0
        idx = range(int(start), min(len(energy_profile), int(end) + 1))
        vals = [energy_profile[i] for i in idx]
        return (sum(vals) / len(vals) / max_energy) if vals else 0.0

    def gameplay_in(start: float, end: float) -> float:
        """Gameplay presence of [start, end] from the face-area profile.

        A small facecam inset means mostly gameplay (score near 1); a
        face filling the frame means a talking stretch with no gameplay
        to show (score near 0). A face area fraction of 0.08 (8% of the
        frame) is the reference point: at or above it the window counts
        as facecam-only. The inset face reads ~0.01, a full-facecam face
        ~0.08. No profile -> neutral 0.5 (no bias).
        """
        if not face_profile:
            return 0.5
        vals = [frac for (t, frac) in face_profile if start <= t < end]
        if not vals:
            return 0.5
        avg = sum(vals) / len(vals)
        return max(0.0, min(1.0, 1.0 - avg / 0.08))

    def stability_in(start: float, end: float) -> float:
        """Scene stability of [start, end] from the face-area profile.

        If the face fraction swings a lot inside the window, the window
        spans a scene change (full-facecam stretch -> gameplay with a
        small inset) and one static split crop cannot serve both halves,
        so it scores lower. A swing of 0.08 (facecam ~0.08 vs inset
        ~0.01) is a full scene change. No profile -> neutral 0.5.
        """
        if not face_profile:
            return 0.5
        vals = [frac for (t, frac) in face_profile if start <= t < end]
        if len(vals) < 2:
            return 0.5
        spread = max(vals) - min(vals)
        return max(0.0, min(1.0, 1.0 - spread / 0.08))

    def gap_before(t: float) -> float:
        prev_end = 0.0
        for u in units:
            if u["end"] <= t + 1e-6:
                prev_end = max(prev_end, u["end"])
            else:
                break
        return t - prev_end

    def gap_after(t: float) -> float:
        for u in units:
            if u["start"] >= t - 1e-6:
                return u["start"] - t
        return source_duration - t

    candidates: list[dict] = []
    if units:
        # Candidate windows: start at a sentence start, extend sentence by
        # sentence until the duration mode is satisfied.
        for i, unit in enumerate(units):
            start = max(0.0, unit["start"] - lead)
            words: list[dict] = []
            end = unit["end"]
            complete = True
            j = i
            while j < len(units):
                u = units[j]
                words.extend(u["words"])
                end = u["end"]
                span = (end + tail) - start
                if mode == "exact" and span >= target:
                    break
                if mode == "maximum" and span >= target:
                    break
                if mode == "minimum" and span >= target and j > i:
                    break
                j += 1
                if mode == "minimum" and span >= target:
                    break
            else:
                complete = False
            window_end = end + tail
            span = window_end - start
            if mode == "exact":
                if span < target - DURATION_TOLERANCE:
                    # Too short even with neighbours: extend into nearby
                    # context where possible, else reject this candidate.
                    room_after = source_duration - window_end
                    room_before = start
                    need = target - span
                    extend_after = min(room_after, need)
                    window_end += extend_after
                    need -= extend_after
                    start = max(0.0, start - need)
                    span = window_end - start
                    if span < target - DURATION_TOLERANCE:
                        continue
                elif span > target + DURATION_TOLERANCE:
                    window_end = start + target
                    span = target
                    complete = False  # trimmed mid-thought
            elif mode == "minimum":
                if span < target:
                    continue
                # The user set a Max too: a long sentence must not push
                # the clip past it. Trim (mid-sentence) rather than break
                # the promised range.
                if max_s and span > max_s + DURATION_TOLERANCE:
                    window_end = start + max_s
                    span = max_s
                    complete = False
            elif mode == "maximum":
                if span > target + DURATION_TOLERANCE:
                    window_end = start + target
                    span = target
                    complete = False
            if window_end > source_duration + 1e-6:
                window_end = source_duration
                span = window_end - start
                if mode in ("exact", "minimum") and span < target - DURATION_TOLERANCE:
                    continue
            # Maximum mode promises a floor too: a tail window that ran
            # out of speech below Min is rejected, not delivered short.
            if mode == "maximum" and min_s and span < min_s - DURATION_TOLERANCE:
                continue
            if span <= 0:
                continue
            word_count = len(words)
            density = word_count / span if span else 0.0
            # Normalise density against the densest candidate (computed below).
            # Coverage is measured on the FINAL window (after any extension
            # into nearby context for the duration mode), so a window padded
            # with silence is honestly measured as mostly silent.
            candidates.append({
                "start": round(start, 3), "end": round(window_end, 3),
                "duration": round(span, 3), "words": word_count,
                "density": density, "complete": complete,
                "coverage": speech_coverage(units, start, window_end),
                "silence": min(2.0, gap_before(start) + gap_after(window_end)) / 2.0,
                "energy": energy_in(start, window_end),
                "gameplay": gameplay_in(start, window_end),
                "stability": stability_in(start, window_end),
                "text": " ".join(u["text"] for u in units[i:j + 1])[:300],
                "signals": [],
            })

    if candidates:
        max_density = max(c["density"] for c in candidates) or 1.0
        for c in candidates:
            density_n = min(1.0, c["density"] / max_density)
            completeness = 1.0 if c["complete"] else 0.4
            silence_n = min(1.0, c["silence"])
            c["score"] = round(
                W_DENSITY * density_n
                + W_COVERAGE * c["coverage"]
                + W_COMPLETENESS * completeness
                + W_SILENCE * silence_n
                + W_ENERGY * min(1.0, c["energy"])
                + W_GAMEPLAY * c["gameplay"]
                + W_STABILITY * c["stability"], 4)
            c["signals"] = ["speech_density", "sentence_complete" if c["complete"] else "trimmed_to_duration",
                            "silence_boundary", "audio_coverage"]
            if c["energy"] > 0:
                c["signals"].append("audio_energy_supporting")
            if c["gameplay"] >= 0.5:
                c["signals"].append("gameplay_present")
            if c["stability"] >= 0.8:
                c["signals"].append("single_scene")
            c["reason"] = (
                f"Score {c['score']:.2f} (viral {round(c['score'] * 100)}/100): "
                f"speech density {density_n:.2f}, "
                f"audio coverage {c['coverage']:.2f}, "
                f"sentence {'complete' if c['complete'] else 'trimmed'}, "
                f"silence boundary {silence_n:.2f}, audio energy (supporting) {c['energy']:.2f}, "
                f"gameplay {c['gameplay']:.2f}, scene stability {c['stability']:.2f}."
            )
        chosen = _select_usable_windows(candidates, count)
        if len(chosen) < count:
            # Speech is scarce: fill the remaining slots with
            # energy-ranked visual moments (loudest audio peaks),
            # honestly labelled — a music-led source still yields
            # clips, but nobody is told they are speech highlights.
            chosen = chosen + _visual_moment_windows(
                energy_profile, source_duration, target, mode,
                min_s, max_s, count - len(chosen),
                [(c["start"], c["end"]) for c in chosen],
                energy_in, gameplay_in, stability_in)
        if chosen:
            chosen.sort(key=lambda c: c["start"])
            return chosen

    if units:
        # Speech exists, but no window met the duration bounds or the
        # speech-coverage bar (e.g. only a 20s stretch of speech for a
        # 30-90s job). Visual moments (loudest audio peaks) may still
        # fill the job — a uniform window over a speech source is mostly
        # silence, exactly the boring content the user does not want.
        # When even those cannot fit, return the honest shortfall
        # (possibly zero clips); the job page explains why fewer clips
        # came back.
        fill = _visual_moment_windows(
            energy_profile, source_duration, target, mode,
            min_s, max_s, count, [],
            energy_in, gameplay_in, stability_in)
        if fill:
            return fill
        return []

    # Fallback: no usable transcribed speech at all (e.g. music-only /
    # silent source). Prefer energy-ranked visual moments (loudest audio
    # peaks) over uniform windows; uniform only when the source is
    # silent (energy all zero) — real footage either way, clearly
    # labelled so nobody mistakes it for a speech-driven highlight.
    visual = _visual_moment_windows(
        energy_profile, source_duration, target, mode,
        min_s, max_s, count, [],
        energy_in, gameplay_in, stability_in)
    if visual:
        return visual
    if source_duration < target and mode in ("exact", "minimum"):
        raise RuntimeError(
            f"Source is {source_duration:.1f}s long but the job requests "
            f"{count}x {target:.0f}s clips in '{mode}' mode: not enough "
            "content for even one valid clip."
        )
    span = min(target, source_duration) if mode in ("exact", "maximum") else target
    if mode == "minimum" and source_duration < target:
        raise RuntimeError(
            f"Source is {source_duration:.1f}s long but 'minimum' mode "
            f"requires {target:.0f}s per clip."
        )
    windows: list[dict] = []
    start = 0.0
    while len(windows) < count and start + 1.0 <= source_duration:
        end = min(source_duration, start + span)
        if end - start < 1.0:
            break
        windows.append({
            "start": round(start, 3), "end": round(end, 3),
            "duration": round(end - start, 3), "words": 0,
            "density": 0.0, "complete": False, "coverage": 0.0,
            "silence": 0.0,
            "energy": energy_in(start, end), "score": 0.0,
            "signals": ["no_speech_fallback"],
            "text": "",
            "reason": ("No transcribed speech found in the source; uniform "
                       "window used as a documented fallback (real footage, "
                       "not a speech-driven highlight)."),
        })
        start = end
    if not windows:
        raise RuntimeError(
            "No valid clip windows could be selected: the source has no "
            "transcribed speech and is too short for uniform fallback windows."
        )
    return windows


# ---------------------------------------------------------------------------
# Captions (SRT per clip) + face detection for split layout
# ---------------------------------------------------------------------------

def write_clip_srt(segments: list[dict], start: float, end: float,
                   srt_path: Path) -> bool:
    """Write an SRT for the clip window (times shifted to 0-based).

    Returns True when at least one cue was written.
    """
    cues: list[tuple[float, float, str]] = []
    for seg in segments:
        s, e = max(seg["start"], start), min(seg["end"], end)
        if e <= s or not seg["text"]:
            continue
        cues.append((s - start, e - start, seg["text"]))
    if not cues:
        return False
    lines: list[str] = []
    for i, (s, e, text) in enumerate(cues, 1):
        lines.append(f"{i}\n{fmt_srt_time(s)} --> {fmt_srt_time(e)}\n{text}\n")
    srt_path.write_text("\n".join(lines), encoding="utf-8")
    return True


# ---------------------------------------------------------------------------
# Caption styles (13 total: 5 original + 8 CapCut-style animated,
# added 2026-11-22)
#
# The styles are a DATA table shared with the frontend
# (apps/web/src/lib/captionStyles.ts) — the Captions Studio page shows
# them as selectable samples, and the selected style id is stored on the
# job as settings.caption_style. The worker renders exactly the selected
# style onto the subtitles. New samples the user sends later are added
# here AND in captionStyles.ts, nothing else needs to change.
# Reference: three user-supplied shorts (Speed reacts GTA 6 ending,
# one-word facecam-card clip, GTA 6 highest-point tower):
#   - streamer FULL top / gameplay FULL bottom, captions centred on the
#     divider (never over the face, never covering the whole frame);
#   - huge bold white type with a thick black outline, key words YELLOW;
#   - 1-4 words per screen, word-by-word build-up, hook in 3 seconds.
# The 8 animated styles follow the CapCut kinetic-caption set
# (Word Pop / Karaoke Fill / Bounce / Typewriter / Highlight Sweep /
# Neon Glow / Word Slam / Outline / Gradient): the Captions Studio
# preview loops the same motion the ASS below burns in — same words,
# same colours, same entrance. libass renders the \t scale transforms,
# \k karaoke fills and \1c colour overrides used here.
# ---------------------------------------------------------------------------

CAPTION_STYLES = {
    "punchy": "Punchy",
    "word_pop": "Word Pop",
    "title_card": "Title Card",
    "clean_subs": "Clean Subtitles",
    "classic": "Classic",
    "karaoke": "Karaoke Fill",
    "bounce": "Bounce In",
    "typewriter": "Typewriter",
    "sweep": "Highlight Sweep",
    "neon": "Neon Glow",
    "slam": "Word Slam",
    "outline": "Outline Only",
    "gradient": "Gradient Pop",
}

# One bright colour per word, cycled (ASS BGR hex) — the Gradient Pop
# palette. Must match wordColors in captionStyles.ts.
GRADIENT_PALETTE = ["0000FFFF", "000080FF", "00FF00FF", "00FFFF00"]

# Words that get the yellow highlight in punchy captions: the emphatic /
# action word of a phrase. Falls back to the longest word (len >= 4).
EMPHASIS_WORDS = {
    "win", "wins", "won", "go", "goes", "going", "gone", "highest", "top",
    "first", "last", "best", "biggest", "huge", "insane", "crazy", "epic",
    "wow", "look", "watch", "free", "new", "secret", "hidden", "never",
    "ever", "actually", "literally", "impossible", "amazing", "shocking",
    "funny", "viral", "god", "dead", "kill", "run", "jump", "fly", "fall",
    "crash", "fire", "boom", "money", "ps5", "gta", "easy", "hard", "stop",
    "wait", "yes", "no", "oh", "bro", "guys", "lets", "let's", "come",
    "pick", "take", "get", "got", "throw", "chuck", "climb", "easter",
    "egg", "tower", "point", "clouds", "view", "map", "car", "drive",
}

_PUNCT = ".,!?:;\"'()[]"


def _ass_escape(text: str) -> str:
    return (text.replace("\\", "\\\\").replace("{", "\\{")
                .replace("}", "\\}").replace("\n", " "))


def _fmt_ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    total_cs = int(round(seconds * 100))
    h, rem = divmod(total_cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _clip_words(segments: list[dict], start: float, end: float) -> list[dict]:
    """Word-level timings inside [start, end], shifted to 0-based."""
    words: list[dict] = []
    for seg in segments:
        for w in (seg.get("words") or []):
            ws, we = w["start"] - start, w["end"] - start
            if we <= 0 or ws >= end - start:
                continue
            text = (w.get("word") or "").strip()
            if text:
                words.append({"start": max(0.0, ws), "end": min(end - start, we),
                              "word": text})
    words.sort(key=lambda w: w["start"])
    return words


def _group_phrases(words: list[dict], max_words: int = 4) -> list[list[dict]]:
    """Group words into 1-4 word phrases (punchy caption units).

    Breaks at sentence punctuation, at a >0.9s gap, or at max_words.
    """
    phrases: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if current:
            prev = current[-1]
            gap = w["start"] - prev["end"]
            if gap > 0.9 or len(current) >= max_words:
                phrases.append(current)
                current = []
        current.append(w)
        if w["word"][-1:] in ".?!":
            phrases.append(current)
            current = []
    if current:
        phrases.append(current)
    return phrases


def _pick_keyword(phrase: list[dict]) -> str | None:
    for w in phrase:
        clean = w["word"].strip(_PUNCT).lower()
        if clean in EMPHASIS_WORDS:
            return w["word"]
    long_words = [w["word"] for w in phrase if len(w["word"].strip(_PUNCT)) >= 4]
    return max(long_words, key=len) if long_words else None


def _punchy_text(phrase: list[dict]) -> str:
    """Phrase text with the keyword wrapped in a yellow override."""
    keyword = _pick_keyword(phrase)
    parts: list[str] = []
    for w in phrase:
        text = _ass_escape(w["word"])
        if keyword is not None and w["word"] == keyword:
            parts.append("{\\1c&H00FFFF&}" + text + "{\\1c&HFFFFFF&}")
        else:
            parts.append(text)
    return " ".join(parts)


def write_clip_ass(segments: list[dict], start: float, end: float,
                   style_id: str, ass_path: Path,
                   divider_y: int | None, tw: int, th: int,
                   layout: str) -> bool:
    """Write an ASS caption file for the clip window (0-based times).

    ``divider_y`` is the y of the streamer/gameplay divider in output
    pixels (split layout); None for layouts without a divider. Returns
    True when at least one event was written. ``classic`` is NOT handled
    here — it uses the legacy SRT path in render_clip.
    """
    duration = end - start
    big = tw >= 1080
    split = layout == "split" and divider_y is not None

    def margin_for(font_size: int) -> tuple[int, int]:
        """(alignment, marginV) — captions sit ON the divider when split,
        lower-centre otherwise (out of the face)."""
        if split:
            return 8, max(0, divider_y - font_size // 2)
        return 2, 140

    styles: dict[str, str] = {}
    if style_id == "punchy":
        fs = 96 if big else 68
        align, mv = margin_for(fs)
        styles["Punchy"] = (
            f"Style: Punchy,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,-1,0,0,0,100,100,0,0,1,3,0,{align},40,40,{mv},1"
        )
    elif style_id == "word_pop":
        fs = 130 if big else 92
        align, mv = margin_for(fs)
        styles["WordPop"] = (
            f"Style: WordPop,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,-1,0,0,0,100,100,0,0,1,4,0,{align},40,40,{mv},1"
        )
    elif style_id == "title_card":
        fs = 60 if big else 44
        align, mv = (8, max(0, divider_y - 40)) if split else (8, int(th * 0.40))
        styles["Title"] = (
            f"Style: Title,DejaVu Sans,{fs},&H00000000,&H000000FF,&H00FFFFFF,"
            f"&H00FFFFFF,-1,0,0,0,100,100,0,0,3,0,0,{align},40,40,{mv},1"
        )
        styles["CleanSubs"] = (
            "Style: CleanSubs,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,"
            "&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1"
        )
    elif style_id == "clean_subs":
        styles["CleanSubs"] = (
            "Style: CleanSubs,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,"
            "&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1"
        )
    elif style_id in ("karaoke", "bounce", "typewriter", "sweep",
                      "neon", "slam", "outline", "gradient"):
        # (name, fs_big, fs_small, primary, secondary, outline_colour,
        #  back_colour, bold, border_style, outline, shadow)
        # Colours are ASS &HAABBGGRR. Neon shadow is BackColour magenta,
        # so the glow reads; Outline is hollow (primary fully transparent).
        _NEW_STYLE_PARAMS = {
            "karaoke": ("Karaoke", 96, 68, "&H0000FFFF", "&H00FFFFFF",
                        "&H00000000", "&H80000000", -1, 1, 3, 0),
            "bounce": ("Bounce", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                       "&H00000000", "&H80000000", -1, 1, 4, 0),
            "typewriter": ("Typewriter", 72, 54, "&H00FFFFFF", "&H0000FFFF",
                           "&H00000000", "&H80000000", -1, 1, 3, 0),
            "sweep": ("Sweep", 96, 68, "&H00FFFFFF", "&H0000FFFF",
                      "&H00000000", "&H80000000", -1, 1, 3, 0),
            "neon": ("Neon", 100, 72, "&H00FFFF00", "&H00FF00FF",
                     "&H00FF00FF", "&H00FF00FF", -1, 1, 4, 2),
            "slam": ("Slam", 130, 92, "&H00FFFFFF", "&H0000FFFF",
                    "&H00000000", "&H80000000", -1, 1, 5, 1),
            "outline": ("Outline", 110, 78, "&HFF000000", "&H0000FFFF",
                        "&H00FFFFFF", "&H80000000", -1, 1, 4, 0),
            "gradient": ("Gradient", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                         "&H00000000", "&H80000000", -1, 1, 4, 0),
        }
        (sname, fs_big, fs_small, primary, secondary, outline_c, back_c,
         bold, border, outline_w, shadow) = _NEW_STYLE_PARAMS[style_id]
        fs = fs_big if big else fs_small
        align, mv = margin_for(fs)
        styles[sname] = (
            f"Style: {sname},DejaVu Sans,{fs},{primary},{secondary},"
            f"{outline_c},{back_c},{bold},0,0,0,100,100,0,0,{border},"
            f"{outline_w},{shadow},{align},40,40,{mv},1"
        )
    else:
        return False

    events: list[str] = []
    words = _clip_words(segments, start, end)
    if style_id in ("punchy", "word_pop"):
        if words:
            if style_id == "punchy":
                phrases = _group_phrases(words)
                for i, phrase in enumerate(phrases):
                    s, e = phrase[0]["start"], phrase[-1]["end"]
                    if e - s < 0.30:
                        e = s + 0.30
                    if i + 1 < len(phrases):
                        e = min(e, phrases[i + 1][0]["start"] - 0.02)
                    e = min(e, duration)
                    if e <= s:
                        continue
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(e)},"
                        f"Punchy,,0,0,0,,{_punchy_text(phrase)}"
                    )
            else:
                for i, w in enumerate(words):
                    s, e = w["start"], w["end"]
                    if e - s < 0.25:
                        e = s + 0.25
                    if i + 1 < len(words):
                        e = min(e, words[i + 1]["start"] - 0.02)
                    e = min(e, duration)
                    if e <= s:
                        continue
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(e)},"
                        f"WordPop,,0,0,0,,{_ass_escape(w['word'])}"
                    )
        if not events:
            # No word timings: fall back to segment text, chunked 4 words.
            for seg in segments:
                s, e = max(seg["start"], start), min(seg["end"], end)
                if e <= s or not seg["text"]:
                    continue
                chunks = [seg["text"].split()[i:i + 4]
                          for i in range(0, len(seg["text"].split()), 4)]
                span = (e - start) / max(1, len(chunks))
                for j, chunk in enumerate(chunks):
                    cs, ce = s - start + j * span, s - start + (j + 1) * span
                    phrase = [{"word": w, "start": cs, "end": ce} for w in chunk]
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"Punchy,,0,0,0,,{_punchy_text(phrase)}"
                    )
    elif style_id in ("karaoke", "bounce", "typewriter", "sweep",
                      "neon", "slam", "outline", "gradient"):
        # CapCut-style animated captions. Every branch produces events
        # in the SAME style the Captions Studio preview loops.
        sname = _NEW_STYLE_PARAMS[style_id][0]
        if style_id == "karaoke":
            # Full phrase visible; each word fills with the secondary
            # (yellow) colour as it is spoken — ASS \k, centiseconds.
            for phrase in _group_phrases(words):
                s, e = phrase[0]["start"], phrase[-1]["end"]
                if e <= s:
                    continue
                parts = []
                for w in phrase:
                    cs = max(10, int(round((w["end"] - w["start"]) * 100)))
                    parts.append("{\\k%d}%s" % (cs, _ass_escape(w["word"])))
                events.append(
                    f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(min(e, duration))},"
                    f"Karaoke,,0,0,0,,{' '.join(parts)}"
                )
        elif style_id == "sweep":
            # Full phrase always visible; one event per word, with the
            # active word coloured yellow — the highlight sweeps across.
            for phrase in _group_phrases(words):
                for i, w in enumerate(phrase):
                    s = w["start"]
                    e = (phrase[i + 1]["start"] if i + 1 < len(phrase)
                         else phrase[-1]["end"])
                    if e <= s:
                        continue
                    parts = []
                    for j, pw in enumerate(phrase):
                        text = _ass_escape(pw["word"])
                        if j == i:
                            parts.append("{\\1c&H00FFFF&}" + text + "{\\1c&HFFFFFF&}")
                        else:
                            parts.append(text)
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(min(e, duration))},"
                        f"Sweep,,0,0,0,,{' '.join(parts)}"
                    )
        elif style_id == "typewriter":
            # Letters appear one by one: each event holds the phrase
            # typed so far, ending when the phrase ends.
            for phrase in _group_phrases(words):
                text = " ".join(w["word"] for w in phrase)
                s, e = phrase[0]["start"], phrase[-1]["end"]
                if e <= s or not text:
                    continue
                per_char = (e - s) / max(1, len(text))
                for k in range(len(text)):
                    cs = s + k * per_char
                    ce = min(e, duration)
                    if cs >= ce:
                        break
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"Typewriter,,0,0,0,,{_ass_escape(text[:k + 1])}"
                    )
        else:
            # Word-at-a-time styles: bounce / slam / neon / outline /
            # gradient. Same timing loop as word_pop; only the entrance
            # override (and, for gradient, the per-word colour) differs.
            for i, w in enumerate(words):
                s, e = w["start"], w["end"]
                min_dur = 0.35 if style_id == "bounce" else 0.25
                if e - s < min_dur:
                    e = s + min_dur
                if i + 1 < len(words):
                    e = min(e, words[i + 1]["start"] - 0.02)
                e = min(e, duration)
                if e <= s:
                    continue
                if style_id == "bounce":
                    prefix = ("{\\fscx0\\fscy0\\t(0,180,\\fscx115\\fscy115)"
                              "\\t(180,320,\\fscx100\\fscy100)}")
                elif style_id == "slam":
                    prefix = "{\\fscx180\\fscy180\\t(0,120,\\fscx100\\fscy100)}"
                elif style_id == "gradient":
                    prefix = "{\\1c&H%s&}" % GRADIENT_PALETTE[i % len(GRADIENT_PALETTE)]
                else:  # neon, outline
                    prefix = ""
                events.append(
                    f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(e)},"
                    f"{sname},,0,0,0,,{prefix}{_ass_escape(w['word'])}"
                )
        if not events:
            # No word timings: fall back to segment text, chunked into
            # 4-word phrases, rendered in this style (plain, no entrance
            # overrides — the look still matches).
            for seg in segments:
                s, e = max(seg["start"], start), min(seg["end"], end)
                if e <= s or not seg["text"]:
                    continue
                chunks = [seg["text"].split()[i:i + 4]
                          for i in range(0, len(seg["text"].split()), 4)]
                span = (e - start) / max(1, len(chunks))
                for j, chunk in enumerate(chunks):
                    cs, ce = s - start + j * span, s - start + (j + 1) * span
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"{sname},,0,0,0,,{_ass_escape(' '.join(chunk))}"
                    )
    elif style_id == "title_card":
        # Hook title: the clip's first 8 words, uppercased, on the divider
        # for the first 4 seconds — the clip's own words, never invented.
        first_words = [w["word"] for w in words[:8]]
        if not first_words:
            for seg in segments:
                if seg["text"]:
                    first_words = seg["text"].split()[:8]
                    break
        if first_words:
            title = _ass_escape(" ".join(first_words)).upper()
            events.append(
                f"Dialogue: 0,0:00:00.00,{_fmt_ass_time(min(4.0, duration))},"
                f"Title,,0,0,0,,{title}"
            )
        for seg in segments:
            s, e = max(seg["start"], start), min(seg["end"], end)
            if e <= s or not seg["text"]:
                continue
            events.append(
                f"Dialogue: 0,{_fmt_ass_time(s - start)},{_fmt_ass_time(e - start)},"
                f"CleanSubs,,0,0,0,,{_ass_escape(seg['text'])}"
            )
    elif style_id == "clean_subs":
        for seg in segments:
            s, e = max(seg["start"], start), min(seg["end"], end)
            if e <= s or not seg["text"]:
                continue
            events.append(
                f"Dialogue: 0,{_fmt_ass_time(s - start)},{_fmt_ass_time(e - start)},"
                f"CleanSubs,,0,0,0,,{_ass_escape(seg['text'])}"
            )

    if not events:
        return False
    header = (
        "[Script Info]\n"
        "; Magician Clipper — caption style: " + style_id + "\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {tw}\n"
        f"PlayResY: {th}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        + "\n".join(styles.values()) + "\n"
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
        + "\n".join(events) + "\n"
    )
    ass_path.write_text(header, encoding="utf-8")
    return True


def _load_face_cascade():
    """Load a Haar face cascade: bundled copy first, then cv2.data.

    Returns (classifier, path) or (None, None). A classifier that fails
    to load reports empty() and is skipped, never used.
    """
    import cv2
    for path in (BUNDLED_CASCADE,
                 Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"):
        if not path.exists():
            continue
        clf = cv2.CascadeClassifier(str(path))
        if clf.empty():
            log.warning("Haar cascade at %s failed to load; trying next.", path)
            continue
        return clf, path
    return None, None


def detect_face_box(source: Path, at_seconds: list[float],
                    width: int, height: int) -> tuple[float, float, float, float] | None:
    """Detect the facecam region with OpenCV Haar cascades, if available.

    Samples frames at the given timestamps, returns the MEDIAN face box
    as fractions (centre_x, centre_y, box_w, box_h) of the frame, or None
    when OpenCV / the cascade / any face is unavailable. Never claims
    speaker-to-face identity.

    Two guards, learned the hard way on a GTA stream:
    - Size guard: only faces whose width is 3%-35% of the frame count.
      Haar happily "finds" faces in game UI (round map markers, car
      headlights) — those false positives are usually huge (a 486px
      "face" in the middle of a map) and would otherwise make the split
      crop the whole gameplay frame as if it were the streamer. A real
      streamer face is ~6% wide inside a small facecam inset and ~19%
      wide in a full-facecam stretch, so both pass the guard.
    - Stability guard: frames are probed at NATIVE resolution (the inset
      face is ~55px and Haar misses it at the 640px probe scale) and the
      detections are clustered by position — the real facecam sits at ONE
      fixed spot for the whole stream, while false positives jump around.
      Only a cluster with >= 2 members counts; a lone detection is
      treated as noise and the layout falls back.
    """
    try:
        import cv2
    except ImportError:
        log.info("OpenCV not available; split layout will use frame analysis fallback.")
        return None
    face_cascade, cascade_path = _load_face_cascade()
    if face_cascade is None:
        log.info("Haar cascade not found; split layout will use frame analysis fallback.")
        return None
    log.info("Face detection using Haar cascade: %s", cascade_path)
    detections: list[tuple[float, float, float, float]] = []
    for t in at_seconds:
        frame_path = WORK_DIR / f"face_probe_{uuid.uuid4().hex}.jpg"
        proc = run([FFMPEG, "-y", "-v", "error", "-ss", str(t), "-i", str(source),
                    "-frames:v", "1", str(frame_path)],
                   timeout=60)
        if proc.returncode != 0 or not frame_path.exists():
            continue
        try:
            img = cv2.imread(str(frame_path))
            if img is None:
                continue
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            # minSize 40 at native resolution: the inset face is ~55px;
            # a 640px probe shrinks it to ~27px and Haar misses it.
            faces = face_cascade.detectMultiScale(gray, 1.1, 5, minSize=(40, 40))
            fw, fh = img.shape[1], img.shape[0]
            for (x, y, w, h) in faces:
                w_frac, h_frac = w / fw, h / fh
                if 0.03 <= w_frac <= 0.35 and 0.03 <= h_frac <= 0.5:
                    detections.append(((x + w / 2) / fw, (y + h / 2) / fh,
                                       w_frac, h_frac))
        finally:
            frame_path.unlink(missing_ok=True)
    if not detections:
        log.info("No plausible face detected in sampled frames; split layout "
                 "will use frame analysis fallback (top 45%% of frame as facecam).")
        return None
    # Cluster by centre position (tolerance 8% of frame width): the real
    # facecam is stationary, false positives jump around. Keep clusters
    # with >= 2 members, then pick the one with the LARGEST median face:
    # a static room object can fool the position test (it never moves),
    # but the streamer's face is always the biggest plausible face in
    # the frame. A lone detection is noise; fall back when none qualify.
    clusters: list[list[tuple[float, float, float, float]]] = []
    for det in detections:
        placed = False
        for cluster in clusters:
            cx, cy = cluster[0][0], cluster[0][1]
            if abs(det[0] - cx) <= 0.08 and abs(det[1] - cy) <= 0.08:
                cluster.append(det)
                placed = True
                break
        if not placed:
            clusters.append([det])
    qualified = [c for c in clusters if len(c) >= 2]
    if not qualified:
        log.info("Face detections did not repeat at a stable position "
                 "(%d lone detection(s)); using frame analysis fallback.",
                 len(detections))
        return None

    def _median(vals: list[float]) -> float:
        vals = sorted(vals)
        return vals[len(vals) // 2]
    best = max(qualified, key=lambda c: _median([b[2] for b in c]))
    return (_median([b[0] for b in best]), _median([b[1] for b in best]),
            _median([b[2] for b in best]), _median([b[3] for b in best]))


def detect_face_center(source: Path, at_seconds: list[float],
                       width: int, height: int) -> tuple[float, float] | None:
    """Median face centre as fractions (x, y) — thin wrapper over
    detect_face_box, kept for callers that only need the centre."""
    box = detect_face_box(source, at_seconds, width, height)
    return None if box is None else (box[0], box[1])


def face_profile(source: Path, duration: float, step: float = 3.0) -> list[tuple[float, float]]:
    """Per-sample face-area fraction of the frame, for highlight scoring.

    Samples one frame every ``step`` seconds and records the largest
    detected face's area as a fraction of the frame (0.0 when no face).
    A small facecam inset reads ~0.01, a full-facecam talking stretch
    reads ~0.05+. Used by select_highlights' gameplay term; a missing
    cascade/OpenCV yields an empty profile (neutral scoring).

    One ffmpeg run extracts ALL sample frames (fps filter into a temp
    dir); the Haar cascade then runs per frame. Same output contract
    and same detection parameters as the old per-sample ffmpeg calls —
    only the extraction is batched, which is what made long sources
    slow (one ffmpeg process per sample, ~120 processes for an 8-min
    video).
    """
    try:
        import cv2
    except ImportError:
        return []
    face_cascade, _ = _load_face_cascade()
    if face_cascade is None:
        return []
    step = max(step, duration / 120.0)  # at most ~120 samples per source
    times: list[float] = []
    t = 0.0
    while t < duration:
        times.append(t)
        t += step
    if not times:
        return []
    frames_dir = WORK_DIR / f"face_prof_{uuid.uuid4().hex}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    try:
        proc = run([FFMPEG, "-y", "-v", "error", "-i", str(source),
                    "-vf", f"fps=1/{step:.6f},scale=640:-1",
                    str(frames_dir / "f_%04d.jpg")], timeout=600)
        if proc.returncode != 0:
            log.warning("face_profile: batch frame extraction failed (ffmpeg rc=%s); "
                        "scoring proceeds without a face profile.", proc.returncode)
            return []
        frames = sorted(frames_dir.glob("f_*.jpg"))
        profile: list[tuple[float, float]] = []
        for i, t in enumerate(times):
            frac = 0.0
            if i < len(frames):
                img = cv2.imread(str(frames[i]))
                if img is not None:
                    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                    # minSize 30 (see detect_face_box): the inset face is
                    # ~40px at probe scale; minSize 60 would miss it and
                    # wrongly score gameplay windows as facecam-only.
                    # Same size guard as detect_face_box: reject huge
                    # "faces" (game-UI false positives) so they cannot
                    # pollute the gameplay score.
                    faces = face_cascade.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
                    if len(faces):
                        x, y, w, h = max(faces, key=lambda b: b[2] * b[3])
                        if 0.02 <= w / img.shape[1] <= 0.35:
                            # Plain float, not np.float64: the profile is a
                            # list[tuple[float, float]] by contract.
                            frac = float((w * h) / (img.shape[1] * img.shape[0]))
            profile.append((t, frac))
        return profile
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

_DETECT_FACE = object()  # sentinel: build_layout_chains detects the face box itself


def _center_crop_filter(sw: int, sh: int, tw: int, th: int) -> str:
    """Crop-to-cover filter (no stretch) for the requested output size."""
    src_ar = sw / sh if sh else 16 / 9
    target_ar = tw / th
    if src_ar > target_ar:
        return f"crop=ih*{target_ar:.6f}:ih,scale={tw}:{th}"
    return f"crop=iw:iw/{target_ar:.6f},scale={tw}:{th}"


def _facecam_inset_crop(box, sw: int, sh: int) -> str | None:
    """Crop filter for the facecam inset around a detected face box
    (fx, fy, fw, fh as fractions of the frame) — the same estimate the
    split layout uses: ~3x the face width, 0.6x as tall. None when no box."""
    if box is None:
        return None
    fx, fy, fw, fh = box
    top_w = int(min(sw, max(fw * sw * 3.0, sw * 0.25)))
    top_h_src = int(top_w * 0.8)
    top_x = int(min(max(fx * sw - top_w / 2, 0), max(0, sw - top_w)))
    top_y = int(min(max(fy * sh - top_h_src * 0.45, 0), max(0, sh - top_h_src)))
    return f"crop={top_w}:{top_h_src}:{top_x}:{top_y}"


def build_layout_chains(source: Path, sw: int, sh: int, tw: int, th: int,
                        ratio: str, layout: str, start: float, duration: float,
                        face_box=_DETECT_FACE) -> list[str]:
    """FFmpeg filter chains turning [0:v] into [v0] for the job's layout.

    Layouts (all 9:16-only, like split — any other ratio, or an unknown
    layout, falls back to centre crop):
      * split — streamer top / gameplay bottom, true split (864 + 1056).
      * pip_facecam — gameplay full-frame, facecam inset overlaid top-right.
      * blur_fill — blurred cover background + sharp contain-fit video.
      * streamer_full — the streamer region fills the whole frame.
    ``face_box`` is a detected (fx, fy, fw, fh) box, None for "no face"
    (the face layouts fall back honestly), or the default sentinel to
    detect it here from 5 samples across the clip window. Callers and
    tests may inject a box instead of running detection.
    """
    layout = (layout or "center_crop").lower()
    box = None
    if layout in ("split", "pip_facecam", "streamer_full") and ratio == "9:16":
        box = (detect_face_box(
            source, [start + duration * f for f in (0.15, 0.3, 0.5, 0.7, 0.85)], sw, sh)
            if face_box is _DETECT_FACE else face_box)

    if layout == "split" and ratio == "9:16":
        # Streamer-top / gameplay-bottom, TRUE split (reference style):
        # top = the facecam inset, full-fit; bottom = gameplay, full-fit,
        # aspect-matched (no squeeze/stretch) and shifted away from the
        # facecam inset when it would overlap. Top panel 864, bottom 1056.
        top_h, bot_h = 864, 1056
        bot_h_src = int(sh * 0.55)
        bot_w_src = int(bot_h_src * tw / bot_h)
        bot_w_src = min(bot_w_src, sw)
        bot_h_src = int(bot_w_src * bot_h / tw)
        bot_y = sh - bot_h_src
        if box is not None:
            fx, fy, fw, fh = box
            # Facecam inset estimate: ~3x the face width, 0.6x as tall.
            inset_w = int(min(sw, max(fw * sw * 3.0, sw * 0.25)))
            inset_h = int(inset_w * 0.6)
            top_crop = _facecam_inset_crop(box, sw, sh)
            # Bottom: centred gameplay crop, shifted away from the inset
            # only when the inset actually overlaps it — and only when the
            # detected face is a SMALL inset face (fw < 0.12). A big
            # full-facecam face has no small inset to avoid; shifting on
            # its (huge, meaningless) inset estimate would push the real
            # inset INTO the bottom crop.
            bot_x = (sw - bot_w_src) // 2
            if fw < 0.12:
                inset_x0 = fx * sw - inset_w / 2
                inset_x1 = inset_x0 + inset_w
                inset_y1 = fy * sh + inset_h / 2
                if inset_y1 > bot_y and inset_x0 < bot_x + bot_w_src and inset_x1 > bot_x:
                    bot_x = sw - bot_w_src if fx < 0.5 else 0
            bot_x = int(min(max(bot_x, 0), max(0, sw - bot_w_src)))
            bot_crop = f"crop={bot_w_src}:{bot_h_src}:{bot_x}:{bot_y}"
        else:
            # Frame-analysis fallback: top 45% of the frame as facecam.
            top_crop = "crop=iw:ih*0.45:0:0"
            bot_crop = f"crop={bot_w_src}:{bot_h_src}:{(sw - bot_w_src) // 2}:{bot_y}"
        return [f"[0:v]split=2[ts][bs];"
                f"[ts]{top_crop},scale=1080:{top_h}[top];"
                f"[bs]{bot_crop},scale=1080:{bot_h}[bot];"
                f"[top][bot]vstack[v0]"]

    if layout == "pip_facecam" and ratio == "9:16":
        # Gameplay fills the whole frame; the facecam inset sits top-right
        # with a thin border. No face found -> honest centre-crop fallback.
        ow = tw // 3
        oh = int(ow * 0.8)
        ox, oy = tw - ow - 24, 24
        face_crop = _facecam_inset_crop(box, sw, sh)
        if face_crop is None:
            log.warning("pip_facecam: no face detected in this clip window; "
                        "falling back to centre crop.")
            return [f"[0:v]{_center_crop_filter(sw, sh, tw, th)}[v0]"]
        return [f"[0:v]split=2[base][face];"
                f"[base]{_center_crop_filter(sw, sh, tw, th)}[bg];"
                f"[face]{face_crop},scale={ow}:{oh},"
                f"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=4[fg];"
                f"[bg][fg]overlay={ox}:{oy}[v0]"]

    if layout == "blur_fill" and ratio == "9:16":
        # Landscape source in a vertical frame: blurred cover background
        # with the sharp video contain-fit on top. No detection needed.
        return [f"[0:v]split=2[bg][fg];"
                f"[bg]scale={tw}:{th}:force_original_aspect_ratio=increase,"
                f"crop={tw}:{th},gblur=sigma=40[bg2];"
                f"[fg]scale={tw}:{th}:force_original_aspect_ratio=decrease[fg2];"
                f"[bg2][fg2]overlay=(W-w)/2:(H-h)/2[v0]"]

    if layout == "streamer_full" and ratio == "9:16":
        # The streamer region fills the whole frame (cover-scaled, no
        # stretch). No face found -> the top 45% of the frame instead.
        top_crop = _facecam_inset_crop(box, sw, sh)
        if top_crop is None:
            log.info("streamer_full: no face detected in this clip window; "
                     "using the top 45% of the frame.")
            top_crop = "crop=iw:ih*0.45:0:0"
        return [f"[0:v]{top_crop},scale={tw}:{th}:"
                f"force_original_aspect_ratio=increase,crop={tw}:{th}[v0]"]

    # Centre crop (crop-to-cover for the requested ratio), no stretch.
    return [f"[0:v]{_center_crop_filter(sw, sh, tw, th)}[v0]"]


def render_clip(source: Path, clip: dict, settings: dict,
                segments: list[dict], out_path: Path,
                source_info: dict, job_dir: Path) -> Path:
    """Render one clip with FFmpeg. Returns out_path. Raises on failure."""
    ratio = settings.get("aspect_ratio", "9:16")
    tw, th = RATIO_TARGETS.get(ratio, (1080, 1920))
    layout = (settings.get("layout") or "center_crop").lower()
    captions_on = bool(settings.get("captions_enabled", True))
    start, end = clip["start"], clip["end"]
    duration = end - start

    # Caption style: the selected sample from Captions Studio (default
    # 'punchy'). 'classic' keeps the old SRT behaviour; every other style
    # is rendered as ASS (word-by-word, divider-centred) — the subtitles
    # filter renders .ass via libass, with no force_style (it would
    # override the style's own fonts and colours).
    style_id = (settings.get("caption_style") or "punchy").lower()
    if style_id not in CAPTION_STYLES:
        style_id = "punchy"
    captions_path: Path | None = None
    captions_is_ass = False
    if captions_on:
        if style_id == "classic":
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.srt"
            if write_clip_srt(segments, start, end, candidate):
                captions_path = candidate
        else:
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.ass"
            divider = 864 if (layout == "split" and ratio == "9:16") else None
            if write_clip_ass(segments, start, end, style_id, candidate,
                              divider, tw, th, layout):
                captions_path = candidate
                captions_is_ass = True

    sw, sh = source_info["width"], source_info["height"]

    # Build the filter graph as a list of "; "-joined filter chains.
    chains = build_layout_chains(source, sw, sh, tw, th, ratio, layout,
                                 start, duration)

    video_label = "[v0]"
    if captions_path is not None:
        if captions_is_ass:
            chains.append(
                f"{video_label}subtitles={escape_ffmpeg_path(captions_path)}[v1]"
            )
        else:
            font_size = 46 if tw >= 1080 else 34
            style = (
                "FontName=DejaVu Sans,FontSize=%d,PrimaryColour=&HFFFFFF,"
                "OutlineColour=&H000000,BorderStyle=1,Outline=2,Shadow=0,"
                "Bold=1,Alignment=2,MarginV=70" % font_size
            )
            chains.append(
                f"{video_label}subtitles={escape_ffmpeg_path(captions_path)}"
                f":force_style='{style}'[v1]"
            )
        video_label = "[v1]"
    chains.append(f"{video_label}fps=30,format=yuv420p[vout]")
    filter_complex = ";".join(chains)

    cmd = [FFMPEG, "-y", "-v", "error",
           "-ss", str(start), "-i", str(source),
           "-filter_complex", filter_complex,
           "-map", "[vout]"]
    if source_info["has_audio"]:
        cmd += ["-map", "0:a"]
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-movflags", "+faststart", "-t", str(duration), str(out_path)]
    proc = run(cmd, timeout=1800)
    if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError(
            f"FFmpeg render failed for clip {start:.1f}-{end:.1f}s: "
            f"{(proc.stderr or '').strip()[:300]}"
        )
    return out_path


def validate_clip(clip_path: Path, expected: dict, source_info: dict) -> dict:
    """Validate a rendered clip with ffprobe. Returns probe summary.

    Checks: file exists, nonzero size, duration within tolerance of the
    expected duration (and within the duration-mode bounds), expected
    resolution/aspect, video stream present, audio present when the source
    has audio. Raises with the exact reason on any failure.
    """
    info = probe_summary(clip_path)
    settings = expected["settings"]
    mode = (settings.get("duration_mode") or "exact").lower()
    target = float(settings.get("duration_seconds", 30))
    min_s = settings.get("duration_min_seconds")
    min_s = float(min_s) if min_s not in (None, "") else None
    max_s = settings.get("duration_max_seconds")
    max_s = float(max_s) if max_s not in (None, "") else None
    actual = info["duration"]
    if mode == "exact":
        if abs(actual - target) > DURATION_TOLERANCE:
            raise RuntimeError(
                f"Clip {clip_path.name} failed validation: duration "
                f"{actual:.2f}s is not within {DURATION_TOLERANCE}s of exact "
                f"target {target:.0f}s."
            )
    elif mode == "minimum":
        if actual < target - DURATION_TOLERANCE:
            raise RuntimeError(
                f"Clip {clip_path.name} failed validation: duration "
                f"{actual:.2f}s is below minimum {target:.0f}s."
            )
        if max_s and actual > max_s + DURATION_TOLERANCE:
            raise RuntimeError(
                f"Clip {clip_path.name} failed validation: duration "
                f"{actual:.2f}s exceeds maximum {max_s:.0f}s."
            )
    elif mode == "maximum":
        if actual > target + DURATION_TOLERANCE:
            raise RuntimeError(
                f"Clip {clip_path.name} failed validation: duration "
                f"{actual:.2f}s exceeds maximum {target:.0f}s."
            )
        if min_s and actual < min_s - DURATION_TOLERANCE:
            raise RuntimeError(
                f"Clip {clip_path.name} failed validation: duration "
                f"{actual:.2f}s is below minimum {min_s:.0f}s."
            )
    tw, th = RATIO_TARGETS.get(settings.get("aspect_ratio", "9:16"), (1080, 1920))
    if (info["width"], info["height"]) != (tw, th):
        raise RuntimeError(
            f"Clip {clip_path.name} failed validation: resolution "
            f"{info['width']}x{info['height']} != expected {tw}x{th}."
        )
    if source_info["has_audio"] and not info["has_audio"]:
        raise RuntimeError(
            f"Clip {clip_path.name} failed validation: source has audio but "
            "the clip has no audio stream."
        )
    if info["size_bytes"] <= 0:
        raise RuntimeError(f"Clip {clip_path.name} failed validation: 0-byte file.")
    return info


def extract_thumbnail(clip_path: Path, thumb_path: Path, at_seconds: float = 1.0) -> Path | None:
    """Extract one JPEG frame from a rendered clip for the Library /
    Projects thumbnails. Returns the thumbnail path, or None when
    ffmpeg is unavailable or the frame cannot be read — a missing
    thumbnail never fails the clip itself; the UI falls back to an
    icon tile."""
    try:
        proc = run([FFMPEG, "-y", "-v", "error",
                    "-ss", str(at_seconds), "-i", str(clip_path),
                    "-vframes", "1", "-q:v", "4", str(thumb_path)],
                   timeout=120)
        if proc.returncode == 0 and thumb_path.exists() and thumb_path.stat().st_size > 0:
            return thumb_path
    except Exception as exc:  # noqa: BLE001 — thumbnail is best-effort
        log.warning("Thumbnail extraction failed for %s: %s", clip_path.name, exc)
    return None


# ---------------------------------------------------------------------------
# Per-job processing
# ---------------------------------------------------------------------------

class JobCancelled(Exception):
    """The user cancelled the job. process_job exits cleanly (marks the
    job Cancelled via the API) instead of marking it Failed."""


def _throw_if_cancelled(api: "JobApi", job_id) -> None:
    """Raise JobCancelled when the job's state is 'cancelling'.

    Best-effort: if the job cannot be read (API down), return silently
    and let the job continue — a failed read must not kill a good job.
    """
    try:
        job = api.get_job(job_id)
    except Exception:
        return
    if (job.get("state") or "") == "cancelling":
        raise JobCancelled(f"Job {job_id} was cancelled by the user.")


def _ready_note(clips: list[dict], requested: int, failed: list[str]) -> str | None:
    """The note the job page shows when a job finishes Ready but the
    result is not the full request: fewer clips than asked for (speech
    was scarce, visual moments may have filled some slots), or some
    clips failed to render and were skipped. Returns None when the job
    delivered exactly what was asked with no failures.
    """
    notes: list[str] = []
    if len(clips) < requested:
        visual = sum(1 for c in clips if "visual_moment" in (c.get("signals") or []))
        if visual:
            notes.append(
                f"Only {len(clips)} of {requested} requested clips could be "
                f"selected from speech; {visual} visual moment(s) (loudest "
                f"audio peaks) filled the rest because the source has very "
                f"little speech.")
        else:
            notes.append(
                f"Only {len(clips)} of {requested} requested clips could be "
                f"selected from the source.")
    if failed:
        notes.append(
            f"{len(failed)} clip(s) failed to render and were skipped: "
            + "; ".join(failed[:3]))
    return " ".join(notes) if notes else None


def process_rerender(api: JobApi, rerender: dict) -> None:
    """Re-render one clip with a different caption style.

    The clip's SAME [start, end] window is rendered again from the job's
    source, with the re-render's caption style, and the new file replaces
    the old one in place (POST /muse/clips/{clip}/file). The transcript
    is re-run — the original job's segments are not stored anywhere, and
    the new style needs word timings to burn in. A failure marks the
    re-render failed; the original clip is never touched on failure.
    """
    rerender_id = rerender["id"]
    clip_id = rerender["clip_id"]
    job_id = rerender["job_id"]
    style = rerender["caption_style"]
    log.info("Processing re-render %s: clip %s of job %s with style '%s'.",
             rerender_id, clip_id, job_id, style)
    try:
        api.set_rerender_status(rerender_id, "processing")
        job = api.get_job(job_id)
        settings = dict(job.get("settings") or {})
        settings["caption_style"] = style
        job_dir = WORK_DIR / f"rerender-{rerender_id}"
        job_dir.mkdir(parents=True, exist_ok=True)
        source, source_note = acquire_source(api, job, job_dir)
        log.info("Source acquired for re-render %s: %s", rerender_id, source_note)
        source_info = probe_summary(source)
        clip = {
            "start": float(rerender["start_seconds"]),
            "end": float(rerender["end_seconds"]),
            "duration": float(rerender["duration_seconds"]),
            "words": 0, "text": "",
        }
        segments: list[dict] = []
        if source_info["has_audio"]:
            wav_path = job_dir / "audio_16k.wav"
            extract_audio(source, wav_path)
            lang = LANGUAGE_MAP.get(
                (settings.get("captions_language") or "auto").lower(), None)
            segments = transcribe(wav_path, lang)
        out_path = job_dir / "clip.mp4"
        render_clip(source, clip, settings, segments, out_path,
                    source_info, job_dir)
        info = validate_clip(out_path, {"settings": settings}, source_info)
        thumb = extract_thumbnail(out_path, job_dir / "thumb.jpg")
        api.upload_replacement_clip(clip_id, out_path, rerender_id,
                                    thumbnail=thumb,
                                    duration_seconds=info["duration"])
        log.info("Re-render %s ready: clip %s now uses style '%s' (%.2fs).",
                 rerender_id, clip_id, style, info["duration"])
    except Exception as exc:
        reason = str(exc)[:500]
        log.error("Re-render %s failed: %s", rerender_id, reason)
        try:
            api.set_rerender_status(rerender_id, "failed", error_message=reason)
        except Exception as api_exc:  # noqa: BLE001 - report both failures
            log.error("Could not mark re-render %s Failed via API: %s", rerender_id, api_exc)
        raise


def process_job(api: JobApi, job: dict) -> None:
    job_id = job["id"]
    settings = job.get("settings") or {}
    job_dir = WORK_DIR / f"job-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    log.info("Processing job %s (platform=%s ratio=%s clips=%s mode=%s)",
             job_id, settings.get("platform"), settings.get("aspect_ratio"),
             settings.get("clip_count"), settings.get("duration_mode"))
    # Notes travel with the job (campaign brief, extra instructions).
    # Log them so the worker record shows the brief it clipped to;
    # Muse reads the full text from the job detail when processing.
    _notes = (settings.get("notes") or "").strip()
    if _notes:
        log.info("Job %s notes: %s", job_id, _notes[:300])
    try:
        # A job cancelled while queued (or between list and claim) must
        # not be rendered at all.
        _throw_if_cancelled(api, job_id)
        # Stale reclaim: the previous worker died mid-job (VM restart,
        # crash) and this listing picked the job back up. Clear any
        # partial clips from the dead run so the fresh run cannot
        # duplicate them, then re-run from the start.
        if job.get("stale"):
            log.warning(
                "Job %s was left mid-processing (state=%s, last update %s); "
                "reclaiming and re-running from the start.",
                job_id, job.get("state"), job.get("updated_at"),
            )
            _cleared = api.delete_clips(job_id)
            if _cleared:
                log.info("Cleared %s partial clip(s) from stale job %s.", _cleared, job_id)
        api.set_status(job_id, "Processing", stage="acquiring_source", progress=5)
        source, source_note = acquire_source(api, job, job_dir)
        log.info("Source acquired for job %s: %s", job_id, source_note)
        source_info = probe_summary(source)
        log.info("Source probe: %.1fs %dx%d %s audio=%s",
                 source_info["duration"], source_info["width"],
                 source_info["height"], source_info["video_codec"],
                 source_info["has_audio"])

        api.set_status(job_id, "Processing", stage="transcribing", progress=20)
        wav_path = job_dir / "audio_16k.wav"
        if source_info["has_audio"]:
            extract_audio(source, wav_path)
            # The extracted WAV must span the video timeline (gap-filled
            # with silence); if it is much shorter, transcript timestamps
            # would no longer be video times. Log loudly — do not fail:
            # audio that legitimately ends before the video ends is fine.
            wav_seconds = (wav_path.stat().st_size - 44) / 32000.0
            if abs(wav_seconds - source_info["duration"]) > 2.0:
                log.warning(
                    "Extracted audio is %.1fs but the video is %.1fs; "
                    "transcript timestamps may not be video times.",
                    wav_seconds, source_info["duration"])
            lang = LANGUAGE_MAP.get(
                (settings.get("captions_language") or "auto").lower(), None)
            segments = transcribe(wav_path, lang)
            energy = wav_rms_profile(wav_path)
        else:
            segments, energy = [], []
            log.info("Source has no audio track; skipping transcription.")

        api.set_status(job_id, "Processing", stage="selecting_clips", progress=45)
        _throw_if_cancelled(api, job_id)
        face_prof = face_profile(source, source_info["duration"])
        clips = select_highlights(segments, source_info["duration"], settings, energy, face_prof)
        requested = int(settings.get("clip_count", 3))
        if len(clips) < requested:
            log.warning("Job %s: only %d of %d requested clips could be "
                        "selected from the source; proceeding with %d.",
                        job_id, len(clips), requested, len(clips))
        log.info("Selected %d clip window(s) for job %s.", len(clips), job_id)
        for clip in clips:
            if "low_audio_coverage" in (clip.get("signals") or []):
                log.warning(
                    "Job %s: selected clip %.1f-%.1fs has only %.0f%% "
                    "transcribed-speech coverage (mostly silent) — used "
                    "only because no better-covered window exists.",
                    job_id, clip["start"], clip["end"],
                    clip.get("coverage", 0.0) * 100)

        api.set_status(job_id, "Processing", stage="rendering", progress=60)
        rendered: list[tuple[Path, dict, dict, Path | None]] = []
        failed: list[str] = []
        for i, clip in enumerate(clips, 1):
            _throw_if_cancelled(api, job_id)
            out_path = job_dir / f"clip_{i:02d}.mp4"
            try:
                render_clip(source, clip, settings, segments, out_path,
                            source_info, job_dir)
                info = validate_clip(out_path, {"settings": settings}, source_info)
                thumb = extract_thumbnail(out_path, job_dir / f"thumb_{i:02d}.jpg")
            except Exception as clip_exc:  # noqa: BLE001 - one bad clip must not kill the job
                # Per-clip failure isolation: log the failure, drop the
                # partial file, and keep rendering the rest. Only when
                # EVERY clip fails does the job fail (below).
                reason = str(clip_exc)[:300]
                log.error("Job %s: clip %d (%.1f-%.1fs) failed: %s; skipping it.",
                          job_id, i, clip["start"], clip["end"], reason)
                failed.append(f"Clip {i} ({clip['start']:.1f}–{clip['end']:.1f}s): {reason}")
                if out_path.exists():
                    out_path.unlink(missing_ok=True)
                continue
            log.info("Clip %d/%d validated: %.2fs %dx%d %d bytes.",
                     i, len(clips), info["duration"], info["width"],
                     info["height"], info["size_bytes"])
            rendered.append((out_path, clip, info, thumb))
            api.set_status(job_id, "Processing", stage="rendering",
                           progress=60 + int(25 * i / len(clips)))
        if clips and not rendered:
            raise RuntimeError(
                "Every clip failed to render: " + "; ".join(failed[:3]))

        api.set_status(job_id, "Processing", stage="uploading_clips", progress=90)
        for i, (out_path, clip, info, thumb) in enumerate(rendered, 1):
            api.upload_clip(job_id, out_path, {
                "title": f"Clip {i}",
                "start_seconds": clip["start"],
                "end_seconds": clip["end"],
                "duration_seconds": info["duration"],
                "score": clip.get("score", 0),
                "reason": clip.get("reason", ""),
                "transcript_excerpt": clip.get("text", ""),
                "caption_style": (settings.get("caption_style") or "punchy"),
            }, thumbnail=thumb)
            log.info("Uploaded clip %d/%d for job %s.", i, len(rendered), job_id)

        api.set_status(job_id, "Ready", stage="ready", progress=100,
                       note=_ready_note(clips, requested, failed))
        log.info("Job %s is Ready (%d clip(s)).", job_id, len(rendered))
    except JobCancelled:
        log.info("Job %s cancelled by the user; stopping without rendering further clips.", job_id)
        try:
            api.set_status(job_id, "Cancelled", stage="cancelled", progress=None)
        except Exception as api_exc:  # noqa: BLE001 - log, do not fail
            log.error("Could not mark job %s Cancelled via API: %s", job_id, api_exc)
        return
    except Exception as exc:
        reason = str(exc)[:500]
        log.error("Job %s failed: %s", job_id, reason)
        try:
            api.set_status(job_id, "Failed", error_reason=reason,
                           stage="failed", progress=None)
        except Exception as api_exc:  # noqa: BLE001 - report both failures
            log.error("Could not mark job %s Failed via API: %s", job_id, api_exc)
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Magician Clipper Muse job worker")
    parser.add_argument("--once", action="store_true",
                        help="Process one queued job, then exit.")
    parser.add_argument("--poll", action="store_true",
                        help="Loop: process queued jobs, sleep, repeat.")
    parser.add_argument("--interval", type=int, default=300,
                        help="Poll interval in seconds (default 300).")
    parser.add_argument("--job-id", default=None,
                        help="Process one specific job ID (must be Queued).")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.once and not args.poll and not args.job_id:
        parser.error("specify --once, --poll, or --job-id")

    try:
        key = load_api_key()
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2
    api = JobApi(key)

    def run_once() -> bool:
        """Process a single job, or a single queued re-render when no
        job is queued. Jobs first: a re-render never jumps the queue
        ahead of a waiting job. Returns True if anything was processed."""
        if args.job_id:
            job = api.get_job(args.job_id)
            if (job.get("status") or "").lower() not in ("queued",):
                log.error("Job %s is not Queued (status=%s); refusing.",
                          args.job_id, job.get("status"))
                return False
        else:
            queued = api.list_queued()
            if not queued:
                rerenders = api.list_rerenders()
                if not rerenders:
                    log.info("No queued jobs.")
                    return False
                rerender = rerenders[0]
                try:
                    process_rerender(api, rerender)
                except Exception:
                    return True  # re-render was processed (and marked Failed)
                return True
            job = queued[0]
        job_id = job["id"]
        try:
            api.set_status(job_id, "Processing", stage="claimed", progress=0)
        except Exception as exc:
            log.error("Could not claim job %s: %s", job_id, exc)
            return False
        try:
            # The re-fetch below would lose the stale flag: the claim
            # above saved the job, refreshing updated_at, so a job the
            # listing flagged stale no longer looks stale. Carry the
            # flag through from the listed/fetched job instead.
            fresh = api.get_job(job_id)
            fresh["stale"] = job.get("stale", False)
            process_job(api, fresh)
        except Exception:
            return True  # job was processed (and marked Failed); count it
        return True

    if args.job_id or args.once:
        run_once()
        return 0

    log.info("Polling %s every %ds (Ctrl-C to stop).", API_BASE, args.interval)
    while True:
        try:
            run_once()
        except Exception as exc:  # noqa: BLE001 - poll loop must survive
            log.error("Poll iteration failed: %s", exc)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
