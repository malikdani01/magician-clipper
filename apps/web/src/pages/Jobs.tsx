import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, CheckCircle2, Clock, ListVideo, Loader2, XCircle } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { JobStatusPill, jobSummary } from '../components/JobStatusPill'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { formatDuration } from '../lib/format'
import { listJobs, type Job, type JobStatus } from '../lib/jobs'
import { useAuth } from '../state/auth'

type StatusFilter = JobStatus | 'all'

const FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All jobs' },
  { id: 'queued', label: 'Queued' },
  { id: 'processing', label: 'Processing' },
  { id: 'ready', label: 'Ready' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
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
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [jobs, setJobs] = useState<Job[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [lastPage, setLastPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [counts, setCounts] = useState<Record<JobStatus, number> | null>(null)

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
        title="My Jobs"
        subtitle="Every clipping job you created, with its real status."
        actions={
          <Link
            to="/jobs/new"
            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
          >
            + New Job
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
                className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
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
            <StatCard label="Total jobs" value={String(total)} icon={<Briefcase className="h-6 w-6" />} />
            <StatCard
              label="Active (queued + processing)"
              value={String(activeCount)}
              icon={<Clock className="h-6 w-6" />}
              accent="#7c3aed"
            />
            <StatCard
              label="Ready"
              value={String(readyCount)}
              icon={<CheckCircle2 className="h-6 w-6" />}
              accent="#059669"
            />
            <StatCard
              label="Failed"
              value={String(failedCount)}
              icon={<XCircle className="h-6 w-6" />}
              accent="#dc2626"
            />
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
                {f.label}
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
                className="mt-4 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
              >
                Retry
              </button>
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState
              title="No jobs yet"
              description={
                filter === 'all'
                  ? 'You have not created any clipping jobs yet. Upload a video or paste a link to make your first clips.'
                  : `No ${filter} jobs. Try a different filter, or create a new job.`
              }
              icon={<ListVideo className="h-7 w-7" />}
              action={
                <Link
                  to="/jobs/new"
                  className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
                >
                  Create your first job
                </Link>
              }
            />
          ) : (
            <>
              <ul className="space-y-3">
                {jobs.map((job) => (
                  <li key={job.id}>
                    <Link
                      to={`/jobs/${job.id}`}
                      className="flex flex-wrap items-center gap-4 rounded-2xl border border-ink-border bg-ink-panel p-5 transition-colors hover:border-brand/60"
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
