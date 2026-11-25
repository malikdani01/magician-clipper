import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Clapperboard,
  FileWarning,
  Folder,
  RefreshCw,
  Users,
} from 'lucide-react'
import { formatBytes } from '../../lib/format'
import { ClipThumbnail } from '../../components/ClipThumbnail'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import {
  AdminTable,
  Cell,
  LoadError,
  LoadingNote,
  Pager,
  SourceNote,
  TableRow,
  formatDate,
  mutateAdmin,
  planPill,
  relativeTime,
  statusPill,
  useAdminFetch,
  type AdminClipRow,
  type AdminJobRow,
  type AdminProjectRow,
  type AdminUserRow,
  type Paginated,
} from './AdminPages'

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function useDebounced(value: string, delayMs = 400): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

const btnPrimary =
  'rounded-xl bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40'
const btnGhost =
  'rounded-xl border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-40'
const btnDanger =
  'rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40'

function ActionNote({ text }: { text: string }) {
  return <p className="mt-2 text-xs text-[var(--color-text-muted)]">{text}</p>
}

function inputClass(): string {
  return 'w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none'
}

function selectClass(): string {
  return 'rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none'
}

const JOB_STATES = [
  'uploaded', 'queued', 'probing', 'extracting_audio', 'transcribing',
  'detecting_scenes', 'analyzing', 'selecting_clips', 'rendering',
  'captioning', 'validating', 'completed', 'failed', 'cancelling', 'cancelled',
]

/* ------------------------------------------------------------------ */
/* Users list                                                          */
/* ------------------------------------------------------------------ */

