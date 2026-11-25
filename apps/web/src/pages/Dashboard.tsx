import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Captions,
  Clapperboard,
  Download,
  Folder,
  HardDrive,
  Instagram,
  Music2,
  Play,
  RefreshCw,
  Sparkles,
  Video,
  Wand2,
  Youtube,
} from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { StatCard } from '../components/StatCard'
import { formatBytes } from '../lib/format'
import { formatDuration } from '../lib/format'
import { API_URL, engineHealth, getToken, laravelHealth, type EngineHealth, type LaravelHealth } from '../lib/api'
import { listJobs, type Job, type JobClip } from '../lib/jobs'
import { fetchSettingsInsights, type SettingsInsights } from '../lib/insights'
import { getCaptionStyle } from '../lib/captionStyles'
import { LAYOUT_LABELS } from '../lib/jobs'
import { viralScore } from '../lib/viralScore'
import { useAuth } from '../state/auth'
import { useProjects } from '../state/projects'

interface UserStats {
  jobs_total: number
  jobs_processing: number
  clips_total: number
  clips_ready: number
  storage_bytes: number
  /** ffmpeg/ffprobe versions as last reported by the worker. */
  engine?: { ffmpeg: string | null; ffprobe: string | null; reported_at: string | null }
}

/** Magician's hat — original SVG art for the hero visual. */
function MagicHat() {
  return (
    <svg viewBox="0 0 220 190" className="relative h-44 w-52" role="img" aria-label="Magician hat">
      <defs>
        <linearGradient id="hatBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#4C1D95" />
        </linearGradient>
        <linearGradient id="hatBand" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      {/* crown */}
      <path d="M72 26 L148 26 L160 116 L60 116 Z" fill="url(#hatBody)" />
      {/* band */}
      <path d="M63 88 L157 88 L160 116 L60 116 Z" fill="url(#hatBand)" />
      {/* brim */}
      <ellipse cx="110" cy="126" rx="88" ry="17" fill="url(#hatBody)" />
      <ellipse cx="110" cy="122" rx="88" ry="14" fill="#6D28D9" opacity="0.55" />
      {/* play button on the crown */}
      <path d="M102 58 L130 76 L102 94 Z" fill="#FFFFFF" />
      {/* sparkles */}
      <path d="M38 34 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5 Z" fill="#FDE68A" />
      <path d="M188 52 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 Z" fill="#FFFFFF" />
      <path d="M176 108 l1.8 4.4 4.4 1.8 -4.4 1.8 -1.8 4.4 -1.8 -4.4 -4.4 -1.8 4.4 -1.8 Z" fill="#FDE68A" />
      <path d="M46 108 l1.8 4.4 4.4 1.8 -4.4 1.8 -1.8 4.4 -1.8 -4.4 -4.4 -1.8 4.4 -1.8 Z" fill="#FFFFFF" />
    </svg>
  )
}

/**
 * Dashboard — Phase 2.
 * All stats come from the real project store and live service checks.
 * Total Clips is an honest 0: no clips exist yet (clips are Phase 3).
 * The hero follows the design reference (welcome line, big headline,
 * Create New Project, decorative magic visual with platform chips) —
 * built from original CSS/SVG only, no copied assets.
 */
