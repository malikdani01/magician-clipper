/**
 * Job presets API client — GET/POST/DELETE /api/v1/presets.
 * A preset is a named snapshot of the New Job settings (no source —
 * the video/link is always chosen fresh when the preset is loaded).
 * All calls hit the real Laravel backend; errors surface the backend's
 * exact message.
 */

import { API_URL, getToken } from './api'
import type { CaptionPosition, ClipLayout, ColourGrade, HeadlineStyle, OstLanguage, OstPosition, SelectionMode, Sfx, TranslationLanguageCode } from './jobs'

export interface PresetSettings {
  platform: 'tiktok' | 'instagram'
  aspect_ratio: '9:16' | '16:9' | '1:1' | '4:5'
  clip_count: number
  duration_mode: 'exact' | 'minimum' | 'maximum'
  duration_seconds: number
  duration_min_seconds: number | null
  duration_max_seconds: number | null
  captions_enabled: boolean
  captions_language: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  caption_style: string
  selection_mode: SelectionMode
  on_screen_text: boolean
  /** Batch 1 enhancements (2026-11-25); default ON. */
  auto_zoom: boolean
  face_tracking: boolean
  silence_removal: boolean
  filler_removal: boolean
  /** Batch 2 headline look + caption position (2026-11-25); defaults
   * bold_bar / bottom. */
  headline_style: HeadlineStyle
  caption_position: CaptionPosition
  /** Batch 9 OST position (2026-11-25); absent on old presets, where
   * the job default derives from the headline style. */
  ost_position?: OstPosition
  /** Batch 9 OST language (2026-11-25); absent on old presets,
   * where the headline stays in the source language. */
  ost_language?: OstLanguage
  /** Batch 9 SFX sting (2026-11-25); absent means 'none'. */
  sfx?: Sfx
  /** Batch 9 colour grade (2026-11-25); absent means 'none' —
   * no filter, the render pipeline is untouched. */
  colour_grade?: ColourGrade
  /** Batch 3 beat sync (2026-11-25); default ON. */
  beat_sync: boolean
  /** Batch 3 caption translation (2026-11-25; broadened Batch 9);
   * default 'none'. */
  caption_translation: 'none' | TranslationLanguageCode
  /** Batch 3 export ratios (2026-11-25); default ['9:16']. */
  export_ratios: string[]
  /** Batch 11 export tier (2026-11-25); absent on old presets,
   * where the wizard keeps '720p'. */
  export_quality?: '720p' | '1080p'
  /** Batch 4 logo overlay (2026-11-25); default OFF. */
  logo_overlay: boolean
  /** Batch 6 caption safe zone (2026-11-25); default ON. */
  caption_safe_zone: boolean
  /** Batch 7 whole-clip on-screen text (2026-11-25); defaults OFF /
   * 'none' / null (empty text = OFF). */
  ost_persistent: boolean
  ost_animation: 'none' | 'slide' | 'fade' | 'pop'
  end_card: boolean
  end_card_text: string | null
  keyword_popups: boolean
  lower_third_text: string | null
  progress_bar: boolean
  job_type: 'myself' | 'campaign'
  campaign_requirements: string | null
  notes: string | null
  layout: ClipLayout
  content_type: string
  quality: 'draft' | 'standard' | 'high'
}

export interface JobPreset {
  id: number
  name: string
  settings: PresetSettings
  created_at: string
  updated_at: string
}

export type PresetResult =
  | { ok: true; preset: JobPreset }
  | { ok: false; error: string; status?: number }

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

/** GET /api/v1/presets — the signed-in user's presets, newest first. */
export async function listPresets(): Promise<JobPreset[]> {
  if (!getToken()) return []
  try {
    const res = await fetch(`${API_URL}/presets`, { headers: authHeaders() })
    if (!res.ok) return []
    const body = (await res.json()) as { presets?: JobPreset[] }
    return Array.isArray(body.presets) ? body.presets : []
  } catch {
    return []
  }
}

/** POST /api/v1/presets — save the current New Job settings under a name. */
export async function createPreset(
  name: string,
  settings: PresetSettings,
): Promise<PresetResult> {
  if (!getToken()) return { ok: false, error: 'Sign in to save a preset.' }
  try {
    const res = await fetch(`${API_URL}/presets`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, settings }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not save the preset (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const preset = (body as { preset?: JobPreset }).preset
    if (!preset || typeof preset.id !== 'number') {
      return { ok: false, error: 'The server did not return the saved preset.' }
    }
    return { ok: true, preset }
  } catch {
    return { ok: false, error: 'Backend is not reachable.' }
  }
}

/** DELETE /api/v1/presets/{id} — delete one of my presets. */
export async function deletePreset(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!getToken()) return { ok: false, error: 'Sign in to delete a preset.' }
  try {
    const res = await fetch(`${API_URL}/presets/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      return {
        ok: false,
        error: serverMessage(body, `Could not delete the preset (HTTP ${res.status})`),
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Backend is not reachable.' }
  }
}