export function AdminUsersPage() {
  const [page, setPage] = useState(1)
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
  const debouncedSearch = useDebounced(search)
  const [sort, setSort] = useState('created_at')
  const [dir, setDir] = useState('desc')
  const query = new URLSearchParams({
    page: String(page),
    sort,
    dir,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminUserRow>>(
    `/admin/users?${query}`,
  )
  const rows = data?.data ?? []

  return (
    <div>
      <PageHeader title="Users Management" subtitle="All registered users. Suspend, change roles, reset passwords and set per-user limits from the detail page." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by name or email…"
          aria-label="Search users"
          className={`${inputClass()} max-w-sm`}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort users by"
          className={selectClass()}
        >
          <option value="created_at">Newest first</option>
          <option value="name">Name</option>
          <option value="email">Email</option>
          <option value="jobs">Most jobs</option>
        </select>
        <select
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          aria-label="Sort direction"
          className={selectClass()}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title={debouncedSearch ? 'No users match that search' : 'No users yet'}
          description={
            debouncedSearch
              ? 'No user matches the search. Try a different name or email.'
              : 'No accounts have signed up yet.'
          }
          icon={<Users className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['User', 'Role', 'Plan', 'Status', 'Projects', 'Jobs', 'Joined', '']}>
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
                <Cell>
                  {u.suspended_at ? (
                    <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-300">
                      Suspended
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                      Active
                    </span>
                  )}
                </Cell>
                <Cell>{u.projects_count ?? '—'}</Cell>
                <Cell>{u.processing_jobs_count ?? '—'}</Cell>
                <Cell muted>{relativeTime(u.created_at)}</Cell>
                <Cell>
                  <Link to={`/admin/users/${u.id}`} className="font-medium text-brand-light hover:underline">
                    Manage →
                  </Link>
                </Cell>
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
/* User detail — every admin action for one user                       */
/* ------------------------------------------------------------------ */

interface UserDetailPayload {
  user: AdminUserRow
  counts: { projects: number; jobs: number; clips: number; storage_bytes: number }
  settings: {
    theme?: string
    language?: string
    caption_style?: string
    processing_mode?: string
  } | null
  jobs: { id: number; state: string; created_at: string }[]
}

export function AdminUserDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error, retry } = useAdminFetch<UserDetailPayload>(
    id ? `/admin/users/${id}` : null,
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [role, setRole] = useState('user')
  const [dailyOverride, setDailyOverride] = useState('')
  const [clipsOverride, setClipsOverride] = useState('')

  const user = data?.user
  useEffect(() => {
    if (user) {
      setRole(user.role)
      setDailyOverride(user.daily_limit_override != null ? String(user.daily_limit_override) : '')
      setClipsOverride(user.max_clips_override != null ? String(user.max_clips_override) : '')
    }
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(fn: () => Promise<T>, okMessage: string): Promise<T | null> {
    setBusy(true)
    setNotice(null)
    setActionError(null)
    try {
      const result = await fn()
      setNotice(okMessage)
      retry()
      return result
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="User" subtitle="Loading…" />
        <LoadingNote />
      </div>
    )
  }
  if (error || !data || !user) {
    return (
      <div>
        <PageHeader title="User" subtitle="Could not load this user." />
        {error ? <LoadError error={error} onRetry={retry} /> : null}
      </div>
    )
  }

  const counts = data.counts

  return (
    <div>
      <PageHeader
        title={user.name}
        subtitle={user.email}
        actions={
          <Link to="/admin/users" className={btnGhost}>
            ← All users
          </Link>
        }
      />

      {notice ? (
        <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {actionError}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ['Projects', String(counts.projects)],
          ['Jobs', String(counts.jobs)],
          ['Clips', String(counts.clips)],
          ['Storage used', formatBytes(counts.storage_bytes)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-ink-border bg-ink-panel p-4">
            <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
            <p className="mt-1 text-xl font-bold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-5">
          <h2 className="text-base font-semibold text-white">Account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Role</dt>
              <dd className="font-medium text-white">{user.role}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Plan</dt>
              <dd className="font-medium capitalize text-white">{user.plan}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Status</dt>
              <dd className="font-medium text-white">
                {user.suspended_at ? `Suspended since ${formatDate(user.suspended_at)}` : 'Active'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Joined</dt>
              <dd className="font-medium text-white">{formatDate(user.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Daily limit override</dt>
              <dd className="font-medium text-white">
                {user.daily_limit_override != null ? `${user.daily_limit_override} jobs/day` : 'Platform default (10)'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Max clips override</dt>
              <dd className="font-medium text-white">
                {user.max_clips_override != null ? `${user.max_clips_override} clips/job` : 'Platform default (50)'}
              </dd>
            </div>
            {data.settings ? (
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Saved settings</dt>
                <dd className="font-medium text-white">
                  {[data.settings.theme, data.settings.language, data.settings.caption_style]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </dd>
              </div>
            ) : null}
          </dl>

          <h3 className="mt-5 text-sm font-semibold text-white">Role</h3>
          <div className="mt-2 flex gap-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={busy}
              aria-label="Role"
              className={selectClass()}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="button"
              disabled={busy || role === user.role}
              onClick={() =>
                void run(
                  () => mutateAdmin(`/admin/users/${user.id}/role`, 'PATCH', { role }),
                  `Role changed to ${role}.`,
                )
              }
              className={btnPrimary}
            >
              Save role
            </button>
          </div>
          <ActionNote text="You cannot change your own role, and the last admin cannot be demoted." />

          <h3 className="mt-5 text-sm font-semibold text-white">Per-user limits</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Daily job limit
              <input
                type="number"
                min={1}
                max={1000}
                value={dailyOverride}
                onChange={(e) => setDailyOverride(e.target.value)}
                placeholder="Platform default"
                disabled={busy}
                aria-label="Daily job limit override"
                className="w-36 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Max clips per job
              <input
                type="number"
                min={1}
                max={200}
                value={clipsOverride}
                onChange={(e) => setClipsOverride(e.target.value)}
                placeholder="Platform default"
                disabled={busy}
                aria-label="Max clips per job override"
                className="w-36 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    mutateAdmin(`/admin/users/${user.id}/overrides`, 'PATCH', {
                      daily_limit_override: dailyOverride === '' ? null : Number(dailyOverride),
                      max_clips_override: clipsOverride === '' ? null : Number(clipsOverride),
                    }),
                  'Per-user limits saved.',
                )
              }
              className={`${btnPrimary} self-end`}
            >
              Save limits
            </button>
          </div>
          <ActionNote text="Empty = use the platform default. Overrides replace the platform limits for this user only." />
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-5">
          <h2 className="text-base font-semibold text-white">Actions</h2>

          <div className="mt-3 flex flex-wrap gap-2">
            {user.suspended_at ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => mutateAdmin(`/admin/users/${user.id}/activate`, 'POST'),
                    'Account activated — the user can sign in and create jobs again.',
                  )
                }
                className={btnPrimary}
              >
                Activate account
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Suspend ${user.email}? They will not be able to sign in or create jobs until activated again.`,
                    )
                  ) {
                    void run(
                      () => mutateAdmin(`/admin/users/${user.id}/suspend`, 'POST'),
                      'Account suspended.',
                    )
                  }
                }}
                className={btnDanger}
              >
                Suspend account
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Reset the password for ${user.email}? A new random password will be shown once — give it to the user right away.`,
                  )
                ) {
                  setTempPassword(null)
                  void run(
                    async () => {
                      const res = await mutateAdmin<{ temporary_password: string }>(
                        `/admin/users/${user.id}/reset-password`,
                        'POST',
                      )
                      setTempPassword(res.temporary_password)
                      return res
                    },
                    'Password reset — the new password is shown below, once.',
                  )
                }
              }}
              className={btnGhost}
            >
              Reset password
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${user.email} permanently? This deletes ${counts.projects} project(s), ${counts.jobs} job(s) and ${counts.clips} clip(s). There is no undo.`,
                  )
                ) {
                  void run(
                    () => mutateAdmin(`/admin/users/${user.id}`, 'DELETE'),
                    'User deleted.',
                  ).then((result) => {
                    if (result !== null) navigate('/admin/users')
                  })
                }
              }}
              className={btnDanger}
            >
              Delete user
            </button>
          </div>
          <ActionNote text="You cannot suspend or delete your own account, and the last admin is protected." />

          {tempPassword ? (
            <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-sm font-semibold text-amber-300">
                New password — shown once, never again:
              </p>
              <p className="mt-2 flex items-center gap-3">
                <code className="rounded-lg bg-ink-panel px-3 py-2 font-mono text-sm text-white">
                  {tempPassword}
                </code>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(tempPassword)}
                  className={btnGhost}
                >
                  Copy
                </button>
              </p>
              <p className="mt-2 text-xs text-amber-200/80">
                The old password stops working immediately. Give this to the user now — it is not stored anywhere.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
        <h2 className="text-base font-semibold text-white">Latest jobs</h2>
        {data.jobs.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">This user has no jobs yet.</p>
        ) : (
          <AdminTable headers={['Job', 'State', 'Created']}>
            {data.jobs.map((j) => (
              <TableRow key={j.id}>
                <Cell>#{j.id}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(j.state)}`}>
                    {j.state}
                  </span>
                </Cell>
                <Cell muted>{formatDate(j.created_at)}</Cell>
              </TableRow>
            ))}
          </AdminTable>
        )}
      </div>
      <SourceNote source={`Laravel /api/v1/admin/users/${user.id}`} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export function AdminProjectsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const query = new URLSearchParams({
    page: String(page),
    ...(status ? { status } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminProjectRow>>(
    `/admin/projects?${query}`,
  )
  const rows = data?.data ?? []

  async function deleteProject(p: AdminProjectRow) {
    const jobs = p.processing_jobs_count ?? 0
    const clips = p.clips_count ?? 0
    if (
      !window.confirm(
        `Delete project "${p.title}" permanently? This deletes ${jobs} job(s) and ${clips} clip(s). There is no undo.`,
      )
    ) {
      return
    }
    setBusyId(p.id)
    setActionError(null)
    try {
      await mutateAdmin(`/admin/projects/${p.id}`, 'DELETE')
      retry()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Projects" subtitle="Every project on the platform. Deleting a project deletes its jobs, clips and media." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by title…"
          aria-label="Search projects"
          className={`${inputClass()} max-w-sm`}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          aria-label="Filter by status"
          className={selectClass()}
        >
          <option value="">All statuses</option>
          {['draft', 'processing', 'ready', 'failed'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {actionError ? (
        <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          {actionError}
        </div>
      ) : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="No projects match. Projects appear here once a user creates a job."
          icon={<Folder className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['Title', 'Owner', 'Status', 'Jobs', 'Clips', 'Created', '']}>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <Cell>{p.title}</Cell>
                <Cell muted>{p.user?.name ?? `User ${p.user_id}`}</Cell>
                <Cell>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusPill(p.status)}`}>
                    {p.status}
                  </span>
                </Cell>
                <Cell>{p.processing_jobs_count ?? '—'}</Cell>
                <Cell>{p.clips_count ?? '—'}</Cell>
                <Cell muted>{relativeTime(p.created_at)}</Cell>
                <Cell>
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => void deleteProject(p)}
                    className={btnDanger}
                  >
                    Delete
                  </button>
                </Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/projects" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Clips                                                               */
/* ------------------------------------------------------------------ */

export function AdminClipsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const query = new URLSearchParams({
    page: String(page),
    ...(status ? { status } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminClipRow>>(
    `/admin/clips?${query}`,
  )
  const rows = data?.data ?? []

  async function deleteClip(c: AdminClipRow) {
    if (!window.confirm(`Delete clip "${c.title ?? `Clip ${c.id}`}" permanently? Its rendered file is deleted too.`)) {
      return
    }
    setBusyId(c.id)
    setActionError(null)
    try {
      await mutateAdmin(`/admin/clips/${c.id}`, 'DELETE')
      retry()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Generated Clips" subtitle="Every clip the engine has generated, with its job and owner." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by title or clip ID…"
          aria-label="Search clips"
          className={`${inputClass()} max-w-sm`}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          aria-label="Filter by status"
          className={selectClass()}
        >
          <option value="">All statuses</option>
          {['pending', 'rendering', 'ready', 'failed'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {actionError ? (
        <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          {actionError}
        </div>
      ) : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title="No clips generated yet"
          description="No clips match. Clips appear here once a job finishes rendering them."
          icon={<Clapperboard className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <AdminTable headers={['', 'ID', 'Title', 'Job', 'Owner', 'Project', 'Status', 'Size', 'Created', '']}>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <Cell>
                  <span className="block h-12 w-9 overflow-hidden rounded-lg bg-ink-panel2">
                    <ClipThumbnail
                      clipId={c.id}
                      hasThumbnail={c.thumbnail_path != null}
                      alt={c.title ?? `Clip ${c.id}`}
                      className="h-full w-full object-cover"
                    />
                  </span>
                </Cell>
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
                <Cell>
                  <button
                    type="button"
                    disabled={busyId === c.id}
                    onClick={() => void deleteClip(c)}
                    className={btnDanger}
                  >
                    Delete
                  </button>
                </Cell>
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

function JobsTable({
  rows,
  onRetry,
  onCancel,
  onDelete,
  busyId,
  showError,
}: {
  rows: AdminJobRow[]
  onRetry: (j: AdminJobRow) => void
  onCancel: (j: AdminJobRow) => void
  onDelete: (j: AdminJobRow) => void
  busyId: number | null
  showError: boolean
}) {
  const TERMINAL = ['completed', 'cancelled']
  return (
    <AdminTable
      headers={['ID', 'State', 'Stage', 'Progress', 'Owner', 'Project', 'Clips', ...(showError ? ['Error'] : []), 'Created', 'Actions']}
    >
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
          <Cell muted>{j.user?.name ?? '—'}</Cell>
          <Cell muted>{j.project?.title ?? '—'}</Cell>
          <Cell>{j.clips_count ?? '—'}</Cell>
          {showError ? (
            <Cell muted>
              <span className="block max-w-xs break-words text-xs">
                {j.error_message ?? j.error_code ?? 'Failed — no error message recorded'}
              </span>
            </Cell>
          ) : null}
          <Cell muted>{formatDate(j.created_at)}</Cell>
          <Cell>
            <span className="flex flex-wrap gap-1.5">
              {j.state === 'failed' ? (
                <button
                  type="button"
                  disabled={busyId === j.id}
                  onClick={() => onRetry(j)}
                  className={btnPrimary}
                >
                  Retry
                </button>
              ) : null}
              {!TERMINAL.includes(j.state) ? (
                <button
                  type="button"
                  disabled={busyId === j.id}
                  onClick={() => onCancel(j)}
                  className={btnGhost}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                disabled={busyId === j.id}
                onClick={() => onDelete(j)}
                className={btnDanger}
              >
                Delete
              </button>
            </span>
          </Cell>
        </TableRow>
      ))}
    </AdminTable>
  )
}

export function AdminJobsPage() {
  const [page, setPage] = useState(1)
  const [state, setState] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [userId, setUserId] = useState('')
  const debouncedUserId = useDebounced(userId)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const query = new URLSearchParams({
    page: String(page),
    ...(state ? { state } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(debouncedUserId.trim() ? { user_id: debouncedUserId.trim() } : {}),
  }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminJobRow>>(
    `/admin/jobs?${query}`,
  )
  const rows = data?.data ?? []

  async function act(j: AdminJobRow, action: 'retry' | 'cancel' | 'delete') {
    if (action === 'delete') {
      const clips = j.clips_count ?? 0
      if (
        !window.confirm(
          `Delete job #${j.id} permanently? This deletes its ${clips} clip(s). There is no undo.`,
        )
      ) {
        return
      }
    }
    setBusyId(j.id)
    setActionError(null)
    setNotice(null)
    try {
      if (action === 'delete') {
        await mutateAdmin(`/admin/jobs/${j.id}`, 'DELETE')
        setNotice(`Job #${j.id} and its clips deleted.`)
      } else {
        await mutateAdmin(`/admin/jobs/${j.id}/${action}`, 'POST')
        setNotice(`Job #${j.id} ${action === 'retry' ? 're-queued' : 'cancelled'}.`)
      }
      retry()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Processing Jobs" subtitle="Jobs in the processing queue, across all users. Cancel, retry or delete any job." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by job ID or project title…"
          aria-label="Search jobs"
          className={`${inputClass()} max-w-sm`}
        />
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value)
            setPage(1)
          }}
          aria-label="Filter by state"
          className={selectClass()}
        >
          <option value="">All states</option>
          {JOB_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value)
            setPage(1)
          }}
          placeholder="Filter by user ID…"
          aria-label="Filter by user ID"
          className="w-40 rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
        />
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {notice ? (
        <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          {actionError}
        </div>
      ) : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          description="No jobs match these filters."
          icon={<RefreshCw className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <JobsTable
            rows={rows}
            onRetry={(j) => void act(j, 'retry')}
            onCancel={(j) => void act(j, 'cancel')}
            onDelete={(j) => void act(j, 'delete')}
            busyId={busyId}
            showError={false}
          />
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/jobs" />
    </div>
  )
}

