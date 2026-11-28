/**
 * Best-settings insights API client — GET /api/v1/insights/settings.
 *
 * A real aggregation of the signed-in user's OWN Ready jobs: for
 * caption style, layout and duration mode, the average viral score
 * (0–100) and job count per value — only for values with at least 3
 * Ready jobs. Anything with fewer jobs is omitted by the backend, so
 * an empty list honestly means "not enough data yet", never a
 * fabricated insight.
 */

import { API_URL, getToken } from './api'

export interface InsightRow {
  value: string
  average_score: number
  job_count: number
}

export interface SettingsInsights {
  caption_style: InsightRow[]
  layout: InsightRow[]
  duration_mode: InsightRow[]
}

const EMPTY: SettingsInsights = { caption_style: [], layout: [], duration_mode: [] }

/** GET /api/v1/insights/settings — empty lists when nothing qualifies. */
export async function fetchSettingsInsights(): Promise<SettingsInsights> {
  if (!getToken()) return EMPTY
  try {
    const res = await fetch(`${API_URL}/insights/settings`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) return EMPTY
    const body = (await res.json()) as Partial<SettingsInsights>
    return {
      caption_style: Array.isArray(body.caption_style) ? body.caption_style : [],
      layout: Array.isArray(body.layout) ? body.layout : [],
      duration_mode: Array.isArray(body.duration_mode) ? body.duration_mode : [],
    }
  } catch {
    return EMPTY
  }
}

/** Batch 15: one aggregated row of REAL posted results — average
 * views across the user's own clips with that value, only for
 * values with at least 3 clips. Fewer clips means the row is
 * omitted by the backend, never guessed. */
export interface PerformanceInsightRow {
  value: string
  average_views: number
  clip_count: number
}

export interface PerformanceInsights {
  total_clips: number
  caption_style: PerformanceInsightRow[]
  duration_band: PerformanceInsightRow[]
}

const EMPTY_PERFORMANCE: PerformanceInsights = {
  total_clips: 0,
  caption_style: [],
  duration_band: [],
}

/** GET /api/v1/insights/performance — honest empty lists when the
 * user has not entered any posted results yet. */
export async function fetchPerformanceInsights(): Promise<PerformanceInsights> {
  if (!getToken()) return EMPTY_PERFORMANCE
  try {
    const res = await fetch(`${API_URL}/insights/performance`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) return EMPTY_PERFORMANCE
    const body = (await res.json()) as Partial<PerformanceInsights>
    return {
      total_clips: typeof body.total_clips === 'number' ? body.total_clips : 0,
      caption_style: Array.isArray(body.caption_style) ? body.caption_style : [],
      duration_band: Array.isArray(body.duration_band) ? body.duration_band : [],
    }
  } catch {
    return EMPTY_PERFORMANCE
  }
}
