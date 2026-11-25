/**
 * Batch 5 (2026-11-25): Cloud Storage API client.
 * GET/PATCH /api/v1/cloud-storage and POST /api/v1/cloud-storage/test.
 * The secret is NEVER returned by the API (the page only knows it is
 * saved); it is only ever sent when the user types a new one.
 */
import { API_URL, getToken } from './api'

export type CloudProvider = 'r2' | 's3' | 'custom'

export interface CloudStorageSettings {
  provider: CloudProvider
  endpoint: string | null
  bucket: string
  region: string
  access_key_id: string
  /** True when a secret is stored — the value itself is never sent. */
  secret_saved: boolean
  enabled: boolean
}

export const CLOUD_PROVIDERS: { id: CloudProvider; label: string; endpointHint: string }[] = [
  {
    id: 'r2',
    label: 'Cloudflare R2',
    endpointHint: 'https://<account-id>.r2.cloudflarestorage.com',
  },
  { id: 's3', label: 'AWS S3', endpointHint: 'Leave empty — uses the AWS default' },
  { id: 'custom', label: 'Custom S3-compatible', endpointHint: 'https://s3.example.com' },
]

async function authed(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken()
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
}

/** GET /api/v1/cloud-storage — null when nothing is saved yet. */
export async function getCloudStorage(): Promise<CloudStorageSettings | null> {
  const res = await authed('/cloud-storage')
  if (!res.ok) throw new Error(`Cloud storage settings could not be loaded (HTTP ${res.status}).`)
  const body = (await res.json()) as { cloud_storage?: CloudStorageSettings | null }
  return body.cloud_storage ?? null
}

export interface SaveCloudStorageInput {
  provider: CloudProvider
  endpoint: string
  bucket: string
  region: string
  access_key_id: string
  /** Omit (empty) to keep the stored secret. */
  secret_access_key: string
  enabled: boolean
}

/** PATCH /api/v1/cloud-storage — returns the saved settings (no secret). */
export async function saveCloudStorage(
  input: SaveCloudStorageInput,
): Promise<{ ok: boolean; settings?: CloudStorageSettings; error?: string }> {
  try {
    const res = await authed('/cloud-storage', {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => null)) as {
      cloud_storage?: CloudStorageSettings
      message?: string
    } | null
    if (!res.ok) {
      return { ok: false, error: body?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, settings: body?.cloud_storage }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach the backend.' }
  }
}

/**
 * POST /api/v1/cloud-storage/test — the backend really puts a tiny
 * test object in the bucket, reads it back and deletes it. The result
 * is the real outcome, never a fake "OK".
 */
export async function testCloudStorage(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await authed('/cloud-storage/test', { method: 'POST', body: '{}' })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
    return {
      ok: res.ok && body?.ok === true,
      message: body?.message ?? (res.ok ? 'Connected.' : `HTTP ${res.status}`),
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not reach the backend.' }
  }
}
