import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createLaravelProject,
  deleteLaravelProject,
  getToken,
  listLaravelProjects,
  updateLaravelProject,
} from '../lib/api'
import type { CaptionTranslation, ClipLayout, OstLanguage } from '../lib/jobs'

/**
 * Project store — Phase 2.
 *
 * Browser records (metadata + clip spec) live in localStorage under
 * `magician-clipper.projects.v1`. Video bytes NEVER go in localStorage:
 * the File object itself is kept in an in-memory Map (see
 * setProjectFile / getProjectFile) and is gone when the tab closes.
 *
 * When signed in, Laravel projects are merged in by laravelId. A
 * Laravel row with no browser record appears as a project whose media
 * is not in this browser (fileName '' and null media fields) — the
 * user must re-attach the source file.
 */

export interface ClipSpec {
  platform: 'tiktok' | 'instagram'
  aspect: '9:16' | '16:9' | '1:1' | '4:5'
  clipCount: number
  durationMode: 'exact' | 'minimum' | 'maximum'
  durationSeconds: number
  captions: boolean
  onScreenText: boolean
  /** Batch 1 enhancements (2026-11-25); default ON. */
  autoZoom: boolean
  faceTracking: boolean
  silenceRemoval: boolean
  fillerRemoval: boolean
  /** Batch 2 headline look + caption position (2026-11-25); defaults
   * bold_bar / bottom (the pre-Batch-2 behaviour). */
  headlineStyle: 'bold_bar' | 'lower_third' | 'big_centre'
  captionPosition: 'bottom' | 'top' | 'middle'
  /** Batch 9 OST position (2026-11-25) — where the headline sits,
   * independent of the look; default follows the headline style
   * (bold_bar -> top, lower_third -> bottom, big_centre -> centre). */
  ostPosition: 'top' | 'centre' | 'bottom'
  /** Batch 9 SFX sting (2026-11-25); default 'none'. */
  sfx: 'none' | 'whoosh' | 'pop' | 'whoosh_pop'
  /** Batch 9 colour grade (2026-11-25); Batch 13 default 'auto'
   * (the worker picks the look per clip) — 'none' means no filter,
   * the render pipeline is untouched. */
  colourGrade: 'auto' | 'none' | 'clean' | 'vibrant' | 'warm' | 'cool' | 'cinematic' | 'mono' | 'vintage'
  /** Batch 3 beat sync (2026-11-25); default ON. */
  beatSync: boolean
  /** Batch 3 caption translation (2026-11-25; broadened Batch 9
   * to 32 languages); default 'none'. */
  captionTranslation: CaptionTranslation
  /** Batch 3 export ratios (2026-11-25); default ['9:16'] — 9:16 is
   * always on, 1:1 and 16:9 are optional extras. */
  exportRatios: string[]
  /** Batch 11 export tier (2026-11-25) — '720p' (Free) or '1080p'
   * (paid plan). The tier caps resolution + bitrate only; the
   * render quality (draft/standard/high) is separate. The server
   * enforces the cap from the user's plan, so a stale '1080p'
   * here is rejected at submit with an upgrade hint. */
  exportQuality: '720p' | '1080p'
  /** Batch 4 logo overlay (2026-11-25); default OFF. */
  logoOverlay: boolean
  /** Batch 6 caption safe zone (2026-11-25); default ON — keep
   * captions clear of TikTok's right action rail and bottom bar. */
  captionSafeZone: boolean
  /** Batch 7 whole-clip on-screen text (2026-11-25); defaults OFF /
   * 'none' / '' (empty text = OFF). */
  ostPersistent: boolean
  ostAnimation: 'none' | 'slide' | 'fade' | 'pop'
  endCard: boolean
  endCardText: string
  keywordPopups: boolean
  lowerThirdText: string
  progressBar: boolean
  /** How clips are picked: best parts only, or any parts to fill the count. */
  selectionMode: 'interesting_only' | 'fill_any'
  /** Batch 9 wizard parity (2026-11-25) — the fields the New Job
   * page had and the wizard was missing. Duration range: the min/max
   * pair for minimum/maximum modes (defaults 30–90s, like New Job);
   * job type + campaign requirements (requirements required when
   * campaign); layout (9:16 only — other ratios fall back to centre
   * crop at submit); quality (the direct control — kept in sync
   * with processingMode, see Clipper.tsx); captions language (which
   * language the speech is in); caption style as a REAL style id
   * (the picker stores real ids now — legacy preset ids map through
   * translateLegacyCaptionPreset only when loading an old preset);
   * OST language ('source' = the video's own language). */
  durationMinSeconds: number
  durationMaxSeconds: number
  jobType: 'myself' | 'campaign'
  campaignRequirements: string
  /** Batch 12 campaign requirements (2026-11-25) — the full pasted
   * brief. Batch 14: the wizard sends ONLY the brief now — the
   * structured fields it used to carry (post caption, hashtags,
   * on-screen text, each with a Required/Optional selector, plus
   * the OST hint) are gone; the backend parses the brief and
   * derives them at creation. */
  layout: ClipLayout
  quality: 'draft' | 'standard' | 'high'
  captionsLanguage: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  captionStyle: string
  ostLanguage: OstLanguage
  contentType:
    | 'podcast'
    | 'interview'
    | 'education'
    | 'gaming'
    | 'commentary'
    | 'story'
    | 'general'
  keywords: string
  processingMode: 'eco' | 'balanced' | 'fast'
}

