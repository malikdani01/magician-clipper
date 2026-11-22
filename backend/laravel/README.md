# Magician Clipper — Laravel Backend

Main API backend for Magician Clipper (spec §5, §8, §11). Laravel is the
source of truth for users, projects, permissions, settings, and job records.
The Python video-engine (`services/video-engine`) only processes media; it
never owns users, projects, or permissions.

> **Laravel scaffold only — PHP/Composer were not available at scaffold time; run `composer install` + `php artisan migrate` once PHP lands.**
>
> At scaffold time (2026-11-22, Muse Linux VM) `php` and `composer` were
> not installed (`php: command not found`, exit 127). The full Laravel
> structure below was written by hand: real `composer.json`, migrations,
> models, controllers, routes, middleware, policies, and seeder. **The
> backend has NOT been run and migrations have NOT been executed yet.**
> An `apt-get install php8.3-cli … composer` was in progress in the
> background when this scaffold was written; re-check `php --version`
> before running the commands below.

## Status (Phase 1)

| Area | State |
|---|---|
| Auth (register/login/logout/me) | Real code (Sanctum tokens) — not yet run |
| Projects CRUD | Real code, ownership policies — not yet run |
| Jobs show/cancel/retry | Real code, state-machine guarded — not yet run |
| Clips list/show/patch | Real code — not yet run |
| Exports list/show | Real code — not yet run |
| Upload / analyze / render / export / settings | Routed, honest `501 not_implemented` (Phase 2/3) |
| Admin dashboard/users/projects/jobs/health | Real code, `admin` middleware (403 for non-admins) — not yet run |
| Migrations (6 tables) | Written, **not yet run** |

## Requirements

- PHP ^8.2 (8.3 recommended) with extensions: `pdo_sqlite`, `mbstring`,
  `xml`, `curl`, `zip`, `gd`, `fileinfo`, `openssl`, `tokenizer`
- Composer 2.x
- SQLite (local/desktop dev) — no MySQL/Redis required

## Setup (once PHP + Composer exist)

```bash
cd backend/laravel
cp .env.example .env
composer install --no-interaction
php artisan key:generate
touch database/database.sqlite
php artisan migrate --force
php artisan serve --host=127.0.0.1 --port=8000
```

Create the first admin user (credentials come from YOUR environment —
never hard-code them, never commit them):

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<strong-password>' php artisan db:seed
```

Without `ADMIN_EMAIL`/`ADMIN_PASSWORD` the seeder creates nothing.

## Run

```bash
php artisan serve --host=127.0.0.1 --port=8000   # API at http://127.0.0.1:8000/api/v1
php artisan queue:work                            # local file queue (Phase 3)
```

## Configuration

- `DB_CONNECTION=sqlite`, `DB_DATABASE=<absolute path>/database/database.sqlite`
- `VIDEO_ENGINE_URL=http://127.0.0.1:8001` — Python FastAPI video engine
- `FILESYSTEM_DISK=local` — media on disk under `storage/app`
  (`uploads/`, `projects/`, `clips/`, `exports/`, `thumbnails/`, `temp/`)
- `CLIPPER_MAX_UPLOAD_MB=4096`, `CLIPPER_ALLOWED_EXTENSIONS=mp4,mov,mkv,webm`

## API (versioned `/api/v1`)

Auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`,
`GET /me`. Projects CRUD, `POST /projects/{project}/upload`,
`GET /projects/{project}/media`, `POST /projects/{project}/analyze`,
`GET /jobs/{job}`, `POST /jobs/{job}/cancel|retry`,
`GET /projects/{project}/clips`, `GET|PATCH /clips/{clip}`,
`POST /clips/{clip}/render`, `POST /projects/{project}/export`,
`GET /exports[/{export}]`, `GET|PATCH /settings`.
Admin (`admin` middleware, 403 otherwise): `GET /admin/dashboard|users|
projects|jobs`, `POST /admin/jobs/{job}/retry|cancel`,
`GET /admin/system/health|logs`.

Full contract: see `docs/api.md` (docs/shared agent).

## Job state machine

States (spec §11): `uploaded, queued, probing, extracting_audio,
transcribing, detecting_scenes, analyzing, selecting_clips, rendering,
captioning, validating, completed, failed, cancelling, cancelled`.
Transitions are enforced by `App\Models\ProcessingJob::VALID_TRANSITIONS`
(`assertValidTransition()` / `transitionTo()`); invalid transitions throw
and are returned as `422 invalid_state`. `failed → queued` is the retry
path; only `cancelling → cancelled`.

## Tests

```bash
php artisan test
```

Unit: job state transitions (`tests/Unit/ProcessingJobStateTest.php`).
Feature: auth + admin gating (`tests/Feature/AuthAndAdminTest.php`).
Both require `composer install` first; neither has been run yet.

## Security notes (spec §13)

- Sanctum token auth on all non-public routes; per-project ownership
  policies; admin routes additionally gated by `EnsureAdmin`.
- Uploads (Phase 3) must use server-generated filenames, validate
  extension/MIME/FFprobe result, and never expose internal paths.
- Never put secrets in logs or code; the seeder reads admin credentials
  only from the environment.
