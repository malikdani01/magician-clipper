import { useEffect, useRef, useState } from 'react'
import { Clapperboard, Download, FileVideo, FolderOpen, Pause, Play, Upload, Volume2 } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { ClipThumbnail } from '../components/ClipThumbnail'
import { API_URL } from '../lib/api'
import { CAPTION_PRESETS } from '../lib/captions'
import { getCaptionStyle, isCaptionStyleId } from '../lib/captionStyles'
import { downloadClip } from '../lib/jobs'
import { createExport, downloadExport } from '../lib/exports'
import { listProjectClips, type ProjectClipSummary } from '../lib/projects-api'
import { formatBytes, formatDuration } from '../lib/format'
import { useAuth } from '../state/auth'
import {
  getProject,
  getProjectFile,
  getProjectVideoUrl,
  setProjectFile,
  useProjects,
  type ClipSpec,
} from '../state/projects'

type EditorTab = 'media' | 'transcript' | 'clips' | 'captions' | 'text' | 'brand-kit'

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'clips', label: 'Clips' },
  { id: 'captions', label: 'Captions' },
  { id: 'text', label: 'Text' },
  { id: 'brand-kit', label: 'Brand Kit' },
]

/** Render the saved clip spec as read-only text. */
function specEntries(spec: ClipSpec): { label: string; value: string }[] {
  const entries: { label: string; value: string }[] = [
    { label: 'Platform', value: spec.platform },
    { label: 'Aspect', value: spec.aspect },
    { label: 'Clip count', value: String(spec.clipCount) },
    {
      label: 'Clip duration',
      value: `${spec.durationSeconds}s (${spec.durationMode})`,
    },
    { label: 'Content type', value: spec.contentType },
    { label: 'Processing mode', value: spec.processingMode },
    { label: 'Captions', value: spec.captions ? 'On' : 'Off' },
    { label: 'On-screen text', value: spec.onScreenText ? 'On' : 'Off' },
  ]
  if (spec.keywords.trim()) entries.push({ label: 'Keywords', value: spec.keywords })
  return entries
}

/**
 * Studio Editor — redesign (same-to-same as the design collage).
 * Edits a REAL uploaded video from the in-memory project store: the
 * <video> preview, play/pause, seek, volume and start/end trim are all
 * live, and the filmstrip above the timeline shows real frames captured
 * from the attached source video. Save Draft persists the trim in this
 * browser; Preview plays the trimmed range; Export builds a ZIP of the
 * project's real generated clips. The Clips tab lists the project's
 * real server clips with downloads, and the Transcript tab shows the
 * transcribed lines burned into those clips. No fake video, no fake
 * waveform (audio analysis does not exist), no fake render.
 */
