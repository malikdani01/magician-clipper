/**
 * Caption styles — the burn-in caption looks the worker renders onto
 * clips (settings.caption_style). The worker defaults to 'punchy' when
 * a job has no caption_style; the frontend defaults the same way.
 *
 * `sample` is the demo phrase shown in the Captions Studio previews.
 * `highlightWord` (punchy only) is the word rendered in yellow — the
 * most emphatic word of the sample. New styles are added here first,
 * then in the worker; the Captions Studio grid renders this list.
 *
 * `anim` drives the animated sample preview in Captions Studio — the
 * preview loops the same motion the worker burns onto the video
 * (pop / karaoke fill / bounce / typewriter / sweep / neon pulse /
 * slam / outline pop / gradient pop / kinetic slide / glow pop /
 * word zoom / word fade / highlight box / bounce pop / glitch pop /
 * tiktok bold pop / reels clean / shorts minimal / comic wobble /
 * marker pop).
 * The preview and the burned-in captions must match: same
 * words-per-screen, same colours, same motion. `wordColors` (gradient
 * only) cycles one colour per word.
 */

export type CaptionStyleId =
  | 'punchy'
  | 'word_pop'
  | 'title_card'
  | 'clean_subs'
  | 'classic'
  | 'karaoke'
  | 'bounce'
  | 'typewriter'
  | 'sweep'
  | 'neon'
  | 'slam'
  | 'outline'
  | 'gradient'
  | 'kinetic'
  | 'glow_pop'
  | 'word_zoom'
  | 'word_fade'
  | 'highlight_sweep'
  | 'bounce_in'
  | 'glitch_pop'
  | 'tiktok_bold'
  | 'reels_clean'
  | 'shorts_minimal'
  | 'comic'
  | 'marker'

export type CaptionPreviewAnim =
  | 'pop'
  | 'title'
  | 'subs'
  | 'karaoke'
  | 'bounce'
  | 'typewriter'
  | 'sweep'
  | 'neon'
  | 'slam'
  | 'outline'
  | 'gradient'
  | 'kinetic'
  | 'glow_pop'
  | 'word_zoom'
  | 'word_fade'
  | 'highlight_sweep'
  | 'bounce_in'
  | 'glitch_pop'
  | 'tiktok_bold'
  | 'reels_clean'
  | 'shorts_minimal'
  | 'comic'
  | 'marker'

export interface CaptionStyle {
  id: CaptionStyleId
  name: string
  description: string
  /** Short "Best for: …" line, written in our own words (Batch 8). */
  bestFor: string
  sample: string
  /** Word of the sample rendered in yellow (punchy only). */
  highlightWord?: string
  /** Animation the sample preview loops (and the worker burns in). */
  anim: CaptionPreviewAnim
  /** One colour per word, cycled (gradient only). */
  wordColors?: string[]
}

/**
 * True when the style's preview moves. Title-card, subtitle and the
 * two still platform styles are static by design (the worker burns
 * them with no motion either); every other style loops its motion.
 * Batch 8: drives the Motion / Static badge on the style picker.
 */
