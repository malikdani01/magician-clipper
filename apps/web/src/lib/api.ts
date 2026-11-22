/**
 * Real API client — Magician Clipper Phase 2.
 * Talks to the Laravel backend (Sanctum auth) and the FastAPI video
 * engine (ffprobe probe + audio extraction). No mock data anywhere:
 * every function hits a real endpoint and surfaces real failures.
 *
 * IMPORTANT: every Laravel request MUST send `Accept: application/json` —
 * without it, unauthenticated calls return HTTP 500 instead of 401
 * (known backend quirk).
 *
 * Engine / Laravel internal file paths (source_path, audio_path) are
 * returned by the engine but must NEVER be rendered in the UI.
 */

export const ENGINE_URL =
  import.meta.env.VITE_ENGINE_URL ?? 'http://127.0.0.1:8001'
export const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000/api/v1'
export const APP_URL =
  import.meta.env.VITE_APP_URL ?? 'http://127.0.0.1:8000'

const TOKEN_KEY = 'magician-clipper.token'
const USER_KEY = 'magician-clipper.user'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** POST /probe response from the video engine (ffprobe). */
export interface ProbeResult {
  job_id: string
  duration_seconds: number | null
  width: number | null
  height: number | null
  fps: number | null
  video_codec: string | null
  audio_codec: string | null
  audio_streams: number
  bitrate: number | null
  format: string | null
  size_bytes: number
  source_path: string
}

/** GET /jobs/{job_id} response from the video engine. */
export interface EngineJob {
  id: string
  source_path: string
  state: string
  stage: string | null
  progress: number | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface EngineHealth {
  ok: boolean
  status: string
  ffmpeg: string | null
  ffprobe: string | null
  error?: string
}

export interface LaravelHealth {
  ok: boolean
  error?: string
}

export type AuthResult =
  | { ok: true; user: unknown; token: string }
  | { ok: false; error: string }

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

function laravelHeaders(withAuth = true): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (withAuth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string' && b.message) return b.message
    if (typeof b.detail === 'string' && b.detail) return b.detail
    // Laravel validation errors: { errors: { field: [msg, ...] } }
    if (b.errors && typeof b.errors === 'object') {
      const first = Object.values(b.errors as Record<string, unknown>)[0]
      if (Array.isArray(first) && typeof first[0] === 'string') return first[0]
    }
  }
  return fallback
}

/* ------------------------------------------------------------------ */
/* Video engine                                                        */
/* ------------------------------------------------------------------ */

export async function engineHealth(): Promise<EngineHealth> {
  const { signal, cancel } = timeoutSignal(5000)
  try {
    const res = await fetch(`${ENGINE_URL}/health`, { signal })
    if (!res.ok) {
      return {
        ok: false,
        status: 'down',
        ffmpeg: null,
        ffprobe: null,
        error: `Engine returned HTTP ${res.status}`,
      }
    }
    const body = (await res.json()) as {
      status?: string
      service?: string
      ffmpeg?: string | null
      ffprobe?: string | null
    }
    return {
      ok: true,
      status: body.status ?? 'ok',
      ffmpeg: body.ffmpeg ?? null,
      ffprobe: body.ffprobe ?? null,
    }
  } catch (err) {
    return {
      ok: false,
      status: 'down',
      ffmpeg: null,
      ffprobe: null,
      error:
        err instanceof Error && err.name === 'AbortError'
          ? 'Engine did not respond within 5s'
          : 'Video engine is not reachable',
    }
  } finally {
    cancel()
  }
}

/** POST /probe — multipart field `file`. Throws on HTTP error.
 * 120s timeout: long-video uploads routinely exceed 10s. */
export async function probeVideo(file: File): Promise<ProbeResult> {
  const form = new FormData()
  form.append('file', file)
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${ENGINE_URL}/probe`, {
      method: 'POST',
      body: form,
      signal,
    })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = (await res.json()) as { detail?: string }
        if (typeof body.detail === 'string' && body.detail) detail = body.detail
      } catch {
        // Keep the status text when the error body is not JSON.
      }
      throw new Error(detail)
    }
    return (await res.json()) as ProbeResult
  } finally {
    cancel()
  }
}

/** POST /extract-audio — multipart field `file`. */
export async function extractAudio(file: File): Promise<{
  job_id: string
  audio_path: string
  duration_seconds: number | null
  sample_rate: number
  channels: number
  size_bytes: number
  source_path: string
}> {
  const form = new FormData()
  form.append('file', file)
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${ENGINE_URL}/extract-audio`, {
      method: 'POST',
      body: form,
      signal,
    })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const body = (await res.json()) as { detail?: string }
        if (typeof body.detail === 'string' && body.detail) detail = body.detail
      } catch {
        // Keep the status text when the error body is not JSON.
      }
      throw new Error(detail)
    }
    return (await res.json()) as {
      job_id: string
      audio_path: string
      duration_seconds: number | null
      sample_rate: number
      channels: number
      size_bytes: number
      source_path: string
    }
  } finally {
    cancel()
  }
}