export function EditorPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { projects, updateProject } = useProjects()
  const { token } = useAuth()
  const projectId = searchParams.get('project')
  const project = projectId ? getProject(projectId) : undefined

  const [tab, setTab] = useState<EditorTab>('media')
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Video bytes live only in memory; after a re-select we re-read the
  // store, so bump this to re-render.
  const [fileTick, setFileTick] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [volume, setVolume] = useState(1)
  const [trimStart, setTrimStart] = useState(project?.trimStartSeconds ?? 0)
  const [trimEnd, setTrimEnd] = useState<number | null>(
    project?.trimEndSeconds ?? null,
  )
  // Trim preview: while true, playback pauses at the trim end.
  const [previewingTrim, setPreviewingTrim] = useState(false)
  const [draftMessage, setDraftMessage] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [downloadingClipId, setDownloadingClipId] = useState<number | null>(null)
  // The project's real server clips (for the Clips / Transcript tabs
  // and the Export button). Empty when the project was never synced.
  const [projectClips, setProjectClips] = useState<ProjectClipSummary[]>([])
  // The default caption style new jobs burn in (from /api/v1/settings).
  const [defaultStyleId, setDefaultStyleId] = useState<string>('punchy')
  // Real filmstrip frames captured from the attached source video.
  const [frames, setFrames] = useState<string[]>([])

  useEffect(() => {
    if (!project?.laravelId || !token) return
    let cancelled = false
    void (async () => {
      const clips = await listProjectClips(project.laravelId as number)
      if (!cancelled) setProjectClips(clips)
    })()
    return () => {
      cancelled = true
    }
  }, [project?.laravelId, token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const body = (await res.json()) as { settings?: { caption_style?: unknown } }
        if (!cancelled && isCaptionStyleId(body.settings?.caption_style)) {
          setDefaultStyleId(body.settings.caption_style)
        }
      } catch {
        // Backend unreachable — keep the 'punchy' default.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  // Capture real frames from the attached source video for the
  // filmstrip: a hidden video element seeks through the file and each
  // frame is drawn to canvas. Nothing is drawn when the source file
  // is not in this browser session.
  useEffect(() => {
    const url = project && getProjectFile(project.id) !== undefined
      ? getProjectVideoUrl(project.id)
      : undefined
    if (!url) {
      setFrames([])
      return
    }
    let cancelled = false
    const offscreen = document.createElement('video')
    offscreen.muted = true
    offscreen.preload = 'auto'
    offscreen.src = url
    const captured: string[] = []
    const fractions = [0.05, 0.17, 0.29, 0.41, 0.53, 0.65, 0.77, 0.89]
    let index = 0
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const ctx = canvas.getContext('2d')
    const onSeeked = () => {
      if (cancelled || !ctx) return
      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)
      captured.push(canvas.toDataURL('image/jpeg', 0.7))
      index += 1
      if (index < fractions.length && Number.isFinite(offscreen.duration)) {
        offscreen.currentTime = offscreen.duration * fractions[index]
      } else {
        setFrames([...captured])
      }
    }
    const onLoaded = () => {
      if (cancelled || !Number.isFinite(offscreen.duration)) return
      offscreen.currentTime = offscreen.duration * fractions[0]
    }
    offscreen.addEventListener('seeked', onSeeked)
    offscreen.addEventListener('loadedmetadata', onLoaded)
    return () => {
      cancelled = true
      offscreen.removeEventListener('seeked', onSeeked)
      offscreen.removeEventListener('loadedmetadata', onLoaded)
      offscreen.src = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, fileTick])

  const fileAvailable = project ? getProjectFile(project.id) !== undefined : false
  const videoUrl = project && fileAvailable ? getProjectVideoUrl(project.id) : undefined
  const duration = project?.durationSeconds ?? videoDuration
  const effectiveEnd = trimEnd ?? duration ?? 0
  const trimmedLength = Math.max(0, effectiveEnd - trimStart)
  const defaultStyle = getCaptionStyle(defaultStyleId)

  function saveDraft() {
    if (!project) return
    updateProject(project.id, {
      trimStartSeconds: trimStart,
      trimEndSeconds: effectiveEnd,
    })
    setDraftMessage(
      `Draft saved in this browser — trim ${formatDuration(trimStart)} – ${formatDuration(effectiveEnd)} kept for this project.`,
    )
  }

  function previewTrim() {
    const video = videoRef.current
    if (!video || !duration) return
    setPreviewingTrim(true)
    video.currentTime = trimStart
    setCurrentTime(trimStart)
    void video.play()
  }

  async function exportProject() {
    if (!project?.laravelId || projectClips.length === 0) return
    setExportMessage(null)
    setExporting(true)
    const created = await createExport(project.laravelId)
    if (!created.ok) {
      setExportMessage(created.error)
      setExporting(false)
      return
    }
    const result = await downloadExport(created.export)
    setExporting(false)
    setExportMessage(
      result.ok
        ? `Export ready — ${projectClips.length} clip${projectClips.length === 1 ? '' : 's'} downloaded as a ZIP.`
        : result.error,
    )
  }

  async function downloadProjectClip(clip: ProjectClipSummary) {
    setDownloadingClipId(clip.id)
    const result = await downloadClip({
      id: clip.id,
      title: clip.title,
      status: 'ready',
      start_seconds: null,
      end_seconds: null,
      duration_seconds: clip.duration_seconds,
      aspect_ratio: null,
      file_size_bytes: clip.file_size_bytes,
      score: clip.score,
      reason: null,
      transcript_excerpt: clip.transcript_excerpt,
      download_url: `${API_URL}/clips/${clip.id}/download`,
      thumbnail_path: clip.thumbnail_path,
      caption_style: clip.caption_style ?? null,
      created_at: '',
    })
    setDownloadingClipId(null)
    if (!result.ok) setExportMessage(result.error)
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const seekTo = (seconds: number) => {
    const video = videoRef.current
    if (!video || !duration) return
    const clamped = Math.min(Math.max(0, seconds), duration)
    video.currentTime = clamped
    setCurrentTime(clamped)
  }

  const clampTrimStart = (value: number) => {
    if (!duration) return
    setTrimStart(Math.min(Math.max(0, value), Math.max(0, effectiveEnd - 0.1)))
  }

  const clampTrimEnd = (value: number) => {
    if (!duration) return
    setTrimEnd(Math.min(Math.max(trimStart + 0.1, value), duration))
  }

  const handleReselect = (file: File | undefined) => {
    if (!file || !project) return
    setProjectFile(project.id, file)
    setFileTick((t) => t + 1)
    setCurrentTime(0)
    setTrimStart(0)
    setTrimEnd(null)
  }

  const spec = project?.spec ? specEntries(project.spec) : []

  return (
    <div>
      <PageHeader
        title="Studio Editor"
        subtitle={
          project ? `Editing: ${project.title}` : 'Edit, customize and perfect your clips.'
        }
        actions={
          <>
            <button
              type="button"
              onClick={saveDraft}
              className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
            >
              Save Draft
            </button>
            <button
              type="button"
              onClick={previewTrim}
              disabled={!videoUrl || !duration}
              title={
                !videoUrl
                  ? 'Re-select the source file to preview the trim'
                  : 'Play the trimmed range'
              }
              className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => void exportProject()}
              disabled={!project?.laravelId || projectClips.length === 0 || exporting}
              title={
                !project?.laravelId
                  ? 'This project has not been synced to the server yet'
                  : projectClips.length === 0
                    ? 'No generated clips to export yet — create a job first'
                    : 'Build a ZIP of this project’s generated clips and download it'
              }
              className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-40"
            >
              {exporting ? 'Preparing…' : 'Export'}
            </button>
          </>
        }
      />
      {draftMessage ? (
        <p className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {draftMessage}
        </p>
      ) : null}
      {exportMessage ? (
        <p className="mb-4 rounded-xl border border-ink-border bg-ink-panel px-4 py-3 text-sm text-[var(--color-text-muted)]">
          {exportMessage}
        </p>
      ) : null}

      {/* No project chosen: pick one for real. */}
      {!projectId ? (
        projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="No projects yet — import a video in the AI Clipper."
            icon={<FolderOpen className="h-7 w-7" />}
            action={
              <Link
                to="/clipper"
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
              >
                <Upload className="h-4 w-4" /> Open the AI Clipper
              </Link>
            }
          />
        ) : (
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Choose a project to edit</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Pick one of your imported videos. The editor loads the video from this
              browser session.
            </p>
            <ul className="mt-4 space-y-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/editor?project=${p.id}`)}
                    className="flex w-full items-center gap-3 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3 text-left hover:border-brand/60"
                  >
                    <FileVideo className="h-5 w-5 shrink-0 text-brand-light" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-white">
                        {p.title}
                      </span>
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">
                        {p.fileName}
                        {p.durationSeconds != null ? ` · ${formatDuration(p.durationSeconds)}` : ''}
                        {p.width && p.height ? ` · ${p.width}×${p.height}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : !project ? (
        <EmptyState
          title="Project not found"
          description="No project matches this link. It may have been removed, or the link is wrong."
          icon={<FolderOpen className="h-7 w-7" />}
          action={
            <Link
              to="/editor"
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
            >
              Choose a project
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <div className="lg:col-span-1">
            <div className="flex flex-col gap-1 rounded-2xl border border-ink-border bg-ink-panel p-3" role="tablist" aria-label="Editor panels">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                    tab === t.id
                      ? 'bg-brand text-white'
                      : 'text-[var(--color-text-muted)] hover:bg-ink-panel2 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-4">
              <h3 className="text-sm font-semibold text-white">Source video</h3>
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">File</dt>
                  <dd className="truncate text-right text-white" title={project.fileName}>
                    {project.fileName}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Size</dt>
                  <dd className="text-white">{formatBytes(project.fileSize)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Duration</dt>
                  <dd className="text-white">
                    {duration != null ? formatDuration(duration) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Resolution</dt>
                  <dd className="text-white">
                    {project.width && project.height ? `${project.width}×${project.height}` : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Frame rate</dt>
                  <dd className="text-white">{project.fps != null ? `${project.fps.toFixed(1)} fps` : '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Video codec</dt>
                  <dd className="text-white">{project.videoCodec ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Audio codec</dt>
                  <dd className="text-white">{project.audioCodec ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-muted)]">Status</dt>
                  <dd className="text-white">{project.status}</dd>
                </div>
              </dl>
              {spec.length > 0 ? (
                <>
                  <h3 className="mt-5 text-sm font-semibold text-white">Clip spec</h3>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    {spec.map((entry) => (
                      <div key={entry.label} className="flex justify-between gap-2">
                        <dt className="text-[var(--color-text-muted)]">{entry.label}</dt>
                        <dd className="truncate text-right text-white">{entry.value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <p className="mt-5 text-xs text-[var(--color-text-muted)]">
                  No clip spec saved for this project yet.
                </p>
              )}
              <p className="mt-5 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Trim: {formatDuration(trimStart)} – {formatDuration(effectiveEnd)} · Trimmed
                length: {trimmedLength.toFixed(1)}s
              </p>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              {tab === 'media' &&
                (!fileAvailable || !videoUrl ? (
                  <EmptyState
                    title="Source file is not in this browser session"
                    description="Source file is not in this browser session — re-select the original file to edit. Video files are kept in memory only and do not survive a page reload."
                    icon={<Clapperboard className="h-7 w-7" />}
                    action={
                      <>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
                        >
                          <Upload className="h-4 w-4" /> Re-select original file
                        </button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => handleReselect(e.target.files?.[0])}
                        />
                      </>
                    }
                  />
                ) : (
                  <div>
                    <video
                      key={`${videoUrl}-${fileTick}`}
                      ref={videoRef}
                      src={videoUrl}
                      preload="metadata"
                      className="aspect-video w-full rounded-xl bg-black"
                      onLoadedMetadata={(e) => {
                        const d = e.currentTarget.duration
                        if (Number.isFinite(d)) setVideoDuration(d)
                      }}
                      onTimeUpdate={(e) => {
                        const t = e.currentTarget.currentTime
                        setCurrentTime(t)
                        if (previewingTrim && t >= effectiveEnd) {
                          e.currentTarget.pause()
                          setPreviewingTrim(false)
                        }
                      }}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
                    />
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={togglePlay}
                        aria-label={isPlaying ? 'Pause' : 'Play'}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-white"
                      >
                        {isPlaying ? (
                          <Pause className="h-5 w-5" />
                        ) : (
                          <Play className="h-5 w-5" />
                        )}
                      </button>
                      <span className="shrink-0 text-xs text-white tabular-nums">
                        {formatDuration(currentTime)} /{' '}
                        {duration != null ? formatDuration(duration) : '—'}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={duration ?? 0}
                        step={0.1}
                        value={Math.min(currentTime, duration ?? 0)}
                        disabled={!duration}
                        onChange={(e) => seekTo(Number(e.target.value))}
                        aria-label="Seek"
                        className="w-full accent-[#7C3AED]"
                      />
                      <span className="flex shrink-0 items-center gap-2">
                        <Volume2 className="h-4 w-4 text-[var(--color-text-muted)]" />
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={volume}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            setVolume(v)
                            if (videoRef.current) videoRef.current.volume = v
                          }}
                          aria-label="Volume"
                          className="w-20 accent-[#7C3AED]"
                        />
                      </span>
                    </div>

                    {/* Filmstrip — real frames captured from the attached
                        source video (hidden video + canvas). No waveform:
                        no audio analysis exists, so none is drawn. */}
                    {frames.length > 0 ? (
                      <div className="mt-6">
                        <div className="flex gap-1 overflow-hidden rounded-lg">
                          {frames.map((src, i) => (
                            <button
                              key={src}
                              type="button"
                              onClick={() => {
                                if (!duration) return
                                const fracs = [0.05, 0.17, 0.29, 0.41, 0.53, 0.65, 0.77, 0.89]
                                seekTo(duration * (fracs[i] ?? 0))
                              }}
                              aria-label={`Seek to frame ${i + 1}`}
                              className="min-w-0 flex-1 overflow-hidden rounded-md"
                            >
                              <img
                                src={src}
                                alt=""
                                className="h-10 w-full object-cover sm:h-12"
                              />
                            </button>
                          ))}
                        </div>
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          Frames from your source video — click one to seek.
                        </p>
                      </div>
                    ) : null}
                    <div className="mt-6">
                      <div
                        role="slider"
                        aria-label="Timeline — click to seek"
                        aria-valuemin={0}
                        aria-valuemax={duration ?? 0}
                        aria-valuenow={Math.round(currentTime)}
                        tabIndex={0}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect()
                          const frac = Math.min(
                            Math.max(0, (e.clientX - rect.left) / rect.width),
                            1,
                          )
                          seekTo(frac * (duration ?? 0))
                        }}
                        onKeyDown={(e) => {
                          if (!duration) return
                          if (e.key === 'ArrowLeft') seekTo(currentTime - 1)
                          if (e.key === 'ArrowRight') seekTo(currentTime + 1)
                        }}
                        className="relative h-8 cursor-pointer rounded-lg bg-ink-panel2"
                      >
                        <div
                          aria-hidden="true"
                          className="absolute top-0 h-full rounded-lg bg-brand/50"
                          style={{
                            left: duration ? `${(trimStart / duration) * 100}%` : '0%',
                            width: duration
                              ? `${Math.max(0, ((effectiveEnd - trimStart) / duration) * 100)}%`
                              : '0%',
                          }}
                        />
                        <div
                          aria-hidden="true"
                          className="absolute top-0 h-full w-0.5 bg-white"
                          style={{
                            left: duration ? `${(currentTime / duration) * 100}%` : '0%',
                          }}
                        />
                      </div>
                      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)] tabular-nums">
                        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                          <span key={f}>
                            {duration != null ? formatDuration(duration * f) : '—'}
                          </span>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                        Purple = kept trim range ({formatDuration(trimStart)} –{' '}
                        {formatDuration(effectiveEnd)}). Click the ruler to seek.
                      </p>
                    </div>

                    <div className="mt-6">
                      <h3 className="text-sm font-semibold text-white">Trim</h3>
                      <div className="mt-3 space-y-4">
                        <label className="block">
                          <span className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                            <span>Start</span>
                            <span className="text-white tabular-nums">
                              {formatDuration(trimStart)}
                            </span>
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={duration ? Math.max(0, effectiveEnd - 0.1) : 0}
                            step={0.1}
                            value={trimStart}
                            disabled={!duration}
                            onChange={(e) => clampTrimStart(Number(e.target.value))}
                            aria-label="Trim start in seconds"
                            className="mt-1 w-full accent-[#7C3AED]"
                          />
                        </label>
                        <label className="block">
                          <span className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                            <span>End</span>
                            <span className="text-white tabular-nums">
                              {formatDuration(effectiveEnd)}
                            </span>
                          </span>
                          <input
                            type="range"
                            min={duration ? trimStart + 0.1 : 0}
                            max={duration ?? 0}
                            step={0.1}
                            value={effectiveEnd}
                            disabled={!duration}
                            onChange={(e) => clampTrimEnd(Number(e.target.value))}
                            aria-label="Trim end in seconds"
                            className="mt-1 w-full accent-[#7C3AED]"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="text-xs text-[var(--color-text-muted)]">
                              Start (seconds)
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={duration ?? 0}
                              step={0.1}
                              value={Number(trimStart.toFixed(1))}
                              disabled={!duration}
                              onChange={(e) => clampTrimStart(Number(e.target.value))}
                              className="mt-1 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-[var(--color-text-muted)]">
                              End (seconds)
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={duration ?? 0}
                              step={0.1}
                              value={Number(effectiveEnd.toFixed(1))}
                              disabled={!duration}
                              onChange={(e) => clampTrimEnd(Number(e.target.value))}
                              className="mt-1 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                            />
                          </label>
                        </div>
                        <p className="text-sm text-white">
                          Trimmed length: {trimmedLength.toFixed(1)}s
                        </p>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          Save Draft keeps this trim in the browser. Cutting
                          and exporting the trimmed video itself is not built
                          yet — Export downloads the project’s generated
                          clips as a ZIP instead.
                        </p>
                      </div>
                    </div>
                  </div>
                ))}

              {tab === 'transcript' && (
                <div>
                  <h2 className="text-lg font-semibold text-white">Transcript</h2>
                  {projectClips.length === 0 ? (
                    <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                      No transcript yet — the worker transcribes during a job
                      run, and the transcribed lines are kept with each
                      generated clip. Create a job for this project first.
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                        The transcribed lines burned into this project’s
                        generated clips. A full transcript of the source is
                        not stored — the worker transcribes during a job run.
                      </p>
                      <ul className="mt-4 space-y-3">
                        {projectClips
                          .filter((c) => c.transcript_excerpt)
                          .map((c) => (
                            <li
                              key={c.id}
                              className="rounded-xl border border-ink-border bg-ink-panel2 p-3"
                            >
                              <p className="text-xs font-semibold text-brand-light">
                                {c.title}
                              </p>
                              <p className="mt-1 text-sm leading-relaxed text-white">
                                {c.transcript_excerpt}
                              </p>
                            </li>
                          ))}
                      </ul>
                      {projectClips.every((c) => !c.transcript_excerpt) ? (
                        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
                          These clips have no transcribed lines stored.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              )}

              {tab === 'clips' && (
                <div>
                  <h2 className="text-lg font-semibold text-white">Clips</h2>
                  {projectClips.length === 0 ? (
                    <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                      No clips yet — generate them with a job in the AI
                      Clipper. Clips appear here once the worker finishes.
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                        {projectClips.length} generated clip
                        {projectClips.length === 1 ? '' : 's'} for this project.
                      </p>
                      <ul className="mt-4 space-y-3">
                        {projectClips.map((clip) => (
                          <li
                            key={clip.id}
                            className="flex items-center gap-3 rounded-xl border border-ink-border bg-ink-panel2 p-3"
                          >
                            <span className="relative block h-14 w-14 shrink-0 overflow-hidden rounded-lg">
                              <ClipThumbnail
                                clipId={clip.id}
                                hasThumbnail={clip.thumbnail_path !== null}
                                alt={`${clip.title} — first frame`}
                                className="h-full w-full object-cover"
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-white">
                                {clip.title}
                              </span>
                              <span className="block text-xs text-[var(--color-text-muted)]">
                                {clip.duration_seconds !== null
                                  ? formatDuration(clip.duration_seconds)
                                  : 'Duration unknown'}
                                {clip.file_size_bytes
                                  ? ` · ${formatBytes(clip.file_size_bytes)}`
                                  : ''}
                                {clip.score !== null
                                  ? ` · viral ${Math.round(clip.score * 100)}`
                                  : ''}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void downloadProjectClip(clip)}
                              disabled={downloadingClipId === clip.id}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-wait disabled:opacity-60"
                            >
                              <Download className="h-4 w-4" />
                              {downloadingClipId === clip.id ? 'Downloading…' : 'Download'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              {tab === 'captions' && (
                <div>
                  <h2 className="text-lg font-semibold text-white">Captions</h2>
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    Caption styles are designed in Captions Studio and burned
                    onto new jobs by the worker. Re-rendering a finished clip
                    with a new style is not built yet.
                  </p>
                  <Link
                    to={`/captions?project=${project.id}`}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
                  >
                    Open Captions Studio
                  </Link>
                </div>
              )}

              {tab === 'text' && (
                <div>
                  <h2 className="text-lg font-semibold text-white">Text</h2>
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    Text overlays use the same caption styles. Open Captions
                    Studio to design them; overlaying text on a finished
                    clip is not built yet.
                  </p>
                  <Link
                    to={`/captions?project=${project.id}`}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
                  >
                    Open Captions Studio
                  </Link>
                </div>
              )}

              {tab === 'brand-kit' && (
                <div>
                  <h2 className="text-lg font-semibold text-white">Brand Kit</h2>
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    Your colours, logo and fonts live in the Brand Kit.
                    Applying them to a finished clip is not built yet.
                  </p>
                  <Link
                    to="/brand-kit"
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white"
                  >
                    Open Brand Kit
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Caption Style rail — design-reference right panel. The top
              block shows the default style new jobs actually burn in;
              the tiles are real preset previews; picking one opens
              Captions Studio. */}
          <div className="lg:col-span-1">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-4">
              <h3 className="text-sm font-semibold text-white">Caption Style</h3>
              <div className="mt-3 rounded-xl border border-ink-border bg-ink-panel2 p-3">
                <p className="text-xs text-[var(--color-text-muted)]">
                  Default for new jobs
                </p>
                <p className="mt-1 text-sm font-semibold text-white">
                  {defaultStyle.name}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                  {defaultStyle.description}
                </p>
                <p className="mt-2 text-xs italic text-[var(--color-text-muted)]">
                  “{defaultStyle.sample}”
                </p>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {CAPTION_PRESETS.slice(0, 6).map((preset) => (
                  <Link
                    key={preset.id}
                    to={`/captions?project=${project.id}`}
                    title={`Open ${preset.label} in Captions Studio`}
                    className="flex h-16 items-center justify-center rounded-xl border border-ink-border bg-ink-panel2 px-2 text-center transition-colors hover:border-brand/60"
                  >
                    <span className={`text-sm leading-tight ${preset.className}`}>
                      {preset.sample}
                    </span>
                  </Link>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Styles are designed in Captions Studio — the default above
                is what the worker burns onto new jobs.
              </p>
              <Link
                to={`/captions?project=${project.id}`}
                className="mt-3 block rounded-xl bg-brand px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-light"
              >
                Open Captions Studio
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
