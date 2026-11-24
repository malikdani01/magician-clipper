/**
 * Job API client — Magician Clipper Phase 3 (New Job UI).
 *
 * Builds strictly against docs/api.md (the Phase 3 Job System contract):
 *   POST /api/v1/jobs        create a job (file OR link + dropdown settings)
 *   GET  /api/v1/jobs        list my jobs (paginated, `status` filter)
 *   GET  /api/v1/jobs/{id}   get one job — poll this for status + clips
 *   POST /api/v1/jobs/{id}/cancel
 *   POST /api/v1/jobs/{id}/retry
 *   GET  /api/v1/clips/{clip}/download   (via the clip's download_url)
 *
 * No mock data: every function hits the real Laravel backend and surfaces
 * the backend's exact error message on failure. Auth is the Sanctum
 * bearer token from lib/api (getToken).
 *
 * NOTE: the clip download_url is an absolute backend URL that requires
 * the bearer token, so downloads go through fetch + blob, not a plain
 * <a href> (a plain link would send no Authorization header and 401).
 */

import { API_URL, getToken } from './api'

export type JobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'

/** Clip layout (9:16 only — other ratios fall back to centre crop). */
export type ClipLayout =
  | 'center_crop'
  | 'split'
  | 'pip_facecam'
  | 'blur_fill'
  | 'streamer_full'

export const LAYOUT_LABELS: Record<ClipLayout, string> = {
  center_crop: 'Centre crop (full frame)',
  split: 'Split — streamer top, gameplay bottom',
  pip_facecam: 'Gameplay full + facecam corner',
  blur_fill: 'Blurred background fill',
  streamer_full: 'Streamer full frame',
}

/** How clips are picked from the source (per job). */
export type SelectionMode = 'interesting_only' | 'fill_any'

export const SELECTION_MODE_LABELS: Record<SelectionMode, string> = {
  interesting_only: 'Interesting only',
  fill_any: 'Any parts — fill to count',
}

export const SELECTION_MODE_DESCRIPTIONS: Record<SelectionMode, string> = {
  interesting_only: 'Only the best parts — fewer clips if fewer good parts exist.',
  fill_any:
    'Always the full count — fills with any part of the video when good parts run out.',
}

export interface JobSettings {
  platform: 'tiktok' | 'instagram'
  aspect_ratio: '9:16' | '16:9' | '1:1' | '4:5'
  clip_count: number
  duration_mode: 'exact' | 'minimum' | 'maximum'
  duration_seconds: number
  duration_min_seconds: number | null
  duration_max_seconds: number | null
  captions_enabled: boolean
  captions_language: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  /** Burn-in caption style; absent on jobs created before styles existed. */
  caption_style?: string
  /** Clip selection mode; absent on jobs created before the mode existed. */
  selection_mode?: string
  on_screen_text: boolean
  job_type: 'myself' | 'campaign'
  campaign_requirements: string | null
  /** Free-text notes for Muse (campaign brief, extra instructions). */
  notes?: string | null
  layout: ClipLayout
  content_type: string
  quality: 'draft' | 'standard' | 'high'
  source_type: 'upload' | 'link'
  source_url: string | null
  source_path: string | null
}

export interface JobClip {
  id: number
  title: string
  status: string
  start_seconds: number | null
  end_seconds: number | null
  duration_seconds: number | null
  aspect_ratio: string | null
  file_size_bytes: number | null
  score: number | null
  reason: string | null
  /** Per-signal viral-score breakdown (label -> 0-100), when the worker sent one. Null for older clips. */
  score_breakdown: Record<string, number> | null
  transcript_excerpt: string | null
  download_url: string
  /** First-frame JPEG path (null for clips rendered before thumbnails). */
  thumbnail_path: string | null
  /** Caption style burned into this clip (null when rendered before styles were stored). */
  caption_style: string | null
  created_at: string
}

