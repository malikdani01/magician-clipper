# Processing pipeline

**Status: Phase 3 (Muse-connected Job System) implemented 2026-11-22.**
This document describes the pipeline as built, from job creation to
validated clips. Nothing here is aspirational: every stage names the code
that performs it and the evidence that it ran.

Related: [API reference](api.md) · [OpenAPI contract](../shared/api-contracts/api-v1.yaml)
· [Architecture](architecture.md) · [Environment](environment.md)

## 1. Job flow (create → Ready)

The final system is a **Muse-connected Job System**: the user creates a
job in Clipper (upload or link + dropdown settings, no typing), Muse picks
it up via a secure Job API, makes clips exactly per the settings, uploads
the MP4s back to the same Job ID, and the user downloads them from
Clipper. No chat messages are needed per job.

```
User (Sanctum)                Laravel (/api/v1)              Muse worker
  │                                │                            │
  │ POST /jobs                     │                            │
  │ file OR link + settings ──────►│  ProcessingJob created     │
  │                                │  state = queued            │
  │                                │  (settings JSON stored)    │
  │                                │                            │
  │                                │◄── GET /muse/jobs?status=queued
  │                                │    (X-Muse-Api-Key)        │
  │                                │──► oldest Queued job       │
  │                                │◄── PATCH /muse/jobs/{id}/status
  │                                │    Processing (claim)       │
  │                                │                            │
  │                                │     acquire source ──┐
  │                                │     (upload path, or  │
  │                                │      yt-dlp download)│
  │                                │     probe (ffprobe)  │
  │                                │     transcribe       │ worker
  │                                │     (faster-whisper) │
  │                                │     select highlights│
  │                                │     render (FFmpeg)  │
  │                                │     validate (ffprobe)
  │                                │                            │
  │                                │◄── POST /muse/jobs/{id}/clips
  │                                │    (multipart MP4,          │
  │                                │     ffprobe-validated)      │
  │                                │◄── PATCH status → Ready     │
  │                                │    (or Failed + exact reason)
  │ GET /jobs/{id} ───────────────►│  job + settings + clips    │
  │ (status Ready, download URLs)  │  (duration, size, download)│
  │ GET /clips/{clip}/download ───►│  streams the MP4           │
```

### 1.1 Job states (public vs internal)

The user panel and the Muse worker speak a simple public status:

```
Queued → Processing → Ready
                  └→ Failed   (error_reason kept verbatim)
```

Internally the job keeps the fine-grained pipeline states from spec §11
(`uploaded, queued, probing, extracting_audio, transcribing,
detecting_scenes, analyzing, selecting_clips, rendering, captioning,
validating, completed, failed, cancelling, cancelled`) in
`App\Models\ProcessingJob::VALID_TRANSITIONS`. The public status is
derived (`ProcessingJob::publicStatus()`):

| Internal state | Public status |
|---|---|
| `uploaded`, `queued` | `queued` |
| `completed` | `ready` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| any other state | `processing` |

The Muse status endpoint walks the internal machine along valid
transitions only (`ProcessingJob::advanceTo()` — BFS over the transition
table). An illegal transition is a 422, never a silent overwrite.
Reporting the same public status again only updates `stage`/`progress`,
so the worker can report progress while staying in `Processing`.

### 1.2 What a job carries

Stored on `processing_jobs` (migration
`2026_11_22_000007_add_job_settings_to_processing_jobs`):

- **Source** — exactly one of:
  - `source_type = upload`, `source_path` = relative path under
    `backend/laravel/storage/app` (e.g. `uploads/<uuid>.mp4`). The file
    is validated with FFprobe at upload time; a file that does not probe
    as a playable video is rejected with 422.
  - `source_type = link`, `source_url` = a YouTube, TikTok, Google
    Drive, or direct video-file (mp4/mov/mkv/webm) link. Other hosts are
    rejected with 422 — the worker is never asked to fetch an arbitrary
    URL.
- **Settings** (JSON, dropdowns/toggles only — see `docs/api.md`):
  `platform` (tiktok/instagram), `aspect_ratio` (9:16/16:9/1:1/4:5),
  `clip_count` (1–10), `duration_mode` (exact/minimum/maximum),
  `duration_seconds` (5–180, plus optional `duration_min_seconds` /
  `duration_max_seconds`), `captions_enabled` + `captions_language`
  (english/roman_urdu/hindi/auto), `on_screen_text`, `job_type`
  (myself/campaign + `campaign_requirements` text when campaign),
  `layout` (center_crop/split).
