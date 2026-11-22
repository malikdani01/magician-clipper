/**
 * Export API client — Magician Clipper (Export Center redesign).
 *
 *   GET  /api/v1/exports                  list my exports (paginated)
 *   POST /api/v1/projects/{id}/export     build a ZIP of the project's ready clips
 *   GET  /api/v1/exports/{id}/download    stream the stored ZIP
 *
 * No mock data: every function hits the real Laravel backend and surfaces
 * the backend's exact error message on failure. Auth is the Sanctum
 * bearer <redacted> from lib/api (getToken). Downloads go through fetch +
 * blob, not a plain <a href> (a plain link would send no Authorization
 * header and 401).
 */

import { API_URL, getToken } from './api'

export interface ExportRecord {
  id: number
  project_id: number
  user_id: number
  clip_ids: number[]
  format: 'mp4' | 'zip'
  status: 'pending' | 'processing' | 'ready' | 'failed'
  file_path: string | null
  file_size_bytes: number | null
  download_count: number
  created_at: string
  updated_at: string
  project?: { id: number; title: string }
}

export type ExportResult =
  | { ok: true; export: ExportRecord }
  | { ok: false; error: string; status?: number }

function authHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${getToken() ?? ''}`,
  }
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message?: unknown }).message
    if (typeof m === 'string' && m.trim()) return m
  }
  return fallback
}

/** GET /api/v1/exports — the user's export history, newest first. */
export async function listExports(page = 1): Promise<{ exports: ExportRecord[]; total: number }> {
  if (!getToken()) return { exports: [], total: 0 }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/exports?page=${page}&per_page=20`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return { exports: [], total: 0 }
    const body = (await res.json()) as { data?: ExportRecord[]; total?: number }
    return {
      exports: Array.isArray(body.data) ? body.data : [],
      total: typeof body.total === 'number' ? body.total : 0,
    }
  } catch {
    return { exports: [], total: 0 }
  } finally {
    cancel()
  }
}

/**
 * POST /api/v1/projects/{projectId}/export — build a ZIP of the project's
 * ready clips on the server and record it. Returns the export row
 * (status 'ready' when the ZIP is built).
 */
export async function createExport(projectId: number): Promise<ExportResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to create an export.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}/export`, {
      method: 'POST',
      headers: authHeaders(),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Export failed (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const exp = (body as { export?: ExportRecord }).export
    if (!exp) return { ok: false, error: 'The server did not return the export.' }
    return { ok: true, export: exp }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'AbortError'
          ? 'The export took too long — check Export Center in a moment.'
          : err instanceof Error
            ? err.message
            : 'Export failed.',
    }
  } finally {
    cancel()
  }
}

/**
 * Download a ready export's ZIP via its download endpoint with the
 * bearer <redacted>, then trigger a browser download of the real ZIP file.
 */
export async function downloadExport(
  exp: ExportRecord,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to download exports.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${API_URL}/exports/${exp.id}/download`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) {
      let detail = `Download failed (HTTP ${res.status})`
      try {
        const body: unknown = await res.json()
        detail = serverMessage(body, detail)
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      return { ok: false, error: detail }
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const safeTitle = (exp.project?.title || `export-${exp.id}`)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 100)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeTitle}-clips.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'AbortError'
          ? 'Download timed out — try again.'
          : err instanceof Error
            ? err.message
            : 'Download failed.',
    }
  } finally {
    cancel()
  }
}