export function DashboardPage() {
  const { projects, loading } = useProjects()
  const { user } = useAuth()
  const [engine, setEngine] = useState<EngineHealth | null>(null)
  const [backend, setBackend] = useState<LaravelHealth | null>(null)
  const [stats, setStats] = useState<UserStats | null>(null)
  // Top clips + recent activity — frontend-only, from real job data.
  const [recentJobs, setRecentJobs] = useState<Job[]>([])
  // Batch 4: "What works best" — real aggregation of the user's own
  // Ready jobs (only values with ≥3 jobs qualify).
  const [insights, setInsights] = useState<SettingsInsights | null>(null)

  useEffect(() => {
    let cancelled = false
    engineHealth().then((h) => {
      if (!cancelled) setEngine(h)
    })
    laravelHealth().then((h) => {
      if (!cancelled) setBackend(h)
    })
    listJobs({ status: 'all', perPage: 20 }).then(({ jobs }) => {
      if (!cancelled) setRecentJobs(jobs)
    })
    fetchSettingsInsights().then((rows) => {
      if (!cancelled) setInsights(rows)
    })
    const token = getToken()
    if (token) {
      fetch(`${API_URL}/me/stats`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!cancelled && body) setStats(body as UserStats)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [])

  const totalProjects = projects.length
  // Real job/clip counts from the server (not the browser project store).
  const totalClips = stats?.clips_total ?? 0
  const processing = stats?.jobs_processing ?? projects.filter((p) => p.status === 'processing').length
  // Real on-disk usage (uploaded sources + rendered clips); falls back
  // to the browser project store's sum while stats are loading.
  const storageBytes = stats?.storage_bytes ?? projects.reduce((sum, p) => sum + (p.fileSize || 0), 0)
  const recent = [...projects]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5)
  // Top 5 clips by viral score across recent ready jobs.
  const topClips = recentJobs
    .flatMap((j) =>
      j.clips.map((c) => ({ ...c, jobId: j.id }) as JobClip & { jobId: number }),
    )
    .filter((c) => c.score !== null)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 5)
  // Recent activity: the newest jobs with their real status + clip count.
  const activity = [...recentJobs]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5)
  const firstName = user?.name?.trim().split(/\s+/)[0]

  return (
    <div>
      {/* Hero — design-reference welcome banner. */}
      <section className="aurora-card relative overflow-hidden rounded-2xl border border-ink-border bg-ink-panel p-6 shadow-card backdrop-blur-xl sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 55% 80% at 78% 20%, rgba(124,58,237,0.35) 0%, transparent 60%), radial-gradient(ellipse 40% 60% at 15% 90%, rgba(139,92,246,0.18) 0%, transparent 60%)',
          }}
        />
        <div className="relative grid grid-cols-1 items-center gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <p className="text-sm font-medium text-brand-light">
              Welcome back{firstName ? `, ${firstName}` : ''}! 👋
            </p>
            <h1 className="mt-2 text-3xl font-bold leading-tight text-white sm:text-4xl">
              Turn Long Videos Into Amazing Short Clips with{' '}
              <span className="aurora-text">Magician Clipper</span>
            </h1>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-[var(--color-text-muted)] sm:text-base">
              AI-powered clipping studio with smart editing, animated captions
              and more.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                to="/clipper"
                className="btn-aurora flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white"
              >
                <Wand2 className="h-4 w-4" />
                Create New Project
              </Link>
              <Link
                to="/help"
                title="No demo video has been recorded yet — the help guides walk through the workflow instead"
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-ink-border"
              >
                <Play className="h-4 w-4" />
                Watch Demo
              </Link>
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              No demo video recorded yet — the guides in Help &amp; Support walk
              through the workflow.
            </p>
          </div>

          {/* Decorative magic visual — original CSS/SVG art only. */}
          <div
            aria-hidden="true"
            className="animate-float-soft relative mx-auto hidden h-56 w-full max-w-sm items-center justify-center sm:flex lg:col-span-2"
          >
            <div className="absolute h-44 w-44 rounded-full bg-brand/25 blur-2xl" />
            <div className="absolute h-32 w-32 rounded-full bg-gradient-to-br from-brand-light/40 to-brand-dark/40 blur-md" />
            <MagicHat />
            <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-semibold text-white shadow-card">
              <Music2 className="h-3.5 w-3.5 text-brand-light" /> TikTok
            </span>
            <span className="absolute right-0 top-10 flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-semibold text-white shadow-card">
              <Youtube className="h-3.5 w-3.5 text-red-400" /> YouTube
            </span>
            <span className="absolute bottom-4 right-6 flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-semibold text-white shadow-card">
              <Instagram className="h-3.5 w-3.5 text-pink-400" /> Instagram
            </span>
            <span className="absolute bottom-10 left-6 flex items-center gap-1.5 rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-semibold text-white shadow-card">
              <Sparkles className="h-3.5 w-3.5 text-yellow-300" /> AI Clips
            </span>
          </div>
        </div>
      </section>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Projects"
          value={String(totalProjects)}
          sublabel={loading ? 'Loading…' : totalProjects === 0 ? 'No projects yet' : `${totalProjects} project${totalProjects === 1 ? '' : 's'}`}
          icon={<Folder className="h-5 w-5" />}
          accent="#7C3AED"
        />
        <StatCard
          label="Total Clips"
          value={String(totalClips)}
          sublabel={
            stats === null
              ? 'Loading…'
              : totalClips === 0
                ? 'No clips generated yet'
                : `${stats.clips_ready} ready to download`
          }
          icon={<Clapperboard className="h-5 w-5" />}
          accent="#8B5CF6"
        />
        <StatCard
          label="Processing"
          value={String(processing)}
          sublabel={processing === 0 ? 'Nothing in the queue' : `${processing} project${processing === 1 ? '' : 's'} processing`}
          icon={<RefreshCw className="h-5 w-5" />}
          accent="#7C3AED"
        />
        <StatCard
          label="Storage Used"
          value={formatBytes(storageBytes)}
          sublabel={storageBytes === 0 ? 'Nothing uploaded yet' : 'Sources + rendered clips on disk'}
          icon={<HardDrive className="h-5 w-5" />}
          accent="#8B5CF6"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Recent projects</h2>
            <Link to="/projects" className="text-sm font-medium text-brand-light hover:underline">
              View All →
            </Link>
          </div>
          <div className="mt-4">
            {loading ? (
              <p className="text-sm text-[var(--color-text-muted)]">Loading projects…</p>
            ) : recent.length === 0 ? (
              <EmptyState
                title="No projects yet"
                description="Your projects will show up here once you create one. Start by importing a long video in the AI Clipper."
                action={
                  <Link
                    to="/clipper"
                    className="inline-flex items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
                  >
                    <Wand2 className="h-4 w-4" />
                    Open AI Clipper
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-ink-border">
                {recent.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/editor?project=${encodeURIComponent(p.id)}`}
                      className="flex items-center justify-between gap-3 py-3 transition-colors hover:opacity-80"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-white">
                          {p.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
                          {p.durationSeconds !== null
                            ? formatDuration(p.durationSeconds)
                            : 'Duration unknown'}
                          {p.fileName ? ` · ${p.fileName}` : ' · Source file not in this browser'}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-ink-panel2 px-2.5 py-1 text-xs font-medium capitalize text-[var(--color-text-muted)]">
                        {p.status}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="text-lg font-semibold text-white">Getting started</h2>
          <ol className="mt-4 space-y-4 text-sm">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">1</span>
              <span className="text-[var(--color-text-muted)]">
                <Link to="/clipper" className="font-medium text-white hover:underline">
                  Import a long video
                </Link>{' '}
                — the video engine reads it with ffprobe and shows its real
                duration, size and resolution.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">2</span>
              <span className="text-[var(--color-text-muted)]">
                Pick a style and let the AI find the best moments — the
                worker transcribes your video and picks the interesting parts.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">3</span>
              <span className="text-[var(--color-text-muted)]">
                Review your clips with their viral scores, then download them
                from the job page — captions are already burned in.
              </span>
            </li>
          </ol>
          <p className="mt-5 rounded-xl bg-ink-panel2 p-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Jobs run through the Muse-connected worker: submit a video or a
            link with your settings, and the finished clips come back to the
            same job with Download buttons.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Recent exports</h2>
            <Link to="/exports" className="text-sm font-medium text-brand-light hover:underline">
              View All →
            </Link>
          </div>
          <div className="mt-4">
            <EmptyState
              title="No exports yet"
              description="Finished clips you export will be listed here with a download link. Nothing has been exported yet — export a finished clip from its job page."
              icon={<Download className="h-7 w-7" />}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="text-lg font-semibold text-white">Quick actions</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {[
              { to: '/clipper', label: 'AI Clipper', icon: <Wand2 className="h-5 w-5" /> },
              { to: '/projects', label: 'My Projects', icon: <Folder className="h-5 w-5" /> },
              { to: '/library', label: 'Video Library', icon: <Video className="h-5 w-5" /> },
              { to: '/captions', label: 'Captions Studio', icon: <Captions className="h-5 w-5" /> },
            ].map((a) => (
              <Link
                key={a.to}
                to={a.to}
                className="aurora-card flex flex-col items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-4 text-center text-sm font-medium text-white"
              >
                <span className="text-brand-light">{a.icon}</span>
                {a.label}
              </Link>
            ))}
          </div>
          <div className="mt-4 rounded-xl bg-ink-panel2 p-4">
            <h3 className="text-sm font-semibold text-white">Services</h3>
            <p className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
              <span>
                Video engine —{' '}
                {engine === null
                  ? 'Checking…'
                  : engine.ok
                    ? `Running, ffmpeg ${engine.ffmpeg ?? stats?.engine?.ffmpeg ?? 'version unknown'}`
                    : (engine.error ?? 'Down')}
              </span>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  engine?.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
                }`}
              >
                {engine === null ? 'Checking…' : engine.ok ? 'Up' : 'Down'}
              </span>
            </p>
            <p className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
              <span>
                Backend —{' '}
                {backend === null ? 'Checking…' : backend.ok ? 'Laravel is up' : (backend.error ?? 'Down')}
              </span>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  backend?.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
                }`}
              >
                {backend === null ? 'Checking…' : backend.ok ? 'Up' : 'Down'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Top clips + recent activity — real data from the user's jobs. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Top clips</h2>
            <Link to="/library" className="text-sm font-medium text-brand-light hover:underline">
              View All →
            </Link>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Your highest-scoring clips so far. Viral score is an estimate,
            not a guarantee.
          </p>
          <div className="mt-4">
            {topClips.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No scored clips yet — finish a job and its best clips will
                show up here.
              </p>
            ) : (
              <ul className="divide-y divide-ink-border">
                {topClips.map((clip) => {
                  const viral = viralScore(clip.score)
                  return (
                    <li key={clip.id}>
                      <Link
                        to={`/jobs/${clip.jobId}`}
                        className="flex items-center justify-between gap-3 py-3 transition-colors hover:opacity-80"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-white">
                            {clip.title}
                          </span>
                          <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
                            {clip.duration_seconds !== null
                              ? formatDuration(clip.duration_seconds)
                              : 'Duration unknown'}
                            {` · job #${clip.jobId}`}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-ink-panel2 px-2.5 py-1 text-xs font-bold text-white tabular-nums">
                          {viral.value ?? '—'}
                          {viral.value != null ? ` · ${viral.label}` : ''}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Recent activity</h2>
            <Link to="/jobs" className="text-sm font-medium text-brand-light hover:underline">
              View All →
            </Link>
          </div>
          <div className="mt-4">
            {activity.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No jobs yet — your latest jobs will show up here.
              </p>
            ) : (
              <ul className="divide-y divide-ink-border">
                {activity.map((j) => (
                  <li key={j.id}>
                    <Link
                      to={`/jobs/${j.id}`}
                      className="flex items-center justify-between gap-3 py-3 transition-colors hover:opacity-80"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-white">
                          Job #{j.id}
                        </span>
                        <span className="mt-0.5 block text-xs capitalize text-[var(--color-text-muted)]">
                          {j.status}
                          {j.clips.length > 0
                            ? ` · ${j.clips.length} clip${j.clips.length === 1 ? '' : 's'}`
                            : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                        {new Date(j.created_at).toLocaleDateString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Batch 4: "What works best" — the top caption style, layout and
          duration mode by average viral score across the user's own
          Ready jobs. Only values with at least 3 finished jobs qualify;
          anything less is honestly "not enough data yet". */}
      <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="text-lg font-semibold text-white">What works best</h2>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Average viral score from your own finished jobs — only settings
          used in at least 3 jobs are shown.
        </p>
        {insights === null ? (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : insights.caption_style.length === 0 &&
          insights.layout.length === 0 &&
          insights.duration_mode.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]">
            Not enough finished jobs yet — finish at least 3 jobs with the
            same caption style, layout or duration and the best-performing
            settings will show up here.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              {
                label: 'Caption style',
                rows: insights.caption_style,
                name: (v: string) => getCaptionStyle(v).name,
              },
              {
                label: 'Layout',
                rows: insights.layout,
                name: (v: string) =>
                  LAYOUT_LABELS[v as keyof typeof LAYOUT_LABELS] ?? v,
              },
              {
                label: 'Duration',
                rows: insights.duration_mode,
                name: (v: string) =>
                  v === 'exact' ? 'Exact' : v === 'minimum' ? 'Minimum' : v === 'maximum' ? 'Maximum' : v,
              },
            ].map(({ label, rows, name }) => (
              <div key={label} className="rounded-xl bg-ink-panel2 p-4">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">{label}</p>
                {rows.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                    Not enough data yet — needs 3 finished jobs.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {rows.slice(0, 3).map((r) => (
                      <li key={r.value} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate font-medium text-white">{name(r.value)}</span>
                        <span className="shrink-0 text-[var(--color-text-muted)] tabular-nums">
                          {r.average_score} avg · {r.job_count} jobs
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
