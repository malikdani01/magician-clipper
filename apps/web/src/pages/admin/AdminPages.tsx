import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Clapperboard,
  Coins,
  Cpu,
  CreditCard,
  Eye,
  FileWarning,
  Folder,
  Globe,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Upload,
  Users,
  Wallet,
} from 'lucide-react'
import { API_URL, engineHealth, getToken, laravelHealth } from '../../lib/api'
import { formatBytes } from '../../lib/format'
import { useAuth } from '../../state/auth'
import { AreaChart } from '../../components/charts'
import { EmptyState } from '../../components/EmptyState'
import { NotImplemented } from '../../components/NotImplemented'
import { PageHeader } from '../../components/PageHeader'
import { StatCard } from '../../components/StatCard'

/* ------------------------------------------------------------------ */
/* Types — exact shapes from AdminController (backend/laravel)         */
/* ------------------------------------------------------------------ */

export interface AdminUserRow {
  id: number
  name: string
  email: string
  role: string
  plan: string
  created_at: string
  projects_count?: number
  processing_jobs_count?: number
  /** Batch 10: suspension + per-user limit overrides. */
  suspended_at?: string | null
  daily_limit_override?: number | null
  max_clips_override?: number | null
}

export interface AdminProjectRow {
  id: number
  user_id: number
  title: string
  status: string
  created_at: string
  updated_at: string
  user?: { id: number; name: string; email?: string }
  jobs_total?: number
  jobs_completed?: number
  /** Batch 10: withCount fields from /admin/projects. */
  media_assets_count?: number
  clips_count?: number
  processing_jobs_count?: number
}

export interface AdminClipRow {
  id: number
  job_id: number
  title: string | null
  status: string
  file_size_bytes: number | null
  thumbnail_path?: string | null
  created_at: string
  job?: {
    id: number
    project_id: number
    user_id: number
    user?: { id: number; name: string }
    project?: { id: number; title: string }
  }
}

interface DailyRow {
  date: string
  users: number
  projects: number
  clips: number
  jobs: number
}

interface UsageEntry {
  label: string
  value: number
}

export interface AdminJobRow {
  id: number
  state: string
  stage?: string | null
  progress?: number | null
  error_code?: string | null
  error_message?: string | null
  /** Batch 10: clip count (for the delete warning). */
  clips_count?: number
  created_at: string
  user?: { id: number; name: string; email: string }
  project?: { id: number; title: string }
}

interface DashboardPayload {
  users: { total: number; admins: number; new_last_30_days: number; growth_pct?: number | null }
  projects: { total: number; by_status: Record<string, number>; growth_pct?: number | null }
  clips: { total: number; ready: number; growth_pct?: number | null }
  jobs: { total: number; by_state: Record<string, number>; failed: number; running: number; growth_pct?: number | null }
  storage: { app_bytes: number }
  /** ffmpeg/ffprobe versions as last reported by the worker. */
  engine?: { ffmpeg: string | null; ffprobe: string | null; reported_at: string | null }
  billing: { enabled: boolean; message: string }
  /** Daily created-counts, last 30 days (Analytics chart + sparklines). */
  daily?: DailyRow[]
  /** Real feature usage from job settings (share of all jobs). */
  usage?: { platforms: UsageEntry[]; caption_styles: UsageEntry[] }
  nav_counts?: { processing_jobs: number; failed_jobs: number }
  recent_users: AdminUserRow[]
  recent_projects: AdminProjectRow[]
  recent_jobs?: { id: number; user_id: number; state: string; created_at: string; user?: { id: number; name: string } }[]
  recent_clips?: { id: number; job_id: number; title: string | null; created_at: string }[]
}

export interface Paginated<T> {
  data: T[]
  current_page: number
  last_page: number
  total: number
}

interface HealthPayload {
  app: { name: string; env: string; debug: boolean; php: string; laravel: string }
  database: { connection: string; ok: boolean }
  video_engine: { url: string; ok: boolean; error: string | null }
  disk: { path: string; total_bytes: number | null; free_bytes: number | null }
  queue: { connection: string; note: string }
}

interface EngineHealth {
  ok: boolean
  status: string
  ffmpeg: string | null
  ffprobe: string | null
  error?: string
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** GET an admin endpoint with the admin Bearer token. Throws the backend's exact error message. */
export async function fetchAdmin<T>(path: string): Promise<T> {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const message =
      body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
    throw new Error(message)
  }
  return body as T
}

/**
 * Batch 10: POST/PATCH/DELETE an admin endpoint with the admin Bearer
 * token. Throws the backend's exact error message. Returns the parsed
 * JSON body (or null for an empty body).
 */
