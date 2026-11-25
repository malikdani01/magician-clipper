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

# Batch 13 (2026-11-25): which layouts render on which canvas.
# The six canvas-agnostic layouts adapt to any target size — their
# chains are written in terms of tw/th, never a hardcoded 9:16 frame.
# The four vertical compositions are portrait-frame designs: a
# top/bottom split, a facecam inset, a full-frame streamer crop and a
# video-over-panel stack only make sense on a portrait canvas, so
# they apply to 9:16 AND 4:5 and are excluded from 16:9 and 1:1.
# A layout that cannot apply to the ratio is never faked in the
# worker: resolve_layout() falls back to centre crop (logged) instead
# of rendering the wrong composition.
AGNOSTIC_LAYOUTS = (
    "center_crop", "blur_fill", "gradient_fill",
    "letterbox", "face_closeup", "framed",
)
PORTRAIT_LAYOUTS = ("split", "pip_facecam", "streamer_full", "stacked")
LAYOUTS_BY_RATIO = {
    "9:16": (*AGNOSTIC_LAYOUTS, *PORTRAIT_LAYOUTS),
    "4:5": (*AGNOSTIC_LAYOUTS, *PORTRAIT_LAYOUTS),
    "16:9": AGNOSTIC_LAYOUTS,
    "1:1": AGNOSTIC_LAYOUTS,
}


def allowed_layouts_for_ratio(ratio: str) -> tuple[str, ...]:
    """Layouts that genuinely render on this canvas (unknown ratio -> agnostic only)."""
    return LAYOUTS_BY_RATIO.get(ratio or "9:16", AGNOSTIC_LAYOUTS)


def resolve_layout(layout, ratio: str) -> str:
    """The layout to render: the requested one when it applies to the
    ratio, else centre crop. Never invents a composition the canvas
    cannot render."""
    layout = (layout or "center_crop").lower()
    if layout in allowed_layouts_for_ratio(ratio):
        return layout
    return "center_crop"

# Batch 3 multi-ratio export: the ratios a job renders in. Batch 13:
# one ratio in, same ratio out — the aspect ratio IS the export
# ratio; 9:16 is no longer force-included. The job's own
# aspect_ratio is always rendered even if a stale client omitted it
# from the list.
#: Hard cap on TOTAL clip rows a job may produce (all ratios together).
MAX_TOTAL_CLIPS = 50


def export_ratios(settings: dict) -> list[str]:
    """The ratios this job renders, in render order.

    The job's aspect_ratio comes first, then the requested export
    ratios in the order given. Unknown values are dropped, so a bad
    client cannot ask for a ratio with no target.
    """
    primary = (settings.get("aspect_ratio") or "9:16")
    wanted = settings.get("export_ratios") or [primary]
    if isinstance(wanted, str):
        wanted = [wanted]
    ratios: list[str] = []
    for r in [primary, *wanted]:
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


# Batch 11 export tiers: Free caps exports at 720p, paid plans at
# 1080p. The "p" number is the SHORT side of the frame (720x1280
# for 9:16, 1280x720 for 16:9). The job carries
# settings["max_export_height"], set SERVER-SIDE from the user's
# plan — never trusted from the client. A job without the setting
# (made before Batch 11) renders at full size, unchanged.
FULL_MAX_EXPORT_HEIGHT = 1080


def capped_target_size(ratio: str, max_export_height) -> tuple[int, int]:
    """Render target for a ratio under the plan's export cap.

    Both dimensions scale down together (even-rounded, so libx264
    accepts them) and the ratio stays exact. A cap at or above the
    target's short side (or a missing/invalid cap) leaves the full
    target untouched.
    """
    tw, th = RATIO_TARGETS.get(ratio, (1080, 1920))
    try:
        cap = FULL_MAX_EXPORT_HEIGHT if max_export_height is None else int(max_export_height)
    except (TypeError, ValueError):
        cap = FULL_MAX_EXPORT_HEIGHT
    short = min(tw, th)
    if cap <= 0 or cap >= short:
        return tw, th
    scale = cap / short
    return (max(2, int(tw * scale) // 2 * 2),
            max(2, int(th * scale) // 2 * 2))


def export_maxrate(max_export_height) -> tuple[str, str]:
    """Video bitrate ceiling for the tier: 16 Mbps at 1080p (Batch 2),
    8 Mbps at 720p. The tier caps resolution + bitrate only — CRF 18
    and the rest of the Batch 2 pipeline are unchanged."""
    try:
        cap = FULL_MAX_EXPORT_HEIGHT if max_export_height is None else int(max_export_height)
    except (TypeError, ValueError):
        cap = FULL_MAX_EXPORT_HEIGHT
    return ("16000k", "32000k") if cap >= 1080 else ("8000k", "16000k")


# Batch 13: quality modes — the Draft/Standard/High selector the UI
# has offered since Batch 9 FINALLY drives the encoder. Before this
# batch the worker ignored the setting entirely and always rendered
# veryfast/CRF 18, so Draft/Standard/High were labels only. Now:
# Draft is a fast preview, Standard is the established Batch 2
# behaviour (medium/CRF 18), High is the slow, high-fidelity encode.
# Loudnorm and AAC 192k are unchanged in every mode; the Batch 11
# tier bitrate caps (8/16 Mbps at 720p, 16/32 at 1080p) are unchanged
# too — CRF is a quality target, the cap is a ceiling, they coexist.
# Honest limit: the SOURCE is the ceiling — a 360p source can never
# become true 1080p; upscaling cannot invent detail. The boost
# squeezes the maximum out of the source.
QUALITY_MODES = {
    "draft": ("fast", "20"),
    "standard": ("medium", "18"),
    "high": ("slow", "16"),
}


def quality_encode_params(settings: dict) -> tuple[str, str]:
    """(x264 preset, CRF) for a job's quality mode. Unknown or
    missing values fall back to Standard — never fail a render over
    a quality label."""
    mode = (settings.get("quality") or "standard").lower()
    return QUALITY_MODES.get(mode, QUALITY_MODES["standard"])


# Batch 13: high-quality scaling for every render-path scale —
# lanczos + accurate rounding + full chroma interpolation. Verified
# in this ffmpeg 8.1.2 build (the flag names are
# lanczos+accurate_rnd+full_chroma_int; "full_chr_int" and the
# separate accurate_rnd=/full_chroma_int= options do NOT exist here).
SCALE_FLAGS = "flags=lanczos+accurate_rnd+full_chroma_int"


def scale_expr(w, h, extra: str = "") -> str:
    """A scale filter expression with the Batch 13 quality flags.
    ``extra`` is an additional option (e.g. a
    force_original_aspect_ratio rule), appended after the flags.
    """
    expr = f"scale={w}:{h}:{SCALE_FLAGS}"
    return f"{expr}:{extra}" if extra else expr

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
W_COMPLETENESS = 0.15
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
# Batch 9 (2026-11-25): ranking v2 — emotional peaks. The number of
# per-second RMS energy peaks inside the window (a second counts as a
# peak when its energy is >= 70% of the loudest second in the source),
# normalised against the best candidate's peak count, like density.
# 0.05 of the score, taken from completeness (0.20 -> 0.15) — sentence
# completeness is now also enforced by the Batch 9 sentence-boundary
# snap, so it needs less weight. Weights still sum to 1.00:
# 0.20 + 0.20 + 0.15 + 0.05 + 0.05 + 0.15 + 0.10 + 0.05 + 0.05 = 1.00.
W_PEAKS = 0.05

# Batch 2 headline styles (per-job setting `headline_style`, default
# "bold_bar" = the look every job used before Batch 2).
HEADLINE_STYLES = ("bold_bar", "lower_third", "big_centre")

# Batch 2 caption positions (per-job setting `caption_position`,
# default "bottom" = where captions always sat before Batch 2).
CAPTION_POSITIONS = ("bottom", "top", "middle")

# Batch 7 (2026-11-25): on-screen text for the whole clip.
# `ost_animation` values — the headline's entrance only; "none" is
# the pre-Batch-7 behaviour (the headline appears instantly).
OST_ANIMATIONS = ("none", "slide", "fade", "pop")
# Default end-card text when end_card is on but no text was given.
OST_END_CARD_DEFAULT = "Follow for more"
# Progress bar: brand violet #8b5cf6 = RGB (139, 92, 246), 8px tall,
# bottom edge, growing left-to-right across the full clip.
PROGRESS_BAR_HEIGHT = 8
PROGRESS_BAR_COLOUR = "0x8b5cf6"
# Batch 9 (2026-11-25): colour grade presets (per-job setting
# `colour_grade`, default "none"). Applied on the final render only,
# as a video filter after layout/zoom/sharpen and BEFORE the
# captions/headline burn, so the grade colours the footage while the
# burned text stays its own colour. "none" adds no filter at all —
# the pipeline is byte-identical to before. Filters use only eq /
# vibrance / colorbalance / hue, all present in this ffmpeg build.
# Batch 13 (2026-11-25): three more looks (clean / mono / vintage)
# and an "auto" mode — the worker analyses each clip and picks the
# look that suits THAT clip (see pick_auto_grade). "auto" is the
# default from Batch 13. The named looks are our own recipes; the
# names are generic words, nothing copied from any competitor.
COLOUR_GRADES = ("auto", "none", "clean", "vibrant", "warm", "cool",
                 "cinematic", "mono", "vintage")
COLOUR_GRADE_FILTERS = {
    # Gentle lift: the safe "enhance" — a touch brighter, a touch
    # more contrast and colour. Also the auto pick for dark clips
    # (brightens) and for already-balanced clips (mild lift only).
    "clean": "eq=brightness=0.06:contrast=1.08:saturation=1.10",
    "vibrant": "eq=saturation=1.3:contrast=1.08,vibrance=intensity=0.2",
    "warm": "colorbalance=rs=0.08:gs=0.02:bs=-0.08,eq=saturation=1.05",
    "cool": "colorbalance=rs=-0.06:gs=0.0:bs=0.08,eq=saturation=1.02",
    "cinematic": ("eq=contrast=1.12:brightness=-0.02:saturation=0.85,"
                  "colorbalance=rs=0.03:bs=0.05"),
    # Black & white: full desaturation + a little contrast.
    "mono": "hue=s=0,eq=contrast=1.08",
    # Faded + warm: lower contrast/saturation, slight lift, warm cast.
    "vintage": ("eq=saturation=0.80:contrast=0.92:brightness=0.03,"
                "colorbalance=rs=0.06:gs=0.01:bs=-0.06"),
}


def colour_grade_filter(grade: str) -> str:
    """FFmpeg video filter for a colour grade, or "" for none/unknown.

    "auto" also returns "" here — it is resolved to a real look by
    resolve_colour_grade BEFORE this is called. Unknown values fall
    back to "" (no grade) — an old or mistyped grade never breaks
    a render.
    """
    return COLOUR_GRADE_FILTERS.get((grade or "none").lower(), "")


# Batch 13: auto-grade analysis thresholds. All measured on 0-255
# luma (Rec.601) and 0-1 HSV saturation, averaged over 3 frames
# (25/50/75% of the clip). The numbers are deliberately loose —
# grading is a look, not a diagnosis; a borderline clip just gets
# the gentle Clean lift. Priority order in pick_auto_grade is:
# dark -> colour cast -> washed out -> flat colour -> balanced.
AUTO_GRADE_DARK_LUMA = 75.0        # mean luma below this: dark
AUTO_GRADE_COOL_CAST = -12.0       # mean R minus mean B below this: cool
AUTO_GRADE_WARM_CAST = 12.0        # mean R minus mean B above this: warm
AUTO_GRADE_LOW_CONTRAST = 28.0     # luma std-dev below this: flat
AUTO_GRADE_LOW_SATURATION = 0.25   # mean saturation below this: washed out
AUTO_GRADE_LOW_SAT_ONLY = 0.28     # saturation below this alone: flat colour


def measure_frame_stats(image) -> dict:
    """Measure one PIL frame: mean luma + luma std-dev (contrast),
    mean saturation, and the red-minus-blue balance (colour cast).

    PIL only — no numpy needed. The frame is downscaled to <=160px
    wide first, so this is cheap even on big frames.
    """
    from PIL import ImageStat

    img = image.convert("RGB")
    if img.width > 160:
        img = img.resize((160, max(1, int(img.height * 160 / img.width))))
    grey = img.convert("L")
    grey_stat = ImageStat.Stat(grey)
    hsv_stat = ImageStat.Stat(img.convert("HSV"))
    rgb_stat = ImageStat.Stat(img)
    return {
        "luma": round(float(grey_stat.mean[0]), 1),
        "contrast": round(float(grey_stat.stddev[0]), 1),
        "saturation": round(float(hsv_stat.mean[1]) / 255.0, 3),
        "r_minus_b": round(float(rgb_stat.mean[0] - rgb_stat.mean[2]), 1),
    }


def pick_auto_grade(stats: dict) -> tuple[str, str]:
    """Pick the grade for one clip from its measured frame stats.

    Returns (grade, reason). Mono and Vintage are NEVER auto-picked —
    they are stylistic choices, not corrections; only the user picks
    them. Every branch is unit-tested with synthetic stats.
    """
    luma = float(stats.get("luma", 128.0))
    contrast = float(stats.get("contrast", 50.0))
    saturation = float(stats.get("saturation", 0.4))
    cast = float(stats.get("r_minus_b", 0.0))
    if luma < AUTO_GRADE_DARK_LUMA:
        return ("clean", "dark — brightened and lifted")
    if cast < AUTO_GRADE_COOL_CAST:
        return ("warm", "cool cast — warmed up")
    if cast > AUTO_GRADE_WARM_CAST:
        return ("cool", "warm cast — cooled down")
    if contrast < AUTO_GRADE_LOW_CONTRAST and saturation < AUTO_GRADE_LOW_SATURATION:
        return ("vibrant", "washed out — contrast and colour boosted")
    if saturation < AUTO_GRADE_LOW_SAT_ONLY:
        return ("vibrant", "flat colour — saturation boosted")
    return ("clean", "already balanced — gentle lift only")


def analyse_clip_frames(source: Path, start: float, end: float,
                        job_dir: Path) -> tuple[str, str, dict]:
    """Sample 3 frames from a clip window and pick its auto grade.

    Returns (grade, reason, averaged_stats). On ANY failure (missing
    source, ffmpeg error, unreadable frame) it falls back to Clean
    with a reason that says so — grading never fails a render.
    """
    from PIL import Image

    duration = max(0.0, end - start)
    frames: list[dict] = []
    for frac in (0.25, 0.5, 0.75):
        at = start + duration * frac
        out = job_dir / f"grade-{uuid.uuid4().hex[:8]}.png"
        try:
            proc = run([FFMPEG, "-y", "-v", "error",
                        "-ss", f"{at:.3f}", "-i", str(source),
                        "-vframes", "1", "-vf", "scale=160:-1",
                        str(out)], timeout=120)
            if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                continue
            with Image.open(out) as im:
                frames.append(measure_frame_stats(im))
        except Exception as exc:  # noqa: BLE001 — grading is best-effort
            log.warning("Auto-grade frame sampling failed at %.1fs: %s", at, exc)
        finally:
            try:
                out.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass
    if not frames:
        return ("clean", "frame analysis failed — gentle lift applied", {})
    avg = {k: round(sum(f[k] for f in frames) / len(frames), 3)
           for k in ("luma", "contrast", "saturation", "r_minus_b")}
    grade, reason = pick_auto_grade(avg)
    log.info("Auto grade: luma=%.1f contrast=%.1f sat=%.3f r-b=%.1f -> %s (%s)",
             avg["luma"], avg["contrast"], avg["saturation"], avg["r_minus_b"],
             grade, reason)
    return (grade, reason, avg)


def resolve_colour_grade(settings: dict, source: Path, start: float,
                         end: float, job_dir: Path) -> tuple[str, str | None, dict]:
    """Resolve the per-clip grade to actually render.

    Returns (grade, reason, measured_stats). "none" -> no grade and
    no reason; a named look -> that look, reason None (the UI calls
    it the "chosen look"); "auto" (the default) -> the analysed pick
    with its reason and stats. Unknown values behave like "none".
    """
    mode = (settings.get("colour_grade") or "none").lower()
    if mode == "auto":
        grade, reason, stats = analyse_clip_frames(source, start, end, job_dir)
        return (grade, reason, stats)
    if mode in COLOUR_GRADE_FILTERS:
        return (mode, None, {})
    return ("none", None, {})


# Batch 9 (2026-11-25): SFX (per-job setting `sfx`: none / whoosh /
# pop / whoosh_pop). Only sounds shipped in the repo are offered —
# services/video-engine/assets/sfx/{whoosh,pop}.wav, synthesised by
# scripts/synth-sfx.py (stdlib only, reproducible). whoosh plays at
# the clip start + each auto-zoom punch-in; pop plays on each keyword
# pop-up. A trigger that does not exist in a clip simply does not
# sound, and the job note says how many times each fired.
SFX_OPTIONS = ("none", "whoosh", "pop", "whoosh_pop")
SFX_DIR = Path(__file__).resolve().parent.parent / "assets" / "sfx"
SFX_FILES = {"whoosh": SFX_DIR / "whoosh.wav", "pop": SFX_DIR / "pop.wav"}
SFX_VOLUMES = {"whoosh": 0.5, "pop": 0.6}
# At most this many SFX events per clip (each is an extra ffmpeg
# input); the earliest triggers win.
SFX_MAX_EVENTS = 8
# Music bed level relative to the speech (0.25 ~= 12 dB under the
# main audio before the final loudnorm); the sidechain compressor
# ducks it further under speech (see render_clip).
MUSIC_BED_VOLUME = 0.25
# Bed alone (source with no audio track): a moderate level, since
# there is no speech to duck under.
MUSIC_BED_SOLO_VOLUME = 0.5


def sfx_events_for_clip(sfx: str, zoom_moments: list,
                        popups: list[dict] | None,
                        duration: float) -> list[tuple[str, float]]:
    """SFX trigger times (render-timeline seconds) for one clip.

    ``zoom_moments`` are (start, end) spans on the render timeline
    (auto-zoom punch-ins); ``popups`` are keyword pop-up dicts with a
    "start" on the render timeline. whoosh fires at the clip start
    (0.0) + each punch-in; pop fires at each pop-up. Events closer
    than 0.3s collapse to one (a punch-in at the clip start is one
    whoosh, not two). Capped at SFX_MAX_EVENTS, earliest first.
    Unknown / "none" settings return [].
    """
    setting = (sfx or "none").lower()
    if setting not in SFX_OPTIONS or setting == "none":
        return []
    events: list[tuple[str, float]] = []
    if "whoosh" in setting:
        times = [0.0] + [float(m[0]) for m in (zoom_moments or [])]
        for t in sorted(times):
            if 0.0 <= t <= duration and not any(
                    abs(t - e[1]) < 0.3 for e in events if e[0] == "whoosh"):
                events.append(("whoosh", t))
    if "pop" in setting:
        for p in (popups or []):
            t = float(p.get("start", -1.0))
            if 0.0 <= t <= duration:
                events.append(("pop", t))
    events.sort(key=lambda e: e[1])
    return events[:SFX_MAX_EVENTS]


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

    def upload_variant_clip(self, clip_id, clip_path: Path, rerender_id,
                            thumbnail: Path | None = None,
                            duration_seconds: float | None = None,
                            candidates: list[Path] | None = None,
                            face_tracked: bool = False) -> dict:
        """Upload an A/B variant render as a NEW clip row (Variant B).

        Batch 9: POST /muse/clips/{clip}/variant-file — the backend
        creates the variant row (score/reason/transcript copied from
        the original clip, linked via variant_of_clip_id) and marks
        the variant re-render ready. The original clip is untouched.
        """
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
            for n, cand in enumerate(candidates or [], 1):
                if n > 3:
                    break
                if cand is not None and Path(cand).exists():
                    fh_c = open(cand, "rb")
                    handles.append(fh_c)
                    files[f"candidate_{n}"] = (Path(cand).name, fh_c, "image/jpeg")
            data = {"rerender_id": str(rerender_id),
                    "face_tracked": "true" if face_tracked else "false"}
            if duration_seconds is not None:
                data["duration_seconds"] = str(duration_seconds)
            resp = self._request(
                "POST", f"/muse/clips/{clip_id}/variant-file",
                files=files, data=data, timeout=300,
            )
        finally:
            for h in handles:
                h.close()
        if resp.status_code not in (200, 201):
            raise RuntimeError(
                f"Upload variant clip {clip_path.name} for clip {clip_id} failed: "
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
#: Batch 9 (2026-11-25): broadened from ur/hi/en to the full MyMemory
#: list (ISO 639-1; zh-CN for Simplified Chinese) — the same list the
#: backend's JobSettingsRules::translationLanguages() states, so the
#: two cannot drift apart. A code MyMemory does not support simply
#: never translates: every call returns None and the caller falls
#: back honestly, so offering the full list is safe.
TRANSLATION_TARGETS = {
    "en": "English", "ur": "Urdu", "hi": "Hindi", "es": "Spanish",
    "fr": "French", "de": "German", "pt": "Portuguese", "ar": "Arabic",
    "tr": "Turkish", "id": "Indonesian", "bn": "Bengali",
    "pa": "Punjabi", "ta": "Tamil", "te": "Telugu", "ml": "Malayalam",
    "mr": "Marathi", "gu": "Gujarati", "ru": "Russian",
    "ja": "Japanese", "ko": "Korean", "zh-CN": "Chinese (Simplified)",
    "it": "Italian", "nl": "Dutch", "pl": "Polish", "uk": "Ukrainian",
    "vi": "Vietnamese", "th": "Thai", "fa": "Persian", "ps": "Pashto",
    "sd": "Sindhi", "ne": "Nepali", "si": "Sinhala",
}
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


def _translate_headline(headline: str, settings: dict) -> tuple[str, str]:
    """Translate a DERIVED headline into the job's ost_language.

    Returns (text, status): status is "none" (ost_language unset /
    'source' / unknown — no translation asked for), "same" (the
    headline is already in the target language — no call made), "ok"
    (translated), or "failed" (MyMemory failed after one retry — the
    ORIGINAL headline is returned and the job note says so).

    The source language is the language the headline is ALREADY in:
    the caption-translation target when captions were translated
    (the headline derives from the translated transcript then), else
    the transcript's language (captions_language). The translated
    headline is uppercased, like every derived headline, so the
    burned look stays the same across languages.

    Only the derived headline ever passes through here — the end-card
    text and lower-third tag are the user's own words and keyword
    pop-ups must match the spoken words, so they are never translated.
    """
    target = (settings.get("ost_language") or "source").lower()
    if target == "source" or target not in TRANSLATION_TARGETS:
        return headline, "none"
    caption_target = (settings.get("caption_translation") or "none").lower()
    if caption_target in TRANSLATION_TARGETS:
        source = caption_target
    else:
        source = TRANSLATION_SOURCES.get(
            (settings.get("captions_language") or "auto").lower(), "autodetect")
    if source == target:
        return headline, "same"
    for _attempt in range(2):  # one attempt + at most one retry
        got = _mymemory_translate(headline, source, target)
        if got:
            return got.upper(), "ok"
    log.warning("MyMemory headline translation to %s failed; headline "
                "stays in the source language.", target)
    return headline, "failed"


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
    "peaks": "Peaks",
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


def _snap_end_to_sentence(units: list[dict], window_end: float,
                          start: float, tail: float,
                          tolerance: float = DURATION_TOLERANCE
                          ) -> tuple[float, bool]:
    """Snap a window's end to the nearest sentence end (Batch 9).

    Sentence ends are ``unit["end"] + tail`` for the sentence units
    inside the window. When one is within ``tolerance`` seconds of
    ``window_end`` (default 0.6s), return it and True. Otherwise
    return the unmoved ``window_end`` and False — the caller keeps
    the old mid-sentence cut and says so honestly in the note.

    NOTE: this helper alone does NOT know the duration mode. The
    caller must gate the snap: exact mode must never snap (Job #8 —
    a 20.595s window failed validation at the 0.6s boundary), and
    minimum/maximum modes must only snap inside their promised
    range. A snap that merely "validates within tolerance" is not
    enough — exact mode promises exactly the target.
    """
    best: float | None = None
    for u in units:
        cand = u["end"] + tail
        if cand <= start:
            continue
        if abs(cand - window_end) <= tolerance:
            if best is None or abs(cand - window_end) < abs(best - window_end):
                best = cand
    if best is None:
        return window_end, False
    return best, best != window_end


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
    # Batch 9: ranking v2 — the loudest second in the source; a
    # second counts as an emotional peak when its energy is >= 70%
    # of this.
    max_energy = max(energy_profile) if energy_profile else 0.0
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
            # Batch 9: sentence-boundary cuts — snap the window end to
            # the nearest sentence end when one is within the 0.6s
            # tolerance, so the clip ends on a sentence, never
            # mid-word. The snap must never break the duration
            # contract of the mode: exact mode NEVER snaps (Job #8 —
            # a 20.595s window failed validation at the 0.6s boundary
            # and the clip was skipped, so exact promises exactly the
            # target); minimum mode only snaps while the window stays
            # >= Min and <= Max; maximum mode only snaps while it
            # stays <= Max and >= Min. When no sentence end qualifies,
            # the old cut stays and the window is honestly marked
            # trimmed in the note.
            snapped_end, moved = _snap_end_to_sentence(
                units, window_end, start, tail)
            snap_refused = False
            if moved:
                snapped_span = snapped_end - start
                snap_ok = (
                    (mode == "minimum" and snapped_span >= target
                     and (not max_s
                          or snapped_span <= max_s + DURATION_TOLERANCE))
                    or (mode == "maximum"
                        and snapped_span <= target + DURATION_TOLERANCE
                        and (not min_s
                             or snapped_span >= min_s - DURATION_TOLERANCE))
                )
                if snap_ok:
                    window_end = snapped_end
                    span = snapped_span
                    complete = True
                else:
                    # A sentence end IS nearby, but taking it would
                    # break the duration promise — say so honestly in
                    # the reason instead of claiming no boundary
                    # exists (see the reason builder below).
                    snap_refused = True
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
            # Batch 9: emotional peaks — per-second RMS energy peaks
            # inside the FINAL window (after snapping/extension). A
            # second is a peak when its energy is >= 70% of the
            # loudest second in the source; only seconds overlapping
            # the window count. Raw count here, normalised against
            # the best candidate in the scoring pass, like density.
            peak_seconds = 0
            if max_energy > 0:
                peak_threshold = 0.7 * max_energy
                peak_seconds = sum(
                    1 for k in range(int(start), int(window_end) + 1)
                    if k + 1 > start and k < window_end
                    and k < len(energy_profile)
                    and energy_profile[k] >= peak_threshold)
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
                "peaks": peak_seconds,
                "snapped": moved and not snap_refused,
                "snap_refused": snap_refused,
                "gameplay": gameplay_in(start, window_end),
                "stability": stability_in(start, window_end),
                "text": " ".join(u["text"] for u in units[i:j + 1])[:300],
                "signals": [],
            })

    if candidates:
        max_density = max(c["density"] for c in candidates) or 1.0
        max_hook_density = max(c["hook_density"] for c in candidates) or 1.0
        max_hook_energy = max(c["hook_energy"] for c in candidates) or 1.0
        max_peaks = max(c.get("peaks", 0) for c in candidates) or 1.0
        for c in candidates:
            density_n = min(1.0, c["density"] / max_density)
            completeness = 1.0 if c["complete"] else 0.4
            silence_n = min(1.0, c["silence"])
            # Hook: half opening speech density, half opening energy,
            # each normalised against the best candidate's opening.
            hook_n = round(0.5 * min(1.0, c["hook_density"] / max_hook_density)
                           + 0.5 * min(1.0, c["hook_energy"] / max_hook_energy), 4)
            # Batch 9: emotional peaks — the window's peak-second
            # count normalised against the best candidate's, like
            # density. A window with several loud moments scores
            # higher than a flat one.
            peaks_n = min(1.0, c.get("peaks", 0) / max_peaks)
            c["hook"] = hook_n
            c["peaks_n"] = round(peaks_n, 4)
            c["score"] = round(
                W_DENSITY * density_n
                + W_COVERAGE * c["coverage"]
                + W_COMPLETENESS * completeness
                + W_SILENCE * silence_n
                + W_ENERGY * min(1.0, c["energy"])
                + W_GAMEPLAY * c["gameplay"]
                + W_STABILITY * c["stability"]
                + W_HOOK * hook_n
                + W_PEAKS * peaks_n, 4)
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
                "peaks": peaks_n,
            })
            c["signals"] = ["speech_density", "sentence_complete" if c["complete"] else "trimmed_to_duration",
                            "silence_boundary", "audio_coverage"]
            if c.get("snapped"):
                c["signals"].append("sentence_boundary_cut")
            if c["energy"] > 0:
                c["signals"].append("audio_energy_supporting")
            if c["hook"] >= 0.7:
                c["signals"].append("strong_opening")
            if peaks_n >= 0.5:
                c["signals"].append("emotional_peaks")
            if c["gameplay"] >= 0.5:
                c["signals"].append("gameplay_present")
            if c["stability"] >= 0.8:
                c["signals"].append("single_scene")
            if c.get("snapped"):
                sentence_note = "ends on a sentence boundary"
            elif c.get("complete"):
                sentence_note = "sentence complete"
            elif c.get("snap_refused"):
                # A sentence end was nearby, but the duration mode
                # forbade taking it — say that, not "no boundary".
                sentence_note = (
                    f"trimmed to the exact {target:.0f}s target"
                    if mode == "exact"
                    else "trimmed mid-sentence (nearest sentence end outside the Min–Max range)"
                )
            else:
                sentence_note = "trimmed mid-sentence (no sentence boundary within 0.6s)"
            c["reason"] = (
                f"Score {c['score']:.2f} (viral {round(c['score'] * 100)}/100): "
                f"speech density {density_n:.2f}, "
                f"audio coverage {c['coverage']:.2f}, "
                f"{sentence_note}, "
                f"silence boundary {silence_n:.2f}, audio energy (supporting) {c['energy']:.2f}, "
                f"gameplay {c['gameplay']:.2f}, scene stability {c['stability']:.2f}, "
                f"opening hook {hook_n:.2f}, emotional peaks {peaks_n:.2f}."
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
    # Batch 9 (2026-11-25): two more concepts, our own work — Comic Pop
    # (playful slanted words, pink shadow, wobble entrance) and Marker
    # (slanted words with a thick yellow marker outline, flat landing).
    # Same generic concepts as the competitor's Comic/Marker, but our
    # own names, samples, colours and rendering — nothing copied.
    "comic": "Comic Pop",
    "marker": "Marker",
}