- **Progress** — `stage` (human-readable current step) and `progress`
  (integer 0–100, real and measurable only; never fabricated).
- **Failure** — `error_code` / `error_message` (user-facing, sanitized).

### 1.3 Endpoints

User-facing (Sanctum): `POST /api/v1/jobs`, `GET /api/v1/jobs`,
`GET /api/v1/jobs/{id}` (job + settings + clip list with duration, size
and download URL), `POST /api/v1/jobs/{id}/cancel`,
`POST /api/v1/jobs/{id}/retry`, `GET /api/v1/clips/{clip}/download`.

Muse Job API (header `X-Muse-Api-Key`, no user session):
`GET /api/v1/muse/jobs?status=queued`, `GET /api/v1/muse/jobs/{id}`
(full settings + `source_local_path`), `PATCH
/api/v1/muse/jobs/{id}/status`, `POST /api/v1/muse/jobs/{id}/clips`
(multipart MP4, ffprobe-validated server-side before a clip record is
created). Full request/response examples: [docs/api.md](api.md).

## 2. Worker pipeline (what happens inside "Processing")

Code: `services/video-engine/workers/muse_worker.py`
(requirements: `services/video-engine/requirements.txt` —
faster-whisper, requests, opencv-python-headless).

### 2.1 Acquire the source

- **Upload:** the worker reads the file at
  `backend/laravel/storage/app/<source_path>` (the Muse API returns
  `source_local_path` for this). The path is checked to stay inside the
  Laravel storage root; anything else is refused.
- **Link:** downloaded with yt-dlp (`best[height<=720]`, CPU/RAM-safe
  cap). Direct video-file URLs get one plain-HTTP fallback if yt-dlp
  fails. **YouTube LIVE is never downloaded unbounded:** a live capture
  is capped at 10 minutes of wall-clock recording (`timeout 600` with
  `--live-from-start`); the file actually written in that window is what
  gets processed, and the job fails with the exact reason if it is
  unusable. What was captured is logged, never assumed.
  **Pre-staged source:** if a local file already sits at the exact path
  the download would write (`job-<id>/source.<ext>`), the worker uses
  it and skips the download — this is how already-downloaded excerpts
  of a linked stream are reused without re-downloading. The file is
  still probed, so a corrupt staged file fails the job with the exact
  ffprobe reason.

### 2.2 Probe

FFprobe: duration, resolution, frame rate, codecs, audio streams. A
file with no video stream or no determinable duration fails the job
with the exact ffprobe reason.

### 2.3 Extract audio + transcribe

FFmpeg extracts a mono 16 kHz WAV; faster-whisper transcribes it with
the **tiny** model, CPU `int8`, 2 threads, word timestamps on, VAD on.
The extraction uses `-af aresample=async=1:first_pts=0`, which fills
timestamp gaps in the source audio with silence instead of compressing
them out: without it, a source whose audio drops out mid-stream (the
acceptance-test source's first 90 s segment carries only 16.3 s of
audio) yields a WAV shorter than the video and every later transcript
timestamp is shifted early by the missing time, so captions would be
burned over the wrong footage. The worker also logs a warning if the
extracted WAV ends up more than 2 s shorter than the video. Sources with
no audio track skip transcription (and therefore the speech-driven
selector below).

**Measured compatibility note (2026-11-22):** faster-whisper 1.2.1's
`decode_audio()` calls `av.open(metadata_errors=...)`, a keyword PyAV
19 removed — the first E2E run failed with exactly
`open() got an unexpected keyword argument 'metadata_errors'` and the
job was correctly marked Failed with that reason. The worker now loads
the extracted WAV with the stdlib `wave` module and passes a float32
numpy array to `model.transcribe()`, which skips the `av` path entirely
(verified: transcription runs, 0 segments on a toneless sample).
`requirements.txt` additionally pins `av>=11,<19` (venv now has av
18.1.1) so fresh installs stay safe for any path-based call.

### 2.4 Highlight selection (explainable scoring)

Candidates are sentence-aligned windows built from the transcript
(never cut mid-word). Each candidate is scored as:

```
score = 0.45 * speech_density   (words per second, normalised to the
                                  densest candidate)
      + 0.35 * sentence_completeness
                                  (1.0 when the window starts and ends
                                   on sentence boundaries, 0.4 trimmed)
      + 0.10 * silence_boundary  (gap before + after the window,
                                  capped at 2 s)
      + 0.10 * audio_energy     (per-second RMS, normalised — SUPPORTING
                                  ONLY; loudness is never engagement)
```

