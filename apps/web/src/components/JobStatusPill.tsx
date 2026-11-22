import type { JobStatus } from '../lib/jobs'

const PILL_STYLES: Record<JobStatus, string> = {
  queued: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  processing: 'border-brand/50 bg-brand/15 text-brand-light',
  ready: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  cancelled: 'border-ink-border bg-ink-panel2 text-[var(--color-text-muted)]',
}

const PILL_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function JobStatusPill({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PILL_STYLES[status]}`}
    >
      {PILL_LABELS[status]}
    </span>
  )
}

/** One-line human summary of a job's settings, e.g. "TikTok · 9:16 · 3 clips · exact 60s". */
export function jobSummary(job: {
  settings: {
    platform: string
    aspect_ratio: string
    clip_count: number
    duration_mode: string
    duration_seconds: number
  } | null
}): string {
  const s = job.settings
  if (!s) return 'Settings unavailable'
  const platform = s.platform === 'tiktok' ? 'TikTok' : 'Instagram'
  const mode =
    s.duration_mode === 'exact' ? 'exact' : s.duration_mode === 'minimum' ? 'min' : 'max'
  return `${platform} · ${s.aspect_ratio} · ${s.clip_count} clip${s.clip_count === 1 ? '' : 's'} · ${mode} ${s.duration_seconds}s`
}
