import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  ScrollText,
} from 'lucide-react'
import { formatBytes } from '../../lib/format'
import { AreaChart } from '../../components/charts'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import { StatCard } from '../../components/StatCard'
import {
  AdminTable,
  Cell,
  LoadError,
  LoadingNote,
  Pager,
  SourceNote,
  TableRow,
  formatDate,
  fetchAdmin,
  mutateAdmin,
  relativeTime,
  useAdminFetch,
  type AdminJobRow,
  type Paginated,
} from './AdminPages'

/* ------------------------------------------------------------------ */
/* Monitor                                                             */
/* ------------------------------------------------------------------ */

interface MonitorPayload {
  worker: { last_report_at: string | null; ffmpeg: string | null; ffprobe: string | null }
  queue: { queued_jobs: number; processing_jobs: number; failed_jobs: number }
  database: { connection: string; ok: boolean; size_bytes: number | null }
  disk: { path: string; total_bytes: number | null; free_bytes: number | null; app_files_bytes: number }
  totals: { users: number; projects: number; jobs: number; clips: number }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ink-border py-2.5 text-sm last:border-0">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="break-words text-right font-medium text-white">{value}</span>
    </div>
  )
}

export function AdminMonitorPage() {
  const { data, loading, error, retry } = useAdminFetch<MonitorPayload>('/admin/monitor')

  return (
    <div>
      <PageHeader
        title="Server Monitor"
        subtitle="Real system facts: worker reports, queue depth, database size, disk usage and totals. Nothing here is estimated."
        icon={<Activity className="h-5 w-5" />}
        actions={
          <button
            type="button"
            onClick={retry}
            className="rounded-xl border border-ink-border bg-ink-panel px-4 py-2 text-sm font-medium text-white hover:bg-ink-border"
          >
            Refresh
          </button>
        }
      />
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Queued jobs"
              value={String(data.queue.queued_jobs)}
              sublabel="Waiting for the worker"
              icon={<Activity className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #4C1D95 0%, #7C3AED 100%)"
            />
            <StatCard
              label="Processing jobs"
              value={String(data.queue.processing_jobs)}
              sublabel="In flight right now"
              icon={<Activity className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)"
            />
            <StatCard
              label="Failed jobs"
              value={String(data.queue.failed_jobs)}
              sublabel="See Failed Jobs to retry"
              icon={<AlertTriangle className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #92400E 0%, #D97706 100%)"
            />
            <StatCard
              label="Database size"
              value={data.database.size_bytes != null ? formatBytes(data.database.size_bytes) : 'Unknown'}
              sublabel={`${data.database.connection} · ${data.database.ok ? 'reachable' : 'UNREACHABLE'}`}
              icon={<Activity className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #065F46 0%, #059669 100%)"
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-5">
              <h2 className="text-base font-semibold text-white">Video worker</h2>
              <div className="mt-2">
                <Fact
                  label="Last report"
                  value={
                    data.worker.last_report_at
                      ? `${formatDate(data.worker.last_report_at)} (${relativeTime(data.worker.last_report_at)})`
                      : 'Never reported yet'
                  }
                />
                <Fact label="FFmpeg" value={data.worker.ffmpeg ?? 'Not reported by the worker'} />
                <Fact label="FFprobe" value={data.worker.ffprobe ?? 'Not reported by the worker'} />
              </div>
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Versions ride along with the worker&apos;s status reports. Until the first report, the panel says so honestly.
              </p>
            </div>
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-5">
              <h2 className="text-base font-semibold text-white">Disk</h2>
              <div className="mt-2">
                <Fact label="Path" value={data.disk.path} />
                <Fact
                  label="Total"
                  value={data.disk.total_bytes != null ? formatBytes(data.disk.total_bytes) : 'Unknown'}
                />
                <Fact
                  label="Free"
                  value={data.disk.free_bytes != null ? formatBytes(data.disk.free_bytes) : 'Unknown'}
                />
                <Fact label="App files (clips + sources)" value={formatBytes(data.disk.app_files_bytes)} />
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Totals</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {data.totals.users} users · {data.totals.projects} projects · {data.totals.jobs} jobs ·{' '}
              {data.totals.clips} clips
            </p>
          </div>
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/monitor" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Logs — activity trail + failed jobs + laravel.log tail              */
/* ------------------------------------------------------------------ */

interface ActivityEntry {
  id: number
  admin_id: number
  action: string
  target_type: string | null
  target_id: number | null
  details: Record<string, unknown> | null
  created_at: string
  admin?: { id: number; name: string; email: string }
}

interface LaravelLogsPayload {
  lines: string[]
  total_lines: number
  file: string
  message?: string
  truncated?: boolean
}

export function AdminLogsPage() {
  const [page, setPage] = useState(1)
  const { data, loading, error, retry } = useAdminFetch<Paginated<ActivityEntry>>(
    `/admin/activity-log?page=${page}`,
  )
  const failed = useAdminFetch<Paginated<AdminJobRow>>('/admin/jobs/failed?page=1')
  const laravel = useAdminFetch<LaravelLogsPayload>('/admin/system/logs?lines=100')
  const entries = data?.data ?? []

  return (
    <div>
      <PageHeader
        title="System Logs"
        subtitle="The admin activity trail, recent failed jobs, and the application log. Every admin action writes one activity row."
        icon={<ScrollText className="h-5 w-5" />}
      />

      <h2 className="text-base font-semibold text-white">Admin activity</h2>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && entries.length === 0 ? (
        <EmptyState
          title="No admin actions yet"
          description="Actions taken in this panel (role changes, suspensions, deletes, settings, broadcasts) appear here."
          icon={<ScrollText className="h-7 w-7" />}
        />
      ) : null}
      {entries.length > 0 ? (
        <>
          <div className="mt-3">
            <AdminTable headers={['When', 'Admin', 'Action', 'Target', 'Details']}>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <Cell muted>{formatDate(e.created_at)}</Cell>
                  <Cell>{e.admin?.name ?? `Admin ${e.admin_id}`}</Cell>
                  <Cell>
                    <code className="rounded bg-ink-panel2 px-2 py-0.5 text-xs text-white">{e.action}</code>
                  </Cell>
                  <Cell muted>
                    {e.target_type ? `${e.target_type} #${e.target_id ?? '—'}` : '—'}
                  </Cell>
                  <Cell muted>
                    <span className="block max-w-sm break-words text-xs">
                      {e.details ? JSON.stringify(e.details) : '—'}
                    </span>
                  </Cell>
                </TableRow>
              ))}
            </AdminTable>
          </div>
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}

      <h2 className="mt-6 text-base font-semibold text-white">Recent failed jobs</h2>
      {failed.loading ? <LoadingNote /> : null}
      {failed.error ? <LoadError error={failed.error} onRetry={failed.retry} /> : null}
      {failed.data && failed.data.data.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">No failed jobs.</p>
      ) : null}
      {failed.data && failed.data.data.length > 0 ? (
        <div className="mt-3">
          <AdminTable headers={['Job', 'Owner', 'Error', 'Failed at']}>
            {failed.data.data.slice(0, 5).map((j) => (
              <TableRow key={j.id}>
                <Cell>#{j.id}</Cell>
                <Cell muted>{j.user?.name ?? '—'}</Cell>
                <Cell muted>
                  <span className="block max-w-md break-words text-xs">
                    {j.error_message ?? j.error_code ?? 'Failed — no error message recorded'}
                  </span>
                </Cell>
                <Cell muted>{formatDate(j.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
          <p className="mt-2 text-sm">
            <Link to="/admin/failed-jobs" className="font-medium text-brand-light hover:underline">
              View all failed jobs →
            </Link>
          </p>
        </div>
      ) : null}

      <h2 className="mt-6 text-base font-semibold text-white">Application log (laravel.log)</h2>
      {laravel.loading ? <LoadingNote /> : null}
      {laravel.error ? <LoadError error={laravel.error} onRetry={laravel.retry} /> : null}
      {laravel.data ? (
        <pre className="mt-3 max-h-96 overflow-auto rounded-2xl border border-ink-border bg-ink-panel p-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {laravel.data.lines.length === 0
            ? laravel.data.message ?? 'No log lines yet.'
            : laravel.data.lines.join('\n')}
        </pre>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/activity-log · /api/v1/admin/jobs/failed · /api/v1/admin/system/logs" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Notifications — broadcast to all users or one user                  */
/* ------------------------------------------------------------------ */

interface AdminUserOption {
  id: number
  name: string
  email: string
}

export function AdminNotificationsPage() {
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState<'all' | 'user'>('all')
  const [emailSearch, setEmailSearch] = useState('')
  const [found, setFound] = useState<AdminUserOption | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  async function lookup() {
    const q = emailSearch.trim()
    if (!q) return
    setLookingUp(true)
    setLookupError(null)
    setFound(null)
    try {
      const res = await fetchAdmin<Paginated<AdminUserOption>>(
        `/admin/users?search=${encodeURIComponent(q)}`,
      )
      const match = res.data.find((u) => u.email.toLowerCase() === q.toLowerCase()) ?? res.data[0] ?? null
      if (!match) {
        setLookupError('No user matches that email or name.')
      } else {
        setFound(match)
      }
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e))
    } finally {
      setLookingUp(false)
    }
  }

  async function send() {
    setSending(true)
    setNotice(null)
    setSendError(null)
    try {
      const res = await mutateAdmin<{ message: string; recipients: number }>(
        '/admin/notifications/broadcast',
        'POST',
        {
          title: title.trim(),
          message: message.trim(),
          target,
          ...(target === 'user' && found ? { user_id: found.id } : {}),
        },
      )
      setNotice(res.message)
      setTitle('')
      setMessage('')
      setFound(null)
      setEmailSearch('')
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const canSend =
    title.trim() !== '' && message.trim() !== '' && (target === 'all' || found !== null)

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Send a notification to all users or one selected user. It appears in their bell exactly like a job notification."
        icon={<Bell className="h-5 w-5" />}
      />
      {notice ? (
        <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      ) : null}
      {sendError ? (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {sendError}
        </div>
      ) : null}

      <div className="max-w-2xl rounded-2xl border border-ink-border bg-ink-panel p-5">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-white">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="e.g. Maintenance tonight"
            className="w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
          />
        </label>
        <label className="mt-4 flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-white">Message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="What should users know?"
            className="w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
          />
        </label>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-white">Send to</legend>
          <div className="mt-2 flex gap-4 text-sm text-white">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="broadcast-target"
                checked={target === 'all'}
                onChange={() => setTarget('all')}
                className="h-4 w-4 accent-[#8b5cf6]"
              />
              All users
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="broadcast-target"
                checked={target === 'user'}
                onChange={() => setTarget('user')}
                className="h-4 w-4 accent-[#8b5cf6]"
              />
              One user
            </label>
          </div>
        </fieldset>

        {target === 'user' ? (
          <div className="mt-4">
            <div className="flex flex-wrap gap-2">
              <input
                type="search"
                value={emailSearch}
                onChange={(e) => {
                  setEmailSearch(e.target.value)
                  setFound(null)
                }}
                placeholder="Search by email or name…"
                aria-label="Find user by email or name"
                className="min-w-64 flex-1 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                disabled={lookingUp || emailSearch.trim() === ''}
                onClick={() => void lookup()}
                className="rounded-xl border border-ink-border bg-ink-panel px-4 py-2.5 text-sm font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-40"
              >
                {lookingUp ? 'Searching…' : 'Find user'}
              </button>
            </div>
            {lookupError ? <p className="mt-2 text-sm text-red-300">{lookupError}</p> : null}
            {found ? (
              <p className="mt-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                Sending to: {found.name} ({found.email})
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={!canSend || sending}
          onClick={() => void send()}
          className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? 'Sending…' : target === 'all' ? 'Send to all users' : 'Send to this user'}
        </button>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Broadcasts are logged in System Logs. There is no undo — a sent notification cannot be recalled.
        </p>
      </div>
      <SourceNote source="Laravel /api/v1/admin/notifications/broadcast" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Reports — real aggregates, no revenue                               */
/* ------------------------------------------------------------------ */

interface ReportsPayload {
  daily: { date: string; users: number; projects: number; clips: number; jobs: number }[]
  top_users: { id: number; name: string; email: string; jobs_count: number; clips_count: number }[]
  totals: { users: number; jobs: number; clips: number; clips_ready: number }
}

export function AdminReportsPage() {
  const { data, loading, error, retry } = useAdminFetch<ReportsPayload>('/admin/reports')
  const [tab, setTab] = useState<'jobs' | 'clips'>('jobs')
  const daily = data?.daily ?? []
  const points = daily.map((d) => d[tab])
  const total = points.reduce((a, b) => a + b, 0)
  const labels: [string, string] =
    daily.length > 0 ? [daily[0].date.slice(5), daily[daily.length - 1].date.slice(5)] : ['—', '—']

  return (
    <div>
      <PageHeader
        title="Reports & Analytics"
        subtitle="Jobs and clips per day for the last 30 days, and the top users by clips rendered. No revenue — billing does not exist."
        icon={<BarChart3 className="h-5 w-5" />}
      />
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total users"
              value={String(data.totals.users)}
              sublabel="Registered accounts"
              icon={<BarChart3 className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #4C1D95 0%, #7C3AED 100%)"
            />
            <StatCard
              label="Total jobs"
              value={String(data.totals.jobs)}
              sublabel="Processing jobs created"
              icon={<BarChart3 className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%)"
            />
            <StatCard
              label="Total clips"
              value={String(data.totals.clips)}
              sublabel={`${data.totals.clips_ready} ready`}
              icon={<BarChart3 className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #065F46 0%, #059669 100%)"
            />
            <StatCard
              label="Jobs in the last 30 days"
              value={String(daily.reduce((a, d) => a + d.jobs, 0))}
              sublabel={`${daily.reduce((a, d) => a + d.clips, 0)} clips in the same period`}
              icon={<BarChart3 className="h-5 w-5" />}
              accent="rgba(255,255,255,0.18)"
              gradient="linear-gradient(135deg, #92400E 0%, #D97706 100%)"
            />
          </div>

          <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">Daily activity</h2>
              <div className="flex gap-1 rounded-full border border-ink-border bg-ink-panel2 p-1" role="tablist" aria-label="Daily series">
                {(['jobs', 'clips'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                      tab === t ? 'bg-brand text-white' : 'text-[var(--color-text-muted)] hover:text-white'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {total} {tab} in the last 30 days · daily counts from the admin API
            </p>
            <div className="mt-5">
              <AreaChart points={points} color="#8B5CF6" labels={labels} />
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Top users by clips</h2>
            {data.top_users.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                No clips rendered yet — the ranking appears once clips exist.
              </p>
            ) : (
              <div className="mt-3">
                <AdminTable headers={['#', 'User', 'Email', 'Jobs', 'Clips']}>
                  {data.top_users.map((u, i) => (
                    <TableRow key={u.id}>
                      <Cell>{i + 1}</Cell>
                      <Cell>
                        <Link to={`/admin/users/${u.id}`} className="font-medium text-brand-light hover:underline">
                          {u.name}
                        </Link>
                      </Cell>
                      <Cell muted>{u.email}</Cell>
                      <Cell>{u.jobs_count}</Cell>
                      <Cell>{u.clips_count}</Cell>
                    </TableRow>
                  ))}
                </AdminTable>
              </div>
            )}
          </div>
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/reports" />
    </div>
  )
}
