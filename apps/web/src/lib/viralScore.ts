/**
 * Viral score — the 0-100 number shown on every clip.
 *
 * It is the worker's clip quality score (0-1) scaled to 0-100. That score
 * is built from real signals of the clip itself: speech density, audio
 * coverage, sentence completeness, silence boundaries, audio energy,
 * gameplay presence and scene stability. It is an ESTIMATE of how strong
 * the clip is as a short — a high score means the clip is dense, complete,
 * has real gameplay on screen and stays in one scene — not a guarantee
 * that it will go viral. The label bands are fixed so the number always
 * means the same thing.
 */

export type ViralTone = 'very-high' | 'high' | 'good' | 'average' | 'low'

export interface ViralScore {
  /** 0-100, or null when the clip has no score yet. */
  value: number | null
  label: string
  tone: ViralTone
}

export function viralScore(score: number | null | undefined): ViralScore {
  if (score == null || Number.isNaN(score)) {
    return { value: null, label: 'Not scored yet', tone: 'low' }
  }
  const value = Math.max(0, Math.min(100, Math.round(score * 100)))
  if (value >= 90) return { value, label: 'Viral potential — Very high', tone: 'very-high' }
  if (value >= 75) return { value, label: 'Viral potential — High', tone: 'high' }
  if (value >= 60) return { value, label: 'Good clip', tone: 'good' }
  if (value >= 45) return { value, label: 'Average', tone: 'average' }
  return { value, label: 'Low viral potential', tone: 'low' }
}

export const VIRAL_TONE_CLASS: Record<ViralTone, string> = {
  'very-high': 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300',
  high: 'border-brand/50 bg-brand/10 text-brand-light',
  good: 'border-sky-400/50 bg-sky-400/10 text-sky-300',
  average: 'border-amber-400/50 bg-amber-400/10 text-amber-300',
  low: 'border-zinc-500/50 bg-zinc-500/10 text-zinc-300',
}
