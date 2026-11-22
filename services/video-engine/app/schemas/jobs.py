"""Pydantic schemas for the video-engine API (Phase 1)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProbeResponse(BaseModel):
    """Real media metadata returned by ffprobe (master prompt §9.1)."""

    job_id: str
    duration_seconds: float | None
    width: int | None
    height: int | None
    fps: float | None
    video_codec: str | None
    audio_codec: str | None
    audio_streams: int
    bitrate: int | None
    format: str | None
    size_bytes: int
    source_path: str


class AudioExtractionResponse(BaseModel):
    """Result of extracting a mono 16 kHz WAV for transcription (§9.2)."""

    job_id: str
    audio_path: str
    duration_seconds: float | None
    sample_rate: int
    channels: int
    size_bytes: int
    source_path: str


class JobRecord(BaseModel):
    """One row of the ``jobs`` table, as returned by GET /jobs/{job_id}."""

    id: str
    source_path: str
    state: str
    stage: str | None = None
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


class ErrorResponse(BaseModel):
    """Uniform error body."""

    detail: str
    error_code: str | None = None