export interface Job {
  id: number
  project_id: number
  status: JobStatus
  state: string
  stage: string | null
  progress: number | null
  /** Worker note: why fewer clips came back, or why some failed. */
  note: string | null
  settings: JobSettings | null
  source_type: 'upload' | 'link'
  source_url: string | null
  clips: JobClip[]
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type JobResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; status?: number }

export interface CreateJobInput {
  /** Exactly one of `file` / `sourceUrl` must be set. */
  file?: File | null
  sourceUrl?: string
  platform: 'tiktok' | 'instagram'
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5'
  clipCount: number
  durationMode: 'exact' | 'minimum' | 'maximum'
  /** Exact length, or the min/max bound per mode (see NewJobPage). */
  durationSeconds: number
  durationMinSeconds?: number | null
  durationMaxSeconds?: number | null
  captionsEnabled: boolean
  captionsLanguage: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  /** Burn-in caption style id (see lib/captionStyles); defaults to 'punchy'. */
  captionStyle: string
  /** Clip selection mode (see SELECTION_MODE_LABELS); defaults to 'interesting_only'. */
  selectionMode?: SelectionMode
  onScreenText: boolean
  jobType: 'myself' | 'campaign'
  campaignRequirements?: string
  /** Free-text notes for Muse (campaign brief, extra instructions). */
  notes?: string
  layout: ClipLayout
  contentType: string
  quality: 'draft' | 'standard' | 'high'
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * The backend's exact error message: `message` first, then the first
 * Laravel validation error, then a fallback. Never invents a message.
 */
function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string' && b.message) return b.message
    if (typeof b.detail === 'string' && b.detail) return b.detail
    if (b.errors && typeof b.errors === 'object') {
      const entries = Object.entries(b.errors as Record<string, unknown>)
      const messages = entries.flatMap(([field, msgs]) =>
        Array.isArray(msgs)
          ? msgs.filter((m): m is string => typeof m === 'string').map((m) => `${field}: ${m}`)
          : [],
      )
      if (messages.length > 0) return messages.join(' ')
    }
  }
  return fallback
}

function isUnreachable(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && err.name === 'AbortError') ||
    /failed to fetch|networkerror|load failed|ECONNREFUSED/i.test(
      err instanceof Error ? err.message : String(err),
    )
  )
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * POST /api/v1/jobs. File source → multipart; link source → JSON.
 * 120s timeout: a 2 GiB upload can take a while on a slow link.
 */
