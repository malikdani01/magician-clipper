# Deploying Magician Clipper on Render Free

**Status: deployment files ready, no live deployment exists.** This
document describes how to take the repo in `~/workspace/magician-clipper`
to a live URL on Render's Free plan. Nothing here has been deployed
yet — there is no Render account access from this VM, so every step
below is a step *you* (or the deployer) run in the Render dashboard.
Nothing in this doc claims a step was already done.

Related files:

- `render.yaml` (repo root) — Render Blueprint: API service + static
  frontend + free PostgreSQL, in one file.
- `backend/laravel/Dockerfile` — PHP 8.3 + Apache image for the API.
- `backend/laravel/public/.htaccess` — stock Laravel rewrite rules
  (was missing; Apache needs it so `/api/v1/...` routes resolve).
- `backend/laravel/.dockerignore` — keeps secrets and local files out
  of the Docker build context.

---

## 1. What gets deployed — and what does not

| Piece | On Render Free? | How |
|---|---|---|
| React frontend (`apps/web`) | Yes | Static Site (free, no instance hours) |
| Laravel API (`backend/laravel`) | Yes | Docker Web Service, Free plan (PHP 8.3 + Apache) |
| PostgreSQL (users, projects, jobs) | Yes | Render free database (1 GB, **expires after 30 days** — see §6) |
| Python video engine (`services/video-engine`) | **No** | Runs on the separate Muse worker (dev VM). See §5. |
| Queue worker (`php artisan queue:work`) | **No** | Background workers are not available on the Free plan. See §6. |
| Uploaded videos / rendered clips | Ephemeral only | Local disk inside the container; **lost on every deploy**. See §7. |

What works on the hosted deployment, honestly:

- Register / login / logout, `/me`, projects CRUD, admin dashboard,
  users/projects/jobs lists, admin system-health endpoint — these are
  real, implemented backend routes.
- The frontend serves all 18 panel routes; the Dashboard shows the
  backend as **Up** and the video engine as **Down** (real status, not
  faked).
- The AI Clipper wizard Step 1 (Import) will **fail honestly**: picking
  a file shows "Probe failed — Video engine is not reachable at
  http://127.0.0.1:8001" with a Retry button. That is the correct
  behaviour while the engine is not publicly reachable — no fake
  metadata is shown. (Minor wart: the error box then tells the visitor
  to run a local `uvicorn` command, which only makes sense on a dev
  machine, not for a visitor of the hosted site. See §8, finding F3.)

What does NOT work on the hosted deployment yet (not Render's fault —
these are features not built yet, and the UI says so honestly):

- Clip re-render with a new caption style (`POST /clips/{clip}/render`
  is a 501 stub); password change; profile photo upload; billing;
  trimmed-video export from the Editor; separate audio export.
- The AI Clipper wizard's Steps 3–5 (Process / Review / Ship) are
  honest placeholders — the real end-to-end flow is **New Job**
  (upload or link + settings + Notes) → Muse worker → clips back on
  the job page. See §5.

What DOES work now (verified on the dev VM 2026-11-22, final test):

- Register / login / logout, `/me`, profile save (name + email),
  projects, New Job submit, job detail with viral scores + thumbnails,
  clip download, Export ZIP, admin dashboard, users/projects/jobs
  lists, admin system-health and system logs endpoints.
- Unauthenticated calls return JSON 401 (not 500).

---

## 2. Before you start

1. **A GitHub account and a repo.** This workspace is not a git repo
   yet. From the repo root:
   ```bash
   cd ~/workspace/magician-clipper
   git init
   git add -A
   git commit -m "Magician Clipper — user/admin panels, Muse Job API, 13 animated caption styles, Render Free deployment files"
   git branch -M main
   git remote add origin https://github.com/<your-username>/magician-clipper.git
   git push -u origin main
   ```
   (`.gitignore` already excludes `.env`, `node_modules/`, `vendor/`,
   `*.sqlite`, build output, the worker's rendered media
   (`services/video-engine/storage/`), demo videos (`demo/*.mp4`) and
   screenshots (`preview-shots/`), so no secrets or media are pushed.
   Double-check with `git status` before the first push — if a real
   `.env` ever appears in the list, stop and remove it.)
2. **A Render account** (render.com — sign up with GitHub is easiest).
   No card is needed for the Free plan.
