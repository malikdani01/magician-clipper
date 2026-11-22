/**
 * Design tokens for Magician Clipper (navy / purple theme).
 * Mirrors the CSS variables in index.css so components can also
 * read them from TypeScript when needed.
 */
export const theme = {
  colors: {
    bg: '#070714',
    bgDeep: '#0B0B1E',
    panel: '#12122B',
    panel2: '#1A1A3A',
    border: '#26264A',
    primary: '#7C3AED',
    primaryLight: '#8B5CF6',
    primaryDark: '#5B21B6',
    text: '#F1F1F8',
    textMuted: '#9A9AB8',
    success: '#22C55E',
    warning: '#F59E0B',
    danger: '#EF4444',
  },
  radius: {
    card: '1rem',
    control: '0.625rem',
  },
} as const

export type Theme = typeof theme