export async function createJob(input: CreateJobInput): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to create a job.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    let res: Response
    if (input.file) {
      const form = new FormData()
      form.append('file', input.file)
      form.append('platform', input.platform)
      form.append('aspect_ratio', input.aspectRatio)
      form.append('clip_count', String(input.clipCount))
      form.append('duration_mode', input.durationMode)
      form.append('duration_seconds', String(input.durationSeconds))
      if (input.durationMinSeconds != null) {
        form.append('duration_min_seconds', String(input.durationMinSeconds))
      }
      if (input.durationMaxSeconds != null) {
        form.append('duration_max_seconds', String(input.durationMaxSeconds))
      }
      form.append('captions_enabled', String(input.captionsEnabled))
      form.append('captions_language', input.captionsLanguage)
      form.append('caption_style', input.captionStyle)
      form.append('selection_mode', input.selectionMode ?? 'interesting_only')
      form.append('on_screen_text', String(input.onScreenText))
      form.append('job_type', input.jobType)
      if (input.jobType === 'campaign' && input.campaignRequirements) {
        form.append('campaign_requirements', input.campaignRequirements)
      }
      if (input.notes) {
        form.append('notes', input.notes)
      }
      form.append('layout', input.layout)
      form.append('content_type', input.contentType)
      form.append('quality', input.quality)
      res = await fetch(`${API_URL}/jobs`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal,
      })
    } else {
      res = await fetch(`${API_URL}/jobs`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: input.sourceUrl,
          platform: input.platform,
          aspect_ratio: input.aspectRatio,
          clip_count: input.clipCount,
          duration_mode: input.durationMode,
          duration_seconds: input.durationSeconds,
          duration_min_seconds: input.durationMinSeconds ?? null,
          duration_max_seconds: input.durationMaxSeconds ?? null,
          captions_enabled: input.captionsEnabled,
          captions_language: input.captionsLanguage,
          caption_style: input.captionStyle,
          selection_mode: input.selectionMode ?? 'interesting_only',
          on_screen_text: input.onScreenText,
          job_type: input.jobType,
          campaign_requirements:
            input.jobType === 'campaign' ? (input.campaignRequirements ?? null) : null,
          notes: input.notes ?? null,
          layout: input.layout,
          content_type: input.contentType,
          quality: input.quality,
        }),
        signal,
      })
    }
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not create the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: 'The server created the job but returned an unusable response.' }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — start it with php artisan serve (http://127.0.0.1:8000).'
        : err instanceof Error
          ? err.message
          : 'Could not create the job.',
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* List / get                                                          */
/* ------------------------------------------------------------------ */

export interface JobListPage {
  jobs: Job[]
  total: number
  currentPage: number
  lastPage: number
}

/**
 * GET /api/v1/jobs — Laravel paginator shape:
 * `{ data: [...], total, current_page, last_page, ... }`.
 * Returns an empty page (not an error) when signed out, so list pages
 * can show their sign-in state instead of a crash.
 */
export async function listJobs(
  opts: { status?: JobStatus | 'all'; page?: number; perPage?: number } = {},
): Promise<JobListPage> {
  const empty: JobListPage = { jobs: [], total: 0, currentPage: 1, lastPage: 1 }
  if (!getToken()) return empty
  const params = new URLSearchParams()
  if (opts.status && opts.status !== 'all') params.set('status', opts.status)
  params.set('page', String(opts.page ?? 1))
  params.set('per_page', String(opts.perPage ?? 20))
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs?${params.toString()}`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return empty
    const body = (await res.json()) as {
      data?: Job[]
      total?: number
      current_page?: number
      last_page?: number
    }
    return {
      jobs: Array.isArray(body.data) ? body.data : [],
      total: typeof body.total === 'number' ? body.total : 0,
      currentPage: typeof body.current_page === 'number' ? body.current_page : 1,
      lastPage: typeof body.last_page === 'number' ? body.last_page : 1,
    }
  } catch {
    return empty
  } finally {
    cancel()
  }
}

/** GET /api/v1/jobs/{id} — 404 means not found or not owned by the caller. */
export async function getJob(id: number): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to view this job.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs/${id}`, {
      headers: authHeaders(),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (res.status === 404) {
      return { ok: false, error: 'Job not found. It may have been deleted or belong to another account.', status: 404 }
    }
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not load the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: 'The server returned an unusable job.' }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — start it with php artisan serve (http://127.0.0.1:8000).'
        : err instanceof Error
          ? err.message
          : 'Could not load the job.',
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Cancel / retry (both supported by the user-facing API)              */
/* ------------------------------------------------------------------ */

export async function cancelJob(id: number): Promise<JobResult> {
  return postJobAction(id, 'cancel')
}

export async function retryJob(id: number): Promise<JobResult> {
  return postJobAction(id, 'retry')
}

async function postJobAction(id: number, action: 'cancel' | 'retry'): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to do that.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs/${id}/${action}`, {
      method: 'POST',
      headers: authHeaders(),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not ${action} the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: `The server did not return the updated job after ${action}.` }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : `Could not ${action} the job.`,
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Clip re-renders (queue a clip with a different caption style)       */
/* ------------------------------------------------------------------ */

/** One re-render request for a clip (see ClipRerender in the backend). */
export interface ClipRerender {
  id: number
  clip_id: number
  caption_style: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  error_message: string | null
  created_at: string
  updated_at: string
}

export type RerenderResult =
  | { ok: true; rerender: ClipRerender }
  | { ok: false; error: string; status?: number }

/**
 * POST /api/v1/clips/{id}/render — queue a re-render of one clip with a
 * different caption style. The worker re-renders the SAME window and
 * replaces the file in place; the job page polls getClipRerenders.
 */
export async function requestClipRerender(
  clipId: number,
  captionStyle: string,
): Promise<RerenderResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to re-render a clip.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/render`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption_style: captionStyle }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not queue the re-render (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const rerender = (body as { rerender?: ClipRerender }).rerender
    if (!rerender || typeof rerender.id !== 'number') {
      return { ok: false, error: 'The server did not return the queued re-render.' }
    }
    return { ok: true, rerender }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : 'Could not queue the re-render.',
    }
  } finally {
    cancel()
  }
}