export function isCaptionStyleAnimated(style: CaptionStyle): boolean {
  return (
    style.anim !== 'title' &&
    style.anim !== 'subs' &&
    style.anim !== 'reels_clean' &&
    style.anim !== 'shorts_minimal'
  )
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'punchy',
    name: 'Punchy',
    description:
      '2–4 words per screen, huge bold white, key words yellow, centred on the divider.',
    bestFor: 'Fast hooks and punchy talking-head clips',
    sample: 'THIS IS THE HIGHEST POINT',
    highlightWord: 'HIGHEST',
    anim: 'pop',
  },
  {
    id: 'word_pop',
    name: 'Word Pop',
    description:
      'One word at a time, even bigger, white + black outline, on the divider.',
    bestFor: 'One-word reactions and hype moments',
    sample: 'WOW',
    anim: 'pop',
  },
  {
    id: 'title_card',
    name: 'Title Card',
    description:
      'Hook title in a white box on the divider, then small subtitles at the bottom.',
    bestFor: 'Story openers and titled segments',
    sample: 'SPEED REACTS TO ENDING OF GTA 6',
    anim: 'title',
  },
  {
    id: 'clean_subs',
    name: 'Clean Subtitles',
    description: 'Small white subtitles at the bottom only.',
    bestFor: 'Interviews and calm explainers',
    sample: 'If we can get into the water, we swim for it.',
    anim: 'subs',
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Full-sentence captions at the bottom (the old behaviour).',
    bestFor: 'Podcasts and long-form speech',
    sample: 'When you have a five-minute counter, you can easily win the PS5.',
    anim: 'subs',
  },
  {
    id: 'karaoke',
    name: 'Karaoke Fill',
    description:
      'Full phrase visible — each word fills yellow exactly as it is spoken.',
    bestFor: 'Sing-alongs, quotes and read-along lines',
    sample: 'SING IT LOUD TONIGHT',
    anim: 'karaoke',
  },
  {
    id: 'bounce',
    name: 'Bounce In',
    description:
      'Words drop in from above with a springy bounce, one by one.',
    bestFor: 'Playful edits and lifestyle clips',
    sample: "LET'S GO NOW",
    anim: 'bounce',
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description:
      'Letters type out one by one, like the story is being written live.',
    bestFor: 'Storytelling and slow reveals',
    sample: 'THE TRUTH IS...',
    anim: 'typewriter',
  },
  {
    id: 'sweep',
    name: 'Highlight Sweep',
    description:
      'A yellow highlight sweeps across the words as they are spoken.',
    bestFor: 'Tips, lists and how-to lines',
    sample: 'WATCH THIS NEXT',
    anim: 'sweep',
  },
  {
    id: 'neon',
    name: 'Neon Glow',
    description:
      'Pink and cyan words alternate with a soft glowing halo — like a neon sign, gently pulsing.',
    bestFor: 'Gaming and night-time edits',
    sample: 'NEON NIGHTS',
    anim: 'neon',
  },
  {
    id: 'slam',
    name: 'Word Slam',
    description:
      'Each word slams in huge, then settles — maximum impact on every beat.',
    bestFor: 'Hype edits and motivational lines',
    sample: 'BOOM',
    anim: 'slam',
  },
  {
    id: 'outline',
    name: 'Outline Only',
    description:
      'Hollow white outline letters, no fill — clean, bold, modern.',
    bestFor: 'Fashion, travel and clean modern clips',
    sample: 'HOLLOW',
    anim: 'outline',
  },
  {
    id: 'gradient',
    name: 'Gradient Pop',
    description:
      'Words pop in, each in a bright gradient colour — yellow, orange, pink, cyan.',
    bestFor: 'Colourful, upbeat edits',
    sample: 'COLOR RUSH',
    anim: 'gradient',
    wordColors: ['#FACC15', '#FB923C', '#F472B6', '#22D3EE'],
  },
  {
    id: 'kinetic',
    name: 'Kinetic Slide',
    description:
      'Words slide in from the left with a scale overshoot — fast, modern, kinetic motion.',
    bestFor: 'Fast-paced edits and quick cuts',
    sample: 'SLIDE IN FAST',
    anim: 'kinetic',
  },
  {
    id: 'glow_pop',
    name: 'Glow Pop',
    description:
      'Words pop in with a warm golden glow — bold white with a glowing edge.',
    bestFor: 'Celebrations and feel-good moments',
    sample: 'GLOW UP',
    anim: 'glow_pop',
  },
  // Batch 3 (2026-11-25). "Bounce In" is taken by `bounce`, so the
  // overshoot variant is "Bounce Pop"; `sweep` already owns "Highlight
  // Sweep", so the boxed-word variant is "Highlight Box".
  {
    id: 'word_zoom',
    name: 'Word Zoom',
    description:
      'Each word lands slightly big and settles to full size as it is spoken.',
    bestFor: 'Emphasis on key words in explainers',
    sample: 'ZOOM IN CLOSE',
    anim: 'word_zoom',
  },
  {
    id: 'word_fade',
    name: 'Word Fade',
    description:
      'Each word fades in softly as it is spoken — calm, clean, readable.',
    bestFor: 'Calm narration and soft stories',
    sample: 'SOFT AND CLEAR',
    anim: 'word_fade',
  },
  {
    id: 'highlight_sweep',
    name: 'Highlight Box',
    description:
      'The current word sits in a yellow highlight box that moves word to word.',
    bestFor: 'Teaching moments and key phrases',
    sample: 'WATCH THIS NOW',
    anim: 'highlight_sweep',
  },
  {
    id: 'bounce_in',
    name: 'Bounce Pop',
    description:
      'Each word pops in with a small overshoot bounce — springier than Bounce In.',
    bestFor: 'Fun reactions and energetic clips',
    sample: 'BOUNCE RIGHT IN',
    anim: 'bounce_in',
  },
  {
    id: 'glitch_pop',
    name: 'Glitch Pop',
    description:
      'Each word pops in with a quick magenta-cyan flicker — a subtle glitch feel. (The burn flickers colours; libass cannot do a true RGB channel split.)',
    bestFor: 'Gaming and edgy edits',
    sample: 'GLITCH IT UP',
    anim: 'glitch_pop',
  },
  // Batch 6 (2026-11-25): platform styles — the classic TikTok look,
  // a clean Reels look, and a minimal Shorts look.
  {
    id: 'tiktok_bold',
    name: 'TikTok Bold',
    description:
      'The classic TikTok look — big bold white, key words yellow, the whole phrase pops in.',
    bestFor: 'TikTok hooks and viral-style clips',
    sample: 'THIS IS THE BIGGEST MOMENT',
    highlightWord: 'BIGGEST',
    anim: 'tiktok_bold',
  },
  {
    id: 'reels_clean',
    name: 'Reels Clean',
    description:
      'Slightly smaller clean white text with a soft shadow — no pop, no fill, stays out of the way.',
    bestFor: 'Reels that stay clean and readable',
    sample: 'Clean, calm captions.',
    anim: 'reels_clean',
  },
  {
    id: 'shorts_minimal',
    name: 'Shorts Minimal',
    description:
      'Minimal and restrained — smaller text, thin outline, no shadow, no motion.',
    bestFor: 'Shorts where the video does the talking',
    sample: 'Small, quiet captions.',
    anim: 'shorts_minimal',
  },
  // Batch 9 (2026-11-25): Comic Pop and Marker — two more concepts,
  // our own names, samples, colours and rendering. Same generic
  // concepts as the competitor's Comic/Marker, nothing copied.
  {
    id: 'comic',
    name: 'Comic Pop',
    description:
      'Playful slanted words with a bright pink shadow — each word pops in mint, yellow or cyan with a bouncy wobble.',
    bestFor: 'Funny moments and playful edits',
    sample: 'THAT WAS SO FUNNY',
    anim: 'comic',
  },
  {
    id: 'marker',
    name: 'Marker',
    description:
      'Casual slanted handwritten words with a black outline — each spoken word turns orange and lands with a slight tilt.',
    bestFor: 'Notes, callouts and key points',
    sample: 'REMEMBER THIS ONE',
    anim: 'marker',
  },
]