3. **An `APP_KEY`.** Laravel encrypts session cookies with it; it must
   be a 32-byte key and it must stay the same across deploys (changing
   it logs everyone out). Generate one — no PHP needed:
   ```bash
   python3 -c "import secrets,base64; print('base64:'+base64.b64encode(secrets.token_bytes(32)).decode())"
   ```
   (With PHP available, the equivalent is `php artisan key:generate
   --show` from `backend/laravel`.) Copy the output somewhere safe —
   it goes into the Render dashboard in step 4, never into the repo.

---

## 3. Deploy, step by step

### Step 1 — Create the Blueprint in Render

1. Render dashboard → **New +** → **Blueprint**.
2. Connect / pick the `magician-clipper` GitHub repo, branch `main`.
3. Render reads `render.yaml` and shows three resources to create:
   `magician-clipper-api` (Web Service), `magician-clipper-web`
   (Static Site), `magician-clipper-db` (PostgreSQL). Click
   **Apply**.
4. Render starts building the API image first. The first build takes
   several minutes (PHP extensions + `composer install`). The static
   site build (`npm ci && npm run build`) runs in parallel.

### Step 2 — Fill in the values Render cannot know yet

While the first build runs, open each service → **Environment** and
fill in the `sync: false` variables (they are listed in `render.yaml`
with no value on purpose):

**`magician-clipper-api` (Web Service):**

| Variable | Value | Where it comes from |
|---|---|---|
| `APP_KEY` | `base64:...` (44 chars) | §2, step 3 — paste the generated key |
| `APP_URL` | `https://magician-clipper-api.onrender.com` | The service's own URL, shown at the top of its dashboard page (copy it after the first deploy; adjust if you renamed the service) |
| `FRONTEND_URL` | `https://magician-clipper-web.onrender.com` | The static site's URL (copy it after its first deploy). **Required** — the API reads it for CORS; without it the hosted frontend cannot call the API at all. |
| `MUSE_JOB_API_KEY` | *(the same key the Muse worker uses)* | **Required for the bridge** — without it the worker gets 401 and no hosted job reaches Muse in chat. Copy the value from the dev machine's `backend/laravel/.env`, or generate a fresh 32-byte hex key and give the same value to the worker (see §5). |
| `ADMIN_EMAIL` | e.g. `admin@clipper.local` | **Required for the admin account** — the pre-deploy seeder creates the initial admin user from this + `ADMIN_PASSWORD`. Without it the site has no admin (registering only makes plain users). |
| `ADMIN_PASSWORD` | *(any strong password)* | Same as above. Keep it somewhere safe — it is the live admin login. |
| `VIDEO_ENGINE_URL` | *(leave empty for now)* | No engine on Render; see §5. Set it only if the worker ever gets a public URL. |

Everything else (`APP_ENV=production`, `APP_DEBUG=false`,
`DB_CONNECTION=pgsql`, `DB_URL` from the database,
`QUEUE_CONNECTION=database`, `FILESYSTEM_DISK=local`, …) is already
set by the Blueprint.

**`magician-clipper-web` (Static Site) — do this AFTER the API's first
deploy, once its URL is known:**

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://magician-clipper-api.onrender.com/api/v1` |
| `VITE_APP_URL` | `https://magician-clipper-api.onrender.com` |
| `VITE_ENGINE_URL` | *(leave empty for now — see §5)* |

**Why the two-step dance:** Vite bakes `VITE_*` values into the
JavaScript *at build time*. The API's `.onrender.com` URL does not
exist until the API service is created, so the first static-site
build cannot know it. After filling in the three values, trigger a
rebuild: Static Site → **Manual Deploy** → **Deploy latest commit**.
That rebuild is what puts the real API URL into the served JS. If
you skip it, the frontend keeps calling the local fallback
`http://127.0.0.1:8000/api/v1` and login fails in the browser.

### Step 3 — Wait for green, then verify each service

**API service** — the service page shows "Live" and the deploy log
ends with the `preDeployCommand` running migrations, then the seeder:
`php artisan migrate --force && php artisan db:seed --force` (11
migrations: personal_access_tokens, users, projects, media_assets,
processing_jobs, clips, exports, processing-jobs job-settings, user
settings, caption_style, thumbnail_path + Sanctum
`personal_access_tokens`). The seeder prints either "admin user
created" or "ADMIN_EMAIL / ADMIN_PASSWORD not set — nothing seeded"
— if you see the second line, set the two vars and Manual Deploy
again. Verify from your machine:

