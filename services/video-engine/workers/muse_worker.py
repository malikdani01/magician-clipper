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


def _binary_version(binary: str) -> str | None:
    """First line of `<binary> -version`, or None when it cannot be run."""
    try:
        out = subprocess.run(
            [binary, "-version"], capture_output=True, text=True, timeout=5
        )
        lines = (out.stdout or "").splitlines()
        return lines[0] if lines else None
    except Exception:
        return None


_engine_versions: dict | None = None


def engine_versions() -> dict:
    """ffmpeg/ffprobe version strings for this worker, cached per process.

    The hosted site has no engine URL to probe, so the worker reports
    its own versions with every status update and the backend serves
    them to the dashboards.
    """
    global _engine_versions
    if _engine_versions is None:
        _engine_versions = {
            "ffmpeg": _binary_version(FFMPEG),
            "ffprobe": _binary_version(FFPROBE),
        }
    return _engine_versions

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

# Batch 3 multi-ratio export: the ratios a job renders in. The UI
# offers 9:16 (always on) + 1:1 + 16:9; the job's own aspect_ratio is
# always rendered even if a stale client omitted it from the list.
#: Hard cap on TOTAL clip rows a job may produce (all ratios together).
MAX_TOTAL_CLIPS = 50


def export_ratios(settings: dict) -> list[str]:
    """The ratios this job renders, in render order.

    The job's aspect_ratio comes first, then the requested export
    ratios in the order given; 9:16 is always included (it is the
    default and the UI keeps it checked). Unknown values are dropped,
    so a bad client cannot ask for a ratio with no target.
    """
    primary = (settings.get("aspect_ratio") or "9:16")
    wanted = settings.get("export_ratios") or [primary]
    if isinstance(wanted, str):
        wanted = [wanted]
    ratios: list[str] = []
    for r in [primary, "9:16", *wanted]:
        if isinstance(r, str) and r in RATIO_TARGETS and r not in ratios:
            ratios.append(r)
    return ratios or ["9:16"]


