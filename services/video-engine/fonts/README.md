# Shipped fonts (Batch 9)

One distinct typeface per caption style (25) + headline style (3),
so the burned-in render and the browser preview use the SAME font
file. All faces are OFL-licensed open fonts: Noto / DejaVu (from
this machine's system fonts), Comic Neue (Debian package
`fonts-comic-neue`), Caveat (instanced as a static Bold from the
official OFL variable font at github.com/google/fonts).

Each file is subset to Latin + Latin-1 + common punctuation
(pyftsubset) — ~692K total for 29 files. Non-Latin captions
(Urdu/Hindi translations) were never covered by these faces anyway;
libass falls back per-glyph exactly as it did with DejaVu Sans Bold.

The worker installs these into fontconfig at job start (see
`_ensure_repo_fonts` in `../workers/muse_worker.py`) and measures
with the same files (PIL). The frontend serves the same files as
webfonts from `apps/web/public/fonts/` (see the `@font-face` block
in `apps/web/src/index.css` and the font maps in
`apps/web/src/lib/captionStyles.ts`).

Regenerate (after a VM replacement, or to add a style font):

    bash scripts/sync-fonts.sh

The font map (style → font) is documented in code:
`muse_worker.py` (`FONT_MAP` / `HEADLINE_FONT_MAP`) and
`captionStyles.ts` (`CAPTION_STYLE_FONTS` / `HEADLINE_STYLE_FONTS`).
Keep the two maps in sync — family names must match exactly, or the
preview lies about the burn.
