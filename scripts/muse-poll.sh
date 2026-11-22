#!/usr/bin/env bash
# muse-poll.sh — run the Muse-connected Job System worker for Magician Clipper.
#
# The worker polls the local Laravel Job API for Queued jobs, renders their
# clips, and uploads the MP4s back to the same Job ID. In this environment
# Muse runs on the same VM and calls the local API (http://127.0.0.1:8000).
#
# Usage:
#   bash scripts/muse-poll.sh              # poll mode, every 5 minutes (default)
#   bash scripts/muse-poll.sh --once       # process one queued job, then exit
#   MUSE_POLL_INTERVAL=120 bash scripts/muse-poll.sh   # poll every 2 minutes
#
# Cron example (every 5 minutes, single-run mode — safe if a previous run
# is still working, because the worker claims one job at a time):
#   */5 * * * * cd /home/hatch/workspace/magician-clipper && bash scripts/muse-poll.sh --once >> services/video-engine/storage/logs/muse-worker.log 2>&1
#
# Loop mode (this script, no cron) is preferred on this VM: it keeps one
# long-lived poller instead of spawning a process every 5 minutes.
#
# The API key is read from backend/laravel/.env (MUSE_JOB_API_KEY) at
# runtime by the worker and is NEVER printed here or in any log.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/services/video-engine"
VENV_PY="$ENGINE_DIR/.venv/bin/python"
LOG_DIR="$ENGINE_DIR/storage/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/muse-worker.log"

if [ ! -x "$VENV_PY" ]; then
  echo "Worker venv python not found at $VENV_PY — run the video-engine setup first." >&2
  exit 1
fi

# The Laravel backend must be running locally for the worker to do anything.
if ! curl -fsS -m 5 http://127.0.0.1:8000/up >/dev/null 2>&1; then
  echo "WARNING: Laravel backend not reachable at http://127.0.0.1:8000/up — is 'php artisan serve' running?" | tee -a "$LOG_FILE" >&2
fi

if [ "${1:-}" = "--once" ]; then
  exec "$VENV_PY" "$ENGINE_DIR/workers/muse_worker.py" --once >>"$LOG_FILE" 2>&1
fi

INTERVAL="${MUSE_POLL_INTERVAL:-300}"
echo "Starting Muse job worker in poll mode (interval ${INTERVAL}s, log: $LOG_FILE)"
exec "$VENV_PY" "$ENGINE_DIR/workers/muse_worker.py" --poll --interval "$INTERVAL" >>"$LOG_FILE" 2>&1
