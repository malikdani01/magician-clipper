import { useEffect, useState } from 'react'
import { Download, FileVideo } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { ClipThumbnail } from '../components/ClipThumbnail'
import {
  listLaravelProjects,
  listProjectClips,
  type LaravelProject,
} from '../lib/projects-api'
import {
  createExport,
  downloadExport,
  listExports,
  type ExportRecord,
} from '../lib/exports'
import { formatBytes } from '../lib/format'

interface ProjectExportRow {
  project: LaravelProject
  clipCount: number
  totalBytes: number
  firstClipId: number | null
  firstClipHasThumbnail: boolean
  export: ExportRecord | null
}

/**
 * Export Center — redesign (same-to-same as the design collage).
 * One row per project with ready clips: real thumbnail, project name,
 * real clip count + total size, a Ready badge when a ZIP export exists,
 * and a working Download ZIP button. The first click builds the ZIP
 * on the server from the real rendered clips (POST /projects/{id}/export)
 * and then downloads it; later clicks download the stored ZIP directly.
 * Projects without ready clips are not listed — an empty ZIP is never
 * fabricated.
 */
export function ExportsPage() {
  const [rows, setRows] = useState<ProjectExportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyProjectId, setBusyProjectId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [laravel, exports] = await Promise.all([
        listLaravelProjects(),
        listExports(),
      ])
      if (cancelled) return
      const latestByProject = new Map<number, ExportRecord>()
      for (const exp of exports.exports) {
        if (!latestByProject.has(exp.project_id)) {
          latestByProject.set(exp.project_id, exp)
        }
      }
      const withClips = laravel.filter((p) => p.clips_count > 0)
      const built = await Promise.all(
        withClips.map(async (project) => {
          const clips = await listProjectClips(project.id)
          return {
            project,
            clipCount: clips.length,
            totalBytes: clips.reduce((s, c) => s + (c.file_size_bytes ?? 0), 0),
            firstClipId: clips.length > 0 ? clips[0].id : null,
            firstClipHasThumbnail:
              clips.length > 0 && clips[0].thumbnail_path !== null,
            export: latestByProject.get(project.id) ?? null,
          } as ProjectExportRow
        }),
      )
      if (cancelled) return
      setRows(built.filter((r) => r.clipCount > 0))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleDownload(row: ProjectExportRow) {
    setError(null)
    setBusyProjectId(row.project.id)
    try {
      let exp = row.export
      if (!exp || exp.status !== 'ready') {
        const created = await createExport(row.project.id)
        if (!created.ok) {
          setError(created.error)
          return
        }
        exp = created.export
        setRows((prev) =>
          prev.map((r) =>
            r.project.id === row.project.id ? { ...r, export: exp } : r,
          ),
        )
      }
      const result = await downloadExport(exp)
      if (!result.ok) setError(result.error)
    } finally {
      setBusyProjectId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Export Center" subtitle="Download your final clips." />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Loading exports…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No exports yet"
          description="Finished clips you export will be listed here with a download link. Generate clips in the AI Clipper first — projects with ready clips appear here."
          icon={<Download className="h-7 w-7" />}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const ready = row.export?.status === 'ready'
            const busy = busyProjectId === row.project.id
            return (
              <div
                key={row.project.id}
                className="flex flex-wrap items-center gap-4 rounded-2xl border border-ink-border bg-ink-panel p-4 shadow-card"
              >
                <span className="relative block h-14 w-14 shrink-0 overflow-hidden rounded-xl">
                  {row.firstClipId !== null ? (
                    <ClipThumbnail
                      clipId={row.firstClipId}
                      hasThumbnail={row.firstClipHasThumbnail}
                      alt={`${row.project.title} — first clip thumbnail`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ink-panel2 to-brand-dark/40 text-brand-light">
                      <FileVideo className="h-7 w-7" />
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {row.project.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
                    {row.clipCount} clip{row.clipCount === 1 ? '' : 's'}
                    {row.totalBytes > 0 ? ` · ${formatBytes(row.totalBytes)}` : ''}
                    {row.export ? ` · exported ${new Date(row.export.created_at).toLocaleDateString()}` : ''}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {ready
                      ? `ZIP ready — downloaded ${row.export?.download_count ?? 0} time${(row.export?.download_count ?? 0) === 1 ? '' : 's'}.`
                      : 'No ZIP built yet — the first download builds it from the real clips.'}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    ready
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-ink-panel2 text-[var(--color-text-muted)]'
                  }`}
                >
                  {ready ? 'Ready' : 'Not exported'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleDownload(row)}
                  disabled={busy}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
                >
                  <Download className="h-4 w-4" />
                  {busy ? 'Preparing…' : 'Download ZIP'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