```bash
# Health endpoint (Render's own health check hits this too):
curl -s https://magician-clipper-api.onrender.com/up
# → {"status":"ok"} (HTTP 200)

# API root:
curl -s https://magician-clipper-api.onrender.com/
# → {"app":"Magician Clipper","api":"/api/v1","status":"ok"}

# Register a real user (first account; make it admin later via the DB
# or a seeder — there is no admin self-registration):
curl -s -X POST https://magician-clipper-api.onrender.com/api/v1/auth/register \
  -H "Accept: application/json" -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","password":"password123","password_confirmation":"password123"}'
# → {"user":{...},"token":"..."}  (HTTP 201)
```

**Static site** — open `https://magician-clipper-web.onrender.com`.
It must load the login page. Log in with the account above; the
Dashboard must show **Backend: Up** and **Video engine: Down**
(the engine is honestly down — see §5). Open **AI Clipper**, pick
any video file: the probe must fail with the clear "Video engine is
not reachable" error, not a spinner that never ends and not fake
metadata.

**Database** — Dashboard → `magician-clipper-db` shows "Available".
Verify the tables exist (psql via Render's "Connect" → External
Connection string, or the dashboard's query view):
```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
-- users, projects, media_assets, processing_jobs, clips, exports,
-- personal_access_tokens, migrations, jobs, ...
```

### Step 4 — Point your domain at it (optional, later)

Render dashboard → Static Site → **Settings → Custom Domains**,
and Web Service → **Settings → Custom Domain**. Free plan supports
custom domains with automatic HTTPS. After adding one, update
`APP_URL` (API) and `VITE_API_URL` / `VITE_APP_URL` (static site,
then Manual Deploy to rebuild) to the custom domain.

---

## 4. Build / start commands (what Render actually runs)

| Service | Build | Start | Pre-deploy |
|---|---|---|---|
| `magician-clipper-api` | Docker build: `backend/laravel/Dockerfile` (PHP 8.3 + Apache; `composer install --no-dev --optimize-autoloader`) | Apache on `$PORT` (Render injects `PORT`, default 10000; the image rebinds Apache from 80 — see Dockerfile `CMD`) | `php artisan migrate --force && php artisan db:seed --force` |
| `magician-clipper-web` | `npm ci && npm run build` (in `apps/web`) | Static file serving from `apps/web/dist` (+ SPA rewrite `/* → /index.html`) | — |
| `magician-clipper-db` | — (managed Postgres) | — | — |

Local equivalents (for comparison, not for Render): API —
`cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000`;
frontend — `cd apps/web && npm run dev`; engine —
`cd services/video-engine && uvicorn app.main:app --host 127.0.0.1 --port 8001`.

---

## 5. The video engine is NOT on Render — by design

Heavy video processing (FFmpeg + faster-whisper + OpenCV) runs via
the **Muse worker**: a separate Python worker on the dev VM that
picks up jobs through the secure Job API, renders clips per the job
settings, and uploads MP4s back to the same Job ID. It is not a
Render service and this Blueprint deliberately does not try to make
it one, because the Free instance cannot do that job:

- 512 MB RAM: faster-whisper (even `tiny`) + FFmpeg on a real video
  does not fit alongside Laravel + the OS.
- No background workers on the Free plan: there is no place to run a
  queue worker or a long-lived engine process.
- 15-minute idle sleep: a render that takes longer than the sleep
  window would be killed mid-job.
- Ephemeral disk: an in-progress render's temp files vanish on
  redeploy.

**How the remote worker gets the source video.** Link jobs need
nothing from the backend: the worker downloads the link itself with
yt-dlp. Uploaded videos are different — the file lives on the
backend's disk, not the worker's. The worker first tries the local
path (dev setup, same machine); when that file is not there it
downloads it over the Job API: `GET /api/v1/muse/jobs/{job}/source`
(same `X-Muse-Api-Key` auth; link jobs get a 404). Verified
2026-11-22: with an empty local storage root the worker downloaded
job 11's 16.3 MB source byte-identical (md5 match) and probed it
fine. Finished clips travel the other way over the same API
(`POST /api/v1/muse/jobs/{job}/clips`) and appear on the job's page
with Download buttons — that is also how the user (and customers)
get them back.

**Switching the bridge on after deploy (checklist — do this in this
chat once the site is live; nothing here runs automatically before
then):**

1. On Render, set `MUSE_JOB_API_KEY` on the API service (§3 step 2) —
   it must be the SAME value the worker uses (copy it from the dev
   machine's `backend/laravel/.env`, or generate a fresh key and give
   the same value to both sides).
2. Tell Muse the live API URL (e.g.
   `https://magician-clipper-api.onrender.com`). The worker then runs
   with `LARAVEL_URL=<that URL>/api/v1` and `MUSE_JOB_API_KEY=<the
   key>` and a scheduled check polls `GET /api/v1/muse/jobs?status=queued`
   for new jobs. Each new job is reported in this chat (job number +
   settings + notes), the worker renders it, and the finished clips
   are uploaded back to the same Job ID and reported here too.
3. Smoke-test the bridge with one real hosted job (upload or link):
   submit on the live site → it must appear in this chat → clips
   must appear on the job page with Download buttons. Until that test
   passes, the deployment is not "done".

**Notes reach the worker with the job.** The "Notes for Muse" field
on the New Job form (free-text brief — campaign details, must-haves
vs nice-to-haves) is stored in the job settings, returned by the Job
API, and logged by the worker at the start of each job. Must-haves
in the notes are always followed; nice-to-haves are followed when
they make the clips better. The worker's render pipeline itself does
not parse the notes — Muse reads the full text from the job detail
when the job arrives in chat.

**What the app does when the engine is unreachable** (verified by
reading the code, not by a live hosted test — no deployment exists
yet):

- **Dashboard** (`apps/web/src/pages/Dashboard.tsx`): calls
  `engineHealth()` (5 s timeout) and shows `Video engine — Down`
  with the real error (`Video engine is not reachable`), red badge.
  No fake "Running" state.
- **Admin → System health** (`AdminController::health`): probes
  `{VIDEO_ENGINE_URL}/health` live with a 3 s timeout and reports
  `video_engine: { ok: false, error: <real message> }`. A down
  engine is never reported healthy.
- **AI Clipper Step 1** (`Clipper.tsx`): the probe `fetch` throws,
  the page shows a red "Probe failed" alert with the real error
  message and a **Retry probe** button. The file preview itself still
  works (browser object URL) and the Style form stays usable; Steps
  3–5 stay disabled as honest Phase 3 placeholders. Nothing crashes
  and no fake probe metadata is shown.
- **Backend**: `config/app.php` reads the engine URL from env —
  `env('VIDEO_ENGINE_URL', 'http://127.0.0.1:8001')` — so an unset
  variable falls back to the local default and every engine call
  fails fast with its real error instead of hanging.

If the worker ever gets a stable public URL, set `VIDEO_ENGINE_URL`
on the API service and `VITE_ENGINE_URL` on the static site (then
Manual Deploy the static site to rebuild), and the same pages will
start showing the engine as Up with no code change.

---

## 6. Render Free limits — and what they mean for this app

From Render's Free-plan terms (check render.com/pricing at deploy
time — limits change):

