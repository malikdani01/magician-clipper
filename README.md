# Magician Clipper

**AI long-video → short-clips studio — local-first, zero-budget core, CPU-only.**

Magician Clipper turns long videos (podcasts, interviews, talks, gameplay, vlogs) into
short, vertical-ready clips: upload → transcribe → detect highlights → render →
reframe → caption → preview → export. The core pipeline runs entirely on the local
machine with FFmpeg, faster-whisper and OpenCV. No paid API is required for the core
flow; Ollama and Gemini are optional adapters, disabled by default.

> **Status:** Phase 1 (foundation) complete; **Phase 2 (complete panels) complete
> 2026-11-22 ~01:44 PKT**; **Phase 3 (panel fidelity, Render hosting docs, Muse-connected
> job system, acceptance test) complete 2026-11-22 ~22:07 PKT** — see the
> [Phase 1 status table](#phase-1-status), [Phase 2 status](#phase-2-status) and
> [Phase 3 status](#phase-3-status) below. Nothing is marked "done" without
> evidence. No live deployment exists yet.

## Architecture at a glance

| Layer | Tech | Responsibility |
|---|---|---|
| Frontend | React + TypeScript + Vite + Tailwind | User panel + admin panel, 5-step workflow (Import → Style → Process → Review → Ship) |
| Backend | Laravel (PHP 8.2+) + SQLite (local) | Source of truth for users, projects, permissions, settings, job records; versioned REST API `/api/v1` |
| Video engine | Python 3.12 + FastAPI + FFmpeg + faster-whisper + OpenCV | Probe, transcribe, detect highlights/scenes, reframe, caption, render, validate |
| Queue | Database queue (default) / sync for dev; Redis optional | One worker by default on 8 GB RAM; retries, timeouts, cancellation, stale-job recovery |
| Storage | Local disk under `storage/` | Originals, projects, clips, exports, thumbnails, temp, logs |

Data flow: **Import → Style → Process → Review → Ship**
(see [docs/architecture.md](docs/architecture.md)).

Full specification: `~/workspace/user/files/Magician_Clipper_Complete_Master_Prompt_3_40up.md`
(master prompt, §5 architecture, §6 repo layout, §11 API, §15 roadmap, §19 definition of done).

## Prerequisites

| Tool | Minimum | This VM (verified 2026-11-22) | Windows 10 target |
|---|---|---|---|
| Node.js | 22+ | **24.22.1** ✅ | Install LTS from nodejs.org |
| Python | 3.12 | **3.12.3** ✅ | Install from python.org, tick "Add to PATH" |
| FFmpeg + FFprobe | 6+ | **8.1.2** ✅ | Download from gyan.dev, add `bin` to PATH |
| PHP | 8.2+ | **8.3.6** ✅ (installed 2026-11-22) | Install from windows.php.net |
| Composer | 2.x | **2.7.1** ✅ (installed 2026-11-22) | Installer from getcomposer.org |

Run `bash scripts/check-env.sh` to check everything on your machine.

## Quick start (Linux dev VM)

```bash
# 1. Clone / enter the repo
cd ~/workspace/magician-clipper

# 2. Environment (copy and fill in — never commit real secrets)
cp .env.example .env

# 3. Check tooling
bash scripts/check-env.sh

# 4. Start the services (each in its own terminal, or use scripts/dev.sh)
#    Video engine (FastAPI, port 8001)
cd services/video-engine && uvicorn app.main:app --host 127.0.0.1 --port 8001

#    Backend (Laravel, port 8000)
cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000

#    Frontend (Vite, port 5173)
cd apps/web && npm install && npm run dev

# 5. Health check
bash scripts/health-check.sh
```

Windows 10 setup: [docs/installation-windows.md](docs/installation-windows.md)
(all Windows steps are marked unverified until run on a real Windows machine).

## Run commands (per service)

| Service | Command | URL |
|---|---|---|
| Video engine | `cd services/video-engine && uvicorn app.main:app --host 127.0.0.1 --port 8001` | http://127.0.0.1:8001/health |
| Backend | `cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000` | http://127.0.0.1:8000/api/v1/health |
| Frontend | `cd apps/web && npm run dev` | http://localhost:5173 |
| Convenience | `bash scripts/dev.sh` (engine + frontend) | — |

## Phase 1 status

Honest status as of 2026-11-22 ~01:30 PKT. **Pending = not yet verified; never
claimed as working.**

| Feature | Status | Evidence |
|---|---|---|
| Monorepo skeleton (root, shared, storage, docs, scripts) | Done | This repo; `find` tree in verification below |
| API contract (`shared/api-contracts/api-v1.yaml`) | Done | YAML validated with PyYAML 6.0.1 |
| Job state machine (`job-states.json`) | Done | Validated with `python3 -m json.tool` |
| Design tokens (`shared/design-tokens/`) | Done | Derived from supplied screenshots (visual language only) |
| Storage layout + retention rules | Done | `storage/*/`, `storage/README.md` |
| Docs (architecture, Windows install, env, API) | Done | `docs/` |
| Health-check / env-check scripts | Done | `bash -n` syntax-checked; `check-env.sh` run for real (see below) |
| Frontend app shell (`apps/web`) | Verified | `npm run build` passed (1604 modules, 3.84s, exit 0); `tsc --noEmit` clean; preview smoke test HTTP 200 on `/`, `/clipper`, `/admin` |
| Laravel API + migrations (`backend/laravel`) | Verified | PHP 8.3.6 + Composer 2.7.1 installed 2026-11-22; `composer install` clean (one scaffold fix: created missing `bootstrap/cache/`); `.env` + app key generated; **7 migrations run** (6 app + Sanctum `personal_access_tokens`, published via `vendor:publish --tag=sanctum-migrations` after the first test run failed on the missing table); `route:list` shows **32** `/api/v1` routes; `php artisan test` **13 passed (37 assertions)**; live `artisan serve` check: register → 201 + token, login, `/me`, projects CRUD, admin dashboard returns real data, non-admin → 403 |
| Video engine (`services/video-engine`) | Verified | `GET /health` → `{"status":"ok"}`; `POST /probe` on a real 5s 1280×720 sample matches direct ffprobe on every field; `POST /extract-audio` produced a real 16 kHz mono WAV (5.0155s) — independently re-verified by the coordinator |
| `GET /health` live (engine :8001, backend :8000) | Verified | Engine `/health` ok (FFmpeg/ffprobe 8.1.2); backend `/up` HTTP 200 (there is no `/api/v1/health` route) |
| Windows 10 install steps | Pending | Documented from Linux equivalents; **not yet verified on a Windows machine** |
| End-to-end: upload → real clip | Pending | Phase 3 work |

## Phase 2 status

Complete panels, verified 2026-11-22 ~01:44 PKT. Frontend (`apps/web`, 22 files
changed): real API client (`src/lib/api.ts`, engine + Laravel, `Accept:
application/json` on every Laravel call), project store (`src/state/projects.tsx`,
Laravel-first when signed in, browser-local fallback), auth
(`src/state/auth.tsx`, real Sanctum login/register, `/login` + `/register`
routes), AI Clipper wizard (Step 1: real engine probe + playable preview +
optional audio extraction; Step 2: full per-job spec form; Steps 3–5: honest
Phase 3 pending UI, no fake progress), Studio Editor (real video preview,
play/pause, seek, start/end trim), Captions Studio (all 10 presets, live
preview, working font/color/animation controls, Apply disabled until Phase 3),
Brand Kit (browser-local save), Dashboard/Projects/Library/Exports/Usage fed by
real data (zeros when empty), Settings/Help updated, admin panel behind a real
guard (admin API: dashboard/users/projects/jobs/health; billing stays
"Not enabled"). `npm run build` passes (tsc clean, 1610 modules, 7.26s);
`vite preview` serves HTTP 200 for `/`, `/clipper`, `/admin` and all 18 panel
routes; engine `/probe` re-verified live on a generated 5s 1280×720 test video
(matches direct ffprobe on every field) and `/extract-audio` (16 kHz mono WAV,
5.0155s). Verification test accounts were deleted afterwards (0 users /
0 projects in the dev DB).

Known Phase 2 limitations (see the coordinator's report for detail):
unauthenticated Laravel calls without `Accept: application/json` return HTTP 500
instead of 401 (frontend always sends the header); `PATCH /api/v1/settings`
returns 501 for every payload (backend stub — Settings Save surfaces the exact
error); Laravel upload/analyze endpoints return "not implemented yet (Phase 3)";
no `/api/v1/health` route (use `GET /up`).

## Phase 3 status

Complete 2026-11-22 ~22:07 PKT (coordinator-verified). Four tasks, all built
from original code — no clone of any existing app; ClipShip files were never
downloaded or analyzed.

**Task A — panel fidelity pass.** 16 files under `apps/web/src/` (StatCard,
PageHeader, AppShell, AdminLayout, Dashboard, Projects, Library, Clipper,
Editor, Captions, BrandKit, Exports, Usage, Settings, Help, admin/AdminPages)
aligned to the two supplied screenshots (layout, sections, cards, tables,
chart positions, colors, spacing). `tsc --noEmit` clean, `npm run build` exit 0
(1610 modules), all 32 routes HTTP 200. Honest gaps kept: no line-chart /
% growth on the admin dashboard (no time-series data exists), no audio
waveform in the editor, thumbnails are icon tiles, the hero visual is original
CSS art (not the screenshot's magic-hat illustration), stat values are real
zeros for a new account, billing stays "Not enabled — billing does not exist
yet".

**Task B — hostable website (Render Free first).** `render.yaml` (API service
`magician-clipper-api`, static web `magician-clipper-web`, free Postgres
`magician-clipper-db`), `backend/laravel/Dockerfile` (php:8.3-apache,
pdo_sqlite/sqlite3/pdo_pgsql/mbstring/xml/curl/zip/gd, Composer 2),
`.dockerignore`, `backend/laravel/public/.htaccess` (was missing), and
`docs/deployment-render-free.md` (23 KB, exact deploy steps + Render Free
limits: 15-min idle sleep, 512 MB RAM, ephemeral disk, 750 h/month, free
Postgres expires after 90 days). `npm run build` PASS, `php artisan
config:cache` PASS, render.yaml parses. **Not verified:** `docker build`
(no Docker on this VM) and any live Render deploy — **no live deployment
exists.** Heavy video processing stays off Render by design (Muse worker,
Task C). One blocker found by this pass and fixed in Task C: there was no
`config/cors.php`, so hosted frontend→API calls (including login) would have
been blocked.

**Task C — Muse-connected job system.** New Job UI (`/jobs/new`, `/jobs`,
`/jobs/:id`): upload MP4/MOV/MKV/WEBM or paste a link, settings only from
dropdowns/toggles (Platform, Ratio, clip count 1–10, duration Exact/Min/Max
5–180 s, captions on/off + English/Roman Urdu/Hindi, on-screen text, self /
campaign with requirements box, split layout offered only at 9:16). Jobs in
the DB with unique Job ID, Queued → Processing → Ready / Failed; job detail
shows source, exact settings, clip list with duration + size, downloads.
Secure Muse Job API (`X-Muse-Api-Key`, timing-safe compare, fails closed 401):
`GET /muse/jobs?status=queued`, `GET /muse/jobs/{id}`, `PATCH
/muse/jobs/{id}/status`, `POST /muse/jobs/{id}/clips` (ffprobe-validated).
The key was generated server-side into `backend/laravel/.env` as
`MUSE_JOB_API_KEY` (never in chat/logs/code). Worker:
`services/video-engine/workers/muse_worker.py` (faster-whisper 1.2.1 +
OpenCV 5.1.0 in the engine venv; yt-dlp 2026.10.26) — claim → source (upload
path or yt-dlp, live streams capped at 10 min wall-clock) → ffprobe → 16 kHz
WAV → transcribe → explainable highlight scoring → FFmpeg render (ratio,
burned captions, split layout) → ffprobe validation → upload → Ready; failures
mark Failed with the exact reason. Polling: `scripts/muse-poll.sh`
(`--once` + 300 s loop) + cron example. Phase 2 fixes done: `ForceJsonResponse`
+ `AuthenticationException` renderer — unauthenticated calls without an
Accept header now return **401 JSON** (verified live, both with and without
`Accept: text/html`); `PATCH /api/v1/settings` is a real validated update
(was 501). CORS added (`config/cors.php`, origin from `FRONTEND_URL`,
preflight verified 204). `php artisan test` **32 passed (107 assertions)**
incl. `MuseJobApiTest` 19 tests. Docs: `docs/processing-pipeline.md`,
`docs/api.md`, `shared/api-contracts/api-v1.yaml` (34 paths), `docs/environment.md`.

**Task D — acceptance test (full loop, no chat in between).** Job **2**,
test user `clipper-acceptance-test@example.com` (id 5), project 4, created
21:25 PKT: link `https://www.youtube.com/live/irNhWMG560k?si=zzfgihMulcUw1EN3`,
TikTok, 9:16, 3 clips, exact 60 s (inside the specified 60–90 s range —
3×90 s would need 270 s from a 270.02 s source, zero slack), English captions
ON, on-screen text OFF, split layout, for self. Source reused, no re-download:
sibling's `~/workspace/clips-job1` raw1+raw2+raw3 concatenated (270.021 s,
1280×720 AV1 60 fps, 19,174,160 B) — the stream is a ~9.8 h live stream and
re-downloading would capture different live content. Job reached **Ready at
22:03:37** (verified live via `GET /api/v1/jobs/2`: `status: ready`,
`state: completed`, `progress: 100`; coordinator re-verified the same API
response and ffprobe on the stored files).

| Clip | Window | Duration | Size | Score |
|---|---|---|---|---|
| 1 (id 4) | 1.08–61.08 s | 60.00 s | 4,288,057 B | 0.38 |
| 2 (id 5) | 125.46–185.88 s | 60.43 s | 30,827,488 B | 0.90 |
| 3 (id 6) | 193.69–253.90 s | 60.21 s | 13,327,064 B | 0.80 |

All 1080×1920, h264+aac, 30 fps; downloads `GET /api/v1/clips/{4,5,6}/download`
all HTTP 200 with byte-exact sizes. Caption frames viewed (stored under
`services/video-engine/storage/muse-worker/job-2/validation/`): clip 1 t=5
"many times I plan to plan this.", clip 2 t=10 "It is only 60 rupees.", clip 3
t=30 "It can't be like that." — all match the worker's SRT cues exactly, so
caption timing is proven correct.

**Two real bugs found and fixed by the acceptance test:** (1) audio-gap
timestamp shift — raw1's audio is only 16.3 s, so plain audio extraction
compressed a 73.7 s gap out and every later caption would have landed ~73.7 s
early; fixed with `-af aresample=async=1:first_pts=0` (gap preserved as
silence, verified by silencedetect) + a WAV-duration warning log. (2) PHP
upload cap — stock `upload_max_filesize = 2M` / `post_max_size = 8M` made
clip upload fail with 422 (`UPLOAD_ERR_INI_SIZE`); fixed to 2048M in
`/etc/php/8.3/cli/php.ini` (VM-local only; a deployed image needs the same
values in its own php.ini — `artisan serve -d` flags do NOT propagate to its
`php -S` child). Pre-staged-source reuse was added to the worker so a link
job can use a staged local file instead of re-downloading.

**Honest caveats on the acceptance result (acceptance passes as specified,
but the quality gaps are real):** (1) **Clip 1 is ~75% silent** — its window
spans the source audio gap (AAC only 15.17 s, no captions after ~15 s); the
selector knew it was weakest (score 0.38). (2) **Captions are oversized** —
whole SRT segments (up to ~10 s of speech) at 46 pt fill most of the frame
and clip at the edges ("rupees." touches the right edge in clip 2); punchy
1–4-words-per-screen style: no. (3) **Split layout never face-detects on this
VM** — the venv's `cv2/data/` has no Haar cascade XML files, so the
top-45%/bottom-55% frame-analysis fallback runs; in the sampled frames the
"streamer top" panel shows game content and the streamer's facecam stays the
source's own small inset box. The 9:16 split exists, but true
streamer-top/gameplay-bottom separation was NOT delivered. Follow-ups:
ship the cascade file, add audio-span validation, and decide the caption
style (the sibling chat's user feedback asks for punchy 1–4-word captions
with yellow key words — a coordinator decision, not applied mid-test).

**Still pending after Phase 3:** speech-driven highlight selection on real
speech is unproven on live data beyond this one job (the E2E sample had no
speech); the link-source path + 10-min live cap was not exercised live
(Task D reused a staged source); `docker build` untested; no live Render
deploy; no real-browser click-through of `/jobs/new` submit (Task D created
the job via API); Windows 10 install steps still unverified; transcription is
mildly nondeterministic run-to-run (94 vs 98 segments). Test user + job 2 are
kept as the acceptance deliverable; test-user password/token are in
`/tmp/clipper-test-pass.txt` and `/tmp/clipper-test-token.txt` (mode 600).

## Verification performed (this builder)

```text
$ bash -n scripts/health-check.sh scripts/dev.sh scripts/check-env.sh   # syntax OK
$ bash scripts/check-env.sh                                              # see output in docs or run it
$ python3 -c "import yaml; yaml.safe_load(open('shared/api-contracts/api-v1.yaml'))"  # OK
$ python3 -m json.tool shared/api-contracts/job-states.json > /dev/null  # OK
$ find ~/workspace/magician-clipper -maxdepth 2 -type d | sort           # tree confirmed
```

## Docs

- [docs/README.md](docs/README.md) — docs index
- [docs/architecture.md](docs/architecture.md) — monorepo layout, services, data flow
- [docs/installation-windows.md](docs/installation-windows.md) — Windows 10 setup
- [docs/environment.md](docs/environment.md) — every environment variable
- [docs/deployment-render-free.md](docs/deployment-render-free.md) — Render Free deployment (Blueprint, env vars, limits); **no live deployment exists yet**
- [docs/api.md](docs/api.md) — API reference (summary of the OpenAPI contract)

Docs required by the spec but not in this builder's scope
(`security.md`, `testing.md`, `performance.md`,
`admin-guide.md`, `user-guide.md`, `CHANGELOG.md`) are **Pending** — they belong
to later phases and must be written from implemented behaviour, not speculation.
(`docs/processing-pipeline.md` was written in Phase 3.)

## Rules (from the spec, §1 — non-negotiable)

- No fake/mock clip generation, fake progress, fake analytics or fabricated results.
- A clip is complete only after a real playable output file has been generated
  and validated.
- Every visible control must work or be clearly marked unavailable.
- Never claim a feature is complete until it has been tested.
- Core workflow usable without paid APIs; originals are never deleted by cleanup.

## License

Original code and assets only. Reference screenshots were used as visual/workflow
guidance, not copied. No proprietary source, private APIs, credentials or
license systems are included.
