/** Caption style presets for Captions Studio.
 *
 * Design previews only: these presets style sample text in the browser.
 * No captions have been generated and no caption engine exists yet
 * (transcription + caption burn-in arrive with the Phase 3 render pipeline).
 */

export interface CaptionPreset {
  id: string
  label: string
  sample: string
  className: string
  fontFamily: string
  fontSizePx: number
  color: string
  highlightColor: string
  animation: 'none' | 'bounce' | 'pop' | 'karaoke' | 'glow'
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'bold-pop',
    label: 'Bold Pop',
    sample: 'Bold Pop',
    className: 'font-black italic text-yellow-300 drop-shadow-[0_2px_0_rgba(0,0,0,0.8)]',
    fontFamily: 'Inter',
    fontSizePx: 56,
    color: '#FDE047',
    highlightColor: '#7C3AED',
    animation: 'pop',
  },
  {
    id: 'highlight',
    label: 'Highlight Box',
    sample: 'Highlight Box',
    className: 'bg-yellow-400 font-bold text-black px-1',
    fontFamily: 'Inter',
    fontSizePx: 48,
    color: '#000000',
    highlightColor: '#FACC15',
    animation: 'none',
  },
  {
    id: 'bounce',
    label: 'Bounce',
    sample: 'Bounce',
    className: 'font-extrabold text-white drop-shadow-[0_3px_0_#7C3AED]',
    fontFamily: 'Inter',
    fontSizePx: 56,
    color: '#FFFFFF',
    highlightColor: '#7C3AED',
    animation: 'bounce',
  },
  {
    id: 'karaoke',
    label: 'Karaoke',
    sample: 'Sing along…',
    className: 'font-bold text-cyan-300',
    fontFamily: 'Inter',
    fontSizePx: 48,
    color: '#67E8F9',
    highlightColor: '#FDE047',
    animation: 'karaoke',
  },
  {
    id: 'neon-glow',
    label: 'Neon Glow',
    sample: 'Neon Glow',
    className: 'font-bold text-fuchsia-400 [text-shadow:0_0_12px_#d946ef]',
    fontFamily: 'Inter',
    fontSizePx: 52,
    color: '#E879F9',
    highlightColor: '#D946EF',
    animation: 'glow',
  },
  {
    id: 'word-slam',
    label: 'Word Slam',
    sample: 'Word Slam',
    className: 'font-black uppercase tracking-tight text-white',
    fontFamily: 'Inter',
    fontSizePx: 56,
    color: '#FFFFFF',
    highlightColor: '#000000',
    animation: 'pop',
  },
  {
    id: 'modern',
    label: 'Modern',
    sample: 'Modern',
    className: 'font-medium text-white',
    fontFamily: 'Inter',
    fontSizePx: 44,
    color: '#FFFFFF',
    highlightColor: '#7C3AED',
    animation: 'none',
  },
  {
    id: 'podcast',
    label: 'Podcast',
    sample: 'Podcast',
    className: 'font-semibold text-emerald-300',
    fontFamily: 'Inter',
    fontSizePx: 44,
    color: '#6EE7B7',
    highlightColor: '#059669',
    animation: 'none',
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    sample: 'Cinematic',
    className: 'font-serif tracking-widest text-amber-200',
    fontFamily: 'Georgia',
    fontSizePx: 36,
    color: '#FCD34D',
    highlightColor: '#78350F',
    animation: 'none',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    sample: 'Minimal',
    className: 'text-sm text-white/90',
    fontFamily: 'Inter',
    fontSizePx: 24,
    color: '#FFFFFF',
    highlightColor: '#9A9AB8',
    animation: 'none',
  },
]
