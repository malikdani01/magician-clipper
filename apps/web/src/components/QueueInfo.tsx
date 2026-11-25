import { Clock } from 'lucide-react'

/** Queue position + estimated wait, as returned by the API on every
 * job (GET /api/v1/jobs and /api/v1/jobs/{id} attach `queue`).
 * Batch 11 (2026-11-25). The estimate is honest by construction:
 * average seconds per clip from recent completed jobs × the clips
 * ahead of you, shown as a RANGE and labelled an estimate; it covers
 * only the jobs ahead of you — the job currently processing is not
 * included, because its remaining time is unknown. With fewer than
 * 3 completed jobs to learn from there is no estimate at all, and
 * the UI says so instead of inventing one. Jobs run one at a time.
 */
export interface QueueInfoData {
  status: 'queued' | 'processing'
  position: number
  jobs_ahead: number
  clips_ahead: number
  estimated_wait_seconds_min: number | null
  estimated_wait_seconds_max: number | null
  avg_seconds_per_clip: number | null
  sample_jobs: number
  note: string
}

function formatWait(min: number, max: number): string {
  if (min <= 0 && max <= 0) return 'less than a minute'
  const fmt = (s: number): string => {
    if (s < 60) return `${s} sec`
    const m = Math.round(s / 60)
    return m === 1 ? '1 min' : `${m} min`
  }
  return min === max ? `about ${fmt(max)}` : `about ${fmt(min)}–${fmt(max)}`
}

export function QueueInfo({ queue }: { queue: QueueInfoData | null | undefined }) {
  if (!queue) return null

  if (queue.status === 'processing') {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
        <Clock className="h-4 w-4 shrink-0 text-brand-light" />
        Processing now — jobs run one at a time.
      </p>
    )
  }

  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-[var(--color-text-muted)]">
      <Clock className="h-4 w-4 shrink-0 text-brand-light" />
      <span>
        Queue position #{queue.position}
        {queue.jobs_ahead > 0
          ? ` — ${queue.jobs_ahead} job${queue.jobs_ahead === 1 ? '' : 's'} ahead of you`
          : ' — nothing ahead of you'}
        {' · '}
        {queue.estimated_wait_seconds_min !== null && queue.estimated_wait_seconds_max !== null ? (
          <>
            Estimated wait {formatWait(queue.estimated_wait_seconds_min, queue.estimated_wait_seconds_max)} (estimate
            {queue.sample_jobs > 0 ? `, based on ${queue.sample_jobs} recent job${queue.sample_jobs === 1 ? '' : 's'}` : ''}
            )
          </>
        ) : (
          'Estimated wait: not enough completed jobs yet to estimate'
        )}
        {' · '}Jobs run one at a time.
      </span>
    </p>
  )
}
