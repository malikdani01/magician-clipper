import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clapperboard, Download, FileVideo, Image, Music, Play, Search, Video } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { ClipPlayerModal } from '../components/ClipPlayerModal'
import { ClipThumbnail } from '../components/ClipThumbnail'
import { useProjects, getProjectFile, getProjectVideoUrl } from '../state/projects'
import { downloadClip, listJobs, type Job, type JobClip } from '../lib/jobs'
import { formatBytes } from '../lib/format'
import { formatDuration } from '../lib/format'

type LibraryTab = 'all' | 'originals' | 'clips' | 'thumbnails' | 'audio'

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'originals', label: 'Originals' },
  { id: 'clips', label: 'Clips' },
  { id: 'thumbnails', label: 'Thumbnails' },
  { id: 'audio', label: 'Audio' },
]

/**
 * Video Library — redesign (same-to-same as the design collage).
 * Originals are real: the source file of each project, with real
 * metadata from the engine probe. Clips are real too: the ready clips
 * of the user's jobs, with real first-frame thumbnails and working
 * downloads. Thumbnails are the same clips as thumbnail tiles. Audio
 * has no extracted files — the worker keeps audio inside the clips —
 * and says so honestly instead of faking rows. A project whose file
 * is not attached in this browser session says so instead of
 * pretending the file is playable.
 */
