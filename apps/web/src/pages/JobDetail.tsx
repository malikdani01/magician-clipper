import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Film,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { ClipThumbnail } from '../components/ClipThumbnail'
import { JobStatusPill, jobSummary } from '../components/JobStatusPill'
import { PageHeader } from '../components/PageHeader'
import { CAPTION_STYLES, getCaptionStyle } from '../lib/captionStyles'
import { formatBytes, formatDuration } from '../lib/format'
import { VIRAL_TONE_CLASS, viralScore } from '../lib/viralScore'
import {
  cancelJob,
  downloadClip,
  getClipRerenders,
  getJob,
  requestClipRerender,
  retryJob,
  type ClipRerender,
  type Job,
  type JobClip,
} from '../lib/jobs'
import { useAuth } from '../state/auth'

const POLL_MS = 5000

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function settingRows(job: Job): Array<[string, string]> {
  const s = job.settings
  if (!s) return []
  const duration =
    s.duration_mode === 'exact'
      ? `Exact ${s.duration_seconds}s`
      : s.duration_min_seconds != null && s.duration_max_seconds != null
        ? `${s.duration_mode === 'minimum' ? 'Min' : 'Max'} ${s.duration_seconds}s (range ${s.duration_min_seconds}–${s.duration_max_seconds}s)`
        : `${s.duration_mode} ${s.duration_seconds}s`
  const language =
    s.captions_language === 'roman_urdu'
      ? 'Roman Urdu'
      : s.captions_language === 'english'
        ? 'English'
        : s.captions_language === 'hindi'
          ? 'Hindi'
          : 'Auto-detect'
  const rows: Array<[string, string]> = [
    ['Platform', s.platform === 'tiktok' ? 'TikTok' : 'Instagram'],
    ['Aspect ratio', s.aspect_ratio],
    ['Clips requested', String(s.clip_count)],
    ['Duration', duration],
    ['Captions', s.captions_enabled ? `On (${language})` : 'Off'],
    ['Caption style', getCaptionStyle(s.caption_style).name],
    ['On-screen text', s.on_screen_text ? 'On' : 'Off'],
    ['Job type', s.job_type === 'campaign' ? 'For a campaign' : 'For myself'],
    [
      'Layout',
      s.layout === 'split' ? 'Split (streamer top / gameplay bottom)' : 'Centre crop',
    ],
    ['Content type', s.content_type],
    ['Quality', s.quality === 'draft' ? 'Draft preview' : s.quality === 'high' ? 'High quality' : 'Standard'],
  ]
  if (s.job_type === 'campaign' && s.campaign_requirements) {
    rows.push(['Campaign requirements', s.campaign_requirements])
  }
  if (s.notes) {
    rows.push(['Notes for Muse', s.notes])
  }
  return rows
}

/**
 * Re-render control for one clip: pick a different caption style and
 * queue a re-render. The worker re-renders the SAME window and replaces
 * the file in place; this polls the re-render status while it is
 * queued/processing and refreshes the job when it lands, so the new
 * style and file show without a manual reload.
 */