/** The matching style, or Punchy for unknown / missing ids. */
export function getCaptionStyle(id: string | null | undefined): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]
}

/**
 * Legacy wizard preset ids (bold-pop, highlight, ...) predate the real
 * caption styles above. They must never be sent to the worker as-is —
 * each one maps to the real style it stood for. Used to translate
 * stored defaults (Brand Kit) and wizard presets (Clipper) onto real
 * style ids. (Moved here from Clipper.tsx so every translation uses
 * this one map.)
 */
export const LEGACY_CAPTION_PRESET_TO_STYLE: Record<string, CaptionStyleId> = {
  'bold-pop': 'punchy',
  highlight: 'word_pop',
  bounce: 'bounce',
  karaoke: 'karaoke',
  'neon-glow': 'neon',
  'word-slam': 'slam',
  modern: 'clean_subs',
  podcast: 'classic',
  cinematic: 'title_card',
  minimal: 'clean_subs',
  // Batch 3 (2026-11-25): the five new styles got wizard presets too,
  // so they are pickable in the wizard as well as in New Job.
  'word-zoom': 'word_zoom',
  'word-fade': 'word_fade',
  'highlight-box': 'highlight_sweep',
  'bounce-pop': 'bounce_in',
  'glitch-pop': 'glitch_pop',
  // Batch 6 (2026-11-25): the three platform styles, same treatment.
  'tiktok-bold': 'tiktok_bold',
  'reels-clean': 'reels_clean',
  'shorts-minimal': 'shorts_minimal',
  // Batch 9 (2026-11-25): Comic Pop and Marker, same treatment.
  'comic-pop': 'comic',
  marker: 'marker',
}