| Limit | What it means here |
|---|---|
| **Sleeps after 15 minutes idle** | The API spins down; the first request after idle takes ~30–60 s to wake it. Users see a slow first login/load, then normal speed. The frontend's 5–10 s API timeouts may fire on a cold start (login shows "Backend is not reachable" until the instance is warm — retry once). Keep-alive pings are against Render's spirit on Free; don't add them. |
| **512 MB RAM** | Fine for the Laravel API + Apache. Not enough for the video engine, Whisper, or large in-memory file handling — another reason the engine stays off Render. Uploads are capped by `CLIPPER_MAX_UPLOAD_MB` (4096 MB default in `backend/laravel/.env.example`) — a 4 GB upload would OOM the instance; lower it for the hosted deployment if you enable uploads in Phase 3. |
| **750 instance hours / month** (shared across Free web services) | One always-on Free web service ≈ 744 h/month — just inside the allowance. The API is the only web service in this Blueprint; the static site and the database do not consume instance hours. **Do not add a second Free web service** (e.g. a queue worker) or you will exceed 750 h and the services stop until next month. |
| **Ephemeral filesystem** | Everything written under `storage/` (uploads, clips, exports, SQLite file, logs, file sessions, file cache) disappears on every deploy and restart. That is why the Blueprint uses Postgres for data, not the SQLite default. File sessions also reset on redeploy (users stay logged in — Sanctum uses bearer tokens, not sessions — but any file-session state is lost). |
| **Free PostgreSQL expires after 30 days** | Render deletes free databases 30 days after creation (the live one, created 2026-11-22, expires 2026-12-22). Before day 30: upgrade to paid, or `pg_dump` the data and recreate the database (Render will give it a new connection string — update `DB_URL` in the API service). Set a calendar reminder at deploy time. 1 GB storage is plenty for users/projects/jobs metadata (no media is stored in the DB). |
| **No background workers / cron on Free** | `QUEUE_CONNECTION=database` is set, but no `queue:work` process runs, so any job dispatched to the database queue will sit in `pending` forever. Phase 3's pipeline must either run synchronously, be driven by the external Muse worker, or wait for a paid worker. Do not expect "Process" to work on Render Free. |
| **100 GB/month outbound bandwidth** | Plenty for an API + static site. Video files are NOT served from Render (no engine, ephemeral disk), so the big files never count against this. |
| **7-day log retention, no persistent disk, no SSH** | Debugging is via the Render dashboard logs only. `php artisan` commands cannot be run interactively on the instance — use `preDeployCommand` or a one-off Job (paid) for migrations/maintenance. |