Windows are picked greedily by score, skipping anything that overlaps
an already-chosen window — so the count is exact, with no duplicates
and no fabricated footage. Duration modes:

- **exact:** the window is extended into nearby context where possible
  (or trimmed) to land within ±0.6 s of `duration_seconds`; if a moment
  cannot be made to fit, it is rejected and another is chosen.
- **minimum:** window is at least `duration_seconds` (extended to the
  next sentence end).
- **maximum:** window is at most `duration_seconds` (trimmed to the last
  sentence end inside the limit).

**No-speech fallback:** if the source has no usable transcribed speech
(music-only / silent), the worker uses deterministic uniform windows
over the source — real footage, clearly labelled
(`no_speech_fallback`) on each clip's reason, never presented as a
speech-driven highlight. If the source is too short for even one valid
window, the job fails with the exact reason (e.g. "Source is 12.0s long
but the job requests 3x 30s clips in 'exact' mode"). If fewer than the
requested clips are possible, the job still completes with the clips
that exist and the shortfall is logged — clips are never duplicated to
meet the count.

### 2.5 Render

FFmpeg (`libx264`, `veryfast`, CRF 20, `yuv420p`, `+faststart`, 30 fps):

- **Ratio:** crop-to-cover (center crop), never stretched. Targets:
  9:16 → 1080×1920, 16:9 → 1920×1080, 1:1 → 1080×1080,
  4:5 → 1080×1350.
- **Split layout** (`layout = split`, 9:16 only): streamer-top /
  gameplay-bottom — top panel 1080×864, bottom 1080×1056, stacked to
  1080×1920. The facecam region is detected with OpenCV Haar cascades
  sampled at 25/50/75% of the clip (largest face, median centre). If
  OpenCV, the cascade, or any face is unavailable, the documented
  fallback is used: the top 45% of the frame as facecam, the lower 55%
  as gameplay. No speaker-to-face identity matching is claimed.
- **Captions:** when `captions_enabled`, an SRT is built from the
  transcript segments overlapping the clip window (times shifted to
  0-based) and burned in with the `subtitles` filter (DejaVu Sans,
  white with black outline, bottom-centred). When captions are off, or
  a clip has no transcript cues, no subtitle filter is applied.
- **Audio:** the source audio track is copied through (AAC 128k) when
  the source has audio; otherwise the clip has no audio stream.

### 2.6 Validate (before upload)

Every rendered clip is validated with ffprobe **before** it is uploaded:

- file exists, nonzero size;
- duration within tolerance of the job's duration mode (exact: ±0.6 s
  of target; minimum: ≥ target − 0.6 s; maximum: ≤ target + 0.6 s);
- resolution exactly matches the target for the ratio;
- video stream present;
- audio stream present when the source has audio.

A clip that fails validation fails the whole job with the exact reason.
The Laravel clip-upload endpoint re-validates with ffprobe as well, and
only creates a `job_clip` record for a validated file.

### 2.7 Upload + finish

Clips are uploaded one by one (`POST /api/v1/muse/jobs/{id}/clips`,
multipart MP4 + title/start/end/duration/score/reason/transcript
excerpt), then the job is marked `Ready`. On **any** failure the job is
marked `Failed` with the exact reason (`PATCH …/status`, `error_reason`,
kept verbatim in `error_message`).

## 3. Running the worker

The worker runs on the same VM as the backend and calls the local API
(`http://127.0.0.1:8000`). It reads `MUSE_JOB_API_KEY` from
`backend/laravel/.env` at runtime (or the environment) and never logs
it.

```bash
# One queued job, then exit:
python3 services/video-engine/workers/muse_worker.py --once
# (or via the wrapper script)
bash scripts/muse-poll.sh --once

# Poll mode (loop, default every 300 s):
bash scripts/muse-poll.sh
MUSE_POLL_INTERVAL=120 bash scripts/muse-poll.sh

# One specific job (must be Queued):
python3 services/video-engine/workers/muse_worker.py --once --job-id <id>
```

Cron example (every 5 minutes, single-run mode — safe if a previous run
is still working, because the worker claims one job at a time):

```cron
*/5 * * * * cd /home/hatch/workspace/magician-clipper && bash scripts/muse-poll.sh --once >> services/video-engine/storage/logs/muse-worker.log 2>&1
```

Loop mode (the script, no cron) is preferred on this VM: one long-lived
poller instead of a process every 5 minutes. Logs go to
`services/video-engine/storage/logs/muse-worker.log`. Working files live
under `services/video-engine/storage/muse-worker/job-<id>/` and are kept
for diagnosis (source downloads, extracted WAV, per-clip SRTs).