export function LibraryPage() {
  const [tab, setTab] = useState<LibraryTab>('all')
  const [query, setQuery] = useState('')
  const { projects } = useProjects()
  const [readyJobs, setReadyJobs] = useState<Job[]>([])
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [previewingClip, setPreviewingClip] = useState<JobClip | null>(null)

  // Ready jobs (with their clips) for the Clips / Thumbnails tabs.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { jobs } = await listJobs({ status: 'ready', perPage: 50 })
      if (!cancelled) setReadyJobs(jobs)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const clips = useMemo(
    () =>
      readyJobs.flatMap((j) =>
        j.clips.map((c) => ({ ...c, jobId: j.id }) as JobClip & { jobId: number }),
      ),
    [readyJobs],
  )

  const filteredClips = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return clips
    return clips.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        String(c.jobId).includes(q),
    )
  }, [clips, query])

  async function doDownload(clip: JobClip) {
    setDownloadingId(clip.id)
    setDownloadError(null)
    const result = await downloadClip(clip)
    setDownloadingId(null)
    if (!result.ok) setDownloadError(result.error)
  }

  const searching = query.trim() !== ''

  const originals = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter(
      (p) =>
        p.fileName !== '' &&
        (q === '' ||
          p.title.toLowerCase().includes(q) ||
          p.fileName.toLowerCase().includes(q)),
    )
  }, [projects, query])

  const showOriginals = tab === 'all' || tab === 'originals'
  const showClips = tab === 'all' || tab === 'clips' || tab === 'thumbnails'

  const emptyTitle =
    searching
      ? `No files match “${query.trim()}”`
      : tab === 'clips'
        ? 'No clips generated yet'
        : tab === 'thumbnails'
          ? 'No thumbnails yet'
          : tab === 'audio'
            ? 'No audio yet'
            : 'Your library is empty'

  const emptyDescription =
    tab === 'clips'
      ? 'No clips generated yet — create a job in the AI Clipper and the finished clips will appear here.'
      : tab === 'thumbnails'
        ? 'Thumbnails appear with the clips — generate a clip first.'
        : tab === 'audio'
          ? 'No extracted audio files — the worker keeps the audio inside the clips; there is no separate audio export yet.'
          : 'Nothing has been uploaded yet. Videos you import in the AI Clipper will appear here.'

  return (
    <div>
      <PageHeader title="Video Library" subtitle="Your uploaded and generated media." />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Library sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-brand text-white'
                  : 'border border-ink-border bg-ink-panel text-[var(--color-text-muted)] hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            aria-label="Search files"
            className="w-64 rounded-xl border border-ink-border bg-ink-panel py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
      </div>

      {downloadError ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Download failed: {downloadError}
        </p>
      ) : null}

      {showOriginals && originals.length > 0 && (
        <>
          {tab === 'all' ? (
            <h2 className="mb-3 text-base font-semibold text-white">Originals</h2>
          ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {originals.map((p) => {
            const attached = getProjectFile(p.id) !== undefined
            const videoUrl = attached ? getProjectVideoUrl(p.id) : undefined
            return (
              <article
                key={p.id}
                className="overflow-hidden rounded-2xl border border-ink-border bg-ink-panel shadow-card transition-colors hover:border-brand/50"
              >
                <Link
                  to={`/editor?project=${encodeURIComponent(p.id)}`}
                  className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-ink-panel2 to-brand-dark/40 text-brand-light"
                  aria-label={`Open ${p.fileName} in the editor`}
                >
                  <FileVideo className="h-12 w-12" />
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity hover:opacity-100">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white">
                      <Play className="ml-0.5 h-5 w-5 fill-white" />
                    </span>
                  </span>
                  {p.durationSeconds !== null ? (
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
                      {formatDuration(p.durationSeconds)}
                    </span>
                  ) : null}
                </Link>
                <div className="p-4">
                  <p className="truncate text-sm font-semibold text-white">{p.fileName}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {p.durationSeconds !== null
                      ? formatDuration(p.durationSeconds)
                      : 'Duration unknown'}
                    {p.width !== null && p.height !== null
                      ? ` · ${p.width}×${p.height}`
                      : ''}
                    {p.videoCodec ? ` · ${p.videoCodec}` : ''}
                    {p.fileSize > 0 ? ` · ${formatBytes(p.fileSize)}` : ''}
                    {` · ${p.title}`}
                  </p>
                  {!attached ? (
                    <p className="mt-2 text-xs text-amber-300">
                      File not in this browser session — re-attach it from the
                      project to play or download it.
                    </p>
                  ) : null}
                  <div className="mt-3 flex items-center gap-2">
                    {videoUrl ? (
                      <a
                        href={videoUrl}
                        download={p.fileName}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-light"
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        title="File not in this browser session"
                        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-xl bg-ink-panel2 px-3 py-2 text-sm font-semibold text-[var(--color-text-muted)]"
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </button>
                    )}
                    <Link
                      to={`/editor?project=${encodeURIComponent(p.id)}`}
                      className="rounded-xl border border-ink-border px-3 py-2 text-sm font-medium text-white hover:bg-ink-panel2"
                    >
                      Open project
                    </Link>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
        </>
      )}

      {showClips && filteredClips.length > 0 && (
        <>
          {tab === 'all' ? (
            <h2 className="mb-3 mt-8 text-base font-semibold text-white">Clips</h2>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredClips.map((clip) => (
              <article
                key={clip.id}
                className="overflow-hidden rounded-2xl border border-ink-border bg-ink-panel shadow-card transition-colors hover:border-brand/50"
              >
                <Link
                  to={`/jobs/${clip.jobId}`}
                  className="relative block aspect-video bg-ink-panel2"
                  aria-label={`Open ${clip.title} (job ${clip.jobId})`}
                >
                  <ClipThumbnail
                    clipId={clip.id}
                    hasThumbnail={clip.thumbnail_path !== null}
                    alt={`${clip.title} — first frame`}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity hover:opacity-100">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white">
                      <Play className="ml-0.5 h-5 w-5 fill-white" />
                    </span>
                  </span>
                  {clip.duration_seconds !== null ? (
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium text-white tabular-nums">
                      {formatDuration(clip.duration_seconds)}
                    </span>
                  ) : null}
                </Link>
                <div className="p-4">
                  <p className="truncate text-sm font-semibold text-white">{clip.title}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {clip.duration_seconds !== null
                      ? formatDuration(clip.duration_seconds)
                      : 'Duration unknown'}
                    {clip.file_size_bytes ? ` · ${formatBytes(clip.file_size_bytes)}` : ''}
                    {clip.score !== null ? ` · viral ${Math.round(clip.score * 100)}` : ''}
                    {` · job #${clip.jobId}`}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void doDownload(clip)}
                      disabled={downloadingId === clip.id}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-wait disabled:opacity-60"
                    >
                      <Download className="h-4 w-4" />
                      {downloadingId === clip.id ? 'Downloading…' : 'Download'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewingClip(clip)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-ink-border px-3 py-2 text-sm font-semibold text-white hover:bg-ink-panel2"
                    >
                      <Play className="h-4 w-4" />
                      Preview
                    </button>
                    <Link
                      to={`/jobs/${clip.jobId}`}
                      className="rounded-xl border border-ink-border px-3 py-2 text-sm font-medium text-white hover:bg-ink-panel2"
                    >
                      Open job
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {((showOriginals && originals.length === 0 && !showClips) ||
        (showClips && filteredClips.length === 0 && !showOriginals) ||
        (tab === 'all' && originals.length === 0 && filteredClips.length === 0) ||
        tab === 'audio') && (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          icon={
            tab === 'thumbnails' ? (
              <Image className="h-7 w-7" />
            ) : tab === 'audio' ? (
              <Music className="h-7 w-7" />
            ) : tab === 'clips' ? (
              <Clapperboard className="h-7 w-7" />
            ) : tab === 'originals' ? (
              <FileVideo className="h-7 w-7" />
            ) : (
              <Video className="h-7 w-7" />
            )
          }
        />
      )}
      {previewingClip ? (
        <ClipPlayerModal
          clip={previewingClip}
          onClose={() => setPreviewingClip(null)}
        />
      ) : null}
    </div>
  )
}