# One bright colour per word, cycled (ASS BGR hex) — the Gradient Pop
# palette. Must match wordColors in captionStyles.ts.
GRADIENT_PALETTE = ["0000FFFF", "000080FF", "00FF00FF", "00FFFF00"]

# Batch 9 (2026-11-25): the Comic Pop accent cycle — mint / yellow /
# cyan, one per word (ASS BGR hex). Must match the comic word colours
# in CaptionStylePreview.tsx. Neon alternates cyan / pink the same
# way (NEON_PALETTE); Marker's spoken word is always orange
# (MARKER_ACCENT, #FB923C).
COMIC_PALETTE = ["0099D334", "0015CCFA", "00EED322"]
NEON_PALETTE = ["00EED322", "009948EC"]
MARKER_ACCENT = "003C92FB"

# Batch 9 — one distinct typeface per caption style (25) + headline
# style (3), documented as the FONT MAP. Each entry: (ASS Fontname,
# ASS Bold, ASS Italic, shipped font file in
# services/video-engine/fonts/). Bold/Italic MATCH the style's
# existing ASS flags (see _NEW_STYLE_PARAMS and the legacy Style
# lines) — only the typeface changes, never the weight or slant, so
# no existing style's look changes except its font. The file is used
# for real PIL measurement (the same glyphs libass renders) and is
# served as a webfont for the browser preview, so preview and burn
# use the same typeface. Weight-named families ("Noto Sans Black")
# resolve via fontconfig to that exact face; plain families
# ("Noto Sans") resolve through the Bold/Italic flags — every entry
# was verified with fc-match (see test_font_map_resolves in
# test_muse_worker.py). The files ship in the repo (see
# scripts/sync-fonts.sh) because VM replacements wipe
# /usr/share/fonts; the worker installs them into fontconfig at job
# start (_ensure_repo_fonts).
FONT_MAP: dict[str, tuple[str, int, int, str]] = {
    "punchy": ("Noto Sans Black", -1, 0, "NotoSans-Black.ttf"),
    "word_pop": ("Noto Sans ExtraBold", -1, 0, "NotoSans-ExtraBold.ttf"),
    "title_card": ("Noto Serif Black", -1, 0, "NotoSerif-Black.ttf"),
    "clean_subs": ("Noto Sans", 0, 0, "NotoSans-Regular.ttf"),
    "classic": ("Noto Serif Display", -1, 0, "NotoSerifDisplay-Bold.ttf"),
    "karaoke": ("Noto Sans", -1, 0, "NotoSans-Bold.ttf"),
    "bounce": ("Noto Sans Display", -1, 0, "NotoSansDisplay-Bold.ttf"),
    "typewriter": ("Noto Sans Mono", -1, 0, "NotoSansMono-Bold.ttf"),
    "sweep": ("Noto Sans SemiBold", -1, 0, "NotoSans-SemiBold.ttf"),
    "neon": ("Noto Sans Condensed", -1, 0, "NotoSans-CondensedBold.ttf"),
    "slam": ("Noto Sans ExtraCondensed Black", -1, 0,
             "NotoSans-ExtraCondensedBlack.ttf"),
    "outline": ("Noto Sans Display Black", -1, 0, "NotoSansDisplay-Black.ttf"),
    "gradient": ("Noto Sans Display ExtraBold", -1, 0,
                 "NotoSansDisplay-ExtraBold.ttf"),
    "kinetic": ("Noto Sans Medium", -1, 0, "NotoSans-Medium.ttf"),
    "glow_pop": ("Noto Sans Light", -1, 0, "NotoSans-Light.ttf"),
    "word_zoom": ("Noto Sans Display SemiBold", -1, 0,
                  "NotoSansDisplay-SemiBold.ttf"),
    "word_fade": ("Noto Sans Display Light", -1, 0, "NotoSansDisplay-Light.ttf"),
    "highlight_sweep": ("Noto Sans Condensed Black", -1, 0,
                        "NotoSans-CondensedBlack.ttf"),
    "bounce_in": ("Noto Sans Display Condensed", -1, 0,
                  "NotoSansDisplay-CondensedBold.ttf"),
    "glitch_pop": ("DejaVu Sans Mono", -1, 0, "DejaVuSansMono-Bold.ttf"),
    "tiktok_bold": ("Noto Sans ExtraCondensed", -1, 0,
                    "NotoSans-ExtraCondensedBold.ttf"),
    "reels_clean": ("DejaVu Sans", -1, 0, "DejaVuSans-Bold.ttf"),
    "shorts_minimal": ("DejaVu Serif", -1, 0, "DejaVuSerif-Bold.ttf"),
    "comic": ("Comic Neue", -1, -1, "ComicNeue-BoldItalic.otf"),
    "marker": ("Caveat", -1, -1, "Caveat-Bold.ttf"),
}
# The CleanSubs sub-style inside title_card shares clean_subs' font.
TITLE_CARD_SUB_FONT = FONT_MAP["clean_subs"]
HEADLINE_FONT_MAP: dict[str, tuple[str, int, int, str]] = {
    "bold_bar": ("Noto Serif", -1, 0, "NotoSerif-Bold.ttf"),
    "lower_third": ("Noto Sans Display Condensed Black", -1, 0,
                    "NotoSansDisplay-CondensedBlack.ttf"),
    "big_centre": ("Noto Serif Display Black", -1, 0,
                   "NotoSerifDisplay-Black.ttf"),
}
FONTS_DIR = Path(__file__).resolve().parent.parent / "fonts"


def _ensure_repo_fonts() -> None:
    """Install the repo's shipped fonts into fontconfig (once per run).

    libass resolves ASS Fontnames through fontconfig, which reads the
    user's font dir — symlink each shipped file into
    ~/.local/share/fonts/magician-clipper/ and refresh the cache when
    anything changed. Idempotent and cheap when nothing changed (no
    fc-cache run). Never fails the job: a fontconfig problem only
    logs a warning and the render falls back to the system fonts.
    """
    try:
        if not FONTS_DIR.is_dir():
            return
        target = Path.home() / ".local" / "share" / "fonts" / "magician-clipper"
        target.mkdir(parents=True, exist_ok=True)
        changed = False
        for src in sorted(FONTS_DIR.iterdir()):
            if src.suffix.lower() not in (".ttf", ".otf"):
                continue
            link = target / src.name
            if link.is_symlink() and link.resolve() == src.resolve():
                continue
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(src)
            changed = True
        if changed:
            run(["fc-cache", "-f", str(target)], timeout=120)
            log.info("Installed %d repo font(s) into fontconfig",
                     len(list(target.iterdir())))
    except Exception:
        log.warning("repo fonts install failed (continuing with system "
                    "fonts)", exc_info=True)

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
# Batch 9: per-font measure cache — one PIL ImageFont (100px) per
# shipped font file, so measurement uses the same glyphs libass
# renders for that style (see FONT_MAP).
_measure_fonts: dict[str, object] = {}


