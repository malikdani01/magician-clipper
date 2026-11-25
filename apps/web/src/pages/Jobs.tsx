import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, CheckCircle2, Clock, ListVideo, Loader2, Pencil, Search, Trash2, XCircle } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { JobStatusPill, jobSummary } from '../components/JobStatusPill'
import { QueueInfo } from '../components/QueueInfo'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { formatDuration } from '../lib/format'
import { listJobs, type Job, type JobStatus } from '../lib/jobs'
import { listLaravelProjects } from '../lib/projects-api'
import { useAuth } from '../state/auth'
import { usePreferences } from '../state/preferences'
import { useProjects, type ProjectRecord } from '../state/projects'

type StatusFilter = JobStatus | 'all'

import type { TranslationKey } from '../lib/i18n'

const FILTERS: Array<{ id: StatusFilter; labelKey: TranslationKey }> = [
  { id: 'all', labelKey: 'allStatuses' },
  { id: 'queued', labelKey: 'queued' },
  { id: 'processing', labelKey: 'processing' },
  { id: 'ready', labelKey: 'ready' },
  { id: 'failed', labelKey: 'failed' },
  { id: 'cancelled', labelKey: 'cancelled' },
]

function formatCreatedAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function sourceLabel(job: Job): string {
  if (job.source_type === 'link' && job.source_url) {
    try {
      return new URL(job.source_url).host.replace(/^www\./, '')
    } catch {
      return job.source_url
    }
  }
  return 'Uploaded video'
}

/**
 * My Jobs — the user's real jobs from GET /api/v1/jobs.
 * Stat counts come from the same endpoint (one per_page=1 request per
 * status, reading meta.total) — no invented numbers anywhere.
 */
