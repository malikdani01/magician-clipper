# Architecture

**Status: Phase 1 in-progress.** This document describes the *intended*
architecture from the master spec (§5, §6, §11, §15). The frontend, backend
and video engine are being built by sibling subagents in parallel; nothing
described here should be read as "implemented" unless the root README's
status table says so with evidence.

## Monorepo layout

```text
magician-clipper/
├── apps/
│   └── web/                    # React + TypeScript + Vite + Tailwind (frontend builder)
├── backend/
│   └── laravel/                # Laravel API — source of truth (backend builder)
├── services/
│   └── video-engine/           # Python 3.12 + FastAPI + FFmpeg + faster-whisper + OpenCV
├── shared/
│   ├── api-contracts/          # api-v1.yaml (OpenAPI), job-states.json, types.ts
│   └── design-tokens/          # tokens.json, tokens.css
├── storage/
│   ├── uploads/ projects/ clips/ exports/ thumbnails/ temp/ logs/
├── docs/
├── scripts/                    # health-check.sh, dev.sh, check-env.sh
├── .env.example
├── .gitignore
└── README.md
```

Desktop (`apps/desktop`, Tauri wrapper) is a Phase 5 milestone and is **not**
in Phase 1. Never claim a Windows installer exists unless it was built and
tested.

## Service responsibilities

| Service | Owns | Does NOT own |
|---|---|---|
| **Frontend** (`apps/web`) | User panel + admin panel UI, 5-step workflow, polling job state, previews, downloads | Any processing; any auth decisions (server decides) |
| **Backend** (`backend/laravel`) | Users, roles, projects, permissions, settings, job records, upload validation, auth (Sanctum), queue dispatch, audit logs | Video processing itself (delegates to the engine) |
| **Video engine** (`services/video-engine`) | FFprobe, audio extraction, faster-whisper transcription, scene/highlight detection, reframing, captions, FFmpeg rendering, output validation | User accounts, billing, job ownership |
| **Queue** (database by default) | Job delivery, retries, timeouts, cancellation, stale-job recovery | — |
| **Storage** (`storage/`) | Media on disk, never DB blobs | — |

## Data flow — Import → Style → Process → Review → Ship

```
1. IMPORT    Browser ──multipart──▶ Laravel ──store──▶ storage/uploads/
             Laravel runs FFprobe (via engine) → MediaAsset metadata
2. STYLE     User picks clip count, duration mode, aspect ratio, captions,
             language, processing mode, content type, keywords
3. PROCESS   Laravel creates ProcessingJob (state: uploaded → queued)
             → queue worker → video engine pipeline:
               probing → extracting_audio → transcribing → detecting_scenes
               → analyzing → selecting_clips → rendering → captioning
               → validating → completed | failed
             Frontend polls GET /api/v1/jobs/{job} (2 s cadence is fine for
             Phase 1; SSE/WebSockets are a later option)
4. REVIEW    Clips listed with previews, scores, highlight reasons,
             transcript excerpts; user edits start/end, includes/excludes,
             re-renders single clips
5. SHIP      Export one / selected / all as MP4 or ZIP; download links +
             export history
```

## Auth and roles

- Laravel Sanctum bearer tokens (`Authorization: Bearer <token>`).
- Roles: `user`, `admin`. Admin routes (`/api/v1/admin/*`) require the admin
  role; normal users must never access admin pages or APIs.
- Every project/media/clip/export operation is authorized server-side against
  the owning user (policies). Storage paths are server-generated and never
  guessable across users.
- Passwords are hashed (bcrypt/argon2); never displayed, never logged.
- Secrets (e.g. optional Gemini key) are stored server-side only, shown as
  configured/not-configured, never revealed.

## Queue

- Default: **database queue** — no Redis required to launch locally.
- `sync` driver for dev only (jobs run inline).
- Redis is an optional backend for multi-user server deployment.
- One worker by default on 8 GB RAM (`PROCESSING_CONCURRENCY=1`).
- Retries, timeouts, cancellation (`cancelling` → `cancelled`) and
  stale-job recovery are required behaviours (spec §12, §15 Phase 5).

## Job state machine

States (spec §11): `uploaded, queued, probing, extracting_audio,
transcribing, detecting_scenes, analyzing, selecting_clips, rendering,
captioning, validating, completed, failed, cancelling, cancelled`.

Valid transitions are defined in `shared/api-contracts/job-states.json` and
must be validated server-side. Terminal states: `completed`, `failed`,
`cancelled`. A failed job may be retried (`failed` → `queued`) with source
media and settings preserved.

Progress: `progress_percent` is **real and measurable only**. When a stage
has no measurable percentage, the API reports the stage label with
indeterminate progress — never a fabricated number.

## Storage

See `storage/README.md`. Key rules:

- Originals in `storage/uploads/` are **never deleted by cleanup** — only by
  explicit project deletion.
- `storage/temp/` is cleaned after job completion or retention expiry
  (`TEMP_RETENTION_HOURS`, default 24 h).
- Media on disk, never as database blobs. No internal paths exposed to users.

## Database

- SQLite for local/desktop development (`DB_CONNECTION=sqlite`,
  `DB_DATABASE=storage/database.sqlite`).
- MySQL/PostgreSQL supported for multi-user server deployment.
- Migrations + indexes; foreign keys; ownership constraints; explicit status
  values. Entities (spec §11): users, roles/permissions, projects,
  media_assets, processing_jobs, transcripts, transcript_segments,
  highlight_candidates, clips, clip_edits, caption_presets, brand_kits,
  exports, user_settings, system_settings, notifications, support_tickets
  (if implemented), audit_logs.

## Hybrid / optional AI

Core pipeline is local-first: FFmpeg, faster-whisper, OpenCV. Ollama
(optional local LLM for semantic ranking) and Gemini (optional cloud
adapter) are **disabled by default**, require the user's own key/endpoint,
and must fail gracefully with the core flow still working.

## Phase 1 scope (honest)

Done in this builder's scope: repo skeleton, API contract, design tokens,
storage layout, docs, scripts. **Pending:** frontend app shell, Laravel API +
migrations, video engine, live health checks, Windows verification. See the
root README status table.
