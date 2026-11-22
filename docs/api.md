# API reference

**Status: Phase 1 contract + Phase 3 Job System (implemented 2026-11-22,
verified live — see the verification notes at the end of each section).**
The authoritative contract is
[`../shared/api-contracts/api-v1.yaml`](../shared/api-contracts/api-v1.yaml)
(OpenAPI 3.0). This document is a human-readable summary of it. TypeScript
types mirroring the same schemas live in
[`../shared/api-contracts/types.ts`](../shared/api-contracts/types.ts).

Base URL (local dev): `http://127.0.0.1:8000/api/v1`
Video engine health only: `http://127.0.0.1:8001/health`

## Auth

- Scheme: Laravel Sanctum bearer token.
- Header: `Authorization: Bearer <token>`
- Get a token: `POST /auth/register` or `POST /auth/login`.
- Revoke: `POST /auth/logout`.
- Admin endpoints (`/admin/*`) additionally require the `admin` role;
  a non-admin caller gets `403`.
- Public endpoints: `GET /health`, `POST /auth/register`, `POST /auth/login`.
- **Muse Job API (`/muse/*`) uses a different scheme:** header
  `X-Muse-Api-Key: <server-side key>` (see [Muse Job API](#muse-job-api-x-muse-api-key)).
  No user session is involved. A missing/wrong key gets `401 JSON`.
- **All `/api/*` responses are JSON**, even for unauthenticated calls
  without an `Accept` header (Phase 3 FIX 1): the `ForceJsonResponse`
  middleware forces `Accept: application/json` before route-level auth,
  and the exception renderer returns 401 JSON for `api/*`.

## Endpoints

### Health

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Backend health (`{status, service, version, timestamp}`) |

### Auth

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Register (name, email, password, password_confirmation) → user + token |
| POST | `/auth/login` | Log in → user + token |
| POST | `/auth/logout` | Revoke current token |
| GET | `/me` | Current user |

### Projects

| Method | Path | Description |
|---|---|---|
| POST | `/projects` | Create project |
| GET | `/projects` | List my projects (paginated; `search`, `status` filters) |
| GET | `/projects/{project}` | Get one project |
| PATCH | `/projects/{project}` | Rename / update |
| DELETE | `/projects/{project}` | Delete project + derived media (confirmed delete only) |

### Media

| Method | Path | Description |
|---|---|---|
| POST | `/projects/{project}/upload` | Multipart video upload; server validates extension, MIME and FFprobe result; server-generated filename |
| GET | `/projects/{project}/media` | List media assets of a project |

### Jobs (user-facing — Phase 3 Job System)

| Method | Path | Description |
|---|---|---|
| POST | `/jobs` | Create a job: upload a video file **or** a link + dropdown settings → `201` + job (status `queued`) |
| GET | `/jobs` | List my jobs (paginated; `status` filter: `queued`, `processing`, `ready`, `failed`, `cancelled`) |
| GET | `/jobs/{job}` | Get a job — **poll this** for status + clips (job + settings + clip list with duration, size, download URL) |
| POST | `/jobs/{job}/cancel` | Cancel (→ `cancelling` → `cancelled`) |
| POST | `/jobs/{job}/retry` | Retry a failed job; source media + settings preserved |

### Muse Job API (`X-Muse-Api-Key`)

| Method | Path | Description |
|---|---|---|
| GET | `/muse/jobs?status=queued` | List jobs for the worker (oldest first; `status` filter: `queued`, `processing`, `ready`, `failed`, `cancelled`) |
| GET | `/muse/jobs/{job}` | Full job for the worker: settings + `source_path` + `source_local_path` + `source_url` |
| PATCH | `/muse/jobs/{job}/status` | Report status: `Queued` / `Processing` / `Ready` / `Failed` (+ `error_reason`, `stage`, `progress`) |
| POST | `/muse/jobs/{job}/clips` | Upload one rendered MP4 clip (multipart; ffprobe-validated server-side) → `201` + clip |

### Clips

| Method | Path | Description |
|---|---|---|
| GET | `/projects/{project}/clips` | List clips of a project |
| GET | `/clips/{clip}` | Get one clip (score, highlight reason, transcript excerpt) |
| GET | `/clips/{clip}/download` | Stream the rendered MP4 file (owner only; 404 when no file exists yet) |
| PATCH | `/clips/{clip}` | Edit start/end, title, include/exclude, order |
| POST | `/clips/{clip}/render` | (Re-)render one clip → `202` + job |

### Exports

| Method | Path | Description |
|---|---|---|
| POST | `/projects/{project}/export` | Export selected/all clips as MP4 or ZIP → `202` + export |
| GET | `/exports` | Export history |
| GET | `/exports/{export}` | One export (download URL when ready) |

### Settings

| Method | Path | Description |
|---|---|---|
| GET | `/settings` | My settings (defaults, processing mode, export defaults) — creates the row with defaults on first access |
| PATCH | `/settings` | Update my settings (Phase 3 FIX 2: real validated update, was a 501 stub) |

### Admin (role: admin)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/dashboard` | Real counts only — no revenue/billing fields until billing exists |
| GET | `/admin/users` | List users (never returns passwords/hashes) |
| GET | `/admin/projects` | List all projects |
| GET | `/admin/jobs` | List all jobs (filter by `state`) |
| POST | `/admin/jobs/{job}/retry` | Admin retry |
| POST | `/admin/jobs/{job}/cancel` | Admin cancel |
| GET | `/admin/system/health` | CPU/RAM/disk, worker, FFmpeg version, Whisper model, DB, optional Redis/Ollama |
| GET | `/admin/system/logs` | Recent sanitized logs (secrets redacted) |

## Create job (POST /api/v1/jobs) — Phase 3 Job System

**This is the contract the New Job UI builds against.** One request
creates a job with a source and the full dropdown-only settings. Auth:
Sanctum bearer token. Exactly one source is required: either a `file`
(multipart) or a `source_url` (JSON or multipart field). A project is
created automatically when `project_id` is omitted.

### Request — link source (JSON)

```http
POST /api/v1/jobs
Authorization: Bearer <token>
Content-Type: application/json

{
  "platform": "tiktok",
  "aspect_ratio": "9:16",
  "clip_count": 3,
  "duration_mode": "exact",
  "duration_seconds": 60,
  "captions_enabled": true,
  "captions_language": "english",
  "on_screen_text": false,
  "job_type": "myself",
  "layout": "center_crop",
  "source_url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

### Request — upload source (multipart)

```http
POST /api/v1/jobs
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <video file: mp4/mov/mkv/webm, max 2 GiB>
platform: tiktok
aspect_ratio: 9:16
clip_count: 3
duration_mode: exact
duration_seconds: 60
captions_enabled: true
captions_language: english
on_screen_text: false
job_type: myself
layout: center_crop
```

### Fields

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `file` | file | one of file/`source_url` | mp4/mov/mkv/webm, max 2 GiB; FFprobe-validated at upload |
| `source_url` | string (URL) | one of file/`source_url` | YouTube, TikTok, Google Drive, or direct video-file link; other hosts → 422 |
| `project_id` | integer | no | Existing project I own; omitted → a project is auto-created |
| `title` | string ≤255 | no | Project/job title (defaults to filename or link host) |
| `platform` | string | **yes** | `tiktok` \| `instagram` |
| `aspect_ratio` | string | **yes** | `9:16` \| `16:9` \| `1:1` \| `4:5` |
| `clip_count` | integer | **yes** | 1–10 |
| `duration_mode` | string | **yes** | `exact` \| `minimum` \| `maximum` |
| `duration_seconds` | integer | **yes** | 5–180 (exact length, or min/max bound per mode) |
| `duration_min_seconds` | integer | no | 5–180, must be < `duration_max_seconds` |
| `duration_max_seconds` | integer | no | 5–180 |
| `captions_enabled` | boolean | no | default `true` |
| `captions_language` | string | no | `english` \| `roman_urdu` \| `hindi` \| `auto` (default) |
| `on_screen_text` | boolean | no | default `false` |
| `job_type` | string | no | `myself` (default) \| `campaign` |
| `campaign_requirements` | string ≤5000 | when `campaign` | Free text describing the campaign's requirements |
| `layout` | string | no | `center_crop` (default) \| `split` (streamer-top/gameplay-bottom, 9:16 only) |
| `content_type` | string | no | `podcast` \| `interview` \| `education` \| `gaming` \| `commentary` \| `story` \| `general` |
| `quality` | string | no | `draft` \| `standard` \| `high` |

### Response — `201 Created`

```json
{
  "job": {
    "id": 12,
    "project_id": 7,
    "status": "queued",
    "state": "queued",
    "stage": "Queued",
    "progress": 0,
    "settings": {
      "platform": "tiktok",
      "aspect_ratio": "9:16",
      "clip_count": 3,
      "duration_mode": "exact",
      "duration_seconds": 60,
      "captions_enabled": true,
      "captions_language": "english",
      "on_screen_text": false,
      "job_type": "myself",
      "layout": "center_crop"
    },
    "source_type": "link",
    "source_url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "clips": [],
    "error_code": null,
    "error_message": null,
    "created_at": "2026-11-22T01:00:00.000000Z",
    "updated_at": "2026-11-22T01:00:00.000000Z"
  }
}
```

Errors: `422` when both/neither source is given, the link host is not
allowed, `job_type=campaign` without `campaign_requirements`, or any
setting is outside its dropdown values; `422` when an uploaded file
does not probe as a playable video.

### Get job — `GET /api/v1/jobs/{id}`

Returns the same `job` object, with `clips` populated once the worker
has uploaded them:

```json
{
  "job": {
    "id": 12,
    "status": "ready",
    "state": "completed",
    "stage": "Ready",
    "progress": 100,
    "settings": { "...": "as created" },
    "clips": [
      {
        "id": 34,
        "title": "Clip 1",
        "status": "ready",
        "start_seconds": 12.5,
        "end_seconds": 72.5,
        "duration_seconds": 60.04,
        "aspect_ratio": "9:16",
        "file_size_bytes": 4821331,
        "score": 0.87,
        "reason": "Score 0.87: speech density 0.91, sentence complete, ...",
        "transcript_excerpt": "…",
        "download_url": "http://127.0.0.1:8000/api/v1/clips/34/download",
        "created_at": "2026-11-22T01:05:00.000000Z"
      }
    ],
    "error_code": null,
    "error_message": null
  }
}
```

`GET /api/v1/jobs?status=ready` filters by public status (`queued`,
`processing`, `ready`, `failed`, `cancelled`).

## Muse Job API (X-Muse-Api-Key) — worker contract

Auth: `X-Muse-Api-Key: <key from backend/laravel/.env MUSE_JOB_API_KEY>`.
No Sanctum token, no user session. A missing/wrong key gets `401`
`{"message": "Unauthenticated.", "code": "UNAUTHENTICATED"}`.

### List Queued jobs — `GET /api/v1/muse/jobs?status=queued`

```json
{
  "data": [
    {
      "id": 12,
      "project_id": 7,
      "user_id": 3,
      "status": "queued",
      "state": "queued",
      "settings": { "...": "full job settings" },
      "source_type": "upload",
      "source_url": null,
      "source_path": "uploads/9f2c…​.mp4",
      "source_local_path": "/home/hatch/workspace/magician-clipper/backend/laravel/storage/app/uploads/9f2c….mp4",
      "clips": []
    }
  ],
  "meta": { "current_page": 1, "per_page": 50, "total": 1, "last_page": 1 }
}
```

`source_local_path` is absolute because the worker runs on the same
machine as the backend. It is **never** returned by user-facing
endpoints.

### Report status — `PATCH /api/v1/muse/jobs/{id}/status`

```http
PATCH /api/v1/muse/jobs/12/status
X-Muse-Api-Key: <key>
Content-Type: application/json

{"status": "Processing", "stage": "transcribing", "progress": 20}
```

```http
PATCH /api/v1/muse/jobs/12/status
X-Muse-Api-Key: <key>
Content-Type: application/json

{"status": "Failed", "error_reason": "yt-dlp failed: video unavailable"}
```

- `status`: `Queued` | `Processing` | `Ready` | `Failed`
  (case-insensitive). `error_reason` is kept verbatim as the job's
  `error_message` (max 500 chars). `stage`/`progress` are optional
  progress reports; reporting the same status again only updates them.
- Illegal transitions (e.g. `Failed` after `Ready`) → `422`
  `{"error": "invalid_state", "message": "Invalid job state transition: …"}`.

### Upload a clip — `POST /api/v1/muse/jobs/{id}/clips`

Multipart, only while the job is `Processing`:

```http
POST /api/v1/muse/jobs/12/clips
X-Muse-Api-Key: <key>
Content-Type: multipart/form-data

file: <clip MP4, max 2 GiB>
title: Clip 1
start_seconds: 12.5
end_seconds: 72.5
duration_seconds: 60.04
score: 0.87
reason: Score 0.87: speech density 0.91, ...
transcript_excerpt: …
```

Response `201` + the created clip. The file is ffprobe-validated
server-side first (must be a playable MP4 with a video stream); an
invalid file → `422` and no clip record is created. Uploading while
the job is not `Processing` → `422` `invalid_state`.

## Analyze request (POST /projects/{project}/analyze)

```json
{
  "media_asset_id": "uuid",
  "clip_count": 3,
  "duration_mode": "exact",
  "duration_seconds": 30,
  "aspect_ratio": "9:16",
  "captions_enabled": true,
  "caption_preset": "Bold Pop",
  "language": null,
  "processing_mode": "balanced",
  "content_type": "podcast",
  "keywords_include": [],
  "keywords_exclude": [],
  "quality": "standard"
}
```

- `clip_count`: presets 1/3/5/10 or custom (1–10).
- `duration_mode`: `exact` | `minimum` | `maximum`.
- `duration_seconds`: presets 15/20/30/45/60 or custom (5–180).
- `aspect_ratio`: `9:16` | `16:9` | `1:1` | `4:5`.
- `processing_mode`: `eco` | `balanced` | `fast`.
- `content_type`: `podcast` | `interview` | `education` | `gaming` |
  `commentary` | `story` | `general`.
- `language`: ISO 639-1 code, or `null` for auto-detect.

## Job states

Internal pipeline states (spec §11):

`uploaded → queued → probing → extracting_audio → transcribing →
detecting_scenes → analyzing → selecting_clips → rendering → captioning →
validating → completed` (or `failed`; `cancelling → cancelled`).

Valid transitions are defined in
[`../shared/api-contracts/job-states.json`](../shared/api-contracts/job-states.json)
and validated server-side. Terminal states: `completed`, `failed`,
`cancelled`. Only a failed job may be retried (`failed → queued`).

**Public status (Phase 3 Job System):** the user panel and the Muse
worker speak `queued → processing → ready` (or `failed`, `cancelled`),
derived from the internal state (`ProcessingJob::publicStatus()`):
`uploaded`/`queued` → `queued`, `completed` → `ready`, `failed` →
`failed`, `cancelled` → `cancelled`, any in-flight state →
`processing`. The Muse status endpoint walks the internal machine along
valid transitions only (`advanceTo()`); illegal transitions are 422.

## Pagination

List endpoints accept `page` (default 1) and `per_page` (default 15, max 100)
and return:

```json
{
  "data": [ /* items */ ],
  "meta": { "current_page": 1, "per_page": 15, "total": 42, "last_page": 3 }
}
```

## Error format

```json
{
  "message": "The given data was invalid.",
  "code": "VALIDATION_FAILED",
  "errors": { "clip_count": ["The clip count must be between 1 and 10."] }
}
```

| HTTP | Meaning |
|---|---|
| 400 | Bad request |
| 401 | Unauthenticated |
| 403 | Authenticated but not authorized (e.g. non-admin on admin route) |
| 404 | Not found (or not owned by the caller) |
| 409 | State conflict (e.g. cancel a completed job, retry a running job) |
| 422 | Validation failed (field errors in `errors`) |

Error messages are user-facing and sanitized — internal paths and secrets
are never included.

## Job polling guidance

- Poll `GET /jobs/{job}` (2 s cadence is acceptable for Phase 1).
- Display `stage` (e.g. "transcribing") and `progress`.
- `progress` is **real and measurable only**. If a stage has no
  measurable percentage, show the stage with indeterminate progress —
  never animate a fake percentage.
- A job is complete only when `status` is `ready` **and** its clips have
  been validated (real playable files). Never mark complete before validation.
- On `failed`, show `error_code`/`error_message` and offer retry/cancel.
- On `cancelled`, stop polling.
- SSE/WebSockets may replace polling in a later phase.

## Worker polling (Muse Job API)

- The worker polls `GET /muse/jobs?status=queued` (default every 300 s;
  see `scripts/muse-poll.sh` and `docs/processing-pipeline.md` §3).
- It claims a job with `PATCH …/status {"status": "Processing"}`,
  reports progress with the same endpoint (`stage`/`progress`), uploads
  clips with `POST /muse/jobs/{id}/clips`, then marks the job `Ready`
  (or `Failed` with the exact `error_reason`).
- In this environment Muse runs on the same VM and calls the local API
  (`http://127.0.0.1:8000`).