export function AdminFailedJobsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const query = new URLSearchParams({
    page: String(page),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminJobRow>>(
    `/admin/jobs/failed?${query}`,
  )
  const rows = data?.data ?? []

  async function act(j: AdminJobRow, action: 'retry' | 'cancel' | 'delete') {
    if (action === 'delete') {
      const clips = j.clips_count ?? 0
      if (
        !window.confirm(
          `Delete failed job #${j.id} permanently? This deletes its ${clips} clip(s). There is no undo.`,
        )
      ) {
        return
      }
    }
    setBusyId(j.id)
    setActionError(null)
    setNotice(null)
    try {
      if (action === 'delete') {
        await mutateAdmin(`/admin/jobs/${j.id}`, 'DELETE')
        setNotice(`Job #${j.id} and its clips deleted.`)
      } else {
        await mutateAdmin(`/admin/jobs/${j.id}/${action}`, 'POST')
        setNotice(`Job #${j.id} ${action === 'retry' ? 're-queued' : 'cancelled'}.`)
      }
      retry()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Failed Jobs" subtitle="Jobs that failed, with their exact error message. Retry re-queues the job." />
      <div className="mb-4 max-w-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
          placeholder="Search by job ID…"
          aria-label="Search failed jobs"
          className={inputClass()}
        />
      </div>
      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {notice ? (
        <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          {actionError}
        </div>
      ) : null}
      {data && rows.length === 0 ? (
        <EmptyState
          title="No failed jobs"
          description="No jobs have failed. Failed jobs appear here with their error message."
          icon={<FileWarning className="h-7 w-7" />}
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <JobsTable
            rows={rows}
            onRetry={(j) => void act(j, 'retry')}
            onCancel={(j) => void act(j, 'cancel')}
            onDelete={(j) => void act(j, 'delete')}
            busyId={busyId}
            showError
          />
          <Pager page={data?.current_page ?? 1} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/jobs/failed" />
    </div>
  )
}
