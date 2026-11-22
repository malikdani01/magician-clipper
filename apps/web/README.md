# Magician Clipper — Web App (Phase 1 Foundation)

React + TypeScript + Vite frontend for Magician Clipper, the AI
long-video-to-short-clips app. Phase 1 is the application shell:
sidebar navigation, routing, honest zero/empty states, and the
AI Clipper import wizard (real in-browser file metadata via the
File API — no backend yet).

## How to run

```bash
npm install
npm run dev        # Vite dev server on http://127.0.0.1:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build on http://127.0.0.1:4173
npm run typecheck  # tsc --noEmit
```

## Environment

Copy `.env.example` to `.env` if you need to point at a backend or engine
running on a different host/port. The defaults point at local services:

- `VITE_API_URL` — Laravel API base (default `http://127.0.0.1:8000/api/v1`)
- `VITE_ENGINE_URL` — video engine base (default `http://127.0.0.1:8001`)
- `VITE_APP_URL` — Laravel app base, used for the `/up` health check
  (default `http://127.0.0.1:8000`)

Start the services for local dev (in separate terminals):

```bash
# Laravel backend (from the repo root)
cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000

# Video engine (from the repo root)
cd services/video-engine && uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Every Laravel request sends `Accept: application/json` (without it,
unauthenticated calls return HTTP 500 instead of 401). Auth tokens are
stored in `localStorage` under `magician-clipper.token`; project metadata
under `magician-clipper.projects.v1`. Video bytes are never stored in
`localStorage` — the source file lives only in memory for the tab session.

## Structure

- `src/layout/` — `AppShell` (user sidebar + top bar), `AdminLayout`
- `src/components/` — shared UI (`EmptyState`, `StatCard`, `PageHeader`,
  `NotImplemented`, `AdminRoute` guard)
- `src/pages/` — one component per user route
- `src/pages/admin/` — one component per admin route (all behind the
  `AdminRoute` guard; auth is not wired in Phase 1)
- `src/state/` — tiny React context (top-bar project search)
- `src/lib/` — formatting helpers
- `src/theme.ts` — design tokens (navy/purple theme)

## Honesty rules (binding for this codebase)

- No fake or mock data. New-account stats are all `0`; lists render
  explicit "No … yet" empty states.
- No charts without real data — empty states instead.
- Every button either works or is visibly marked
  "Not implemented yet (Phase 2/3)" and disabled.
- Admin routes render an honest "Admin sign-in required" notice until
  real authentication is wired (Phase 2). No fake login.
