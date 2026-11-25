import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { API_URL, getToken } from './api'

/**
 * Batch 10 (2026-11-25): platform gating — GET /api/v1/platform.
 * The backend owns enforcement (it rejects disabled features and
 * blocks job creation with 503 during maintenance); this module is
 * the frontend mirror: it hides disabled controls and shows honest
 * notes instead of dead buttons. A failed / unauthenticated fetch
 * returns null and the UI renders ungated (never flash-hide on a
 * loading or failed state).
 */

export interface PlatformLimits {
  free_daily_limit: number
  max_clips_per_job: number
  max_bulk_files: number
  max_upload_mb: number
}

export interface PlatformFeatures {
  captions: boolean
  on_screen_text: boolean
  beat_sync: boolean
  translation: boolean
  logo_overlay: boolean
  intro_outro: boolean
  music_bed_sfx: boolean
  cloud_storage: boolean
  bulk_jobs: boolean
  clip_rerender: boolean
  favourites: boolean
  thumbnail_picker: boolean
}

export interface PlatformPages {
  library: boolean
  brand_kit: boolean
  exports: boolean
  usage: boolean
  help: boolean
  editor: boolean
}

export interface PlatformMaintenance {
  enabled: boolean
  message: string
}

export interface PlatformDaily {
  /** Null for admins (unlimited). */
  limit: number | null
  used_today: number
  remaining: number
}

export interface PlatformPayload {
  limits: PlatformLimits
  features: PlatformFeatures
  pages: PlatformPages
  maintenance: PlatformMaintenance
  announcement: string | null
  daily: PlatformDaily
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Minimal shape check — the backend contract is fixed; anything else is not a platform payload. */
function isPlatformPayload(body: unknown): body is PlatformPayload {
  if (!isRecord(body)) return false
  return (
    isRecord(body.limits) &&
    isRecord(body.features) &&
    isRecord(body.pages) &&
    isRecord(body.maintenance) &&
    isRecord(body.daily)
  )
}

/**
 * GET /api/v1/platform with the Sanctum Bearer token.
 * Returns the typed payload, or null on failure / unauthenticated
 * (no token, non-OK status, network error, unexpected shape).
 */
export async function fetchPlatform(): Promise<PlatformPayload | null> {
  const token = getToken()
  if (!token) return null
  try {
    const res = await fetch(`${API_URL}/platform`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body: unknown = await res.json().catch(() => null)
    return isPlatformPayload(body) ? body : null
  } catch {
    return null
  }
}

interface PlatformState {
  platform: PlatformPayload | null
  loading: boolean
}

const PlatformContext = createContext<PlatformState | null>(null)

/**
 * Fetches the platform payload once when a token exists and shares
 * it with every page under the shell. Mounted inside AppShell (see
 * layout/AppShell.tsx) — App.tsx itself is untouched.
 */
export function PlatformProvider({ children }: { children: ReactNode }) {
  const [platform, setPlatform] = useState<PlatformPayload | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    if (!getToken()) {
      setLoading(false)
      return undefined
    }
    void fetchPlatform().then((result) => {
      if (!cancelled) {
        setPlatform(result)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PlatformContext.Provider value={{ platform, loading }}>
      {children}
    </PlatformContext.Provider>
  )
}

export function usePlatform(): PlatformState {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error('usePlatform must be used inside <PlatformProvider>')
  return ctx
}
