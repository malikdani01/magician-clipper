/**
 * Laravel projects API — the server-side project list with real counts.
 * Used by My Projects and Export Center to show honest clip counts:
 * GET /api/v1/projects returns each project with clips_count,
 * media_assets_count and processing_jobs_count (withCount).
 */

import { API_URL, getToken } from './api'

export interface LaravelProject {
  id: number
  title: string
  status: string
  clips_count: number
  media_assets_count: number
  processing_jobs_count: number
  created_at: string
  updated_at: string
}

/** GET /api/v1/projects — the signed-in user's projects with counts. */
export async function listLaravelProjects(): Promise<LaravelProject[]> {
  if (!getToken()) return []
  try {
    const res = await fetch(`${API_URL}/projects?per_page=50`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: LaravelProject[] }
    return Array.isArray(body.data) ? body.data : []
  } catch {
    return []
  }
}

export interface ProjectClipSummary {
  id: number
  title: string
  thumbnail_path: string | null
  duration_seconds: number | null
  file_size_bytes: number | null
  score: number | null
  /** Caption style burned into this clip (null when rendered before styles were stored). */
  caption_style: string | null
  /** The transcribed lines burned into this clip (null when none). */
  transcript_excerpt: string | null
}

/** GET /api/v1/projects/{id}/clips — the project's clips, newest first. */
export async function listProjectClips(projectId: number): Promise<ProjectClipSummary[]> {
  if (!getToken()) return []
  try {
    const res = await fetch(`${API_URL}/projects/${projectId}/clips?per_page=20`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { clips?: { data?: ProjectClipSummary[] } }
    const data = body.clips?.data
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
