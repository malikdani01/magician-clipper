import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, Folder, Pencil, Play, Search, Trash2, Video } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { ClipThumbnail } from '../components/ClipThumbnail'
import { useProjectSearch } from '../state/search'
import { useProjects, getProjectFile, getProjectVideoUrl, type ProjectRecord } from '../state/projects'
import { listLaravelProjects, listProjectClips } from '../lib/projects-api'
import { formatBytes } from '../lib/format'
import { formatDuration } from '../lib/format'

type StatusFilter = 'all' | ProjectRecord['status']

const STATUS_STYLES: Record<ProjectRecord['status'], string> = {
  draft: 'bg-ink-panel2 text-[var(--color-text-muted)]',
  processing: 'bg-amber-500/15 text-amber-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
}

/**
 * My Projects — redesign (same-to-same as the design collage).
 * Real project cards from the project store (browser + Laravel sync).
 * Clip counts are real: joined from the Laravel projects index by
 * laravelId (a project that was never synced genuinely has 0 server
 * clips). The thumbnail is the first generated clip's real first
 * frame, or the attached source video's first frame when the file is
 * in this browser session — never a fake thumbnail image.
 */
export function ProjectsPage() {
  const { query, setQuery } = useProjectSearch()
  const { projects, loading, error, source, updateProject, removeProject } =
    useProjects()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Real server-side clip counts + first clip (for the thumbnail),
  // joined by the Laravel project id. Unsynced projects have 0.
  const [serverCounts, setServerCounts] = useState<Map<number, number>>(new Map())
  const [countsLoaded, setCountsLoaded] = useState(false)
  const [firstClips, setFirstClips] = useState<
    Map<string, { id: number; hasThumbnail: boolean; totalDuration: number }>
  >(new Map())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const laravel = await listLaravelProjects()
      if (cancelled) return
      setServerCounts(new Map(laravel.map((p) => [p.id, p.clips_count])))
      setCountsLoaded(true)
      const withClips = projects.filter(
        (p) => p.laravelId !== null && (laravel.find((l) => l.id === p.laravelId)?.clips_count ?? 0) > 0,
      )
      const entries = await Promise.all(
        withClips.map(async (p) => {
          const clips = await listProjectClips(p.laravelId as number)
          if (clips.length === 0) return null
          return [
            p.id,
            {
              id: clips[0].id,
              hasThumbnail: clips[0].thumbnail_path !== null,
              totalDuration: clips.reduce((s, c) => s + (c.duration_seconds ?? 0), 0),
            },
          ] as const
        }),
      )
      if (cancelled) return
      setFirstClips(
        new Map(entries.filter((e): e is NonNullable<typeof e> => e !== null)),
      )
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      const matchesQuery =
        q === '' ||
        p.title.toLowerCase().includes(q) ||
        p.fileName.toLowerCase().includes(q)
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter
      return matchesQuery && matchesStatus
    })
  }, [projects, query, statusFilter])

  const searching = query.trim() !== '' || statusFilter !== 'all'

  function startRename(p: ProjectRecord) {
    setRenamingId(p.id)
    setRenameValue(p.title)
  }

  function saveRename(p: ProjectRecord) {
    const title = renameValue.trim()
    if (title && title !== p.title) updateProject(p.id, { title })
    setRenamingId(null)
  }

  function confirmDelete(p: ProjectRecord) {
    if (window.confirm(`Delete project "${p.title}"? This cannot be undone.`)) {
      removeProject(p.id)
    }
  }

  return (
    <div>
      <PageHeader
        title="My Projects"
        subtitle="Manage all your clipping projects."
        actions={
          <Link
            to="/clipper"
            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
          >
            New Project
          </Link>
        }
      />

      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        {source === 'laravel'
          ? 'Synced with backend'
          : 'Stored in this browser — sign in to sync with the backend'}
      </p>

      {error ? (
        <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </p>
      ) : null}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="w-64 rounded-xl border border-ink-border bg-ink-panel py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div className="relative">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Filter by status"
            className="appearance-none rounded-xl border border-ink-border bg-ink-panel px-3.5 py-2.5 pr-8 text-sm font-medium text-white focus:border-brand focus:outline-none"
          >
            <option value="all">Filter: All</option>
            <option value="completed">Filter: Completed</option>
            <option value="processing">Filter: Processing</option>
            <option value="draft">Filter: Draft</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        </div>
        <span className="ml-auto text-sm text-[var(--color-text-muted)]">
          {filtered.length} project{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Loading projects…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={searching ? 'No projects match your search' : 'No projects yet'}
          description={
            searching
              ? 'Try a different search term or clear the status filter.'
              : 'You have not created any projects yet. Import a long video in the AI Clipper to create your first project.'
          }
          icon={<Folder className="h-7 w-7" />}
          action={
            searching ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  setStatusFilter('all')
                }}
                className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                Clear search & filters
              </button>
            ) : (
              <Link
                to="/clipper"
                className="inline-flex rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
              >
                Create your first project
              </Link>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => {
            const clipCount =
              p.laravelId !== null
                ? (countsLoaded ? (serverCounts.get(p.laravelId) ?? 0) : null)
                : 0
            const firstClip = firstClips.get(p.id)
            const attached = getProjectFile(p.id) !== undefined
            const videoUrl = attached ? getProjectVideoUrl(p.id) : undefined
            const totalClipsDuration =
              firstClip && firstClip.totalDuration > 0 ? firstClip.totalDuration : null
            return (
            <article
              key={p.id}
              className="overflow-hidden rounded-2xl border border-ink-border bg-ink-panel shadow-card transition-colors hover:border-brand/50"
            >
              <Link
                to={`/editor?project=${encodeURIComponent(p.id)}`}
                className="relative block aspect-video bg-ink-panel2"
                aria-label={`Open ${p.title} in the editor`}
              >
                {firstClip ? (
                  <ClipThumbnail
                    clipId={firstClip.id}
                    hasThumbnail={firstClip.hasThumbnail}
                    alt={`${p.title} — first clip thumbnail`}
                    className="h-full w-full object-cover"
                  />
                ) : videoUrl ? (
                  <video
                    src={videoUrl}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ink-panel2 to-brand-dark/40 text-brand-light">
                    <Video className="h-12 w-12" />
                  </span>
                )}
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

              <div className="p-5">
                {renamingId === p.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(p)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      aria-label="Project title"
                      autoFocus
                      className="min-w-0 flex-1 rounded-lg border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => saveRename(p)}
                      className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-light"
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
                  <h2 className="truncate text-base font-semibold text-white">{p.title}</h2>
                )}

                <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]">
                  {p.fileName || 'Source file not in this browser'}
                </p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {clipCount === null
                    ? 'Counting clips…'
                    : `${clipCount} clip${clipCount === 1 ? '' : 's'}`}
                  {totalClipsDuration !== null
                    ? ` · ${formatDuration(totalClipsDuration)}`
                    : p.durationSeconds !== null
                      ? ` · source ${formatDuration(p.durationSeconds)}`
                      : ''}
                  {p.width !== null && p.height !== null ? ` · ${p.width}×${p.height}` : ''}
                  {p.fileSize > 0 ? ` · ${formatBytes(p.fileSize)}` : ''}
                </p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Created {new Date(p.createdAt).toLocaleDateString()}
                </p>

                <div className="mt-4 flex items-center justify-between gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${STATUS_STYLES[p.status]}`}
                  >
                    {p.status}
                  </span>
                  <div className="flex items-center gap-1">
                    <Link
                      to={`/editor?project=${encodeURIComponent(p.id)}`}
                      className="rounded-lg px-2 py-2 text-sm font-semibold text-brand-light hover:underline"
                    >
                      Open →
                    </Link>
                    <button
                      type="button"
                      onClick={() => startRename(p)}
                      aria-label={`Rename ${p.title}`}
                      className="rounded-lg border border-ink-border p-2 text-[var(--color-text-muted)] hover:text-white"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmDelete(p)}
                      aria-label={`Delete ${p.title}`}
                      className="rounded-lg border border-ink-border p-2 text-[var(--color-text-muted)] hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