/**
 * Resolve any stored caption-style value to a real style id: real ids
 * pass through untouched, legacy preset ids translate via the map
 * above, anything else falls back to Punchy.
 */
export function translateLegacyCaptionPreset(id: string | null | undefined): CaptionStyleId {
  if (typeof id === 'string' && isCaptionStyleId(id)) return id
  if (typeof id === 'string') return LEGACY_CAPTION_PRESET_TO_STYLE[id] ?? 'punchy'
  return 'punchy'
}

/** True when the id is one of the known styles. */
export function isCaptionStyleId(id: unknown): id is CaptionStyleId {
  return typeof id === 'string' && CAPTION_STYLES.some((s) => s.id === id)
}

/**
 * Batch 9 — one distinct typeface per style (the FONT MAP, mirrored
 * from the worker's FONT_MAP in muse_worker.py — family names must
 * match the worker's ASS Fontnames EXACTLY, or the preview lies
 * about the burn). `family` is the @font-face family (see
 * index.css), `weight` its CSS weight, `style` how the preview
 * renders it:
 * - marker is `normal`, not italic: the burn renders Caveat-Bold
 *   upright (no italic Caveat face exists for libass to pick), so
 *   an italic preview would be a lie; the handwriting itself reads
 *   slanted.
 * - comic is `italic`: the burn picks the real Comic Neue
 *   BoldItalic face, so the preview slants the same way.
 * The files ship in the repo (services/video-engine/fonts/ and
 * apps/web/public/fonts/, see scripts/sync-fonts.sh).
 */
export interface StyleFont {
  family: string
  weight: number
  style: 'normal' | 'italic'
  file: string
}

