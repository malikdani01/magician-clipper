import type { JobStatus } from '../lib/jobs'
import type { TranslationKey } from '../lib/i18n'
import { usePreferences } from '../state/preferences'

const PILL_STYLES: Record<JobStatus, string> = {
  queued: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  processing: 'border-brand/50 bg-brand/15 text-brand-light',
  ready: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  cancelled: 'border-ink-border bg-ink-panel2 text-[var(--color-text-muted)]',
}

/** Status labels go through the UI language (Roman Urdu when on). */
const PILL_LABELS: Record<JobStatus, TranslationKey> = {
  queued: 'queued',
  processing: 'processing',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
}

export function JobStatusPill({ status }: { status: JobStatus }) {
  const { t } = usePreferences()
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PILL_STYLES[status]}`}
    >
      {status === 'processing' || status === 'queued' ? (
        <span className="live-dot" aria-hidden="true" />
      ) : null}
      {t(PILL_LABELS[status])}
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