/** GET /api/v1/clips/{id}/rerenders — re-render history, latest first. */
export async function getClipRerenders(clipId: number): Promise<ClipRerender[]> {
  if (!getToken()) return []
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/rerenders`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { rerenders?: ClipRerender[] }
    return Array.isArray(body.rerenders) ? body.rerenders : []
  } catch {
    return []
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Clip download                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch a clip's first-frame thumbnail (GET /api/v1/clips/{id}/thumbnail)
 * with the bearer token and return an object URL for an <img>, or null
 * when the clip has no thumbnail (clips rendered before thumbnails
 * existed, or the file is missing). The caller owns the object URL.
 */
export async function fetchClipThumbnail(clipId: number): Promise<string | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/thumbnail`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  } finally {
    cancel()
  }
}

/**
 * Fetch one clip's MP4 as a blob via its download_url with the bearer
 * token. Shared by downloads and the in-app preview player. Returns the
 * exact backend error when the file is not ready / not found.
 */
export async function fetchClipBlob(clip: JobClip): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to download clips.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(clip.download_url, {
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
    return { ok: true, blob: await res.blob() }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — the clip could not be downloaded.'
        : err instanceof Error
          ? err.message
          : 'Download failed.',
    }
  } finally {
    cancel()
  }
}

/**
 * Download one clip via its download_url with the bearer token, then
 * trigger a browser download of the real MP4. Returns the exact
 * backend error when the file is not ready / not found.
 */
export async function downloadClip(clip: JobClip): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await fetchClipBlob(clip)
  if (!result.ok) return result
  const url = URL.createObjectURL(result.blob)
  const safeTitle = (clip.title || `clip-${clip.id}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeTitle}.mp4`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { ok: true }
}

/**
 * POST /api/v1/clips/zip — download several clips as one ZIP. The
 * server builds the ZIP from the clip files still on disk and skips
 * files wiped by a server restart; the skipped count comes back in the
 * X-Clips-Skipped header (0 when everything was there). When none of
 * the selected clips still have files, the server answers 404 with an
 * honest message instead of an empty ZIP.
 */
export async function downloadClipsZip(
  clipIds: number[],
): Promise<
  | { ok: true; included: number; skipped: number }
  | { ok: false; error: string }
> {
  if (!getToken()) return { ok: false, error: 'Sign in to download clips.' }
  if (clipIds.length === 0) return { ok: false, error: 'Select at least one clip first.' }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${API_URL}/clips/zip`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_ids: clipIds }),
      signal,
    })
    if (!res.ok) {
      let detail = `Could not build the ZIP (HTTP ${res.status})`
      try {
        const body: unknown = await res.json()
        detail = serverMessage(body, detail)
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      return { ok: false, error: detail }
    }
    const blob = await res.blob()
    const included = Number(res.headers.get('X-Clips-Included') ?? clipIds.length)
    const skipped = Number(res.headers.get('X-Clips-Skipped') ?? 0)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clips-${new Date().toISOString().slice(0, 10)}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true, included, skipped }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — the ZIP could not be built.'
        : err instanceof Error
          ? err.message
          : 'Could not build the ZIP.',
    }
  } finally {
    cancel()
  }
}
