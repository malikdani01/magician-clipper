#!/usr/bin/env bash
# Magician Clipper — font sync (Batch 9).
#
# Ships one distinct typeface per caption style (25) + headline style
# (3) so the burned-in render and the browser preview use the SAME
# font file. All faces are OFL-licensed open fonts already on this
# machine (Noto / DejaVu families) plus Comic Neue (Debian package
# fonts-comic-neue) and Caveat (instanced as a static Bold from the
# official OFL variable font at github.com/google/fonts).
#
# Why ship copies in the repo instead of relying on /usr/share/fonts:
# VM replacements wipe apt packages and /usr/share/fonts, but the repo
# survives — the worker auto-installs these files into fontconfig at
# job start (see _ensure_repo_fonts in muse_worker.py), so a fresh VM
# still renders every style. The same files are served as webfonts
# from apps/web/public/fonts/ for the preview.
#
# Subsetting: each file is reduced to Latin + Latin-1 + common
# punctuation with pyftsubset (fontTools). Non-Latin captions
# (Urdu/Hindi translations) were never covered by these faces anyway
# — libass falls back per-glyph exactly as it did with DejaVu Sans
# Bold, so subsetting changes nothing for those scripts and keeps the
# webfont payload small (~1 MB total instead of ~8 MB).
#
# Regenerate after a VM replacement (or to pick up a new style font):
#   bash scripts/sync-fonts.sh
# Requires: system Noto/DejaVu fonts, fonts-comic-neue installed
# (sudo apt-get install -y fonts-comic-neue), python3 + fontTools,
# and network access to github.com for the Caveat variable font.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_FONTS="$REPO/services/video-engine/fonts"
WEB_FONTS="$REPO/apps/web/public/fonts"
SRC_DIR="$(mktemp -d)"
trap 'rm -rf "$SRC_DIR"' EXIT

NOTO=/usr/share/fonts/truetype/noto
DEJAVU=/usr/share/fonts/truetype/dejavu
COMIC=/usr/share/fonts/opentype/comic-neue

# file → source path (all must exist except Caveat, fetched below)
declare -A SOURCES=(
  [NotoSans-Black.ttf]="$NOTO/NotoSans-Black.ttf"
  [NotoSans-ExtraBold.ttf]="$NOTO/NotoSans-ExtraBold.ttf"
  [NotoSerif-Black.ttf]="$NOTO/NotoSerif-Black.ttf"
  [NotoSans-Regular.ttf]="$NOTO/NotoSans-Regular.ttf"
  [NotoSerif-Regular.ttf]="$NOTO/NotoSerif-Regular.ttf"
  [NotoSans-Bold.ttf]="$NOTO/NotoSans-Bold.ttf"
  [NotoSansDisplay-Bold.ttf]="$NOTO/NotoSansDisplay-Bold.ttf"
  [NotoSansMono-Bold.ttf]="$NOTO/NotoSansMono-Bold.ttf"
  [NotoSans-SemiBold.ttf]="$NOTO/NotoSans-SemiBold.ttf"
  [NotoSans-CondensedBold.ttf]="$NOTO/NotoSans-CondensedBold.ttf"
  [NotoSans-ExtraCondensedBlack.ttf]="$NOTO/NotoSans-ExtraCondensedBlack.ttf"
  [NotoSansDisplay-Black.ttf]="$NOTO/NotoSansDisplay-Black.ttf"
  [NotoSansDisplay-ExtraBold.ttf]="$NOTO/NotoSansDisplay-ExtraBold.ttf"
  [NotoSans-Medium.ttf]="$NOTO/NotoSans-Medium.ttf"
  [NotoSans-Light.ttf]="$NOTO/NotoSans-Light.ttf"
  [NotoSansDisplay-SemiBold.ttf]="$NOTO/NotoSansDisplay-SemiBold.ttf"
  [NotoSansDisplay-Light.ttf]="$NOTO/NotoSansDisplay-Light.ttf"
  [NotoSans-CondensedBlack.ttf]="$NOTO/NotoSans-CondensedBlack.ttf"
  [NotoSansDisplay-CondensedBold.ttf]="$NOTO/NotoSansDisplay-CondensedBold.ttf"
  [DejaVuSansMono-Bold.ttf]="$DEJAVU/DejaVuSansMono-Bold.ttf"
  [NotoSans-ExtraCondensedBold.ttf]="$NOTO/NotoSans-ExtraCondensedBold.ttf"
  [DejaVuSans-Bold.ttf]="$DEJAVU/DejaVuSans-Bold.ttf"
  [DejaVuSerif-Bold.ttf]="$DEJAVU/DejaVuSerif-Bold.ttf"
  [NotoSerif-Bold.ttf]="$NOTO/NotoSerif-Bold.ttf"
  [NotoSansDisplay-CondensedBlack.ttf]="$NOTO/NotoSansDisplay-CondensedBlack.ttf"
  [NotoSerifDisplay-Black.ttf]="$NOTO/NotoSerifDisplay-Black.ttf"
  [NotoSerifDisplay-Bold.ttf]="$NOTO/NotoSerifDisplay-Bold.ttf"
  [ComicNeue-BoldItalic.otf]="$COMIC/ComicNeue-BoldItalic.otf"
)

# Caveat: no Debian package — instance a static Bold (wght 700) from
# the official OFL variable font, then subset like the rest.
echo "Fetching Caveat variable font (google/fonts, OFL)..."
curl -sL -o "$SRC_DIR/Caveat-VF.ttf" \
  "https://github.com/google/fonts/raw/main/ofl/caveat/Caveat%5Bwght%5D.ttf"
python3 - "$SRC_DIR" <<'EOF'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
d = sys.argv[1]
f = TTFont(f"{d}/Caveat-VF.ttf")
instantiateVariableFont(f, {"wght": 700}, inplace=True)
f.save(f"{d}/Caveat-Bold.ttf")
print("Caveat-Bold.ttf instanced (wght 700)")
EOF
SOURCES[Caveat-Bold.ttf]="$SRC_DIR/Caveat-Bold.ttf"

UNICODES="U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+20AC,U+2122"
mkdir -p "$WORKER_FONTS" "$WEB_FONTS"

for file in "${!SOURCES[@]}"; do
  src="${SOURCES[$file]}"
  if [ ! -f "$src" ]; then
    echo "MISSING: $src (needed for $file)" >&2
    exit 1
  fi
  python3 -m fontTools.subset "$src" \
    --output-file="$WORKER_FONTS/$file" \
    --unicodes="$UNICODES" \
    --layout-features='kern,liga' \
    --no-hinting --desubroutinize --name-IDs='*'
  cp "$WORKER_FONTS/$file" "$WEB_FONTS/$file"
  echo "ok $file ($(du -h "$WORKER_FONTS/$file" | cut -f1))"
done

echo "---"
echo "worker fonts: $WORKER_FONTS ($(du -sh "$WORKER_FONTS" | cut -f1))"
echo "web fonts:    $WEB_FONTS ($(du -sh "$WEB_FONTS" | cut -f1))"
echo "count: $(ls "$WORKER_FONTS" | grep -c -E '\.(ttf|otf)$') files"