export function defaultClipSpec(): ClipSpec {
  return {
    platform: 'tiktok',
    aspect: '9:16',
    clipCount: 3,
    durationMode: 'exact',
    durationSeconds: 20,
    captions: true,
    onScreenText: false,
    autoZoom: true,
    faceTracking: true,
    silenceRemoval: true,
    fillerRemoval: true,
    headlineStyle: 'bold_bar',
    captionPosition: 'bottom',
    ostPosition: 'top',
    sfx: 'none',
    colourGrade: 'auto',
    beatSync: true,
    captionTranslation: 'none',
    exportRatios: ['9:16'],
    exportQuality: '720p',
    logoOverlay: false,
    captionSafeZone: true,
    ostPersistent: false,
    ostAnimation: 'none',
    endCard: false,
    endCardText: '',
    keywordPopups: false,
    lowerThirdText: '',
    progressBar: false,
    selectionMode: 'interesting_only',
    contentType: 'general',
    keywords: '',
    processingMode: 'balanced',
    durationMinSeconds: 30,
    durationMaxSeconds: 90,
    jobType: 'myself',
    campaignRequirements: '',
    layout: 'center_crop',
    quality: 'standard',
    captionsLanguage: 'english',
    captionStyle: 'punchy',
    ostLanguage: 'source',
  }
}

export interface ProjectRecord {
  id: string
  laravelId: number | null
  title: string
  fileName: string
  fileSize: number
  durationSeconds: number | null
  width: number | null
  height: number | null
  fps: number | null
  videoCodec: string | null
  audioCodec: string | null
  audioStreams: number
  jobId: string | null
  spec: ClipSpec | null
  /** Trim saved by the Studio Editor (Save Draft), in seconds. */
  trimStartSeconds?: number | null
  trimEndSeconds?: number | null
  status: 'draft' | 'processing' | 'completed'
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = 'magician-clipper.projects.v1'

/* ------------------------------------------------------------------ */
/* In-memory file handling (video bytes never touch localStorage)      */
/* ------------------------------------------------------------------ */

const projectFiles = new Map<string, File>()
const projectVideoUrls = new Map<string, string>()

export function setProjectFile(id: string, file: File): void {
  projectFiles.set(id, file)
  const old = projectVideoUrls.get(id)
  if (old) URL.revokeObjectURL(old)
  projectVideoUrls.delete(id)
}

export function getProjectFile(id: string): File | undefined {
  return projectFiles.get(id)
}

/**
 * Module-level project lookup (used by Editor/Captions pages outside
 * the useProjects() hook). Mirrors exactly what the provider holds:
 * the provider syncs this cache on every state change, so it never
 * contains anything the store does not.
 */
let projectCache: ProjectRecord[] = []

export function getProject(id: string): ProjectRecord | undefined {
  return projectCache.find((p) => p.id === id)
}

function syncProjectCache(projects: ProjectRecord[]): void {
  projectCache = projects
}

export function getProjectVideoUrl(id: string): string | undefined {
  const cached = projectVideoUrls.get(id)
  if (cached) return cached
  const file = projectFiles.get(id)
  if (!file) return undefined
  const url = URL.createObjectURL(file)
  projectVideoUrls.set(id, url)
  return url
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

interface ProjectsState {
  projects: ProjectRecord[]
  loading: boolean
  error: string | null
  source: 'laravel' | 'browser'
  addProject: (
    input: Omit<
      ProjectRecord,
      'id' | 'createdAt' | 'updatedAt' | 'status' | 'laravelId'
    > & { status?: ProjectRecord['status'] },
  ) => ProjectRecord
  updateProject: (id: string, patch: Partial<ProjectRecord>) => void
  removeProject: (id: string) => void
  getProject: (id: string) => ProjectRecord | undefined
}

const ProjectsContext = createContext<ProjectsState>({
  projects: [],
  loading: true,
  error: null,
  source: 'browser',
  addProject: () => {
    throw new Error('ProjectProvider is not mounted')
  },
  updateProject: () => undefined,
  removeProject: () => undefined,
  getProject: () => undefined,
})

function loadStoredProjects(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : []
  } catch {
    return []
  }
}

function persistProjects(projects: ProjectRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  } catch {
    // Storage full / unavailable — the in-memory list still works.
  }
}

/**
 * Laravel statuses are draft | processing | ready | failed. The
 * browser record only has draft | processing | completed, so ready
 * maps to completed and failed maps back to draft (the failure detail
 * is not representable here; it is not invented either).
 */
export function mapLaravelStatus(status: string): ProjectRecord['status'] {
  if (status === 'processing') return 'processing'
  if (status === 'ready') return 'completed'
  return 'draft'
}

