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
