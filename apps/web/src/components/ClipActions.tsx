/**
 * Shared per-clip actions (Batch 4, 2026-11-25): the favourite heart
 * and the thumbnail picker. Used by JobDetail and Library so the two
 * can never drift apart.
 */

import { useEffect, useState } from 'react'
import { Heart, Loader2 } from 'lucide-react'
import {
  fetchClipCandidate,
  setClipThumbnail,
  toggleClipFavourite,
  type JobClip,
} from '../lib/jobs'

/**
 * The per-clip favourite heart. Toggles via the API and calls
 * onChanged so the parent refreshes from the server (the flag shown
 * is the server's, not a guess). A re-render never clears the flag —
 * the backend keeps it on the clip row.
 */
export function ClipFavouriteButton({
  clip,
  onChanged,
}: {
  clip: JobClip
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = async () => {
    setBusy(true)
    setError(null)
    const result = await toggleClipFavourite(clip.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChanged()
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={clip.is_favourite ? 'Remove from favourites' : 'Add to favourites'}
        aria-pressed={clip.is_favourite}
        title={clip.is_favourite ? 'Favourited — click to remove' : 'Add to favourites'}
        className={`flex h-10 w-10 items-center justify-center rounded-xl border disabled:cursor-not-allowed disabled:opacity-50 ${
          clip.is_favourite
            ? 'border-red-500/50 bg-red-500/15 text-red-400'
            : 'border-ink-border text-[var(--color-text-muted)] hover:text-white'
        }`}
      >
        <Heart className={`h-5 w-5 ${clip.is_favourite ? 'fill-current' : ''}`} />
      </button>
      {error ? <span className="max-w-32 text-xs text-red-300">{error}</span> : null}
    </span>
  )
}

/**
 * Thumbnail picker — the 3 candidate frames the worker extracted
 * (10% / 50% / 90% of the clip). Picking one sets it as the clip's
 * thumbnail. A clip rendered before the picker existed has no
 * candidates and says so honestly instead of showing a broken picker.
 */
export function ClipThumbnailPicker({
  clip,
  onChanged,
}: {
  clip: JobClip
  onChanged: () => void
}) {
  const candidates = Array.isArray(clip.thumbnail_candidates) ? clip.thumbnail_candidates : []
  const [urls, setUrls] = useState<Array<string | null>>([])
  const [busyIndex, setBusyIndex] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (candidates.length === 0) return
    let cancelled = false
    const loaded: Array<string | null> = new Array(candidates.length).fill(null)
    void (async () => {
      for (let i = 0; i < candidates.length; i++) {
        loaded[i] = await fetchClipCandidate(clip.id, i)
        if (cancelled) return
        setUrls([...loaded])
      }
    })()
    return () => {
      cancelled = true
      for (const url of loaded) {
        if (url) URL.revokeObjectURL(url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, candidates.length])

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)]">
        No alternate frames for this clip.
      </p>
    )
  }

  const pick = async (index: number) => {
    setBusyIndex(index)
    setError(null)
    const result = await setClipThumbnail(clip.id, index)
    setBusyIndex(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onChanged()
  }

  return (
    <div>
      <p className="text-xs font-medium text-[var(--color-text-muted)]">
        Change thumbnail — pick a frame:
      </p>
      <div className="mt-2 flex gap-2">
        {candidates.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => void pick(i)}
            disabled={busyIndex !== null}
            aria-label={`Use frame ${i + 1} as thumbnail`}
            title={`Frame ${i + 1} of ${candidates.length}`}
            className="relative h-16 w-10 shrink-0 overflow-hidden rounded-lg border border-ink-border hover:border-brand disabled:cursor-not-allowed disabled:opacity-60"
          >
            {urls[i] ? (
              <img src={urls[i] ?? undefined} alt={`Candidate frame ${i + 1}`} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-ink-panel2 text-[10px] text-[var(--color-text-muted)]">
                {busyIndex === i ? '…' : `${i + 1}`}
              </span>
            )}
            {busyIndex === i ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                <Loader2 className="h-4 w-4 animate-spin text-white" />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}
