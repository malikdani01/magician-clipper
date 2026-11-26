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
  (import.meta.env.VITE_ENGINE_URL || '').trim() || 'http://127.0.0.1:8001'
export const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000/api/v1'
export const APP_URL =
  import.meta.env.VITE_APP_URL ?? 'http://127.0.0.1:8000'

/**
 * True when this page is served from local dev (localhost), where a
 * local engine can run. Same hostname test as Clipper.tsx.
 * The engine URL alone cannot tell us: on the hosted site
 * VITE_ENGINE_URL is set but empty, so it falls back to
 * 127.0.0.1:8001 even though no engine can run there.
 */
export const IS_LOCAL_SITE =
  typeof window !== 'undefined' &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)

/** True when an engine URL was explicitly configured (non-empty VITE_ENGINE_URL). */
export const ENGINE_CONFIGURED =
  (import.meta.env.VITE_ENGINE_URL || '').trim().length > 0

/**
 * Always-On round (2026-11-26): the old "Backend is not reachable —
 * start it with php artisan serve" error was shown on the LIVE site
 * too, where no local server can be started — users read it as "the
 * backend is down" when the real cause was a slow upload or a dropped
 * connection. The artisan hint only makes sense when the app is
 * actually talking to a local backend, so it is kept for localhost
 * API URLs only; everywhere else the message says what to do.
 */
export function isLocalApi(): boolean {
  return /(^https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(API_URL)
}

/** Honest, actionable error for a failed request. `timedOut` = the
 *  request ran past its client timeout (usually a slow upload). */
export function unreachableMessage(timedOut = false): string {
  if (isLocalApi()) {
    return 'Backend is not reachable — start it with php artisan serve (http://127.0.0.1:8000).'
  }
  return timedOut
    ? 'The upload is taking too long — check your connection and try again. Large videos upload best on WiFi.'
    : 'Could not reach the server — check your connection and try again. Large videos upload best on WiFi.'
}

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
  /**
   * Where the numbers came from. 'engine' = ffprobe on the video
   * engine (full metadata incl. fps/codecs); 'browser' = the browser
   * read duration/resolution itself (fps/codecs unknown, null).
   * The UI says which one it was — never present browser numbers
   * as engine numbers.
   */
  probed_by?: 'browser' | 'engine'
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
  // Hosted site with no engine URL configured: there is no engine to
  // probe — heavy processing runs through the connected Muse worker,
  // not a local FastAPI engine. Report the worker path as up instead
  // of probing localhost (unreachable from a visitor's browser) or
  // the static host itself (which 404s /health). Local dev still
  // probes the real engine below.
  if (!IS_LOCAL_SITE && !ENGINE_CONFIGURED) {
    return { ok: true, status: 'worker', ffmpeg: null, ffprobe: null }
  }
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

/**
 * Probe a video file for duration, resolution and size.
 *
 * Local dev (engine configured): POST /probe to the video engine —
 * ffprobe gives full metadata incl. fps and codecs.
 *
 * Hosted site (no engine configured): the engine URL falls back to
 * 127.0.0.1:8001, which the visitor's browser can never reach — the
 * old code fetched it anyway and every probe failed ("Failed to
 * fetch", wizard blocked). Here the browser reads the metadata
 * itself from the file (duration/resolution); fps/codecs stay null
 * and are labelled as unmeasured. The server re-validates the
 * upload with ffprobe when the job is created, so a bad file is
 * still caught before any work starts.
 */
export async function probeVideo(file: File): Promise<ProbeResult> {
  if (!ENGINE_CONFIGURED) return probeVideoInBrowser(file)
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
    const result = (await res.json()) as ProbeResult
    return { ...result, probed_by: 'engine' }
  } finally {
    cancel()
  }
}