def _load_measure_font_for(font_path) -> object | None:
    """PIL ImageFont (100px) for one shipped font file, or None.

    Cached per path. None when Pillow is missing or the file cannot
    be read — the caller then falls back to the estimator.
    """
    key = str(font_path)
    if key in _measure_fonts:
        return _measure_fonts[key]
    try:
        from PIL import ImageFont
        font = ImageFont.truetype(key, 100)
    except Exception:
        font = None
    _measure_fonts[key] = font
    return font


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


def _measure_text_width_px(text: str, fs: int, font_path=None) -> float:
    """Real rendered width of one line at ``fs``.

    Primary path for caption auto-fit: Pillow measures the exact glyph
    advances of the same font libass renders. ``font_path`` selects
    that style's shipped font (Batch 9 FONT_MAP); without it, the
    legacy DejaVu Sans Bold measure font is used (Batch 6 behaviour).
    A 2% safety margin covers libass's own rounding (its advances are
    integer pixels). Falls back to the per-glyph estimator when Pillow
    or the font is unavailable.
    """
    if font_path is not None:
        font = _load_measure_font_for(font_path)
        if font is None:
            return _estimate_text_width_px(text, fs)
        return font.getlength(text) * fs / 100 * 1.02
    font = _load_measure_font()
    if font is None:
        return _estimate_text_width_px(text, fs)
    return font.getlength(text) * fs / 100 * 1.02


def _fit_font_size(text: str, fs: int, max_width: float,
                   font_path=None) -> int | None:
    """Smaller font size that fits ``text`` in ``max_width`` px, or
    None when ``fs`` already fits. Floored at 24 so captions stay
    readable — a word that still would not fit at 24 is left at 24
    (libass then wraps it; a 24pt overflow is a one-word edge case,
    not a silent clip of the frame). Widths are real measurements
    (Batch 6) with the estimator as fallback."""
    if _measure_text_width_px(text, fs, font_path) <= max_width:
        return None
    fitted = int(fs * max_width / _measure_text_width_px(text, fs, font_path))
    return max(24, fitted)


def _caption_align_mv(position: str, fs: int, tw: int, th: int,
                      divider_y: int | None, layout: str,
                      headline_style: str = "bold_bar",
                      ost_position: str | None = None) -> tuple[int, int]:
    """(ASS alignment, MarginV) for captions at ``position``.

    - "bottom" (default, pre-Batch-2 behaviour): on the split divider
      when split, lower-centre otherwise (out of the face).
    - "top": near the top, below the headline band (MarginV 300 clears
      the bold-bar headline at 120), so headline and captions stack
      instead of colliding.
    - "middle": vertically centred (top alignment at th/2 - fs/2).
      When the headline sits at the CENTRE (big_centre's default, or
      any style with ost_position="centre"), the first 4s would
      collide, so middle captions drop to 62% down for those 4s' sake
      — the setting still reads "Middle" everywhere; the shift is a
      layout guard, not a different position. Batch 9: the guard
      follows the EFFECTIVE ost position, not just the headline style.
    """
    split = layout == "split" and divider_y is not None
    if position == "top":
        return 8, 300
    if position == "middle":
        if effective_ost_position(headline_style, ost_position) == "centre":
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
                  max_width: float, font_path=None) -> list[list[dict]]:
    """Split one phrase into 1–2 rendered lines (Batch 6).

    One line when the whole phrase fits ``max_width`` at ``fs``.
    Otherwise split at the phrase boundary that best balances the two
    lines (after a comma/semicolon/colon, or before a conjunction);
    with no boundary inside, split at the middle word. The caller fits
    the font on the LONGEST line, so a 2-line phrase keeps the full
    font size instead of shrinking — a 6-word phrase at fs 96 becomes
    two 3-word lines, not a tiny one-liner. ``font_path`` (Batch 9)
    measures with that style's real font.
    """
    text = " ".join(w["word"] for w in phrase)
    if _measure_text_width_px(text, fs, font_path) <= max_width:
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
            " ".join(w["word"] for w in phrase[:i]), fs, font_path)
        w2 = _measure_text_width_px(
            " ".join(w["word"] for w in phrase[i:]), fs, font_path)
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


def _required_campaign_ost(settings: dict) -> str | None:
    """The structured required on-screen text, or None.

    Batch 12: the wizard's Campaign requirements section carries an
    explicit on-screen-text field with its own Required/Optional
    selector. When the field is set AND marked Required, its text is
    burned verbatim (never translated, never re-scored) and it wins
    over every other source. When Optional (or empty) it is a hint
    for the headline scorer, not a binding text.
    """
    text = (settings.get("campaign_ost") or "").strip()
    if text and settings.get("campaign_ost_required"):
        return _cap_headline(text)
    return None


def _campaign_on_screen_text(settings: dict) -> str | None:
    """Explicit on-screen text from the job brief, verbatim.

    Order: (a) the structured required OST field (Batch 12);
    (b) an explicit line in the campaign brief / notes
    ("on-screen text: ...", "OST: ...", "headline: ..."), else the
    first double-quoted string. Capped at 60 chars; None when the
    brief carries no explicit on-screen text — the transcript
    headline is tried next, never invented text.
    """
    required = _required_campaign_ost(settings)
    if required:
        return required
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


def _trim_headline_edges(parts: list[dict]) -> list[dict]:
    """Strip leading/trailing stopwords from a headline candidate.

    Batch 9: a headline must start AND end on a content word
    ("CLIMB THE TOWER", never "TO I HAVE TO" or "WE CLIMB THE").
    Returns [] when nothing but stopwords survives — the caller then
    tries the next-best phrase, or no headline at all.
    """
    start = 0
    while (start < len(parts)
           and parts[start]["word"].strip(_PUNCT).lower() in _ON_SCREEN_STOPWORDS):
        start += 1
    end = len(parts)
    while (end > start
           and parts[end - 1]["word"].strip(_PUNCT).lower() in _ON_SCREEN_STOPWORDS):
        end -= 1
    kept = parts[start:end]
    if not any(w["word"].strip(_PUNCT)
               and w["word"].strip(_PUNCT).lower() not in _ON_SCREEN_STOPWORDS
               for w in kept):
        return []
    return kept


# Batch 12: OST hint types — when the on-screen text is Optional,
# the user may describe the KIND of headline they want ("question
# style"). The scorer then prefers phrases of that type. A question
# starts on a question word; an exclamation carries an emphasis word;
# a statement starts on anything else.
_QUESTION_STARTERS = {
    "what", "why", "how", "when", "where", "who", "which", "whose",
    "whom", "can", "could", "should", "would", "will", "do", "does",
    "did", "is", "are", "was", "were", "have", "has", "had",
}


def _hint_type(hint: str | None) -> str | None:
    """Classify an OST hint ("question style", "make it a question!",
    "statement") into question / exclamation / statement, or None
    when the hint names no type. Never raises on odd input."""
    if not hint:
        return None
    h = hint.lower()
    if "?" in h or "question" in h:
        return "question"
    if "!" in h or "exclamat" in h or "shout" in h:
        return "exclamation"
    if "statement" in h or "declar" in h:
        return "statement"
    return None


def _phrase_matches_hint(phrase: list[dict], hint_kind: str | None) -> bool:
    """True when a phrase is of the hinted type. The phrase's FIRST
    word decides a question / statement (question words are
    stopwords, so the first CONTENT word would never be one — "why
    is this view insane" starts on "why", not on "view"). An
    exclamation carries an emphasis word anywhere in the phrase."""
    if hint_kind is None or not phrase:
        return False
    first = phrase[0]["word"].strip(_PUNCT).lower()
    if hint_kind == "question":
        return first in _QUESTION_STARTERS
    if hint_kind == "statement":
        return first not in _QUESTION_STARTERS
    if hint_kind == "exclamation":
        return any(w["word"].strip(_PUNCT).lower() in EMPHASIS_WORDS
                   for w in phrase)
    return False


def _transcript_headline(clip: dict, segments: list[dict],
                         hint: str | None = None) -> str | None:
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
    Batch 9: score COMPLETE natural phrases only — a phrase that
    starts on a stopword or is mostly function words is penalised,
    the winning phrase's edges are trimmed to content words, and a
    window with no content word at all gets NO headline (the old
    fallback returned the first phrase verbatim, which is how a
    stopword-only stretch became the Batch 7 headline
    "TO I HAVE TO I TO").
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
        # Batch 9: a window with no content word at all has no
        # headline — the old fallback returned the first phrase
        # verbatim, which is how a stopword-only stretch became the
        # Batch 7 headline "TO I HAVE TO I TO".
        log.debug("Headline: window has no content words — no headline")
        return None

    # Batch 12: the OST hint's type (question / exclamation /
    # statement), or None when no hint was given.
    hint_kind = _hint_type(hint)

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
        # Batch 9: a phrase that is mostly function words is not a
        # headline — score complete natural phrases only. (A leading
        # stopword is NOT penalised here on purpose: "we climb the
        # tower" is a good phrase whose edge the trim below removes;
        # penalising the start would demote it below a repeated-word
        # stretch. The trim, not the score, guarantees the edge.)
        content_frac = len(content) / max(1, len(phrase))
        fragment_penalty = 2.0 if content_frac < 0.5 else 0.0
        # One word repeated is not a headline ("go go go go").
        repeat_penalty = 1.0 if content and len(distinct) <= 1 and len(content) >= 3 else 0.0
        # Batch 12: an OST hint ("question style") boosts phrases of
        # the hinted type — a preference, never a fabrication: a
        # non-matching phrase can still win when it scores far higher.
        hint_bonus = 1.5 if _phrase_matches_hint(phrase, hint_kind) else 0.0
        return (emphasis + min(best_count, 2) * 0.5 + density * 0.3
                + min(len(distinct), 4) * 0.2 - filler_frac * 2.0
                - trailing_stop - fragment_penalty
                - repeat_penalty + hint_bonus)

    scored = sorted(range(len(phrases)),
                    key=lambda i: (-phrase_score(phrases[i]), i))
    for phrase_idx in scored:
        log.debug("Headline pick: phrase %d of %d scored %.2f: %r",
                  phrase_idx, len(phrases), phrase_score(phrases[phrase_idx]),
                  " ".join(w["word"] for w in phrases[phrase_idx]))
        parts = list(phrases[phrase_idx])
        if len(parts) < 3 and phrase_idx > 0:
            parts = list(phrases[phrase_idx - 1]) + parts
        if len(parts) < 3 and phrase_idx + 1 < len(phrases):
            parts = parts + list(phrases[phrase_idx + 1])
        # Batch 9: the headline never starts/ends on a stopword and
        # is never a lone function word — trim the edges and require
        # at least one content word to survive; otherwise try the
        # next-best phrase.
        trimmed = _trim_headline_edges(parts)
        if not trimmed:
            continue
        text = " ".join(w["word"] for w in trimmed[:6])
        return _cap_headline(text.upper()) if text else None
    return None


def derive_on_screen_text(clip: dict, segments: list[dict],
                          settings: dict) -> str | None:
    """The on-screen headline for one clip, or None.

    Order: (a) the structured required OST, verbatim; (b) an
    explicit campaign line from the brief, verbatim; (c) a headline
    from the clip's own transcript — with the OST hint steering the
    scorer when the OST is Optional (the hint is the `ost_hint`
    input, or the Optional OST text itself); (d) nothing when the
    window has no transcript — a silent/visual clip gets no
    invented text, and the worker logs that honestly.
    """
    campaign = _campaign_on_screen_text(settings)
    if campaign:
        return campaign
    hint = settings.get("ost_hint") or None
    if hint is None and (settings.get("campaign_ost") or "").strip():
        # An Optional OST text is not binding — it is the hint.
        hint = settings.get("campaign_ost")
    return _transcript_headline(clip, segments, hint=hint)


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


def _top_hashtags(words: list[dict], limit: int = 8) -> list[str]:
    """Top content words by frequency as #tags (lowercase,
    #prefixed, de-duplicated, stopwords and fillers removed, 3–20
    chars, at most ``limit``). The one hashtag rule shared by the
    job-level and per-clip derivations, so the two can never drift
    apart. ``words`` are the 0-based word dicts ``_clip_words``
    returns. ``_clip_words`` strips the whitespace Whisper puts on
    every word (" Come") — raw segment words would fail the isalnum
    check and yield zero hashtags (Job #44 proved it: 0 tags).
    """
    counts: dict[str, int] = {}
    first_seen: dict[str, int] = {}
    order = 0
    for word in words:
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
    return [f"#{w}" for w in ranked[:limit]]


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
    return title, _top_hashtags(_clip_words(segments, 0.0, source_duration))


def derive_clip_title_hashtags(segments: list[dict], start: float,
                               end: float) -> tuple[str | None, list[str]]:
    """Title + hashtags for ONE clip, from that clip's OWN spoken
    words — the same derivation as the job-level suggestion, run over
    the clip's window only. No second Whisper pass: the clip's words
    are the window's words (the same transcript the captions use),
    so re-transcribing the clip file would only re-derive the same
    words at the cost of a Whisper run per clip. Returns (None, [])
    for a silent window.
    """
    duration = end - start
    if not segments or duration <= 0:
        return None, []
    title_raw = _transcript_headline({"start": start, "end": end}, segments)
    title = _title_case_headline(title_raw).rstrip(_PUNCT).strip() \
        if title_raw else None
    return title, _top_hashtags(_clip_words(segments, start, end))


def _campaign_parsed(settings: dict) -> dict:
    """The backend's deterministic parse of the campaign brief
    (settings.campaign_parsed, Batch 14), or {} when the job has
    none — an old job, or a brief the backend never parsed. The
    backend is the single source of truth for the parse: the worker
    NEVER re-parses the raw brief text, so the two can never
    disagree about what the brief said."""
    parsed = settings.get("campaign_parsed")
    return parsed if isinstance(parsed, dict) else {}


def parse_required_hashtags(raw: str | None) -> list[str]:
    """Parse the campaign hashtags field into an ordered list:
    "#a #b, c" -> ["#a", "#b", "#c"]. A '#' is added when missing;
    the tag's own characters are kept exactly as typed (verbatim);
    duplicates collapse case-insensitively, keeping the first.
    Mirrors the backend's CampaignChecklist::parseHashtags."""
    if not raw or not raw.strip():
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for piece in re.split(r"[\s,]+", raw.strip()):
        piece = piece.strip()
        if not piece:
            continue
        tag = piece if piece.startswith("#") else "#" + piece
        if tag.lower() in seen:
            continue
        seen.add(tag.lower())
        tags.append(tag)
    return tags


def apply_campaign_caption(settings: dict, title: str | None,
                           auto_hashtags: list[str],
                           clip_index: int = 0) -> dict:
    """A clip's post caption + hashtag set under the campaign rules.

    Required post caption -> verbatim, source "required". Otherwise
    Batch 14: when the brief gave example captions (optional
    CAPTION GUIDELINES with example lines), the examples ROTATE
    across clips — clip N gets examples[N % len(examples)], source
    "example" — so the set is used evenly instead of one line on
    every clip. When there are no examples, the clip's own derived
    title is the caption, source "auto" (None when the clip has no
    title to derive — a silent clip).
    Required hashtags come first, in the given order; auto-derived
    tags fill the set to 8 total (never duplicating a required tag,
    case-insensitively). Required items are NEVER translated — they
    are the user's own words, and the caller never passes them
    through any translation. Returns the post caption, its source,
    the final hashtag list, and which required items applied.
    """
    caption = (settings.get("campaign_caption") or "").strip()
    caption_required = bool(settings.get("campaign_caption_required"))
    if caption and caption_required:
        post_caption, source = caption, "required"
        applied = ["caption"]
    else:
        examples = [e.strip() for e in
                    _campaign_parsed(settings).get("caption", {}).get("examples", [])
                    if isinstance(e, str) and e.strip()]
        if examples:
            post_caption, source = examples[clip_index % len(examples)], "example"
        else:
            post_caption, source = title, "auto"
        applied = []
    required_tags = (
        parse_required_hashtags(settings.get("campaign_hashtags"))
        if settings.get("campaign_hashtags_required") else [])
    tags = list(required_tags)
    if required_tags:
        applied.append("hashtags")
    seen = {t.lower() for t in tags}
    for tag in auto_hashtags:
        if len(tags) >= 8:
            break
        if tag.lower() not in seen:
            tags.append(tag)
            seen.add(tag.lower())
    return {"post_caption": post_caption,
            "caption_source": source,
            "hashtags": tags,
            "required_items_applied": applied}


def derive_keyword_popups(segments: list[dict], start: float, end: float,
                            max_popups: int = 4) -> list[dict]:
    """Up to ``max_popups`` keyword pop-ups for one clip, from the
    clip's OWN transcript — never invented words.

    The words are the top content words by frequency inside [start,
    end] (same rules as the hashtag derivation: 3–20 chars, alnum,
    stopwords and fillers removed), each shown at its FIRST spoken
    moment (Whisper word timestamp, 0-based on the clip) for 1.0s.
    When two keywords fall within 1s of each other only the first is
    kept — never more than one pop-up on screen at once. Returns []
    when the clip has no speech (silent clips get no pop-ups).
    Each item is {"word": str, "start": float, "end": float}.
    """
    if not segments or end <= start:
        return []
    counts: dict[str, int] = {}
    first: dict[str, dict] = {}
    for word in _clip_words(segments, start, end):
        clean = word["word"].strip(_PUNCT).lower()
        if (not clean or len(clean) < 3 or len(clean) > 20
                or not clean.isalnum()
                or clean in _ON_SCREEN_STOPWORDS
                or clean in FILLER_WORDS):
            continue
        if clean not in counts:
            counts[clean] = 0
            first[clean] = word
        counts[clean] += 1
    if not counts:
        return []
    ranked = sorted(counts, key=lambda w: (-counts[w], first[w]["start"]))
    duration = end - start
    popups: list[dict] = []
    for clean in ranked[:max_popups]:
        w = first[clean]
        s = max(0.0, w["start"])
        e = min(s + 1.0, duration)
        if e <= s:
            continue
        popups.append({"word": w["word"].strip(_PUNCT).upper(),
                       "start": s, "end": e})
    popups.sort(key=lambda p: p["start"])
    # Never two at once: drop a pop-up that starts within 1s of the
    # previous kept one (keep the first).
    kept: list[dict] = []
    for p in popups:
        if kept and p["start"] < kept[-1]["start"] + 1.0:
            continue
        kept.append(p)
    return kept


