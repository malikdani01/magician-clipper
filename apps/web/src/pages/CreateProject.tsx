import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Link2, Upload, Wand2, Youtube } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'

/**
 * Create Project.
 * Uploading a file goes to the AI Clipper wizard (the browser reads
 * its duration/resolution; the server re-checks it on job creation).
 * YouTube / Drive / direct links go to the New Job wizard with the
 * link tab prefilled — the backend accepts source_url and the worker
 * downloads the video with yt-dlp. No download is claimed here; the
 * job page shows the real result.
 */
export function CreateProjectPage() {
  const navigate = useNavigate()
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)

  const submitLink = (raw: string) => {
    const url = raw.trim()
    if (!url) {
      setLinkError('Paste a video link first.')
      return
    }
    try {
      new URL(url)
    } catch {
      setLinkError(
        'That does not look like a valid link. Paste a full YouTube, TikTok, Drive or direct video URL.',
      )
      return
    }
    setLinkError(null)
    navigate(`/jobs/new?source=link&url=${encodeURIComponent(url)}`)
  }
  return (
    <div>
      <PageHeader
        title="Create Project"
        subtitle="Start a new clipping project from a long video."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Link
          to="/clipper"
          className="group rounded-2xl border border-ink-border bg-ink-panel p-6 transition-colors hover:border-brand"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
            <Upload className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Upload a video file</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Choose a video from your computer. The wizard sends it to the
            video engine, which probes it with ffprobe and shows its real
            duration, size, resolution and codecs.
          </p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-light group-hover:underline">
            Open the AI Clipper <ArrowRight className="h-4 w-4" />
          </span>
        </Link>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-600/20 text-red-400">
            <Youtube className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Import from YouTube</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Paste a YouTube link — it opens in the New Job wizard and the
            worker downloads the video.
          </p>
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => {
              setYoutubeUrl(e.target.value)
              setLinkError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLink(youtubeUrl)
            }}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube link to import"
            className="mt-4 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
          />
          <button
            type="button"
            onClick={() => submitLink(youtubeUrl)}
            className="mt-4 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
          >
            Import from YouTube
          </button>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-600/20 text-sky-400">
            <Link2 className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Import from a link / Drive</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Import a video from a direct link or Google Drive — it opens in
            the New Job wizard and the worker downloads it.
          </p>
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => {
              setLinkUrl(e.target.value)
              setLinkError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLink(linkUrl)
            }}
            placeholder="Paste a Drive or direct video link…"
            aria-label="Link or Drive URL to import"
            className="mt-4 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
          />
          <button
            type="button"
            onClick={() => submitLink(linkUrl)}
            className="mt-4 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
          >
            Import from link
          </button>
        </div>
      </div>

      {linkError ? (
        <p role="alert" className="mt-4 text-sm text-red-300">
          {linkError}
        </p>
      ) : null}

      <p className="mt-6 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Wand2 className="h-4 w-4 text-brand-light" />
        Supported in the wizard today: MP4, MOV, MKV, WEBM uploads, plus
        YouTube, TikTok, Google Drive and direct video links — the worker
        downloads link videos.
      </p>
    </div>
  )
}
