import { Link } from 'react-router-dom'
import { ArrowRight, Link2, Upload, Wand2, Youtube } from 'lucide-react'
import { NotImplemented } from '../components/NotImplemented'
import { PageHeader } from '../components/PageHeader'

/**
 * Create Project — Phase 2.
 * Uploading a file goes to the AI Clipper wizard, which sends the file
 * to the video engine for a real ffprobe probe. URL / YouTube / Drive
 * imports need a backend download pipeline and are marked unavailable
 * (Phase 3) — downloading is not claimed to work.
 */
export function CreateProjectPage() {
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

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 opacity-90">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-600/20 text-red-400">
            <Youtube className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Import from YouTube</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Paste a YouTube link and import the video directly.
          </p>
          <div className="mt-4">
            <NotImplemented phase="Phase 3" detail="needs a backend download pipeline" />
          </div>
          <button
            type="button"
            disabled
            className="mt-4 cursor-not-allowed rounded-xl bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)]"
          >
            Import from YouTube
          </button>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 opacity-90">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-600/20 text-sky-400">
            <Link2 className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Import from a link / Drive</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Import a video from a direct link or Google Drive.
          </p>
          <div className="mt-4">
            <NotImplemented phase="Phase 3" detail="needs a backend download pipeline" />
          </div>
          <button
            type="button"
            disabled
            className="mt-4 cursor-not-allowed rounded-xl bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)]"
          >
            Import from link
          </button>
        </div>
      </div>

      <p className="mt-6 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Wand2 className="h-4 w-4 text-brand-light" />
        Supported in the wizard today: MP4, MOV, MKV, WEBM — probed by the
        video engine for real metadata.
      </p>
    </div>
  )
}
