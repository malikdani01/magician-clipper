import { useEffect, useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import {
  downloadClip,
  fetchClipBlob,
  fetchClipThumbnail,
  type JobClip,
} from '../lib/jobs'

/**
 * In-app clip player — watch a ready clip before downloading it.
 *
 * Fetches the MP4 as a blob (the same authed fetch as downloads) and
 * plays it from an object URL, so no new backend route is needed. The
 * modal carries its own Download button, so the flow is exactly what
 * the user asked for: play it, watch it, then download it.
 */
export function ClipPlayerModal({
  clip,
  onClose,
}: {
  clip: JobClip
  onClose: () => void
}) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    void (async () => {
      const [thumb, blob] = await Promise.all([
        fetchClipThumbnail(clip.id),
        fetchClipBlob(clip),
      ])
      if (cancelled) {
        if (thumb) URL.revokeObjectURL(thumb)
        return
      }
      if (thumb) {
        urls.push(thumb)
        setPosterUrl(thumb)
      }
      if (!blob.ok) {
        setError(blob.error)
        return
      }
      const url = URL.createObjectURL(blob.blob)
      urls.push(url)
      setVideoUrl(url)
    })()
    return () => {
      cancelled = true
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [clip])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const doDownload = async () => {
    setDownloading(true)
    setDownloadError(null)
    const result = await downloadClip(clip)
    setDownloading(false)
    if (!result.ok) setDownloadError(result.error)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${clip.title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ink-border bg-ink-panel p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-white">{clip.title}</p>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Watch it first — download when you are happy with it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="shrink-0 rounded-lg p-1.5 text-white hover:bg-ink-panel2"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-3 flex min-h-64 items-center justify-center rounded-xl bg-black">
          {error ? (
            <p role="alert" className="px-4 py-8 text-center text-sm text-red-300">
              Preview failed: {error}
            </p>
          ) : videoUrl ? (
            <video
              src={videoUrl}
              poster={posterUrl ?? undefined}
              controls
              autoPlay
              playsInline
              className="max-h-[62vh] w-full rounded-xl object-contain"
            />
          ) : (
            <div className="flex items-center gap-2 py-16">
              <Loader2 className="h-6 w-6 animate-spin text-white" />
              <span className="text-sm text-white">Loading preview…</span>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void doDownload()}
            disabled={downloading || videoUrl === null}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {downloading ? 'Downloading…' : 'Download this clip'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-ink-border px-4 py-2.5 text-sm font-medium text-white hover:bg-ink-panel2"
          >
            Close
          </button>
        </div>
        {downloadError ? (
          <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            Download failed: {downloadError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
