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
 * slam / outline pop / gradient pop). The preview and the burned-in
 * captions must match: same words-per-screen, same colours, same
 * motion. `wordColors` (gradient only) cycles one colour per word.
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

export interface CaptionStyle {
  id: CaptionStyleId
  name: string
  description: string
  sample: string
  /** Word of the sample rendered in yellow (punchy only). */
  highlightWord?: string
  /** Animation the sample preview loops (and the worker burns in). */
  anim: CaptionPreviewAnim
  /** One colour per word, cycled (gradient only). */
  wordColors?: string[]
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'punchy',
    name: 'Punchy',
    description:
      '2–4 words per screen, huge bold white, key words yellow, centred on the divider.',
    sample: 'THIS IS THE HIGHEST POINT',
    highlightWord: 'HIGHEST',
    anim: 'pop',
  },
  {
    id: 'word_pop',
    name: 'Word Pop',
    description:
      'One word at a time, even bigger, white + black outline, on the divider.',
    sample: 'WOW',
    anim: 'pop',
  },
  {
    id: 'title_card',
    name: 'Title Card',
    description:
      'Hook title in a white box on the divider, then small subtitles at the bottom.',
    sample: 'SPEED REACTS TO ENDING OF GTA 6',
    anim: 'title',
  },
  {
    id: 'clean_subs',
    name: 'Clean Subtitles',
    description: 'Small white subtitles at the bottom only.',
    sample: 'If we can get into the water, we swim for it.',
    anim: 'subs',
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Full-sentence captions at the bottom (the old behaviour).',
    sample: 'When you have a five-minute counter, you can easily win the PS5.',
    anim: 'subs',
  },
  {
    id: 'karaoke',
    name: 'Karaoke Fill',
    description:
      'Full phrase visible — each word fills yellow exactly as it is spoken.',
    sample: 'SING IT LOUD TONIGHT',
    anim: 'karaoke',
  },
  {
    id: 'bounce',
    name: 'Bounce In',
    description:
      'Words drop in from above with a springy bounce, one by one.',
    sample: "LET'S GO NOW",
    anim: 'bounce',
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description:
      'Letters type out one by one, like the story is being written live.',
    sample: 'THE TRUTH IS...',
    anim: 'typewriter',
  },
  {
    id: 'sweep',
    name: 'Highlight Sweep',
    description:
      'A yellow highlight sweeps across the words as they are spoken.',
    sample: 'WATCH THIS NEXT',
    anim: 'sweep',
  },
  {
    id: 'neon',
    name: 'Neon Glow',
    description:
      'Bright cyan glow with a magenta edge — like a neon sign, gently pulsing.',
    sample: 'NEON NIGHTS',
    anim: 'neon',
  },
  {
    id: 'slam',
    name: 'Word Slam',
    description:
      'Each word slams in huge, then settles — maximum impact on every beat.',
    sample: 'BOOM',
    anim: 'slam',
  },
  {
    id: 'outline',
    name: 'Outline Only',
    description:
      'Hollow white outline letters, no fill — clean, bold, modern.',
    sample: 'HOLLOW',
    anim: 'outline',
  },
  {
    id: 'gradient',
    name: 'Gradient Pop',
    description:
      'Words pop in, each in a bright gradient colour — yellow, orange, pink, cyan.',
    sample: 'COLOR RUSH',
    anim: 'gradient',
    wordColors: ['#FACC15', '#FB923C', '#F472B6', '#22D3EE'],
  },
  {
    id: 'kinetic',
    name: 'Kinetic Slide',
    description:
      'Words slide in from the left with a scale overshoot — fast, modern, kinetic motion.',
    sample: 'SLIDE IN FAST',
    anim: 'kinetic',
  },
  {
    id: 'glow_pop',
    name: 'Glow Pop',
    description:
      'Words pop in with a warm golden glow — bold white with a glowing edge.',
    sample: 'GLOW UP',
    anim: 'glow_pop',
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
