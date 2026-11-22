#!/usr/bin/env bash
# Magician Clipper — health check (Phase 1)
# Probes the video engine and the Laravel backend and prints PASS/FAIL per
# service. Exit code 0 only if every *configured* service is reachable.
#
# Usage:
#   bash scripts/health-check.sh
#
# Endpoints probed:
#   Video engine:  http://127.0.0.1:8001/health
#   Backend:       http://127.0.0.1:8000/api/v1/health
#
# NOTE: if a service is not running, that is reported as FAIL (not an error
# in this script) — start the service first; see README.md run commands.

set -u

ENGINE_URL="${VIDEO_ENGINE_URL:-http://127.0.0.1:8001}/health"
BACKEND_URL="${LARAVEL_URL:-http://127.0.0.1:8000}/api/v1/health"

overall=0

check() {
  local name="$1" url="$2"
  local code
  # curl -w already prints 000 when it cannot connect; no fallback needed.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)"
  if [ "$code" = "200" ]; then
    echo "PASS  $name  ($url -> HTTP $code)"
  else
    echo "FAIL  $name  ($url -> HTTP $code)"
    overall=1
  fi
}

echo "Magician Clipper — health check"
echo "--------------------------------"
check "video-engine" "$ENGINE_URL"
check "backend"      "$BACKEND_URL"
echo "--------------------------------"
if [ "$overall" -eq 0 ]; then
  echo "All services healthy."
else
  echo "One or more services are DOWN. Start them first (see README.md)."
fi
exit "$overall"
