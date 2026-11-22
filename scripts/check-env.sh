#!/usr/bin/env bash
# Magician Clipper — environment check (Phase 1)
# Checks Node, Python, FFmpeg/FFprobe, PHP and Composer versions and prints
# a table. Missing tools are reported as MISSING, not fatal — the script
# always exits 0 so it can be used as a diagnostic.
#
# Usage:
#   bash scripts/check-env.sh

echo "Magician Clipper — environment check"
echo "======================================"
printf "%-12s %-28s %s\n" "Tool" "Version" "Status"
echo "--------------------------------------"

check_tool() {
  local label="$1" cmd="$2" min_note="$3"
  local ver
  if command -v "$cmd" >/dev/null 2>&1; then
    # ffmpeg/ffprobe use single-dash -version and print to stderr;
    # most other tools use --version on stdout. Try both.
    ver="$("$cmd" --version 2>&1 | head -n 1)"
    if [ -z "$ver" ] || [[ "$ver" == *"Unrecognized option"* ]]; then
      ver="$("$cmd" -version 2>&1 | head -n 1)"
    fi
    printf "%-12s %-28s %s\n" "$label" "${ver:-unknown}" "OK ($min_note)"
  else
    printf "%-12s %-28s %s\n" "$label" "-" "MISSING ($min_note)"
  fi
}

check_tool "Node"       "node"    "need 22+"
check_tool "npm"        "npm"     "bundled with Node"
check_tool "Python"     "python3" "need 3.12"
check_tool "pip"        "pip3"    "need pip"
check_tool "FFmpeg"     "ffmpeg"  "need 6+"
check_tool "FFprobe"    "ffprobe" "need 6+"
check_tool "PHP"        "php"     "need 8.2+ (Laravel)"
check_tool "Composer"   "composer" "need 2.x (Laravel)"
check_tool "Git"        "git"     "need git"
check_tool "curl"       "curl"    "health checks"

echo "======================================"
echo "GPU: not probed here — target is CPU-only (spec §4)."
echo "If PHP/Composer are MISSING, the Laravel backend cannot start;"
echo "see docs/installation-windows.md for install steps."