/** GET /jobs/{job_id} — 404 returns null (job unknown/expired). */
export async function getEngineJob(jobId: string): Promise<EngineJob | null> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${ENGINE_URL}/jobs/${encodeURIComponent(jobId)}`, {
      signal,
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(res.statusText)
    return (await res.json()) as EngineJob
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Laravel backend                                                     */
/* ------------------------------------------------------------------ */

/** GET {API_URL}/health — under /api/* so CORS headers apply (unlike /up). */
export async function laravelHealth(): Promise<LaravelHealth> {
  const { signal, cancel } = timeoutSignal(5000)
  try {
    const res = await fetch(`${API_URL}/health`, { signal })
    return res.ok ? { ok: true } : { ok: false, error: `Backend returned HTTP ${res.status}` }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === 'AbortError'
          ? 'Backend did not respond within 5s'
          : 'Backend is not reachable',
    }
  } finally {
    cancel()
  }
}

/* --- token / stored user --- */

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // localStorage unavailable (private mode) — auth just won't persist.
  }
}

export function getStoredUser(): unknown | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function storeUser(user: unknown): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    // Ignore — user just won't persist across reloads.
  }
}

/* --- auth --- */

export async function laravelLogin(
  email: string,
  password: string,
): Promise<AuthResult> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { ...laravelHeaders(false), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: serverMessage(body, `Login failed (HTTP ${res.status})`) }
    }
    const data = body as { user?: unknown; token?: string }
    if (!data.token) return { ok: false, error: 'Login succeeded but no token was returned.' }
    setToken(data.token)
    storeUser(data.user ?? null)
    return { ok: true, user: data.user ?? null, token: data.token }
  } catch {
    return {
      ok: false,
      error: 'Backend is not reachable — start it with php artisan serve',
    }
  } finally {
    cancel()
  }
}

export async function laravelRegister(
  name: string,
  email: string,
  password: string,
  passwordConfirmation: string,
): Promise<AuthResult> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { ...laravelHeaders(false), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        password,
        password_confirmation: passwordConfirmation,
      }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: serverMessage(body, `Registration failed (HTTP ${res.status})`) }
    }
    const data = body as { user?: unknown; token?: string }
    if (!data.token) {
      return { ok: false, error: 'Registration succeeded but no token was returned.' }
    }
    setToken(data.token)
    storeUser(data.user ?? null)
    return { ok: true, user: data.user ?? null, token: data.token }
  } catch {
    return {
      ok: false,
      error: 'Backend is not reachable — start it with php artisan serve',
    }
  } finally {
    cancel()
  }
}

export async function laravelLogout(): Promise<void> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: laravelHeaders(),
      signal,
    })
  } catch {
    // Logout is best-effort; the local token is cleared either way.
  } finally {
    cancel()
    setToken(null)
    try {
      localStorage.removeItem(USER_KEY)
    } catch {
      // Ignore.
    }
  }
}

export async function laravelMe(): Promise<unknown | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/me`, { headers: laravelHeaders(), signal })
    if (!res.ok) return null
    const body = (await res.json()) as { user?: unknown }
    return body.user ?? null
  } catch {
    return null
  } finally {
    cancel()
  }
}

/* --- projects --- */

export async function listLaravelProjects(): Promise<{
  projects: unknown[]
  total: number
}> {
  if (!getToken()) return { projects: [], total: 0 }
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/projects`, {
      headers: laravelHeaders(),
      signal,
    })
    if (!res.ok) return { projects: [], total: 0 }
    const body = (await res.json()) as {
      data?: unknown[]
      total?: number
    }
    return {
      projects: Array.isArray(body.data) ? body.data : [],
      total: typeof body.total === 'number' ? body.total : 0,
    }
  } catch {
    return { projects: [], total: 0 }
  } finally {
    cancel()
  }
}

/** POST /projects {title} — title is required (max 255 chars). Returns the Laravel id, or null on failure. */
export async function createLaravelProject(title: string): Promise<number | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/projects`, {
      method: 'POST',
      headers: { ...laravelHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { project?: { id?: number } }
    return typeof body.project?.id === 'number' ? body.project.id : null
  } catch {
    return null
  } finally {
    cancel()
  }
}

export async function deleteLaravelProject(id: number): Promise<boolean> {
  if (!getToken()) return false
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/projects/${id}`, {
      method: 'DELETE',
      headers: laravelHeaders(),
      signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    cancel()
  }
}

export async function updateLaravelProject(
  id: number,
  patch: { title?: string; description?: string },
): Promise<boolean> {
  if (!getToken()) return false
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/projects/${id}`, {
      method: 'PATCH',
      headers: { ...laravelHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    cancel()
  }
}