---

## 7. Storage: local disk now, R2 / B2 for anything durable

**Today (this Blueprint):** `FILESYSTEM_DISK=local`. Laravel's
`config/filesystems.php` already defines local disks (`local`,
`public`, `uploads`, `clips`, `exports`) rooted under
`storage/app/`. They work, and they are ephemeral on Render — treat
anything stored there as temporary. The root `.env.example` storage
paths (`STORAGE_UPLOADS_PATH` etc.) describe the local-dev layout,
not the hosted one.

**Durable option (documented, not yet wired up):** the same
`config/filesystems.php` already has an `s3` disk driven entirely by
env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_DEFAULT_REGION`, `AWS_BUCKET`, `AWS_URL`, `AWS_ENDPOINT`,
`AWS_USE_PATH_STYLE_ENDPOINT`). Both Cloudflare R2 and Backblaze B2
speak S3-compatible APIs, so either can back that disk:

- **Cloudflare R2 (free tier):** 10 GB storage, 1 M Class A / 10 M
  Class B operations per month, **zero egress fees**. Create a bucket
  at dash.cloudflare.com → R2, create an API token with Object Read &
  Write, set `AWS_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`,
  `AWS_DEFAULT_REGION=auto`, `AWS_BUCKET=<bucket>`,
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the token.
- **Backblaze B2 (free tier):** 10 GB storage, 1 GB/day free egress,
  2,500 Class B / 2,500 Class C transactions per day free. Create a
  bucket at backblaze.com/b2, create an application key, set
  `AWS_ENDPOINT=https://s3.<region>.backblazeb2.com`,
  `AWS_DEFAULT_REGION=<region>`, `AWS_BUCKET=<bucket>`, key ID /
  key as the AWS credentials.

Then set `FILESYSTEM_DISK=s3` on the API service. **Honest caveat:**
switching `FILESYSTEM_DISK` changes only Laravel's *default* disk.
The clipper-specific named disks (`uploads`, `clips`, `exports`) are
still `local` in config, and no backend code uses `Storage::` at all
yet (upload/analyze are Phase 3 stubs that return 501). So R2/B2
today covers "the default disk", not "all clipper media" — wiring
the clipper disks to S3 is a Phase 3 code change (set their
`driver` to `s3` / point them at the `s3` disk), not a config-only
switch. Do not claim hosted uploads are durable until that is done
and tested.

---

## 8. Known blockers and findings (do not deploy past these blindly)

### F1 — FIXED (2026-11-22, Phase 3): CORS config exists; FRONTEND_URL must be set

`backend/laravel/config/cors.php` **now exists** (added in Phase 3 — the
"no `cors.php`" finding above is stale). It reads allowed origins from
`FRONTEND_URL` (comma-separated list supported) and `HandleCors` is in
Laravel's global middleware, so preflight `OPTIONS` to `/api/*` works.
**Remaining step, still manual:** set `FRONTEND_URL` on the API service
to the static site's URL after the first deploy — it is declared in
`render.yaml` (`sync: false`) and listed in §3 step 2. Without it the
hosted frontend's login/register and every API call are blocked by the
browser. Verify in a real browser (login must succeed) before calling
the deployment done.

### F2 — `.htaccess` was missing (fixed in this task)

`backend/laravel/public/` contained only `index.php`. Without the
stock Laravel rewrite rules, Apache serves `/api/v1/...` as 404s.
Added `backend/laravel/public/.htaccess` (standard Laravel 12
content, no app logic). The Dockerfile enables `mod_rewrite`.

### F3 — FIXED (2026-11-22): engine-unreachable message is environment-aware