def windows_per_ratio(requested: int, ratios: list[str]) -> int:
    """Windows to select when each window renders once per ratio: the
    50-clip total cap binds (e.g. 30 requested x 3 ratios -> 16
    windows, 48 clips). A single ratio is never capped by this."""
    if len(ratios) <= 1:
        return requested
    return min(requested, MAX_TOTAL_CLIPS // len(ratios))

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
W_DENSITY = 0.20
W_COVERAGE = 0.20
W_COMPLETENESS = 0.20
W_SILENCE = 0.05
W_ENERGY = 0.05
W_GAMEPLAY = 0.15
W_STABILITY = 0.10
# Batch 2 (2026-11-25): the hook term — how strong a window OPENS
# (first ~3s: speech density + audio energy there). It is a bonus, not
# a rule: 0.05 of the score, taken from density (0.25 -> 0.20) so the
# weights still sum to 1.00. A clip that opens on a dense, loud line
# hooks the viewer; one that opens on a pause does not — but a
# genuinely better later window still wins.
W_HOOK = 0.05

# Batch 2 headline styles (per-job setting `headline_style`, default
# "bold_bar" = the look every job used before Batch 2).
HEADLINE_STYLES = ("bold_bar", "lower_third", "big_centre")

# Batch 2 caption positions (per-job setting `caption_position`,
# default "bottom" = where captions always sat before Batch 2).
CAPTION_POSITIONS = ("bottom", "top", "middle")
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

    def download_brand_asset(self, download_url: str, dest: Path) -> Path:
        """Download one brand asset (intro/outro) over the Job API.

        `download_url` is the absolute URL from the job's `brand_assets`
        payload; it is fetched with the same X-Muse-Api-Key auth as every
        other JobApi call (the _request helper cannot be used here
        because it prefixes API_BASE, and this URL is already absolute).
        Streams to disk like download_source. Raises on a non-200
        response; the caller treats any failure as 'asset absent',
        never as a job failure.
        """
        url = download_url
        if not url.startswith(("http://", "https://")):
            url = LARAVEL_BASE + (url if url.startswith("/") else "/" + url)
        resp = self._requests.request(
            "GET", url, headers=api_headers(self.key),
            stream=True, timeout=300,
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Download brand asset failed: HTTP {resp.status_code}: "
                f"{resp.text[:300]}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
        return dest

    def set_status(self, job_id, status: str, error_reason: str | None = None,
                   stage: str | None = None, progress: int | None = None,
                   note: str | None = None,
                   intro_applied: bool | None = None,
                   outro_applied: bool | None = None,
                   title_suggestion: str | None = None,
                   hashtags: list[str] | None = None) -> dict:
        payload: dict = {"status": status}
        # The worker's own ffmpeg/ffprobe versions ride along with
        # every status update — the hosted site has no engine URL to
        # probe, so this is how the dashboards learn the versions.
        payload["engine_versions"] = engine_versions()
        if error_reason is not None:
            payload["error_reason"] = error_reason[:500]
        if stage is not None:
            payload["stage"] = stage
        if progress is not None:
            payload["progress"] = progress
        if note is not None:
            payload["note"] = note[:1000]
        # Brand flags ride only when the caller passes them (a job that
        # used brand assets): every other status update is byte-identical
        # to before, so old backends see no change at all.
        if intro_applied is not None:
            payload["intro_applied"] = intro_applied
        if outro_applied is not None:
            payload["outro_applied"] = outro_applied
        # Batch 4: title + hashtag suggestions, derived from the job's
        # own transcript. Sent only when the worker derived them (a
        # silent job sends neither, and the job page says so honestly).
        if title_suggestion is not None:
            payload["title_suggestion"] = title_suggestion[:120]
        if hashtags:
            payload["hashtags"] = list(hashtags)[:10]
        resp = self._request("PATCH", f"/muse/jobs/{job_id}/status", json=payload)
        if resp.status_code not in (200, 202):
            raise RuntimeError(
                f"Set job {job_id} status to {status} failed: "
                f"HTTP {resp.status_code}: {resp.text[:300]}"
            )
        data = resp.json()
        return data.get("job", data)

    def upload_clip(self, job_id, clip_path: Path, fields: dict, thumbnail: Path | None = None,
                    candidates: list[Path] | None = None) -> dict:
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
            # Batch 4: thumbnail-picker candidates (up to 3 frames).
            # Each rides as its own file field; a missing file is
            # skipped, never fatal — the backend stores what it got.
            for n, cand in enumerate(candidates or [], 1):
                if n > 3:
                    break
                if cand is not None and Path(cand).exists():
                    fh_c = open(cand, "rb")
                    handles.append(fh_c)
                    files[f"candidate_{n}"] = (Path(cand).name, fh_c, "image/jpeg")
            # Multipart form fields are strings. The wire contract for
            # `score_breakdown` is a JSON-encoded object (string keys,
            # integer values 0-100) — str() on a dict would send a
            # Python repr, which the backend cannot parse. A window
            # with no breakdown at all sends no field (never "{}").
            data: dict = {}
            for k, v in fields.items():
                if k == "score_breakdown":
                    if not v:
                        continue
                    data[k] = v if isinstance(v, str) else json.dumps(v)
                else:
                    data[k] = str(v)
            resp = self._request(
                "POST", f"/muse/jobs/{job_id}/clips",
                files=files, data=data,
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
                                duration_seconds: float | None = None,
                                candidates: list[Path] | None = None) -> dict:
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
            # Batch 4: the re-rendered clip gets fresh thumbnail-picker
            # candidates (its frames changed with the new style).
            for n, cand in enumerate(candidates or [], 1):
                if n > 3:
                    break
                if cand is not None and Path(cand).exists():
                    fh_c = open(cand, "rb")
                    handles.append(fh_c)
                    files[f"candidate_{n}"] = (Path(cand).name, fh_c, "image/jpeg")
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


# ---------------------------------------------------------------------------
# Captions auto-translate (Batch 3, 2026-11-25)
# ---------------------------------------------------------------------------
# Free MyMemory API, no key: GET
# https://api.mymemory.translated.net/get?q=<text>&langpair=<src>|<dst>
# Short timeout (5s), at most one retry per segment, in-memory cache
# per job. On ANY failure the segment keeps its original text — the
# job never fails for translation, and the note says so honestly.
# Two things the free tier forces us to live with: the anonymous quota
# (5,000 chars/day, shared across this server's egress IP) is often
# exhausted, so the fallback is the COMMON path, not an edge case; and
# a 200 can still carry a bad translation-memory match, which no code
# can detect — the note never claims a translation is good, only that
# it was attempted. Translated words have no real timings, so they are
# spread evenly across the segment span — the same behaviour the
# caption builders already use when a segment has no word timings —
# which keeps density/hook scoring and every caption style working.
# Urdu/Hindi glyphs render through fontconfig fallback (this machine
# has Noto Nastaliq Urdu / Noto Naskh Arabic / Noto Sans Devanagari
# installed); a machine without those fonts would show boxes, which
# no setting here can fix.
# ---------------------------------------------------------------------------

#: Target language code -> display name (the only values the API accepts).
TRANSLATION_TARGETS = {"ur": "Urdu", "hi": "Hindi", "en": "English"}
#: Job captions_language -> MyMemory source code. "auto" lets MyMemory
#: detect the source language itself.
TRANSLATION_SOURCES = {"english": "en", "hindi": "hi",
                       "roman_urdu": "ur", "auto": "autodetect"}
MYMEMORY_URL = "https://api.mymemory.translated.net/get"
MYMEMORY_TIMEOUT = 5.0
#: MyMemory's anonymous per-request limit is 500 chars; stay under it.
MYMEMORY_MAX_CHARS = 450


def _mymemory_translate(text: str, source: str, target: str) -> str | None:
    """One MyMemory call. Returns the translated text, or None on any
    failure (network, timeout, non-200, rate limit / quota, empty or
    unusable response). NEVER returns the API's quota-warning text as
    a translation — responseStatus must be 200 first."""
    import urllib.error
    import urllib.parse
    query = urllib.parse.urlencode(
        {"q": text, "langpair": f"{source}|{target}"})
    req = urllib.request.Request(f"{MYMEMORY_URL}?{query}",
                                 headers={"User-Agent": "MagicianClipper/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=MYMEMORY_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001 - any transport failure is a fallback
        log.warning("MyMemory request failed (%s); segment keeps its original text.", exc)
        return None
    if not isinstance(payload, dict) or payload.get("responseStatus") != 200:
        log.warning("MyMemory refused the translation (status=%s); segment "
                    "keeps its original text.",
                    payload.get("responseStatus") if isinstance(payload, dict) else "?")
        return None
    data = payload.get("responseData") or {}
    translated = (data.get("translatedText") or "").strip()
    # Batch 5 (2026-11-25): MyMemory sometimes returns TMX markup
    # inside translatedText (e.g. `<bpt i="0" x="0"/>` — Job #16's
    # transcript showed it verbatim). Strip every <...> tag and
    # collapse the leftover double spaces, so captions and the
    # transcript excerpt never show raw markup. If nothing readable
    # remains, treat it as a failed translation (caller falls back
    # to the original text).
    translated = re.sub(r"<[^>]+>", "", translated)
    translated = re.sub(r"\s+", " ", translated).strip()
    if not translated:
        return None
    return translated


def _split_for_translation(text: str,
                           max_chars: int = MYMEMORY_MAX_CHARS) -> list[str]:
    """Split a long segment into <=max_chars chunks at word boundaries
    (MyMemory's anonymous limit is 500 chars per request)."""
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in text.split():
        add = len(word) + (1 if current else 0)
        if current and current_len + add > max_chars:
            chunks.append(" ".join(current))
            current, current_len = [], 0
        current.append(word)
        current_len += len(word) + (1 if len(current) > 1 else 0)
    if current:
        chunks.append(" ".join(current))
    return chunks


def _even_word_timings(text: str, start: float, end: float) -> list[dict]:
    """Word timings spread evenly across [start, end] — the same
    behaviour the caption builders use for segments without timings."""
    words = text.split()
    if not words:
        return []
    span = max(0.0, end - start)
    step = span / len(words)
    return [{"start": start + i * step, "end": start + (i + 1) * step,
             "word": w} for i, w in enumerate(words)]


def translate_segments(segments: list[dict], target: str,
                       source_language: str = "auto",
                       cache: dict | None = None) -> tuple[list[dict], dict]:
    """Translate every segment's text into ``target`` (MyMemory).

    Returns (segments, info) where info is {"status", "translated",
    "failed", "target"}: status is "ok" (every segment translated),
    "partial" (some fell back to the original text), "unavailable"
    (none translated — every call failed), "same" (target is already
    the source language, no call made), or "none" (target "none" or
    unknown). ``cache`` maps source text -> translated text and is
    shared across the job so a repeated line is translated once.
    The returned segments are NEW dicts; the input is untouched.
    """
    if target not in TRANSLATION_TARGETS:
        return segments, {"status": "none", "translated": 0, "failed": 0,
                          "target": target}
    source = TRANSLATION_SOURCES.get(
        (source_language or "auto").lower(), "autodetect")
    if source == target:
        return segments, {"status": "same", "translated": 0, "failed": 0,
                          "target": target}
    cache = cache if cache is not None else {}
    out: list[dict] = []
    translated_n = 0
    failed_n = 0
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            out.append(dict(seg))
            continue
        if text in cache:
            translated = cache[text]
        else:
            translated = None
            for attempt in range(2):  # one attempt + at most one retry
                parts = []
                ok = True
                for chunk in _split_for_translation(text):
                    got = _mymemory_translate(chunk, source, target)
                    if got is None:
                        ok = False
                        break
                    parts.append(got)
                if ok:
                    translated = " ".join(parts).strip()
                    break
                if attempt == 0:
                    log.info("Retrying MyMemory translation for one segment.")
            if translated:
                cache[text] = translated
        if not translated:
            failed_n += 1
            out.append(dict(seg))
            continue
        translated_n += 1
        out.append({
            "start": seg["start"], "end": seg["end"],
            "text": translated,
            "words": _even_word_timings(translated, seg["start"], seg["end"]),
        })
    if translated_n and failed_n:
        status = "partial"
    elif translated_n:
        status = "ok"
    elif failed_n:
        status = "unavailable"
    else:
        status = "ok"
    return out, {"status": status, "translated": translated_n,
                 "failed": failed_n, "target": target}


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


# Display labels for the per-signal values in a window's score_breakdown
# (wire format: multipart `score_breakdown` field, JSON-encoded object,
# string keys, integer values 0-100 — the backend renders these verbatim).
_SCORE_BREAKDOWN_LABELS = {
    "density": "Speech",
    "coverage": "Coverage",
    "completeness": "Completeness",
    "silence": "Silence",
    "energy": "Energy",
    "gameplay": "Gameplay",
    "stability": "Stability",
    "hook": "Hook",
}


def _score_breakdown(values: dict[str, float]) -> dict[str, int]:
    """Map a window's computed signals to its display breakdown.

    ``values`` maps the internal signal name to its NORMALISED 0-1
    value, exactly as the selector computed it (density normalised
    against the densest candidate, completeness 1.0/0.4, silence
    clamped to 1.0, energy clamped to 1.0, gameplay/stability already
    0-1). Only signals actually computed for the window are passed in:
    a speech window passes all seven, a visual-moment / any-part
    window passes only energy/gameplay/stability, and the uniform
    no-speech fallback passes only energy — a signal never computed is
    never invented. Values are rounded to integers 0-100.
    """
    breakdown: dict[str, int] = {}
    for key, value in values.items():
        label = _SCORE_BREAKDOWN_LABELS.get(key)
        if label is None:
            continue
        breakdown[label] = max(0, min(100, int(round(value * 100))))
    return breakdown


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
            # Only the signals this window actually computed: no speech
            # terms exist for a wordless window, so none are invented.
            "score_breakdown": _score_breakdown({
                "energy": min(1.0, energy),
                "gameplay": gameplay,
                "stability": stability,
            }),
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


def _any_part_windows(source_duration: float,
                      span: float, mode: str,
                      min_s: float | None, max_s: float | None,
                      count: int,
                      occupied: list[tuple[float, float]],
                      energy_in, gameplay_in, stability_in) -> list[dict]:
    """Evenly-spaced 'any part' windows (selection_mode=fill_any).

    Used only when the user asked for the full count no matter what:
    after speech + visual-moment selection, any remaining slots are
    filled with windows spread evenly across the WHOLE source. A window
    is exactly ``span`` long (the mode's bound, like visual moments),
    must not overlap any ``occupied`` window or another any-part
    window, and is labelled ``any_part`` with a reason ending "Any part
    — not a highlight." — it is any footage, not a highlight, and the
    label says so. Scored like a visual moment (energy/gameplay/
    stability) so the clip still carries a real viral estimate.
    Returns at most ``count`` windows, sorted by start time. When the
    source is physically too short for more full windows, the shortfall
    is returned as-is (fewer clips, honestly) — time is never invented.
    """
    if count <= 0:
        return []
    if mode in ("exact", "minimum") and span > source_duration + DURATION_TOLERANCE:
        return []
    if mode == "maximum" and min_s and min_s > source_duration + DURATION_TOLERANCE:
        return []
    # An any-part window is exactly ``span`` long (the mode's bound),
    # except in maximum mode where the floor is min_s and span is the ceiling.
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
    # Ideal even grid across the whole source; each ideal start is
    # nudged (1s steps, outward) to the nearest free start so a
    # chosen window never overlaps — and a slot with no free stretch
    # is skipped, not padded with a short window.
    if count == 1:
        ideals = [(source_duration - length) / 2.0]
    else:
        ideals = [i * (source_duration - length) / (count - 1)
                  for i in range(count)]
    for ideal in ideals:
        if len(picked) >= count:
            break
        start = None
        for step in range(0, int(source_duration) + 2):
            cands = [ideal] if step == 0 else [ideal + step, ideal - step]
            for cand in cands:
                c = round(float(cand), 3)
                if c < 0 or c + length > source_duration + 1e-6:
                    continue
                if overlaps(c, c + length, taken):
                    continue
                start = c
                break
            if start is not None:
                break
        if start is None:
            continue
        end = start + length
        energy = energy_in(start, end)
        gameplay = gameplay_in(start, end)
        stability = stability_in(start, end)
        score = round(
            W_VISUAL_ENERGY * min(1.0, energy)
            + W_VISUAL_GAMEPLAY * gameplay
            + W_VISUAL_STABILITY * stability, 4)
        picked.append({
            "start": round(start, 3), "end": round(end, 3),
            "duration": round(end - start, 3), "words": 0,
            "density": 0.0, "complete": False, "coverage": 0.0,
            "silence": 0.0, "energy": energy,
            "gameplay": gameplay, "stability": stability,
            "score": score, "signals": ["any_part"], "text": "",
            # Same as a visual moment: only energy/gameplay/stability
            # were computed for this window.
            "score_breakdown": _score_breakdown({
                "energy": min(1.0, energy),
                "gameplay": gameplay,
                "stability": stability,
            }),
            "reason": (
                f"Any part of the video (viral {round(score * 100)}/100): "
                f"the job asked for the full clip count, so this window "
                f"fills a slot from anywhere in the source — it was not "
                f"picked for speech or for a loud moment. "
                f"Any part — not a highlight."),
        })
        taken.append((start, end))
    picked.sort(key=lambda c: c["start"])
    return picked


def select_highlights(segments: list[dict], source_duration: float,
                      settings: dict, energy_profile: list[float],
                      face_profile: list[tuple[float, float]] | None = None) -> list[dict]:
    """Select exactly clip_count non-overlapping windows.

    Selection mode (settings.selection_mode):
    - 'interesting_only' (default): only speech + visual-moment
      windows above the quality bar; fewer clips than requested when
      the source has too little good content, with the reason recorded
      on each clip and in the job note.
    - 'fill_any': after speech + visual selection, any remaining slots
      are filled with evenly-spaced windows from anywhere in the
      source (labelled 'any_part'), so the job delivers the full count
      whenever the source is physically long enough.
    Scoring (documented weights): speech density 0.20, audio coverage
    0.20, sentence completeness 0.20, silence boundaries 0.05, audio
    energy 0.05 (supporting only), gameplay presence 0.15 (real gameplay
    on screen beats a full-facecam talking stretch), scene stability
    0.10 (a window staying in one scene beats one spanning a
    facecam->gameplay switch, which one static split crop cannot serve),
    hook 0.05 (how strong the window OPENS — speech density + audio
    energy in its first ~3s; a bonus, not a rule).
    Raises if zero valid windows exist; returns fewer than requested
    only when the source genuinely has too little usable content, with
    the reason recorded on each clip. ``face_profile`` is a list of
    (time, face_area_fraction) samples; when absent the gameplay and
    stability terms are neutral (0.5).
    """
    count = int(settings.get("clip_count", 3))
    mode = (settings.get("duration_mode") or "exact").lower()
    selection_mode = (settings.get("selection_mode") or "interesting_only").lower()
    fill_any = selection_mode == "fill_any"
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
                # Exact mode promises exactly `target` seconds: land on
                # target, never above it. A natural span past target is
                # trimmed (mid-thought); a short one is extended into
                # nearby context when room exists. The old code only
                # trimmed past target + 0.6s, so a window at 20.59s
                # passed selection — and the render's container duration
                # runs a hair past -t, so it then failed validation at
                # the 0.6s boundary (Job #8 lost a 20.60s clip that way).
                # A window that cannot reach target for lack of room is
                # still accepted down to target - 0.6s, as before.
                if span > target:
                    window_end = start + target
                    span = target
                    complete = False  # trimmed mid-thought
                elif span < target:
                    room_after = source_duration - window_end
                    need = target - span
                    extend_after = min(room_after, need)
                    window_end += extend_after
                    need -= extend_after
                    start = max(0.0, start - need)
                    span = window_end - start
                    if span < target - DURATION_TOLERANCE:
                        continue
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
            # Hook (Batch 2): how strong the window OPENS. Words spoken
            # in the first 3s + audio energy there. Raw values only
            # here — normalised against the best candidate in the
            # scoring pass below, like density.
            opening_words = [w for w in words
                             if start <= w["start"] < start + 3.0]
            hook_density = len(opening_words) / 3.0
            hook_energy = energy_in(start, min(window_end, start + 3.0))
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
                "hook_density": hook_density,
                "hook_energy": hook_energy,
                "gameplay": gameplay_in(start, window_end),
                "stability": stability_in(start, window_end),
                "text": " ".join(u["text"] for u in units[i:j + 1])[:300],
                "signals": [],
            })

    if candidates:
        max_density = max(c["density"] for c in candidates) or 1.0
        max_hook_density = max(c["hook_density"] for c in candidates) or 1.0
        max_hook_energy = max(c["hook_energy"] for c in candidates) or 1.0
        for c in candidates:
            density_n = min(1.0, c["density"] / max_density)
            completeness = 1.0 if c["complete"] else 0.4
            silence_n = min(1.0, c["silence"])
            # Hook: half opening speech density, half opening energy,
            # each normalised against the best candidate's opening.
            hook_n = round(0.5 * min(1.0, c["hook_density"] / max_hook_density)
                           + 0.5 * min(1.0, c["hook_energy"] / max_hook_energy), 4)
            c["hook"] = hook_n
            c["score"] = round(
                W_DENSITY * density_n
                + W_COVERAGE * c["coverage"]
                + W_COMPLETENESS * completeness
                + W_SILENCE * silence_n
                + W_ENERGY * min(1.0, c["energy"])
                + W_GAMEPLAY * c["gameplay"]
                + W_STABILITY * c["stability"]
                + W_HOOK * hook_n, 4)
            # The breakdown is the same normalised per-signal values
            # the score above was just built from — nothing invented,
            # nothing re-derived.
            c["score_breakdown"] = _score_breakdown({
                "density": density_n,
                "coverage": c["coverage"],
                "completeness": completeness,
                "silence": silence_n,
                "energy": min(1.0, c["energy"]),
                "gameplay": c["gameplay"],
                "stability": c["stability"],
                "hook": hook_n,
            })
            c["signals"] = ["speech_density", "sentence_complete" if c["complete"] else "trimmed_to_duration",
                            "silence_boundary", "audio_coverage"]
            if c["energy"] > 0:
                c["signals"].append("audio_energy_supporting")
            if c["hook"] >= 0.7:
                c["signals"].append("strong_opening")
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
                f"gameplay {c['gameplay']:.2f}, scene stability {c['stability']:.2f}, "
                f"opening hook {hook_n:.2f}."
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
        if fill_any and len(chosen) < count:
            # 'Any parts' mode: top the count up with evenly-spaced
            # windows from anywhere in the source, labelled any_part.
            chosen = chosen + _any_part_windows(
                source_duration, target, mode,
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
        # came back. In 'fill_any' mode the any-part grid fills the
        # rest (or the whole count when no visual moment fits).
        fill = _visual_moment_windows(
            energy_profile, source_duration, target, mode,
            min_s, max_s, count, [],
            energy_in, gameplay_in, stability_in)
        if fill_any and len(fill) < count:
            fill = fill + _any_part_windows(
                source_duration, target, mode,
                min_s, max_s, count - len(fill),
                [(c["start"], c["end"]) for c in fill],
                energy_in, gameplay_in, stability_in)
        if fill:
            return fill
        return []

    # Fallback: no usable transcribed speech at all (e.g. music-only /
    # silent source). Prefer energy-ranked visual moments (loudest audio
    # peaks) over uniform windows; uniform only when the source is
    # silent (energy all zero) — real footage either way, clearly
    # labelled so nobody mistakes it for a speech-driven highlight.
    # In 'fill_any' mode the any-part grid fills any remaining slots
    # (and replaces the uniform fallback: same even spread, but
    # labelled any_part, not "no speech").
    visual = _visual_moment_windows(
        energy_profile, source_duration, target, mode,
        min_s, max_s, count, [],
        energy_in, gameplay_in, stability_in)
    if fill_any and len(visual) < count:
        visual = visual + _any_part_windows(
            source_duration, target, mode,
            min_s, max_s, count - len(visual),
            [(c["start"], c["end"]) for c in visual],
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
        energy = energy_in(start, end)
        windows.append({
            "start": round(start, 3), "end": round(end, 3),
            "duration": round(end - start, 3), "words": 0,
            "density": 0.0, "complete": False, "coverage": 0.0,
            "silence": 0.0,
            "energy": energy, "score": 0.0,
            "signals": ["no_speech_fallback"],
            # Only energy was computed for a uniform fallback window.
            "score_breakdown": _score_breakdown({"energy": min(1.0, energy)}),
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
# Caption styles (23 total: 5 original + 10 CapCut-style animated,
# added 2026-11-22, kinetic + glow_pop 2026-11-24, Batch 3's five
# 2026-11-25: word_zoom, word_fade, highlight_sweep, bounce_in,
# glitch_pop, Batch 6's three platform styles 2026-11-25: tiktok_bold,
# reels_clean, shorts_minimal)
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
# Batch 3 adds five more in the same spirit. Two honest limits, written
# where they apply in write_clip_ass: libass has no per-channel offset,
# so glitch_pop's "RGB split" is a rapid magenta->cyan colour flicker
# on each word change, not a true channel split; highlight_sweep's box
# is the style's BorderStyle-3 background on the single current word
# (the full phrase is NOT shown behind it).
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
    "kinetic": "Kinetic Slide",
    "glow_pop": "Glow Pop",
    # Batch 3 (2026-11-25). "Bounce In" is taken by `bounce`, so the
    # overshoot variant is "Bounce Pop" in the UI; `sweep` already owns
    # "Highlight Sweep", so the boxed-word variant is "Highlight Box".
    "word_zoom": "Word Zoom",
    "word_fade": "Word Fade",
    "highlight_sweep": "Highlight Box",
    "bounce_in": "Bounce Pop",
    "glitch_pop": "Glitch Pop",
    # Batch 6 (2026-11-25): one style per platform. tiktok_bold is the
    # classic TikTok look (phrase-based like punchy, bigger, with a pop
    # entrance and the yellow keyword); reels_clean is smaller, clean
    # white with a soft shadow; shorts_minimal is the smallest, most
    # restrained — white, thin outline, no entrance, no shadow.
    "tiktok_bold": "TikTok Bold",
    "reels_clean": "Reels Clean",
    "shorts_minimal": "Shorts Minimal",
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


def _estimate_text_width_px(text: str, fs: int) -> float:
    """Conservative rendered width of one line of DejaVu Sans Bold at
    font size ``fs`` (pixels), from per-character width factors.

    This is the FALLBACK for _measure_text_width_px (below) when Pillow
    or the font file is unavailable. It is deliberately pessimistic —
    but not perfectly so: it UNDER-measures wide words (28-letter
    "antidisestablishmentarianism": estimator 1398px at fs 96, real
    1611px — the old fit of fs 65 still overflowed the 960px margin).
    Real measurement is the primary path; this stays only as a
    no-Pillow fallback.
    """
    total = 0.0
    for ch in text:
        if ch == " ":
            total += 0.28
        elif ch.isupper():
            total += 0.68
        elif ch.isdigit():
            total += 0.56
        elif ch.isalpha():
            total += 0.52
        else:
            total += 0.32
    return total * fs


# Batch 6 (2026-11-25): real caption measurement. libass renders the
# ASS styles below with FontName "DejaVu Sans" Bold, so the widths that
# matter are DejaVu Sans Bold's. Pillow reads the same .ttf and returns
# true glyph advances (kerning included), which the per-glyph estimator
# above cannot. The font is loaded once at 100px and scaled linearly
# (glyph advances scale exactly with size in FreeType).
_DEJAVU_BOLD_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/local/share/fonts/DejaVuSans-Bold.ttf",
)
_measure_font = None  # PIL ImageFont at 100px, or False when unavailable
_MEASURE_FONT_TRIED = False


def _load_measure_font():
    """DejaVu Sans Bold at 100px via Pillow, or None (cached).

    Returns None when Pillow is not installed or the font file cannot
    be found — the caller then falls back to _estimate_text_width_px.
    """
    global _measure_font, _MEASURE_FONT_TRIED
    if _MEASURE_FONT_TRIED:
        return _measure_font or None
    _MEASURE_FONT_TRIED = True
    try:
        from PIL import ImageFont
    except ImportError:
        _measure_font = False
        return None
    for candidate in _DEJAVU_BOLD_CANDIDATES:
        try:
            _measure_font = ImageFont.truetype(candidate, 100)
            return _measure_font
        except (OSError, IOError):
            continue
    _measure_font = False
    return None


def _measure_text_width_px(text: str, fs: int) -> float:
    """Real rendered width of one line of DejaVu Sans Bold at ``fs``.

    Primary path for caption auto-fit: Pillow measures the exact glyph
    advances of the same font libass renders. A 2% safety margin covers
    libass's own rounding (its advances are integer pixels). Falls back
    to the per-glyph estimator when Pillow or the font is unavailable.
    """
    font = _load_measure_font()
    if font is None:
        return _estimate_text_width_px(text, fs)
    return font.getlength(text) * fs / 100 * 1.02


def _fit_font_size(text: str, fs: int, max_width: float) -> int | None:
    """Smaller font size that fits ``text`` in ``max_width`` px, or
    None when ``fs`` already fits. Floored at 24 so captions stay
    readable — a word that still would not fit at 24 is left at 24
    (libass then wraps it; a 24pt overflow is a one-word edge case,
    not a silent clip of the frame). Widths are real measurements
    (Batch 6) with the estimator as fallback."""
    if _measure_text_width_px(text, fs) <= max_width:
        return None
    fitted = int(fs * max_width / _measure_text_width_px(text, fs))
    return max(24, fitted)


def _caption_align_mv(position: str, fs: int, tw: int, th: int,
                      divider_y: int | None, layout: str,
                      headline_style: str = "bold_bar") -> tuple[int, int]:
    """(ASS alignment, MarginV) for captions at ``position``.

    - "bottom" (default, pre-Batch-2 behaviour): on the split divider
      when split, lower-centre otherwise (out of the face).
    - "top": near the top, below the headline band (MarginV 300 clears
      the bold-bar headline at 120), so headline and captions stack
      instead of colliding.
    - "middle": vertically centred (top alignment at th/2 - fs/2).
      When the headline is the big centred one, the first 4s would
      collide, so middle captions drop to 62% down for those 4s' sake
      — the setting still reads "Middle" everywhere; the shift is a
      layout guard, not a different position.
    """
    split = layout == "split" and divider_y is not None
    if position == "top":
        return 8, 300
    if position == "middle":
        if headline_style == "big_centre":
            return 8, int(th * 0.62)
        return 8, max(0, th // 2 - fs // 2)
    if split:
        return 8, max(0, divider_y - fs // 2)
    return 2, 140


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


# Words a caption chunk may START with — breaking BEFORE one of these
# keeps the clause together ("we went to the club, | and we danced").
_CONJUNCTIONS = {"and", "but", "so", "or", "yet", "because", "then"}


def _group_phrases(words: list[dict], max_words: int = 6) -> list[list[dict]]:
    """Group words into caption phrases (Batch 6 rework).

    A chunk ends ONLY at a phrase boundary: sentence punctuation
    (.?!), a comma/semicolon/colon, the start of a conjunction
    (and/but/so/or/yet/because/then), or a >0.9s speech gap — never
    mid-phrase. ``max_words`` is a last resort for run-on speech with
    no punctuation at all (6 words, split into two lines at render
    time — see _phrase_lines). The old chunker cut at 4 words wherever
    the count ran out, so a phrase could end mid-clause ("we went to
    the | club and we danced").
    """
    phrases: list[list[dict]] = []
    current: list[dict] = []
    for w in words:
        if current:
            prev = current[-1]
            gap = w["start"] - prev["end"]
            prev_last = prev["word"][-1:]
            cur_clean = w["word"].strip(_PUNCT).lower()
            boundary = (
                gap > 0.9
                or prev_last in ".?!"
                or prev_last in ",;:"
                or (cur_clean in _CONJUNCTIONS and len(current) >= 2)
                or len(current) >= max_words
            )
            if boundary:
                phrases.append(current)
                current = []
        current.append(w)
    if current:
        phrases.append(current)
    return phrases


def _split_text_phrases(text: str, max_words: int = 6) -> list[list[str]]:
    """Phrase-boundary chunking for plain text (the no-word-timings
    fallback paths): same boundaries as _group_phrases, on words
    instead of timed dicts. A chunk never ends mid-phrase."""
    words = text.split()
    phrases: list[list[str]] = []
    current: list[str] = []
    for w in words:
        if current:
            prev_last = current[-1][-1:]
            cur_clean = w.strip(_PUNCT).lower()
            boundary = (
                prev_last in ".?!"
                or prev_last in ",;:"
                or (cur_clean in _CONJUNCTIONS and len(current) >= 2)
                or len(current) >= max_words
            )
            if boundary:
                phrases.append(current)
                current = []
        current.append(w)
    if current:
        phrases.append(current)
    return phrases


def _phrase_lines(phrase: list[dict], fs: int,
                  max_width: float) -> list[list[dict]]:
    """Split one phrase into 1–2 rendered lines (Batch 6).

    One line when the whole phrase fits ``max_width`` at ``fs``.
    Otherwise split at the phrase boundary that best balances the two
    lines (after a comma/semicolon/colon, or before a conjunction);
    with no boundary inside, split at the middle word. The caller fits
    the font on the LONGEST line, so a 2-line phrase keeps the full
    font size instead of shrinking — a 6-word phrase at fs 96 becomes
    two 3-word lines, not a tiny one-liner.
    """
    text = " ".join(w["word"] for w in phrase)
    if _measure_text_width_px(text, fs) <= max_width:
        return [phrase]
    n = len(phrase)
    if n < 2:
        return [phrase]
    candidates: list[int] = []
    for i in range(1, n):
        if phrase[i - 1]["word"][-1:] in ",;:":
            candidates.append(i)
        elif phrase[i]["word"].strip(_PUNCT).lower() in _CONJUNCTIONS:
            candidates.append(i)
    if not candidates:
        candidates = [n // 2]
    best_i, best_max = candidates[0], float("inf")
    for i in candidates:
        w1 = _measure_text_width_px(
            " ".join(w["word"] for w in phrase[:i]), fs)
        w2 = _measure_text_width_px(
            " ".join(w["word"] for w in phrase[i:]), fs)
        if max(w1, w2) < best_max:
            best_max, best_i = max(w1, w2), i
    return [phrase[:best_i], phrase[best_i:]]


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


def _punchy_lines_text(lines: list[list[dict]]) -> str:
    """Punchy text for 1–2 rendered lines: the keyword override rides
    on its word, lines join with ASS \\N (a real line break, not a
    space) — the event stays one event with one timing."""
    return r"\N".join(_punchy_text(line) for line in lines)


# On-screen text: stopwords for headline derivation (small, generic).
_ON_SCREEN_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
    "it", "its", "this", "that", "these", "those", "with", "for",
    "from", "you", "your", "we", "they", "he", "she", "of", "to",
    "in", "on", "at", "so", "just", "like", "very", "really", "all",
    "not", "no", "yes", "oh", "yeah", "hey", "ok", "okay", "um", "uh",
    "i", "me", "my", "our", "us", "am", "be", "been", "do",
    "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "should", "then", "than", "there", "here", "when",
    "what", "who", "how", "why", "get", "got", "go", "going", "come",
    "let", "lets", "let's",
}

_CAMPAIGN_TEXT_RE = re.compile(
    r"(?im)^\s*(?:on[\s-]*screen(?:\s+text)?|ost|headline|title[\s-]*text)"
    r"\s*[:\-–—]\s*(.+?)\s*$")


def _cap_headline(text: str, limit: int = 60) -> str:
    """Collapse whitespace and cap at ``limit`` chars (word boundary)."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.strip() or text[:limit]


def _campaign_on_screen_text(settings: dict) -> str | None:
    """Explicit on-screen text from the job brief, verbatim.

    Campaign jobs carry the brief in ``campaign_requirements``; any job
    may carry extra instructions in ``notes``. An explicit line wins
    ("on-screen text: ...", "OST: ...", "headline: ..."), else the
    first double-quoted string. Capped at 60 chars; None when the brief
    carries no explicit on-screen text — the transcript headline is
    tried next, never invented text.
    """
    for source in (settings.get("campaign_requirements") or "",
                   settings.get("notes") or ""):
        if not source:
            continue
        for line in source.splitlines():
            m = _CAMPAIGN_TEXT_RE.match(line)
            if m and m.group(1).strip():
                return _cap_headline(m.group(1).strip())
        for m in re.finditer(r'"([^"]{3,60})"', source):
            text = m.group(1).strip()
            if text:
                return _cap_headline(text)
    return None


def _transcript_headline(clip: dict, segments: list[dict]) -> str | None:
    """Headline from the clip's own transcript (max 6 words / 60 chars).

    Batch 2: each phrase in the window is SCORED, not just the one
    holding the most frequent word. A phrase wins on emphasis presence
    (one strong word makes a headline; repeating it does not), how
    often its best word recurs in the window, speech density, and how
    many distinct content words it carries — minus penalties for
    filler-heavy phrases (um/uh/hmm), phrases trailing off on a
    stopword ("... view is"), and phrases that are one word repeated
    ("go go go"). Without a scored winner, the window's first phrase.
    None when the window has no transcript words at all — silence gets
    no invented headline.
    """
    words = _clip_words(segments, clip["start"], clip["end"])
    if not words:
        return None
    phrases = _group_phrases(words) or [words]

    def content_counts() -> dict[str, int]:
        counts: dict[str, int] = {}
        for w in words:
            clean = w["word"].strip(_PUNCT).lower()
            if clean and clean not in _ON_SCREEN_STOPWORDS:
                counts[clean] = counts.get(clean, 0) + 1
        return counts

    counts = content_counts()
    if not counts:
        text = " ".join(w["word"] for w in phrases[0][:6])
        return _cap_headline(text.upper()) if text else None

    def phrase_score(phrase: list[dict]) -> float:
        if not phrase:
            return -1.0
        dur = max(0.1, phrase[-1]["end"] - phrase[0]["start"])
        density = len(phrase) / dur
        content = [w for w in phrase
                   if w["word"].strip(_PUNCT).lower() not in _ON_SCREEN_STOPWORDS
                   and w["word"].strip(_PUNCT)]
        distinct = {w["word"].strip(_PUNCT).lower() for w in content}
        # Presence, not count: one emphasis word makes a headline
        # ("highest", "insane"), but saying it five times does not make
        # it five times better — that is what let plain repetition win.
        emphasis = 2.0 if any(
            w["word"].strip(_PUNCT).lower() in EMPHASIS_WORDS for w in content) else 0.0
        best_count = max((counts.get(w, 0) for w in distinct), default=0)
        fillers = sum(1 for w in phrase
                      if w["word"].strip(_PUNCT).lower() in FILLER_WORDS)
        filler_frac = fillers / max(1, len(phrase))
        # A headline that trails off on "is"/"the" reads unfinished.
        trailing_stop = 1.0 if (
            phrase[-1]["word"].strip(_PUNCT).lower() in _ON_SCREEN_STOPWORDS) else 0.0
        # One word repeated is not a headline ("go go go go").
        repeat_penalty = 1.0 if content and len(distinct) <= 1 and len(content) >= 3 else 0.0
        return (emphasis + min(best_count, 2) * 0.5 + density * 0.3
                + min(len(distinct), 4) * 0.2 - filler_frac * 2.0
                - trailing_stop - repeat_penalty)

    scored = sorted(range(len(phrases)),
                    key=lambda i: (-phrase_score(phrases[i]), i))
    phrase_idx = scored[0]
    log.debug("Headline pick: phrase %d of %d scored %.2f: %r",
              phrase_idx, len(phrases), phrase_score(phrases[phrase_idx]),
              " ".join(w["word"] for w in phrases[phrase_idx]))
    parts = list(phrases[phrase_idx])
    if len(parts) < 3 and phrase_idx > 0:
        parts = list(phrases[phrase_idx - 1]) + parts
    if len(parts) < 3 and phrase_idx + 1 < len(phrases):
        parts = parts + list(phrases[phrase_idx + 1])
    text = " ".join(w["word"] for w in parts[:6])
    return _cap_headline(text.upper()) if text else None


def derive_on_screen_text(clip: dict, segments: list[dict],
                          settings: dict) -> str | None:
    """The on-screen headline for one clip, or None.

    Order: (a) explicit campaign text from the job brief, verbatim;
    (b) a headline from the clip's own transcript; (c) nothing when
    the window has no transcript — a silent/visual clip gets no
    invented text, and the worker logs that honestly.
    """
    campaign = _campaign_on_screen_text(settings)
    if campaign:
        return campaign
    return _transcript_headline(clip, segments)


def _title_case_headline(text: str) -> str:
    """Turn an ALL-CAPS headline into Title Case for a suggested
    title. Words with digits ("2D", "PS5") are left alone — title()
    would mangle them into "2d"/"Ps5"."""
    out: list[str] = []
    for word in text.split():
        if any(c.isdigit() for c in word):
            out.append(word)
        else:
            out.append(word.capitalize())
    return " ".join(out)


def derive_title_hashtags(segments: list[dict],
                          source_duration: float) -> tuple[str | None, list[str]]:
    """Suggested title + hashtags for a whole job, derived from the
    job's OWN transcript — never canned text.

    The title is the best headline phrase across the full source
    (the same phrase scoring `_transcript_headline` uses), in Title
    Case. Hashtags are the top content words by frequency (lowercase,
    #prefixed, de-duplicated, stopwords and fillers removed, 3–20
    chars, at most 8). Returns (None, []) when the source has no
    transcript words at all — a silent source gets no invented
    suggestions, and the job page says so.
    """
    if not segments or source_duration <= 0:
        return None, []
    title_raw = _transcript_headline(
        {"start": 0.0, "end": source_duration}, segments)
    # A title is not a sentence: drop trailing punctuation (the
    # headline phrase usually ends with one).
    title = _title_case_headline(title_raw).rstrip(_PUNCT).strip() \
        if title_raw else None
    # _clip_words strips the whitespace Whisper puts on every word
    # (" Come") — the raw segment words would fail the isalnum check
    # below and yield zero hashtags (Job #44 proved it: 0 tags).
    counts: dict[str, int] = {}
    first_seen: dict[str, int] = {}
    order = 0
    for word in _clip_words(segments, 0.0, source_duration):
        clean = word["word"].strip(_PUNCT).lower()
        if (not clean or len(clean) < 3 or len(clean) > 20
                or not clean.isalnum()
                or clean in _ON_SCREEN_STOPWORDS
                or clean in FILLER_WORDS):
            continue
        if clean not in counts:
            counts[clean] = 0
            first_seen[clean] = order
            order += 1
        counts[clean] += 1
    ranked = sorted(counts, key=lambda w: (-counts[w], first_seen[w]))
    hashtags = [f"#{w}" for w in ranked[:8]]
    return title, hashtags


def write_headline_ass(text: str, duration: float, ass_path: Path,
                       tw: int, th: int, style: str = "bold_bar") -> bool:
    """Write a minimal ASS file with one headline event.

    Shown for the first 4 seconds of the clip only. Batch 2 styles
    (per-job setting ``headline_style``; unknown values fall back to
    "bold_bar", the look every job used before Batch 2):
    - "bold_bar": top-centre, huge bold white on a translucent bar
      (the original look; MarginV 120).
    - "lower_third": a bottom band (opaque box, Alignment 2, MarginV
      40) — sits below bottom captions (MarginV 140), so the two stack
      instead of colliding.
    - "big_centre": very large, vertically centred (Alignment 5) —
      the clip's hook as a title card. Middle captions drop to 62%
      while it shows (see _caption_align_mv), so they never overlap it.
    A single very long word is scaled down (auto-fit) so it cannot
    overflow the frame; ordinary text wraps as before. Returns False
    when there is nothing to show.
    """
    if not text or duration <= 0:
        return False
    style = style if style in HEADLINE_STYLES else "bold_bar"
    show = min(4.0, duration)
    if style == "lower_third":
        fs = 64 if tw >= 1080 else 48
        align, mv = 2, 40
        border, outline_w, shadow = 3, 2, 0
        back = "&HCC000000"
    elif style == "big_centre":
        fs = 110 if tw >= 1080 else 80
        align, mv = 5, 0
        border, outline_w, shadow = 1, 5, 1
        back = "&H80000000"
    else:  # bold_bar
        fs = 84 if tw >= 1080 else 60
        align, mv = 8, 120
        border, outline_w, shadow = 1, 4, 0
        back = "&H80000000"
    # Auto-fit: a single long word must fit on one line; the rest of
    # the headline may wrap (WrapStyle 0) as before.
    longest = max(text.split(), key=len) if text.split() else text
    fitted = _fit_font_size(longest, fs, tw - 120)
    fs_prefix = f"{{\\fs{fitted}}}" if fitted is not None else ""
    header = (
        "[Script Info]\n"
        "; Magician Clipper — on-screen headline\n"
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
        f"Style: Headline,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
        f"{back},-1,0,0,0,100,100,0,0,{border},{outline_w},{shadow},{align},40,40,{mv},1\n"
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
        f"Dialogue: 0,0:00:00.00,{_fmt_ass_time(show)},Headline,,0,0,0,,{fs_prefix}{_ass_escape(text)}\n"
    )
    ass_path.write_text(header, encoding="utf-8")
    return True


def write_clip_ass(segments: list[dict], start: float, end: float,
                   style_id: str, ass_path: Path,
                   divider_y: int | None, tw: int, th: int,
                   layout: str, caption_position: str = "bottom",
                   headline_style: str = "bold_bar",
                   caption_safe_zone: bool = True) -> bool:
    """Write an ASS caption file for the clip window (0-based times).

    ``divider_y`` is the y of the streamer/gameplay divider in output
    pixels (split layout); None for layouts without a divider. Returns
    True when at least one event was written. ``classic`` is NOT handled
    here — it uses the legacy SRT path in render_clip.

    Batch 2 ``caption_position`` ("bottom" default = the pre-Batch-2
    spot, "top", "middle") moves the captions via _caption_align_mv;
    ``headline_style`` only matters for the middle-vs-big-centre
    collision guard. Batch 2 auto-fit: a line that would overflow the
    frame is scaled down with a per-event {\\fs} override — the whole
    line for the big single-line styles (punchy, word pop, animated),
    the longest word only for full-sentence styles (clean_subs), which
    may wrap. A fitted size never goes below 24.
    Batch 6 ``caption_safe_zone`` (default ON): the caption block is
    capped at ~78% of the frame width and kept left-of-centre, clear of
    TikTok's right action rail (~15% of the frame) and the bottom bar —
    the right margin reserves 22% of the width and the fit width is
    the safe area, not the full frame. OFF restores the pre-Batch-6
    behaviour (full-width centred captions, max_w = tw - 120). The
    phrase is split into 2 lines at a phrase boundary before the font
    is shrunk, so safe-zone captions keep the big font size.
    """
    duration = end - start
    big = tw >= 1080
    split = layout == "split" and divider_y is not None
    position = caption_position if caption_position in CAPTION_POSITIONS else "bottom"
    headline_style = headline_style if headline_style in HEADLINE_STYLES else "bold_bar"
    safe_zone = bool(caption_safe_zone)

    def margin_for(font_size: int) -> tuple[int, int]:
        """(alignment, marginV) — Batch 2 caption position; "bottom"
        is the pre-Batch-2 behaviour (on the divider when split,
        lower-centre otherwise)."""
        return _caption_align_mv(position, font_size, tw, th, divider_y,
                                 layout, headline_style)

    # Batch 6 safe zone: the caption text area is the left ~78% of the
    # frame (right margin reserves 22% for the action rail); its centre
    # sits at ~43% of the frame width — left-of-centre, never under the
    # rail. OFF: the old 40px margins on both sides.
    if safe_zone:
        ml = 40
        mr = max(40, int(tw * 0.22) - 40)
        max_w = int(tw * 0.78) - 20
    else:
        ml, mr = 40, 40
        # Batch 2 auto-fit: scale a line down so it fits the frame.
        # max_w is the frame minus the caption side margins plus safety.
        max_w = tw - 120
    # Centre of the caption text area — the kinetic slide lands here,
    # not at the frame centre, when the safe zone is on.
    center_x = ml + (tw - ml - mr) // 2

    def fit(text: str, fs: int, whole_line: bool = True) -> str:
        """"{\\fsN}" prefix when ``text`` would overflow at ``fs`` —
        the whole line for single-line styles, the longest word only
        for full-sentence styles. "" when it already fits. Widths are
        real DejaVu Sans Bold measurements (Batch 6)."""
        probe = text
        if not whole_line:
            words = text.split()
            probe = max(words, key=len) if words else text
        fitted = _fit_font_size(probe, fs, max_w)
        return f"{{\\fs{fitted}}}" if fitted is not None else ""

    def fit_lines(lines: list[list[dict]], fs: int) -> str:
        """{\\fsN} prefix fitted on the LONGEST rendered line of a
        1–2 line phrase — a phrase split into two lines keeps the full
        font size (Batch 6); only a line that still overflows shrinks."""
        longest = ""
        for line in lines:
            text = " ".join(w["word"] for w in line)
            if _measure_text_width_px(text, fs) > _measure_text_width_px(longest, fs):
                longest = text
        return fit(longest, fs)

    styles: dict[str, str] = {}
    if style_id == "punchy":
        fs = 96 if big else 68
        align, mv = margin_for(fs)
        styles["Punchy"] = (
            f"Style: Punchy,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,-1,0,0,0,100,100,0,0,1,3,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "tiktok_bold":
        # Batch 6: the classic TikTok look — phrase-based like punchy,
        # bigger, with a pop entrance on the whole phrase and the same
        # yellow keyword. The pop prefix is added per event below.
        fs = 104 if big else 76
        align, mv = margin_for(fs)
        styles["TikTokBold"] = (
            f"Style: TikTokBold,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,-1,0,0,0,100,100,0,0,1,4,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "word_pop":
        fs = 130 if big else 92
        align, mv = margin_for(fs)
        styles["WordPop"] = (
            f"Style: WordPop,DejaVu Sans,{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,-1,0,0,0,100,100,0,0,1,4,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "title_card":
        fs = 60 if big else 44
        align, mv = (8, max(0, divider_y - 40)) if split else (8, int(th * 0.40))
        styles["Title"] = (
            f"Style: Title,DejaVu Sans,{fs},&H00000000,&H000000FF,&H00FFFFFF,"
            f"&H00FFFFFF,-1,0,0,0,100,100,0,0,3,0,0,{align},{ml},{mr},{mv},1"
        )
        # The Title event is the hook title (its own spot); only the
        # CleanSubs captions follow the position setting — and "bottom"
        # keeps the established (2, 40) subtitle spot, not the divider.
        cs_align, cs_mv = ((2, 40) if position == "bottom" else
                           _caption_align_mv(position, 36, tw, th, divider_y,
                                             layout, headline_style))
        styles["CleanSubs"] = (
            "Style: CleanSubs,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,0,0,0,0,100,100,0,0,1,2,0,{cs_align},{ml},{mr},{cs_mv},1"
        )
    elif style_id == "clean_subs":
        cs_align, cs_mv = ((2, 40) if position == "bottom" else
                           _caption_align_mv(position, 36, tw, th, divider_y,
                                             layout, headline_style))
        styles["CleanSubs"] = (
            "Style: CleanSubs,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,0,0,0,0,100,100,0,0,1,2,0,{cs_align},{ml},{mr},{cs_mv},1"
        )
    elif style_id in ("karaoke", "bounce", "typewriter", "sweep",
                      "neon", "slam", "outline", "gradient",
                      "kinetic", "glow_pop",
                      "word_zoom", "word_fade", "highlight_sweep",
                      "bounce_in", "glitch_pop",
                      "reels_clean", "shorts_minimal"):
        # (name, fs_big, fs_small, primary, secondary, outline_colour,
        #  back_colour, bold, border_style, outline, shadow)
        # Colours are ASS &HAABBGGRR. Neon shadow is BackColour magenta,
        # so the glow reads; Outline is hollow (primary fully transparent).
        # Glow Pop's glow is its gold BackColour with Shadow 2 — steady
        # in the burn (libass cannot pulse a shadow; the preview pulses
        # it, the burn keeps the glow constant). Kinetic's slide is a
        # straight linear \move (no easing curve in libass); the preview
        # eases it — same spirit, not the same curve.
        # Batch 3: highlight_sweep's box IS the style — BorderStyle 3
        # fills the text box with the yellow BackColour, and the text
        # is black on it (white on yellow would not read). glitch_pop
        # has no true RGB split in libass (no per-channel offset), so
        # the flicker lives in the per-word prefix below: a rapid
        # magenta -> cyan colour flash on each word change.
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
            "kinetic": ("Kinetic", 100, 72, "&H00FFFFFF", "&H0000FFFF",
                        "&H00000000", "&H80000000", -1, 1, 4, 0),
            "glow_pop": ("GlowPop", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                         "&H00000000", "&H0000CCFF", -1, 1, 4, 2),
            "word_zoom": ("WordZoom", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0),
            "word_fade": ("WordFade", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0),
            "highlight_sweep": ("HighlightSweep", 96, 68, "&H00000000",
                                "&H00FFFFFF", "&H00000000", "&H0000FFFF",
                                -1, 3, 0, 0),
            "bounce_in": ("BounceIn", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0),
            "glitch_pop": ("GlitchPop", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                           "&H00000000", "&H80000000", -1, 1, 4, 0),
            # Batch 6: reels_clean is smaller, clean white with a soft
            # shadow (outline 2, shadow 1); shorts_minimal is the
            # smallest, most restrained — thin outline, no shadow, no
            # entrance. Both are word-at-a-time like the other
            # animated styles, with no entrance override.
            "reels_clean": ("ReelsClean", 84, 60, "&H00FFFFFF", "&H0000FFFF",
                            "&H00000000", "&H80000000", -1, 1, 2, 1),
            "shorts_minimal": ("ShortsMinimal", 72, 52, "&H00FFFFFF",
                               "&H0000FFFF", "&H00000000", "&H80000000",
                               -1, 1, 1, 0),
        }
        (sname, fs_big, fs_small, primary, secondary, outline_c, back_c,
         bold, border, outline_w, shadow) = _NEW_STYLE_PARAMS[style_id]
        fs = fs_big if big else fs_small
        align, mv = margin_for(fs)
        styles[sname] = (
            f"Style: {sname},DejaVu Sans,{fs},{primary},{secondary},"
            f"{outline_c},{back_c},{bold},0,0,0,100,100,0,0,{border},"
            f"{outline_w},{shadow},{align},{ml},{mr},{mv},1"
        )
    else:
        return False

    events: list[str] = []
    words = _clip_words(segments, start, end)
    if style_id in ("punchy", "tiktok_bold", "word_pop"):
        if words:
            if style_id in ("punchy", "tiktok_bold"):
                sname = "Punchy" if style_id == "punchy" else "TikTokBold"
                # Batch 6: TikTok Bold pops the whole phrase in
                # (108% -> 100% over its first 120ms).
                pop = ("{\\fscx108\\fscy108\\t(0,120,\\fscx100\\fscy100)}"
                       if style_id == "tiktok_bold" else "")
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
                    # Batch 6: split into 1-2 lines at a phrase
                    # boundary first; the font is fitted on the
                    # longest line, so a split phrase keeps full size.
                    lines = _phrase_lines(phrase, fs, max_w)
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(e)},"
                        f"{sname},,0,0,0,,{fit_lines(lines, fs)}{pop}"
                        f"{_punchy_lines_text(lines)}"
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
                        f"WordPop,,0,0,0,,{fit(w['word'], fs)}{_ass_escape(w['word'])}"
                    )
        if not events:
            # No word timings: fall back to segment text, chunked at
            # phrase boundaries (Batch 6 — never mid-phrase).
            sname = ("TikTokBold" if style_id == "tiktok_bold" else "Punchy")
            pop = ("{\\fscx108\\fscy108\\t(0,120,\\fscx100\\fscy100)}"
                   if style_id == "tiktok_bold" else "")
            for seg in segments:
                s, e = max(seg["start"], start), min(seg["end"], end)
                if e <= s or not seg["text"]:
                    continue
                chunks = _split_text_phrases(seg["text"])
                span = (e - start) / max(1, len(chunks))
                for j, chunk in enumerate(chunks):
                    cs, ce = s - start + j * span, s - start + (j + 1) * span
                    phrase = [{"word": w, "start": cs, "end": ce} for w in chunk]
                    lines = _phrase_lines(phrase, fs, max_w)
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"{sname},,0,0,0,,{fit_lines(lines, fs)}{pop}"
                        f"{_punchy_lines_text(lines)}"
                    )
    elif style_id in ("karaoke", "bounce", "typewriter", "sweep",
                      "neon", "slam", "outline", "gradient",
                      "kinetic", "glow_pop",
                      "word_zoom", "word_fade", "highlight_sweep",
                      "bounce_in", "glitch_pop",
                      "reels_clean", "shorts_minimal"):
        # CapCut-style animated captions. Every branch produces events
        # in the SAME style the Captions Studio preview loops.
        sname = _NEW_STYLE_PARAMS[style_id][0]
        if style_id == "karaoke":
            # Full phrase visible; each word fills with the secondary
            # (yellow) colour as it is spoken — ASS \k, centiseconds.
            # Batch 6: the \k duration is the word's OWN duration in
            # centiseconds. The old max(10, ...) floor forced every
            # short word's fill to last 100ms regardless of how fast it
            # was spoken (a 50ms word filled for twice its length);
            # \k is centisecond precision by format, so round() here is
            # exact within ±5ms. The floor is now 1cs so a word never
            # gets \k0.
            for phrase in _group_phrases(words):
                s, e = phrase[0]["start"], phrase[-1]["end"]
                if e <= s:
                    continue
                lines = _phrase_lines(phrase, fs, max_w)
                line_parts = []
                for line in lines:
                    line_parts.append(" ".join(
                        "{\\k%d}%s" % (
                            max(1, int(round((w["end"] - w["start"]) * 100))),
                            _ass_escape(w["word"]))
                        for w in line))
                events.append(
                    f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(min(e, duration))},"
                    f"Karaoke,,0,0,0,,{fit_lines(lines, fs)}{'\\N'.join(line_parts)}"
                )
        elif style_id == "sweep":
            # Full phrase always visible; one event per word, with the
            # active word coloured yellow — the highlight sweeps across.
            for phrase in _group_phrases(words):
                lines = _phrase_lines(phrase, fs, max_w)
                for i, w in enumerate(phrase):
                    s = w["start"]
                    e = (phrase[i + 1]["start"] if i + 1 < len(phrase)
                         else phrase[-1]["end"])
                    if e <= s:
                        continue
                    # Walk the phrase's lines, keeping the active-word
                    # override on word i (global index across lines).
                    idx = 0
                    line_texts = []
                    for line in lines:
                        parts = []
                        for pw in line:
                            text = _ass_escape(pw["word"])
                            if idx == i:
                                parts.append("{\\1c&H00FFFF&}" + text + "{\\1c&HFFFFFF&}")
                            else:
                                parts.append(text)
                            idx += 1
                        line_texts.append(" ".join(parts))
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(min(e, duration))},"
                        f"Sweep,,0,0,0,,{fit_lines(lines, fs)}{'\\N'.join(line_texts)}"
                    )
        elif style_id == "typewriter":
            # Letters appear one by one: each event holds the phrase
            # typed so far, ending when the phrase ends. The fit is
            # computed on the FULL phrase, once, so the size never
            # jumps as letters appear. Phrases stay at 4 words (the
            # established typing unit) — a 6-word phrase would take
            # too long to type out.
            for phrase in _group_phrases(words, max_words=4):
                text = " ".join(w["word"] for w in phrase)
                s, e = phrase[0]["start"], phrase[-1]["end"]
                if e <= s or not text:
                    continue
                phrase_fit = fit(text, fs)
                per_char = (e - s) / max(1, len(text))
                for k in range(len(text)):
                    cs = s + k * per_char
                    ce = min(e, duration)
                    if cs >= ce:
                        break
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"Typewriter,,0,0,0,,{phrase_fit}{_ass_escape(text[:k + 1])}"
                    )
        else:
            # Word-at-a-time styles: bounce / slam / neon / outline /
            # gradient / kinetic / glow_pop / word_zoom / word_fade /
            # highlight_sweep / bounce_in / glitch_pop. Same timing
            # loop as word_pop; only the entrance override (and, for
            # gradient, the per-word colour) differs.
            for i, w in enumerate(words):
                s, e = w["start"], w["end"]
                min_dur = 0.35 if style_id in ("bounce", "kinetic", "bounce_in") else (
                    0.30 if style_id in ("glow_pop", "word_zoom", "word_fade",
                                         "glitch_pop") else 0.25)
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
                elif style_id == "kinetic":
                    # Slide in from the left + scale overshoot. The
                    # anchor is the caption line's own position
                    # (divider-centred when split, bottom-centre
                    # otherwise), so the slide lands exactly where the
                    # plain caption would sit. Batch 6: the slide
                    # lands at the safe-zone centre (center_x), not
                    # the frame centre, when the safe zone is on.
                    k_align, k_mv = margin_for(fs)
                    anchor_y = k_mv if k_align == 8 else th - k_mv
                    cx = center_x
                    prefix = ("{\\move(%d,%d,%d,%d,0,250)"
                              "\\t(0,250,\\fscx110\\fscy110)"
                              "\\t(250,350,\\fscx100\\fscy100)}"
                              % (cx - 360, anchor_y, cx, anchor_y))
                elif style_id == "glow_pop":
                    # Pop in with overshoot; the glow is the style's
                    # gold shadow (steady in the burn).
                    prefix = ("{\\fscx0\\fscy0\\t(0,150,\\fscx118\\fscy118)"
                              "\\t(150,280,\\fscx100\\fscy100)}")
                elif style_id == "word_zoom":
                    # Each word lands at 120% and settles to 100% over
                    # its first 300ms — a gentle zoom as it is spoken.
                    prefix = "{\\fscx120\\fscy120\\t(0,300,\\fscx100\\fscy100)}"
                elif style_id == "word_fade":
                    # Each word fades in from fully transparent over
                    # its first 250ms (\alpha FF -> 00).
                    prefix = "{\\alpha&HFF&\\t(0,250,\\alpha&H00&)}"
                elif style_id == "highlight_sweep":
                    # No prefix: the yellow box IS the style (BorderStyle
                    # 3 + yellow BackColour). One word per event, so the
                    # box sits behind the current word only and moves
                    # word to word as each word is spoken.
                    prefix = ""
                elif style_id == "bounce_in":
                    # Pop in with an overshoot AND an undershoot settle
                    # (118% -> 95% -> 100%): a real bounce, distinct
                    # from `bounce`'s single overshoot.
                    prefix = ("{\\fscx0\\fscy0\\t(0,120,\\fscx118\\fscy118)"
                              "\\t(120,240,\\fscx95\\fscy95)"
                              "\\t(240,340,\\fscx100\\fscy100)}")
                elif style_id == "glitch_pop":
                    # libass has no per-channel offset, so a true RGB
                    # split is impossible; the flicker is simulated as
                    # a rapid magenta -> cyan colour flash on each word
                    # change, settling to white with a small scale pop.
                    prefix = ("{\\fscx112\\fscy112"
                              "\\t(0,80,\\1c&HFF00FF&)"
                              "\\t(80,160,\\1c&H00FFFF&)"
                              "\\t(160,260,\\fscx100\\fscy100)}")
                else:  # neon, outline
                    prefix = ""
                events.append(
                    f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(e)},"
                    f"{sname},,0,0,0,,{fit(w['word'], fs)}{prefix}{_ass_escape(w['word'])}"
                )
        if not events:
            # No word timings: fall back to segment text, chunked at
            # phrase boundaries (Batch 6), rendered in this style
            # (plain, no entrance overrides — the look still matches).
            for seg in segments:
                s, e = max(seg["start"], start), min(seg["end"], end)
                if e <= s or not seg["text"]:
                    continue
                chunks = _split_text_phrases(seg["text"])
                span = (e - start) / max(1, len(chunks))
                for j, chunk in enumerate(chunks):
                    cs, ce = s - start + j * span, s - start + (j + 1) * span
                    phrase = [{"word": w, "start": cs, "end": ce} for w in chunk]
                    lines = _phrase_lines(phrase, fs, max_w)
                    text = "\\N".join(
                        " ".join(_ass_escape(w["word"]) for w in line)
                        for line in lines)
                    events.append(
                        f"Dialogue: 0,{_fmt_ass_time(cs)},{_fmt_ass_time(ce)},"
                        f"{sname},,0,0,0,,{fit_lines(lines, fs)}{text}"
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
                f"Title,,0,0,0,,{fit(' '.join(first_words).upper(), fs)}{title}"
            )
        for seg in segments:
            s, e = max(seg["start"], start), min(seg["end"], end)
            if e <= s or not seg["text"]:
                continue
            events.append(
                f"Dialogue: 0,{_fmt_ass_time(s - start)},{_fmt_ass_time(e - start)},"
                f"CleanSubs,,0,0,0,,{fit(seg['text'], 36, whole_line=False)}{_ass_escape(seg['text'])}"
            )
    elif style_id == "clean_subs":
        for seg in segments:
            s, e = max(seg["start"], start), min(seg["end"], end)
            if e <= s or not seg["text"]:
                continue
            events.append(
                f"Dialogue: 0,{_fmt_ass_time(s - start)},{_fmt_ass_time(e - start)},"
                f"CleanSubs,,0,0,0,,{fit(seg['text'], 36, whole_line=False)}{_ass_escape(seg['text'])}"
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
# Clip enhancement — Batch 1 (2026-11-25)
#
# Four per-job boolean settings, all DEFAULT ON (a job created before
# them, or one whose stored settings omit them, behaves as ON):
#   auto_zoom       — slow punch-in (1.00 -> 1.08) on high-energy moments
#   face_tracking   — the layout crop follows the speaker's face
#   silence_removal — trim leading silence, cut internal silences > 0.7s
#   filler_removal  — cut um/uh/hmm/erm spans (word-timestamped)
#
# Silence/filler cutting happens BEFORE captions are built: the segment
# is cleaned first and the transcript is re-mapped onto the cleaned
# timeline, so burned captions stay in sync with the audio that is
# actually in the clip. When all four are OFF the render path is
# unchanged (the chains below are built exactly as before).
# ---------------------------------------------------------------------------

def _feature_on(settings: dict, key: str) -> bool:
    """A Batch-1 enhancement flag: ON unless the job explicitly set it
    OFF. Old jobs (no key stored) get the new behaviour; a stored
    False is honoured."""
    return bool(settings.get(key, True))


FILLER_WORDS = frozenset({
    "um", "umm", "uh", "uhh", "hmm", "hmmm", "erm", "mmm",
})


def detect_silences(source: Path, start: float, end: float,
                    min_duration: float = 0.7, noise_db: int = -40) -> list[tuple[float, float]]:
    """Silence spans inside [start, end] (source times), via ffmpeg
    silencedetect. Only spans >= min_duration are returned. A trailing
    silence (silence_start with no silence_end — the audio ends silent)
    runs to the window end. [] when the source has no audio or
    detection fails — silence removal then simply has nothing to cut,
    never an error."""
    duration = max(0.0, end - start)
    if duration <= 0:
        return []
    proc = run([FFMPEG, "-y", "-v", "info",
                "-ss", str(start), "-t", str(duration), "-i", str(source),
                "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}",
                "-f", "null", "-"], timeout=300)
    spans: list[tuple[float, float]] = []
    cur_start: float | None = None
    for line in (proc.stderr or "").splitlines():
        m = re.search(r"silence_start:\s*([0-9.]+)", line)
        if m:
            cur_start = float(m.group(1))
            continue
        m = re.search(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)", line)
        if m and cur_start is not None:
            s, e = start + cur_start, start + float(m.group(1))
            if e - s >= min_duration - 1e-6:
                spans.append((max(start, s), min(end, e)))
            cur_start = None
    if cur_start is not None:
        # Audio ends in silence: the span runs to the window end.
        s = start + cur_start
        if end - s >= min_duration - 1e-6:
            spans.append((max(start, s), end))
    return spans


def filler_spans(segments: list[dict], start: float, end: float,
                 pad: float = 0.05) -> tuple[list[tuple[float, float]], int]:
    """(spans, count) for filler words inside [start, end] (source
    times). Words match case-insensitively after stripping punctuation;
    each span is padded by ``pad`` but never into a neighbouring word,
    so a cut never clips the word before/after the filler."""
    words: list[dict] = []
    for seg in segments:
        for w in (seg.get("words") or []):
            if start <= w["start"] < end:
                words.append(w)
    words.sort(key=lambda w: w["start"])
    spans: list[tuple[float, float]] = []
    for i, w in enumerate(words):
        clean = re.sub(r"^[^a-z]+|[^a-z]+$", "", (w.get("word") or "").lower())
        if clean not in FILLER_WORDS:
            continue
        lo = w["start"] - pad
        hi = w["end"] + pad
        if i > 0:
            lo = max(lo, words[i - 1]["end"])
        if i + 1 < len(words):
            hi = min(hi, words[i + 1]["start"])
        lo = max(lo, start)
        hi = min(hi, end)
        if hi - lo > 0.05:
            spans.append((lo, hi))
    return spans, len(spans)


def merge_cuts(cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping / adjacent cut spans (gap < 0.05s), sorted."""
    merged: list[tuple[float, float]] = []
    for s, e in sorted(cuts):
        if e <= s:
            continue
        if merged and s <= merged[-1][1] + 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def compute_clip_cuts(source: Path, segments: list[dict], start: float,
                      end: float, settings: dict) -> tuple[list[tuple[float, float]], dict]:
    """Cut list (source times) for one clip window + stats. Silence
    spans come from the audio; filler spans from the transcript's word
    timestamps. [] when both flags are off, or when there is nothing to
    cut — cleaning is a no-op then, never a failure."""
    cuts: list[tuple[float, float]] = []
    fillers_cut = 0
    if _feature_on(settings, "silence_removal"):
        cuts += detect_silences(source, start, end)
    if _feature_on(settings, "filler_removal"):
        spans, fillers_cut = filler_spans(segments, start, end)
        cuts += spans
    cuts = merge_cuts(cuts)
    cut_seconds = sum(e - s for s, e in cuts)
    leading = cuts[0][1] - cuts[0][0] if cuts and cuts[0][0] <= start + 0.05 else 0.0
    stats = {"cut_seconds": round(cut_seconds, 2),
             "fillers_cut": fillers_cut,
             "leading_trimmed": round(leading, 2)}
    return cuts, stats


def _remap_time(t: float, start: float, cuts: list[tuple[float, float]]) -> float | None:
    """Map a source-time t onto the cleaned timeline (0-based at the
    window start), or None when t falls inside a removed span."""
    if t < start:
        return 0.0
    removed = 0.0
    for cs, ce in cuts:
        if t < cs:
            break
        if cs <= t < ce:
            return None
        removed += ce - cs
    return (t - start) - removed


def _remap_span(s: float, e: float, start: float,
                cuts: list[tuple[float, float]]) -> tuple[float, float] | None:
    """Map a source-time span onto the cleaned timeline. Returns
    (new_s, new_e) or None when the span is fully removed. A span that
    starts inside a cut resumes at the cut's end; one that ends inside
    a cut stops at the cut's start — so a word straddling a cut keeps
    only the part that is still audible."""
    ns = _remap_time(s, start, cuts)
    if ns is None:
        for cs, ce in cuts:
            if cs <= s < ce:
                ns = _remap_time(ce, start, cuts)
                break
    ne = _remap_time(e, start, cuts)
    if ne is None:
        # e inside a cut: the kept part ends at the cut's start. That
        # boundary maps to (cs - start) minus the cuts fully before it
        # (_remap_time(cs) itself is None — cs is inside its own cut).
        for cs, ce in cuts:
            if cs <= e < ce:
                removed = sum(c2 - c1 for c1, c2 in cuts if c2 <= cs)
                ne = (cs - start) - removed
                break
    if ns is None or ne is None or ne - ns < 0.01:
        return None
    return (ns, ne)


def remap_segments(segments: list[dict], start: float,
                   cuts: list[tuple[float, float]]) -> list[dict]:
    """Transcript re-mapped onto the cleaned timeline (0-based at the
    window start). Words inside removed spans are dropped; segment text
    is rebuilt from the surviving words, so captions match the audio
    that is actually in the clip."""
    if not cuts:
        return segments
    out: list[dict] = []
    for seg in segments:
        words: list[dict] = []
        for w in (seg.get("words") or []):
            span = _remap_span(w["start"], w["end"], start, cuts)
            if span is None:
                continue
            text = (w.get("word") or "").strip()
            if text:
                words.append({"start": span[0], "end": span[1], "word": text})
        if not words:
            continue
        out.append({"start": words[0]["start"], "end": words[-1]["end"],
                    "text": " ".join(w["word"] for w in words), "words": words})
    return out


def remap_spans(spans: list[tuple[float, float]], start: float,
                cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Source-time spans (e.g. zoom moments) onto the cleaned timeline;
    spans shorter than 0.3s after the mapping are dropped. With no cuts
    this is just a shift to window-relative time."""
    if not cuts:
        return [(a - start, b - start) for a, b in spans]
    out: list[tuple[float, float]] = []
    for a, b in spans:
        mapped = _remap_span(a, b, start, cuts)
        if mapped is not None and mapped[1] - mapped[0] >= 0.3:
            out.append(mapped)
    return out


def _cleaning_keeps_duration(cleaned_dur: float, settings: dict) -> bool:
    """Would the cleaned duration still validate? Exact/minimum need
    the target (within tolerance); maximum needs >= min when one is
    set. Anything else renders uncleaned rather than failing the clip."""
    mode = (settings.get("duration_mode") or "exact").lower()
    target = float(settings.get("duration_seconds", 30))
    min_s = settings.get("duration_min_seconds")
    min_s = float(min_s) if min_s not in (None, "") else None
    max_s = settings.get("duration_max_seconds")
    max_s = float(max_s) if max_s not in (None, "") else None
    if mode == "exact":
        return abs(cleaned_dur - target) <= DURATION_TOLERANCE
    if mode == "minimum":
        return (cleaned_dur >= target - DURATION_TOLERANCE
                and (not max_s or cleaned_dur <= max_s + DURATION_TOLERANCE))
    return (cleaned_dur <= target + DURATION_TOLERANCE
            and (not min_s or cleaned_dur >= min_s - DURATION_TOLERANCE))


def clean_clip_segment(source: Path, start: float, end: float,
                       cuts: list[tuple[float, float]], out_path: Path) -> Path:
    """Re-encode [start, end] with the cut spans removed (trim + concat,
    video + audio together so A/V stay in sync). CRF 18 for the
    intermediate, to limit the double-encode loss before the final
    render. Returns out_path. Raises on ffmpeg failure — the caller
    falls back to the uncleaned clip and says so in the note."""
    kept: list[tuple[float, float]] = []
    cursor = start
    for cs, ce in cuts:
        if cs > cursor:
            kept.append((cursor, cs))
        cursor = max(cursor, ce)
    if cursor < end:
        kept.append((cursor, end))
    if not kept:
        raise RuntimeError("Cleaning would remove the whole clip window.")
    v_parts, a_parts = [], []
    for j, (ks, ke) in enumerate(kept):
        v_parts.append(f"[0:v]trim={ks:.3f}:{ke:.3f},setpts=PTS-STARTPTS[v{j}]")
        a_parts.append(f"[0:a]atrim={ks:.3f}:{ke:.3f},asetpts=PTS-STARTPTS[a{j}]")
    join = "".join(f"[v{j}][a{j}]" for j in range(len(kept)))
    fc = ";".join(v_parts + a_parts) + f";{join}concat=n={len(kept)}:v=1:a=1[cv][ca]"
    proc = run([FFMPEG, "-y", "-v", "error", "-i", str(source),
                "-filter_complex", fc, "-map", "[cv]", "-map", "[ca]",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                str(out_path)], timeout=1800)
    if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError(
            f"Cleaning pass failed for clip {start:.1f}-{end:.1f}s: "
            f"{(proc.stderr or '').strip()[:300]}")
    return out_path


def _extend_window_for_cleaning(source: Path, segments: list[dict],
                                start: float, end: float, settings: dict,
                                source_duration: float) -> tuple[float, float, list, dict]:
    """Extend [start, end] so the cleaned clip still meets its duration
    promise. The window grows into neighbouring source (end first, then
    start) until the cleaned duration is within 0.05s of the need, or
    the source runs out. Returns (start, end, cuts, stats); cuts is []
    when cleaning cannot be kept even after extending — the caller then
    renders the window uncleaned instead of failing the clip."""
    mode = (settings.get("duration_mode") or "exact").lower()
    target = float(settings.get("duration_seconds", 30))
    min_s = settings.get("duration_min_seconds")
    min_s = float(min_s) if min_s not in (None, "") else None
    need = target if mode in ("exact", "minimum") else (min_s or 0.0)
    orig_start, orig_end = start, end
    cuts, stats = compute_clip_cuts(source, segments, start, end, settings)
    if need <= 0:
        return start, end, cuts, stats
    for _ in range(4):
        cleaned = (end - start) - sum(e - s for s, e in cuts)
        if cleaned >= need - 0.05:
            return start, end, cuts, stats
        deficit = need - cleaned
        if end < source_duration:
            end = round(end + min(deficit, source_duration - end), 3)
        elif start > 0:
            start = round(start - min(deficit, start), 3)
        else:
            break
        cuts, stats = compute_clip_cuts(source, segments, start, end, settings)
    cleaned = (end - start) - sum(e - s for s, e in cuts)
    if cleaned < need - DURATION_TOLERANCE:
        # Cleaning cannot be kept even after extending: return the
        # ORIGINAL window with no cuts — the clip renders uncleaned.
        return orig_start, orig_end, [], stats
    return start, end, cuts, stats


def zoom_moments(energy_profile: list[float], start: float, end: float,
                 threshold_frac: float = 0.6, min_len: float = 1.0,
                 max_moments: int = 3, max_len: float = 6.0) -> list[tuple[float, float]]:
    """High-energy moments inside [start, end] (SOURCE times), from the
    per-second RMS profile — the same signal the selector uses as a
    supporting term. A moment is a run of seconds at >= 60% of the
    window's peak RMS, at least 1s long; runs < 1s apart merge; at most
    the 3 longest moments, each capped at 6s. [] when the profile is
    empty or flat — no moment, no zoom, honestly reported."""
    if not energy_profile:
        return []
    lo = max(0, int(start))
    hi = min(len(energy_profile), int(end) + 1)
    vals = energy_profile[lo:hi]
    if not vals:
        return []
    peak = max(vals)
    if peak <= 0:
        return []
    thresh = threshold_frac * peak
    runs: list[list[float]] = []
    run_start: float | None = None
    for i, v in enumerate(vals):
        t = float(lo + i)
        if v >= thresh:
            if run_start is None:
                run_start = t
        elif run_start is not None:
            runs.append([run_start, t])
            run_start = None
    if run_start is not None:
        runs.append([run_start, float(lo + len(vals))])
    merged: list[list[float]] = []
    for r in runs:
        s, e = max(r[0], start), min(r[1], end)
        if e - s < 0.05:
            continue
        if merged and s - merged[-1][1] < 1.0:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    moments = [(s, min(e, s + max_len)) for s, e in merged if e - s >= min_len]
    moments.sort(key=lambda m: m[1] - m[0], reverse=True)
    moments = moments[:max_moments]
    moments.sort()
    return moments


def zoompan_filter(moments: list[tuple[float, float]], tw: int, th: int,
                   fps: int = 30) -> str | None:
    """zoompan chain for a slow punch-in (1.00 -> 1.08, 0.5s ease in/out)
    over each moment. ``in`` is the input frame number, so in/fps is
    clip time — the render chain runs fps=30 before this filter, so
    that conversion is exact. None when there are no moments."""
    if not moments:
        return None
    envs = []
    for a, b in moments:
        envs.append(
            f"(clip((in/{fps}-{a:.3f})/0.5,0,1)*clip(({b:.3f}-in/{fps})/0.5,0,1))")
    env = envs[0]
    for extra in envs[1:]:
        env = f"max({env},{extra})"
    return (f"zoompan=z='1+0.08*{env}':x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':d=1:s={tw}x{th}:fps={fps}")


# ---------------------------------------------------------------------------
# Beat sync (Batch 3, 2026-11-25)
# ---------------------------------------------------------------------------
# Beats come from the SAME per-second RMS profile the selector and the
# auto-zoom already use — no new dependency, no new analysis pass. A
# beat is an onset second: the RMS jumps by >= 25% of the profile peak
# against the previous second AND reaches >= 60% of the peak. The beat
# time is the centre of the onset second (i + 0.5) — the profile is
# per-second, so a beat is only known to the nearest second and every
# snap below is honest about that resolution. Flat audio (no rise
# anywhere, or a peak so small it is noise) yields no beats at all and
# the job falls back to the unsynced behaviour with a note.
# ---------------------------------------------------------------------------

#: A beat must clear this absolute RMS rise too, so near-silent noise
#: on a flat profile cannot manufacture "beats".
BEAT_MIN_RISE = 0.05
#: Snap window: a moment/window boundary only moves when a beat is
#: this close (seconds). The shift is always uniform (start and end
#: move together), so a duration promise is never broken to chase a beat.
BEAT_SNAP_WINDOW = 0.5


def detect_beats(energy_profile: list[float]) -> list[float]:
    """Onset times (seconds) from the per-second RMS profile.

    [] when the profile is empty, flat, or silent — the caller treats
    that as "no clear beat" and does not sync anything.
    """
    if not energy_profile:
        return []
    peak = max(energy_profile)
    if peak <= 0:
        return []
    rise_needed = max(0.25 * peak, BEAT_MIN_RISE)
    beats: list[float] = []
    for i in range(1, len(energy_profile)):
        v, prev = energy_profile[i], energy_profile[i - 1]
        if v >= 0.6 * peak and v - prev >= rise_needed:
            beats.append(i + 0.5)
    return beats


def _nearest_beat(t: float, beats: list[float],
                  max_shift: float = BEAT_SNAP_WINDOW) -> float | None:
    """Nearest beat to ``t`` within ``max_shift`` seconds, else None."""
    best: float | None = None
    best_dist = max_shift + 1e-9
    for b in beats:
        dist = abs(b - t)
        if dist <= max_shift and dist < best_dist:
            best, best_dist = b, dist
    return best


def snap_zoom_moments_to_beats(
        moments: list[tuple[float, float]], beats: list[float],
        clip_start: float, clip_end: float) -> tuple[list[tuple[float, float]], int]:
    """Snap each zoom moment's START to its nearest beat (source time).

    The moment keeps its length (end shifts by the same delta), so the
    zoompan envelope is unchanged in shape. A moment is only snapped
    when a beat lies within +/-0.5s of its start AND the shifted
    moment still sits inside [clip_start, clip_end]; otherwise it
    stays exactly where it was. Returns (moments, snapped_count).
    """
    if not beats or not moments:
        return moments, 0
    snapped: list[tuple[float, float]] = []
    count = 0
    for a, b in moments:
        beat = _nearest_beat(a, beats)
        if beat is None:
            snapped.append((a, b))
            continue
        delta = beat - a
        na, nb = a + delta, b + delta
        if na < clip_start:
            nb -= na - clip_start
            na = clip_start
        if nb > clip_end:
            na -= nb - clip_end
            nb = clip_end
        if nb - na < 0.5:
            # The clamp would have crushed the moment; keep it unsnapped.
            snapped.append((a, b))
            continue
        snapped.append((na, nb))
        count += 1
    return snapped, count


def snap_windows_to_beats(windows: list[dict], beats: list[float],
                          source_duration: float) -> int:
    """Nudge chosen clip windows so their START lands on a beat.

    Each window shifts uniformly (start and end by the same delta, so
    its duration is preserved exactly) toward the nearest beat within
    +/-0.5s of its start. A shift is refused when it would push the
    window out of [0, source_duration] or into a neighbour — the
    window keeps its original bounds instead. The window dict gains
    ``beat_shift`` (seconds, 0.0 when unsnapped) and the "beat_aligned"
    signal; the reason line notes the alignment. Returns how many
    windows were snapped. Pure function — no I/O, unit-tested.
    """
    if not beats or not windows:
        return 0
    ordered = sorted(windows, key=lambda w: w["start"])
    snapped = 0
    for idx, w in enumerate(ordered):
        beat = _nearest_beat(float(w["start"]), beats)
        if beat is None:
            w["beat_shift"] = 0.0
            continue
        delta = beat - float(w["start"])
        ns, ne = float(w["start"]) + delta, float(w["end"]) + delta
        if ns < 0.0 or ne > source_duration:
            w["beat_shift"] = 0.0
            continue
        if idx > 0 and ns < float(ordered[idx - 1]["end"]):
            w["beat_shift"] = 0.0
            continue
        if idx + 1 < len(ordered) and ne > float(ordered[idx + 1]["start"]):
            w["beat_shift"] = 0.0
            continue
        w["start"], w["end"] = round(ns, 3), round(ne, 3)
        w["duration"] = round(ne - ns, 3)
        w["beat_shift"] = round(delta, 3)
        signals = w.get("signals") or []
        if "beat_aligned" not in signals:
            signals.append("beat_aligned")
            w["signals"] = signals
        reason = w.get("reason") or ""
        if "Beat-aligned" not in reason:
            w["reason"] = reason + " Beat-aligned start."
        snapped += 1
    return snapped


def face_track_trajectory(source: Path, start: float, duration: float,
                          sw: int, sh: int, step: float = 2.0) -> list[tuple]:
    """Face-centre trajectory across the clip window, smoothed.

    Samples one frame every ``step`` seconds (at most ~45 samples),
    runs the same Haar cascade + size guard as detect_face_box, keeps
    the largest plausible face per frame, and smooths the centres with
    a 3-sample moving average. Returns [(rel_t, fx, fy, fw, fh)] with
    fractions of the source frame, or [] when fewer than 2 samples
    contain a face — the caller falls back to the static crop and says
    so. Never raises: detection failure is a fallback, not a job
    failure. Sample times are approximate (frame index * step)."""
    try:
        import cv2
    except ImportError:
        return []
    cascade, _ = _load_face_cascade()
    if cascade is None or duration <= 0:
        return []
    step = max(step, duration / 45.0)
    frames_dir = WORK_DIR / f"face_track_{uuid.uuid4().hex}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    try:
        proc = run([FFMPEG, "-y", "-v", "error",
                    "-ss", str(start), "-i", str(source),
                    "-t", str(duration),
                    "-vf", f"fps=1/{step:.6f},scale=640:-1",
                    str(frames_dir / "f_%04d.jpg")], timeout=300)
        if proc.returncode != 0:
            log.warning("face_track: frame extraction failed (ffmpeg rc=%s); "
                        "falling back to a static crop.", proc.returncode)
            return []
        frames = sorted(frames_dir.glob("f_*.jpg"))
        samples: list[tuple[float, float, float, float, float]] = []
        for i, frame_path in enumerate(frames):
            img = cv2.imread(str(frame_path))
            if img is None:
                continue
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))
            fw_px, fh_px = img.shape[1], img.shape[0]
            best = None
            for (x, y, w, h) in faces:
                w_frac, h_frac = w / fw_px, h / fh_px
                if 0.03 <= w_frac <= 0.35 and 0.03 <= h_frac <= 0.5:
                    if best is None or w * h > best[0] * best[1]:
                        best = (x, y, w, h)
            if best is None:
                continue
            x, y, w, h = best
            samples.append((i * step, (x + w / 2) / fw_px, (y + h / 2) / fh_px,
                            w / fw_px, h / fh_px))
        if len(samples) < 2:
            return []
        return _smooth_trajectory(samples)
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


def _smooth_trajectory(samples: list[tuple]) -> list[tuple]:
    """3-sample moving average over the face centres (positions only;
    sizes keep the per-sample value — a smoothed size would breathe).
    The median size is what the static layout decisions use."""
    out = []
    n = len(samples)
    for i, (t, fx, fy, fw, fh) in enumerate(samples):
        lo = max(0, i - 1)
        hi = min(n, i + 2)
        window = samples[lo:hi]
        out.append((t,
                    sum(s[1] for s in window) / len(window),
                    sum(s[2] for s in window) / len(window),
                    fw, fh))
    return out


def _pan_expr(samples: list[tuple], axis: int) -> str:
    """ffmpeg expression for the face fraction (axis 0 = x, 1 = y) at
    time t, linearly interpolated between trajectory samples, held
    outside the sampled range."""
    vals = [(s[0], s[1 + axis]) for s in samples]
    if len(vals) == 1:
        return f"{vals[0][1]:.4f}"
    expr = f"{vals[-1][1]:.4f}"
    for i in range(len(vals) - 2, -1, -1):
        t0, f0 = vals[i]
        t1, f1 = vals[i + 1]
        span = max(t1 - t0, 0.001)
        seg = f"({f0:.4f}+({f1:.4f}-{f0:.4f})*(t-{t0:.3f})/{span:.3f})"
        expr = f"if(lt(t,{t1:.3f}),{seg},{expr})"
    t_first, f_first = vals[0]
    return f"if(lt(t,{t_first:.3f}),{f_first:.4f},{expr})"


def _tracked_crop(sw: int, sh: int, tw: int, th: int,
                  face_track: list[tuple]) -> str:
    """Crop-to-cover filter following the face trajectory (Batch 1).
    Same cover geometry as _center_crop_filter, but the crop offset is
    a time-varying expression from the trajectory instead of a fixed
    centre. Includes the scale to the target size, like
    _center_crop_filter — without it the clip would come out at crop
    size whenever auto-zoom (whose zoompan also scales) is off."""
    src_ar = sw / sh if sh else 16 / 9
    target_ar = tw / th
    if src_ar > target_ar:
        cw = f"ih*{target_ar:.6f}"
        x = f"min(max({_pan_expr(face_track, 0)}*iw-({cw})/2,0),iw-({cw}))"
        # The x expression holds commas (nested if()/min()/max()) so it
        # MUST be single-quoted: unquoted, ffmpeg's filtergraph parser
        # splits it into separate filters ("No such filter: '0.000)'").
        return f"crop={cw}:ih:'{x}':0,scale={tw}:{th}"
    ch = f"iw/{target_ar:.6f}"
    y = f"min(max({_pan_expr(face_track, 1)}*ih-({ch})/2,0),ih-({ch}))"
    return f"crop=iw:{ch}:0:'{y}',scale={tw}:{th}"


def _tracked_inset_crop(box, sw: int, sh: int, face_track: list[tuple]) -> str | None:
    """Facecam inset crop following the trajectory: same inset size as
    _facecam_inset_crop (from the median face), but the inset window
    moves with the face instead of sitting on the median position."""
    if box is None:
        return None
    fx, fy, fw, fh = box
    top_w = int(min(sw, max(fw * sw * 3.0, sw * 0.25)))
    top_h_src = int(top_w * 0.8)
    x = f"min(max({_pan_expr(face_track, 0)}*iw-{top_w}/2,0),iw-{top_w})"
    y = f"min(max({_pan_expr(face_track, 1)}*ih-{top_h_src}*0.45,0),ih-{top_h_src})"
    # Same quoting rule as _tracked_crop: the if()/min()/max()
    # expressions hold commas, so both offsets are single-quoted.
    return f"crop={top_w}:{top_h_src}:'{x}':'{y}'"


def _median_face_box(face_track: list[tuple]) -> tuple[float, float, float, float]:
    """Median (fx, fy, fw, fh) of a trajectory — the static layout
    decisions (inset size, the split bottom-shift rule) use it."""
    def _median(vals: list[float]) -> float:
        vals = sorted(vals)
        return vals[len(vals) // 2]
    return (_median([s[1] for s in face_track]),
            _median([s[2] for s in face_track]),
            _median([s[3] for s in face_track]),
            _median([s[4] for s in face_track]))


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
                        face_box=_DETECT_FACE, face_track=None,
                        face_tracking=False) -> list[str]:
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
    Batch 1 face tracking: when ``face_tracking`` is on and
    ``face_track`` holds a trajectory, the crops that centre on the
    subject follow it over time instead of sitting on the median box
    (split top inset, pip base, streamer_full inset, centre crop).
    blur_fill has no crop to track — it is unaffected. When tracking is
    on but no trajectory exists, the static behaviour below is used
    unchanged and the caller reports the fallback.
    """
    layout = (layout or "center_crop").lower()
    box = None
    tracked = bool(face_tracking) and bool(face_track)
    if layout in ("split", "pip_facecam", "streamer_full") and ratio == "9:16":
        if tracked:
            # Median face from the trajectory — the static decisions
            # (inset size, the split bottom-shift rule) use it; the
            # crops themselves follow the trajectory.
            box = _median_face_box(face_track)
        else:
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
            top_crop = (_tracked_inset_crop(box, sw, sh, face_track)
                        if tracked else _facecam_inset_crop(box, sw, sh))
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
        face_crop = (_tracked_inset_crop(box, sw, sh, face_track)
                     if tracked else _facecam_inset_crop(box, sw, sh))
        if face_crop is None:
            log.warning("pip_facecam: no face detected in this clip window; "
                        "falling back to centre crop.")
            return [f"[0:v]{_center_crop_filter(sw, sh, tw, th)}[v0]"]
        base_crop = (_tracked_crop(sw, sh, tw, th, face_track)
                     if tracked else _center_crop_filter(sw, sh, tw, th))
        return [f"[0:v]split=2[base][face];"
                f"[base]{base_crop}[bg];"
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
        top_crop = (_tracked_inset_crop(box, sw, sh, face_track)
                    if tracked else _facecam_inset_crop(box, sw, sh))
        if top_crop is None:
            log.info("streamer_full: no face detected in this clip window; "
                     "using the top 45% of the frame.")
            top_crop = "crop=iw:ih*0.45:0:0"
        return [f"[0:v]{top_crop},scale={tw}:{th}:"
                f"force_original_aspect_ratio=increase,crop={tw}:{th}[v0]"]

    # Centre crop (crop-to-cover for the requested ratio), no stretch.
    # With face tracking on, the crop follows the trajectory.
    centre = (_tracked_crop(sw, sh, tw, th, face_track)
              if tracked else _center_crop_filter(sw, sh, tw, th))
    return [f"[0:v]{centre}[v0]"]


def render_clip(source: Path, clip: dict, settings: dict,
                segments: list[dict], out_path: Path,
                source_info: dict, job_dir: Path) -> Path:
    """Render one clip with FFmpeg. Returns out_path. Raises on failure.

    Batch 1 enhancements (all default ON; see _feature_on):
    - silence/filler removal: the window is cleaned first (trim+concat
      pre-pass) and the transcript is re-mapped onto the cleaned
      timeline, so captions are built on the cleaned timeline. When the
      cleaned clip would break the duration promise it renders
      uncleaned instead, and the skip is recorded in the stats.
    - auto-zoom: a zoompan punch-in over the high-energy moments
      stashed on the clip dict by process_job (source times; re-mapped
      through any cuts here), applied after the layout so captions
      stay crisp.
    - face tracking: the layout crops follow the smoothed face
      trajectory sampled from the render source.
    Per-clip stats are stashed on ``clip["_batch1_stats"]`` for the job
    note. With all four flags OFF the filter graph is built exactly as
    before.
    """
    ratio = settings.get("aspect_ratio", "9:16")
    tw, th = RATIO_TARGETS.get(ratio, (1080, 1920))
    layout = (settings.get("layout") or "center_crop").lower()
    captions_on = bool(settings.get("captions_enabled", True))
    start, end = clip["start"], clip["end"]
    duration = end - start
    stats = {"silence_trimmed": 0.0, "fillers_cut": 0, "zoom_moments": 0,
             "face_tracked": False, "face_fallback": None, "cleaning_skipped": None}
    clip["_batch1_stats"] = stats

    # --- Cleaning pre-pass (silence + filler removal) ---
    # The cleaned intermediate becomes the render source; the transcript
    # is re-mapped onto its timeline before ANY caption is built.
    render_source = source
    render_start, render_end = start, end
    render_segments = segments
    render_duration = duration
    cuts: list[tuple[float, float]] = []
    do_clean = source_info["has_audio"] and (
        _feature_on(settings, "silence_removal")
        or _feature_on(settings, "filler_removal"))
    if do_clean:
        cuts, cstats = compute_clip_cuts(source, segments, start, end, settings)
        if cuts:
            cleaned_dur = duration - sum(e - s for s, e in cuts)
            if not _cleaning_keeps_duration(cleaned_dur, settings):
                stats["cleaning_skipped"] = (
                    f"cleaning would leave {cleaned_dur:.1f}s "
                    f"(target {float(settings.get('duration_seconds', 30)):.0f}s)")
                log.info("Clip %.1f-%.1fs: %s; rendering uncleaned.",
                         start, end, stats["cleaning_skipped"])
                cuts = []
            else:
                try:
                    cleaned_path = job_dir / f"clip_{uuid.uuid4().hex}_cleaned.mp4"
                    clean_clip_segment(source, start, end, cuts, cleaned_path)
                    render_source = cleaned_path
                    render_start, render_end = 0.0, cleaned_dur
                    render_duration = cleaned_dur
                    render_segments = remap_segments(segments, start, cuts)
                    stats["silence_trimmed"] = cstats.get("cut_seconds", 0.0)
                    stats["fillers_cut"] = cstats.get("fillers_cut", 0)
                    log.info("Clip %.1f-%.1fs: cleaned %.2fs -> %.2fs "
                             "(trimmed %.2fs, %d filler(s) cut).",
                             start, end, duration, cleaned_dur,
                             stats["silence_trimmed"], stats["fillers_cut"])
                except Exception as clean_exc:  # noqa: BLE001 - cleaning never fails the clip
                    log.warning("Clip %.1f-%.1fs: cleaning failed (%s); "
                                "rendering the uncleaned window.",
                                start, end, clean_exc)
                    stats["cleaning_skipped"] = f"cleaning failed ({clean_exc})"
                    cuts = []
                    render_source, render_start, render_end = source, start, end
                    render_segments = segments
                    render_duration = duration

    # The headline reads the clip window, so it gets a render-time view
    # of the clip (0-based on the cleaned timeline, source-time when
    # uncleaned) — never the pre-cleaning window on cleaned segments.
    render_clip_view = {"start": render_start, "end": render_end}

    # Caption style: the selected sample from Captions Studio (default
    # 'punchy'). 'classic' keeps the old SRT behaviour; every other style
    # is rendered as ASS (word-by-word, divider-centred) — the subtitles
    # filter renders .ass via libass, with no force_style (it would
    # override the style's own fonts and colours).
    style_id = (settings.get("caption_style") or "punchy").lower()
    if style_id not in CAPTION_STYLES:
        style_id = "punchy"
    # Batch 2: headline look + caption position (unknown values fall
    # back to the pre-Batch-2 defaults, so old jobs render as before).
    headline_style = (settings.get("headline_style") or "bold_bar")
    if headline_style not in HEADLINE_STYLES:
        headline_style = "bold_bar"
    caption_position = (settings.get("caption_position") or "bottom")
    if caption_position not in CAPTION_POSITIONS:
        caption_position = "bottom"
    # Batch 6: caption safe zone (default ON — a missing key means ON,
    # like the Batch 1 enhancements, so jobs made before it get the
    # safer captions too; OFF restores the old full-width captions).
    caption_safe_zone = settings.get("caption_safe_zone", True)
    if not isinstance(caption_safe_zone, bool):
        caption_safe_zone = str(caption_safe_zone).lower() in ("true", "1", "yes")
    captions_path: Path | None = None
    captions_is_ass = False
    if captions_on:
        if style_id == "classic":
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.srt"
            if write_clip_srt(render_segments, render_start, render_end, candidate):
                captions_path = candidate
        else:
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.ass"
            divider = 864 if (layout == "split" and ratio == "9:16") else None
            if write_clip_ass(render_segments, render_start, render_end, style_id, candidate,
                              divider, tw, th, layout, caption_position, headline_style,
                              caption_safe_zone):
                captions_path = candidate
                captions_is_ass = True

    # On-screen text: a short headline burned onto the clip, derived
    # from this clip's own analysis (campaign text verbatim first,
    # else its transcript; silent windows get none — never invented).
    # It goes in its own ASS file so it works whether captions are
    # ASS, classic SRT, or off entirely.
    headline_path: Path | None = None
    if bool(settings.get("on_screen_text", False)):
        headline = derive_on_screen_text(render_clip_view, render_segments, settings)
        if headline:
            log.info("Clip %.1f-%.1fs on-screen headline: %r (style %s)",
                     start, end, headline, headline_style)
            candidate = job_dir / f"clip_{uuid.uuid4().hex}_headline.ass"
            if write_headline_ass(headline, render_duration, candidate, tw, th,
                                  headline_style):
                headline_path = candidate
        else:
            log.info("Clip %.1f-%.1fs: on-screen text on, but no headline "
                     "could be derived (no campaign text, no transcript) — "
                     "no headline burned.", start, end)

    sw, sh = source_info["width"], source_info["height"]

    # --- Face tracking: sample the trajectory from the render source
    # (cleaned file when cleaning ran, else the original source at the
    # window offset), then hand it to the layout chains.
    face_track: list[tuple] = []
    do_track = _feature_on(settings, "face_tracking")
    if do_track:
        if layout == "blur_fill" and ratio == "9:16":
            # blur_fill has no crop to track — honest no-op, not faked.
            stats["face_fallback"] = (
                "face tracking does not apply to the blurred-background layout")
        else:
            face_track = face_track_trajectory(
                render_source, render_start, render_duration, sw, sh)
            if face_track:
                stats["face_tracked"] = True
                log.info("Clip %.1f-%.1fs: face tracking on (%d samples).",
                         start, end, len(face_track))
            else:
                stats["face_fallback"] = (
                    "no face found in this clip — centre crop used")
                log.info("Clip %.1f-%.1fs: face tracking on, but no face "
                         "found; using the static crop.", start, end)

    # Build the filter graph as a list of "; "-joined filter chains.
    chains = build_layout_chains(render_source, sw, sh, tw, th, ratio, layout,
                                 render_start, render_duration,
                                 face_track=face_track or None,
                                 face_tracking=do_track)

    video_label = "[v0]"
    # --- Auto-zoom: punch in over the high-energy moments (stashed by
    # process_job in source time; re-mapped through any cuts). Applied
    # after the layout and before the captions, so the text never zooms.
    # fps=30 runs here so in/30 is exact clip time in the zoompan
    # expression; the final chain then only sets the pixel format.
    fps_applied = False
    if _feature_on(settings, "auto_zoom"):
        moments = clip.get("_zoom_moments") or []
        render_moments = remap_spans(moments, start, cuts) if moments else []
        zoom_filter = zoompan_filter(render_moments, tw, th)
        if zoom_filter:
            stats["zoom_moments"] = len(render_moments)
            chains.append(f"{video_label}fps=30,{zoom_filter}[vz]")
            video_label = "[vz]"
            fps_applied = True
            log.info("Clip %.1f-%.1fs: auto-zoom punch-in over %d moment(s).",
                     start, end, len(render_moments))
    # Batch 2: mild sharpening after layout/zoom, before captions —
    # the text stays crisp because it is burned in after this.
    chains.append(f"{video_label}unsharp=5:5:0.5:5:5:0.0[vu]")
    video_label = "[vu]"
    if captions_path is not None:
        if captions_is_ass:
            chains.append(
                f"{video_label}subtitles={escape_ffmpeg_path(captions_path)}[v1]"
            )
        else:
            font_size = 46 if tw >= 1080 else 34
            # Batch 2: the legacy SRT path honours the caption position
            # too; "bottom" keeps the established Alignment 2 / MarginV 70.
            # (The divider is only defined on the ASS path, so it is
            # recomputed here — middle does not use it, but the helper
            # takes it for the shared signature.)
            srt_divider = 864 if (layout == "split" and ratio == "9:16") else None
            if caption_position == "top":
                srt_align, srt_mv = 8, 300
            elif caption_position == "middle":
                srt_align, srt_mv = _caption_align_mv(
                    "middle", font_size, tw, th, srt_divider, layout, headline_style)
            else:
                srt_align, srt_mv = 2, 70
            style = (
                "FontName=DejaVu Sans,FontSize=%d,PrimaryColour=&HFFFFFF,"
                "OutlineColour=&H000000,BorderStyle=1,Outline=2,Shadow=0,"
                f"Bold=1,Alignment={srt_align},MarginV={srt_mv}" % font_size
            )
            chains.append(
                f"{video_label}subtitles={escape_ffmpeg_path(captions_path)}"
                f":force_style='{style}'[v1]"
            )
        video_label = "[v1]"
    if headline_path is not None:
        # Second subtitles filter, after the captions: the headline
        # burns on top, first 4 seconds only, near the top of frame.
        next_label = "[v2]" if captions_path is not None else "[v1]"
        chains.append(
            f"{video_label}subtitles={escape_ffmpeg_path(headline_path)}{next_label}"
        )
        video_label = next_label
    chains.append(f"{video_label}{'format=yuv420p' if fps_applied else 'fps=30,format=yuv420p'}[vout]")
    filter_complex = ";".join(chains)

    cmd = [FFMPEG, "-y", "-v", "error",
           "-ss", str(render_start), "-i", str(render_source),
           "-filter_complex", filter_complex,
           "-map", "[vout]"]
    if source_info["has_audio"]:
        # Batch 2: loudness-normalised to -14 LUFS (the level TikTok /
        # Instagram expect) and AAC 192k. Single-pass loudnorm on the
        # trimmed clip; it does not change the duration.
        cmd += ["-map", "0:a"]
        cmd += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    # Batch 2: CRF 18 (was 20) with a 16 Mbps ceiling — visibly cleaner
    # on busy gameplay, same preset so render time barely moves.
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-maxrate", "16000k", "-bufsize", "32000k",
            "-movflags", "+faststart", "-t", str(render_duration), str(out_path)]
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
        # The 1e-6s epsilon is float-noise protection only: a container
        # duration of exactly target + 0.6s reads as 0.6000000000000014
        # in binary and would otherwise fail by 1.4e-15s. It is not a
        # tolerance change — one microsecond is below ffprobe precision.
        if abs(actual - target) > DURATION_TOLERANCE + 1e-6:
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


def extract_thumbnail_candidates(clip_path: Path, job_dir: Path, prefix: str,
                                 duration: float) -> list[Path]:
    """Three candidate frames for the thumbnail picker (Batch 4): at
    10%, 50% and 90% of the FINAL clip's duration (after any brand
    intro/outro, so a long intro cannot fill all three frames). A
    frame that fails to extract is skipped, never fatal — the picker
    shows however many survived (0–3).
    """
    if duration <= 0:
        return []
    candidates: list[Path] = []
    for i, frac in enumerate((0.10, 0.50, 0.90), 1):
        path = job_dir / f"{prefix}_cand{i}.jpg"
        got = extract_thumbnail(clip_path, path, at_seconds=round(duration * frac, 3))
        if got is not None:
            candidates.append(got)
    return candidates


# ---------------------------------------------------------------------------
# Brand assets (intro / outro)
# ---------------------------------------------------------------------------

def _probe_video_info(path: Path) -> dict | None:
    """ffprobe summary for one segment, or None when the file is not a
    playable video (corrupt, zero-byte, wrong format). Never raises —
    a bad brand asset is skipped, never fatal."""
    try:
        return probe_summary(path)
    except Exception:
        return None


def download_brand_assets(api: "JobApi", brand_assets: dict | None,
                          job_dir: Path) -> dict[str, Path]:
    """Download the job's intro/outro brand assets into the job workdir.

    `brand_assets` is the job payload's `brand_assets` key (absent on an
    old backend — treated as 'no brand assets', never a crash). Each
    present asset is downloaded over the Job API and verified with
    ffprobe; anything that fails to download or is not a playable video
    is logged and skipped. Returns {"intro": Path, "outro": Path} for
    the assets that survived. Download failures NEVER fail the job.

    Batch 4: the "logo" kind is an IMAGE, not a video — it is
    validated with `_probe_image_info` (a readable image, no duration
    needed) and returned under the "logo" key for `apply_logo_overlay`.
    """
    assets: dict[str, Path] = {}
    if not isinstance(brand_assets, dict):
        return assets
    for kind in ("intro", "outro", "logo"):
        asset = brand_assets.get(kind)
        if not isinstance(asset, dict):
            continue
        url = asset.get("download_url")
        if not url:
            continue
        asset_id = asset.get("id")
        suffix = f"_{asset_id}" if asset_id is not None else ""
        if kind == "logo":
            dest = job_dir / f"brand_logo{suffix}.png"
        else:
            dest = job_dir / f"brand_{kind}{suffix}.mp4"
        try:
            api.download_brand_asset(url, dest)
        except Exception as exc:  # noqa: BLE001 - a bad asset must not fail the job
            log.warning("Brand %s asset download failed; continuing "
                        "without it: %s", kind, exc)
            continue
        if kind == "logo":
            if _probe_image_info(dest) is None:
                log.warning("Brand logo asset is not a readable image; "
                            "ignoring it: %s", dest.name)
                dest.unlink(missing_ok=True)
                continue
        elif _probe_video_info(dest) is None:
            log.warning("Brand %s asset is not a playable video; "
                        "ignoring it: %s", kind, dest.name)
            dest.unlink(missing_ok=True)
            continue
        assets[kind] = dest
        log.info("Brand %s asset downloaded: %s", kind, dest.name)
    return assets


def apply_brand_assets(clip_path: Path, intro_path: Path | None = None,
                       outro_path: Path | None = None,
                       out_path: Path | None = None) -> tuple[Path, bool, bool]:
    """Concatenate [intro?] + clip + [outro?] into one branded clip.

    Every segment is normalised to the rendered clip's canvas (probe the
    clip for width/height/fps; scale + pad to match, fps filter,
    format=yuv420p) and its audio to 48kHz stereo; a segment without an
    audio stream gets a silent anullsrc track of its own duration, so a
    missing audio stream can never fail the concat. The segments are
    joined with the concat filter (n=2 or 3) and re-encoded libx264 +
    aac with the same preset/crf render_clip uses (veryfast / 18, Batch 2).

    Returns (final_path, intro_applied, outro_applied). With no usable
    brand segment the original clip_path is returned untouched — no
    ffmpeg pass at all. On ANY concat/validation failure the plain
    rendered clip is returned instead: the job never fails over
    branding, and that segment is marked not applied.
    """
    clip_path = Path(clip_path)
    clip_info = _probe_video_info(clip_path)
    if clip_info is None:
        log.warning("Cannot probe rendered clip %s; skipping brand assets.",
                    clip_path.name)
        return clip_path, False, False
    width, height = clip_info["width"], clip_info["height"]
    fps = clip_info["fps"] or 30.0
    if fps <= 0:
        fps = 30.0

    ordered: list[tuple[str, Path, dict]] = []
    has_intro = has_outro = False
    for kind, path in (("intro", intro_path), ("outro", outro_path)):
        if path is None:
            continue
        info = _probe_video_info(Path(path))
        if info is None:
            log.warning("Brand %s asset %s is not a playable video; "
                        "skipping it.", kind, Path(path).name)
            continue
        if kind == "intro":
            has_intro = True
        else:
            has_outro = True
        ordered.append((kind, Path(path), info))
    if not ordered:
        return clip_path, False, False
    # The clip sits between intro and outro in playback order
    # (ordered already holds intro first, outro second).
    ordered.insert(1 if has_intro else 0, ("clip", clip_path, clip_info))

    chains: list[str] = []
    concat_inputs: list[str] = []
    for i, (_kind, _path, info) in enumerate(ordered):
        chains.append(
            f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,"
            f"fps={fps:.2f},format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
        )
        if info["has_audio"]:
            chains.append(
                f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]"
            )
        else:
            chains.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=0:{info['duration']:.3f},asetpts=PTS-STARTPTS[a{i}]"
            )
        # The concat filter takes each segment's video THEN audio, in
        # segment order ([v0][a0][v1][a1]...) — all videos first would
        # feed a video pad into an audio input and fail to link.
        concat_inputs.append(f"[v{i}][a{i}]")
    chains.append(
        "".join(concat_inputs) +
        f"concat=n={len(ordered)}:v=1:a=1[vout][aout]"
    )

    if out_path is None:
        out_path = clip_path.with_name(clip_path.stem + "_branded.mp4")
    else:
        out_path = Path(out_path)
    cmd = [FFMPEG, "-y", "-v", "error"]
    for _kind, path, _info in ordered:
        cmd += ["-i", str(path)]
    cmd += ["-filter_complex", ";".join(chains),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(out_path)]
    try:
        proc = run(cmd, timeout=1800)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "").strip()[:300])
        out_info = _probe_video_info(out_path)
        if out_info is None:
            raise RuntimeError("concatenated clip failed ffprobe validation")
        if not out_info["has_audio"]:
            raise RuntimeError("concatenated clip has no audio stream")
        if (out_info["width"], out_info["height"]) != (width, height):
            raise RuntimeError(
                f"concatenated resolution {out_info['width']}x{out_info['height']} "
                f"!= clip canvas {width}x{height}")
        expected = sum(info["duration"] for _k, _p, info in ordered)
        if abs(out_info["duration"] - expected) > 0.5:
            raise RuntimeError(
                f"concatenated duration {out_info['duration']:.2f}s != "
                f"expected {expected:.2f}s")
    except Exception as exc:  # noqa: BLE001 - branding must never fail the job
        log.warning("Brand concat failed for %s (%s); using the plain clip.",
                    clip_path.name, exc)
        out_path.unlink(missing_ok=True)
        return clip_path, False, False
    log.info("Brand concat: %s + %s -> %s (%.2fs).",
             "intro" if has_intro else "-",
             "outro" if has_outro else "-",
             out_path.name, out_info["duration"])
    return out_path, has_intro, has_outro


def _probe_image_info(path: Path) -> dict | None:
    """ffprobe summary for one IMAGE file (PNG/JPG/WebP), or None when
    it is not a readable image. Unlike `probe_summary`, an image has
    no duration — requiring one would reject every logo — so only a
    video stream with a real width/height is required. Never raises.
    """
    try:
        info = ffprobe_json(path)
    except Exception:
        return None
    streams = info.get("streams", [])
    image = next((s for s in streams if s.get("codec_type") == "video"), None)
    if image is None:
        return None
    width, height = int(image.get("width") or 0), int(image.get("height") or 0)
    if width <= 0 or height <= 0:
        return None
    return {"width": width, "height": height}


def apply_logo_overlay(clip_path: Path, logo_path: Path,
                       out_path: Path | None = None) -> tuple[Path, bool]:
    """Overlay the Brand Kit logo on a rendered clip (Batch 4).

    The logo sits bottom-right, scaled to ~12% of the clip width with
    a small margin, at 85% opacity — applied to the FINAL clip (after
    any brand intro/outro concat), so it covers the whole clip. The
    video is re-encoded libx264 veryfast / CRF 18 (the render
    settings); the audio stream is copied untouched.

    Returns (final_path, applied). On ANY failure the original clip
    is returned untouched with applied=False — a bad logo never fails
    the job, and the job note only claims the overlay when it really
    happened.
    """
    clip_path, logo_path = Path(clip_path), Path(logo_path)
    clip_info = _probe_video_info(clip_path)
    logo_info = _probe_image_info(logo_path)
    if clip_info is None or logo_info is None:
        log.warning("Logo overlay skipped: %s.",
                    "clip is not a playable video" if clip_info is None
                    else "logo is not a readable image")
        return clip_path, False
    width, height = clip_info["width"], clip_info["height"]
    logo_w = max(48, int(width * 0.12))
    margin = max(12, int(width * 0.022))
    if out_path is None:
        out_path = clip_path.with_name(clip_path.stem + "_logo.mp4")
    else:
        out_path = Path(out_path)
    # scale the logo to 12% of the clip width (height follows the
    # aspect ratio), fade it to 85% opacity, and pin it bottom-right.
    filt = (f"[1:v]scale={logo_w}:-1,format=rgba,"
            f"colorchannelmixer=aa=0.85[logo];"
            f"[0:v][logo]overlay=W-w-{margin}:H-h-{margin}:format=yuv420[vout]")
    cmd = [FFMPEG, "-y", "-v", "error",
           "-i", str(clip_path), "-i", str(logo_path),
           "-filter_complex", filt,
           "-map", "[vout]", "-map", "0:a?",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
           "-c:a", "copy", "-movflags", "+faststart", str(out_path)]
    try:
        proc = run(cmd, timeout=1800)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "").strip()[:300])
        out_info = _probe_video_info(out_path)
        if out_info is None:
            raise RuntimeError("logo-overlay output failed ffprobe validation")
        if (out_info["width"], out_info["height"]) != (width, height):
            raise RuntimeError(
                f"logo-overlay resolution {out_info['width']}x{out_info['height']} "
                f"!= clip canvas {width}x{height}")
        if abs(out_info["duration"] - clip_info["duration"]) > 0.5:
            raise RuntimeError(
                f"logo-overlay duration {out_info['duration']:.2f}s != "
                f"clip duration {clip_info['duration']:.2f}s")
    except Exception as exc:  # noqa: BLE001 - a bad logo never fails the job
        log.warning("Logo overlay failed for %s (%s); using the plain clip.",
                    clip_path.name, exc)
        out_path.unlink(missing_ok=True)
        return clip_path, False
    log.info("Logo overlay: %s -> %s (logo %dpx wide, bottom-right).",
             clip_path.name, out_path.name, logo_w)
    return out_path, True


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


def _ready_note(clips: list[dict], requested: int, failed: list[str],
                rendered: list[dict] | None = None,
                extra: list[str] | None = None) -> str | None:
    """The note the job page shows when a job finishes Ready but the
    result is not the full request: fewer clips than asked for (speech
    was scarce, visual moments may have filled some slots), or some
    clips failed to render and were skipped. Returns None when the job
    delivered exactly what was asked with no failures.

    Batch 1: when ``rendered`` (the clips that actually uploaded) is
    given, the note also reports the enhancements honestly — seconds of
    silence trimmed, fillers cut, zoom/face-tracking counts, and any
    fallback or skip — from the per-clip stats render_clip stashed.
    Batch 3: ``extra`` carries pre-built honest lines the caller adds
    (beat sync, caption translation, multi-ratio export); they are
    appended verbatim, so a job with nothing to report still gets None.
    """
    notes: list[str] = []
    if len(clips) < requested:
        visual = sum(1 for c in clips if "visual_moment" in (c.get("signals") or []))
        any_part = sum(1 for c in clips if "any_part" in (c.get("signals") or []))
        if visual or any_part:
            filled: list[str] = []
            if visual:
                filled.append(f"{visual} visual moment(s) (loudest audio peaks)")
            if any_part:
                filled.append(
                    f"{any_part} any-part window(s) (any part of the video, "
                    f"not a highlight)")
            notes.append(
                f"Only {len(clips)} of {requested} requested clips could be "
                f"selected from speech; {' and '.join(filled)} filled some "
                f"slots because the source has very little speech and is too "
                f"short for the full count.")
        else:
            notes.append(
                f"Only {len(clips)} of {requested} requested clips could be "
                f"selected from the source.")
    if failed:
        notes.append(
            f"{len(failed)} clip(s) failed to render and were skipped: "
            + "; ".join(failed[:3]))
    if rendered:
        def _stats(c: dict) -> dict:
            return c.get("_batch1_stats") or {}
        trimmed = sum(_stats(c).get("silence_trimmed", 0.0) for c in rendered)
        fillers = sum(_stats(c).get("fillers_cut", 0) for c in rendered)
        zoomed = sum(1 for c in rendered if _stats(c).get("zoom_moments", 0))
        tracked = sum(1 for c in rendered if _stats(c).get("face_tracked"))
        fallbacks = sorted({_stats(c).get("face_fallback")
                            for c in rendered} - {None})
        skipped = sorted({_stats(c).get("cleaning_skipped")
                          for c in rendered} - {None})
        if trimmed > 0 or fillers > 0:
            bits = []
            if trimmed > 0:
                bits.append(f"trimmed {trimmed:.1f}s of silence")
            if fillers > 0:
                bits.append(f"cut {fillers} filler word(s)")
            notes.append("Enhancements: " + " and ".join(bits) + ".")
        if zoomed:
            notes.append(f"Auto-zoom punch-in applied to {zoomed} clip(s).")
        if tracked:
            notes.append(
                f"Face tracking followed the speaker in {tracked} clip(s).")
        if fallbacks:
            notes.append("Face tracking fallback: " + "; ".join(fallbacks) + ".")
        if skipped:
            notes.append(
                "Silence/filler removal skipped for a clip: "
                + "; ".join(skipped) + ".")
    if extra:
        notes.extend(extra)
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
        # The parent job's brand assets ride along on a re-render too:
        # a re-rendered clip keeps the job's intro/outro.
        brand = download_brand_assets(api, job.get("brand_assets"), job_dir)
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
            # Batch 3: the re-render keeps the job's caption translation
            # (same fallback rule as a fresh job — never fails the clip).
            target_lang = (settings.get("caption_translation") or "none").lower()
            if target_lang in TRANSLATION_TARGETS:
                segments, _translation_info = translate_segments(
                    segments, target_lang,
                    source_language=(settings.get("captions_language") or "auto"))
            # Batch 1: the re-render keeps the job's enhancements — the
            # auto-zoom moments come from this clip's own audio energy.
            # (Silence/filler cleaning is computed inside render_clip
            # for the fixed window; it renders uncleaned rather than
            # breaking the clip's duration.)
            if _feature_on(settings, "auto_zoom"):
                energy = wav_rms_profile(wav_path)
                if energy:
                    moments = zoom_moments(
                        energy, clip["start"], clip["end"])
                    # Batch 3: snap the zoom moments to beats, as a
                    # fresh job does.
                    if _feature_on(settings, "beat_sync"):
                        beats = detect_beats(energy)
                        if beats:
                            moments, _n = snap_zoom_moments_to_beats(
                                moments, beats, clip["start"], clip["end"])
                    clip["_zoom_moments"] = moments
        out_path = job_dir / "clip.mp4"
        render_clip(source, clip, settings, segments, out_path,
                    source_info, job_dir)
        info = validate_clip(out_path, {"settings": settings}, source_info)
        rerender_intro_ok = False
        if brand:
            # Same concat as a fresh render; on any failure the plain
            # re-rendered clip is uploaded instead — never a failure.
            final_path, _intro_ok, _outro_ok = apply_brand_assets(
                out_path, brand.get("intro"), brand.get("outro"),
                job_dir / "clip_branded.mp4")
            if final_path != out_path:
                info = probe_summary(final_path)
                out_path = final_path
                rerender_intro_ok = _intro_ok
        # Batch 4: the re-rendered clip keeps the job's logo overlay
        # (same rule as a fresh render — OFF unless the job asked for
        # it, and a failure keeps the plain re-render).
        if settings.get("logo_overlay") and brand.get("logo"):
            final_path, _logo_ok = apply_logo_overlay(
                out_path, brand["logo"], job_dir / "clip_logo.mp4")
            if final_path != out_path:
                info = probe_summary(final_path)
                out_path = final_path
        # Thumbnail: see process_job — skip past a stitched-on intro.
        thumb_at = 1.0
        if rerender_intro_ok and "intro" in brand:
            intro_info = _probe_video_info(brand["intro"])
            if intro_info is not None:
                thumb_at = intro_info["duration"] + 1.0
        thumb = extract_thumbnail(out_path, job_dir / "thumb.jpg",
                                  at_seconds=thumb_at)
        # Batch 4: fresh thumbnail-picker candidates for the new file.
        cands = extract_thumbnail_candidates(out_path, job_dir,
                                             "rerender_cand", info["duration"])
        api.upload_replacement_clip(clip_id, out_path, rerender_id,
                                    thumbnail=thumb,
                                    duration_seconds=info["duration"],
                                    candidates=cands)
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
        # Brand assets (intro/outro) come with the job payload; absent
        # on an old backend. A failed download never fails the job —
        # download_brand_assets logs and skips.
        brand = download_brand_assets(api, job.get("brand_assets"), job_dir)
        used_brand_assets = bool(brand)
        intro_applied = outro_applied = False
        logo_applied = False
        if used_brand_assets:
            log.info("Job %s brand assets: %s", job_id, sorted(brand))

        api.set_status(job_id, "Processing", stage="transcribing", progress=20)
        wav_path = job_dir / "audio_16k.wav"
        # Batch 3: translation info for the job note (None when the job
        # does not ask for a translation, or has no audio to translate).
        translation_info: dict | None = None
        # Batch 4: title + hashtag suggestions (None/[] when the job
        # has no audio to derive them from).
        title_suggestion: str | None = None
        hashtag_list: list[str] = []
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
            # Batch 3: captions auto-translate, BEFORE selection — the
            # windows, scores, headlines and captions all use the
            # translated text. A failed translation never fails the
            # job: the segment keeps its original text (see
            # translate_segments) and the note says so.
            target_lang = (settings.get("caption_translation") or "none").lower()
            if target_lang in TRANSLATION_TARGETS:
                segments, translation_info = translate_segments(
                    segments, target_lang,
                    source_language=(settings.get("captions_language") or "auto"))
                log.info("Job %s translation to %s: %s (%d translated, %d fell back).",
                         job_id, target_lang, translation_info["status"],
                         translation_info["translated"], translation_info["failed"])
            # Batch 4: title + hashtag suggestions from the FINAL
            # (possibly translated) transcript — the same words the
            # captions and headline use. A silent job gets none.
            title_suggestion, hashtag_list = derive_title_hashtags(
                segments, source_info["duration"])
            if title_suggestion:
                log.info("Job %s title suggestion: %r (%d hashtag(s)).",
                         job_id, title_suggestion, len(hashtag_list))
        else:
            segments, energy = [], []
            log.info("Source has no audio track; skipping transcription.")

        api.set_status(job_id, "Processing", stage="selecting_clips", progress=45)
        _throw_if_cancelled(api, job_id)
        # Batch 3 multi-ratio: the SAME windows render once per ratio,
        # so the window count is capped by the 50-clip total limit
        # (e.g. 3 ratios -> at most 16 windows). The cap is reported
        # in the job note; the selector is asked for the capped count.
        ratios = export_ratios(settings)
        requested = int(settings.get("clip_count", 3))
        windows_requested = windows_per_ratio(requested, ratios)
        capped_for_ratios = windows_requested < requested
        face_prof = face_profile(source, source_info["duration"])
        clips = select_highlights(segments, source_info["duration"],
                                  dict(settings, clip_count=windows_requested),
                                  energy, face_prof)
        if len(clips) < windows_requested:
            log.warning("Job %s: only %d of %d requested clips could be "
                        "selected from the source; proceeding with %d.",
                        job_id, len(clips), windows_requested, len(clips))
        log.info("Selected %d clip window(s) for job %s.", len(clips), job_id)
        for clip in clips:
            if "low_audio_coverage" in (clip.get("signals") or []):
                log.warning(
                    "Job %s: selected clip %.1f-%.1fs has only %.0f%% "
                    "transcribed-speech coverage (mostly silent) — used "
                    "only because no better-covered window exists.",
                    job_id, clip["start"], clip["end"],
                    clip.get("coverage", 0.0) * 100)

        # Batch 1: silence/filler cleaning shortens a clip, so extend
        # each window first (into neighbouring source) until the cleaned
        # clip still meets its duration promise. A window that cannot be
        # extended far enough keeps its original bounds and renders
        # uncleaned instead of failing.
        if source_info["has_audio"] and (
                _feature_on(settings, "silence_removal")
                or _feature_on(settings, "filler_removal")):
            for clip in clips:
                ns, ne, _cuts, _cstats = _extend_window_for_cleaning(
                    source, segments, clip["start"], clip["end"], settings,
                    source_info["duration"])
                if _cuts and (ns, ne) != (clip["start"], clip["end"]):
                    log.info("Job %s: clip window %.1f-%.1fs extended to "
                             "%.1f-%.1fs so silence/filler cleaning keeps "
                             "the duration promise.", job_id, clip["start"],
                             clip["end"], ns, ne)
                    clip["start"], clip["end"] = ns, ne
                    clip["duration"] = round(ne - ns, 3)

        # Batch 3: beat sync — detect beats from the RMS profile and
        # snap each chosen window's start to the nearest beat (uniform
        # shift, so the duration promise is untouched). Runs AFTER the
        # cleaning extension above, so the snapped bounds are the final
        # ones. A window that cannot shift without leaving the source
        # or overlapping a neighbour keeps its original bounds.
        beat_on = _feature_on(settings, "beat_sync")
        beats: list[float] = []
        windows_snapped = 0
        if beat_on and energy:
            beats = detect_beats(energy)
            if beats:
                windows_snapped = snap_windows_to_beats(
                    clips, beats, source_info["duration"])
                log.info("Job %s beat sync: %d beat(s) detected, %d of %d "
                         "window starts aligned.",
                         job_id, len(beats), windows_snapped, len(clips))
            else:
                log.info("Job %s beat sync: no clear beat in this audio; "
                         "clips cut as usual.", job_id)

        # Batch 1: high-energy moments for the auto-zoom punch-in, from
        # the same RMS profile the selector already uses. Stashed on the
        # clip dict in source time; render_clip re-maps them through any
        # silence/filler cuts. Batch 3: each moment's start snaps to its
        # nearest beat when one is within +/-0.5s.
        zoom_snapped = 0
        zoom_total = 0
        if _feature_on(settings, "auto_zoom") and energy:
            for clip in clips:
                moments = zoom_moments(
                    energy, clip["start"], clip["end"])
                snapped_n = 0
                if beats:
                    moments, snapped_n = snap_zoom_moments_to_beats(
                        moments, beats, clip["start"], clip["end"])
                clip["_zoom_moments"] = moments
                zoom_snapped += snapped_n
                zoom_total += len(moments)
            if beats:
                log.info("Job %s beat sync: %d of %d zoom moment(s) snapped "
                         "to beats.", job_id, zoom_snapped, zoom_total)

        api.set_status(job_id, "Processing", stage="rendering", progress=60)
        # Batch 3 multi-ratio: the SAME windows render once per ratio.
        # Each ratio gets its OWN clip row (own aspect_ratio, thumbnail
        # and download) sharing the window's score and transcript. The
        # layouts are 9:16-first: build_layout_chains falls back to a
        # centre crop for 1:1 / 16:9 (documented there), and the brand
        # concat normalises to the clip canvas per ratio. A per-ratio
        # COPY of the clip dict is rendered, so the per-clip stats
        # render_clip stashes never collide between ratios.
        rendered: list[tuple[Path, dict, dict, Path | None, str, int]] = []
        failed: list[str] = []
        total_renders = max(1, len(clips) * len(ratios))
        render_n = 0
        for ratio in ratios:
            ratio_settings = dict(settings)
            ratio_settings["aspect_ratio"] = ratio
            slug = ratio.replace(":", "x")
            for i, clip in enumerate(clips, 1):
                render_n += 1
                _throw_if_cancelled(api, job_id)
                clip_r = dict(clip)
                out_path = job_dir / f"clip_{i:02d}_{slug}.mp4"
                try:
                    render_clip(source, clip_r, ratio_settings, segments, out_path,
                                source_info, job_dir)
                    info = validate_clip(out_path, {"settings": ratio_settings}, source_info)
                    clip_intro_ok = False
                    if brand:
                        # Brand the clip: [intro?] + clip + [outro?]. Any
                        # concat failure falls back to the plain clip
                        # (apply_brand_assets never raises); the uploaded
                        # duration then comes from the branded file.
                        try:
                            branded_path = job_dir / f"clip_{i:02d}_{slug}_branded.mp4"
                            final_path, intro_ok, outro_ok = apply_brand_assets(
                                out_path, brand.get("intro"), brand.get("outro"),
                                branded_path)
                            if final_path != out_path:
                                info = probe_summary(final_path)
                                intro_applied = intro_applied or intro_ok
                                outro_applied = outro_applied or outro_ok
                                out_path = final_path
                                clip_intro_ok = intro_ok
                        except Exception as brand_exc:  # noqa: BLE001 - branding never fails the clip
                            log.warning("Job %s: clip %d (%s) branding failed (%s); "
                                        "uploading the plain clip.",
                                        job_id, i, ratio, brand_exc)
                    # Batch 4: logo overlay (default OFF) — after the
                    # brand concat so it sits on the whole final clip,
                    # and before the thumbnail so the thumbnail shows it.
                    # Any failure keeps the plain clip; never fatal.
                    if settings.get("logo_overlay") and brand.get("logo"):
                        try:
                            logo_out = job_dir / f"clip_{i:02d}_{slug}_logo.mp4"
                            final_path, logo_ok = apply_logo_overlay(
                                out_path, brand["logo"], logo_out)
                            if logo_ok:
                                info = probe_summary(final_path)
                                out_path = final_path
                                logo_applied = True
                        except Exception as logo_exc:  # noqa: BLE001 - logo never fails the clip
                            log.warning("Job %s: clip %d (%s) logo overlay failed (%s); "
                                        "uploading without the logo.",
                                        job_id, i, ratio, logo_exc)
                    # Thumbnail: a branded clip opens with its intro, so a
                    # frame at 1.0s would show the intro card, not the clip.
                    # Take the frame just after the intro instead.
                    thumb_at = 1.0
                    if clip_intro_ok and "intro" in brand:
                        intro_info = _probe_video_info(brand["intro"])
                        if intro_info is not None:
                            thumb_at = intro_info["duration"] + 1.0
                    thumb = extract_thumbnail(out_path, job_dir / f"thumb_{i:02d}_{slug}.jpg",
                                              at_seconds=thumb_at)
                    # Batch 4: thumbnail-picker candidates from the
                    # FINAL clip (after branding + logo overlay).
                    cands = extract_thumbnail_candidates(
                        out_path, job_dir, f"cand_{i:02d}_{slug}", info["duration"])
                except Exception as clip_exc:  # noqa: BLE001 - one bad clip must not kill the job
                    # Per-clip failure isolation: log the failure, drop the
                    # partial file, and keep rendering the rest. Only when
                    # EVERY clip fails does the job fail (below).
                    reason = str(clip_exc)[:300]
                    log.error("Job %s: clip %d (%s, %.1f-%.1fs) failed: %s; skipping it.",
                              job_id, i, ratio, clip["start"], clip["end"], reason)
                    failed.append(
                        f"Clip {i}" + (f" ({ratio})" if len(ratios) > 1 else "") +
                        f" ({clip['start']:.1f}–{clip['end']:.1f}s): {reason}")
                    if out_path.exists():
                        out_path.unlink(missing_ok=True)
                    continue
                log.info("Clip %d/%d (%s) validated: %.2fs %dx%d %d bytes.",
                         render_n, total_renders, ratio, info["duration"], info["width"],
                         info["height"], info["size_bytes"])
                rendered.append((out_path, clip_r, info, thumb, ratio, i, cands))
                api.set_status(job_id, "Processing", stage="rendering",
                               progress=60 + int(25 * render_n / total_renders))
        if clips and not rendered:
            raise RuntimeError(
                "Every clip failed to render: " + "; ".join(failed[:3]))

        api.set_status(job_id, "Processing", stage="uploading_clips", progress=90)
        for n, (out_path, clip, info, thumb, ratio, i, cands) in enumerate(rendered, 1):
            clip_fields = {
                # In a multi-ratio job the title carries the ratio so the
                # variants are distinguishable in the Library; a
                # single-ratio job keeps the plain "Clip N" title.
                "title": f"Clip {i}" + (f" ({ratio})" if len(ratios) > 1 else ""),
                "aspect_ratio": ratio,
                "start_seconds": clip["start"],
                "end_seconds": clip["end"],
                "duration_seconds": info["duration"],
                "score": clip.get("score", 0),
                "reason": clip.get("reason", ""),
                "transcript_excerpt": clip.get("text", ""),
                "caption_style": (settings.get("caption_style") or "punchy"),
            }
            # The selector attaches a score_breakdown to every window;
            # a window with none (defensive — none exists today) sends
            # no field rather than an empty object.
            if clip.get("score_breakdown"):
                clip_fields["score_breakdown"] = clip["score_breakdown"]
            api.upload_clip(job_id, out_path, clip_fields, thumbnail=thumb,
                            candidates=cands)
            log.info("Uploaded clip %d/%d for job %s.", n, len(rendered), job_id)

        # Batch 3 job-note lines: beat sync, translation, multi-ratio.
        # Built here from what actually happened — never claimed in
        # advance, and absent entirely when the feature was off.
        extra_notes: list[str] = []
        if beat_on:
            if beats:
                beat_bits = []
                if zoom_total:
                    beat_bits.append(
                        f"{zoom_snapped} of {zoom_total} zoom moment(s) "
                        f"snapped to beats")
                beat_bits.append(
                    f"{windows_snapped} of {len(clips)} clip start(s) "
                    f"aligned to beats")
                extra_notes.append("Beat sync: " + "; ".join(beat_bits) + ".")
            else:
                extra_notes.append(
                    "Beat sync: no clear beat in this audio — clips cut as usual.")
        if translation_info is not None:
            t_status = translation_info["status"]
            t_lang = TRANSLATION_TARGETS[translation_info["target"]]
            if t_status == "ok":
                extra_notes.append(f"Captions translated to {t_lang}.")
            elif t_status == "partial":
                extra_notes.append(
                    f"Captions translated to {t_lang} where possible — "
                    f"{translation_info['failed']} segment(s) in the "
                    f"original language.")
            elif t_status == "unavailable":
                extra_notes.append(
                    "Translation unavailable — captions in the original language.")
            # "same" (already in the target language): nothing to report.
        if len(ratios) > 1:
            extra_notes.append(
                f"Exported in {len(ratios)} ratios — "
                f"{', '.join(ratios)} ({len(rendered)} clips total).")
            if capped_for_ratios:
                extra_notes.append(
                    f"Clip count capped at {windows_requested} windows per "
                    f"ratio (50-clip total limit).")
        # Batch 4: the logo line is claimed only when the overlay
        # actually landed on at least one clip.
        if logo_applied:
            extra_notes.append("Logo overlay applied.")

        # Brand flags ride only when the job actually used brand assets,
        # so a job without intro/outro is byte-identical to before.
        ready_kwargs: dict = {}
        if used_brand_assets:
            ready_kwargs["intro_applied"] = intro_applied
            ready_kwargs["outro_applied"] = outro_applied
        # Enhancement stats come from the primary ratio's renders only —
        # the other ratios repeat the same cuts, and counting them twice
        # would double-report the trimmed seconds.
        primary_rendered = [c for _, c, _, _, r, _, _ in rendered if r == ratios[0]]
        api.set_status(job_id, "Ready", stage="ready", progress=100,
                       note=_ready_note(clips, windows_requested, failed,
                                        rendered=primary_rendered,
                                        extra=extra_notes or None),
                       title_suggestion=title_suggestion,
                       hashtags=hashtag_list or None,
                       **ready_kwargs)
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
