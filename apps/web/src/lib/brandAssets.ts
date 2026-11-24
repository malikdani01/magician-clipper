/**
 * Brand Kit intro/outro assets API client — GET/POST/DELETE
 * /api/v1/brand-kit/assets.
 *
 * An asset is a short brand video (intro or outro) the worker adds to
 * the start / end of clips rendered by NEW jobs. All calls hit the real
 * Laravel backend; errors surface the backend's exact message.
 * Upload limits are enforced by the backend (mp4/mov/webm, ≤50 MB,
 * ≤15 s); this client pre-checks the file size so an oversized file
 * fails fast with an honest message instead of a long upload.
 */

import { API_URL, getToken } from './api'

export type BrandAssetKind = 'intro' | 'outro'

export interface BrandAsset {
  id: number
  kind: BrandAssetKind
  original_name: string
  duration_seconds: number | null
  file_size_bytes: number
  created_at: string
}

export type BrandAssetResult =
  | { ok: true; asset: BrandAsset }
  | { ok: false; error: string; status?: number }

export const BRAND_ASSET_MAX_BYTES = 50 * 1024 * 1024

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string' && b.message) return b.message
    if (b.errors && typeof b.errors === 'object') {
      const messages = Object.entries(b.errors as Record<string, unknown>).flatMap(
        ([field, msgs]) =>
          Array.isArray(msgs)
            ? msgs.filter((m): m is string => typeof m === 'string').map((m) => `${field}: ${m}`)
            : [],
      )
      if (messages.length > 0) return messages.join(' ')
    }
  }
  return fallback
}

function parseAsset(body: unknown): BrandAsset | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidate = (b.asset ?? b) as Record<string, unknown>
  if (typeof candidate.id !== 'number') return null
  if (candidate.kind !== 'intro' && candidate.kind !== 'outro') return null
  if (typeof candidate.original_name !== 'string') return null
  return {
    id: candidate.id,
    kind: candidate.kind,
    original_name: candidate.original_name,
    duration_seconds:
      typeof candidate.duration_seconds === 'number' ? candidate.duration_seconds : null,
    file_size_bytes:
      typeof candidate.file_size_bytes === 'number' ? candidate.file_size_bytes : 0,
    created_at: typeof candidate.created_at === 'string' ? candidate.created_at : '',
  }
}

function parseAssetList(body: unknown): BrandAsset[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, unknown>
  const raw = b.assets ?? b.data ?? (Array.isArray(body) ? body : [])
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => parseAsset(item))
    .filter((a): a is BrandAsset => a !== null)
}

/** GET /api/v1/brand-kit/assets — the signed-in user's intro/outro assets. */
export async function listBrandAssets(): Promise<BrandAsset[]> {
  if (!getToken()) return []
  try {
    const res = await fetch(`${API_URL}/brand-kit/assets`, { headers: authHeaders() })
    if (!res.ok) return []
    const body: unknown = await res.json().catch(() => null)
    return parseAssetList(body)
  } catch {
    return []
  }
}

/**
 * POST /api/v1/brand-kit/assets — multipart fields `kind` (intro|outro)
 * + `file` (mp4/mov/webm, ≤50 MB, ≤15 s). Uploading a kind that already
 * has an asset replaces it on the server.
 */
export async function uploadBrandAsset(
  kind: BrandAssetKind,
  file: File,
): Promise<BrandAssetResult> {
  if (!getToken()) return { ok: false, error: 'Sign in to upload brand assets.' }
  if (file.size > BRAND_ASSET_MAX_BYTES) {
    return { ok: false, error: 'File is larger than 50 MB.' }
  }
  try {
    const form = new FormData()
    form.append('kind', kind)
    form.append('file', file)
    const res = await fetch(`${API_URL}/brand-kit/assets`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not upload the ${kind} clip (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const asset = parseAsset(body)
    if (!asset) {
      return { ok: false, error: 'The server did not return the uploaded asset.' }
    }
    return { ok: true, asset }
  } catch {
    return { ok: false, error: 'Backend is not reachable.' }
  }
}

/** DELETE /api/v1/brand-kit/assets/{id} — remove one asset. */
export async function deleteBrandAsset(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!getToken()) return { ok: false, error: 'Sign in to remove brand assets.' }
  try {
    const res = await fetch(`${API_URL}/brand-kit/assets/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      return {
        ok: false,
        error: serverMessage(body, `Could not remove the asset (HTTP ${res.status})`),
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Backend is not reachable.' }
  }
}