function laravelRowToRecord(row: Record<string, unknown>): ProjectRecord {
  const now = new Date().toISOString()
  return {
    id: `laravel-${String(row.id)}`,
    laravelId: typeof row.id === 'number' ? row.id : null,
    title: typeof row.title === 'string' && row.title ? row.title : 'Untitled project',
    fileName: '',
    fileSize: 0,
    durationSeconds: null,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    audioStreams: 0,
    jobId: null,
    spec: null,
    status: mapLaravelStatus(typeof row.status === 'string' ? row.status : 'draft'),
    createdAt: typeof row.created_at === 'string' ? row.created_at : now,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : now,
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<'laravel' | 'browser'>('browser')
  const mountedRef = useRef(true)

  // Keep the module-level getProject() mirror in step with the store.
  useEffect(() => {
    syncProjectCache(projects)
  }, [projects])

  useEffect(() => {
    mountedRef.current = true
    const stored = loadStoredProjects()
    setProjects(stored)
    setLoading(false)

    // If signed in, merge Laravel projects by laravelId.
    if (getToken()) {
      listLaravelProjects()
        .then(({ projects: rows }) => {
          if (!mountedRef.current) return
          const laravelRecords = (rows as Record<string, unknown>[]).map(
            laravelRowToRecord,
          )
          setProjects((current) => {
            const byLaravelId = new Map<number, ProjectRecord>()
            for (const p of current) {
              if (p.laravelId !== null) byLaravelId.set(p.laravelId, p)
            }
            const merged = [...current]
            for (const lr of laravelRecords) {
              if (lr.laravelId === null) continue
              const existing = byLaravelId.get(lr.laravelId)
              if (!existing) {
                merged.push(lr)
              } else {
                // The server is the source of truth for a job-linked
                // project's status: refresh it from the server row so a
                // finished job stops showing as "Processing" forever.
                // Every local-only field (title, fileName, fileSize, spec,
                // jobId, trim) stays exactly as-is — the server row has
                // none of those.
                const idx = merged.findIndex((p) => p.id === existing.id)
                if (idx >= 0) {
                  merged[idx] = {
                    ...existing,
                    status: lr.status,
                    updatedAt: lr.updatedAt,
                  }
                }
              }
            }
            merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
            persistProjects(merged)
            return merged
          })
          setSource('laravel')
        })
        .catch(() => {
          if (!mountedRef.current) return
          setError('Could not sync projects from the backend — showing browser projects only.')
        })
    }
    return () => {
      mountedRef.current = false
    }
  }, [])

  const addProject = useCallback<ProjectsState['addProject']>((input) => {
    const now = new Date().toISOString()
    const record: ProjectRecord = {
      ...input,
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      laravelId: null,
      status: input.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    }
    setProjects((current) => {
      const next = [record, ...current]
      persistProjects(next)
      return next
    })

    // Best-effort backend sync: an API failure never blocks the local save.
    if (getToken()) {
      createLaravelProject(record.title)
        .then((laravelId) => {
          if (laravelId === null) return
          setProjects((current) => {
            const next = current.map((p) =>
              p.id === record.id ? { ...p, laravelId } : p,
            )
            persistProjects(next)
            return next
          })
        })
        .catch(() => {
          // Keep laravelId null; the project still exists locally.
        })
    }
    return record
  }, [])

  const updateProject = useCallback<ProjectsState['updateProject']>((id, patch) => {
    setProjects((current) => {
      const next = current.map((p) =>
        p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
      )
      persistProjects(next)
      return next
    })
    // Best-effort backend sync when the title changed.
    const target = projects.find((p) => p.id === id)
    if (target && target.laravelId !== null && patch.title !== undefined && patch.title !== target.title) {
      updateLaravelProject(target.laravelId, { title: patch.title }).catch(() => {
        // Ignore — the local rename still stands.
      })
    }
  }, [projects])

  const removeProject = useCallback<ProjectsState['removeProject']>((id) => {
    const target = projects.find((p) => p.id === id)
    setProjects((current) => {
      const next = current.filter((p) => p.id !== id)
      persistProjects(next)
      return next
    })
    projectFiles.delete(id)
    const url = projectVideoUrls.get(id)
    if (url) URL.revokeObjectURL(url)
    projectVideoUrls.delete(id)
    if (target && target.laravelId !== null) {
      deleteLaravelProject(target.laravelId).catch(() => {
        // Ignore — the local record is gone either way.
      })
    }
  }, [projects])

  const getProject = useCallback(
    (id: string) => projects.find((p) => p.id === id),
    [projects],
  )

  const value = useMemo<ProjectsState>(
    () => ({
      projects,
      loading,
      error,
      source,
      addProject,
      updateProject,
      removeProject,
      getProject,
    }),
    [projects, loading, error, source, addProject, updateProject, removeProject, getProject],
  )

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>
}

export function useProjects(): ProjectsState {
  return useContext(ProjectsContext)
}