export function JobsPage() {
  const { user, loading: authLoading } = useAuth()
  const { t } = usePreferences()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [jobs, setJobs] = useState<Job[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [lastPage, setLastPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [counts, setCounts] = useState<Record<JobStatus, number> | null>(null)
  const [query, setQuery] = useState('')
  const { projects, updateProject, removeProject } = useProjects()
  // Batch 9 (2026-11-25): /projects was hidden and its rename + delete
  // moved here. Exact server counts per project (jobs + clips) for the
  // delete warning — the loaded page alone can under-count a project
  // whose jobs span several pages.
  const [serverCounts, setServerCounts] = useState<Map<number, { jobs: number; clips: number }>>(new Map())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    let cancelled = false
    void listLaravelProjects()
      .then((laravel) => {
        if (cancelled) return
        setServerCounts(
          new Map(laravel.map((p) => [p.id, { jobs: p.processing_jobs_count, clips: p.clips_count }])),
        )
      })
      .catch(() => {
        // Counts are a nicety for the delete warning — the generic
        // warning covers it when they fail to load.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Project title per Laravel project id — for searching jobs by their
  // project's title (same pattern as the Library page).
  const projectTitleById = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of projects) {
      if (p.laravelId !== null) map.set(p.laravelId, p.title)
    }
    return map
  }, [projects])

  // Client-side search over the LOADED jobs only (job id substring or
  // project title). It does not reach the server — jobs on later pages
  // are not searched until they are loaded.
  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return jobs
    return jobs.filter(
      (job) =>
        String(job.id).includes(q) ||
        (projectTitleById.get(job.project_id) ?? '').toLowerCase().includes(q),
    )
  }, [jobs, query, projectTitleById])
  const searching = query.trim() !== ''

  // Group the loaded jobs by their project so each project can be
  // renamed / deleted from this page. Jobs whose project is not in
  // the store (or has no project) fall into an "Other jobs" group
  // with no project actions.
  const jobGroups = useMemo(() => {
    const groups: Array<{ project: ProjectRecord | null; jobs: Job[] }> = []
    const byProject = new Map<string, Job[]>()
    const other: Job[] = []
    for (const job of filteredJobs) {
      const project = projects.find((p) => p.laravelId !== null && p.laravelId === job.project_id)
      if (project) {
        const list = byProject.get(project.id) ?? []
        list.push(job)
        byProject.set(project.id, list)
      } else {
        other.push(job)
      }
    }
    for (const project of projects) {
      const list = byProject.get(project.id)
      if (list) groups.push({ project, jobs: list })
    }
    if (other.length > 0) groups.push({ project: null, jobs: other })
    return groups
  }, [filteredJobs, projects])

  function startRename(p: ProjectRecord) {
    setRenamingId(p.id)
    setRenameValue(p.title)
  }

  function saveRename(p: ProjectRecord) {
    const title = renameValue.trim()
    if (title && title !== p.title) updateProject(p.id, { title })
    setRenamingId(null)
  }

  function confirmDeleteProject(p: ProjectRecord) {
    // Deleting a project cascades to its jobs and clips on the server
    // (foreign keys). Name the exact counts when they are known;
    // otherwise warn generically. The Jobs list is filtered locally
    // at once; the server state re-syncs on the next load.
    const counts = p.laravelId !== null ? serverCounts.get(p.laravelId) : undefined
    const detail =
      counts !== undefined
        ? ` This will also delete its ${counts.jobs} job${counts.jobs === 1 ? '' : 's'} and ${counts.clips} clip${counts.clips === 1 ? '' : 's'}.`
        : ' Its jobs and clips will be deleted too.'
    if (window.confirm(`Delete project "${p.title}"?${detail} This cannot be undone.`)) {
      const laravelId = p.laravelId
      removeProject(p.id)
      if (laravelId !== null) {
        setJobs((current) => current.filter((j) => j.project_id !== laravelId))
        setTotal((current) => Math.max(0, current - (counts?.jobs ?? 0)))
      }
    }
  }

  const load = useCallback(async (status: StatusFilter, pageToLoad: number, append: boolean) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setLoadError(false)
    try {
      const result = await listJobs({ status, page: pageToLoad, perPage: 20 })
      setJobs((current) => (append ? [...current, ...result.jobs] : result.jobs))
      setTotal(result.total)
      setPage(result.currentPage)
      setLastPage(result.lastPage)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  // First load + counts (counts refresh with the filter change too).
  useEffect(() => {
    void load(filter, 1, false)
    let cancelled = false
    Promise.all(
      (['queued', 'processing', 'ready', 'failed'] as JobStatus[]).map(async (s) => {
        const r = await listJobs({ status: s, page: 1, perPage: 1 })
        return [s, r.total] as const
      }),
    )
      .then((entries) => {
        if (cancelled) return
        setCounts(Object.fromEntries(entries) as Record<JobStatus, number>)
      })
      .catch(() => {
        // Counts are a nicety — the list itself still renders.
      })
    return () => {
      cancelled = true
    }
  }, [filter, load])

  const readyCount = counts?.ready ?? 0
  const activeCount = (counts?.queued ?? 0) + (counts?.processing ?? 0)
  const failedCount = counts?.failed ?? 0

  return (
    <div>
      <PageHeader
        title={t('jobsTitle')}
        subtitle={t('jobsSubtitle')}
        actions={
          <Link
            to="/clipper"
            className="rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
          >
            + {t('newJobTitle')}
          </Link>
        }
      />

      {authLoading ? (
        <div className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-6 text-sm text-white">
          <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
          Checking sign-in…
        </div>
      ) : !user ? (
        <EmptyState
          title="Sign in to see your jobs"
          description="Jobs are tied to your account. Sign in or register to see the jobs you created."
          action={
            <div className="flex gap-2">
              <Link
                to="/login"
                className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                Register
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('statJobs')} value={String(total)} icon={<Briefcase className="h-6 w-6" />} />
            <StatCard
              label="Active (queued + processing)"
              value={String(activeCount)}
              icon={<Clock className="h-6 w-6" />}
              accent="#7c3aed"
            />
            <StatCard
              label={t('ready')}
              value={String(readyCount)}
              icon={<CheckCircle2 className="h-6 w-6" />}
              accent="#059669"
            />
            <StatCard
              label={t('failed')}
              value={String(failedCount)}
              icon={<XCircle className="h-6 w-6" />}
              accent="#dc2626"
            />
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchJobs')}
                aria-label="Search jobs by job number or project title"
                className="w-72 rounded-xl border border-ink-border bg-ink-panel py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            {searching ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('showingJobs')} {filteredJobs.length} of {jobs.length} loaded job
                {jobs.length === 1 ? '' : 's'} — search covers loaded jobs only.
              </p>
            ) : null}
          </div>

          <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter jobs by status">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors ${
                  filter === f.id
                    ? 'border-brand bg-brand text-white'
                    : 'border-ink-border bg-ink-panel2 text-white hover:border-brand/60'
                }`}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-6 text-sm text-white">
              <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
              Loading your jobs…
            </div>
          ) : loadError ? (
            <div role="alert" className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6">
              <p className="text-sm font-semibold text-red-300">Could not load your jobs</p>
              <p className="mt-1 text-sm text-red-200/90">
                The backend did not answer. Check it is running, then try again.
              </p>
              <button
                type="button"
                onClick={() => void load(filter, 1, false)}
                className="mt-4 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
              >
                Retry
              </button>
            </div>
          ) : filteredJobs.length === 0 ? (
            <EmptyState
              title={
                searching
                  ? `No loaded jobs match “${query.trim()}”`
                  : 'No jobs yet'
              }
              description={
                searching
                  ? 'Search covers the jobs loaded on this page only — try a different job number or project title, or load more jobs.'
                  : filter === 'all'
                    ? 'You have not created any clipping jobs yet. Upload a video or paste a link to make your first clips.'
                    : `No ${filter} jobs. Try a different filter, or create a new job.`
              }
              icon={<ListVideo className="h-7 w-7" />}
              action={
                searching ? undefined : (
                  <Link
                    to="/clipper"
                    className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
                  >
                    Create your first job
                  </Link>
                )
              }
            />
          ) : (
            <>
              {/* Jobs grouped by project — each project header carries
                  the rename + delete actions the old /projects page had. */}
              {jobGroups.map((group) => (
                <section key={group.project?.id ?? 'other'} className="mb-6">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    {group.project && renamingId === group.project.id ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename(group.project as ProjectRecord)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          aria-label="Project title"
                          autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => saveRename(group.project as ProjectRecord)}
                          className="rounded-lg btn-aurora px-3 py-2 text-sm font-semibold text-white"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          className="rounded-lg border border-ink-border px-3 py-2 text-sm text-[var(--color-text-muted)] hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-white">
                          {group.project ? group.project.title : 'Other jobs'}
                        </h2>
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {group.jobs.length} job{group.jobs.length === 1 ? '' : 's'}
                          {group.project && group.project.laravelId !== null && serverCounts.has(group.project.laravelId)
                            ? ` · ${serverCounts.get(group.project.laravelId)?.clips ?? 0} clips`
                            : ''}
                        </span>
                        {group.project ? (
                          <>
                            <button
                              type="button"
                              onClick={() => startRename(group.project as ProjectRecord)}
                              aria-label={`Rename ${group.project.title}`}
                              className="rounded-lg border border-ink-border p-2 text-[var(--color-text-muted)] hover:text-white"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => confirmDeleteProject(group.project as ProjectRecord)}
                              aria-label={`Delete ${group.project.title}`}
                              className="rounded-lg border border-ink-border p-2 text-[var(--color-text-muted)] hover:text-red-300"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
              <ul className="space-y-3">
                {group.jobs.map((job) => (
                  <li key={job.id}>
                    <Link
                      to={`/jobs/${job.id}`}
                      className="aurora-card flex flex-wrap items-center gap-4 rounded-2xl border border-ink-border bg-ink-panel p-5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="font-semibold text-white">Job #{job.id}</span>
                          <JobStatusPill status={job.status} />
                          {job.clips.length > 0 ? (
                            <span className="text-xs text-[var(--color-text-muted)]">
                              {job.clips.length} clip{job.clips.length === 1 ? '' : 's'} ready
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]">
                          {sourceLabel(job)} · {jobSummary(job)}
                        </p>
                        {job.status === 'failed' && job.error_message ? (
                          <p className="mt-1 truncate text-sm text-red-300">{job.error_message}</p>
                        ) : null}
                        {job.status === 'processing' && job.stage ? (
                          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                            Stage: {job.stage}
                            {typeof job.progress === 'number' ? ` · ${job.progress}%` : ''}
                          </p>
                        ) : null}
                        {/* Batch 11: queue position + estimated wait. */}
                        {(job.status === 'queued' || job.status === 'processing') && job.queue ? (
                          <QueueInfo queue={job.queue} />
                        ) : null}
                      </div>
                      <div className="text-right text-xs text-[var(--color-text-muted)]">
                        <p>{formatCreatedAt(job.created_at)}</p>
                        {job.clips.length > 0 ? (
                          <p className="mt-1">
                            Total clip time{' '}
                            {formatDuration(
                              job.clips.reduce(
                                (sum, c) => sum + (c.duration_seconds ?? 0),
                                0,
                              ),
                            )}
                          </p>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
                </section>
              ))}
              <p className="mt-4 text-sm text-[var(--color-text-muted)]">
                Showing {jobs.length} of {total} job{total === 1 ? '' : 's'}.
              </p>
              {page < lastPage ? (
                <button
                  type="button"
                  onClick={() => void load(filter, page + 1, true)}
                  disabled={loadingMore}
                  className="mt-3 rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-semibold text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
