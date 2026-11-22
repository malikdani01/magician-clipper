"""API routes for the video engine (Phase 1).

Endpoints:
  GET  /health          service + ffmpeg/ffprobe availability
  POST /probe           upload a video, return real ffprobe metadata
  POST /extract-audio   upload a video, extract mono 16 kHz WAV
  GET  /jobs/{job_id}   return the stored job record (404 if unknown)

Uploads are streamed to disk (never loaded whole into RAM), saved under
a server-generated uuid name (the client filename is never trusted),
and rejected with a clear 400 when the extension/MIME is not a video.
"""

from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.job_states import (
    COMPLETED,
    EXTRACTING_AUDIO,
    FAILED,
    PROBING,
)
from app.db import create_job, get_job, update_job
from app.schemas.jobs import AudioExtractionResponse, JobRecord, ProbeResponse
from app.services.audio.extract import AudioExtractionError, extract_audio
from app.services.media_probe.probe import ProbeError, probe_media

router = APIRouter()

# Max bytes streamed per chunk while writing the upload to disk.
_CHUNK_SIZE = 1024 * 1024  # 1 MiB


def _save_upload_streaming(upload: UploadFile) -> tuple[str, int]:
    """Stream an upload to a uuid-named file under the temp dir.

    Returns (saved_path, size_bytes). Raises HTTPException 400/413 on
    bad extension, bad MIME, or oversize. Never trusts the client
    filename; only its extension is used for validation.
    """
    filename = upload.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported file type {ext or '(none)'}: "
                f"allowed video extensions are {sorted(settings.allowed_extensions)}"
            ),
        )
    content_type = (upload.content_type or "").lower()
    if content_type and not (
        content_type.startswith("video/")
        or content_type in {"application/octet-stream", "application/x-matroska"}
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported MIME type: {content_type}",
        )
    settings.ensure_dirs()
    dest_name = f"{uuid.uuid4().hex}{ext}"
    dest_path = os.path.join(settings.temp_dir, dest_name)
    size = 0
    with open(dest_path, "wb") as out:
        while True:
            chunk = upload.file.read(_CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                out.close()
                os.unlink(dest_path)
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"Upload exceeds the {settings.max_upload_bytes} byte limit "
                        f"({settings.max_upload_bytes // (1024 * 1024)} MiB)"
                    ),
                )
            out.write(chunk)
    return dest_path, size


def _job_or_404(job_id: str) -> JobRecord:
    row = get_job(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return JobRecord(**row)


@router.get("/health")
def health() -> dict:
    """Service health + ffmpeg/ffprobe availability."""
    import subprocess

    def _version(binary: str | None) -> str | None:
        if not binary:
            return None
        try:
            out = subprocess.run(
                [binary, "-version"], capture_output=True, text=True, timeout=5
            )
            first = (out.stdout or "").splitlines()
            return first[0] if first else None
        except Exception:
            return None

    return {
        "status": "ok",
        "service": "video-engine",
        "ffmpeg": _version(settings.ffmpeg_path),
        "ffprobe": _version(settings.ffprobe_path),
    }


@router.post("/probe", response_model=ProbeResponse)
async def probe(file: UploadFile = File(...)):
    """Upload a video and return real ffprobe metadata."""
    saved_path, size = _save_upload_streaming(file)
    # The upload is already on disk and probing starts immediately, so the
    # job is created in its first working state (not 'uploaded').
    job = create_job(saved_path, state=PROBING)
    job_id = job["id"]
    try:
        update_job(job_id, stage="probing", progress=0.1)
        meta = probe_media(saved_path)
        if meta["video_codec"] is None and meta["duration_seconds"] is None:
            raise ProbeError("no video stream found in file", "probe_no_video")
        update_job(job_id, state=COMPLETED, stage="completed", progress=1.0)
        return ProbeResponse(
            job_id=job_id,
            duration_seconds=meta["duration_seconds"],
            width=meta["width"],
            height=meta["height"],
            fps=meta["fps"],
            video_codec=meta["video_codec"],
            audio_codec=meta["audio_codec"],
            audio_streams=meta["audio_streams"],
            bitrate=meta["bitrate"],
            format=meta["format"],
            size_bytes=meta["size_bytes"] if meta["size_bytes"] is not None else size,
            source_path=saved_path,
        )
    except ProbeError as exc:
        update_job(
            job_id, state=FAILED, stage="probing", error_code=exc.code,
            error_message=str(exc),
        )
        return JSONResponse(
            status_code=422,
            content={"detail": str(exc), "error_code": exc.code, "job_id": job_id},
        )


@router.post("/extract-audio", response_model=AudioExtractionResponse)
async def extract_audio_endpoint(file: UploadFile = File(...)):
    """Upload a video and extract a mono 16 kHz WAV for transcription."""
    saved_path, _size = _save_upload_streaming(file)
    # Audio extraction starts immediately, so the job is created in its
    # first working state (not 'uploaded').
    job = create_job(saved_path, state=EXTRACTING_AUDIO)
    job_id = job["id"]
    try:
        update_job(job_id, stage="extracting_audio", progress=0.1)
        result = extract_audio(saved_path, job_id=job_id)
        update_job(job_id, state=COMPLETED, stage="completed", progress=1.0)
        return AudioExtractionResponse(
            job_id=job_id,
            audio_path=result["audio_path"],
            duration_seconds=result["duration_seconds"],
            sample_rate=result["sample_rate"],
            channels=result["channels"],
            size_bytes=result["size_bytes"],
            source_path=saved_path,
        )
    except AudioExtractionError as exc:
        update_job(
            job_id, state=FAILED, stage="extracting_audio", error_code=exc.code,
            error_message=str(exc),
        )
        return JSONResponse(
            status_code=422,
            content={"detail": str(exc), "error_code": exc.code, "job_id": job_id},
        )


@router.get("/jobs/{job_id}", response_model=JobRecord)
def read_job(job_id: str):
    """Return the stored job record, or 404."""
    return _job_or_404(job_id)
