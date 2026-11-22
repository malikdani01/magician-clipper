#!/usr/bin/env bash
# Magician Clipper — dev launcher (convenience only, Phase 1)
# Starts the video engine (uvicorn, port 8001) and the frontend (Vite dev
# server, port 5173) in the background, then waits.
#
# The Laravel backend is NOT started here on purpose: PHP/Composer are not
# installed on this dev VM yet (see README.md). Start it separately with:
#   cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000
#
# Usage:
#   bash scripts/dev.sh
#   # Ctrl+C stops both services.
#
# If a service directory does not exist yet (sibling builders still working),
# this script reports that and starts whatever is present.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping dev services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Video engine ------------------------------------------------------------
if [ -f "$ROOT/services/video-engine/app/main.py" ]; then
  echo "[dev] starting video engine on http://127.0.0.1:8001 ..."
  (cd "$ROOT/services/video-engine" && uvicorn app.main:app --host 127.0.0.1 --port 8001) &
  PIDS+=($!)
else
  echo "[dev] SKIP video engine: services/video-engine/app/main.py not found yet."
fi

# --- Frontend ----------------------------------------------------------------
if [ -f "$ROOT/apps/web/package.json" ]; then
  echo "[dev] starting frontend on http://localhost:5173 ..."
  (cd "$ROOT/apps/web" && npm run dev) &
  PIDS+=($!)
else
  echo "[dev] SKIP frontend: apps/web/package.json not found yet."
fi

if [ "${#PIDS[@]}" -eq 0 ]; then
  echo "[dev] Nothing to start yet — services are still being built."
  exit 1
fi

echo "[dev] Running. Press Ctrl+C to stop."
echo "[dev] Health check: bash scripts/health-check.sh"
wait