function ClipRerenderControl({
  clip,
  onRerendered,
}: {
  clip: JobClip
  onRerendered: () => void
}) {
  const otherStyles = CAPTION_STYLES.filter((s) => s.id !== (clip.caption_style ?? ''))
  const [style, setStyle] = useState<string>(otherStyles[0]?.id ?? 'punchy')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<ClipRerender | null>(null)
  const prevStatusRef = useRef<string | null>(null)

  // Keep the picker on a valid style when the clip changes (new file landed).
  useEffect(() => {
    const next = CAPTION_STYLES.filter((s) => s.id !== (clip.caption_style ?? ''))[0]?.id
    if (next) setStyle(next)
  }, [clip.caption_style])

  const refresh = useCallback(async () => {
    const list = await getClipRerenders(clip.id)
    const first = list[0] ?? null
    const prev = prevStatusRef.current
    setLatest(first)
    prevStatusRef.current = first?.status ?? null
    // A re-render that just finished changes the clip file + style.
    if (
      first &&
      (first.status === 'ready' || first.status === 'failed') &&
      (prev === 'queued' || prev === 'processing')
    ) {
      onRerendered()
    }
  }, [clip.id, onRerendered])

  useEffect(() => {
    void refresh()
    if (!latest || latest.status === 'queued' || latest.status === 'processing') {
      const timer = setInterval(() => void refresh(), 5000)
      return () => clearInterval(timer)
    }
    return undefined
  }, [refresh, latest?.status])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const result = await requestClipRerender(clip.id, style)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    prevStatusRef.current = null
    setLatest(result.rerender)
  }

  const inFlight = latest?.status === 'queued' || latest?.status === 'processing'

  return (
    <div className="mt-3 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-white">
          Captions: {getCaptionStyle(clip.caption_style).name}
        </span>
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          disabled={submitting || inFlight}
          aria-label="Caption style for re-render"
          className="rounded-lg border border-ink-border bg-ink-panel2 px-2 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {otherStyles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || inFlight}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {inFlight ? 'Re-rendering…' : 'Re-render with this style'}
        </button>
      </div>
      {latest ? (
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          {latest.status === 'ready'
            ? `Re-rendered with ${getCaptionStyle(latest.caption_style).name} — the file above is the new version.`
            : latest.status === 'failed'
              ? `Re-render failed${latest.error_message ? `: ${latest.error_message}` : '.'}`
              : `Re-render ${latest.status} with ${getCaptionStyle(latest.caption_style).name}…`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}
export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const jobId = Number(id)
  const { user } = useAuth()
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [acting, setActing] = useState<'cancel' | 'retry' | null>(null)
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const fetchJob = useCallback(async () => {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      setError('That job id is not valid.')
      setLoading(false)
      return
    }
    const reqId = ++requestRef.current
    const result = await getJob(jobId)
    if (reqId !== requestRef.current) return // stale response
    if (!result.ok) {
      setError(result.error)
    } else {
      setJob(result.job)
      setError(null)
    }
    setLoading(false)
  }, [jobId])

  useEffect(() => {
    requestRef.current += 1
    setJob(null)
    setError(null)
    setLoading(true)
    void fetchJob()
  }, [fetchJob])

  // Poll every 5s while the job is still running; stop on terminal states.
  useEffect(() => {
    if (!job) return
    if (job.status !== 'queued' && job.status !== 'processing') return
    const timer = setInterval(() => void fetchJob(), POLL_MS)
    return () => clearInterval(timer)
  }, [job?.status, fetchJob])

  const doCancel = async () => {
    if (!job) return
    if (!window.confirm(`Cancel job #${job.id}? The worker stops and any unfinished clips are discarded.`)) return
    setActing('cancel')
    setActionError(null)
    const result = await cancelJob(job.id)
    setActing(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setJob(result.job)
  }

  const doRetry = async () => {
    if (!job) return
    setActing('retry')
    setActionError(null)
    const result = await retryJob(job.id)
    setActing(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setJob(result.job)
  }

  const doDownload = async (clip: JobClip) => {
    setDownloadingId(clip.id)
    setDownloadError(null)
    const result = await downloadClip(clip)
    setDownloadingId(null)
    if (!result.ok) setDownloadError(result.error)
  }

  if (!user) {
    return (
      <div>
        <PageHeader title="Job" subtitle="Job detail." />
        <EmptyState
          title="Sign in to view this job"
          description="Jobs are tied to your account. Sign in to see this job and its clips."
          action={
            <Link
              to="/login"
              className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
            >
              Sign in
            </Link>
          }
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Job" subtitle="Loading…" />
        <div className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-6 text-sm text-white">
          <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
          Loading job #{Number.isInteger(jobId) ? jobId : id}…
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div>
        <PageHeader title="Job not found" subtitle="This job could not be loaded." />
        <EmptyState
          title="Job not found"
          description={error ?? 'This job does not exist or belongs to another account.'}
          action={
            <Link
              to="/jobs"
              className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
            >
              Back to My Jobs
            </Link>
          }
        />
      </div>
    )
  }

  const isActive = job.status === 'queued' || job.status === 'processing'
  const isTerminal = job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled'
  const hasProgress = typeof job.progress === 'number'

  return (
    <div>
      <PageHeader
        title={`Job #${job.id}`}
        subtitle={jobSummary(job)}
        actions={
          <Link
            to="/jobs"
            className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
          >
            <ArrowLeft className="h-4 w-4" /> All jobs
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Status */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <JobStatusPill status={job.status} />
                {isActive ? (
                  <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin text-brand-light" />
                    Updating every 5s
                  </span>
                ) : null}
              </div>
              <div className="flex gap-2">
                {!isTerminal ? (
                  <button
                    type="button"
                    onClick={() => void doCancel()}
                    disabled={acting !== null}
                    className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acting === 'cancel' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                    Cancel job
                  </button>
                ) : null}
                {job.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => void doRetry()}
                    disabled={acting !== null}
                    className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acting === 'retry' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Retry job
                  </button>
                ) : null}
              </div>
            </div>

            {job.stage ? (
              <p className="mt-4 text-sm text-white">
                Stage: <span className="font-semibold">{job.stage}</span>
              </p>
            ) : null}
            {hasProgress ? (
              <div className="mt-3">
                <div
                  className="h-2 overflow-hidden rounded-full bg-ink-panel2"
                  role="progressbar"
                  aria-valuenow={job.progress ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, job.progress ?? 0))}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {job.progress}% — reported by the worker, not estimated.
                </p>
              </div>
            ) : isActive ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                The worker has not reported a measurable percentage for this
                stage yet — showing the stage only, no estimated progress.
              </p>
            ) : null}

            {job.status === 'failed' ? (
              <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
                  <AlertTriangle className="h-4 w-4" /> This job failed
                </p>
                {job.error_code ? (
                  <p className="mt-2 text-xs text-red-200/70">Error code: {job.error_code}</p>
                ) : null}
                <p className="mt-1 break-words text-sm text-red-200/90">
                  {job.error_message ?? 'No failure reason was reported.'}
                </p>
                <p className="mt-2 text-xs text-red-200/70">
                  Your source and settings are preserved — retry re-queues the
                  same job.
                </p>
              </div>
            ) : null}

            {job.status === 'cancelled' ? (
              <p className="mt-4 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3 text-sm text-[var(--color-text-muted)]">
                This job was cancelled. Create a new job to try again with the
                same settings.
              </p>
            ) : null}

            {job.note ? (
              <div
                role="note"
                className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                  <AlertTriangle className="h-4 w-4" /> A note from the worker
                </p>
                <p className="mt-1 text-sm text-amber-200/90">{job.note}</p>
              </div>
            ) : null}

            {actionError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {actionError}
              </p>
            ) : null}

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Created', formatTime(job.created_at)],
                ['Started', formatTime(job.started_at)],
                ['Finished', formatTime(job.finished_at)],
                ['Clips', `${job.clips.length} of ${job.settings?.clip_count ?? '?'}`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-ink-panel2 p-3">
                  <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-medium text-white">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Clips — best viral score first so the strongest clip is on top */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Film className="h-5 w-5 text-brand-light" />
              Clips ({job.clips.length})
            </h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Viral score is an estimate from each clip&apos;s speech, gameplay, energy and scene
              signals — not a guarantee it will go viral.
            </p>
            {job.settings?.clip_count != null &&
            job.clips.length > 0 &&
            job.clips.length < job.settings.clip_count ? (
              <p className="mt-2 text-xs text-amber-300">
                Only {job.clips.length} of {job.settings.clip_count} requested clips fit this
                source — the rest had no usable speech or would overlap a clip already picked.
                Shorter clips or a longer, talk-heavy source fits more.
              </p>
            ) : null}
            {job.clips.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                {job.status === 'ready'
                  ? 'The job is marked ready but no clips were returned. Check again in a moment — if it stays empty, the worker may have finished without uploading clips.'
                  : isActive
                    ? 'No clips yet — they appear here as the worker renders and validates them.'
                    : 'No clips were produced for this job.'}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {[...job.clips]
                  .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
                  .map((clip) => {
                    const viral = viralScore(clip.score)
                    return (
                  <li
                    key={clip.id}
                    className="flex flex-wrap items-center gap-4 rounded-xl bg-ink-panel2 p-4"
                  >
                    <ClipThumbnail
                      clipId={clip.id}
                      hasThumbnail={clip.thumbnail_path != null}
                      alt={`First frame of ${clip.title}`}
                      className="h-24 w-14 shrink-0 rounded-xl object-cover"
                    />
                    <div
                      className={`flex shrink-0 flex-col items-center rounded-xl border px-3 py-2 ${VIRAL_TONE_CLASS[viral.tone]}`}
                      title="Viral score — estimate from speech, gameplay, energy and scene signals"
                    >
                      <span className="text-xl font-bold leading-none">
                        {viral.value ?? '—'}
                      </span>
                      <span className="mt-1 max-w-24 text-center text-[10px] leading-tight">
                        {viral.value != null ? 'Viral score' : viral.label}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-white">{clip.title}</p>
                      {viral.value != null ? (
                        <p className="mt-0.5 text-xs font-medium text-[var(--color-text-muted)]">
                          {viral.label}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                        {clip.duration_seconds != null
                          ? `${formatDuration(clip.duration_seconds)} · `
                          : ''}
                        {clip.file_size_bytes != null ? formatBytes(clip.file_size_bytes) : 'Size unknown'}
                        {clip.start_seconds != null && clip.end_seconds != null
                          ? ` · ${formatDuration(clip.start_seconds)}–${formatDuration(clip.end_seconds)} in source`
                          : ''}
                      </p>
                      {clip.reason ? (
                        <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">{clip.reason}</p>
                      ) : null}
                      {clip.transcript_excerpt ? (
                        <p className="mt-1 line-clamp-2 text-xs italic text-[var(--color-text-muted)]">
                          “{clip.transcript_excerpt}”
                        </p>
                      ) : null}
                    </div>
                    <ClipRerenderControl
                      clip={clip}
                      onRerendered={() => void fetchJob()}
                    />
                    <button
                      type="button"
                      onClick={() => void doDownload(clip)}
                      disabled={downloadingId === clip.id}
                      className="flex shrink-0 items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {downloadingId === clip.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {downloadingId === clip.id ? 'Downloading…' : 'Download'}
                    </button>
                  </li>
                    )
                  })}
              </ul>
            )}
            {downloadError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                Download failed: {downloadError}
              </p>
            ) : null}
          </section>
        </div>

        {/* Right rail — source + exact settings */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Source</h2>
            {job.source_type === 'link' && job.source_url ? (
              <a
                href={job.source_url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block break-all text-sm text-brand-light hover:underline"
              >
                {job.source_url}
              </a>
            ) : (
              <p className="mt-3 text-sm text-white">Uploaded video file</p>
            )}
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Project #{job.project_id} · Job #{job.id} · internal state “{job.state}”
            </p>
          </div>

          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Settings used</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {settingRows(job).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="break-words text-right font-medium text-white">{value}</dd>
                </div>
              ))}
            </dl>
            {settingRows(job).length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                The server did not return settings for this job.
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}
