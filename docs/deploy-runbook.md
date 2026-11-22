# Deploy runbook — Magician Clipper on Render (new accounts)

**Status (2026-11-22 ~20:15 PKT): everything is READY to deploy. No live
deployment exists yet.** The repo is committed locally (commit `dde6ff0`,
235 files, branch `main`, no remote yet) and is waiting for the GitHub
account + the Render account. This file is the exact sequence to run
once those accounts arrive. The full background is in
`docs/deployment-render-free.md` — this file is only the checklist.

## 0. What is already done (do not redo)

- `git init` + first commit at the repo root; working tree clean.
  Verified before committing: no real `.env`, no `.sqlite`, no media
  (`.mp4`/`.wav`), no `node_modules`/`vendor`/`dist` in the 235 files
  (46.6 MB total — mostly small verification frames under `demo/`).
- `render.yaml` parses; services `magician-clipper-api` (Docker),
  `magician-clipper-web` (static), database `magician-clipper-db`.
- `preDeployCommand` runs migrations **and** the seeder, so the admin
  account is created on first deploy from `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` (env-gated, idempotent — safe on later deploys).
- `MUSE_JOB_API_KEY` + `FRONTEND_URL` are declared `sync: false` in
  `render.yaml`; `.dockerignore` excludes all media + `.env` + vendor.
- Probe-failure message in `Clipper.tsx` is environment-aware (local
  dev shows the `uvicorn` command; the hosted site tells visitors to
  submit a New Job instead).
- Backend suite 53/53 (242 assertions), frontend `tsc` + build clean
  (verified after the last change, 2026-11-22 ~20:1x PKT).

## 1. Accounts needed

- **GitHub account** — repo `magician-clipper` (public is fine; nothing
  secret is in the repo). The user already has github.com saved; a new
  account works too.
- **Render account** — new account, Free plan, no card needed.

Credentials arrive through the Secure Vault (never in chat). The
browser task signs in with the saved logins.

## 2. Push the repo to GitHub

```bash
cd ~/workspace/magician-clipper
git remote add origin https://github.com/<github-username>/magician-clipper.git
git push -u origin main
```

(If the GitHub account is new, create the empty repo `magician-clipper`
first in the GitHub web UI — no README, no .gitignore, no licence —
then push.)

## 3. Create the Blueprint on Render

Render dashboard → **New +** → **Blueprint** → pick the
`magician-clipper` repo, branch `main` → **Apply**. Three resources are
created: `magician-clipper-api`, `magician-clipper-web`,
`magician-clipper-db`. First build takes several minutes.

## 4. Fill in the env vars (dashboard → service → Environment)

**`magician-clipper-api`:**

| Variable | Value |
|---|---|
| `APP_KEY` | Generate: `python3 -c "import secrets,base64; print('base64:'+base64.b64encode(secrets.token_bytes(32)).decode())"` |
| `APP_URL` | `https://magician-clipper-api.onrender.com` (copy from the service page; adjust if renamed) |
| `FRONTEND_URL` | `https://magician-clipper-web.onrender.com` (copy from the static site page) |
| `MUSE_JOB_API_KEY` | SAME value as the dev machine's `backend/laravel/.env` (copy it there — never print it in chat) |
| `ADMIN_EMAIL` | The live admin login, e.g. `admin@clipper.local` |
| `ADMIN_PASSWORD` | Any strong password — this is the live admin login; keep it safe |

**`magician-clipper-web`** (AFTER the API's first deploy, once its URL exists):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://magician-clipper-api.onrender.com/api/v1` |
| `VITE_APP_URL` | `https://magician-clipper-api.onrender.com` |
| `VITE_ENGINE_URL` | Leave empty |

Then **Manual Deploy** the static site (Vite bakes `VITE_*` in at build
time — changing them does nothing until a rebuild).

## 5. Verify the live site (browser)

1. `https://magician-clipper-api.onrender.com/up` → `{"status":"ok"}`.
2. Open `https://magician-clipper-web.onrender.com` → login page loads.
3. Log in as the admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) → Admin panel
   loads; a normal registered user gets 403 there.
4. Dashboard shows **Backend: Up**, **Video engine: Down** (expected —
   the engine is not on Render; see §6).
5. Register a test user → login works (proves CORS + `FRONTEND_URL`).

## 6. Switch on the Muse bridge (in this chat, after the site is live)

1. Set `MUSE_JOB_API_KEY` on Render = the worker's key (§4 — already
   done there, just confirm it matches).
2. Worker runs with `LARAVEL_URL=<live API>/api/v1` +
   `MUSE_JOB_API_KEY=<same key>`; scheduled check polls
   `GET /api/v1/muse/jobs?status=queued`.
3. Smoke-test with one real hosted job (upload or link): submit on the
   live site → it must appear in this chat → worker renders → clips
   appear on the job page with Download buttons. Until that passes,
   the deployment is not "done".

## 7. Reminders to set at deploy time

- **Day 89: free PostgreSQL expires after 90 days.** Before then,
  upgrade the database or `pg_dump` + recreate it (then update `DB_URL`).
- Uploaded videos / rendered clips on Render are **ephemeral** (lost on
  every redeploy) — download promptly; the chat copies are the backup.

## 8. Honest limits (unchanged)

- The Laravel Docker image has **never been built** (no Docker on this
  VM) — the first Render build is the first real build. If it fails,
  read the build log; the likely spots are `composer install` or a
  missing file in the `backend/laravel` context.
- Render Free sleeps after 15 idle minutes (first request takes
  ~30–60 s to wake); 512 MB RAM; 750 instance-hours/month (one web
  service only — do not add a second).
- The video engine stays off Render by design; the hosted Dashboard
  honestly shows it Down until the bridge (§6) is on.
