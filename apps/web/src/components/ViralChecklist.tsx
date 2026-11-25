/**
 * Viral checklist — one row per check, derived ONLY from real data.
 * A check whose data is missing shows "not measured" — never a fake
 * pass or an invented value. Score-breakdown keys arrive as display
 * labels ("Hook", "Coverage") from the worker, so the lookup is
 * case-insensitive.
 */

import type { Job, JobClip } from '../lib/jobs'

type CheckState = { label: string; state: 'pass' | 'fail' | 'not_measured'; value: string }

function breakdownValue(
  breakdown: Record<string, number> | null | undefined,
  key: string,
): number | null {
  if (!breakdown) return null
  const found = Object.entries(breakdown).find(
    ([k]) => k.toLowerCase() === key.toLowerCase(),
  )
  if (!found) return null
  const v = Number(found[1])
  return Number.isFinite(v) ? v : null
}

/** Target duration range for the job, from its own settings. */
function targetRange(job: Job): { min: number; max: number } | null {
  const s = job.settings
  if (!s) return null
  const mode = s.duration_mode
  const exact = s.duration_seconds
  if (typeof exact !== 'number') return null
  if (mode === 'exact') return { min: exact, max: exact }
  const min = s.duration_min_seconds ?? exact
  const max = s.duration_max_seconds ?? exact
  if (mode === 'minimum') return { min, max: Number.POSITIVE_INFINITY }
  if (mode === 'maximum') return { min: 0, max }
  return { min, max }
}

export function viralChecklistItems(clip: JobClip, job: Job): CheckState[] {
  const s = job.settings
  const hook = breakdownValue(clip.score_breakdown, 'hook')
  const coverage = breakdownValue(clip.score_breakdown, 'coverage')
  const range = targetRange(job)
  // ±5s tolerance: a clip a few seconds off the target still counts
  // as in range (renders rarely land on the exact second).
  const duration = clip.duration_seconds
  const durationCheck: CheckState =
    duration == null || range === null
      ? { label: 'Duration in range', state: 'not_measured', value: 'not measured' }
      : duration >= range.min - 5 && duration <= range.max + 5
        ? {
            label: 'Duration in range',
            state: 'pass',
            value: `${duration}s (target ${range.min === range.max ? `${range.min}s` : `${range.min}–${range.max === Number.POSITIVE_INFINITY ? '∞' : range.max}s`})`,
          }
        : {
            label: 'Duration in range',
            state: 'fail',
            value: `${duration}s (target ${range.min === range.max ? `${range.min}s` : `${range.min}–${range.max === Number.POSITIVE_INFINITY ? '∞' : range.max}s`})`,
          }
  const hashtags = job.hashtags
  return [
    hook === null
      ? { label: 'Hook score', state: 'not_measured', value: 'not measured' }
      : hook >= 60
        ? { label: 'Hook score', state: 'pass', value: `${hook}/100` }
        : { label: 'Hook score', state: 'fail', value: `${hook}/100 (needs 60+)` },
    coverage === null
      ? { label: 'Speech density', state: 'not_measured', value: 'not measured' }
      : coverage >= 60
        ? { label: 'Speech density', state: 'pass', value: `${coverage}/100` }
        : { label: 'Speech density', state: 'fail', value: `${coverage}/100 (needs 60+)` },
    {
      label: 'Captions on',
      state: s?.captions_enabled === false ? 'fail' : 'pass',
      value: s?.captions_enabled === false ? 'Off' : 'On',
    },
    {
      label: 'Safe zone on',
      state: s?.caption_safe_zone === false ? 'fail' : 'pass',
      value: s?.caption_safe_zone === false ? 'Off' : 'On',
    },
    durationCheck,
    {
      label: 'Beat sync on',
      state: s?.beat_sync === false ? 'fail' : 'pass',
      value: s?.beat_sync === false ? 'Off' : 'On',
    },
    {
      label: 'Title present',
      state: clip.title != null && clip.title.trim() !== '' ? 'pass' : 'fail',
      value: clip.title != null && clip.title.trim() !== '' ? clip.title : 'No title',
    },
    hashtags == null
      ? { label: 'Hashtags present', state: 'not_measured', value: 'not measured' }
      : hashtags.length > 0
        ? { label: 'Hashtags present', state: 'pass', value: `${hashtags.length} hashtag${hashtags.length === 1 ? '' : 's'}` }
        : { label: 'Hashtags present', state: 'fail', value: 'None yet' },
    {
      label: 'Face tracked',
      state: clip.face_tracked ? 'pass' : 'fail',
      value: clip.face_tracked ? 'Tracked' : 'Not tracked',
    },
  ]
}

export function ViralChecklist({ clip, job }: { clip: JobClip; job: Job }) {
  const items = viralChecklistItems(clip, job)
  const passed = items.filter((i) => i.state === 'pass').length
  return (
    <div className="mt-3 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5">
      <p className="text-xs font-semibold text-white">
        Viral checklist — {passed}/{items.length} passed
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-2 text-xs">
            <span
              aria-label={item.state === 'pass' ? 'passed' : item.state === 'fail' ? 'failed' : 'not measured'}
              className={
                item.state === 'pass'
                  ? 'font-bold text-emerald-400'
                  : item.state === 'fail'
                    ? 'font-bold text-red-400'
                    : 'font-bold text-[var(--color-text-muted)]'
              }
            >
              {item.state === 'pass' ? '✓' : item.state === 'fail' ? '✗' : '—'}
            </span>
            <span className="text-[var(--color-text-muted)]">{item.label}:</span>
            <span className="font-medium text-white">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
