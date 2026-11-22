"""Magician Clipper — video engine (Phase 1).

FastAPI service providing real media probing (ffprobe) and audio
extraction (ffmpeg) plus a SQLite job ledger. Phase 1 only:
transcription, highlight detection, scene detection, rendering and
captioning are Phase 3+ and are NOT implemented here.
"""

import os
import shutil


class Settings:
    """Runtime settings. No secrets are stored here."""

    def __init__(self) -> None:
        self.ffmpeg_path: str | None = shutil.which("ffmpeg")
        self.ffprobe_path: str | None = shutil.which("ffprobe")
        # Prefer the monorepo storage dir when it exists, otherwise use the
        # service-local storage dir (created under services/video-engine).
        here = os.path.dirname(os.path.abspath(__file__))  # app/core
        service_root = os.path.dirname(os.path.dirname(here))  # services/video-engine
        monorepo_root = os.path.dirname(os.path.dirname(service_root))
        monorepo_storage = os.path.join(monorepo_root, "storage", "temp")
        if os.path.isdir(os.path.join(monorepo_root, "storage")):
            self.temp_dir = monorepo_storage
            self.audio_dir = os.path.join(monorepo_root, "storage", "temp", "audio")
        else:
            self.temp_dir = os.path.join(service_root, "storage", "temp")
            self.audio_dir = os.path.join(service_root, "storage", "audio")
        self.data_dir = os.path.join(service_root, "data")
        # Max upload size: 2 GiB by default, overridable via env.
        self.max_upload_bytes: int = int(
            os.environ.get("VIDEO_ENGINE_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
        )
        # Allowed video extensions (lowercase, with leading dot).
        self.allowed_extensions: frozenset[str] = frozenset(
            {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg"}
        )

    def ensure_dirs(self) -> None:
        os.makedirs(self.temp_dir, exist_ok=True)
        os.makedirs(self.audio_dir, exist_ok=True)
        os.makedirs(self.data_dir, exist_ok=True)


settings = Settings()