def _text_box_filter(tw: int, text: str, fs: int, y_centre: int,
                     pad_x: int = 40, pad_y: int = 20,
                     enable: str | None = None, font_path=None,
                     lines: list[str] | None = None,
                     y_top: int | None = None,
                     alpha: float = 0.8) -> str:
    """A filled dark box behind one line of text — the background for
    the end card and the lower-third tag. ASS BorderStyle 3 opaque
    boxes do NOT render in this ffmpeg/libass build (verified
    2026-11-25 with a minimal test: the text rendered, the box did
    not — 0% dark pixels behind it), so the card background is a
    drawbox with static geometry (proven to work on this build) plus
    an ``enable`` timeline for the end card. It is drawn UNDER the
    subtitles step, so the text sits on top of it. ``y_centre`` is the
    text line's vertical centre in output px; the box is centred
    horizontally and padded by ``pad_x``/``pad_y`` around the measured
    text width (real font measurement, estimator fallback).
    Batch 9: ``font_path`` measures with the style's real font, and
    ``lines`` (the fitted wrapped lines) sizes the box to the longest
    line and to all lines' height — a 2-line end card gets a taller
    box. ``y_top`` places the box by its top edge instead of its
    centre (the top headline bar).
    """
    # _measure_text_width_px already falls back to the estimator when
    # Pillow/the font is unavailable, so this is always a real number.
    use_lines = lines if lines else [text]
    text_w = max(_measure_text_width_px(l, fs, font_path) for l in use_lines)
    box_w = min(int(text_w) + 2 * pad_x, tw - 40)
    box_h = int(fs * 1.2 * len(use_lines)) + 2 * pad_y
    x = max(0, (tw - box_w) // 2)
    y = y_top if y_top is not None else max(0, y_centre - box_h // 2)
    s = f"drawbox=x={x}:y={y}:w={box_w}:h={box_h}:color=black@{alpha}:t=fill"
    if enable:
        s += f":enable='{enable}'"
    return s


def _headline_background_filter(tw: int, th: int, style: str, pos: str,
                                fit_fs: int, lines: list[str], font_path,
                                enable: str) -> str | None:
    """The dark background behind the headline text — the bar/band the
    preview shows. ASS BorderStyle 3 opaque boxes do NOT render in
    this libass build (same as the end card/tag), so the background is
    a drawbox, drawn UNDER the headline subtitles step and time-gated
    to the headline's span (``enable``). The background follows the
    STYLE (bold_bar: a padded bar; lower_third: a full-width band;
    big_centre: none — its look is plain text) and sits at the
    EFFECTIVE position (top / centre / bottom). Batch 9: without this
    the preview's bar/band would be a lie — the burn had no bar at
    all. Returns None when the style has no background.
    """
    if style == "big_centre" or not lines:
        return None
    line_h = int(fit_fs * 1.2 * len(lines))
    if style == "lower_third":
        # Full-width band (the preview's band), placed at the position.
        if pos == "top":
            y, h = 120 - 16, line_h + 32
        elif pos == "centre":
            h = line_h + 32
            y = th // 2 - h // 2
        else:  # bottom — to the bottom edge, like the preview
            y = th - 40 - line_h - 16
            h = th - y
        return (f"drawbox=x=0:y={max(0, y)}:w={tw}:h={h}:color=black@0.7"
                f":t=fill:enable='{enable}'")
    # bold_bar: a padded bar around the text.
    if pos == "top":
        y_top = 120 - 20
    elif pos == "centre":
        y_top = th // 2 - (line_h + 40) // 2
    else:  # bottom — the text's bottom edge sits 40px above the frame
        y_top = th - 40 - line_h - 20
    return _text_box_filter(
        tw, " ".join(lines), fit_fs, 0, pad_x=40, pad_y=20, enable=enable,
        font_path=font_path, lines=lines, y_top=y_top, alpha=0.7)


def _progress_bar_source(tw: int, duration: float) -> str:
    """The filter chain that generates the progress bar stream.

    A brand-violet colour source (``tw`` x 8px, 30fps) whose ALPHA
    grows with time via geq — the one filter on this ffmpeg build
    that genuinely evaluates per frame. drawbox's ``t`` does NOT
    animate here (verified 2026-11-25: a drawbox width of
    ``iw*t/20`` stayed full-width at every frame, and crop
    re-evaluates its width once at config time), so a static bar
    would be a fake — this geq bar was measured growing 54px at 1s,
    270px at 5s, 810px at 15s, 1026px at 19s on a 20s 1080px clip.
    The bar is overlaid at the bottom edge (``overlay=0:H-8``) as the
    LAST step, after captions and headline, so it never covers text.
    """
    return (
        f"color=c={PROGRESS_BAR_COLOUR}:s={tw}x{PROGRESS_BAR_HEIGHT}:r=30:"
        f"d={duration:.3f},format=rgba,"
        f"geq=r=139:g=92:b=246:"
        f"a='if(lt(X,{tw}*T/{duration:.3f}),255,0)'[bar]"
    )


# Batch 9 — OST position. The headline's position is its own
# setting (``ost_position``), INDEPENDENT of the headline style
# (style = look, position = where). An explicit position wins; when
# the setting is absent (old jobs, old presets) the style's historic
# default applies, so old jobs render exactly as before.
OST_POSITION_DEFAULTS = {"bold_bar": "top", "lower_third": "bottom",
                         "big_centre": "centre"}


def effective_ost_position(style: str, position: str | None) -> str:
    """The headline's render position: an explicit top/centre/bottom
    wins, otherwise the style's historic default (bold_bar top,
    lower_third bottom, big_centre centre)."""
    if position in ("top", "centre", "bottom"):
        return position
    return OST_POSITION_DEFAULTS.get(
        style if style in HEADLINE_STYLES else "bold_bar", "top")


def _wrap_text_lines(text: str, fs: int, max_width: float,
                     font_path=None) -> list[str]:
    """Greedy word wrap of ``text`` at ``fs`` (real font measurement),
    each line <= ``max_width``. A single word longer than max_width
    stays on its own line (the caller shrinks the size for it)."""
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if not cur or _measure_text_width_px(trial, fs, font_path) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _balance_two_lines(words: list[str], fs: int, max_width: float,
                       font_path=None) -> list[str]:
    """Split ``words`` into two lines with near-equal measured widths
    (both <= max_width). Falls back to the greedy wrap when no split
    satisfies both lines."""
    if len(words) < 2:
        return [" ".join(words)]
    best: tuple[float, list[str]] | None = None
    for i in range(1, len(words)):
        l1, l2 = " ".join(words[:i]), " ".join(words[i:])
        w1 = _measure_text_width_px(l1, fs, font_path)
        w2 = _measure_text_width_px(l2, fs, font_path)
        if w1 > max_width or w2 > max_width:
            continue
        gap = abs(w1 - w2)
        if best is None or gap < best[0]:
            best = (gap, [l1, l2])
    if best is not None:
        return best[1]
    return _wrap_text_lines(" ".join(words), fs, max_width, font_path)


def _fit_text_block(text: str, fs: int, max_width: float, max_lines: int = 2,
                    min_fs: int = 24, font_path=None) -> tuple[int, list[str]]:
    """Largest font size <= ``fs`` at which ``text`` wraps to at most
    ``max_lines`` lines of <= ``max_width`` each, and the wrapped
    lines (balanced when there are two). Shrinks toward ``min_fs``;
    a single word longer than max_width at min_fs stays on one line
    at min_fs (libass then wraps it; the floor keeps it readable).
    Returns (fitted_fs, lines) — fitted_fs == fs when it fits as-is.
    Batch 9: the no-overflow guarantee for OST (headline, tag, end
    card) — the same measured-fit idea Batch 6 gave captions."""
    if not text or not text.split():
        return fs, [text] if text else []
    lo, hi = min_fs, fs
    best_fs = min_fs
    best_lines = _wrap_text_lines(text, min_fs, max_width, font_path)
    while lo <= hi:
        mid = (lo + hi) // 2
        lines = _wrap_text_lines(text, mid, max_width, font_path)
        if (len(lines) <= max_lines and all(
                _measure_text_width_px(l, mid, font_path) <= max_width
                for l in lines)):
            best_fs, best_lines = mid, lines
            lo = mid + 1
        else:
            hi = mid - 1
    if len(best_lines) == 2:
        best_lines = _balance_two_lines(text.split(), best_fs, max_width,
                                        font_path)
    return best_fs, best_lines


def write_headline_ass(text: str | None, duration: float, ass_path: Path,
                       tw: int, th: int, style: str = "bold_bar",
                       persistent: bool = False,
                       animation: str = "none",
                       end_card_text: str | None = None,
                       keyword_popups: list[dict] | None = None,
                       lower_third_text: str | None = None,
                       position: str | None = None) -> bool:
    """Write a minimal ASS file with the on-screen-text events.

    The headline (``text``) is shown for the first 4 seconds of the
    clip only — unless ``persistent`` is on, when it stays up for the
    FULL clip. Batch 2 styles (per-job setting ``headline_style``;
    unknown values fall back to "bold_bar", the look every job used
    before Batch 2):
    - "bold_bar": top-centre, huge bold white on a translucent bar
      (the original look; MarginV 120).
    - "lower_third": a bottom band (opaque box, Alignment 2, MarginV
      40) — sits below bottom captions (MarginV 140), so the two stack
      instead of colliding.
    - "big_centre": very large, vertically centred (Alignment 5) —
      the clip's hook as a title card. Middle captions drop to 62%
      while it shows (see _caption_align_mv), so they never overlap
      it — the guard is positional, not time-based, so it holds for
      the persistent headline too.
    A single very long word is scaled down (auto-fit) so it cannot
    overflow the frame; ordinary text wraps as before.

    Batch 9 (position + measured fit + static OST):
    - ``position`` ("top"/"centre"/"bottom", None = the style's
      historic default) moves the headline INDEPENDENTLY of the
      style — style is the look, position is where it sits. The
      caption collision guard follows the effective position, not
      just big_centre (see _caption_align_mv).
    - The headline wraps to at most 2 balanced lines and shrinks
      until it fits the frame width (measured with the style's real
      font); the end card gets the same 2-line treatment and the
      lower-third tag fits on one line. Nothing overflows, at any
      position or style.
    - OST is STATIC, always (user rule): render_clip passes
      animation="none" regardless of the stored setting; the
      parameter stays so old callers do not break.

    Batch 7 (whole-clip on-screen text) — all optional, all off by
    default, so a call with no extras is byte-identical to before:
    - ``animation`` ("none"/"slide"/"fade"/"pop") is the headline's
      ENTRANCE only (first 300ms for slide/fade, 150ms for pop).
      slide moves 90px onto the style's alignment anchor (the point
      libass pins the text to); fade is \\fad(300,0); pop is the
      60%->100% scale ramp Batch 6 uses for TikTok Bold phrases.
      libass has no easing curves, so the slide is linear.
    - ``end_card_text`` renders a centred card with that exact text
      in the LAST 2 seconds. The headline — persistent or not — ends
      at duration-2 when an end card is set, so the two centred
      cards never stack; a clip shorter than 2s cannot happen
      (duration_min is 5s). The card's dark background is a drawbox
      in render_clip (_text_box_filter): this libass build does not
      render ASS BorderStyle 3 opaque boxes (verified 2026-11-25),
      so the style carries an outline only and the box is drawn
      under the text.
    - ``keyword_popups`` (from derive_keyword_popups) renders each
      word LARGE (yellow, thick outline) at Alignment 8, MarginV
      28% — centre-above the captions, so it never covers them — for
      1.0s at its spoken moment, with the pop entrance.
    - ``lower_third_text`` renders a persistent lower-third tag for
      the FULL clip: bottom-centre, MarginV 260 — above the bottom
      captions (MarginV 140) and above the lower_third headline band
      (MarginV 40), so it never covers either; on split layouts the
      captions sit on the divider, far above the tag. The text is the
      user's own words, never derived or translated. Like the end
      card, its dark band is a drawbox in render_clip (same libass
      BorderStyle 3 limitation).
    Returns False when there is nothing to show at all (no headline,
    no end card, no pop-ups, no tag).
    """
    if duration <= 0:
        return False
    style = style if style in HEADLINE_STYLES else "bold_bar"
    # Batch 9 FONT MAP: this headline style's own typeface (shared by
    # the end card, keyword pop-ups and lower-third tag — they are
    # parts of the one OST sample, so one font per sample).
    h_family, h_bold, h_italic, h_file = HEADLINE_FONT_MAP[style]
    h_font_path = FONTS_DIR / h_file
    animation = animation if animation in OST_ANIMATIONS else "none"
    # Headline span: first 4s, or the full clip when persistent. An
    # end card always replaces it for the last 2s.
    headline_end: float | None = None
    if text:
        headline_end = duration if persistent else min(4.0, duration)
        if end_card_text:
            headline_end = min(headline_end, max(0.0, duration - 2.0))
        if headline_end <= 0:
            headline_end = None
    if style == "lower_third":
        fs = 64 if tw >= 1080 else 48
        border, outline_w, shadow = 3, 2, 0
        back = "&HCC000000"
    elif style == "big_centre":
        fs = 110 if tw >= 1080 else 80
        border, outline_w, shadow = 1, 5, 1
        back = "&H80000000"
    else:  # bold_bar
        fs = 84 if tw >= 1080 else 60
        border, outline_w, shadow = 1, 4, 0
        back = "&H80000000"
    # Batch 9: position is independent of style — the style sets the
    # look (size, outline, colours), the position sets where it sits.
    # The defaults keep the old geometry exactly (bold_bar top 8/120,
    # lower_third bottom 2/40, big_centre centre 5/0).
    pos = effective_ost_position(style, position)
    if pos == "centre":
        align, mv = 5, 0
    elif pos == "bottom":
        align, mv = 2, 40
    else:  # top
        align, mv = 8, 120
    # Entrance animation prefix for the headline event. \move's
    # coordinates are the position's alignment anchor: (tw/2, 120) for
    # the top, (tw/2, th-40) for the bottom band (slides UP from
    # below), (tw/2, th/2) for the centred card. Batch 9: render_clip
    # always passes animation="none" (OST is static, always — user
    # rule); the parameter stays for old callers and tests.
    anim = ""
    if headline_end is not None and animation == "slide":
        if pos == "bottom":
            x2, y2 = tw // 2, th - 40
            x1, y1 = x2, y2 + 90
        elif pos == "centre":
            x2, y2 = tw // 2, th // 2
            x1, y1 = x2, y2 - 90
        else:
            x2, y2 = tw // 2, 120
            x1, y1 = x2, max(0, y2 - 90)
        anim = f"{{\\move({x1},{y1},{x2},{y2},0,300)}}"
    elif headline_end is not None and animation == "fade":
        anim = "{\\fad(300,0)}"
    elif headline_end is not None and animation == "pop":
        anim = "{\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)}"
    # Batch 9 measured fit (no-overflow): the headline wraps to at
    # most 2 balanced lines and shrinks until it fits the frame width
    # — at every position and style. The old code only fitted the
    # longest single word; a long headline could still wrap to many
    # lines and crowd the frame. The end card and the tag get the same
    # treatment (2 lines / 1 line); a keyword pop-up is one word, so
    # it fits like the old longest-word rule.
    fs_prefix = ""
    headline_lines: list[str] = []
    if text:
        fit_fs, headline_lines = _fit_text_block(
            text, fs, tw - 120, max_lines=2, min_fs=28, font_path=h_font_path)
        if fit_fs != fs:
            fs_prefix = f"{{\\fs{fit_fs}}}"
    pop_fs = 120 if tw >= 1080 else 84
    pop_mv = int(th * 0.28)
    tag_fs = 40 if tw >= 1080 else 30
    card_fs = 96 if tw >= 1080 else 68
    card_prefix = ""
    card_lines: list[str] = []
    if end_card_text:
        card_fit_fs, card_lines = _fit_text_block(
            end_card_text, card_fs, tw - 120, max_lines=2, min_fs=36,
            font_path=h_font_path)
        if card_fit_fs != card_fs:
            card_prefix = f"{{\\fs{card_fit_fs}}}"
    tag_prefix = ""
    if lower_third_text:
        tag_fit_fs, _tag_lines = _fit_text_block(
            lower_third_text, tag_fs, tw - 120, max_lines=1, min_fs=20,
            font_path=h_font_path)
        if tag_fit_fs != tag_fs:
            tag_prefix = f"{{\\fs{tag_fit_fs}}}"
    events: list[str] = []
    if headline_end is not None and text:
        body = ("\\N".join(_ass_escape(line) for line in headline_lines)
                if headline_lines else _ass_escape(text))
        events.append(
            f"Dialogue: 0,0:00:00.00,{_fmt_ass_time(headline_end)},Headline,,0,0,0,,"
            f"{anim}{fs_prefix}{body}"
        )
    if end_card_text:
        card_body = ("\\N".join(_ass_escape(line) for line in card_lines)
                     if card_lines else _ass_escape(end_card_text))
        events.append(
            f"Dialogue: 0,{_fmt_ass_time(max(0.0, duration - 2.0))},{_fmt_ass_time(duration)},"
            f"EndCard,,0,0,0,,{card_prefix}{card_body}"
        )
    for popup in keyword_popups or []:
        s, e = popup["start"], popup["end"]
        if e <= s or s >= duration:
            continue
        pop_fit = _fit_font_size(popup["word"], pop_fs, tw - 120, h_font_path)
        pop_prefix = f"{{\\fs{pop_fit}}}" if pop_fit is not None else ""
        events.append(
            f"Dialogue: 0,{_fmt_ass_time(s)},{_fmt_ass_time(min(e, duration))},"
            f"KeywordPop,,0,0,0,,{{\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)}}"
            f"{pop_prefix}{_ass_escape(popup['word'])}"
        )
    if lower_third_text:
        events.append(
            f"Dialogue: 0,0:00:00.00,{_fmt_ass_time(duration)},LowerThirdTag,,0,0,0,,"
            f"{tag_prefix}{_ass_escape(lower_third_text)}"
        )
    if not events:
        return False
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
        f"Style: Headline,{h_family},{fs},&H00FFFFFF,&H000000FF,&H00000000,"
        f"{back},{h_bold},{h_italic},0,0,100,100,0,0,{border},{outline_w},{shadow},{align},40,40,{mv},1\n"
        # Batch 7: the end card is a centred card; keyword pop-ups
        # are large yellow on the upper-middle (Alignment 8,
        # MarginV 28%); the lower-third tag is a small band at the
        # bottom (Alignment 2, MarginV 260). NOTE: these styles use
        # BorderStyle 1 (outline), NOT BorderStyle 3 — this libass
        # build does not render opaque boxes at all (verified
        # 2026-11-25), so the card/band background is a drawbox added
        # in render_clip (_text_box_filter), drawn UNDER the text.
        f"Style: EndCard,{h_family},{card_fs},&H00FFFFFF,&H000000FF,&H00000000,"
        f"&H80000000,{h_bold},{h_italic},0,0,100,100,0,0,1,2,0,5,40,40,0,1\n"
        f"Style: KeywordPop,{h_family},{pop_fs},&H0000FFFF,&H00FFFFFF,&H00000000,"
        f"&H80000000,{h_bold},{h_italic},0,0,100,100,0,0,1,4,1,8,40,40,{pop_mv},1\n"
        f"Style: LowerThirdTag,{h_family},{tag_fs},&H00FFFFFF,&H000000FF,&H00000000,"
        f"&H80000000,{h_bold},{h_italic},0,0,100,100,0,0,1,2,0,2,40,40,260,1\n"
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
        + "\n".join(events)
        + "\n"
    )
    ass_path.write_text(header, encoding="utf-8")
    return True


def write_clip_ass(segments: list[dict], start: float, end: float,
                   style_id: str, ass_path: Path,
                   divider_y: int | None, tw: int, th: int,
                   layout: str, caption_position: str = "bottom",
                   headline_style: str = "bold_bar",
                   caption_safe_zone: bool = True,
                   ost_position: str | None = None) -> bool:
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

    # Batch 9 FONT MAP: this style's own typeface (family + Bold /
    # Italic flags + the shipped file for real measurement). Unknown
    # ids fall back to DejaVu Sans Bold, the pre-Batch-9 font.
    font_family, font_bold, font_italic, font_file = FONT_MAP.get(
        style_id, ("DejaVu Sans", -1, 0, "DejaVuSans-Bold.ttf"))
    font_path = FONTS_DIR / font_file

    def margin_for(font_size: int) -> tuple[int, int]:
        """(alignment, marginV) — Batch 2 caption position; "bottom"
        is the pre-Batch-2 behaviour (on the divider when split,
        lower-centre otherwise). The middle-vs-centre-headline guard
        follows the effective OST position (Batch 9)."""
        return _caption_align_mv(position, font_size, tw, th, divider_y,
                                 layout, headline_style, ost_position)

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
        real measurements of THIS style's font (Batch 9 FONT_MAP)."""
        probe = text
        if not whole_line:
            words = text.split()
            probe = max(words, key=len) if words else text
        fitted = _fit_font_size(probe, fs, max_w, font_path)
        return f"{{\\fs{fitted}}}" if fitted is not None else ""

    def fit_lines(lines: list[list[dict]], fs: int) -> str:
        """{\\fsN} prefix fitted on the LONGEST rendered line of a
        1–2 line phrase — a phrase split into two lines keeps the full
        font size (Batch 6); only a line that still overflows shrinks."""
        longest = ""
        for line in lines:
            text = " ".join(w["word"] for w in line)
            if _measure_text_width_px(text, fs, font_path) > _measure_text_width_px(longest, fs, font_path):
                longest = text
        return fit(longest, fs)

    styles: dict[str, str] = {}
    if style_id == "punchy":
        fs = 96 if big else 68
        align, mv = margin_for(fs)
        styles["Punchy"] = (
            f"Style: Punchy,{font_family},{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,{font_bold},{font_italic},0,0,100,100,0,0,1,3,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "tiktok_bold":
        # Batch 6: the classic TikTok look — phrase-based like punchy,
        # bigger, with a pop entrance on the whole phrase and the same
        # yellow keyword. The pop prefix is added per event below.
        fs = 104 if big else 76
        align, mv = margin_for(fs)
        styles["TikTokBold"] = (
            f"Style: TikTokBold,{font_family},{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,{font_bold},{font_italic},0,0,100,100,0,0,1,4,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "word_pop":
        fs = 130 if big else 92
        align, mv = margin_for(fs)
        styles["WordPop"] = (
            f"Style: WordPop,{font_family},{fs},&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,{font_bold},{font_italic},0,0,100,100,0,0,1,4,0,{align},{ml},{mr},{mv},1"
        )
    elif style_id == "title_card":
        fs = 60 if big else 44
        align, mv = (8, max(0, divider_y - 40)) if split else (8, int(th * 0.40))
        styles["Title"] = (
            f"Style: Title,{font_family},{fs},&H00000000,&H000000FF,&H00FFFFFF,"
            f"&H00FFFFFF,{font_bold},{font_italic},0,0,100,100,0,0,3,0,0,{align},{ml},{mr},{mv},1"
        )
        # The Title event is the hook title (its own spot); only the
        # CleanSubs captions follow the position setting — and "bottom"
        # keeps the established (2, 40) subtitle spot, not the divider.
        cs_align, cs_mv = ((2, 40) if position == "bottom" else
                           _caption_align_mv(position, 36, tw, th, divider_y,
                                             layout, headline_style,
                                             ost_position))
        _sub_family, _sub_bold, _sub_italic, _sub_file = TITLE_CARD_SUB_FONT
        styles["CleanSubs"] = (
            f"Style: CleanSubs,{_sub_family},36,&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,{_sub_bold},{_sub_italic},0,0,100,100,0,0,1,2,0,{cs_align},{ml},{mr},{cs_mv},1"
        )
    elif style_id == "clean_subs":
        cs_align, cs_mv = ((2, 40) if position == "bottom" else
                           _caption_align_mv(position, 36, tw, th, divider_y,
                                             layout, headline_style,
                                             ost_position))
        styles["CleanSubs"] = (
            f"Style: CleanSubs,{font_family},36,&H00FFFFFF,&H000000FF,&H00000000,"
            f"&H80000000,{font_bold},{font_italic},0,0,100,100,0,0,1,2,0,{cs_align},{ml},{mr},{cs_mv},1"
        )
    elif style_id in ("karaoke", "bounce", "typewriter", "sweep",
                      "neon", "slam", "outline", "gradient",
                      "kinetic", "glow_pop",
                      "word_zoom", "word_fade", "highlight_sweep",
                      "bounce_in", "glitch_pop",
                      "reels_clean", "shorts_minimal",
                      "comic", "marker"):
        # (name, fs_big, fs_small, primary, secondary, outline_colour,
        #  back_colour, bold, border_style, outline, shadow, italic)
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
        # Batch 9: comic and marker are the only italic styles
        # (12th column -1) — the slant is the playful/handwritten
        # read. Comic's pink shadow is its BackColour; Marker's
        # spoken word is orange (MARKER_ACCENT, per-word prefix
        # below) with an alternating tilt, over a plain black
        # outline + shadow.
        _NEW_STYLE_PARAMS = {
            "karaoke": ("Karaoke", 96, 68, "&H0000FFFF", "&H00FFFFFF",
                        "&H00000000", "&H80000000", -1, 1, 3, 0, 0),
            "bounce": ("Bounce", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                       "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "typewriter": ("Typewriter", 72, 54, "&H00FFFFFF", "&H0000FFFF",
                           "&H00000000", "&H80000000", -1, 1, 3, 0, 0),
            "sweep": ("Sweep", 96, 68, "&H00FFFFFF", "&H0000FFFF",
                      "&H00000000", "&H80000000", -1, 1, 3, 0, 0),
            "neon": ("Neon", 100, 72, "&H00FFFF00", "&H00FF00FF",
                     "&H00FF00FF", "&H00FF00FF", -1, 1, 4, 2, 0),
            "slam": ("Slam", 130, 92, "&H00FFFFFF", "&H0000FFFF",
                    "&H00000000", "&H80000000", -1, 1, 5, 1, 0),
            "outline": ("Outline", 110, 78, "&HFF000000", "&H0000FFFF",
                        "&H00FFFFFF", "&H80000000", -1, 1, 4, 0, 0),
            "gradient": ("Gradient", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                         "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "kinetic": ("Kinetic", 100, 72, "&H00FFFFFF", "&H0000FFFF",
                        "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "glow_pop": ("GlowPop", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                         "&H00000000", "&H0000CCFF", -1, 1, 4, 2, 0),
            "word_zoom": ("WordZoom", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "word_fade": ("WordFade", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "highlight_sweep": ("HighlightSweep", 96, 68, "&H00000000",
                                "&H00FFFFFF", "&H00000000", "&H0000FFFF",
                                -1, 3, 0, 0, 0),
            "bounce_in": ("BounceIn", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                          "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            "glitch_pop": ("GlitchPop", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                           "&H00000000", "&H80000000", -1, 1, 4, 0, 0),
            # Batch 6: reels_clean is smaller, clean white with a soft
            # shadow (outline 2, shadow 1); shorts_minimal is the
            # smallest, most restrained — thin outline, no shadow, no
            # entrance. Both are word-at-a-time like the other
            # animated styles, with no entrance override.
            "reels_clean": ("ReelsClean", 84, 60, "&H00FFFFFF", "&H0000FFFF",
                            "&H00000000", "&H80000000", -1, 1, 2, 1, 0),
            "shorts_minimal": ("ShortsMinimal", 72, 52, "&H00FFFFFF",
                               "&H0000FFFF", "&H00000000", "&H80000000",
                               -1, 1, 1, 0, 0),
            # Batch 9 (2026-11-25): Comic Pop — playful slanted
            # words, white on black outline with a bright pink shadow
            # (BackColour #FF6B9D); the spoken word takes a bright
            # accent that cycles mint / yellow / cyan (COMIC_PALETTE,
            # applied per word below). Marker — casual slanted
            # handwritten words, black outline + shadow; the spoken
            # word turns orange (#FB923C, applied per word below) and
            # lands with an alternating tilt (see the prefix). Both
            # italic (-1 in the new 12th column).
            "comic": ("Comic", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                      "&H00000000", "&H009D6BFF", -1, 1, 3, 2, -1),
            "marker": ("Marker", 110, 78, "&H00FFFFFF", "&H0000FFFF",
                       "&H00000000", "&H80000000", -1, 1, 3, 1, -1),
        }
        (sname, fs_big, fs_small, primary, secondary, outline_c, back_c,
         bold, border, outline_w, shadow, italic) = _NEW_STYLE_PARAMS[style_id]
        fs = fs_big if big else fs_small
        align, mv = margin_for(fs)
        styles[sname] = (
            f"Style: {sname},{font_family},{fs},{primary},{secondary},"
            f"{outline_c},{back_c},{font_bold},{font_italic},0,0,100,100,0,0,{border},"
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
                    lines = _phrase_lines(phrase, fs, max_w, font_path)
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
                    lines = _phrase_lines(phrase, fs, max_w, font_path)
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
                      "reels_clean", "shorts_minimal",
                      "comic", "marker"):
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
                lines = _phrase_lines(phrase, fs, max_w, font_path)
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
                lines = _phrase_lines(phrase, fs, max_w, font_path)
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
                                         "glitch_pop", "comic", "marker") else 0.25)
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
                elif style_id == "comic":
                    # Playful wobble + a bright accent that cycles
                    # mint / yellow / cyan word to word: the word on
                    # screen IS the spoken word (one word per event),
                    # so each spoken word takes the next accent. The
                    # pink shadow is the style's BackColour (steady).
                    prefix = ("{\\1c&H%s&\\fscx0\\fscy0\\frz-8"
                              "\\t(0,150,\\fscx115\\fscy115\\frz5)"
                              "\\t(150,300,\\fscx100\\fscy100\\frz0)}"
                              % COMIC_PALETTE[i % len(COMIC_PALETTE)])
                elif style_id == "marker":
                    # The spoken word turns orange and lands with an
                    # alternating tilt (-3° / +3° word to word) — the
                    # uneven handwritten read. A marker stroke lands
                    # flat, so the scale pop has no rotation of its
                    # own; the tilt is the static \\frz.
                    prefix = ("{\\1c&H%s&\\frz%d\\fscx0\\fscy0"
                              "\\t(0,150,\\fscx112\\fscy112)"
                              "\\t(150,280,\\fscx100\\fscy100)}"
                              % (MARKER_ACCENT, -3 if i % 2 == 0 else 3))
                elif style_id == "neon":
                    # Pink / cyan alternate word to word; the magenta
                    # glow is the style's BackColour (steady in the
                    # burn) so both colours glow.
                    prefix = ("{\\1c&H%s&}"
                              % NEON_PALETTE[i % len(NEON_PALETTE)])
                else:  # outline
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
                    lines = _phrase_lines(phrase, fs, max_w, font_path)
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
                       cuts: list[tuple[float, float]], out_path: Path,
                       quality: str = "standard") -> Path:
    """Re-encode [start, end] with the cut spans removed (trim + concat,
    video + audio together so A/V stay in sync). CRF 18 for the
    intermediate, to limit the double-encode loss before the final
    render. Returns out_path. Raises on ffmpeg failure — the caller
    falls back to the uncleaned clip and says so in the note.
    Batch 13: the intermediate follows the job's quality mode, so a
    High job is not silently capped at CRF 18 before the final render."""
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
    preset, crf = quality_encode_params({"quality": quality})
    proc = run([FFMPEG, "-y", "-v", "error", "-i", str(source),
                "-filter_complex", fc, "-map", "[cv]", "-map", "[ca]",
                "-c:v", "libx264", "-preset", preset, "-crf", crf,
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
        return f"crop={cw}:ih:'{x}':0,{scale_expr(tw, th)}"
    ch = f"iw/{target_ar:.6f}"
    y = f"min(max({_pan_expr(face_track, 1)}*ih-({ch})/2,0),ih-({ch}))"
    return f"crop=iw:{ch}:0:'{y}',{scale_expr(tw, th)}"


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


def _tracked_closeup_crop(box, sw: int, sh: int, face_track: list[tuple],
                          tw: int = 1080, th: int = 1920) -> str | None:
    """Face-closeup crop following the trajectory (Batch 9): same tight
    size as _face_closeup_crop (from the median face), but the window
    moves with the face instead of sitting on the median position.
    None when no box (the caller falls back to centre crop)."""
    if box is None:
        return None
    cw, ch = _closeup_size(box, sw, sh, tw, th)
    x = f"min(max({_pan_expr(face_track, 0)}*iw-{cw}/2,0),iw-{cw})"
    y = f"min(max({_pan_expr(face_track, 1)}*ih-{ch}/2,0),ih-{ch})"
    # Same quoting rule as _tracked_crop: the if()/min()/max()
    # expressions hold commas, so both offsets are single-quoted.
    return f"crop={cw}:{ch}:'{x}':'{y}'"


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
        return f"crop=ih*{target_ar:.6f}:ih,{scale_expr(tw, th)}"
    return f"crop=iw:iw/{target_ar:.6f},{scale_expr(tw, th)}"


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


def _closeup_size(box, sw: int, sh: int, tw: int = 1080, th: int = 1920) -> tuple[int, int]:
    """Tight crop size around a detected face box (Batch 9
    face_closeup; Batch 13: parameterised by the TARGET canvas):
    ~2.2x the face width, clamped to 25–60% of the frame width so a
    huge face does not collapse the crop and a tiny face still fills
    the frame. Height follows the TARGET ratio — it was hardcoded
    9:16, and a 9:16 crop scaled to a 16:9/1:1 frame would stretch —
    clamped to the frame height (width re-derived so the ratio stays
    exact). At 9:16 the numbers are unchanged."""
    _fx, _fy, fw, _fh = box
    cw = int(min(max(fw * sw * 2.2, sw * 0.25), sw * 0.6))
    ch = int(cw * th / tw)
    if ch > sh:
        ch = sh
        cw = int(ch * tw / th)
    return cw, ch


def _face_closeup_crop(box, sw: int, sh: int, tw: int = 1080, th: int = 1920) -> str | None:
    """Static tight crop centred on a detected face box (fx, fy, fw, fh
    as fractions of the frame) — the face fills roughly half the frame
    width. None when no box (the caller falls back to centre crop)."""
    if box is None:
        return None
    fx, fy, _fw, _fh = box
    cw, ch = _closeup_size(box, sw, sh, tw, th)
    cx = int(min(max(fx * sw - cw / 2, 0), max(0, sw - cw)))
    cy = int(min(max(fy * sh - ch / 2, 0), max(0, sh - ch)))
    return f"crop={cw}:{ch}:{cx}:{cy}"


def build_layout_chains(source: Path, sw: int, sh: int, tw: int, th: int,
                        ratio: str, layout: str, start: float, duration: float,
                        face_box=_DETECT_FACE, face_track=None,
                        face_tracking=False) -> list[str]:
    """FFmpeg filter chains turning [0:v] into [v0] for the job's layout.

    Layouts (Batch 13: per-ratio — see LAYOUTS_BY_RATIO. The six
    canvas-agnostic layouts render on every ratio; the four vertical
    compositions render on portrait frames (9:16 and 4:5) only. An
    unknown layout, or one that does not apply to the ratio, falls
    back to centre crop):
      * split — streamer top / gameplay bottom, true split (864 + 1056).
      * pip_facecam — gameplay full-frame, facecam inset overlaid top-right.
      * blur_fill — blurred cover background + sharp contain-fit video.
      * streamer_full — the streamer region fills the whole frame.
      * gradient_fill (Batch 9) — Aurora gradient background (deep navy
        -> violet -> fuchsia, the picker's own palette) + sharp
        contain-fit video centred on it. No blurred video anywhere.
      * stacked (Batch 9) — video cover-cropped to the top ~65% of the
        frame, dark slate panel below for the headline/captions area.
      * letterbox (Batch 9) — video full width, cinematic black bars
        top + bottom (centred vertically, no stretch).
      * face_closeup (Batch 9) — tight crop around the speaker's
        face (~2.2x the face width, in the target ratio), following the face trajectory when
        face tracking is on; no face -> honest centre-crop fallback.
      * framed (Batch 9) — video cover-cropped to the target ratio,
        inset with a 30px margin on a dark slate frame + a thin light
        border around it.
    ``face_box`` is a detected (fx, fy, fw, fh) box, None for "no face"
    (the face layouts fall back honestly), or the default sentinel to
    detect it here from 5 samples across the clip window. Callers and
    tests may inject a box instead of running detection.
    Batch 1 face tracking: when ``face_tracking`` is on and
    ``face_track`` holds a trajectory, the crops that centre on the
    subject follow it over time instead of sitting on the median box
    (split top inset, pip base, streamer_full inset, centre crop,
    face_closeup). gradient_fill, stacked, letterbox, framed and
    blur_fill have no crop to track — they are unaffected. When tracking is
    on but no trajectory exists, the static behaviour below is used
    unchanged and the caller reports the fallback.
    """
    layout = (layout or "center_crop").lower()
    # Batch 13: never render a composition the canvas cannot do —
    # a layout that does not apply to this ratio becomes centre crop
    # (logged, so the job note can say so honestly).
    resolved = resolve_layout(layout, ratio)
    if resolved != layout:
        log.warning("layout %s does not apply to %s; falling back to centre crop.",
                    layout, ratio)
    layout = resolved
    box = None
    tracked = bool(face_tracking) and bool(face_track)
    if layout in ("split", "pip_facecam", "streamer_full", "face_closeup"):
        if tracked:
            # Median face from the trajectory — the static decisions
            # (inset size, the split bottom-shift rule) use it; the
            # crops themselves follow the trajectory.
            box = _median_face_box(face_track)
        else:
            box = (detect_face_box(
                source, [start + duration * f for f in (0.15, 0.3, 0.5, 0.7, 0.85)], sw, sh)
                if face_box is _DETECT_FACE else face_box)

    if layout == "split":
        # Streamer-top / gameplay-bottom, TRUE split (reference style):
        # top = the facecam inset, full-fit; bottom = gameplay, full-fit,
        # aspect-matched (no squeeze/stretch) and shifted away from the
        # facecam inset when it would overlap. Top panel 45% / bottom
        # 55% of the frame height (864 + 1056 at 9:16 1080p) —
        # parameterised by th so the same composition renders on 4:5
        # (607 + 743) instead of hardcoding the 9:16 frame.
        top_h, bot_h = int(th * 0.45), th - int(th * 0.45)
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
                f"[ts]{top_crop},{scale_expr(tw, top_h)}[top];"
                f"[bs]{bot_crop},{scale_expr(tw, bot_h)}[bot];"
                f"[top][bot]vstack[v0]"]

    if layout == "pip_facecam":
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
                f"[face]{face_crop},{scale_expr(ow, oh)},"
                f"drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=4[fg];"
                f"[bg][fg]overlay={ox}:{oy}[v0]"]

    if layout == "blur_fill":
        # Landscape source in a vertical frame: blurred cover background
        # with the sharp video contain-fit on top. No detection needed.
        return [f"[0:v]split=2[bg][fg];"
                f"[bg]{scale_expr(tw, th, 'force_original_aspect_ratio=increase')},"
                f"crop={tw}:{th},gblur=sigma=40[bg2];"
                f"[fg]{scale_expr(tw, th, 'force_original_aspect_ratio=decrease')}[fg2];"
                f"[bg2][fg2]overlay=(W-w)/2:(H-h)/2[v0]"]

    if layout == "streamer_full":
        # The streamer region fills the whole frame (cover-scaled, no
        # stretch). No face found -> the top 45% of the frame instead.
        top_crop = (_tracked_inset_crop(box, sw, sh, face_track)
                    if tracked else _facecam_inset_crop(box, sw, sh))
        if top_crop is None:
            log.info("streamer_full: no face detected in this clip window; "
                     "using the top 45% of the frame.")
            top_crop = "crop=iw:ih*0.45:0:0"
        return [f"[0:v]{top_crop},{scale_expr(tw, th, 'force_original_aspect_ratio=increase')},"
                f"crop={tw}:{th}[v0]"]

    if layout == "gradient_fill":
        # Aurora gradient background (the picker's own palette: deep
        # navy -> violet -> fuchsia) with the sharp video contain-fit
        # on top — a smooth gradient, never blurred video. The
        # gradients source generates its own frames; the render
        # command's -t caps the output duration.
        return [f"gradients=size={tw}x{th}:nb_colors=3:c0=1e1b4b:c1=7c3aed:"
                f"c2=db2777:x0={tw // 2}:y0=0:x1={tw // 2}:y1={th}[bg];"
                f"[0:v]{scale_expr(tw, th, 'force_original_aspect_ratio=decrease')}[fg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]"]

    if layout == "stacked":
        # Podcast stack: video cover-cropped to the top ~65% of the
        # frame (1248px), dark slate panel below for the
        # headline/captions area. Captions at the bottom sit on the
        # panel by design.
        top_h = int(th * 0.65)
        return [f"[0:v]{scale_expr(tw, top_h, 'force_original_aspect_ratio=increase')},"
                f"crop={tw}:{top_h},pad={tw}:{th}:0:0:color=0x0f172a[v0]"]

    if layout == "letterbox":
        # Cinematic black bars: video full width, centred vertically
        # (no stretch, no crop of the width). scale=1080:-2 keeps the
        # source aspect; pad centres it with black top + bottom.
        return [f"[0:v]{scale_expr(tw, '-2')},"
                f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black[v0]"]

    if layout == "face_closeup":
        # Tight 9:16 crop around the speaker's face, following the
        # trajectory when face tracking is on. No face found -> honest
        # centre-crop fallback (same as pip_facecam).
        closeup = (_tracked_closeup_crop(box, sw, sh, face_track, tw, th)
                   if tracked else _face_closeup_crop(box, sw, sh, tw, th))
        if closeup is None:
            log.warning("face_closeup: no face detected in this clip window; "
                        "falling back to centre crop.")
            return [f"[0:v]{_center_crop_filter(sw, sh, tw, th)}[v0]"]
        return [f"[0:v]{closeup},{scale_expr(tw, th)}[v0]"]

    if layout == "framed":
        # Video cover-cropped to the target ratio, inset with a 30px
        # side / ~53px top-bottom margin on a dark slate frame, thin
        # light border around the video rect. (Batch 13: the inset was
        # hardcoded 1020x1813 for 9:16 1080p — the same margins now
        # derive from the target size, so the frame fits 16:9/1:1/4:5
        # too; at 9:16 the numbers are unchanged.)
        inner_w, inner_h = tw - 60, th - 107
        frame_x, frame_y = (tw - inner_w) // 2, (th - inner_h) // 2
        return [f"[0:v]{_center_crop_filter(sw, sh, inner_w, inner_h)},"
                f"pad={tw}:{th}:{frame_x}:{frame_y}:color=0x0f172a,"
                f"drawbox=x={frame_x - 3}:y={frame_y - 3}:w={inner_w + 6}:"
                f"h={inner_h + 6}:color=white@0.85:t=4[v0]"]

    # Centre crop (crop-to-cover for the requested ratio), no stretch.
    # With face tracking on, the crop follows the trajectory.
    centre = (_tracked_crop(sw, sh, tw, th, face_track)
              if tracked else _center_crop_filter(sw, sh, tw, th))
    return [f"[0:v]{centre}[v0]"]


def render_clip(source: Path, clip: dict, settings: dict,
                segments: list[dict], out_path: Path,
                source_info: dict, job_dir: Path,
                music_bed_path: Path | None = None) -> Path:
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
    # Batch 11: the plan's export cap (720p Free / 1080p paid) —
    # the short side of the frame, set server-side from the plan.
    tw, th = capped_target_size(ratio, settings.get("max_export_height"))
    layout = (settings.get("layout") or "center_crop").lower()
    captions_on = bool(settings.get("captions_enabled", True))
    start, end = clip["start"], clip["end"]
    duration = end - start
    stats = {"silence_trimmed": 0.0, "fillers_cut": 0, "zoom_moments": 0,
             "face_tracked": False, "face_fallback": None, "cleaning_skipped": None,
             # Batch 7: whole-clip on-screen text (see the OST block
             # below); the job note reads these, never the settings.
             "ost_persistent": False, "ost_animation": "none",
             "end_card": False, "keyword_popups": 0,
             "keyword_popups_on": False, "lower_third": False,
             "progress_bar": False,
             # Batch 11: export tier actually rendered (the job note
            # reads these, never the settings) — the rendered frame
            # size and whether the plan cap shrank it.
            "export_size": f"{tw}x{th}",
            "export_capped": capped_target_size(ratio, settings.get("max_export_height")) != RATIO_TARGETS.get(ratio, (1080, 1920)),
            # Batch 9: colour grade applied ("none" when ungraded);
             # the job note reads this, never the settings. Batch 13:
             # the reason the auto picker gave (None for a manual
             # look) and the measured frame stats it decided on.
             "colour_grade": "none",
             "colour_grade_reason": None,
             "colour_grade_stats": {},
            # Batch 13: quality mode actually rendered (the job note
            # reads these, never the settings).
            "quality_mode": (settings.get("quality") or "standard").lower(),
            "quality_encode": None,
             # Batch 9: music bed + SFX applied to this clip (the job
             # note reads these, never the settings).
             "music_bed": None,
             "music_bed_skipped": None,
             "sfx_counts": {"whoosh": 0, "pop": 0},
             # Batch 9: OST language — the headline language asked
             # for, and whether its translation landed ("none" /
             # "same" / "ok" / "failed"; the job note reads these).
             "ost_language": "source",
             "ost_translation": "none"}
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
                    clean_clip_segment(source, start, end, cuts, cleaned_path,
                                       quality=settings.get("quality"))
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
    # Batch 7: whole-clip on-screen text — all default OFF / "none" /
    # empty (a missing key means the default, so jobs made before
    # Batch 7 render exactly as before). end_card_text falls back to
    # "Follow for more" when the card is on but no text was given;
    # lower_third_text is empty = OFF.
    ost_persistent = bool(settings.get("ost_persistent", False))
    # Batch 9: OST is STATIC, always (user rule). The stored
    # ost_animation is accepted for old presets but never honoured —
    # the headline is written with animation="none".
    ost_animation = "none"
    # Batch 9: OST position is its own setting, independent of the
    # headline style; absent = the style's historic default.
    ost_position = settings.get("ost_position") or None
    ost_pos = effective_ost_position(headline_style, ost_position)
    h_font_path = FONTS_DIR / HEADLINE_FONT_MAP[headline_style][3]
    end_card = bool(settings.get("end_card", False))
    end_card_text = None
    if end_card:
        end_card_text = (str(settings.get("end_card_text") or "")
                         .strip()[:40] or OST_END_CARD_DEFAULT)
    keyword_popups_on = bool(settings.get("keyword_popups", False))
    lower_third_text = (str(settings.get("lower_third_text") or "")
                        .strip()[:40] or None)
    progress_bar = bool(settings.get("progress_bar", False))
    captions_path: Path | None = None
    captions_is_ass = False
    if captions_on:
        if style_id == "classic":
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.srt"
            if write_clip_srt(render_segments, render_start, render_end, candidate):
                captions_path = candidate
        else:
            candidate = job_dir / f"clip_{uuid.uuid4().hex}.ass"
            # Batch 13: the divider is the split top-panel height
            # (45% of the frame — 864 at 9:16 1080p, 607 at 4:5).
            divider = int(th * 0.45) if layout == "split" else None
            if write_clip_ass(render_segments, render_start, render_end, style_id, candidate,
                              divider, tw, th, layout, caption_position, headline_style,
                              caption_safe_zone, ost_position=ost_position):
                captions_path = candidate
                captions_is_ass = True

    # On-screen text: a short headline burned onto the clip, derived
    # from this clip's own analysis (campaign text verbatim first,
    # else its transcript; silent windows get none — never invented).
    # It goes in its own ASS file so it works whether captions are
    # ASS, classic SRT, or off entirely.
    # Batch 7: the same file also carries the whole-clip OST — the
    # persistent headline, the end card, keyword pop-ups and the
    # lower-third tag. The end card, pop-ups and tag are INDEPENDENT
    # of the headline toggle: a job can have an end card, pop-ups or
    # a tag with on_screen_text off (the headline itself still needs
    # it on).
    headline_path: Path | None = None
    headline = None
    if bool(settings.get("on_screen_text", False)):
        headline = derive_on_screen_text(render_clip_view, render_segments, settings)
        if headline:
            # Batch 9: ost_language — translate the DERIVED headline
            # (campaign verbatim first, else the transcript headline)
            # into the job's headline language. The end-card text,
            # lower-third tag and keyword pop-ups are never translated.
            # Batch 12: a REQUIRED on-screen text is the user's own
            # words — it is burned verbatim and never translated.
            stats["ost_language"] = (
                settings.get("ost_language") or "source").lower()
            required_ost = _required_campaign_ost(settings)
            if required_ost is not None and headline == required_ost:
                stats["ost_translation"] = "none"
            else:
                headline, stats["ost_translation"] = _translate_headline(
                    headline, settings)
            log.info("Clip %.1f-%.1fs on-screen headline: %r (style %s, "
                     "ost_language %s, translation %s)",
                     start, end, headline, headline_style,
                     stats["ost_language"], stats["ost_translation"])
        else:
            log.info("Clip %.1f-%.1fs: on-screen text on, but no headline "
                     "could be derived (no campaign text, no transcript) — "
                     "no headline burned.", start, end)
    popups: list[dict] = []
    if keyword_popups_on:
        popups = derive_keyword_popups(render_segments, render_start, render_end)
        if popups:
            log.info("Clip %.1f-%.1fs: %d keyword pop-up(s): %s",
                     start, end, len(popups),
                     ", ".join(p["word"] for p in popups))
        else:
            log.info("Clip %.1f-%.1fs: keyword pop-ups on, but no words "
                     "to pop up (silent clip) — none burned.",
                     start, end)
    if headline or end_card_text or popups or lower_third_text:
        candidate = job_dir / f"clip_{uuid.uuid4().hex}_headline.ass"
        if write_headline_ass(headline, render_duration, candidate, tw, th,
                              headline_style,
                              persistent=ost_persistent,
                              animation=ost_animation,
                              end_card_text=end_card_text,
                              keyword_popups=popups or None,
                              lower_third_text=lower_third_text,
                              position=ost_position):
            headline_path = candidate
            stats["ost_persistent"] = bool(ost_persistent and headline)
            stats["ost_animation"] = ost_animation
            stats["ost_position"] = ost_pos
            stats["end_card"] = bool(end_card_text)
            stats["keyword_popups"] = len(popups)
            stats["keyword_popups_on"] = keyword_popups_on
            stats["lower_third"] = lower_third_text is not None

    # Batch 12: the exact headline actually burned (None when no
    # headline was burned — silent clip, or the ASS write failed).
    # The backend's compliance checklist compares this against the
    # required OST, so it is recorded from what happened, never from
    # the settings alone.
    stats["ost_burned_text"] = headline if headline_path else None

    sw, sh = source_info["width"], source_info["height"]

    # --- Face tracking: sample the trajectory from the render source
    # (cleaned file when cleaning ran, else the original source at the
    # window offset), then hand it to the layout chains.
    face_track: list[tuple] = []
    do_track = _feature_on(settings, "face_tracking")
    if do_track:
        if layout in ("blur_fill", "gradient_fill", "stacked",
                      "letterbox", "framed"):
            # These layouts have no crop to track — honest no-op, not
            # faked. blur_fill keeps its original message; the Batch 9
            # layouts name themselves.
            if layout == "blur_fill":
                stats["face_fallback"] = (
                    "face tracking does not apply to the blurred-background layout")
            else:
                stats["face_fallback"] = (
                    f"face tracking does not apply to the {layout} layout")
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
    render_moments: list = []
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
    # Batch 13: a MILD denoise first (hqdn3d, well below its defaults
    # — phone/360p sources are noisy, and the denoise stops the
    # encoder wasting bits on that noise), then the unsharp (0.7 luma,
    # up from 0.5, to put back the crispness the denoise softens).
    # Verified by frame inspection: no plastic/over-smoothed look.
    chains.append(f"{video_label}hqdn3d=1.5:1.5:4:3,unsharp=5:5:0.7:5:5:0.0[vu]")
    video_label = "[vu]"
    # Batch 9: colour grade — after layout/zoom/sharpen, before the
    # captions burn, so the grade colours the footage and the burned
    # text stays its own colour. "none" (default) adds nothing, so
    # the pipeline is unchanged for ungraded jobs. Batch 13: "auto"
    # (the default) analyses THIS clip's frames first and resolves
    # to the look that suits it; the resolved grade + reason + the
    # measured stats are stashed for the job note and the clip row.
    grade, grade_reason, grade_stats = resolve_colour_grade(
        settings, render_source, render_start, render_end, job_dir)
    grade_filter = colour_grade_filter(grade)
    if grade_filter:
        chains.append(f"{video_label}{grade_filter}[vg]")
        video_label = "[vg]"
        stats["colour_grade"] = grade
        stats["colour_grade_reason"] = grade_reason
        stats["colour_grade_stats"] = grade_stats
        log.info("Clip %.1f-%.1fs: colour grade %s applied%s.",
                 start, end, grade,
                 f" ({grade_reason})" if grade_reason else " (manual)")
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
            srt_divider = int(th * 0.45) if layout == "split" else None
            if caption_position == "top":
                srt_align, srt_mv = 8, 300
            elif caption_position == "middle":
                srt_align, srt_mv = _caption_align_mv(
                    "middle", font_size, tw, th, srt_divider, layout,
                    headline_style, ost_position)
            else:
                srt_align, srt_mv = 2, 70
            # Batch 9 FONT MAP: classic's own typeface — the family
            # comes from the map so the burn and the map cannot drift.
            classic_family = FONT_MAP["classic"][0]
            style = (
                f"FontName={classic_family},FontSize=%d,PrimaryColour=&HFFFFFF,"
                "OutlineColour=&H000000,BorderStyle=1,Outline=2,Shadow=0,"
                f"Bold=1,Alignment={srt_align},MarginV={srt_mv}" % font_size
            )
            chains.append(
                f"{video_label}subtitles={escape_ffmpeg_path(captions_path)}"
                f":force_style='{style}'[v1]"
            )
        video_label = "[v1]"
    if headline_path is not None:
        # Batch 7 card backgrounds: the end card and the lower-third
        # tag are a card / a band — a dark box BEHIND the text. This
        # libass build does not render ASS BorderStyle 3 opaque boxes
        # (verified 2026-11-25), so the box is a drawbox here, UNDER
        # the subtitles step. The end card's box is time-gated to the
        # last 2s (enable timeline); the tag's box runs the full clip.
        # Static geometry + enable are both proven on this build.
        # Batch 9: the same treatment for the headline's own bar/band
        # (bold_bar / lower_third) — the preview shows it, so the burn
        # must have it too — and every box is sized from the FITTED
        # text (measured with the style's real font), so a shrunk or
        # 2-line text still sits inside its box.
        boxes: list[str] = []
        if headline:
            # The headline's span, same formula as write_headline_ass.
            headline_end = (render_duration if ost_persistent
                            else min(4.0, render_duration))
            if end_card_text:
                headline_end = min(headline_end,
                                   max(0.0, render_duration - 2.0))
            if headline_end > 0:
                if headline_style == "lower_third":
                    hl_fs = 64 if tw >= 1080 else 48
                elif headline_style == "big_centre":
                    hl_fs = 110 if tw >= 1080 else 80
                else:  # bold_bar
                    hl_fs = 84 if tw >= 1080 else 60
                hl_fit_fs, hl_lines = _fit_text_block(
                    headline, hl_fs, tw - 120, max_lines=2, min_fs=28,
                    font_path=h_font_path)
                hl_box = _headline_background_filter(
                    tw, th, headline_style, ost_pos, hl_fit_fs, hl_lines,
                    h_font_path,
                    enable=f"between(t,0,{headline_end:.3f})")
                if hl_box:
                    boxes.append(hl_box)
        if end_card_text:
            card_fs = 96 if tw >= 1080 else 68
            card_fit_fs, card_lines = _fit_text_block(
                end_card_text, card_fs, tw - 120, max_lines=2, min_fs=36,
                font_path=h_font_path)
            boxes.append(_text_box_filter(
                tw, end_card_text, card_fit_fs, th // 2,
                enable=f"between(t,{render_duration - 2.0:.3f},{render_duration:.3f})",
                font_path=h_font_path, lines=card_lines))
        if lower_third_text:
            tag_fs = 40 if tw >= 1080 else 30
            tag_fit_fs, _tag_lines = _fit_text_block(
                lower_third_text, tag_fs, tw - 120, max_lines=1, min_fs=20,
                font_path=h_font_path)
            # Alignment 2 + MarginV 260: the tag's bottom edge sits
            # 260px above the frame bottom, so its line centre is
            # ~260 + half a line above the bottom.
            tag_centre = th - 260 - int(tag_fit_fs * 0.6)
            boxes.append(_text_box_filter(
                tw, lower_third_text, tag_fit_fs, tag_centre, pad_x=30, pad_y=16,
                font_path=h_font_path))
        if boxes:
            chains.append(f"{video_label}{','.join(boxes)}[vcard]")
            video_label = "[vcard]"
        # Second subtitles filter, after the captions: the headline
        # burns on top, first 4 seconds only, near the top of frame.
        next_label = "[v2]" if captions_path is not None else "[v1]"
        chains.append(
            f"{video_label}subtitles={escape_ffmpeg_path(headline_path)}{next_label}"
        )
        video_label = next_label
    # Batch 7: progress bar — a thin brand-violet bar growing
    # left-to-right across the full clip, on the bottom 8px. It is the
    # LAST step (after captions and headline), so it never covers
    # text. The bar stream comes from _progress_bar_source (a violet
    # colour source whose alpha grows with time via geq — the one
    # filter on this ffmpeg build that genuinely evaluates per frame;
    # drawbox `t` and crop widths do not animate here), overlaid at
    # the bottom edge. When OFF, the chain is byte-identical to before.
    if progress_bar:
        chains.append(_progress_bar_source(tw, render_duration))
        chains.append(
            f"{video_label}{'format=yuv420p' if fps_applied else 'fps=30,format=yuv420p'}[vfmt]"
        )
        chains.append(f"[vfmt][bar]overlay=0:H-{PROGRESS_BAR_HEIGHT}[vout]")
        stats["progress_bar"] = True
    else:
        chains.append(f"{video_label}{'format=yuv420p' if fps_applied else 'fps=30,format=yuv420p'}[vout]")
    # Batch 9: music bed + SFX — the audio chain. The bed is ducked
    # under speech with sidechain compression (the clip's own audio
    # is the sidechain key, so the bed dips whenever someone speaks
    # and comes back up in gaps); SFX fire at their trigger times
    # via adelay. A source with no audio gets the bed alone at a
    # moderate level (nothing to duck under). When neither is set,
    # the command is exactly the old path (single -af loudnorm), so
    # jobs without a bed/SFX render byte-identically to before.
    sfx_setting = (settings.get("sfx") or "none").lower()
    if sfx_setting not in SFX_OPTIONS:
        sfx_setting = "none"
    bed_file = Path(music_bed_path) if music_bed_path else None
    if bed_file is not None and not bed_file.exists():
        stats["music_bed_skipped"] = (
            "music bed file missing — rendered without it")
        bed_file = None
    sfx_events = sfx_events_for_clip(
        sfx_setting, render_moments, popups, render_duration)
    # Only SFX files that exist are used — a missing shipped file is
    # a repo problem, never a render failure: the event is dropped.
    sfx_events = [(kind, t) for kind, t in sfx_events
                  if SFX_FILES[kind].exists()]
    for kind, _t in sfx_events:
        stats["sfx_counts"][kind] += 1
    if bed_file is not None:
        stats["music_bed"] = bed_file.name
    audio_chains: list[str] = []
    input_args: list[str] = [
        "-ss", str(render_start), "-i", str(render_source)]
    if bed_file is not None or sfx_events:
        # Extra inputs: the bed first (looped), then one per SFX event.
        next_input = 1
        bed_input: int | None = None
        if bed_file is not None:
            input_args += ["-stream_loop", "-1", "-i", str(bed_file)]
            bed_input = next_input
            next_input += 1
        sfx_inputs: list[str] = []
        for kind, at in sfx_events:
            input_args += ["-i", str(SFX_FILES[kind])]
            delay_ms = int(round(at * 1000))
            label = f"[sfx{len(sfx_inputs)}]"
            audio_chains.append(
                f"[{next_input}:a]adelay={delay_ms}:all=1,"
                f"volume={SFX_VOLUMES[kind]},"
                f"aformat=sample_rates=48000:channel_layouts=stereo{label}")
            sfx_inputs.append(label)
            next_input += 1
        mix_inputs: list[str] = []
        if source_info["has_audio"]:
            if bed_file is not None:
                # Split the speech: one copy for the mix, one as the
                # sidechain key that ducks the bed.
                audio_chains.append("[0:a]asplit=2[amain][aside]")
                audio_chains.append(
                    f"[{bed_input}:a]volume={MUSIC_BED_VOLUME},"
                    "aformat=sample_rates=48000:channel_layouts=stereo[bedv]")
                audio_chains.append(
                    "[bedv][aside]sidechaincompress=threshold=0.03:ratio=6:"
                    "attack=200:release=500[bedd]")
                mix_inputs += ["[amain]", "[bedd]"]
            else:
                mix_inputs.append("[0:a]")
        elif bed_file is not None:
            audio_chains.append(
                f"[{bed_input}:a]volume={MUSIC_BED_SOLO_VOLUME},"
                "aformat=sample_rates=48000:channel_layouts=stereo[bedv]")
            mix_inputs.append("[bedv]")
        mix_inputs += sfx_inputs
        if not source_info["has_audio"] and bed_file is None and sfx_inputs:
            # SFX only: the mix needs a duration-defining input —
            # amix duration=first would stop at the first (short)
            # SFX and truncate the clip's audio. Silence for the
            # full clip duration does it; the SFX ride on top.
            audio_chains.append(
                "anullsrc=r=48000:cl=stereo:"
                f"duration={render_duration:.3f}[sil]")
            mix_inputs = ["[sil]"] + mix_inputs
        if len(mix_inputs) == 1:
            audio_chains.append(
                f"{mix_inputs[0]}loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
        else:
            audio_chains.append(
                "".join(mix_inputs)
                + f"amix=inputs={len(mix_inputs)}:duration=first:"
                "dropout_transition=0,"
                "loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    filter_complex = ";".join(chains + audio_chains)

    cmd = [FFMPEG, "-y", "-v", "error",
           *input_args,
           "-filter_complex", filter_complex,
           "-map", "[vout]"]
    if audio_chains:
        cmd += ["-map", "[aout]"]
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    elif source_info["has_audio"]:
        # Batch 2: loudness-normalised to -14 LUFS (the level TikTok /
        # Instagram expect) and AAC 192k. Single-pass loudnorm on the
        # trimmed clip; it does not change the duration.
        cmd += ["-map", "0:a"]
        cmd += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    # Batch 2: CRF 18 (was 20) with a bitrate ceiling — visibly
    # cleaner on busy gameplay, same preset so render time barely
    # moves. Batch 11: the ceiling follows the export tier (16 Mbps
    # at 1080p, 8 Mbps at 720p). Batch 13: the preset + CRF now
    # follow the job's quality mode (Draft fast/20, Standard
    # medium/18 — the old behaviour — High slow/16); the tier cap
    # is unchanged, and loudnorm/AAC 192k above are untouched.
    preset, crf = quality_encode_params(settings)
    stats["quality_encode"] = f"{preset}/CRF {crf}"
    maxrate, bufsize = export_maxrate(settings.get("max_export_height"))
    cmd += ["-c:v", "libx264", "-preset", preset, "-crf", crf,
            "-maxrate", maxrate, "-bufsize", bufsize,
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
    tw, th = capped_target_size(settings.get("aspect_ratio", "9:16"),
                                settings.get("max_export_height"))
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
# Smart best-frame thumbnail (Batch 9, item 14d)
# ---------------------------------------------------------------------------
#
# The MAIN thumbnail is the best frame of the clip — sharpest +
# brightest + face-present, scored honestly from the pixels — instead
# of a fixed time. The 3 fixed picker candidates from Batch 4
# (10/50/90%) are untouched: this only chooses the main thumbnail.
# Weights: sharpness dominates (a blurry thumbnail is useless),
# brightness next (well-exposed beats dark/blown-out), face is a
# bonus (a face sells the clip, but a sharp bright frame without one
# still beats a blurry dark one with one).
THUMB_SHARPNESS_WEIGHT = 0.5
THUMB_BRIGHTNESS_WEIGHT = 0.3
THUMB_FACE_WEIGHT = 0.2
# The best-exposed frame: mean luminance 150 (bright but not blown
# out); the brightness term falls to 0 at pure black or pure white.
THUMB_IDEAL_BRIGHTNESS = 150.0


def score_thumbnail_frame(frame_path: Path, cascade=None) -> dict | None:
    """Score one candidate thumbnail frame.

    Returns {"sharpness": float (variance of Laplacian — higher is
    sharper), "brightness": float 0-1 (1 at the ideal exposure),
    "face": 0/1 (Haar face found)} — or None when OpenCV is
    unavailable or the frame cannot be read. The sharpness term is
    RAW (unbounded); the picker normalises it against the sharpest
    sampled frame, like the ranking normalises density. ``cascade``
    is injected by tests; None loads the bundled cascade.
    """
    try:
        import cv2
    except ImportError:
        return None
    img = cv2.imread(str(frame_path))
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_lum = float(gray.mean())
    brightness = max(
        0.0, 1.0 - abs(mean_lum - THUMB_IDEAL_BRIGHTNESS) / THUMB_IDEAL_BRIGHTNESS)
    face = 0
    if cascade is None:
        cascade, _path = _load_face_cascade()
    if cascade is not None:
        try:
            faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(40, 40))
            face = 1 if len(faces) > 0 else 0
        except Exception:  # noqa: BLE001 - face detection never fails scoring
            face = 0
    return {"sharpness": sharpness, "brightness": brightness, "face": face}


def pick_best_thumbnail_frame(clip_path: Path, job_dir: Path, prefix: str,
                              duration: float, skip_seconds: float = 0.0,
                              skip_tail_seconds: float = 0.0,
                              samples: int = 9
                              ) -> tuple[Path | None, dict | None]:
    """Pick the best thumbnail frame for a clip.

    Samples ``samples`` frames evenly across the clip content —
    after ``skip_seconds`` (the brand intro) and before the last
    ``skip_tail_seconds`` (the brand outro) — scores each with
    score_thumbnail_frame, and returns (best_path, best_scores)
    where best_scores carries the winning frame's time + the three
    terms + the weighted score. Losing frames are deleted; only the
    winner is kept. Returns (None, None) when nothing could be
    scored (no OpenCV, no frames, empty range) — the caller falls
    back to the fixed-time frame, never fails the clip.
    """
    if duration <= 0 or samples < 1:
        return None, None
    start = max(0.0, skip_seconds)
    end = duration - max(0.0, skip_tail_seconds)
    if end <= start:
        return None, None
    span = end - start
    times = [start + span * (i + 0.5) / samples for i in range(samples)]
    frames: list[tuple[Path, float, dict]] = []
    max_sharp = 0.0
    for i, t in enumerate(times):
        path = job_dir / f"{prefix}_best{i + 1}.jpg"
        got = extract_thumbnail(clip_path, path, at_seconds=round(t, 3))
        if got is None:
            continue
        raw = score_thumbnail_frame(got)
        if raw is None:
            path.unlink(missing_ok=True)
            continue
        frames.append((path, t, raw))
        max_sharp = max(max_sharp, raw["sharpness"])
    if not frames:
        return None, None
    best: tuple[Path, float, dict] | None = None
    best_score = -1.0
    for path, t, raw in frames:
        sharp_n = raw["sharpness"] / max_sharp if max_sharp > 0 else 0.0
        score = (THUMB_SHARPNESS_WEIGHT * sharp_n
                 + THUMB_BRIGHTNESS_WEIGHT * raw["brightness"]
                 + THUMB_FACE_WEIGHT * raw["face"])
        if score > best_score:
            best_score = score
            best = (path, t, {**raw, "sharpness_n": round(sharp_n, 3),
                              "score": round(score, 3),
                              "at_seconds": round(t, 3)})
    if best is None:
        return None, None
    best_path, _t, best_scores = best
    for path, _t2, _raw in frames:
        if path != best_path:
            path.unlink(missing_ok=True)
    log.info("Best thumbnail frame: %s at %.1fs (score %.2f: sharpness %.0f, "
             "brightness %.2f, face %d).",
             best_path.name, best_scores["at_seconds"], best_scores["score"],
             best_scores["sharpness"], best_scores["brightness"],
             best_scores["face"])
    return best_path, best_scores


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


def _download_music_bed(api: "JobApi", job: dict, job_dir: Path
                        ) -> tuple[Path | None, str | None, str | None]:
    """Download a job's music bed once, for all its clips (Batch 9).

    Returns (path, name, note): the local bed file + its original
    name when downloaded and ffprobe-validated as having an audio
    stream; (None, name, reason) when the job has a bed URL but it
    could not be used (download failed / no audio stream) — the job
    still renders, without the bed, and the note says why;
    (None, None, None) when the job has no bed at all.

    Batch 14: when the campaign brief forbids background music
    (parsed music_allowed is False — "background music NOT
    ALLOWED"), the job NEVER mixes a bed, even when a bed file
    exists: return the suppression reason WITHOUT attempting the
    download at all. The suppression reason reaches the job note
    through music_bed_note (the caller's "Music bed: …" line); the
    per-clip "music bed file missing" stat never fires for it,
    because no path is handed to the renders.
    """
    # Batch 14: the brief's music rule outranks any bed on the job.
    parsed = _campaign_parsed(job.get("settings") or {})
    if parsed.get("music_allowed") is False:
        return (None, job.get("music_bed_name"),
                "brief forbids background music — no music bed mixed")
    url = job.get("music_bed_url")
    name = job.get("music_bed_name")
    if not url:
        return None, None, None
    # The downloaded file keeps the original name (sanitised), so the
    # job note can say which bed was mixed in.
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_"
                   for ch in (name or "music-bed"))[:80] or "music-bed"
    dest = job_dir / f"music_bed_{safe}"
    try:
        api.download_brand_asset(url, dest)
    except Exception as exc:  # noqa: BLE001 - a bad bed never fails the job
        log.warning("Job %s: music bed download failed (%s); rendering "
                    "without it.", job.get("id"), exc)
        return None, name, "music bed download failed — rendered without it"
    # BUG FIX (Batch 9, 2026-11-25 — found by proof Job #67): the bed
    # is AUDIO-ONLY, so it must NOT be probed with probe_summary —
    # that helper requires a VIDEO stream and raises "No video stream
    # found" for a perfectly good MP3, which this except swallowed as
    # "has no audio stream" and the bed was silently dropped. Probe
    # the streams directly and accept any file with an audio stream.
    try:
        info = ffprobe_json(dest)
        has_audio = any(
            s.get("codec_type") == "audio" for s in info.get("streams", [])
        )
    except Exception:  # noqa: BLE001 - unprobeable bed, same fallback
        has_audio = False
    if not has_audio:
        log.warning("Job %s: music bed has no audio stream; rendering "
                    "without it.", job.get("id"))
        dest.unlink(missing_ok=True)
        return None, name, "music bed has no audio stream — rendered without it"
    log.info("Job %s: music bed downloaded: %s.", job.get("id"), name or dest.name)
    return dest, name, None


def apply_brand_assets(clip_path: Path, intro_path: Path | None = None,
                       outro_path: Path | None = None,
                       out_path: Path | None = None,
                       quality: str = "standard") -> tuple[Path, bool, bool]:
    """Concatenate [intro?] + clip + [outro?] into one branded clip.

    Every segment is normalised to the rendered clip's canvas (probe the
    clip for width/height/fps; scale + pad to match, fps filter,
    format=yuv420p) and its audio to 48kHz stereo; a segment without an
    audio stream gets a silent anullsrc track of its own duration, so a
    missing audio stream can never fail the concat. The segments are
    joined with the concat filter (n=2 or 3) and re-encoded libx264 +
    aac with the job's quality mode (Batch 13; was veryfast / 18).

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
            f"[{i}:v]{scale_expr(width, height, 'force_original_aspect_ratio=decrease')},"
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
    preset, crf = quality_encode_params({"quality": quality})
    cmd += ["-filter_complex", ";".join(chains),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", preset, "-crf", crf,
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
                       out_path: Path | None = None,
                       quality: str = "standard") -> tuple[Path, bool]:
    """Overlay the Brand Kit logo on a rendered clip (Batch 4).

    The logo sits bottom-right, scaled to ~12% of the clip width with
    a small margin, at 85% opacity — applied to the FINAL clip (after
    any brand intro/outro concat), so it covers the whole clip. The
    video is re-encoded libx264 with the job's quality mode
    (Batch 13; was veryfast / CRF 18); the audio stream is copied
    untouched.

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
    filt = (f"[1:v]{scale_expr(logo_w, '-1')},format=rgba,"
            f"colorchannelmixer=aa=0.85[logo];"
            f"[0:v][logo]overlay=W-w-{margin}:H-h-{margin}:format=yuv420[vout]")
    preset, crf = quality_encode_params({"quality": quality})
    cmd = [FFMPEG, "-y", "-v", "error",
           "-i", str(clip_path), "-i", str(logo_path),
           "-filter_complex", filt,
           "-map", "[vout]", "-map", "0:a?",
           "-c:v", "libx264", "-preset", preset, "-crf", crf,
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
        # Batch 7: whole-clip on-screen text — claimed only from what
        # the renders actually did (the stats), never the settings.
        if any(_stats(c).get("ost_persistent") for c in rendered):
            notes.append("On-screen headline shown for the full clip.")
        if any(_stats(c).get("end_card") for c in rendered):
            notes.append("Follow end card shown in the last 2 seconds.")
        popup_total = sum(_stats(c).get("keyword_popups", 0) for c in rendered)
        if popup_total:
            notes.append(f"{popup_total} keyword pop-up(s) shown.")
        elif any(_stats(c).get("keyword_popups_on") for c in rendered):
            notes.append(
                "Keyword pop-ups on, but no words to pop up — "
                "the clip has no speech.")
        if any(_stats(c).get("lower_third") for c in rendered):
            notes.append("Lower-third tag shown for the full clip.")
        if any(_stats(c).get("progress_bar") for c in rendered):
            notes.append("Progress bar shown.")
        # Batch 13: colour grade + quality — claimed only from what
        # the renders actually did (the stats), never the settings.
        # Auto grades carry their reason ("dark — brightened and
        # lifted"); a manual look has no reason, so identical manual
        # grades collapse to one line. The note is capped at 5 clips
        # (the payload truncates it at 1000 chars anyway).
        _grade_labels = {"clean": "Clean", "vibrant": "Vibrant",
                         "warm": "Warm", "cool": "Cool",
                         "cinematic": "Cinematic", "mono": "Mono",
                         "vintage": "Vintage"}
        _graded = [(i + 1, _stats(c).get("colour_grade"),
                    _stats(c).get("colour_grade_reason"))
                   for i, c in enumerate(rendered)]
        _graded = [(n, g, r) for n, g, r in _graded if g and g != "none"]
        if _graded:
            if (len({_g for _, _g, _ in _graded}) == 1
                    and all(_r is None for _, _, _r in _graded)):
                notes.append(
                    f"Colour grade: {_grade_labels.get(_graded[0][1], _graded[0][1])} "
                    f"applied to all {len(rendered)} clip(s).")
            else:
                _bits = []
                for _n, _g, _r in _graded[:5]:
                    _bits.append(f"Clip {_n}: {_grade_labels.get(_g, _g)}"
                                 + (f" ({_r})" if _r else ""))
                if len(_graded) > 5:
                    _bits.append(f"+{len(_graded) - 5} more")
                notes.append("Colour grade: " + "; ".join(_bits) + ".")
        _qmode = _stats(rendered[0]).get("quality_mode") or "standard"
        if _qmode != "standard":
            _qenc = _stats(rendered[0]).get("quality_encode") or ""
            notes.append(f"Quality: {_qmode.title()} ({_qenc}).")
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
    _ensure_repo_fonts()
    try:
        api.set_rerender_status(rerender_id, "processing")
        job = api.get_job(job_id)
        settings = dict(job.get("settings") or {})
        settings["caption_style"] = style
        # Batch 9: an A/B variant renders a NEW clip (Variant B) with
        # its own headline style when one was requested; a plain
        # re-render keeps the job's headline style and replaces the
        # file in place.
        is_variant = bool(rerender.get("is_variant"))
        variant_headline = (rerender.get("variant_headline_style") or "").lower()
        if is_variant and variant_headline in HEADLINE_STYLES:
            settings["headline_style"] = variant_headline
        job_dir = WORK_DIR / f"rerender-{rerender_id}"
        job_dir.mkdir(parents=True, exist_ok=True)
        source, source_note = acquire_source(api, job, job_dir)
        log.info("Source acquired for re-render %s: %s", rerender_id, source_note)
        source_info = probe_summary(source)
        # The parent job's brand assets ride along on a re-render too:
        # a re-rendered clip keeps the job's intro/outro.
        brand = download_brand_assets(api, job.get("brand_assets"), job_dir)
        # Batch 9: the job's music bed rides along on a re-render too
        # (same download, same ducking; a failed download renders
        # without the bed, never fails the re-render).
        music_bed_path, _music_bed_name, _music_bed_note = _download_music_bed(
            api, job, job_dir)
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
                    source_info, job_dir, music_bed_path=music_bed_path)
        info = validate_clip(out_path, {"settings": settings}, source_info)
        rerender_intro_ok = False
        rerender_outro_ok = False
        if brand:
            # Same concat as a fresh render; on any failure the plain
            # re-rendered clip is uploaded instead — never a failure.
            final_path, _intro_ok, _outro_ok = apply_brand_assets(
                out_path, brand.get("intro"), brand.get("outro"),
                job_dir / "clip_branded.mp4", quality=settings.get("quality"))
            if final_path != out_path:
                info = probe_summary(final_path)
                out_path = final_path
                rerender_intro_ok = _intro_ok
                rerender_outro_ok = _outro_ok
        # Batch 4: the re-rendered clip keeps the job's logo overlay
        # (same rule as a fresh render — OFF unless the job asked for
        # it, and a failure keeps the plain re-render).
        if settings.get("logo_overlay") and brand.get("logo"):
            final_path, _logo_ok = apply_logo_overlay(
                out_path, brand["logo"], job_dir / "clip_logo.mp4",
                quality=settings.get("quality"))
            if final_path != out_path:
                info = probe_summary(final_path)
                out_path = final_path
        # Thumbnail: see process_job — the BEST frame across the clip
        # content (after the intro, before the outro); the fixed-time
        # frame is the fallback when nothing scores.
        thumb_at = 1.0
        intro_dur = 0.0
        outro_dur = 0.0
        if rerender_intro_ok and "intro" in brand:
            intro_info = _probe_video_info(brand["intro"])
            if intro_info is not None:
                intro_dur = intro_info["duration"]
                thumb_at = intro_dur + 1.0
        if rerender_outro_ok and "outro" in brand:
            outro_info = _probe_video_info(brand["outro"])
            if outro_info is not None:
                outro_dur = outro_info["duration"]
        best_thumb, _best_scores = pick_best_thumbnail_frame(
            out_path, job_dir, "rerender_best", info["duration"],
            skip_seconds=intro_dur, skip_tail_seconds=outro_dur)
        thumb = best_thumb if best_thumb is not None else extract_thumbnail(
            out_path, job_dir / "thumb.jpg", at_seconds=thumb_at)
        # Batch 4: fresh thumbnail-picker candidates for the new file.
        cands = extract_thumbnail_candidates(out_path, job_dir,
                                             "rerender_cand", info["duration"])
        if is_variant:
            # Batch 9: a variant is a NEW clip row (Variant B) — the
            # original clip is never touched.
            api.upload_variant_clip(
                clip_id, out_path, rerender_id,
                thumbnail=thumb,
                duration_seconds=info["duration"],
                candidates=cands,
                face_tracked=bool(
                    (clip.get("_batch1_stats") or {}).get("face_tracked")))
            log.info("Variant %s ready: new Variant B clip for clip %s "
                     "(style '%s', headline '%s').",
                     rerender_id, clip_id, style,
                     settings.get("headline_style"))
        else:
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


def _reduced_aspect(width: int, height: int) -> str:
    """1280x720 -> "16:9". The ratio reduced to lowest terms."""
    g = math.gcd(width, height)
    return f"{width // g}:{height // g}"


def _analyse_reference_file(path: Path) -> dict:
    """Measure a downloaded reference video — pacing, shot length,
    aspect, audio. Returns a dict with duration / width / height /
    aspect / has_audio / cuts / cuts_per_minute / avg_shot_seconds,
    or {"error": reason} when the file cannot be probed.

    Batch 14: the brief's reference video is watched ONCE and only
    MEASURABLE style signals are mirrored. Caption/OST presence in
    the reference is NOT measured (no OCR in the worker) and no
    selector weight is changed by the pacing — the analysis is
    surfaced on the job page so the user can see what the example
    actually does. A failure here never fails the job.
    """
    try:
        info = ffprobe_json(path)
    except Exception as exc:  # noqa: BLE001 - unprobeable file
        return {"error": f"could not probe reference: {exc}"}
    fmt = info.get("format", {})
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        return {"error": "no video stream in reference"}
    duration = float(fmt.get("duration") or 0)
    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    aspect = _reduced_aspect(width, height) if width and height else None
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    cuts = None
    try:
        # Scene-change detection: each frame the filter selects is
        # one cut (the first frame scores 0, so it is never selected).
        proc = run([
            FFMPEG, "-i", str(path), "-vf", "select='gt(scene,0.4)'",
            "-vsync", "0", "-f", "null", "-",
        ], timeout=300)
        frames = None
        for line in (proc.stderr or "").splitlines():
            m = re.search(r"frame=\s*(\d+)", line)
            if m:
                frames = int(m.group(1))
        cuts = frames if frames is not None else 0
    except Exception as exc:  # noqa: BLE001 - cut count is optional
        log.warning("Reference scene detection failed: %s", exc)
        cuts = None
    out: dict = {
        "duration": round(duration, 1),
        "width": width,
        "height": height,
        "aspect": aspect,
        "has_audio": has_audio,
    }
    if cuts is not None:
        out["cuts"] = cuts
        out["cuts_per_minute"] = round(cuts / (duration / 60), 1) if duration > 0 else None
        out["avg_shot_seconds"] = round(duration / (cuts + 1), 1) if duration > 0 else None
    return out


def _analyse_reference_video(api: "JobApi", job: dict, job_dir: Path,
                             url: str) -> dict:
    """Download + analyse ONE reference video from the brief.
    Returns {"url": url, **measurements} or {"url": url, "error":
    reason} — Instagram links often fail behind a login wall, and
    that is a manual note on the job page, never a job failure.
    The file is deleted after analysis; nothing is reposted."""
    result: dict = {"url": url}
    dest = job_dir / "reference_video.mp4"
    try:
        try:
            download_with_ytdlp(url, dest, is_live=False)
        except Exception:
            # A direct file URL (or a host yt-dlp cannot read) gets
            # the plain-HTTP fallback before giving up.
            download_direct(url, dest)
        result.update(_analyse_reference_file(dest))
    except Exception as exc:  # noqa: BLE001 - reference is best-effort
        result["error"] = str(exc)[:300]
        log.warning("Job %s: reference video %s could not be analysed: %s",
                    job.get("id"), url, exc)
    finally:
        dest.unlink(missing_ok=True)
    return result


def process_job(api: JobApi, job: dict) -> None:
    job_id = job["id"]
    settings = job.get("settings") or {}
    job_dir = WORK_DIR / f"job-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    log.info("Processing job %s (platform=%s ratio=%s clips=%s mode=%s)",
             job_id, settings.get("platform"), settings.get("aspect_ratio"),
             settings.get("clip_count"), settings.get("duration_mode"))
    # Batch 9: the repo's shipped fonts must be in fontconfig before
    # any render, so every style burns in its own typeface.
    _ensure_repo_fonts()
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
        # Batch 9: the music bed is downloaded ONCE for the whole job
        # (all clips share it); a failed download never fails the job.
        music_bed_path, music_bed_name, music_bed_note = _download_music_bed(
            api, job, job_dir)
        # Batch 14: the brief's reference video is downloaded +
        # analysed ONCE (first link only), before the renders — its
        # measured pacing/aspect are surfaced in the job note. A
        # failure is a manual note, never a job failure.
        reference_info: dict | None = None
        ref_urls = _campaign_parsed(settings).get("reference_videos") or []
        if settings.get("job_type") == "campaign" and ref_urls:
            reference_info = _analyse_reference_video(
                api, job, job_dir, ref_urls[0])
            log.info("Job %s reference video: %s", job_id, reference_info)

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
                                source_info, job_dir,
                                music_bed_path=music_bed_path)
                    info = validate_clip(out_path, {"settings": ratio_settings}, source_info)
                    clip_intro_ok = False
                    clip_outro_ok = False
                    if brand:
                        # Brand the clip: [intro?] + clip + [outro?]. Any
                        # concat failure falls back to the plain clip
                        # (apply_brand_assets never raises); the uploaded
                        # duration then comes from the branded file.
                        try:
                            branded_path = job_dir / f"clip_{i:02d}_{slug}_branded.mp4"
                            final_path, intro_ok, outro_ok = apply_brand_assets(
                                out_path, brand.get("intro"), brand.get("outro"),
                                branded_path, quality=settings.get("quality"))
                            if final_path != out_path:
                                info = probe_summary(final_path)
                                intro_applied = intro_applied or intro_ok
                                outro_applied = outro_applied or outro_ok
                                out_path = final_path
                                clip_intro_ok = intro_ok
                                clip_outro_ok = outro_ok
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
                                out_path, brand["logo"], logo_out,
                                quality=settings.get("quality"))
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
                    # Batch 9: the main thumbnail is the BEST frame
                    # (sharpest + brightest + face-present) sampled across
                    # the clip content — after the intro, before the outro;
                    # the fixed-time frame is the fallback when nothing
                    # scores (no OpenCV, no frames).
                    thumb_at = 1.0
                    intro_dur = 0.0
                    outro_dur = 0.0
                    if clip_intro_ok and "intro" in brand:
                        intro_info = _probe_video_info(brand["intro"])
                        if intro_info is not None:
                            intro_dur = intro_info["duration"]
                            thumb_at = intro_dur + 1.0
                    if clip_outro_ok and "outro" in brand:
                        outro_info = _probe_video_info(brand["outro"])
                        if outro_info is not None:
                            outro_dur = outro_info["duration"]
                    best_thumb, _best_scores = pick_best_thumbnail_frame(
                        out_path, job_dir, f"best_{i:02d}_{slug}",
                        info["duration"], skip_seconds=intro_dur,
                        skip_tail_seconds=outro_dur)
                    thumb = best_thumb if best_thumb is not None else extract_thumbnail(
                        out_path, job_dir / f"thumb_{i:02d}_{slug}.jpg",
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
                # Batch 9 (item 14b): the worker's own face-tracking
                # measurement for this clip — the viral checklist
                # reads it, never a guess. Older clips have no field.
                "face_tracked": bool(
                    (clip.get("_batch1_stats") or {}).get("face_tracked")),
            }
            # The selector attaches a score_breakdown to every window;
            # a window with none (defensive — none exists today) sends
            # no field rather than an empty object.
            if clip.get("score_breakdown"):
                clip_fields["score_breakdown"] = clip["score_breakdown"]
            # Batch 12: per-clip campaign attachment — the title +
            # hashtags from THIS clip's own transcript, the post
            # caption (required verbatim, else the clip's own title),
            # and the exact OST text the render actually burned.
            # A field is sent only when it has a value — an absent
            # field means "none", never the string "None".
            clip_title, auto_tags = derive_clip_title_hashtags(
                segments, clip["start"], clip["end"])
            # Batch 14: the clip's 0-based index drives the example
            # caption rotation (the render loop is 1-based).
            campaign = apply_campaign_caption(
                settings, clip_title, auto_tags, clip_index=i - 1)
            clip_stats = clip.get("_batch1_stats") or {}
            burned = clip_stats.get("ost_burned_text")
            applied = list(campaign["required_items_applied"])
            required_ost = _required_campaign_ost(settings)
            if required_ost is not None and burned == required_ost:
                applied.append("ost")
            if clip_title:
                clip_fields["title_suggestion"] = clip_title
            if campaign["hashtags"]:
                clip_fields["hashtags"] = json.dumps(campaign["hashtags"])
            if campaign["post_caption"]:
                clip_fields["post_caption"] = campaign["post_caption"]
            clip_fields["caption_source"] = campaign["caption_source"]
            if burned:
                clip_fields["ost_burned_text"] = burned
            if applied:
                clip_fields["required_items_applied"] = json.dumps(applied)
            # Batch 13: the grade this clip actually rendered with +
            # the auto picker's reason (absent for a manual look or
            # when grading was off). The backend stores both on the
            # clip row for the per-clip card.
            if clip_stats.get("colour_grade") and clip_stats["colour_grade"] != "none":
                clip_fields["colour_grade_applied"] = clip_stats["colour_grade"]
            if clip_stats.get("colour_grade_reason"):
                clip_fields["colour_grade_reason"] = clip_stats["colour_grade_reason"]
            log.info("Job %s clip %d campaign: title=%r caption_source=%s "
                     "hashtags=%s ost_burned=%r applied=%s",
                     job_id, i, clip_title, campaign["caption_source"],
                     campaign["hashtags"], burned, applied)
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
        # Batch 9: OST language — from the renders' stats (never the
        # settings alone): the headline was translated only when a
        # render actually translated one. Aggregated over the primary
        # ratio's renders, like the music-bed / SFX lines below.
        _ost_ok = sum(
            1 for c in primary_rendered
            if (c.get("_batch1_stats") or {}).get("ost_translation") == "ok")
        _ost_failed = sum(
            1 for c in primary_rendered
            if (c.get("_batch1_stats") or {}).get("ost_translation") == "failed")
        _ost_target = (settings.get("ost_language") or "source").lower()
        if _ost_target in TRANSLATION_TARGETS:
            _ost_lang = TRANSLATION_TARGETS[_ost_target]
            if _ost_ok and not _ost_failed:
                extra_notes.append(
                    f"On-screen headline translated to {_ost_lang}.")
            elif _ost_ok:
                extra_notes.append(
                    f"On-screen headline translated to {_ost_lang} where "
                    f"possible — {_ost_failed} headline(s) in the source "
                    f"language.")
            elif _ost_failed:
                extra_notes.append(
                    "On-screen headline translation unavailable — headline "
                    "in the source language.")
            # "same"/"none" (already in that language, or no headline
            # was derived): nothing to report.
        # Batch 9: music bed + SFX — stated on every job, applied or
        # not, from the renders' stats (never the settings alone).
        bed_names = sorted({(c.get("_batch1_stats") or {}).get("music_bed")
                            for c in primary_rendered} - {None})
        bed_skipped = sorted({(c.get("_batch1_stats") or {}).get("music_bed_skipped")
                              for c in primary_rendered} - {None})
        if bed_names:
            extra_notes.append(
                f"Music bed: {', '.join(bed_names)} (ducked under speech).")
        elif bed_skipped:
            extra_notes.append("Music bed: " + "; ".join(bed_skipped) + ".")
        elif music_bed_note:
            extra_notes.append(f"Music bed: {music_bed_note}.")
        else:
            extra_notes.append("Music bed: none set.")
        # Batch 14: what the reference video measured — or why it
        # could not be analysed (an Instagram login wall is the
        # usual reason). The aspect note only fires on a mismatch:
        # the job keeps the aspect the user chose.
        if reference_info is not None:
            if "error" in reference_info:
                extra_notes.append(
                    "Reference video: could not be analysed "
                    f"({reference_info['error']}) — check the example by eye.")
            else:
                bits = []
                if reference_info.get("duration") is not None:
                    bits.append(f"{reference_info['duration']}s")
                if reference_info.get("aspect"):
                    bits.append(str(reference_info["aspect"]))
                if reference_info.get("cuts_per_minute") is not None:
                    bits.append(f"{reference_info['cuts_per_minute']} cuts/min")
                if reference_info.get("avg_shot_seconds") is not None:
                    bits.append(f"avg shot {reference_info['avg_shot_seconds']}s")
                extra_notes.append(
                    "Reference video: " + (", ".join(bits) + "." if bits
                                           else "analysed."))
                if (reference_info.get("aspect")
                        and reference_info["aspect"] != settings.get("aspect_ratio")):
                    extra_notes.append(
                        f"Reference is {reference_info['aspect']} but this job "
                        f"renders {settings.get('aspect_ratio')} (your chosen ratio).")
        sfx_setting = (settings.get("sfx") or "none").lower()
        sfx_whoosh = sum((c.get("_batch1_stats") or {}).get("sfx_counts", {}).get("whoosh", 0)
                         for c in primary_rendered)
        sfx_pop = sum((c.get("_batch1_stats") or {}).get("sfx_counts", {}).get("pop", 0)
                      for c in primary_rendered)
        if sfx_whoosh or sfx_pop:
            bits = []
            if sfx_whoosh:
                bits.append(f"whoosh x{sfx_whoosh}")
            if sfx_pop:
                bits.append(f"pop x{sfx_pop}")
            extra_notes.append(
                f"Sound effects ({sfx_setting}): " + ", ".join(bits) + ".")
        elif sfx_setting == "none":
            extra_notes.append("Sound effects: none set.")
        else:
            extra_notes.append(
                f"Sound effects ({sfx_setting}): no trigger in these "
                f"clips, so none sounded.")
        # Batch 11: export tier — stated when the plan cap shrank
        # the renders (720p Free tier). Full-size renders need no
        # note: 1080p is the default expectation.
        _capped_sizes = sorted({(c.get("_batch1_stats") or {}).get("export_size")
                                for c in primary_rendered
                                if (c.get("_batch1_stats") or {}).get("export_capped")} - {None})
        if _capped_sizes:
            extra_notes.append(
                f"Exported at {', '.join(_capped_sizes)} (720p plan cap).")
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