### 3.1 Resource notes

- One job at a time; Whisper tiny/int8 with 2 CPU threads (see
  `WHISPER_MODEL` / `WHISPER_CPU_THREADS` env overrides).
- Do not run the worker's transcription/encoding while another heavy
  FFmpeg render is running on this RAM-tight VM (check
  `ps aux | grep ffmpeg` and `free -h` first).
- The first transcription downloads the faster-whisper `tiny` model
  (~75 MB) into the Hugging Face cache; that is the only model download.

## 4. Fixes shipped with this phase

- **FIX 1 — JSON for /api/*:** `ForceJsonResponse` middleware forces
  `Accept: application/json` on every API request (runs before
  route-level auth), and the exception renderer in
  `backend/laravel/bootstrap/app.php` renders `AuthenticationException`
  as 401 JSON for `api/*`. Unauthenticated calls without an Accept
  header now return 401 JSON instead of HTTP 500. Regression test:
  `MuseJobApiTest::test_unauthenticated_api_call_without_accept_header_returns_401_json`.
  **Implementation note (measured, not assumed):** appending the
  middleware to the `api` group alone did NOT fix it — Laravel sorts
  route middleware by its priority list, and `Authenticate` (via the
  `AuthenticatesRequests` contract) is in that list while group
  middleware is not, so the sort promoted `auth:sanctum` ahead of the
  group middleware and the auth layer redirected to the nonexistent
  `login` route before our middleware ever ran (verified live: still
  500 HTML). The fix that works is registering `ForceJsonResponse` in
  the priority list immediately before `AuthenticatesRequests`
  (`$middleware->prependToPriorityList(...)` in `bootstrap/app.php`);
  verified live with curl: `GET /api/v1/me` with no Accept header and
  with `Accept: text/html` both return `401` with
  `Content-Type: application/json` and body
  `{"message":"Unauthenticated.","code":"UNAUTHENTICATED"}`.
- **CORS (Worker B blocker fix):** `backend/laravel/config/cors.php`
  added (from Laravel's default stub). `paths: api/*,
  sanctum/csrf-cookie`; `allowed_origins` from the `FRONTEND_URL` env
  var (comma-separated list; defaults to the local Vite origins
  `http://localhost:5173,http://127.0.0.1:5173`); `supports_credentials:
  true` (Sanctum). Before this file existed, `HandleCors` was in the
  global middleware but `cors.paths` was empty, so no
  `Access-Control-Allow-Origin` headers were ever added and preflight
  OPTIONS had no route. Verified live: preflight to
  `/api/v1/auth/login` from `http://localhost:5173` returns `204` with
  `Access-Control-Allow-Origin: http://localhost:5173` and
  `Access-Control-Allow-Credentials: true`; an unknown origin gets a
  204 with no allow-origin header. Regression tests in `MuseJobApiTest`.
  `FRONTEND_URL` was also added to `backend/laravel/.env.example`.
  The root-vs-backend `.env.example` drift was aligned in the backend
  template: `APP_DEBUG=false`, `QUEUE_CONNECTION=database`, and
  `DB_DATABASE` is now unset (Laravel defaults to
  `database/database.sqlite`, the existing dev DB) with the VM/Windows
  absolute paths kept as commented examples. The live backend `.env`
  was NOT changed. `render.yaml` / `Dockerfile` /
  `docs/deployment-render-free.md` were not touched (Worker B owns them).
- **FIX 2 — Settings update:** `PATCH /api/v1/settings` is a real
  validated update (was a 501 stub). Backed by the new `user_settings`
  table (`2026_11_22_000008_create_user_settings_table`) and
  `App\Models\UserSetting`; `GET /api/v1/settings` creates the row with
  defaults on first access.

## 5. Known limitations

- The worker polls; there is no push/SSE for job completion yet.
- Live-stream capture is capped at 10 minutes of recording (see §2.1);
  a live job whose first 10 minutes contain too little usable content
  fails honestly rather than recording indefinitely.
- Split-layout face detection is Haar-cascade based (fast, CPU-safe);
  it finds *a* face region, not *the* speaker, and falls back to frame
  analysis when no face is found.
- Clip download is a direct file stream (`GET /api/v1/clips/{clip}/download`);
  there is no ZIP/batch export of a job's clips yet (existing
  `POST /projects/{project}/export` is still the Phase 3 stub).
- `POST /projects/{project}/upload` and `POST /projects/{project}/analyze`
  remain Phase 3 stubs; job creation (`POST /api/v1/jobs`) is the
  implemented upload path.