export const CAPTION_STYLE_FONTS: Record<CaptionStyleId, StyleFont> = {
  punchy: { family: 'Noto Sans Black', weight: 900, style: 'normal', file: 'NotoSans-Black.ttf' },
  word_pop: { family: 'Noto Sans ExtraBold', weight: 800, style: 'normal', file: 'NotoSans-ExtraBold.ttf' },
  title_card: { family: 'Noto Serif Black', weight: 900, style: 'normal', file: 'NotoSerif-Black.ttf' },
  clean_subs: { family: 'Noto Sans', weight: 400, style: 'normal', file: 'NotoSans-Regular.ttf' },
  classic: { family: 'Noto Serif Display', weight: 700, style: 'normal', file: 'NotoSerifDisplay-Bold.ttf' },
  karaoke: { family: 'Noto Sans', weight: 700, style: 'normal', file: 'NotoSans-Bold.ttf' },
  bounce: { family: 'Noto Sans Display', weight: 700, style: 'normal', file: 'NotoSansDisplay-Bold.ttf' },
  typewriter: { family: 'Noto Sans Mono', weight: 700, style: 'normal', file: 'NotoSansMono-Bold.ttf' },
  sweep: { family: 'Noto Sans SemiBold', weight: 600, style: 'normal', file: 'NotoSans-SemiBold.ttf' },
  neon: { family: 'Noto Sans Condensed', weight: 700, style: 'normal', file: 'NotoSans-CondensedBold.ttf' },
  slam: { family: 'Noto Sans ExtraCondensed Black', weight: 900, style: 'normal', file: 'NotoSans-ExtraCondensedBlack.ttf' },
  outline: { family: 'Noto Sans Display Black', weight: 900, style: 'normal', file: 'NotoSansDisplay-Black.ttf' },
  gradient: { family: 'Noto Sans Display ExtraBold', weight: 800, style: 'normal', file: 'NotoSansDisplay-ExtraBold.ttf' },
  kinetic: { family: 'Noto Sans Medium', weight: 500, style: 'normal', file: 'NotoSans-Medium.ttf' },
  glow_pop: { family: 'Noto Sans Light', weight: 300, style: 'normal', file: 'NotoSans-Light.ttf' },
  word_zoom: { family: 'Noto Sans Display SemiBold', weight: 600, style: 'normal', file: 'NotoSansDisplay-SemiBold.ttf' },
  word_fade: { family: 'Noto Sans Display Light', weight: 300, style: 'normal', file: 'NotoSansDisplay-Light.ttf' },
  highlight_sweep: { family: 'Noto Sans Condensed Black', weight: 900, style: 'normal', file: 'NotoSans-CondensedBlack.ttf' },
  bounce_in: { family: 'Noto Sans Display Condensed', weight: 700, style: 'normal', file: 'NotoSansDisplay-CondensedBold.ttf' },
  glitch_pop: { family: 'DejaVu Sans Mono', weight: 700, style: 'normal', file: 'DejaVuSansMono-Bold.ttf' },
  tiktok_bold: { family: 'Noto Sans ExtraCondensed', weight: 700, style: 'normal', file: 'NotoSans-ExtraCondensedBold.ttf' },
  reels_clean: { family: 'DejaVu Sans', weight: 700, style: 'normal', file: 'DejaVuSans-Bold.ttf' },
  shorts_minimal: { family: 'DejaVu Serif', weight: 700, style: 'normal', file: 'DejaVuSerif-Bold.ttf' },
  comic: { family: 'Comic Neue', weight: 700, style: 'italic', file: 'ComicNeue-BoldItalic.otf' },
  marker: { family: 'Caveat', weight: 700, style: 'normal', file: 'Caveat-Bold.ttf' },
}

/** The CleanSubs sub-style inside title_card shares clean_subs' font. */
export const TITLE_CARD_SUB_FONT: StyleFont = CAPTION_STYLE_FONTS.clean_subs

/** The typeface for one caption style (Punchy when unknown). */
export function fontForCaptionStyle(id: CaptionStyleId): StyleFont {
  return CAPTION_STYLE_FONTS[id] ?? CAPTION_STYLE_FONTS.punchy
}

export type HeadlineStyleId = 'bold_bar' | 'lower_third' | 'big_centre'

export const HEADLINE_STYLE_FONTS: Record<HeadlineStyleId, StyleFont> = {
  bold_bar: { family: 'Noto Serif', weight: 700, style: 'normal', file: 'NotoSerif-Bold.ttf' },
  lower_third: { family: 'Noto Sans Display Condensed Black', weight: 900, style: 'normal', file: 'NotoSansDisplay-CondensedBlack.ttf' },
  big_centre: { family: 'Noto Serif Display Black', weight: 900, style: 'normal', file: 'NotoSerifDisplay-Black.ttf' },
}

/** The typeface for one headline style (bold_bar when unknown). */
export function fontForHeadlineStyle(id: HeadlineStyleId): StyleFont {
  return HEADLINE_STYLE_FONTS[id] ?? HEADLINE_STYLE_FONTS.bold_bar
}
