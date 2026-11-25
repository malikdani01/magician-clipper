/**
 * Bulk re-render bar — checkboxes select clips (JobDetail + Library),
 * one caption style is picked for all of them, and the bar queues the
 * re-renders in one request. Per-clip progress is shown honestly by
 * polling the existing per-clip rerenders endpoint while any selected
 * re-render is queued/processing; a clip whose re-render was skipped
 * shows the server's reason.
 */

import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { CAPTION_STYLES, getCaptionStyle } from '../lib/captionStyles'
import {
  getClipRerenders,
  requestBulkRerender,
  type ClipRerender,
} from '../lib/jobs'

export function BulkRerenderBar({
  clipIds,
  onDone,
}: {
  clipIds: number[]
  onDone: () => void
}) {
  const [style, setStyle] = useState('neon')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState<ClipRerender[]>([])
  const [skipped, setSkipped] = useState<{ clip_id: number; reason: string }[]>([])
  const [statusByClip, setStatusByClip] = useState<Record<number, ClipRerender>>({})
  const pollingRef = useRef(false)

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const result = await requestBulkRerender(clipIds, style)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setQueued(result.rerenders)
    setSkipped(result.skipped)
    const initial: Record<number, ClipRerender> = {}
    for (const r of result.rerenders) initial[r.clip_id] = r
    setStatusByClip(initial)
    pollingRef.current = result.rerenders.length > 0
  }

  // Poll each queued re-render's clip endpoint until all are done.
  useEffect(() => {
    if (!pollingRef.current || queued.length === 0) return undefined
    let cancelled = false
    const tick = async () => {
      let anyInFlight = false
      const next: Record<number, ClipRerender> = {}
      for (const r of queued) {
        const list = await getClipRerenders(r.clip_id)
        const latest = list.find((x) => x.id === r.id) ?? list[0] ?? null
        if (latest) {
          next[r.clip_id] = latest
          if (latest.status === 'queued' || latest.status === 'processing') {
            anyInFlight = true
          }
        }
      }
      if (cancelled) return
      setStatusByClip((current) => ({ ...current, ...next }))
      if (!anyInFlight) {
        pollingRef.current = false
        onDone()
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued])

  if (clipIds.length === 0) return null

  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-2 rounded-2xl border border-ink-border bg-ink-panel px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-white">
          {clipIds.length} clip{clipIds.length === 1 ? '' : 's'} selected
        </span>
        <label className="flex items-center gap-2 text-sm text-white">
          Caption style
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            aria-label="Caption style for bulk re-render"
            className="rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
          >
            {CAPTION_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="flex items-center gap-1.5 rounded-xl btn-aurora px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          {submitting ? 'Queuing…' : 'Re-render selected'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
      {queued.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {queued.map((r) => {
            const latest = statusByClip[r.clip_id] ?? r
            return (
              <li key={r.id} className="text-[var(--color-text-muted)]">
                Clip #{r.clip_id} — {getCaptionStyle(latest.caption_style).name}:{' '}
                <span className="font-medium text-white">
                  {latest.status === 'ready'
                    ? 'Done — the file was replaced.'
                    : latest.status === 'failed'
                      ? `Failed${latest.error_message ? `: ${latest.error_message}` : '.'}`
                      : `${latest.status}…`}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {skipped.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {skipped.map((s) => (
            <li key={s.clip_id} className="text-amber-300">
              Clip #{s.clip_id} skipped — {s.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