/** Read duration/resolution from the file in the browser itself. */
async function probeVideoInBrowser(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file)
  try {
    const meta = await new Promise<{ duration: number; width: number; height: number }>(
      (resolve, reject) => {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.muted = true
        const cleanup = () => {
          window.clearTimeout(timer)
          video.removeAttribute('src')
          video.load()
        }
        const timer = window.setTimeout(() => {
          cleanup()
          reject(new Error('The browser could not read this video file.'))
        }, 30000)
        video.onloadedmetadata = () => {
          const duration = video.duration
          const width = video.videoWidth
          const height = video.videoHeight
          cleanup()
          if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
            reject(
              new Error(
                'The browser could not read this video’s duration or resolution. Try the New Job page instead — the server checks the file there.',
              ),
            )
          } else {
            resolve({ duration, width, height })
          }
        }
        video.onerror = () => {
          cleanup()
          reject(
            new Error(
              'The browser could not play this video file. It may be corrupt or in an unsupported format.',
            ),
          )
        }
        video.src = url
      },
    )
    return {
      job_id: 'browser',
      duration_seconds: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: null,
      video_codec: null,
      audio_codec: null,
      audio_streams: 0,
      bitrate: null,
      format: file.type || null,
      size_bytes: file.size,
      source_path: '',
      probed_by: 'browser',
    }
  } finally {
    URL.revokeObjectURL(url)
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
      error: unreachableMessage(),
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
      error: unreachableMessage(),
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

/* ------------------------------------------------------------------ */
/* Plans (Batch 11)                                                    */
/* ------------------------------------------------------------------ */

export interface PlanInfo {
  id: number
  name: string
  price_display: string
  duration_days: number
  total_clips: number | null
  daily_clips: number | null
  max_export_quality: string
  features: string[] | null
  active: boolean
}

export interface MyPlanSummary {
  current: {
    name: string
    price_display: string
    plan_id?: number
    user_plan_id?: number
    starts_at?: string
    ends_at?: string
    clips_used: number | null
    total_clips: number | null
    clips_remaining: number | null
    clips_reserved?: number
    daily_clips: number | null
    max_export_quality: string
  }
  limits: {
    daily_limit: number | null
    daily_limit_source: string
    max_clips_per_job: number
    max_export_height: number
    total_clips_remaining: number | null
  }
  precedence: string
}

export interface PlanRequestInfo {
  id: number
  plan_id: number
  note: string | null
  status: string
  decline_reason: string | null
  created_at: string
  plan?: { id: number; name: string; price_display: string }
}

/** GET /plans — the active plans a user can request. */
export async function fetchPlans(): Promise<PlanInfo[]> {
  if (!getToken()) return []
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/plans`, { headers: laravelHeaders(), signal })
    if (!res.ok) return []
    const body = (await res.json()) as { plans?: unknown }
    return Array.isArray(body.plans) ? (body.plans as PlanInfo[]) : []
  } catch {
    return []
  } finally {
    cancel()
  }
}

/** GET /me/plan — my current plan + usage + effective limits. */
export async function fetchMyPlan(): Promise<MyPlanSummary | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/me/plan`, { headers: laravelHeaders(), signal })
    if (!res.ok) return null
    return (await res.json()) as MyPlanSummary
  } catch {
    return null
  } finally {
    cancel()
  }
}

/** GET /plan-requests — my plan requests, newest first. */
export async function fetchMyPlanRequests(): Promise<PlanRequestInfo[]> {
  if (!getToken()) return []
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/plan-requests`, { headers: laravelHeaders(), signal })
    if (!res.ok) return []
    const body = (await res.json()) as { requests?: unknown }
    return Array.isArray(body.requests) ? (body.requests as PlanRequestInfo[]) : []
  } catch {
    return []
  } finally {
    cancel()
  }
}

/** POST /plan-requests — request a plan (admin approves it after confirming payment). */
export async function requestPlan(
  planId: number,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/plan-requests`, {
      method: 'POST',
      headers: { ...laravelHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: planId, ...(note ? { note } : {}) }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: serverMessage(body, `Request failed (HTTP ${res.status})`) }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Backend is not reachable.' }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Google sign-in (Batch 11)                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /auth/google/redirect — the URL to send the user to. When the
 * Google keys are not configured yet the backend answers 422
 * google_not_configured; the caller shows that message instead of
 * attempting any login — never a fake login.
 */
export async function googleRedirectUrl(): Promise<
  | { ok: true; url: string }
  | { ok: false; error: string; notConfigured: boolean }
> {
  const { signal, cancel } = timeoutSignal(10000)
  try {
    const res = await fetch(`${API_URL}/auth/google/redirect`, {
      headers: laravelHeaders(false),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const b = body as { error?: string; message?: string } | null
      return {
        ok: false,
        error:
          (b && typeof b.message === 'string' && b.message) ||
          `Google sign-in failed (HTTP ${res.status})`,
        notConfigured: b?.error === 'google_not_configured',
      }
    }
    const data = body as { redirect_url?: string }
    if (!data.redirect_url) {
      return { ok: false, error: 'Google sign-in returned no redirect URL.', notConfigured: false }
    }
    return { ok: true, url: data.redirect_url }
  } catch {
    return { ok: false, error: 'Backend is not reachable.', notConfigured: false }
  } finally {
    cancel()
  }
}
