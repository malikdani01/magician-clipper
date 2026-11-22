# Magician Clipper — Video Engine (Phase 1)

Real media probing (ffprobe) and audio extraction (ffmpeg) as a FastAPI
service, plus a SQLite job ledger. Part of the Magician Clipper monorepo
(`services/video-engine`).

## What Phase 1 does

- `GET /health` — service status + ffmpeg/ffprobe versions.
- `POST /probe` — upload a video, get real ffprobe metadata
  (duration, resolution, fps, codecs, audio streams, bitrate, format, size).
- `POST /extract-audio` — upload a video, extract a mono 16 kHz WAV
  ready for transcription.
- `GET /jobs/{job_id}` — the stored job record (state machine per
  master prompt §11: uploaded → queued → probing → extracting_audio →
  … → completed / failed / cancelled, with validated transitions).

Uploads are streamed to disk (never loaded whole into RAM), saved under
server-generated uuid names (client filenames are never trusted), and
rejected with a clear 400 for non-video extensions/MIME types.
Max upload size is 2 GiB by default (`VIDEO_ENGINE_MAX_UPLOAD_BYTES`).

## Run

```bash
cd services/video-engine
python3 -m venv .venv
.venv/bin/pip install --no-cache-dir -r requirements.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Requires `ffmpeg` and `ffprobe` on PATH (checked at startup via
`shutil.which`; `/health` reports their versions or `null`).

## Endpoints (curl examples)

```bash
# Health
curl -s http://127.0.0.1:8001/health

# Probe a video (returns real metadata + a job id)
curl -s -F "file=@/path/to/video.mp4" http://127.0.0.1:8001/probe

# Extract mono 16 kHz WAV
curl -s -F "file=@/path/to/video.mp4" http://127.0.0.1:8001/extract-audio

# Fetch a job record
curl -s http://127.0.0.1:8001/jobs/<job_id>
```

## Layout

```text
services/video-engine/
├── app/
│   ├── main.py                    # FastAPI app entrypoint
│   ├── db.py                      # SQLite job ledger (stdlib sqlite3)
│   ├── core/
│   │   ├── config.py              # ffmpeg/ffprobe paths, storage dirs, limits
│   │   └── job_states.py          # §11 job states + VALID_TRANSITIONS
│   ├── schemas/jobs.py            # ProbeResponse, AudioExtractionResponse, JobRecord
│   ├── api/routes.py              # /health, /probe, /extract-audio, /jobs/{id}
│   └── services/
│       ├── media_probe/probe.py   # ffprobe subprocess → parsed metadata
│       └── audio/extract.py       # ffmpeg → mono 16 kHz WAV
├── data/                          # jobs.db (gitignored)
├── storage/temp/                  # uploaded files (gitignored)
├── storage/audio/                 # extracted WAVs (gitignored)
├── requirements.txt
└── README.md
```

## Phase 1 vs pending

| Feature | Status |
|---|---|
| ffprobe metadata | ✅ Done (Phase 1) |
| Audio extraction (mono 16 kHz WAV) | ✅ Done (Phase 1) |
| Job ledger + state machine | ✅ Done (Phase 1) |
| Transcription (faster-whisper) | ⏳ Phase 3 — `faster-whisper` NOT installed |
| Highlight / scene detection (OpenCV, PySceneDetect) | ⏳ Phase 3 — `opencv-python-headless` NOT installed |
| Clip rendering / reframing | ⏳ Phase 3 |
| Captions (SRT/VTT + burn-in) | ⏳ Phase 4 |
| Optional Ollama / Gemini adapters | ⏳ Phase 5, disabled by default |

No model, torch, or OpenCV is installed in Phase 1 on purpose — the
service stays tiny and CPU-safe on the 8 GB target machine.