export async function mutateAdmin<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const message =
      parsed && typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.status}`
    throw new Error(message)
  }
  return parsed as T
}

export function useAdminFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // Whether a fetch is in flight. retry() must not start a second one:
  // on a cold Render container /admin/dashboard takes ~20s, and the
  // Monitor's 10s re-fetch timer used to bump the nonce mid-flight —
  // the effect cleanup then discarded the in-flight response, so the
  // Jobs card showed "Loading job counts…" forever. A retry fired while
  // a fetch is in flight is a no-op; the next tick retries again.
  const inFlight = useRef(false)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    inFlight.current = true
    setLoading(true)
    setError(null)
    fetchAdmin<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
      .finally(() => {
        inFlight.current = false
      })
    return () => {
      cancelled = true
    }
  }, [path, nonce])

  const retry = useCallback(() => {
    if (!inFlight.current) setNonce((n) => n + 1)
  }, [])
  return { data, loading, error, retry }
}

export function useEngineHealth() {
  const [engine, setEngine] = useState<EngineHealth | null>(null)
  useEffect(() => {
    let cancelled = false
    engineHealth().then((h) => {
      if (!cancelled) setEngine(h)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return engine
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

export function SourceNote({ source }: { source: string }) {
  return (
    <p className="mt-4 text-xs text-[var(--color-text-muted)]">Source: {source}</p>
  )
}

export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-red-500/40 bg-red-500/10 p-5">
      <p className="flex items-center gap-2 text-sm font-medium text-red-300">
        <AlertTriangle className="h-4 w-4" />
        Could not load — {error}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-xl bg-ink-panel2 px-4 py-2 text-sm font-medium text-white hover:bg-ink-border"
      >
        Retry
      </button>
    </div>
  )
}

export function LoadingNote() {
  return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
}

export function AdminTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-border bg-ink-panel">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-ink-border text-[var(--color-text-muted)]">
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="border-b border-ink-border text-white last:border-0">{children}</tr>
}

export function Cell({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <td className={`px-4 py-3 ${muted ? 'text-[var(--color-text-muted)]' : ''}`}>{children}</td>
  )
}

export function Pager({
  page,
  lastPage,
  total,
  onPage,
}: {
  page: number
  lastPage: number
  total: number
  onPage: (p: number) => void
}) {
  return (
    <div className="mt-4 flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-xl border border-ink-border bg-ink-panel px-3 py-1.5 text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span>
        Page {page} of {Math.max(lastPage, 1)} · {total} total
      </span>
      <button
        type="button"
        disabled={page >= lastPage}
        onClick={() => onPage(page + 1)}
        className="rounded-xl border border-ink-border bg-ink-panel px-3 py-1.5 text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  )
}

function BillingNotEnabledPanel() {
  return (
    <div className="mb-5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm font-medium text-amber-300">
        Not enabled — billing does not exist yet.
      </p>
      <p className="mt-1 text-sm text-amber-200/80">
        Payments, subscriptions and plans do not exist yet. No amounts, customers
        or transactions exist to show.
      </p>
    </div>
  )
}

function DisabledAdminFormNote({ detail }: { detail: string }) {
  return (
    <div className="mt-4">
      <NotImplemented phase="Phase 2" detail={detail} />
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        The form below is disabled — it needs a backend settings endpoint, which
        does not exist yet. Nothing here is saved.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dashboard helpers — all charts/bars render REAL data only           */
/* ------------------------------------------------------------------ */

export function relativeTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return d.toLocaleDateString()
}

export function planPill(plan: string): string {
  const p = plan.toLowerCase()
  if (p.includes('pro') && p.includes('year')) return 'bg-blue-500/15 text-blue-300'
  if (p.includes('pro')) return 'bg-brand/20 text-brand-light'
  if (p.includes('business') || p.includes('enterprise')) return 'bg-amber-500/15 text-amber-300'
  return 'bg-ink-panel2 text-[var(--color-text-muted)]'
}

export function statusPill(status: string): string {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'complete' || s === 'ready') return 'bg-emerald-500/15 text-emerald-300'
  if (s === 'processing' || s === 'running') return 'bg-amber-500/15 text-amber-300'
  if (s === 'failed') return 'bg-red-500/15 text-red-300'
  return 'bg-ink-panel2 text-[var(--color-text-muted)]'
}

/** SVG donut from real segment counts. Centre shows the largest segment's share. */
function DonutChart({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  const r = 70
  const c = 2 * Math.PI * r
  let acc = 0
  const dominant =
    segments.length > 0
      ? segments.reduce((a, b) => (b.value > a.value ? b : a), segments[0])
      : null
  const dominantPct = total > 0 && dominant ? Math.round((dominant.value / total) * 100) : 0

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-44 w-44 shrink-0">
        <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90" role="img" aria-label="Jobs by state">
          <circle cx="90" cy="90" r={r} fill="none" stroke="#26264A" strokeWidth="22" />
          {total > 0
            ? segments.map((s) => {
                const len = (s.value / total) * c
                const el = (
                  <circle
                    key={s.label}
                    cx="90"
                    cy="90"
                    r={r}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="22"
                    strokeDasharray={`${Math.max(0, len - 2)} ${c - Math.max(0, len - 2)}`}
                    strokeDashoffset={-acc}
                  />
                )
                acc += len
                return el
              })
            : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-white">
            {total > 0 ? `${dominantPct}%` : '—'}
          </span>
          <span className="max-w-[6rem] truncate text-center text-xs capitalize text-[var(--color-text-muted)]">
            {total > 0 && dominant ? dominant.label : 'No jobs yet'}
          </span>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-2">
        {total === 0 ? (
          <li className="text-sm text-[var(--color-text-muted)]">No jobs yet.</li>
        ) : (
          segments.map((s) => (
            <li key={s.label} className="flex items-center gap-2 text-sm">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
              <span className="flex-1 capitalize text-white">{s.label}</span>
              <span className="text-[var(--color-text-muted)] tabular-nums">
                {s.value} ({Math.round((s.value / total) * 100)}%)
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

/** Horizontal bars from real counts (share of total). */
function ShareBars({ entries, total }: { entries: { label: string; value: number; color: string }[]; total: number }) {
  if (total === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">No jobs yet — bars appear once jobs exist.</p>
  }
  return (
    <ul className="space-y-3">
      {entries.map((e) => (
        <li key={e.label}>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="capitalize text-white">{e.label}</span>
            <span className="text-[var(--color-text-muted)] tabular-nums">
              {e.value} · {Math.round((e.value / total) * 100)}%
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-panel2">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (e.value / total) * 100)}%`, backgroundColor: e.color }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function AdminDashboardPage() {
  const { data, loading, error, retry } = useAdminFetch<DashboardPayload>('/admin/dashboard')
  const engine = useEngineHealth()
  const [chartTab, setChartTab] = useState<'jobs' | 'clips' | 'users' | 'projects'>('jobs')

  const byStatus = data?.projects.by_status ?? {}
  const statusLine =
    Object.keys(byStatus).length === 0
      ? 'No projects yet'
      : Object.entries(byStatus)
          .map(([status, count]) => `${count} ${status}`)
          .join(' · ')
  const byState = data?.jobs.by_state ?? {}

  // Donut segments, grouped the way the design shows them:
  // Processing (any in-flight state), Completed, Failed, Queued.
  const inFlight = Object.entries(byState)
    .filter(([s]) => !['completed', 'failed', 'cancelled', 'queued', 'uploaded'].includes(s))
    .reduce((sum, [, n]) => sum + n, 0)
  const donutSegments = [
    { label: 'Processing', value: inFlight, color: '#8B5CF6' },
    { label: 'Completed', value: byState['completed'] ?? 0, color: '#22C55E' },
    { label: 'Failed', value: byState['failed'] ?? 0, color: '#F59E0B' },
    { label: 'Queued', value: (byState['queued'] ?? 0) + (byState['uploaded'] ?? 0), color: '#94A3B8' },
    { label: 'Cancelled', value: byState['cancelled'] ?? 0, color: '#64748B' },
  ]
  const jobTotal = data?.jobs.total ?? 0

  // Daily series (last 30 days) + 14-day sparklines, all real counts.
  const daily = data?.daily ?? []
  const spark = (key: 'users' | 'projects' | 'clips' | 'jobs') =>
    daily.slice(-14).map((d) => d[key])
  const chartPoints = daily.map((d) => d[chartTab])
  const chartTotal = chartPoints.reduce((a, b) => a + b, 0)
  const chartLabels: [string, string] =
    daily.length > 0
      ? [daily[0].date.slice(5), daily[daily.length - 1].date.slice(5)]
      : ['—', '—']

  // Most-used features, from real job settings (share of all jobs).
  const usageEntries = [
    ...(data?.usage?.platforms ?? []).map((u) => ({
      label: `${u.label} jobs`,
      value: u.value,
      color: '#8B5CF6',
    })),
    ...(data?.usage?.caption_styles ?? []).map((u) => ({
      label: `${u.label} captions`,
      value: u.value,
      color: '#22C55E',
    })),
  ]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)

  const activities = [
    ...(data?.recent_users ?? []).map((u) => ({
      key: `user-${u.id}`,
      text: `New user registered: ${u.name}`,
      time: u.created_at,
      color: '#22C55E',
    })),
    ...(data?.recent_projects ?? []).map((p) => ({
      key: `project-${p.id}`,
      text: `Project created: ${p.title}`,
      time: p.created_at,
      color: '#8B5CF6',
    })),
    ...(data?.recent_jobs ?? [])
      .filter((j) => j.state === 'completed')
      .map((j) => ({
        key: `job-${j.id}`,
        text: `Job completed: #${j.id}${j.user ? ` by ${j.user.name}` : ''}`,
        time: j.created_at,
        color: '#3B82F6',
      })),
    ...(data?.recent_clips ?? []).map((c) => ({
      key: `clip-${c.id}`,
      text: `Clip generated: ${c.title ?? `Clip ${c.id}`}`,
      time: c.created_at,
      color: '#F59E0B',
    })),
  ]
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .slice(0, 5)

  // Project progress from real job counts (completed / total).
  const projectProgress = (p: AdminProjectRow): number | null => {
    if (p.jobs_total === undefined || p.jobs_total === 0) return null
    return Math.round(((p.jobs_completed ?? 0) / p.jobs_total) * 100)
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Welcome back, Admin! Here's what's happening with your platform."
        icon={<Users className="h-5 w-5" />}
        actions={
          <span className="rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)]">
            Last 30 days
          </span>
        }
      />

      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}

      {data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total Users"
              value={String(data.users.total)}
              sublabel={`${data.users.admins} admins · ${data.users.new_last_30_days} new in the last 30 days`}
              icon={<Users className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #4C1D95 0%, #7C3AED 100%)"
              growthPct={data.users.growth_pct}
              spark={spark('users')}
              sparkColor="#FFFFFF"
            />
            <StatCard
              label="Total Projects"
              value={String(data.projects.total)}
              sublabel={statusLine}
              icon={<Folder className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)"
              growthPct={data.projects.growth_pct}
              spark={spark('projects')}
              sparkColor="#FFFFFF"
            />
            <StatCard
              label="Generated Clips"
              value={String(data.clips.total)}
              sublabel={`${data.clips.ready} ready`}
              icon={<Clapperboard className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #065F46 0%, #059669 100%)"
              growthPct={data.clips.growth_pct}
              spark={spark('clips')}
              sparkColor="#FFFFFF"
            />
            <StatCard
              label="Total Revenue"
              value="Not enabled"
              sublabel={data.billing.message}
              icon={<CreditCard className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #92400E 0%, #D97706 100%)"
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Analytics Overview</h2>
                <div className="flex gap-1 rounded-full border border-ink-border bg-ink-panel2 p-1" role="tablist" aria-label="Analytics series">
                  {(['jobs', 'clips', 'users', 'projects'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={chartTab === tab}
                      onClick={() => setChartTab(tab)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                        chartTab === tab ? 'bg-brand text-white' : 'text-[var(--color-text-muted)] hover:text-white'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {chartTotal} {chartTab} in the last 30 days · daily counts from the admin API
              </p>
              <div className="mt-5">
                <AreaChart points={chartPoints} color="#8B5CF6" labels={chartLabels} />
              </div>
            </div>
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Processing Status</h2>
                <Link to="/admin/jobs" className="text-sm font-medium text-brand-light hover:underline">
                  View All →
                </Link>
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {data.jobs.total} jobs total · {data.jobs.running} running ·{' '}
                {data.jobs.failed} failed
              </p>
              <div className="mt-5">
                <DonutChart segments={donutSegments} />
              </div>
              <div className="mt-6 border-t border-ink-border pt-4">
                <h3 className="text-sm font-semibold text-white">Storage &amp; engine</h3>
                <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                  Storage used (sources + clips):{' '}
                  <span className="font-medium text-white">{formatBytes(data.storage.app_bytes)}</span>
                </p>
                <p className="mt-1 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                  <span className={`h-2 w-2 rounded-full ${engine?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  Video engine:{' '}
                  {engine ? (
                    <span className="font-medium text-white">
                      {engine.ok ? `up (${engine.status})` : `down — ${engine.error ?? engine.status}`}
                    </span>
                  ) : (
                    'checking…'
                  )}
                </p>
                {engine ? (
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    FFmpeg: {engine.ffmpeg ?? data.engine?.ffmpeg ?? 'not reported by the engine'} · FFprobe:{' '}
                    {engine.ffprobe ?? data.engine?.ffprobe ?? 'not reported'}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Most used</h2>
                <Link to="/admin/jobs" className="text-sm font-medium text-brand-light hover:underline">
                  View Details →
                </Link>
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Top platforms and caption styles, by job count
              </p>
              <div className="mt-5">
                {usageEntries.length === 0 ? (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    No jobs yet — usage bars appear once jobs exist.
                  </p>
                ) : (
                  <ShareBars entries={usageEntries} total={jobTotal} />
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Recent users</h2>
                <Link to="/admin/users" className="text-sm font-medium text-brand-light hover:underline">
                  View All →
                </Link>
              </div>
              {data.recent_users.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="No users yet"
                    description="No accounts have signed up yet."
                    icon={<Users className="h-7 w-7" />}
                  />
                </div>
              ) : (
                <ul className="mt-4 space-y-3">
                  {data.recent_users.map((u) => (
                    <li key={u.id} className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-xs font-bold text-white">
                        {u.name.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-white">{u.name}</span>
                        <span className="block truncate text-xs text-[var(--color-text-muted)]">{u.email}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${planPill(u.plan)}`}>
                        {u.plan}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--color-text-muted)]">{relativeTime(u.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              <h2 className="text-lg font-semibold text-white">Server Status</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Server CPU/RAM percentages are not measured on the hosted container — the host&rsquo;s numbers do not describe this app.
              </p>
              <p className="mt-5 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <span className={`h-2 w-2 rounded-full ${engine?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {engine === null
                  ? 'Checking video engine…'
                  : engine.ok
                    ? 'Server Healthy'
                    : 'Video engine down'}
                <span className="ml-auto text-xs">Checked just now</span>
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Recent projects</h2>
                <Link to="/admin/projects" className="text-sm font-medium text-brand-light hover:underline">
                  View All →
                </Link>
              </div>
              {data.recent_projects.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="No projects yet"
                    description="No projects have been created yet."
                    icon={<Folder className="h-7 w-7" />}
                  />
                </div>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-ink-border text-[var(--color-text-muted)]">
                        <th className="py-2 pr-3 font-medium">#</th>
                        <th className="py-2 pr-3 font-medium">Video</th>
                        <th className="py-2 pr-3 font-medium">Status</th>
                        <th className="py-2 pr-3 font-medium">Progress</th>
                        <th className="py-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_projects.map((p, i) => (
                        <tr key={p.id} className="border-b border-ink-border last:border-0">
                          <td className="py-3 pr-3 text-[var(--color-text-muted)] tabular-nums">{i + 1}</td>
                          <td className="py-3 pr-3">
                            <span className="block truncate font-medium text-white">{p.title}</span>
                            <span className="block truncate text-xs text-[var(--color-text-muted)]">
                              {p.user?.name ?? `User ${p.user_id}`}
                            </span>
                          </td>
                          <td className="py-3 pr-3">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(p.status)}`}>
                              {p.status}
                            </span>
                          </td>
                          <td className="py-3 pr-3">
                            {(() => {
                              const pct = projectProgress(p)
                              if (pct === null) {
                                return <span className="text-[var(--color-text-muted)]">—</span>
                              }
                              return (
                                <span className="flex items-center gap-2">
                                  <span className="h-2 w-16 overflow-hidden rounded-full bg-ink-panel2">
                                    <span
                                      className="block h-full rounded-full bg-emerald-500"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </span>
                                  <span className="text-xs tabular-nums text-white">{pct}%</span>
                                </span>
                              )
                            })()}
                          </td>
                          <td className="py-3 text-[var(--color-text-muted)]">{relativeTime(p.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
                <h2 className="text-lg font-semibold text-white">Quick actions</h2>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {[
                    { to: '/clipper', label: 'Upload Video', icon: <Upload className="h-5 w-5" />, chip: 'bg-brand/20 text-brand-light' },
                    { to: '/admin/reports', label: 'View Analytics', icon: <BarChart3 className="h-5 w-5" />, chip: 'bg-blue-500/15 text-blue-300' },
                    { to: '/admin/users', label: 'Manage Users', icon: <Users className="h-5 w-5" />, chip: 'bg-emerald-500/15 text-emerald-300' },
                    { to: '/admin/settings', label: 'System Settings', icon: <Settings className="h-5 w-5" />, chip: 'bg-amber-500/15 text-amber-300' },
                  ].map((a) => (
                    <Link
                      key={a.to}
                      to={a.to}
                      className="flex flex-col items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-4 text-center text-sm font-medium text-white transition-colors hover:border-brand/60"
                    >
                      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${a.chip}`}>{a.icon}</span>
                      {a.label}
                    </Link>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
                <h2 className="text-lg font-semibold text-white">Latest activities</h2>
                {activities.length === 0 ? (
                  <p className="mt-4 text-sm text-[var(--color-text-muted)]">
                    No activity yet — signups and new projects will appear here.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-4">
                    {activities.map((a) => (
                      <li key={a.key} className="flex items-start gap-3 text-sm">
                        <span
                          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: a.color }}
                        />
                        <span className="min-w-0 flex-1 text-white">{a.text}</span>
                        <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                          {relativeTime(a.time)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-4 text-xs text-[var(--color-text-muted)]">
                  Built from real signups, projects, jobs and clips — there is
                  no separate activity feed yet.
                </p>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <SourceNote source="Laravel /api/v1/admin/dashboard + video-engine /health" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

function UsersSection({ title, subtitle }: { title: string; subtitle: string }) {
  const [page, setPage] = useState(1)
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminUserRow>>(
    `/admin/users?page=${page}`,
  )
  const query = search.trim().toLowerCase()
  const rows = (data?.data ?? []).filter(
    (u) =>
      query.length === 0 ||
      u.name.toLowerCase().includes(query) ||
      u.email.toLowerCase().includes(query),
  )

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="mb-4 max-w-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this page by name or email…"
          className="w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
        />
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title={query ? 'No users match that search' : 'No users yet'}
          description={
            query
              ? 'No user on this page matches the search. Try a different name or email.'
              : 'No accounts have signed up yet.'
          }
          icon={<Users className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['User', 'Role', 'Plan', 'Projects', 'Jobs', 'Joined']}>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <Cell>
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-xs font-bold text-white">
                      {u.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-white">{u.name}</span>
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">{u.email}</span>
                    </span>
                  </span>
                </Cell>
                <Cell>{u.role}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${planPill(u.plan)}`}>
                    {u.plan}
                  </span>
                </Cell>
                <Cell>{u.projects_count ?? '—'}</Cell>
                <Cell>{u.processing_jobs_count ?? '—'}</Cell>
                <Cell muted>{relativeTime(u.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/users" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function ProjectsSection({ title, subtitle }: { title: string; subtitle: string }) {
  const [page, setPage] = useState(1)
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminProjectRow>>(
    `/admin/projects?page=${page}`,
  )

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && data.data.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="No projects have been created yet."
          icon={<Folder className="h-7 w-7" />}
        />
      ) : null}
      {data && data.data.length > 0 ? (
        <>
          <AdminTable headers={['Title', 'Owner', 'Status', 'Created']}>
            {data.data.map((p) => (
              <TableRow key={p.id}>
                <Cell>{p.title}</Cell>
                <Cell muted>{p.user?.name ?? `User ${p.user_id}`}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(p.status)}`}>
                    {p.status}
                  </span>
                </Cell>
                <Cell muted>{relativeTime(p.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={data.current_page} lastPage={data.last_page} total={data.total} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/projects" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Clips — every rendered clip, with its job and owner                 */
/* ------------------------------------------------------------------ */

function ClipsSection({ title, subtitle }: { title: string; subtitle: string }) {
  const [page, setPage] = useState(1)
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminClipRow>>(
    `/admin/clips?page=${page}`,
  )
  const rows = data?.data ?? []

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title="No clips generated yet"
          description="No clips have been rendered yet. Clips appear here once a job finishes rendering them."
          icon={<Clapperboard className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['ID', 'Title', 'Job', 'Owner', 'Project', 'Status', 'Size', 'Created']}>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <Cell>{c.id}</Cell>
                <Cell>{c.title ?? '—'}</Cell>
                <Cell muted>#{c.job_id}</Cell>
                <Cell muted>{c.job?.user?.name ?? '—'}</Cell>
                <Cell muted>{c.job?.project?.title ?? '—'}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(c.status)}`}>
                    {c.status}
                  </span>
                </Cell>
                <Cell muted>{c.file_size_bytes != null ? formatBytes(c.file_size_bytes) : '—'}</Cell>
                <Cell muted>{formatDate(c.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/clips" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Jobs + Failed Jobs                                                  */
/* ------------------------------------------------------------------ */

function JobsSection({
  title,
  subtitle,
  failedOnly,
}: {
  title: string
  subtitle: string
  failedOnly: boolean
}) {
  const [page, setPage] = useState(1)
  const path = failedOnly
    ? `/admin/jobs?state=failed&page=${page}`
    : `/admin/jobs?page=${page}`
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminJobRow>>(path)
  const rows = (data?.data ?? []).filter((j) => !failedOnly || j.state === 'failed')

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title={failedOnly ? 'No failed jobs' : 'No jobs yet'}
          description={
            failedOnly
              ? 'No jobs have failed. Failed jobs appear here with their error message.'
              : 'No processing jobs have run yet.'
          }
          icon={failedOnly ? <FileWarning className="h-7 w-7" /> : <RefreshCw className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['ID', 'State', 'Stage', 'Progress', 'Project', 'Error', 'Created']}>
            {rows.map((j) => (
              <TableRow key={j.id}>
                <Cell>{j.id}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(j.state)}`}>
                    {j.state}
                  </span>
                </Cell>
                <Cell muted>{j.stage ?? '—'}</Cell>
                <Cell>
                  {typeof j.progress === 'number' ? (
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-20 overflow-hidden rounded-full bg-ink-panel2">
                        <span
                          className="block h-full rounded-full bg-brand"
                          style={{ width: `${Math.min(100, Math.max(0, j.progress))}%` }}
                        />
                      </span>
                      <span className="text-xs tabular-nums">{j.progress}%</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </Cell>
                <Cell muted>{j.project?.title ?? '—'}</Cell>
                <Cell muted>
                  {j.state === 'failed'
                    ? j.error_message ?? j.error_code ?? 'Failed — no error message recorded'
                    : '—'}
                </Cell>
                <Cell muted>{formatDate(j.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/jobs" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Billing / Subscriptions / Credits — do not exist yet                */
/* ------------------------------------------------------------------ */

function BillingSection({
  title,
  subtitle,
  icon,
}: {
  title: string
  subtitle: string
  icon: ReactNode
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <BillingNotEnabledPanel />
      <EmptyState
        title={`No ${title.toLowerCase()} yet`}
        description="Billing does not exist yet, so there is nothing to list — no payments, no subscriptions, no amounts."
        icon={icon}
      />
      <SourceNote source="No data source yet — billing does not exist" />
    </div>
  )
}

function CreditsSection({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="mb-5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p className="text-sm font-medium text-amber-300">Credits system not enabled yet.</p>
        <p className="mt-1 text-sm text-amber-200/80">
          There is no credits system — no balances, no adjustments, nothing to show.
        </p>
      </div>
      <EmptyState
        title="No credits yet"
        description="The credits system is not enabled yet."
        icon={<Coins className="h-7 w-7" />}
      />
      <SourceNote source="No data source yet — credits system not enabled" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* AI / FFmpeg / Whisper / OpenCV / Queue                              */
/* ------------------------------------------------------------------ */

function AiSettingsSection({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Cpu className="h-5 w-5 text-brand-light" /> Moment detection
        </h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          There is no AI settings endpoint yet. Moment detection and clipping
          model settings arrive with the processing engine in Phase 3 — no
          values are shown here because none exist to show.
        </p>
        <DisabledAdminFormNote detail="AI settings endpoint not implemented" />
      </div>
      <SourceNote source="No data source yet — AI settings arrive in Phase 3" />
    </div>
  )
}

function FfmpegSection({ title, subtitle }: { title: string; subtitle: string }) {
  const engine = useEngineHealth()
  const { data } = useAdminFetch<DashboardPayload>('/admin/dashboard')
  // Direct probe first; the worker-reported versions from the admin
  // dashboard are the fallback on the hosted site (no engine URL).
  const ffmpeg = engine?.ffmpeg ?? data?.engine?.ffmpeg ?? null
  const ffprobe = engine?.ffprobe ?? data?.engine?.ffprobe ?? null
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Terminal className="h-5 w-5 text-brand-light" /> FFmpeg (from the video engine)
        </h2>
        {!engine ? (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Checking the video engine…</p>
        ) : engine.ok ? (
          <>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Engine status: <span className="font-medium text-white">{engine.status}</span>
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              FFmpeg: <span className="font-medium text-white">{ffmpeg ?? 'not reported by the engine'}</span>
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              FFprobe: <span className="font-medium text-white">{ffprobe ?? 'not reported by the engine'}</span>
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-red-300">
            Video engine is not reachable — {engine.error ?? engine.status}
          </p>
        )}
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          Encoding presets and FFmpeg paths are not configurable yet — there is
          no admin FFmpeg settings endpoint.
        </p>
        <DisabledAdminFormNote detail="FFmpeg settings endpoint not implemented" />
      </div>
      <SourceNote source="Video-engine /health + Laravel /api/v1/admin/dashboard (worker-reported versions)" />
    </div>
  )
}

function NotInstalledSection({
  title,
  subtitle,
  icon,
  name,
  detail,
}: {
  title: string
  subtitle: string
  icon: ReactNode
  name: string
  detail: string
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          {icon} {name}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{detail}</p>
        <DisabledAdminFormNote detail={`${name} settings endpoint not implemented`} />
      </div>
      <SourceNote source="No data source yet" />
    </div>
  )
}

function QueueSection({ title, subtitle }: { title: string; subtitle: string }) {
  const { data, loading, error, retry } = useAdminFetch<HealthPayload>('/admin/system/health')
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Server className="h-5 w-5 text-brand-light" /> Queue &amp; workers
        </h2>
        {loading ? <p className="mt-2 text-sm text-[var(--color-text-muted)]">Loading…</p> : null}
        {error ? (
          <div className="mt-2">
            <LoadError error={error} onRetry={retry} />
          </div>
        ) : null}
        {data ? (
          <>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Queue connection: <span className="font-medium text-white">{data.queue.connection}</span>
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{data.queue.note}</p>
          </>
        ) : null}
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Local queue not connected — Phase 3/5. There is no worker pool or
          concurrency setting to configure yet.
        </p>
        <DisabledAdminFormNote detail="queue settings endpoint not implemented" />
      </div>
      <SourceNote source="Laravel /api/v1/admin/system/health" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Website / Notifications / Admin Settings — disabled forms           */
/* ------------------------------------------------------------------ */

function DisabledSettingsSection({
  title,
  subtitle,
  icon,
  intro,
}: {
  title: string
  subtitle: string
  icon: ReactNode
  intro: string
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          {icon} {title}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{intro}</p>
        <div className="mt-5 max-w-lg space-y-4 opacity-50">
          <label className="block">
            <span className="text-sm font-medium text-white">Setting</span>
            <input
              type="text"
              disabled
              placeholder="Disabled — no backend endpoint"
              className="mt-2 w-full cursor-not-allowed rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)]"
            />
          </label>
        </div>
        <button
          type="button"
          disabled
          className="mt-5 cursor-not-allowed rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white opacity-40"
        >
          Save Changes
        </button>
        <DisabledAdminFormNote detail="needs backend settings endpoint (not implemented)" />
      </div>
      <SourceNote source="No data source yet — no admin website-settings endpoint" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tickets / Logs / Monitor / Reports                                  */
/* ------------------------------------------------------------------ */

function TicketsSection({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState
        title="No support tickets yet"
        description="Support tickets need the backend — not implemented. No tickets exist to list."
        icon={<ShieldCheck className="h-7 w-7" />}
        action={
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white opacity-40"
          >
            New ticket
          </button>
        }
      />
      <SourceNote source="No data source yet — support tickets need the backend" />
    </div>
  )
}

function LogsSection({ title, subtitle }: { title: string; subtitle: string }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [totalLines, setTotalLines] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAdmin<{ lines?: string[]; total_lines?: number; truncated?: boolean; message?: string }>('/admin/system/logs?lines=200')
      .then((body) => {
        if (cancelled) return
        setLines(Array.isArray(body.lines) ? body.lines : null)
        setTotalLines(typeof body.total_lines === 'number' ? body.total_lines : 0)
        setTruncated(body.truncated === true)
        setMessage(body.message ?? null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => load(), [load])

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={load}
          className="rounded-xl bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Refresh
        </button>
        {!loading && lines ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Showing the last {totalLines} line{totalLines === 1 ? '' : 's'} of laravel.log
            {truncated ? ' (older lines cut off — ask for more with ?lines=500)' : ''}
          </p>
        ) : null}
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={load} /> : null}
      {message ? (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-300">
            <ScrollText className="h-4 w-4" />
            {message}
          </p>
        </div>
      ) : null}
      {lines && lines.length > 0 ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-[var(--color-border)] bg-black/40 p-4 font-mono text-xs leading-5 text-[var(--color-text)]">
          {lines.join('\n')}
        </pre>
      ) : null}
      {lines && lines.length === 0 && !message ? (
        <p className="text-sm text-[var(--color-text-muted)]">The log file is empty.</p>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/system/logs" />
    </div>
  )
}

function MonitorSection({ title, subtitle }: { title: string; subtitle: string }) {
  const engine = useEngineHealth()
  const [backend, setBackend] = useState<{ ok: boolean; error?: string } | null>(null)
  const { data, error, retry } = useAdminFetch<DashboardPayload>('/admin/dashboard')

  useEffect(() => {
    let cancelled = false
    laravelHealth().then((h) => {
      if (!cancelled) setBackend(h)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // A monitor that fetches once goes stale: it showed "0 running"
  // while a job was processing because the fetch predated the job
  // starting. Re-fetch every 10s (the job page polls every 5s) so the
  // counts track the same live definition as the dashboard.
  useEffect(() => {
    const timer = setInterval(() => retry(), 10_000)
    return () => clearInterval(timer)
  }, [retry])

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Activity className="h-5 w-5 text-brand-light" /> Backend (Laravel)
          </h2>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {backend
              ? backend.ok
                ? 'Reachable — GET /up answered.'
                : `Not reachable — ${backend.error ?? 'unknown error'}`
              : 'Checking…'}
          </p>
        </div>
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Server className="h-5 w-5 text-brand-light" /> Video engine
          </h2>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {engine
              ? engine.ok
                ? `Up (${engine.status}) — FFmpeg ${engine.ffmpeg ?? data?.engine?.ffmpeg ?? 'not reported'}`
                : `Down — ${engine.error ?? engine.status}`
              : 'Checking…'}
          </p>
        </div>
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <RefreshCw className="h-5 w-5 text-brand-light" /> Jobs
          </h2>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            {data
              ? `${data.jobs.total} total · ${data.jobs.running} running · ${data.jobs.failed} failed`
              : error
                ? `Could not load job counts — ${error}`
                : 'Loading job counts…'}
          </p>
        </div>
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="text-lg font-semibold text-white">CPU / RAM</h2>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            No CPU or RAM percentages are shown — a browser cannot measure the
            server, and there is no server-metrics endpoint. Any percentage
            here would be invented.
          </p>
        </div>
      </div>
      <SourceNote source="Laravel /api/v1/admin/system/health + /api/v1/admin/dashboard + video-engine /health" />
    </div>
  )
}

function ReportsSection({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState
        title="No reports yet"
        description="There is no usage data to report on yet, and billing does not exist — so there are no revenue or growth numbers to show, and none are invented."
        icon={<BarChart3 className="h-7 w-7" />}
      />
      <SourceNote source="No data source yet — reports need real usage data" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Generic page — branches on pathname to page-specific real content   */
/* ------------------------------------------------------------------ */

interface AdminPageProps {
  title: string
  subtitle: string
  /** Shown when the page concerns billing, which does not exist yet. */
  billingNotEnabled?: boolean
}

/* ------------------------------------------------------------------ */
/* Admin Settings — admin credentials (Batch 9)                        */
/* ------------------------------------------------------------------ */

/**
 * The signed-in admin changes their OWN email + password here.
 * Each Save replaces the previous credentials and the old ones stop
 * working. The seeder never touches credentials after the first
 * admin exists, so a change made here survives deploys. The current
 * password must be proven first; the current session stays signed
 * in. No credential value is ever displayed back.
 */
function AdminCredentialsSection({ title, subtitle }: { title: string; subtitle: string }) {
  const { user } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Prefill the new-email field with the signed-in admin's email —
  // changing only the password means leaving this untouched.
  useEffect(() => {
    if (user?.email) setNewEmail(user.email)
  }, [user?.email])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    setError(null)
    setFieldErrors({})
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())) {
      setFieldErrors({ new_email: 'Enter a valid email address.' })
      return
    }
    if (newPassword.length < 8) {
      setFieldErrors({ new_password: 'New password must be at least 8 characters.' })
      return
    }
    if (newPassword !== confirmPassword) {
      setFieldErrors({ new_password_confirmation: 'New passwords do not match.' })
      return
    }
    const token = getToken()
    if (!token) {
      setError('Sign in again — your session expired.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${API_URL}/admin/settings/credentials`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_email: newEmail.trim(),
          new_password: newPassword,
          new_password_confirmation: confirmPassword,
        }),
      })
      const body = (await res.json().catch(() => null)) as {
        message?: unknown
        errors?: Record<string, string[]>
      } | null
      if (!res.ok) {
        if (body?.errors) {
          const first: Record<string, string> = {}
          for (const [key, messages] of Object.entries(body.errors)) {
            if (messages.length > 0) first[key] = messages[0]
          }
          setFieldErrors(first)
          setError(
            typeof body.message === 'string' && body.message
              ? body.message
              : 'Could not update credentials.',
          )
        } else {
          setError(
            typeof body?.message === 'string' && body.message
              ? body.message
              : `Could not update credentials (HTTP ${res.status}).`,
          )
        }
        return
      }
      setMessage('Credentials updated — use the new email and password next time you sign in.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the backend.')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="max-w-lg rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <ShieldCheck className="h-5 w-5 text-brand-light" /> Admin credentials
        </h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Change the admin sign-in email and password. Saving replaces the previous
          credentials — the old ones stop working immediately, and the change survives
          deploys. You stay signed in.
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
          <label className="block">
            <span className="text-sm font-medium text-white">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={saving}
              className={inputClass}
            />
            {fieldErrors.current_password ? (
              <span className="mt-1 block text-sm text-red-300">{fieldErrors.current_password}</span>
            ) : null}
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">New email</span>
            <input
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              disabled={saving}
              className={inputClass}
            />
            {fieldErrors.new_email ? (
              <span className="mt-1 block text-sm text-red-300">{fieldErrors.new_email}</span>
            ) : null}
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={saving}
              className={inputClass}
            />
            {fieldErrors.new_password ? (
              <span className="mt-1 block text-sm text-red-300">{fieldErrors.new_password}</span>
            ) : null}
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={saving}
              className={inputClass}
            />
            {fieldErrors.new_password_confirmation ? (
              <span className="mt-1 block text-sm text-red-300">{fieldErrors.new_password_confirmation}</span>
            ) : null}
          </label>
          {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save credentials'}
          </button>
        </form>
      </div>
      <p className="mt-4 max-w-lg text-sm text-[var(--color-text-muted)]">
        Platform-wide settings (site name, AI, FFmpeg and the rest) are not built yet —
        their pages say so honestly. The credentials form and the Backup &amp; Restore
        section below are the live settings here.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Backup & Restore (Batch 9, 2026-11-25 — deploy-safety work)         */
/* ------------------------------------------------------------------ */

interface BackupInfo {
  filename: string
  size_bytes: number
  created_at: string
  driver: string
  method: string | null
  cloud_key: string | null
  cloud_error: string | null
  location: string
}

interface BackupPayload {
  backup: BackupInfo | null
  cloud_configured: boolean
  restore_command: string
}

function AdminBackupSection() {
  const { data, loading, error, retry } = useAdminFetch<BackupPayload>('/admin/backup')
  // A backup created from this section replaces the fetched one until
  // the next reload — same pattern as the credentials success message.
  const [created, setCreated] = useState<BackupInfo | null>(null)
  const [restoreCommand, setRestoreCommand] = useState<string | null>(null)
  const [cloudConfigured, setCloudConfigured] = useState<boolean | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const latest = created ?? data?.backup ?? null
  const cloud = cloudConfigured ?? data?.cloud_configured ?? false
  const restoreCmd = restoreCommand ?? data?.restore_command ?? null

  async function onCreate() {
    setMessage(null)
    setErrorMsg(null)
    const token = getToken()
    if (!token) {
      setErrorMsg('Sign in again — your session expired.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`${API_URL}/admin/backup`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })
      const body = (await res.json().catch(() => null)) as {
        message?: unknown
        backup?: BackupInfo
        restore_command?: string
        cloud_configured?: boolean
      } | null
      if (!res.ok) {
        setErrorMsg(
          typeof body?.message === 'string' && body.message
            ? body.message
            : `Could not create a backup (HTTP ${res.status}).`,
        )
        return
      }
      if (body?.backup) {
        setCreated(body.backup)
        if (body.restore_command) setRestoreCommand(body.restore_command)
        if (typeof body.cloud_configured === 'boolean') setCloudConfigured(body.cloud_configured)
      }
      setMessage('Backup created.')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not reach the backend.')
    } finally {
      setCreating(false)
    }
  }

  async function onDownload() {
    if (!latest) return
    setErrorMsg(null)
    const token = getToken()
    if (!token) {
      setErrorMsg('Sign in again — your session expired.')
      return
    }
    setDownloading(true)
    try {
      const res = await fetch(`${API_URL}/admin/backup/download`, {
        headers: { Accept: 'application/gzip', Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setErrorMsg('Could not download the backup — create a fresh one and try again.')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = latest.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not reach the backend.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="mt-8 max-w-lg rounded-2xl border border-ink-border bg-ink-panel p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Server className="h-5 w-5 text-brand-light" /> Backup &amp; Restore
      </h2>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        Backups cover the <strong className="text-white">database only</strong> — jobs, clips
        metadata, settings, presets, users and brand asset records. Clip, upload and
        brand-asset <strong className="text-white">files are not included</strong>; they live on
        the server disk and are wiped on deploy. Use Cloud Storage (Settings → Cloud
        Storage) for those.
      </p>

      {loading ? (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">Loading backup info…</p>
      ) : error ? (
        <div className="mt-4">
          <LoadError error={error} onRetry={retry} />
        </div>
      ) : latest ? (
        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-text-muted)]">Latest backup</dt>
            <dd className="text-right font-mono text-xs text-white">{latest.filename}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-text-muted)]">Created</dt>
            <dd className="text-white">{formatDate(latest.created_at)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-text-muted)]">Size</dt>
            <dd className="text-white">{formatBytes(latest.size_bytes)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--color-text-muted)]">Stored</dt>
            <dd className="text-white">
              {latest.location === 'local+cloud' ? 'Local disk + cloud bucket' : 'Local disk only'}
              {latest.method ? ` (${latest.method})` : ''}
            </dd>
          </div>
          {latest.cloud_error ? (
            <p className="pt-1 text-sm text-amber-300">
              Cloud upload failed for this backup: {latest.cloud_error} The local file is fine —
              download it.
            </p>
          ) : null}
        </dl>
      ) : (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          No backup exists yet — create one first.
        </p>
      )}

      {cloud ? (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          Cloud storage is configured — new backups are also uploaded to your bucket.
        </p>
      ) : (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          Cloud storage is not configured — backups sit on this server&apos;s disk under{' '}
          <code className="font-mono text-xs text-white">storage/app/backups</code> and are
          wiped on deploy, so download each backup and keep it somewhere safe.
        </p>
      )}

      {message ? <p className="mt-4 text-sm text-emerald-300">{message}</p> : null}
      {errorMsg ? <p className="mt-4 text-sm text-red-300">{errorMsg}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? 'Creating backup…' : 'Create backup now'}
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={!latest || downloading}
          className="rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          {downloading ? 'Downloading…' : 'Download backup'}
        </button>
      </div>

      {restoreCmd ? (
        <div className="mt-5">
          <p className="text-sm font-medium text-white">Restore</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Restore is a server command, not a button — a web request can time out mid-restore
            and corrupt data. Run it in the Render shell (or locally). It takes a fresh safety
            backup first and needs <code className="font-mono text-xs text-white">--force</code>.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 font-mono text-xs text-white">
            {restoreCmd}
          </code>
        </div>
      ) : null}
    </div>
  )
}

export function AdminSettingsPage() {
  return (
    <>
      <AdminCredentialsSection title="Admin Settings" subtitle="Platform-wide admin configuration." />
      <AdminBackupSection />
    </>
  )
}

export function AdminGenericPage({ title, subtitle }: AdminPageProps) {
  const { pathname } = useLocation()

  switch (pathname) {
    case '/admin/users':
      return <UsersSection title={title} subtitle={subtitle} />
    case '/admin/projects':
      return <ProjectsSection title={title} subtitle={subtitle} />
    case '/admin/clips':
      return <ClipsSection title={title} subtitle={subtitle} />
    case '/admin/jobs':
      return <JobsSection title={title} subtitle={subtitle} failedOnly={false} />
    case '/admin/failed-jobs':
      return <JobsSection title={title} subtitle={subtitle} failedOnly />
    case '/admin/payments':
      return <BillingSection title={title} subtitle={subtitle} icon={<CreditCard className="h-7 w-7" />} />
    case '/admin/subscriptions':
      return <BillingSection title={title} subtitle={subtitle} icon={<Wallet className="h-7 w-7" />} />
    case '/admin/credits':
      return <CreditsSection title={title} subtitle={subtitle} />
    case '/admin/ai-settings':
      return <AiSettingsSection title={title} subtitle={subtitle} />
    case '/admin/ffmpeg':
      return <FfmpegSection title={title} subtitle={subtitle} />
    case '/admin/whisper':
      return (
        <NotInstalledSection
          title={title}
          subtitle={subtitle}
          icon={<Eye className="h-5 w-5 text-brand-light" />}
          name="Whisper"
          detail="Not installed — transcription arrives in Phase 3. There is no Whisper model or language setting to configure yet."
        />
      )
    case '/admin/opencv':
      return (
        <NotInstalledSection
          title={title}
          subtitle={subtitle}
          icon={<SlidersHorizontal className="h-5 w-5 text-brand-light" />}
          name="OpenCV"
          detail="Not installed — Phase 3. Scene detection and face tracking settings arrive with the processing engine."
        />
      )
    case '/admin/queue':
      return <QueueSection title={title} subtitle={subtitle} />
    case '/admin/website':
      return (
        <DisabledSettingsSection
          title={title}
          subtitle={subtitle}
          icon={<Globe className="h-5 w-5 text-brand-light" />}
          intro="Site name, branding and public pages are configured here once a backend settings endpoint exists. The Laravel SettingsController exists for user settings, but there is no admin website-settings endpoint."
        />
      )
    case '/admin/notifications':
      return (
        <DisabledSettingsSection
          title={title}
          subtitle={subtitle}
          icon={<Bell className="h-5 w-5 text-brand-light" />}
          intro="Platform notification templates are configured here once a backend settings endpoint exists."
        />
      )
    case '/admin/tickets':
      return <TicketsSection title={title} subtitle={subtitle} />
    case '/admin/logs':
      return <LogsSection title={title} subtitle={subtitle} />
    case '/admin/monitor':
      return <MonitorSection title={title} subtitle={subtitle} />
    case '/admin/reports':
      return <ReportsSection title={title} subtitle={subtitle} />
    case '/admin/settings':
      return <AdminCredentialsSection title={title} subtitle={subtitle} />
    default:
      return (
        <div>
          <PageHeader title={title} subtitle={subtitle} />
          <EmptyState
            title={`No ${title.toLowerCase()} yet`}
            description="There is no data here yet — no accounts, no activity, nothing to list."
            icon={<FileWarning className="h-7 w-7" />}
          />
          <SourceNote source="No data source yet" />
        </div>
      )
  }
}