`Clipper.tsx` used to show the local `uvicorn` start command inside
the probe-failure alert. Now it checks `window.location.hostname`:
on local dev it still shows the command; on the hosted site it tells
the visitor the site processes videos through the connected worker
and to submit a New Job instead. (The engine URL alone could not
decide this — on the hosted site `VITE_ENGINE_URL` is unset, so it
falls back to `127.0.0.1:8001` even though no engine can run there.)

### F4 — `APP_KEY` and Vite URLs are manual steps, not automatic

See §3 step 2. `APP_KEY` has no safe auto-generation in a Blueprint
(`generateValue` would not guarantee Laravel's `base64:` 32-byte
format), and `VITE_*` values are baked in at build time, so both
need the two-step dashboard flow. This is normal for Render, but it
means "Apply Blueprint" alone does not produce a working site.

### F5 — Env-template drift (minor)

Root `.env.example` says `QUEUE_CONNECTION=database`;
`backend/laravel/.env.example` says `QUEUE_CONNECTION=file` and
`APP_DEBUG=true`, and hard-codes an absolute `DB_DATABASE` path for
this VM. On Render the Blueprint's env vars win, so this does not
break the deploy — but the two templates disagree, and the backend
one should not be copied verbatim for production. The doc's tables
above are the authority for Render, not either `.env.example`.

### F6 — Free Postgres 30-day expiry

See §6. The Blueprint creates the database, but nobody will remind
you on day 89. Set the reminder when you deploy.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blueprint Apply fails on `render.yaml` | Syntax / unknown field | Validate locally first: `python3 -c "import yaml; yaml.safe_load(open('render.yaml'))"`. Field names are Render's (`type`, `runtime`, `plan`, `dockerfilePath`, `dockerContext`, `healthCheckPath`, `preDeployCommand`, `envVars`, `fromDatabase`, `sync`). |
| API deploy fails at Docker build | Missing file in context | The build context is `backend/laravel` — `Dockerfile`, `composer.json`, `composer.lock`, `public/.htaccess` must all exist under it (they do). Check the build log's failing step. |
| API shows "Live" but `/up` returns 502 | Apache not listening on `$PORT` | The Dockerfile rebinds Apache to `${PORT:-80}` in `CMD`. Check the runtime logs for `AH00072: make_sock: could not bind`. |
| `/api/v1/...` returns 404, `/` works | Rewrites not active | `public/.htaccess` + `mod_rewrite` (both in the image). Confirm `.htaccess` was committed — `git ls-files backend/laravel/public/`. |
| `500` on first API request | `APP_KEY` missing/invalid | Set `APP_KEY` in the dashboard (must start `base64:` and decode to 32 bytes), then Manual Deploy. |
| Migrations fail in `preDeployCommand` | DB not ready / wrong `DB_URL` | Check the deploy log; confirm `magician-clipper-db` is "Available" and `DB_URL` is set from it. First deploy can race the DB — re-run Manual Deploy once. |
| Frontend loads but login fails | F1 (no CORS config) or wrong `VITE_API_URL` | Browser devtools → Network: no `Access-Control-Allow-Origin` on the API response = F1. `ERR_NAME_NOT_RESOLVED` / calls to `127.0.0.1` = stale build — check `VITE_API_URL` in the dashboard and Manual Deploy the static site. |
| Frontend shows old API URL after fixing env vars | Vite baked the old value in | `VITE_*` are build-time: changing them in the dashboard does nothing until you **Manual Deploy** the static site. |
| Login "Backend is not reachable" on first try | Free instance asleep (15-min idle) | Wait ~30–60 s and retry once. Not an error. |
| Dashboard shows engine Down | Expected — see §5 | Not an error on this deployment. |

---

## 10. After the deploy works

1. The admin user is created automatically on the first deploy by
   the pre-deploy seeder, from the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   env vars (§3 step 2). Log in with those credentials and confirm
   the Admin panel loads (a normal registered user gets 403 there).
2. Confirm in a real browser: register → login → Dashboard
   (Backend Up / Engine Down) → AI Clipper probe failure message →
   Admin panel loads for the admin, 403 for a normal user.
3. Set the day-89 reminder for the free database (§6).
4. When Phase 3 lands, revisit: CORS (F1), queue worker, upload
   size cap, and wiring the clipper storage disks to R2/B2 (§7).

---

*No live deployment exists as of writing. This doc was written from
reading the repo (Phase 1 + 2 code, verified on the dev VM
2026-11-22) and Render's documented Free-plan behaviour; the steps
have not been executed against a real Render account.*
