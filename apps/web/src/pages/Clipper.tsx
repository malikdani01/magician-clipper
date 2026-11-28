import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  CloudUpload,
  Eye,
  FileVideo,
  Link2,
  Loader2,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { LayoutMiniPreview, LayoutPicker } from '../components/LayoutPicker'
import {
  CaptionStylePicker,
  HeadlineStylePicker,
  HeadlineStyleStill,
} from '../components/StylePicker'
import { CaptionStylePreview } from '../components/CaptionStylePreview'
import { Dropdown } from '../components/Dropdown'
import { API_URL, ENGINE_URL, extractAudio, fetchMyPlan, probeVideo, type ProbeResult } from '../lib/api'
import { formatBytes, formatDuration } from '../lib/format'
import {
  CAPTION_LANGUAGES,
  CAPTION_POSITION_LABELS,
  CAPTION_TRANSLATION_LABELS,
  COLOUR_GRADE_LABELS,
  createJob,
  defaultOstPosition,
  getJob,
  HEADLINE_STYLE_LABELS,
  LAYOUT_LABELS,
  LAYOUTS_BY_ASPECT,
  layoutAllowedForAspect,
  OST_LANGUAGE_LABELS,
  OST_POSITION_LABELS,
  SELECTION_MODE_DESCRIPTIONS,
  SELECTION_MODE_LABELS,
  type CaptionPosition,
  type CaptionTranslation,
  type ColourGrade,
  type HeadlineStyle,
  type JobSettings,
  type OstLanguage,
  type OstPosition,
  type SelectionMode,
  type Sfx,
} from '../lib/jobs'
import { getCaptionStyle, isCaptionStyleId, translateLegacyCaptionPreset } from '../lib/captionStyles'
import { usePlatform } from '../lib/platform'
import { createPreset, listPresets, type JobPreset, type PresetSettings } from '../lib/presets'
import { useAuth } from '../state/auth'
import {
  defaultClipSpec,
  setProjectFile,
  useProjects,
  type ClipSpec,
  type ProjectRecord,
} from '../state/projects'
import { usePreferences } from '../state/preferences'

const STEPS = [
  { id: 1, label: 'Import', icon: Upload },
  { id: 2, label: 'Style', icon: SlidersHorizontal },
  { id: 3, label: 'Process', icon: Sparkles },
  { id: 4, label: 'Review', icon: Eye },
  { id: 5, label: 'Ship', icon: Send },
] as const

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v']

const ENGINE_START_COMMAND =
  'cd services/video-engine && uvicorn app.main:app --host 127.0.0.1 --port 8001'

/**
 * True when this page itself is served from this machine (local dev).
 * The engine URL alone cannot tell us: on the hosted site
 * VITE_ENGINE_URL is unset, so it falls back to 127.0.0.1:8001 even
 * though no engine can run there — the probe-failure message must not
 * tell a visitor to start a local process they cannot run.
 */
const IS_LOCAL_SITE =
  typeof window !== 'undefined' &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)

/**
 * Batch 9 (2026-11-25): the caption picker is UNIFIED with New Job —
 * it stores REAL style ids (punchy, word_pop, …) and offers ALL 25
 * styles via the shared StylePicker (no `options` prop = the full
 * set). The old wizard-local LEGACY preset ids (bold-pop, highlight,
 * …) are gone from the picker. translateLegacyCaptionPreset survives
 * ONLY for loading old saved presets that stored a legacy id
 * (back-compat — real ids pass through unchanged).
 */

/** Preset quality → wizard processing mode. */
const QUALITY_TO_PROCESSING_MODE: Record<string, ClipSpec['processingMode']> = {
  draft: 'eco',
  standard: 'balanced',
  high: 'fast',
}

/**
 * Processing mode → job quality. This MUST be the exact inverse of
 * QUALITY_TO_PROCESSING_MODE — the old map sent 'fast' back to
 * 'standard', so a High-quality preset silently became Standard at
 * submit. The quality dropdown and the processing-mode buttons set
 * both fields together (see updateQuality / updateProcessingMode),
 * so the two can never disagree.
 */
const PROCESSING_MODE_TO_QUALITY: Record<string, 'draft' | 'standard' | 'high'> = {
  eco: 'draft',
  balanced: 'standard',
  fast: 'high',
}

const CONTENT_TYPES = [
  { id: 'podcast', label: 'Podcast' },
  { id: 'interview', label: 'Interview' },
  { id: 'education', label: 'Education' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'commentary', label: 'Commentary' },
  { id: 'story', label: 'Story' },
  { id: 'general', label: 'General' },
] as const

const CLIP_COUNT_PRESETS = [1, 3, 5, 10] as const
const DURATION_PRESETS = [15, 20, 30, 45, 60] as const

/** The real pipeline stages. Only stages 1–2 can honestly complete in Phase 2. */
const PIPELINE_STAGES = [
  'Checking media',
  'Extracting audio',
  'Transcribing speech',
  'Detecting scenes',
  'Finding candidate moments',
  'Ranking highlights',
  'Preparing boundaries',
  'Rendering clips',
  'Generating captions',
  'Validating outputs',
] as const

type ExtractAudioResult = Awaited<ReturnType<typeof extractAudio>>

/**
 * Accept video/* MIME types, plus MKV-style files whose browser reports
 * an empty or generic type — those are judged by extension instead.
 */
function isVideoFile(f: File): boolean {
  if (f.type.startsWith('video/')) return true
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(ext)
}

/** A failed fetch / TypeError means the engine process is not reachable. */
function isEngineUnreachable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    err instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed|ECONNREFUSED/i.test(message)
  )
}

function ChoiceButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-colors ${
        selected
          ? 'border-brand bg-brand text-white'
          : 'border-ink-border bg-ink-panel2 text-white hover:border-brand/60'
      }`}
    >
      {children}
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand' : 'bg-ink-border'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

/**
 * AI Clipper — 5-step wizard (Import → Style → Process → Review → Ship).
 *
 * Step 1 (Import) is REAL in Phase 2: a video file is previewed from an
 * object URL, then uploaded straight to the local video engine
 * (http://127.0.0.1:8001) and probed with ffprobe. The engine values are
 * authoritative; a successful probe creates a draft project in the store.
 * Audio can be extracted for real (16 kHz mono WAV) as groundwork for
 * transcription in Phase 3.
 *
 * Step 2 (Style) is a REAL form bound to the project's ClipSpec.
 * The caption preset has no field on ClipSpec, so it lives in
 * wizard-local state only.
 *
 * Steps 3–5 are honest placeholders: the pipeline stages are listed as
 * pending, Start Processing / export controls stay disabled, and no
 * percentage, progress bar or fake activity is ever shown. Stages 1–2
 * of the pipeline show as done only when probe + audio extraction have
 * really succeeded, with their real engine job ids.
 *
 * The Laravel backend is NOT used by this wizard — its upload/analyze
 * endpoints return "not implemented yet (Phase 3)". Internal engine
 * paths (source_path / audio_path) are never rendered.
 */
/**
 * Batch 13: collapsible picker dropdown — the three big card grids
 * (Layout, Caption style, Headline style) were making Step 2 very
 * long and confusing on phones, so each picker now lives behind a
 * header row that shows the CURRENT selection (name + small preview)
 * and a chevron. All three start COLLAPSED. Tapping the header
 * expands the full card grid (unchanged cards, same selection
 * behaviour); picking a card updates the header and leaves the
 * dropdown OPEN so styles can be compared — closing is only via
 * the header. Selection state and defaults are unchanged.
 */
function PickerDropdown({
  label,
  open,
  onToggle,
  header,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  header: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-ink-border bg-ink-panel2">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label} — ${open ? 'hide' : 'show'} options`}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        {header}
        <ChevronDown
          aria-hidden="true"
          className={`ml-auto h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div className="border-t border-ink-border/60 px-2.5 pb-3 pt-3">{children}</div>
      ) : null}
    </div>
  )
}

/**
 * Batch 13: export ratios are gone from the wizard UI — the Aspect
 * ratio selector IS the export ratio. One ratio in, same ratio out.
 * The API allows all four ratios (incl. 4:5), so every aspect
 * submits itself and the job renders exactly that one ratio.
 */
const exportRatiosForAspect = (aspect: ClipSpec['aspect']): string[] => [aspect]

export function ClipperPage() {
  const { addProject, updateProject, getProject } = useProjects()
  const { t } = usePreferences()
  const navigate = useNavigate()

  const [step, setStep] = useState(1)
  const [maxStep, setMaxStep] = useState(1)

  // Step 1 — file + browser metadata + engine probe
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [browserMeta, setBrowserMeta] = useState<{
    duration: number
    width: number
    height: number
  } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [probeStatus, setProbeStatus] = useState<'idle' | 'probing' | 'done' | 'error'>('idle')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probeUnreachable, setProbeUnreachable] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)

  // Step 1 — link import (wizard-internal since the New Job page
  // was hidden: a validated link becomes this wizard's source and
  // the job is created from Step 3 with sourceUrl, like a file job
  // — the worker downloads it with yt-dlp).
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  // A validated link source (no file/probe — Step 1's Continue and
  // Step 3's Start Processing accept it in place of a project).
  const [linkSource, setLinkSource] = useState<string | null>(null)

  // Step 3 — real processing: creates a Job via the API and navigates
  // to the job page, where the worker renders the clips.
  const [processing, setProcessing] = useState(false)
  const [processingError, setProcessingError] = useState<string | null>(null)
  // Always-On round (2026-11-26): 0–1 while the source file is
  // uploading to the backend, null otherwise. fetch reports no upload
  // progress, so the file path uses XHR (see createJob) and the button
  // shows a real percentage instead of a stuck spinner.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)

  // Step 1 — audio extraction (Phase 2 groundwork for transcription)
  const [audioStatus, setAudioStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>('idle')
  const [audioResult, setAudioResult] = useState<ExtractAudioResult | null>(null)
  const [audioError, setAudioError] = useState<string | null>(null)

  // Step 2 — style form (bound to the project's ClipSpec)
  const [spec, setSpec] = useState<ClipSpec>(() => defaultClipSpec())
  // Batch 13: a ref mirror of the spec, so async callbacks always
  // merge onto the LATEST spec. updateSpec used to close over a stale
  // render's spec: if the /settings fetch (saved caption style)
  // resolved after the user picked a layout, the pick was silently
  // reverted to the old value — the Batch 13 proof run stored centre
  // crop after picking blur fill. The ref makes that impossible.
  const specRef = useRef(spec)
  specRef.current = spec
  // Batch 13: the three big card pickers (Layout / Caption style /
  // Headline style) are collapsible dropdowns — all start closed
  // so Step 2 stays short on phones.
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [captionStyleOpen, setCaptionStyleOpen] = useState(false)
  const [headlineStyleOpen, setHeadlineStyleOpen] = useState(false)
  const [clipCountText, setClipCountText] = useState(() => String(spec.clipCount))
  const [clipCountError, setClipCountError] = useState<string | null>(null)
  const [durationText, setDurationText] = useState(() => String(spec.durationSeconds))
  const [durationError, setDurationError] = useState<string | null>(null)
  // Batch 9: the duration min/max pair for minimum/maximum modes
  // (defaults 30–90s, like New Job; the backend caps all three at
  // 180s).
  const [durationMinText, setDurationMinText] = useState(() => String(spec.durationMinSeconds))
  const [durationMaxText, setDurationMaxText] = useState(() => String(spec.durationMaxSeconds))
  const [durationRangeError, setDurationRangeError] = useState<string | null>(null)
  // The caption style lives on ClipSpec now (a REAL style id) — the
  // old wizard-local legacy preset state is gone (Batch 9 unification).
  // Batch 11: the user's export cap (720 Free / 1080 paid), from
  // GET /me/plan. Null while loading — the 1080p option stays
  // enabled until the cap is known, and the SERVER is the
  // enforcement (a Free user submitting 1080p gets a 422 with an
  // upgrade hint), so a slow load can never leak the tier.
  const [maxExportHeight, setMaxExportHeight] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchMyPlan().then((summary) => {
      if (!cancelled && summary) setMaxExportHeight(summary.limits.max_export_height)
    })
    return () => {
      cancelled = true
    }
  }, [])
  // Batch 9: whether the user picked an OST position explicitly.
  // Until then, changing the headline style moves the position to
  // that style's default.
  const ostPositionTouchedRef = useRef(false)
  const pickHeadlineStyle = (s: HeadlineStyle) => {
    if (!ostPositionTouchedRef.current) {
      updateSpec({ headlineStyle: s, ostPosition: defaultOstPosition(s) })
    } else {
      updateSpec({ headlineStyle: s })
    }
  }

  // Job presets (GET /api/v1/presets) — load a saved settings snapshot
  // into the Step 2 form. Presets hold settings only; the source is
  // always the file picked on Step 1.
  const [presets, setPresets] = useState<JobPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [presetMessage, setPresetMessage] = useState<string | null>(null)
  // Batch 9: saving a preset from this wizard (the New Job page had
  // the save UI; the wizard is the only creation flow now, so the
  // save lives here too — same endpoint, same settings snapshot).
  const [presetName, setPresetName] = useState('')
  const [presetSaving, setPresetSaving] = useState(false)
  // Batch 9: clone (?clone=<id>) — settings copied from an earlier
  // job; the source is never reused (same banner as New Job had).
  const [clonedFrom, setClonedFrom] = useState<number | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  // Set once a preset/clone has applied settings, so the saved-default
  // caption style effect below does not clobber them afterwards.
  const settingsAppliedRef = useRef(false)
  const { token } = useAuth()
  const [searchParams] = useSearchParams()

  useEffect(() => {
    let cancelled = false
    listPresets().then((rows) => {
      if (!cancelled) setPresets(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Link prefill: the user (or an old bookmark) arrives with
  // ?source=link&url=… — open Step 1 with the URL already pasted
  // (same behaviour New Job had). Only on first mount.
  useEffect(() => {
    if (searchParams.get('source') === 'link') {
      const url = searchParams.get('url') ?? ''
      if (url) setLinkUrl(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clone (?clone=<jobId>): copy an earlier job's settings into Step 2.
  // The source is never copied — the user picks the video/link again
  // (the banner says so). Same error handling New Job had for
  // bad/missing ids.
  useEffect(() => {
    const cloneId = searchParams.get('clone')
    if (!cloneId) return
    const id = Number(cloneId)
    if (!Number.isFinite(id) || id <= 0) {
      setCloneError(`Could not clone job "${cloneId}" — that is not a valid job id.`)
      return
    }
    let cancelled = false
    getJob(id)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setCloneError(`Could not clone job #${id} — ${result.error}`)
          return
        }
        if (!result.job.settings) {
          setCloneError(`Could not clone job #${id} — the job has no settings to copy.`)
          return
        }
        applySettings(result.job.settings)
        settingsAppliedRef.current = true
        setClonedFrom(id)
      })
      .catch(() => {
        if (!cancelled) {
          setCloneError(`Could not clone job #${id} — the job could not be loaded.`)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Default caption style from the user's saved settings (Settings →
  // Preferences saves it via PATCH /api/v1/settings). 'punchy' when
  // nothing is saved. Skipped once a preset/clone has applied
  // settings — theirs wins. Same behaviour New Job had.
  useEffect(() => {
    if (!token || settingsAppliedRef.current) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const body = (await res.json()) as { settings?: { caption_style?: unknown } }
        const saved = body.settings?.caption_style
        if (!cancelled && !settingsAppliedRef.current && isCaptionStyleId(saved)) {
          updateSpec({ captionStyle: saved })
        }
      } catch {
        // Backend unreachable — keep the 'punchy' default.
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Stale-response guards: a probe/audio call that finishes after a newer
  // file was picked (or the user navigated away) is ignored.
  const probeRequestRef = useRef(0)
  const audioRequestRef = useRef(0)

  const project = projectId ? getProject(projectId) : undefined
  /** Campaign jobs need requirements (same rule as New Job) — the
   * derived flag blocks Continue until they are filled in. */
  const campaignInvalid =
    spec.jobType === 'campaign' && spec.campaignRequirements.trim() === ''
  const specValid =
    clipCountError === null &&
    durationError === null &&
    durationRangeError === null &&
    !campaignInvalid
  // Batch 10 (2026-11-25): platform gating. A feature is off ONLY
  // when the payload says so (`=== false`) — while the payload is
  // loading or unavailable, every control renders unchanged (never
  // hide on a loading state). The backend enforces the same rules;
  // the `gated*` values below are what the submitted payload sends,
  // so a disabled setting can never go out as enabled.
  const { platform } = usePlatform()
  const captionsOff = platform?.features.captions === false
  const ostOff = platform?.features.on_screen_text === false
  const beatSyncOff = platform?.features.beat_sync === false
  const translationOff = platform?.features.translation === false
  const logoOff = platform?.features.logo_overlay === false
  const musicOff = platform?.features.music_bed_sfx === false
  const maintenanceOn = platform?.maintenance.enabled === true
  const maintenanceMessage =
    platform?.maintenance.message ||
    'Magician Clipper is under maintenance — please check back soon.'
  const daily = platform?.daily ?? null
  const dailyExhausted =
    daily !== null && daily.limit !== null && daily.remaining <= 0
  // The wizard's own range is 1–20; the platform cap can only lower
  // it (an admin cap of 5 means 5, a cap of 50 still means 20 here).
  const platformMaxClips = platform?.limits.max_clips_per_job
  const effectiveMaxClips =
    platformMaxClips != null
      ? Math.min(Math.max(1, platformMaxClips), 20)
      : 20
  const gatedCaptions = captionsOff ? false : spec.captions
  const gatedOnScreenText = ostOff ? false : spec.onScreenText
  const gatedBeatSync = beatSyncOff ? false : (spec.beatSync ?? true)
  const gatedCaptionTranslation: CaptionTranslation = translationOff
    ? 'none'
    : (spec.captionTranslation ?? 'none')
  const gatedOstLanguage: OstLanguage = translationOff
    ? 'source'
    : (spec.ostLanguage ?? 'source')
  const gatedLogoOverlay = logoOff ? false : (spec.logoOverlay ?? false)
  const gatedSfx: Sfx = musicOff ? 'none' : (spec.sfx ?? 'none')
  const gatedClipCount = Math.min(spec.clipCount, effectiveMaxClips)
  // Stepper: step 1 is always reachable; later steps need a probed project
  // and must have been visited (or be the immediate next step, so every
  // step stays reachable even though Step 4's Continue is disabled).
  const canGoToStep = (n: number) =>
    n === 1 || (projectId !== null && n <= maxStep + 1)

  const goTo = (n: number) => {
    setStep(n)
    setMaxStep((m) => Math.max(m, n))
  }

  /** Keep local spec state and the stored project spec in sync.
   * Reads the ref (not the render's spec) so a patch applied from an
   * async callback never reverts a pick the user made meanwhile. */
  const updateSpec = (patch: Partial<ClipSpec>) => {
    const next = { ...specRef.current, ...patch }
    specRef.current = next
    setSpec(next)
    if (projectId) {
      updateProject(projectId, { spec: next })
    }
  }

  /** Batch 13: changing the aspect ratio keeps the layout only when
   * it renders on the new canvas — a portrait-only layout falls back
   * to centre crop instead of silently rendering something else. */
  const applyAspect = (aspect: ClipSpec['aspect']) => {
    const next: Partial<ClipSpec> = { aspect }
    if (!layoutAllowedForAspect(specRef.current.layout, aspect)) {
      next.layout = 'center_crop'
    }
    updateSpec(next)
  }

  /**
   * Quality and processing mode are two controls for one choice, so
   * they always move together — picking a quality sets the matching
   * processing mode and vice versa (the maps are exact inverses, so
   * a High preset can no longer silently become Standard at submit).
   */
  const updateQuality = (q: ClipSpec['quality']) => {
    const mode = QUALITY_TO_PROCESSING_MODE[q]
    updateSpec(mode ? { quality: q, processingMode: mode } : { quality: q })
  }
  const updateProcessingMode = (m: ClipSpec['processingMode']) => {
    const q = PROCESSING_MODE_TO_QUALITY[m]
    updateSpec(q ? { processingMode: m, quality: q } : { processingMode: m })
  }

  /**
   * Apply a saved settings snapshot (preset or cloned job) to the
   * Step 2 form. Every field is validated against what this wizard
   * accepts first — a value outside the wizard's range (e.g. clip
   * count above 20, duration outside 5–300s) is skipped, not forced
   * in. A caption style with no real id keeps the wizard's current
   * style and says so. The wizard has no notes field, so a preset's
   * notes are not applied (they stay in the preset). Sets
   * settingsAppliedRef so the saved-default caption style effect
   * does not clobber these settings afterwards.
   */
  const applySettings = (s: PresetSettings | JobSettings) => {
    const skipped: string[] = []
    const patch: Partial<ClipSpec> = {}
    if (s.platform === 'tiktok' || s.platform === 'instagram') {
      patch.platform = s.platform
    }
    if (s.aspect_ratio === '9:16' || s.aspect_ratio === '16:9' || s.aspect_ratio === '1:1' || s.aspect_ratio === '4:5') {
      patch.aspect = s.aspect_ratio
    }
    if (typeof s.clip_count === 'number' && s.clip_count >= 1 && s.clip_count <= 20) {
      patch.clipCount = Math.round(s.clip_count)
      setClipCountText(String(Math.round(s.clip_count)))
      setClipCountError(null)
    } else if (typeof s.clip_count === 'number') {
      skipped.push(`clip count (${s.clip_count} is outside this wizard's 1–20)`)
    }
    if (s.duration_mode === 'exact' || s.duration_mode === 'minimum' || s.duration_mode === 'maximum') {
      patch.durationMode = s.duration_mode
      if (typeof s.duration_seconds === 'number' && s.duration_seconds >= 5 && s.duration_seconds <= 300) {
        patch.durationSeconds = Math.round(s.duration_seconds)
        setDurationText(String(Math.round(s.duration_seconds)))
        setDurationError(null)
      } else if (typeof s.duration_seconds === 'number') {
        skipped.push(`clip duration (${s.duration_seconds}s is outside this wizard's 5–300s)`)
      }
      // Batch 9: the min/max pair for minimum/maximum modes
      // (defaults 30–90s; the backend caps all three at 180s).
      if (
        typeof s.duration_min_seconds === 'number' &&
        typeof s.duration_max_seconds === 'number' &&
        s.duration_min_seconds >= 5 && s.duration_min_seconds <= 180 &&
        s.duration_max_seconds >= 5 && s.duration_max_seconds <= 180 &&
        s.duration_min_seconds < s.duration_max_seconds
      ) {
        patch.durationMinSeconds = Math.round(s.duration_min_seconds)
        patch.durationMaxSeconds = Math.round(s.duration_max_seconds)
        setDurationMinText(String(Math.round(s.duration_min_seconds)))
        setDurationMaxText(String(Math.round(s.duration_max_seconds)))
        setDurationRangeError(null)
      } else if (typeof s.duration_min_seconds === 'number' || typeof s.duration_max_seconds === 'number') {
        skipped.push('duration range (min/max outside 5–180s, or min not below max)')
      }
    }
    if (typeof s.captions_enabled === 'boolean') patch.captions = s.captions_enabled
    if (s.selection_mode === 'interesting_only' || s.selection_mode === 'fill_any') {
      patch.selectionMode = s.selection_mode
    }
    if (typeof s.on_screen_text === 'boolean') patch.onScreenText = s.on_screen_text
    if (typeof s.auto_zoom === 'boolean') patch.autoZoom = s.auto_zoom
    if (typeof s.face_tracking === 'boolean') patch.faceTracking = s.face_tracking
    if (typeof s.silence_removal === 'boolean') patch.silenceRemoval = s.silence_removal
    if (typeof s.filler_removal === 'boolean') patch.fillerRemoval = s.filler_removal
    // Batch 15: loop-perfect (pattern interrupts have no wizard
    // toggle — always ON, so there is nothing to restore).
    if (typeof s.loop_perfect === 'boolean') patch.loopPerfect = s.loop_perfect
    // Batch 2 (2026-11-25): headline look + caption position.
    if (s.headline_style === 'bold_bar' || s.headline_style === 'lower_third' || s.headline_style === 'big_centre') {
      patch.headlineStyle = s.headline_style
    }
    if (s.caption_position === 'bottom' || s.caption_position === 'top' || s.caption_position === 'middle') {
      patch.captionPosition = s.caption_position
    }
    // Batch 3 (2026-11-25): beat sync, caption translation, export ratios.
    // Batch 9: the translation list is broad now (32 languages) —
    // any label in the shared list validates.
    if (typeof s.beat_sync === 'boolean') patch.beatSync = s.beat_sync
    if (
      s.caption_translation === 'none' ||
      (typeof s.caption_translation === 'string' &&
        s.caption_translation in CAPTION_TRANSLATION_LABELS)
    ) {
      patch.captionTranslation = s.caption_translation as CaptionTranslation
    }
    // Batch 13: export_ratios is no longer a wizard control —
    // the submitted list is derived from the aspect ratio at
    // submit (exportRatiosForAspect). A stored preset's old
    // export_ratios list is ignored; its aspect_ratio still
    // restores the aspect selector above.
    // Batch 4 (2026-11-25): logo overlay.
    if (typeof s.logo_overlay === 'boolean') patch.logoOverlay = s.logo_overlay
    // Batch 6 (2026-11-25): caption safe zone (default ON).
    if (typeof s.caption_safe_zone === 'boolean') patch.captionSafeZone = s.caption_safe_zone
    // Batch 7 (2026-11-25): whole-clip on-screen text (defaults OFF).
    // Batch 9: ost_animation is no longer a control — OST is always
    // static, so an old preset's animation value is ignored here.
    if (typeof s.ost_persistent === 'boolean') patch.ostPersistent = s.ost_persistent
    if (typeof s.end_card === 'boolean') patch.endCard = s.end_card
    // Batch 9 (2026-11-25): OST position + SFX. An old preset
    // without ost_position keeps the style default.
    if (s.ost_position === 'top' || s.ost_position === 'centre' || s.ost_position === 'bottom') {
      patch.ostPosition = s.ost_position
      ostPositionTouchedRef.current = true
    } else if (s.headline_style === 'bold_bar' || s.headline_style === 'lower_third' || s.headline_style === 'big_centre') {
      patch.ostPosition = defaultOstPosition(s.headline_style)
      ostPositionTouchedRef.current = false
    }
    if (s.sfx === 'none' || s.sfx === 'whoosh' || s.sfx === 'pop' || s.sfx === 'whoosh_pop') {
      patch.sfx = s.sfx
    }
    // Batch 9 (2026-11-25): OST language. An old preset without it
    // keeps 'source' (the video's own language).
    if (
      s.ost_language === 'source' ||
      (typeof s.ost_language === 'string' && s.ost_language in OST_LANGUAGE_LABELS)
    ) {
      patch.ostLanguage = s.ost_language as OstLanguage
    }
    // Batch 9 (2026-11-25): colour grade. Batch 13: 'auto' is the
    // new default; an old preset without it keeps 'auto' too (the
    // spec default), and any value outside the label map is skipped.
    if (typeof s.colour_grade === 'string' && s.colour_grade in COLOUR_GRADE_LABELS) {
      patch.colourGrade = s.colour_grade as ColourGrade
    }
    if (typeof s.end_card_text === 'string') patch.endCardText = s.end_card_text
    if (typeof s.keyword_popups === 'boolean') patch.keywordPopups = s.keyword_popups
    if (typeof s.lower_third_text === 'string') patch.lowerThirdText = s.lower_third_text
    if (typeof s.progress_bar === 'boolean') patch.progressBar = s.progress_bar
    if (CONTENT_TYPES.some((c) => c.id === s.content_type)) {
      patch.contentType = s.content_type as ClipSpec['contentType']
    }
    // Batch 9 (2026-11-25): job type + campaign requirements, layout,
    // quality (both fields move together — see updateQuality).
    if (s.job_type === 'myself' || s.job_type === 'campaign') {
      patch.jobType = s.job_type
    }
    if (typeof s.campaign_requirements === 'string') {
      patch.campaignRequirements = s.campaign_requirements
    }
    // Batch 12: the brief prefers the new campaign_brief key,
    // falling back to the old one. Batch 14: the structured fields
    // are gone from the wizard — an old job/preset that still has
    // them is loaded as brief-only (the backend re-derives them
    // from the brief at creation).
    if (typeof s.campaign_brief === 'string' && s.campaign_brief) {
      patch.campaignRequirements = s.campaign_brief
    }
    if (
      s.layout === 'center_crop' ||
      s.layout === 'split' ||
      s.layout === 'pip_facecam' ||
      s.layout === 'blur_fill' ||
      s.layout === 'streamer_full' ||
      s.layout === 'gradient_fill' ||
      s.layout === 'stacked' ||
      s.layout === 'letterbox' ||
      s.layout === 'face_closeup' ||
      s.layout === 'framed'
    ) {
      patch.layout = s.layout
    }
    if (s.quality === 'draft' || s.quality === 'standard' || s.quality === 'high') {
      patch.quality = s.quality
      const mode = QUALITY_TO_PROCESSING_MODE[s.quality]
      if (mode) patch.processingMode = mode
    }
    // Batch 11 (2026-11-25): export tier. An old preset without it
    // keeps '720p'; a '1080p' preset on a Free account is rejected
    // at submit by the server with an upgrade hint.
    if (s.export_quality === '720p' || s.export_quality === '1080p') {
      patch.exportQuality = s.export_quality
    }
    // Batch 9: captions language (which language the speech is in).
    if (
      s.captions_language === 'english' ||
      s.captions_language === 'roman_urdu' ||
      s.captions_language === 'hindi' ||
      s.captions_language === 'auto'
    ) {
      patch.captionsLanguage = s.captions_language
    }
    // Batch 9: caption style — a REAL style id now. An old preset
    // that stored a legacy id maps through the back-compat table;
    // an unknown id keeps the current style and says so.
    if (typeof s.caption_style === 'string') {
      const realId = translateLegacyCaptionPreset(s.caption_style)
      if (isCaptionStyleId(realId)) {
        patch.captionStyle = realId
      } else {
        skipped.push(
          `caption style (“${s.caption_style}” is not a style this wizard knows — kept the current style)`,
        )
      }
    }
    // Batch 13: a preset/clone may pair a portrait-only layout with
    // a landscape/square ratio — fall back to centre crop instead of
    // showing a layout the canvas cannot render.
    if (patch.layout && !layoutAllowedForAspect(patch.layout, patch.aspect ?? spec.aspect)) {
      patch.layout = 'center_crop'
    }
    settingsAppliedRef.current = true
    updateSpec(patch)
    return skipped
  }

  /** Load a saved job preset into the Step 2 form (see applySettings). */
  const handleLoadPreset = (id: number) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    const skipped = applySettings(preset.settings)
    setPresetMessage(
      `Preset “${preset.name}” loaded.` +
        (skipped.length > 0 ? ` Not applied: ${skipped.join('; ')}.` : ''),
    )
  }

  /** Save the current Step 2 settings as a named preset (same
   * endpoint New Job used — the wizard is the only creation flow
   * now, so the save lives here). */
  const handleSavePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      setPresetMessage('Type a name for the preset first.')
      return
    }
    setPresetSaving(true)
    setPresetMessage(null)
    const result = await createPreset(name, snapshotSettings())
    setPresetSaving(false)
    if (!result.ok) {
      setPresetMessage(result.error)
      return
    }
    setPresets((current) => [result.preset, ...current])
    setPresetName('')
    setPresetMessage(`Preset "${result.preset.name}" saved.`)
  }

  /** Snapshot the current Step 2 spec for saving as a preset. */
  const snapshotSettings = (): PresetSettings => ({
    platform: spec.platform,
    aspect_ratio: spec.aspect,
    clip_count: spec.clipCount,
    duration_mode: spec.durationMode,
    duration_seconds:
      spec.durationMode === 'exact'
        ? spec.durationSeconds
        : spec.durationMode === 'minimum'
          ? spec.durationMinSeconds
          : spec.durationMaxSeconds,
    duration_min_seconds: spec.durationMinSeconds,
    duration_max_seconds: spec.durationMaxSeconds,
    captions_enabled: spec.captions,
    captions_language: spec.captionsLanguage,
    caption_style: spec.captionStyle,
    selection_mode: spec.selectionMode ?? 'interesting_only',
    on_screen_text: spec.onScreenText,
    auto_zoom: spec.autoZoom ?? true,
    face_tracking: spec.faceTracking ?? true,
    silence_removal: spec.silenceRemoval ?? true,
    filler_removal: spec.fillerRemoval ?? true,
    // Batch 15: pattern interrupts are always ON (no wizard toggle);
    // loop-perfect comes from the Step 2 toggle (default OFF).
    pattern_interrupts: true,
    loop_perfect: spec.loopPerfect ?? false,
    headline_style: spec.headlineStyle ?? 'bold_bar',
    caption_position: spec.captionPosition ?? 'bottom',
    ost_position: spec.ostPosition ?? defaultOstPosition(spec.headlineStyle ?? 'bold_bar'),
    ost_language: spec.ostLanguage ?? 'source',
    sfx: spec.sfx ?? 'none',
    colour_grade: spec.colourGrade ?? 'auto',
    beat_sync: spec.beatSync ?? true,
    caption_translation: spec.captionTranslation ?? 'none',
    export_ratios: exportRatiosForAspect(spec.aspect),
    // Batch 11: export tier (the server caps it from the plan —
    // a Free user asking for 1080p gets a 422 + upgrade hint).
    export_quality: spec.exportQuality ?? '720p',
    logo_overlay: spec.logoOverlay ?? false,
    caption_safe_zone: spec.captionSafeZone ?? true,
    ost_persistent: spec.ostPersistent ?? false,
    // Batch 9: OST is always static — presets keep 'none'.
    ost_animation: 'none',
    end_card: spec.endCard ?? false,
    end_card_text: (spec.endCardText ?? '').trim() ? (spec.endCardText ?? '').trim() : null,
    keyword_popups: spec.keywordPopups ?? false,
    lower_third_text: (spec.lowerThirdText ?? '').trim() ? (spec.lowerThirdText ?? '').trim() : null,
    progress_bar: spec.progressBar ?? false,
    job_type: spec.jobType,
    campaign_requirements: spec.campaignRequirements.trim()
      ? spec.campaignRequirements.trim()
      : null,
    // Batch 12: the brief rides in presets too. Batch 14: only
    // the brief — the structured fields are derived from the
    // parse at creation.
    campaign_brief: spec.campaignRequirements.trim()
      ? spec.campaignRequirements.trim()
      : null,
    notes: null,
    layout: spec.layout,
    content_type: spec.contentType,
    quality: spec.quality,
  })

  /**
   * Link import: validate the URL, then keep it as this wizard's
   * source — Step 2 styles it and Step 3 creates the job with
   * sourceUrl (the backend accepts it and the worker downloads the
   * video with yt-dlp). No download is claimed here; the job page
   * shows the real result. Replaces the old hand-off to /jobs/new.
   */
  const submitLink = () => {
    const url = linkUrl.trim()
    if (!url) {
      setLinkError('Paste a video link first.')
      return
    }
    try {
      new URL(url)
    } catch {
      setLinkError('That does not look like a valid link. Paste a full YouTube, TikTok, Drive or direct video URL.')
      return
    }
    setLinkError(null)
    setLinkSource(url)
    setFile(null)
    setProjectId(null)
  }

  /**
   * Start Processing — the real one. Creates a Job from the probed
   * file (or the validated link source) + the style spec via the Job
   * API and navigates to the job page, where the connected worker
   * transcribes, selects highlights and renders the clips. The
   * wizard itself never pretends to render.
   */
  const startRealProcessing = async () => {
    if ((!file && !linkSource) || processing) return
    if (!specValid) return
    // Batch 10: job creation is blocked during maintenance and once
    // the daily limit is used up (the button is disabled too — this
    // is the defence in depth, the backend rejects it as well).
    if (maintenanceOn || dailyExhausted) return
    setProcessing(true)
    setProcessingError(null)
    setUploadProgress(null)
    // The API requires duration_seconds in every mode: for exact it
    // is the exact length; for minimum/maximum it is the bound that
    // mode enforces (min / max). The min/max pair is sent as well.
    const durationSeconds =
      spec.durationMode === 'exact'
        ? spec.durationSeconds
        : spec.durationMode === 'minimum'
          ? spec.durationMinSeconds
          : spec.durationMaxSeconds
    const result = await createJob({
      file: file ?? null,
      sourceUrl: linkSource ?? undefined,
      platform: spec.platform,
      aspectRatio: spec.aspect,
      // Batch 10: gated values — a disabled feature never goes out
      // as enabled, and the clip count never exceeds the platform cap.
      clipCount: gatedClipCount,
      durationMode: spec.durationMode,
      durationSeconds,
      durationMinSeconds: spec.durationMode === 'exact' ? null : spec.durationMinSeconds,
      durationMaxSeconds: spec.durationMode === 'exact' ? null : spec.durationMaxSeconds,
      captionsEnabled: gatedCaptions,
      captionsLanguage: spec.captionsLanguage,
      captionStyle: spec.captionStyle,
      selectionMode: spec.selectionMode ?? 'interesting_only',
      onScreenText: gatedOnScreenText,
      autoZoom: spec.autoZoom ?? true,
      faceTracking: spec.faceTracking ?? true,
      silenceRemoval: spec.silenceRemoval ?? true,
      fillerRemoval: spec.fillerRemoval ?? true,
      patternInterrupts: true,
      loopPerfect: spec.loopPerfect ?? false,
      headlineStyle: spec.headlineStyle ?? 'bold_bar',
      captionPosition: spec.captionPosition ?? 'bottom',
      ostPosition: spec.ostPosition ?? defaultOstPosition(spec.headlineStyle ?? 'bold_bar'),
      ostLanguage: gatedOstLanguage,
      sfx: gatedSfx,
      colourGrade: spec.colourGrade ?? 'auto',
      musicBed: null,
      beatSync: gatedBeatSync,
      captionTranslation: gatedCaptionTranslation,
      exportRatios: exportRatiosForAspect(spec.aspect),
      logoOverlay: gatedLogoOverlay,
      captionSafeZone: spec.captionSafeZone ?? true,
      ostPersistent: spec.ostPersistent ?? false,
      // Batch 9: OST is always static — no animation is sent.
      ostAnimation: 'none',
      endCard: spec.endCard ?? false,
      endCardText: (spec.endCardText ?? '').trim(),
      keywordPopups: spec.keywordPopups ?? false,
      lowerThirdText: (spec.lowerThirdText ?? '').trim(),
      progressBar: spec.progressBar ?? false,
      jobType: spec.jobType,
      campaignRequirements: spec.campaignRequirements.trim(),
      // Batch 13: the chosen layout is stored for every ratio —
      // the worker renders it per ratio (only layouts that apply to
      // the ratio are offered, so nothing is silently discarded).
      layout: spec.layout,
      contentType: spec.contentType,
      quality: spec.quality,
    },
    {
      onUploadProgress: (fraction) => setUploadProgress(fraction),
    })
    setProcessing(false)
    setUploadProgress(null)
    if (!result.ok) {
      setProcessingError(result.error)
      return
    }
    navigate(`/jobs/${result.job.id}`)
  }

  const applyClipCount = (n: number) => {
    const clamped = Math.min(Math.max(1, n), effectiveMaxClips)
    setClipCountText(String(clamped))
    setClipCountError(null)
    updateSpec({ clipCount: clamped })
  }

  const onClipCountText = (value: string) => {
    setClipCountText(value)
    const n = Number(value)
    if (value.trim() === '' || !Number.isInteger(n) || n < 1 || n > effectiveMaxClips) {
      setClipCountError(`Enter a whole number between 1 and ${effectiveMaxClips}.`)
      return
    }
    setClipCountError(null)
    updateSpec({ clipCount: n })
  }

  const applyDuration = (n: number) => {
    setDurationText(String(n))
    setDurationError(null)
    updateSpec({ durationSeconds: n })
  }

  const onDurationText = (value: string) => {
    setDurationText(value)
    const n = Number(value)
    if (value.trim() === '' || !Number.isInteger(n) || n < 5 || n > 300) {
      setDurationError('Enter a whole number between 5 and 300 seconds.')
      return
    }
    setDurationError(null)
    updateSpec({ durationSeconds: n })
  }

  /**
   * Duration min/max for minimum/maximum modes (defaults 30–90s).
   * The backend caps all three durations at 180s, and min must be
   * below max — the same rule New Job enforced.
   */
  const onDurationRangeText = (which: 'min' | 'max', value: string) => {
    const min = which === 'min' ? Number(value) : spec.durationMinSeconds
    const max = which === 'max' ? Number(value) : spec.durationMaxSeconds
    if (which === 'min') setDurationMinText(value)
    else setDurationMaxText(value)
    if (
      value.trim() === '' ||
      !Number.isInteger(which === 'min' ? min : max) ||
      min < 5 || min > 180 || max < 5 || max > 180
    ) {
      setDurationRangeError('Enter whole numbers between 5 and 180 seconds.')
      return
    }
    if (min >= max) {
      setDurationRangeError('Minimum duration must be less than maximum duration.')
      return
    }
    setDurationRangeError(null)
    updateSpec(
      which === 'min' ? { durationMinSeconds: min } : { durationMaxSeconds: max },
    )
  }

  /**
   * Upload the file to the engine and probe it with ffprobe.
   * `priorId` is the project to update when re-probing; null creates a
   * new project (a new file always starts a new project).
   */
  const startProbe = (f: File, priorId: string | null) => {
    const reqId = ++probeRequestRef.current
    setProbe(null)
    setProbeError(null)
    setProbeUnreachable(false)
    setProbeStatus('probing')
    setAudioResult(null)
    setAudioError(null)
    setAudioStatus('idle')
    probeVideo(f)
      .then((result) => {
        if (reqId !== probeRequestRef.current) return
        setProbe(result)
        setProbeStatus('done')
        const existing = priorId ? getProject(priorId) : undefined
        const projectSpec = existing?.spec ?? defaultClipSpec()
        setSpec(projectSpec)
        setClipCountText(String(projectSpec.clipCount))
        setDurationText(String(projectSpec.durationSeconds))
        const title = f.name.replace(/\.[^.]+$/, '') || f.name
        const record = {
          title,
          fileName: f.name,
          fileSize: result.size_bytes,
          durationSeconds: result.duration_seconds,
          width: result.width,
          height: result.height,
          fps: result.fps,
          videoCodec: result.video_codec,
          audioCodec: result.audio_codec,
          audioStreams: result.audio_streams,
          jobId: result.job_id,
          status: 'draft' as const,
          spec: projectSpec,
        }
        if (priorId && existing) {
          updateProject(priorId, record)
          setProjectFile(priorId, f)
        } else {
          // addProject returns the created record (or its id); handle both.
          const created = addProject(record) as unknown as
            | ProjectRecord
            | string
            | undefined
          const newId = typeof created === 'string' ? created : created?.id
          if (newId) {
            setProjectId(newId)
            setProjectFile(newId, f)
          }
        }
      })
      .catch((err: unknown) => {
        if (reqId !== probeRequestRef.current) return
        setProbeStatus('error')
        setProbeError(err instanceof Error ? err.message : String(err))
        setProbeUnreachable(isEngineUnreachable(err))
      })
  }

  const startExtractAudio = () => {
    if (!file) return
    const reqId = ++audioRequestRef.current
    setAudioStatus('extracting')
    setAudioError(null)
    extractAudio(file)
      .then((result) => {
        if (reqId !== audioRequestRef.current) return
        setAudioResult(result)
        setAudioStatus('done')
      })
      .catch((err: unknown) => {
        if (reqId !== audioRequestRef.current) return
        setAudioStatus('error')
        setAudioError(err instanceof Error ? err.message : String(err))
      })
  }

  const handleFile = (f: File | undefined) => {
    setFileError(null)
    if (!f) return
    if (!isVideoFile(f)) {
      setFileError(
        `"${f.name}" is not a video file. Please choose an MP4, MOV, MKV or WEBM file.`,
      )
      return
    }
    // A new file mid-wizard drops all old probe/project state and starts
    // a new project; any probe already in flight is invalidated.
    probeRequestRef.current += 1
    audioRequestRef.current += 1
    const fresh = defaultClipSpec()
    setSpec(fresh)
    setClipCountText(String(fresh.clipCount))
    setDurationText(String(fresh.durationSeconds))
    setDurationMinText(String(fresh.durationMinSeconds))
    setDurationMaxText(String(fresh.durationMaxSeconds))
    setDurationRangeError(null)
    setProbe(null)
    setProbeError(null)
    setProbeUnreachable(false)
    setProbeStatus('idle')
    setAudioResult(null)
    setAudioError(null)
    setAudioStatus('idle')
    setProjectId(null)
    setBrowserMeta(null)
    setMaxStep(1)
    setStep(1)
    setFile(f)
    if (inputRef.current) inputRef.current.value = ''
    startProbe(f, null)
  }

  const clearFile = () => {
    probeRequestRef.current += 1
    audioRequestRef.current += 1
    const fresh = defaultClipSpec()
    setSpec(fresh)
    setClipCountText(String(fresh.clipCount))
    setDurationText(String(fresh.durationSeconds))
    setDurationMinText(String(fresh.durationMinSeconds))
    setDurationMaxText(String(fresh.durationMaxSeconds))
    setDurationRangeError(null)
    setFile(null)
    setPreviewUrl(null)
    setBrowserMeta(null)
    setProbe(null)
    setProbeError(null)
    setProbeUnreachable(false)
    setProbeStatus('idle')
    setAudioResult(null)
    setAudioError(null)
    setAudioStatus('idle')
    setProjectId(null)
    setFileError(null)
    setMaxStep(1)
    setStep(1)
    if (inputRef.current) inputRef.current.value = ''
  }

  // Playable preview from an object URL + real browser metadata, as soon
  // as a file is chosen. The engine probe runs in parallel (startProbe).
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      setBrowserMeta(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    const video = videoRef.current
    if (!video) {
      return () => URL.revokeObjectURL(url)
    }
    const onLoaded = () => {
      setBrowserMeta({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }
    const onError = () => {
      setFileError('Could not read this video file in your browser. Try a different file.')
    }
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
    video.src = url
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      URL.revokeObjectURL(url)
    }
  }, [file])

  // ---- derived values -------------------------------------------------

  const browserDiffers =
    browserMeta !== null &&
    probe !== null &&
    ((probe.duration_seconds != null &&
      Math.abs(browserMeta.duration - probe.duration_seconds) > 0.5) ||
      (probe.width != null && probe.width !== browserMeta.width) ||
      (probe.height != null && probe.height !== browserMeta.height))

  const engineMeta: Array<[string, string]> = probe
    ? [
        ['Duration', formatDuration(probe.duration_seconds ?? Number.NaN)],
        [
          'Resolution',
          probe.width != null && probe.height != null
            ? `${probe.width} × ${probe.height}`
            : '—',
        ],
        [
          'FPS',
          probe.fps != null
            ? Number.isInteger(probe.fps)
              ? String(probe.fps)
              : probe.fps.toFixed(2)
            : '—',
        ],
        ['Video codec', probe.video_codec ?? '—'],
        ['Audio codec', probe.audio_codec ?? '—'],
        [
          'Audio streams',
          // The browser probe cannot count streams — show '—', not 0.
          probe.probed_by === 'browser' ? '—' : String(probe.audio_streams),
        ],
        [
          'Bitrate',
          probe.bitrate != null ? `${Math.round(probe.bitrate / 1000)} kbps` : '—',
        ],
        ['Format', probe.format ?? '—'],
        ['Size', formatBytes(probe.size_bytes)],
      ]
    : []

  const durationModeLabel =
    spec.durationMode === 'exact'
      ? `exact ${spec.durationSeconds}s`
      : `${spec.durationMinSeconds}–${spec.durationMaxSeconds}s (${spec.durationMode})`
  const summary = `${gatedClipCount} clip${gatedClipCount === 1 ? '' : 's'} · ${durationModeLabel} · ${spec.aspect} · ${spec.platform === 'tiktok' ? 'TikTok' : 'Instagram'} · captions ${gatedCaptions ? 'on' : 'off'} · ${SELECTION_MODE_LABELS[spec.selectionMode ?? 'interesting_only']}`
  const captionLabel = getCaptionStyle(spec.captionStyle).name
  const contentLabel =
    CONTENT_TYPES.find((c) => c.id === spec.contentType)?.label ?? spec.contentType

  return (
    <div>
      <PageHeader
        title="AI Clipper"
        subtitle="Let AI find the best moments in your video."
      />

      {/* Batch 10: maintenance — job creation is blocked server-side
          with 503; the banner says so and the submit button (Step 3)
          is disabled while it is on. */}
      {maintenanceOn ? (
        <div
          role="alert"
          className="mb-4 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm font-medium text-amber-200"
        >
          {maintenanceMessage}
        </div>
      ) : null}

      {/* Stepper — numbered circles on a connecting line (design reference). */}
      <ol className="mb-8 flex items-start justify-between gap-1 sm:gap-2">
        {STEPS.map((s, i) => {
          const active = step === s.id
          const done = step > s.id
          const reachable = canGoToStep(s.id)
          return (
            <li key={s.id} className="relative flex flex-1 flex-col items-center">
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={`absolute right-1/2 top-5 h-0.5 w-full ${step > s.id ? 'bg-brand' : 'bg-ink-border'}`}
                />
              ) : null}
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`absolute left-1/2 top-5 h-0.5 w-full ${step > s.id + 1 ? 'bg-brand' : 'bg-ink-border'}`}
                />
              ) : null}
              <button
                type="button"
                onClick={() => goTo(s.id)}
                disabled={!reachable}
                aria-current={active ? 'step' : undefined}
                className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-bold transition-colors ${
                  active
                    ? 'border-brand bg-brand text-white shadow-glow'
                    : done
                      ? 'border-brand bg-brand/20 text-brand-light'
                      : 'border-ink-border bg-ink-panel text-[var(--color-text-muted)] hover:text-white'
                } ${!reachable ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                {done ? <Check className="h-4 w-4" /> : s.id}
              </button>
              <span
                className={`mt-2 text-center text-xs font-medium sm:text-sm ${
                  active ? 'text-white' : 'text-[var(--color-text-muted)]'
                }`}
              >
                {s.label}
              </span>
            </li>
          )
        })}
      </ol>

      {/* Hidden video element used only to read real file metadata. */}
      <video ref={videoRef} preload="metadata" className="hidden" aria-hidden="true" />

      {step === 1 ? (
        <section aria-label="Step 1 — Import">
          {/* Clone banner — the source is never reused, so the user
              picks the video/link again below (same as New Job had). */}
          {clonedFrom !== null ? (
            <div
              role="status"
              className="mb-4 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-amber-200"
            >
              <p className="font-semibold">Cloned from Job #{clonedFrom} — settings copied.</p>
              <p className="mt-1">
                Source needed again — pick the video or link below. The old
                video is not reused.
              </p>
            </div>
          ) : null}
          {cloneError ? (
            <div
              role="alert"
              className="mb-4 rounded-2xl border border-red-400/40 bg-red-400/10 p-4 text-sm text-red-200"
            >
              {cloneError}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
          {!file ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="Drop a video file here or click to browse"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                handleFile(e.dataTransfer.files?.[0])
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
                dragOver ? 'border-brand bg-brand/10' : 'border-ink-border bg-ink-panel hover:border-brand/60'
              }`}
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/15 text-brand-light">
                <CloudUpload className="h-8 w-8" />
              </span>
              <h2 className="mt-4 text-lg font-semibold text-white">
                Drag &amp; drop your video here or click to browse
              </h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Supports: MP4, MOV, MKV, WEBM. The file is uploaded to the local
                video engine and probed with ffprobe — nothing is sent to any
                other service.
              </p>
              <span className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white">
                Choose File
              </span>
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mkv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </div>
          ) : (
            <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
                    <FileVideo className="h-6 w-6" />
                  </span>
                  <div>
                    <h2 className="font-semibold text-white">{file.name}</h2>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      {probeStatus === 'probing'
                        ? 'Uploading to the engine…'
                        : probeStatus === 'done'
                          ? 'Probed by the engine — metadata below is authoritative'
                          : probeStatus === 'error'
                            ? 'Probe failed — see the error below'
                            : 'Reading metadata…'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={clearFile}
                  aria-label="Remove file"
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-border text-[var(--color-text-muted)] hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {previewUrl ? (
                <video
                  src={previewUrl}
                  controls
                  preload="metadata"
                  className="mt-5 max-h-80 w-full rounded-xl bg-black"
                />
              ) : (
                <p className="mt-5 text-sm text-[var(--color-text-muted)]">
                  Preparing preview…
                </p>
              )}

              {browserMeta && probeStatus !== 'done' ? (
                <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                  Browser reading: {formatDuration(browserMeta.duration)} ·{' '}
                  {browserMeta.width} × {browserMeta.height}
                </p>
              ) : null}

              {probeStatus === 'probing' ? (
                <div className="mt-5 flex items-start gap-3 rounded-xl bg-ink-panel2 p-4">
                  <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand-light" />
                  <div>
                    <p className="text-sm font-medium text-white">
                      {IS_LOCAL_SITE ? 'Uploading to engine…' : 'Reading video…'}
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                      {IS_LOCAL_SITE
                        ? 'Probing with ffprobe… follows on the engine once the upload finishes. No fake progress is shown.'
                        : 'Your browser is reading the duration and resolution. No fake progress is shown.'}
                    </p>
                  </div>
                </div>
              ) : null}

              {probeStatus === 'error' ? (
                <div role="alert" className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
                    <AlertTriangle className="h-4 w-4" /> Probe failed
                  </p>
                  <p className="mt-2 break-words text-sm text-red-200/90">{probeError}</p>
                  {probeUnreachable && IS_LOCAL_SITE ? (
                    <p className="mt-3 text-sm text-red-200/90">
                      Video engine is not reachable at {ENGINE_URL} — start it
                      with:
                    </p>
                  ) : null}
                  {probeUnreachable && IS_LOCAL_SITE ? (
                    <code className="mt-2 block overflow-x-auto rounded-lg bg-black/40 px-3 py-2 text-xs text-white">
                      {ENGINE_START_COMMAND}
                    </code>
                  ) : null}
                  {probeUnreachable && !IS_LOCAL_SITE ? (
                    <p className="mt-3 text-sm text-red-200/90">
                      Video engine is not reachable at {ENGINE_URL}. This site
                      processes videos through the connected worker instead —
                      submit your video as a New Job and the finished clips
                      will appear on the job page.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => startProbe(file, projectId)}
                    className="mt-4 flex items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white"
                  >
                    <RotateCcw className="h-4 w-4" /> Retry probe
                  </button>
                </div>
              ) : null}

              {probeStatus === 'done' && probe ? (
                <>
                  <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {engineMeta.map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-ink-panel2 p-3">
                        <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
                        <dd className="mt-1 break-words text-sm font-medium text-white">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {probe.probed_by === 'browser' ? (
                    <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                      Read in your browser — frame rate and codecs are checked
                      by the server when the job is created.
                    </p>
                  ) : null}
                  {browserDiffers && browserMeta ? (
                    <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                      Engine values are authoritative — they differ from the
                      browser&apos;s reading (browser: {formatDuration(browserMeta.duration)},{' '}
                      {browserMeta.width} × {browserMeta.height}).
                    </p>
                  ) : null}
                  {project ? (
                    <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                      Saved as project “{project.title}” (draft).
                    </p>
                  ) : null}

                  <div className="mt-6 border-t border-ink-border pt-5">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                      <AudioLines className="h-4 w-4 text-brand-light" />
                      Audio extraction
                    </h3>
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                      Extract a 16 kHz mono WAV for transcription. Audio extraction
                      works — transcription arrives in Phase 3.
                    </p>
                    <button
                      type="button"
                      onClick={startExtractAudio}
                      disabled={audioStatus === 'extracting'}
                      className="mt-3 flex items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {audioStatus === 'extracting' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <AudioLines className="h-4 w-4" />
                      )}
                      {audioStatus === 'extracting'
                        ? 'Extracting audio…'
                        : 'Extract audio (16 kHz mono WAV)'}
                    </button>
                    {audioStatus === 'done' && audioResult ? (
                      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {[
                          ['Duration', formatDuration(audioResult.duration_seconds ?? Number.NaN)],
                          ['Sample rate', `${audioResult.sample_rate.toLocaleString()} Hz`],
                          ['Channels', audioResult.channels === 1 ? '1 (mono)' : String(audioResult.channels)],
                          ['Size', formatBytes(audioResult.size_bytes)],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-xl bg-ink-panel2 p-3">
                            <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
                            <dd className="mt-1 break-words text-sm font-medium text-white">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {audioStatus === 'error' ? (
                      <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                        Audio extraction failed: {audioError}
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}

              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-5 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                Choose a different file
              </button>
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mkv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </div>
          )}

          {fileError ? (
            <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {fileError}
            </p>
          ) : null}

          <div className="mt-6 rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="flex items-center gap-2 text-base font-semibold text-white">
              <Link2 className="h-5 w-5 text-brand-light" /> Import from a link
            </h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Paste a YouTube, Google Drive or direct video link. Click
              Import link, then style it on Step 2 — the worker downloads
              the video and the job page shows the real result.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                type="url"
                value={linkUrl}
                onChange={(e) => {
                  setLinkUrl(e.target.value)
                  setLinkError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitLink()
                }}
                placeholder="Paste a YouTube, Drive or video link…"
                aria-label="Video link to import"
                className="w-full flex-1 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={submitLink}
                className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
              >
                Import link
              </button>
            </div>
            {linkError ? (
              <p role="alert" className="mt-3 text-sm text-red-300">
                {linkError}
              </p>
            ) : null}
            {linkSource ? (
              <p className="mt-3 text-xs text-white">
                Link ready: <span className="break-all">{linkSource}</span>
                <button
                  type="button"
                  onClick={() => {
                    setLinkSource(null)
                    setLinkUrl('')
                  }}
                  className="ml-2 text-xs font-medium text-red-300 hover:underline"
                >
                  Remove
                </button>
              </p>
            ) : null}
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={projectId === null && linkSource === null}
              onClick={() => goTo(2)}
              className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue to Style <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {projectId === null && linkSource === null ? (
            <p className="mt-2 text-right text-xs text-[var(--color-text-muted)]">
              {probeStatus === 'probing'
                ? IS_LOCAL_SITE
                  ? 'Probing with the engine — please wait.'
                  : 'Reading the video in your browser — please wait.'
                : probeStatus === 'error'
                  ? 'Probe failed — retry or choose a different file.'
                  : IS_LOCAL_SITE
                    ? 'Choose a video and let the engine probe it to continue, or import a link.'
                    : 'Choose a video — your browser reads its duration and resolution — to continue, or import a link.'}
            </p>
          ) : null}
            </div>

            {/* Right rail — design-reference Clipping Options + Why card.
                The controls below edit the same spec as Step 2 (Style);
                Step 2 stays the full form. */}
            <aside className="space-y-4">
              <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
                <h2 className="text-lg font-semibold text-white">Clipping Options</h2>
                <div className="mt-4 block">
                  <span className="text-sm font-medium text-white">Number of Clips</span>
                  <Dropdown
                    value={String(gatedClipCount)}
                    ariaLabel="Number of clips"
                    options={[
                      ...[1, 3, 5, 10]
                        .filter((n) => n <= effectiveMaxClips)
                        .map((n) => ({ value: String(n), label: `${n} clip${n === 1 ? '' : 's'}` })),
                      ...(![1, 3, 5, 10].includes(gatedClipCount)
                        ? [{ value: String(gatedClipCount), label: `${gatedClipCount} clips (custom)` }]
                        : []),
                    ]}
                    onChange={(v) => applyClipCount(Number(v))}
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Max {effectiveMaxClips} clips per job.
                  </span>
                </div>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-white">Clip Duration</span>
                  {spec.durationMode === 'exact' ? (
                    <Dropdown
                      value={String(spec.durationSeconds)}
                      ariaLabel="Clip duration in seconds"
                      options={[
                        ...[15, 20, 30, 45, 60].map((n) => ({
                          value: String(n),
                          label: `${n} seconds`,
                        })),
                        ...(![15, 20, 30, 45, 60].includes(spec.durationSeconds)
                          ? [{ value: String(spec.durationSeconds), label: `${spec.durationSeconds} seconds (custom)` }]
                          : []),
                      ]}
                      onChange={(v) => applyDuration(Number(v))}
                    />
                  ) : (
                    <p className="mt-2 text-sm text-white">
                      {spec.durationMinSeconds}–{spec.durationMaxSeconds}s ({spec.durationMode})
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        Set the range on Step 2.
                      </span>
                    </p>
                  )}
                </label>
                <div className="mt-4 block">
                  <span className="text-sm font-medium text-white">Clip selection</span>
                  <Dropdown
                    value={spec.selectionMode ?? 'interesting_only'}
                    ariaLabel="Clip selection"
                    options={(Object.keys(SELECTION_MODE_LABELS) as SelectionMode[]).map((id) => ({
                      value: id,
                      label: SELECTION_MODE_LABELS[id],
                    }))}
                    onChange={(v) => updateSpec({ selectionMode: v as SelectionMode })}
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {SELECTION_MODE_DESCRIPTIONS[spec.selectionMode ?? 'interesting_only']}
                  </span>
                </div>
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">Vertical (9:16)</span>
                    <Toggle
                      checked={spec.aspect === '9:16'}
                      onChange={(v) => applyAspect(v ? '9:16' : '16:9')}
                      label="Vertical 9:16 on or off"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">Add Animated Captions</span>
                    {captionsOff ? (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        Captions are disabled by the admin
                      </span>
                    ) : (
                      <Toggle
                        checked={spec.captions}
                        onChange={(v) => updateSpec({ captions: v })}
                        label="Animated captions on or off"
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">On-screen text</span>
                    {ostOff ? (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        On-screen text is disabled by the admin
                      </span>
                    ) : (
                      <Toggle
                        checked={spec.onScreenText}
                        onChange={(v) => updateSpec({ onScreenText: v })}
                        label="On-screen text on or off"
                      />
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={projectId === null && linkSource === null}
                  onClick={() => goTo(2)}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue to Style <ArrowRight className="h-4 w-4" />
                </button>
                <p className="mt-2 text-center text-xs text-[var(--color-text-muted)]">
                  {projectId === null && linkSource === null
                    ? 'Choose a video first — options save into its project.'
                    : `Live summary: ${summary}`}
                </p>
              </div>

              <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
                <h2 className="text-lg font-semibold text-white">Why Magician Clipper?</h2>
                <ul className="mt-4 space-y-3 text-sm text-white">
                  {[
                    'AI-Powered Moment Detection',
                    'Smart Captions & Subtitles',
                    'Professional Video Editor',
                    'One-Click Export',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
                  Moment detection, caption burn-in and export arrive with the
                  Phase 3 pipeline. Import, probing and the editor work today.
                </p>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section aria-label="Step 2 — Style">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">{t('chooseStyle')}</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {file
                ? `Video: ${file.name} · ${formatBytes(file.size)}`
                : linkSource
                  ? `Link: ${linkSource}`
                  : 'Set the style for this job.'}
              {project ? ` · Project: ${project.title}` : ''}
            </p>

            {/* Load preset — same pattern as the New Job page's presets
                card, compact. Loads the preset's settings into this
                form; the video stays the one picked on Step 1. The
                save control lives here too (the wizard is the only
                creation flow now). */}
            <div className="mt-5 rounded-xl border border-ink-border bg-ink-panel2 p-4">
              <div className="block">
                <span className="text-sm font-medium text-white">Load preset</span>
                <Dropdown
                  value={selectedPresetId}
                  ariaLabel="Load a saved job preset into the style form"
                  options={[
                    { value: '', label: 'Choose a preset…' },
                    ...presets.map((p) => ({ value: String(p.id), label: p.name })),
                  ]}
                  onChange={(v) => {
                    setSelectedPresetId(v)
                    const id = Number(v)
                    if (id > 0) handleLoadPreset(id)
                  }}
                />
              </div>
              {presetMessage ? (
                <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {presetMessage}
                </p>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {presets.length === 0
                    ? 'No presets saved yet — save one below.'
                    : 'Loads a saved preset’s settings into this form.'}
                </p>
              )}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset name…"
                  aria-label="New preset name"
                  maxLength={100}
                  className="w-full flex-1 rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSavePreset()}
                  disabled={presetSaving}
                  className="rounded-xl border border-ink-border bg-ink-panel px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {presetSaving ? 'Saving…' : 'Save preset'}
                </button>
              </div>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Saves the current settings under a name (no video — the
                video is always chosen fresh).
              </p>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              <fieldset>
                <legend className="text-sm font-medium text-white">Platform</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  <ChoiceButton
                    selected={spec.platform === 'tiktok'}
                    onClick={() => updateSpec({ platform: 'tiktok' })}
                  >
                    TikTok
                  </ChoiceButton>
                  <ChoiceButton
                    selected={spec.platform === 'instagram'}
                    onClick={() => updateSpec({ platform: 'instagram' })}
                  >
                    Instagram
                  </ChoiceButton>
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">Aspect ratio</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['9:16', '16:9', '1:1', '4:5'] as const).map((a) => (
                    <ChoiceButton
                      key={a}
                      selected={spec.aspect === a}
                      onClick={() => applyAspect(a)}
                    >
                      {a === '9:16'
                        ? 'Vertical (9:16)'
                        : a === '16:9'
                          ? 'Landscape (16:9)'
                          : a === '1:1'
                            ? 'Square (1:1)'
                            : 'Portrait (4:5)'}
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">Number of clips</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CLIP_COUNT_PRESETS.filter((n) => n <= effectiveMaxClips).map((n) => (
                    <ChoiceButton
                      key={n}
                      selected={gatedClipCount === n}
                      onClick={() => applyClipCount(n)}
                    >
                      {n}
                    </ChoiceButton>
                  ))}
                  <label className="flex items-center gap-2">
                    <span className="text-sm text-[var(--color-text-muted)]">Custom</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={effectiveMaxClips}
                      value={clipCountText}
                      onChange={(e) => onClipCountText(e.target.value)}
                      aria-label={`Custom number of clips (1 to ${effectiveMaxClips})`}
                      className="w-20 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                    />
                  </label>
                </div>
                {clipCountError ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">{clipCountError}</p>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">Max {effectiveMaxClips} clips per job.</p>
                )}
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">Clip duration</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['exact', 'minimum', 'maximum'] as const).map((m) => (
                    <ChoiceButton
                      key={m}
                      selected={spec.durationMode === m}
                      onClick={() => updateSpec({ durationMode: m })}
                    >
                      {m === 'exact' ? 'Exact' : m === 'minimum' ? 'Minimum' : 'Maximum'}
                    </ChoiceButton>
                  ))}
                </div>
                {spec.durationMode === 'exact' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {DURATION_PRESETS.map((n) => (
                      <ChoiceButton
                        key={n}
                        selected={spec.durationSeconds === n}
                        onClick={() => applyDuration(n)}
                      >
                        {n}s
                      </ChoiceButton>
                    ))}
                    <label className="flex items-center gap-2">
                      <span className="text-sm text-[var(--color-text-muted)]">Custom</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={300}
                        value={durationText}
                        onChange={(e) => onDurationText(e.target.value)}
                        aria-label="Custom clip duration in seconds (5 to 300)"
                        className="w-20 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                      />
                      <span className="text-sm text-[var(--color-text-muted)]">seconds</span>
                    </label>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">
                      <span className="text-sm text-[var(--color-text-muted)]">Min</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={180}
                        value={durationMinText}
                        onChange={(e) => onDurationRangeText('min', e.target.value)}
                        aria-label="Minimum clip duration in seconds (5 to 180)"
                        className="w-20 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="text-sm text-[var(--color-text-muted)]">Max</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={180}
                        value={durationMaxText}
                        onChange={(e) => onDurationRangeText('max', e.target.value)}
                        aria-label="Maximum clip duration in seconds (5 to 180)"
                        className="w-20 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                      />
                    </label>
                    <span className="text-sm text-[var(--color-text-muted)]">seconds</span>
                  </div>
                )}
                {durationError ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">{durationError}</p>
                ) : durationRangeError ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">{durationRangeError}</p>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    {spec.durationMode === 'exact'
                      ? 'Each clip is exactly this long.'
                      : spec.durationMode === 'minimum'
                        ? 'Clips are at least the minimum long, up to the maximum.'
                        : 'Clips are at most the maximum long, at least the minimum.'}
                  </p>
                )}
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">Clip selection</legend>
                <Dropdown
                  value={spec.selectionMode ?? 'interesting_only'}
                  ariaLabel="Clip selection"
                  options={(Object.keys(SELECTION_MODE_LABELS) as SelectionMode[]).map((id) => ({
                    value: id,
                    label: SELECTION_MODE_LABELS[id],
                  }))}
                  onChange={(v) => updateSpec({ selectionMode: v as SelectionMode })}
                />
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {SELECTION_MODE_DESCRIPTIONS[spec.selectionMode ?? 'interesting_only']}
                </p>
              </fieldset>

              {/* Batch 13: layout picker — visible for EVERY ratio.
                  Only the layouts that genuinely render on the chosen
                  canvas are offered (all ten on portrait frames, six
                  on 16:9/1:1); the worker renders the stored layout
                  for the chosen ratio. Card grid on the same system
                  as the caption picker (gradient backdrop diagrams,
                  2 per row, gradient border + checkmark). */}
              <div className="md:col-span-2">
                <span className="text-sm font-medium text-white">Layout</span>
                  <div className="mt-2">
                    <PickerDropdown
                      label="Layout"
                      open={layoutOpen}
                      onToggle={() => setLayoutOpen((v) => !v)}
                      header={
                        <>
                          <span aria-hidden="true" className="block h-14 w-8 shrink-0 overflow-hidden rounded">
                            <span className="block origin-top-left scale-[0.44]">
                              <LayoutMiniPreview layout={spec.layout} />
                            </span>
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-white">
                              {LAYOUT_LABELS[spec.layout].split(' — ')[0]}
                            </span>
                            <span className="block text-xs text-[var(--color-text-muted)]">
                              Tap to change layout
                            </span>
                          </span>
                        </>
                      }
                    >
                      <LayoutPicker
                        value={spec.layout}
                        onChange={(layout) => updateSpec({ layout })}
                        allowed={LAYOUTS_BY_ASPECT[spec.aspect]}
                      />
                    </PickerDropdown>
                  </div>
                  <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                    How the video fills the {spec.aspect} frame.
                    {spec.aspect === '9:16' || spec.aspect === '4:5'
                      ? ' All ten layouts are available on portrait frames.'
                      : ' Only layouts that work on this ratio are shown.'}
                  </span>
                </div>

              {/* Batch 10: when captions are off, the whole block
                  (toggle, style picker, language + translation
                  selectors) is replaced by an honest note. */}
              {captionsOff ? (
                <div className="md:col-span-2">
                  <span className="text-sm font-medium text-white">Captions</span>
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    Captions are disabled by the admin.
                  </p>
                </div>
              ) : (
              <div className="md:col-span-2">
                <span className="text-sm font-medium text-white">Captions</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.captions}
                    onChange={(v) => updateSpec({ captions: v })}
                    label="Captions on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.captions ? 'Captions on' : 'Captions off'}
                  </span>
                </div>
                {/* Caption position — directly below the "Captions on"
                    toggle (user placement spec, Batch 9): a dropdown,
                    Bottom / Top / Centre. The stored value for Centre
                    is "middle" (the existing caption_position value);
                    only the label changed. Disabled while captions
                    are off, like the style picker. */}
                <div className="mt-3 block">
                  <span className="text-sm font-medium text-white">Caption position</span>
                  <Dropdown
                    value={spec.captionPosition ?? 'bottom'}
                    disabled={!spec.captions}
                    ariaLabel="Caption position"
                    options={(['bottom', 'top', 'middle'] as CaptionPosition[]).map((p) => ({
                      value: p,
                      label: CAPTION_POSITION_LABELS[p],
                    }))}
                    onChange={(v) => updateSpec({ captionPosition: v as CaptionPosition })}
                  />
                  <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                    Where the burn-in captions sit — never over the headline.
                  </span>
                </div>
                {/* Caption language — directly below the Caption
                    position dropdown (user placement spec, Batch 9):
                    which language the SPEECH is in. This is the
                    transcription language, not the output language. */}
                <div className="mt-3 block">
                  <span className="text-sm font-medium text-white">Caption language</span>
                  <Dropdown
                    value={spec.captionsLanguage}
                    disabled={!spec.captions}
                    ariaLabel="Caption language"
                    options={CAPTION_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
                    onChange={(v) =>
                      updateSpec({ captionsLanguage: v as ClipSpec['captionsLanguage'] })
                    }
                  />
                  <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                    The language of the speech in the video. Auto-detect lets
                    the transcriber decide.
                  </span>
                </div>
                {/* Translate captions — directly below the Caption
                    language dropdown. Translates the captions AFTER
                    transcription (Batch 9: 32 languages). If the free
                    service is unavailable, captions stay in the
                    original language and the job says so. */}
                {/* Batch 10: caption translation is hidden when the
                    translation feature is off (captions themselves
                    stay on). */}
                {translationOff ? (
                  <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                    Caption translation is disabled by the admin.
                  </p>
                ) : (
                <div className="mt-3 block">
                  <span className="text-sm font-medium text-white">Translate captions</span>
                  <Dropdown
                    value={spec.captionTranslation ?? 'none'}
                    disabled={!spec.captions}
                    ariaLabel="Translate captions"
                    options={(Object.keys(CAPTION_TRANSLATION_LABELS) as CaptionTranslation[]).map((t) => ({
                      value: t,
                      label: CAPTION_TRANSLATION_LABELS[t],
                    }))}
                    onChange={(v) => updateSpec({ captionTranslation: v as CaptionTranslation })}
                  />
                  <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                    Translates the captions after transcription. If the free
                    translation service is unavailable, captions stay in the
                    original language and the job says so.
                  </span>
                </div>
                )}
                <div className="mt-3">
                  <span className="text-sm font-medium text-white">Caption style</span>
                  <div className="mt-2">
                    <PickerDropdown
                      label="Caption style"
                      open={captionStyleOpen}
                      onToggle={() => setCaptionStyleOpen((v) => !v)}
                      header={
                        <>
                          {/* Batch 13: header miniature — the same
                              smaller card preview (52x93) scaled to
                              half again, 26x46. */}
                          <span aria-hidden="true" className="block h-[46px] w-[26px] shrink-0 overflow-hidden rounded">
                            <span className="block w-[104px] origin-top-left scale-[0.25]">
                              <CaptionStylePreview style={getCaptionStyle(spec.captionStyle)} />
                            </span>
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-white">
                              {captionLabel}
                            </span>
                            <span className="block text-xs text-[var(--color-text-muted)]">
                              Tap to change caption style
                            </span>
                          </span>
                        </>
                      }
                    >
                      <CaptionStylePicker
                        value={spec.captionStyle}
                        onChange={(realId) => updateSpec({ captionStyle: realId })}
                        disabled={!spec.captions}
                      />
                    </PickerDropdown>
                  </div>
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Selected caption style: <span className="font-medium text-white">{captionLabel}</span>
                  {' '}— kept with this wizard session; captions are rendered in Phase 3.
                </p>
              </div>
              )}

              {/* Batch 10: when on-screen text is off, the whole block
                  (toggle, position + language selectors) is replaced
                  by an honest note. */}
              {ostOff ? (
                <div>
                  <span className="text-sm font-medium text-white">On-screen text</span>
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    On-screen text is disabled by the admin.
                  </p>
                </div>
              ) : (
              <div>
                <span className="text-sm font-medium text-white">On-screen text</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.onScreenText}
                    onChange={(v) => updateSpec({ onScreenText: v })}
                    label="On-screen text on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.onScreenText ? 'On-screen text on' : 'On-screen text off'}
                  </span>
                </div>
                {/* On-screen text position — directly below the
                    "On-screen text on" toggle (user placement spec,
                    Batch 9): a dropdown, Bottom / Top / Centre.
                    Always visible; disabled while on-screen text is
                    off. Picking a headline style moves it to that
                    style's default until a position is picked here. */}
                <div className="mt-3 block">
                  <span className="text-sm font-medium text-white">On-screen text position</span>
                  <Dropdown
                    value={spec.ostPosition ?? defaultOstPosition(spec.headlineStyle ?? 'bold_bar')}
                    disabled={!spec.onScreenText}
                    ariaLabel="On-screen text position"
                    options={(['bottom', 'top', 'centre'] as OstPosition[]).map((p) => ({
                      value: p,
                      label: OST_POSITION_LABELS[p],
                    }))}
                    onChange={(v) => {
                      ostPositionTouchedRef.current = true
                      updateSpec({ ostPosition: v as OstPosition })
                    }}
                  />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Where the headline sits on the frame. Default follows the style.
                  </span>
                </div>
                {/* On-screen text language — directly below the
                    On-screen text position dropdown (user placement
                    spec, Batch 9): the headline's OUTPUT language.
                    'Source language' keeps the headline in the
                    video's own language. The end-card text and
                    lower-third tag are never translated. */}
                {/* Batch 10: the OST language selector is a translation
                    control — hidden when translation is off. */}
                {translationOff ? (
                  <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                    On-screen text translation is disabled by the admin.
                  </p>
                ) : (
                <div className="mt-3 block">
                  <span className="text-sm font-medium text-white">On-screen text language</span>
                  <Dropdown
                    value={spec.ostLanguage ?? 'source'}
                    disabled={!spec.onScreenText}
                    ariaLabel="On-screen text language"
                    options={(Object.keys(OST_LANGUAGE_LABELS) as OstLanguage[]).map((l) => ({
                      value: l,
                      label: OST_LANGUAGE_LABELS[l],
                    }))}
                    onChange={(v) => updateSpec({ ostLanguage: v as OstLanguage })}
                  />
                  <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                    Translates the headline into this language. If the free
                    translation service is unavailable, the headline stays
                    in the source language and the job says so.
                  </span>
                </div>
                )}
              </div>
              )}

              {/* Batch 2 headline style — defaults are the pre-Batch-2
                  behaviour (bold bar). Batch 8: static card grid, no
                  motion. The OST position dropdown lives under the
                  On-screen text toggle above, not here. */}
              <div className="block md:col-span-2">
                <span className="text-sm font-medium text-white">Headline style</span>
                <div className="mt-2">
                  <PickerDropdown
                    label="Headline style"
                    open={headlineStyleOpen}
                    onToggle={() => setHeadlineStyleOpen((v) => !v)}
                    header={
                      <>
                        {/* Batch 13: header miniature, 26x46 — see
                            the caption header above. */}
                        <span aria-hidden="true" className="block h-[46px] w-[26px] shrink-0 overflow-hidden rounded">
                          <span className="block w-[104px] origin-top-left scale-[0.25]">
                            <HeadlineStyleStill
                              style={spec.headlineStyle ?? 'bold_bar'}
                              className="relative block aspect-[9/16] w-full overflow-hidden rounded border border-white/10 caption-preview"
                            />
                          </span>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-white">
                            {HEADLINE_STYLE_LABELS[spec.headlineStyle ?? 'bold_bar']}
                          </span>
                          <span className="block text-xs text-[var(--color-text-muted)]">
                            Tap to change headline style
                          </span>
                        </span>
                      </>
                    }
                  >
                    <HeadlineStylePicker
                      value={spec.headlineStyle ?? 'bold_bar'}
                      onChange={pickHeadlineStyle}
                    />
                  </PickerDropdown>
                </div>
              </div>








              {/* Batch 3 beat sync + export ratios. The Translate
                  captions control lives with the caption controls
                  above (directly below the Caption language
                  dropdown), not here. Batch 10: hidden with an
                  honest note when beat sync is off. */}
              {beatSyncOff ? (
                <div>
                  <span className="text-sm font-medium text-white">Beat sync</span>
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    Beat sync is disabled by the admin.
                  </p>
                </div>
              ) : (
              <div>
                <span className="text-sm font-medium text-white">Beat sync</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.beatSync ?? true}
                    onChange={(v) => updateSpec({ beatSync: v })}
                    label="Beat sync on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    Beat sync — snap cuts and zoom to the beat of the audio
                  </span>
                </div>
              </div>
              )}



              {/* Batch 6 caption safe zone — default ON. When ON,
                  captions keep clear of TikTok's right action rail
                  and the bottom bar; OFF restores full-width centred
                  captions. */}
              <div>
                <span className="text-sm font-medium text-white">Caption safe zone</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.captionSafeZone ?? true}
                    onChange={(v) => updateSpec({ captionSafeZone: v })}
                    label="Caption safe zone on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    Caption safe zone — keep captions clear of TikTok's
                    right action rail and bottom bar
                  </span>
                </div>
              </div>

              {/* Batch 1 clip enhancements — all default ON. A spec saved
                  before they existed has no value; `?? true` keeps the
                  default instead of silently turning one off. */}
              <div>
                <span className="text-sm font-medium text-white">Clip enhancements</span>
                <div className="mt-2 space-y-3">
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={spec.autoZoom ?? true}
                      onChange={(v) => updateSpec({ autoZoom: v })}
                      label="Auto zoom on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Auto zoom — slow punch-in on the exciting parts
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={spec.faceTracking ?? true}
                      onChange={(v) => updateSpec({ faceTracking: v })}
                      label="Face tracking on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Face tracking — keep the speaker centred as they move
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={spec.silenceRemoval ?? true}
                      onChange={(v) => updateSpec({ silenceRemoval: v })}
                      label="Silence removal on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Remove silence — trim pauses over 0.7s, start on speech
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={spec.fillerRemoval ?? true}
                      onChange={(v) => updateSpec({ fillerRemoval: v })}
                      label="Filler removal on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Remove filler words — cut um, uh, hmm, erm
                    </span>
                  </div>
                  {/* Batch 15: loop-perfect clips — the only new
                      wizard toggle in this batch (parity rule: add
                      only this one). Default OFF. */}
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={spec.loopPerfect ?? false}
                      onChange={(v) => updateSpec({ loopPerfect: v })}
                      label="Loop-perfect clip on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Loop-perfect clip — end matches the start so it loops smoothly on TikTok
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-3 block">
                <span className="text-sm font-medium text-white">Content type</span>
                  <Dropdown
                    value={spec.contentType}
                    ariaLabel="Content type"
                    options={CONTENT_TYPES.map((c) => ({ value: c.id, label: c.label }))}
                    onChange={(v) => updateSpec({ contentType: v as ClipSpec['contentType'] })}
                  />
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Content type: <span className="font-medium text-white">{contentLabel}</span>
                </p>



              {/* Batch 9: quality — the direct control (same field
                  New Job sets). It moves with the processing mode
                  below: picking a quality sets the matching mode and
                  vice versa, so the two can never disagree. */}
              <div className="block">
                <span className="text-sm font-medium text-white">Quality</span>
                <Dropdown
                  value={spec.quality}
                  ariaLabel="Render quality"
                  options={[
                    { value: 'draft', label: 'Draft preview' },
                    { value: 'standard', label: 'Standard' },
                    { value: 'high', label: 'High quality' },
                  ]}
                  onChange={(v) => updateQuality(v as ClipSpec['quality'])}
                />
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Render quality for this job. High quality takes longer.
                </span>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  The source is the ceiling — a 360p source can never become true 1080p. The boost squeezes the maximum out of it.
                </span>
              </div>

              {/* Batch 11: export tier — 720p (Free) or 1080p (paid
                  plan). The tier caps resolution + bitrate only; the
                  render quality above is separate. 1080p is locked
                  while the plan cap is 720p; the server enforces the
                  same rule at submit. */}
              <div className="block">
                <span className="text-sm font-medium text-white">Export quality</span>
                <Dropdown
                  value={spec.exportQuality ?? '720p'}
                  ariaLabel="Export quality"
                  options={[
                    { value: '720p', label: '720p (Free)' },
                    {
                      value: '1080p',
                      label: `1080p${maxExportHeight !== null && maxExportHeight < 1080 ? ' — locked' : ''}`,
                      disabled: maxExportHeight !== null && maxExportHeight < 1080,
                    },
                  ]}
                  onChange={(v) => updateSpec({ exportQuality: v as ClipSpec['exportQuality'] })}
                />
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  {maxExportHeight !== null && maxExportHeight < 1080 ? (
                    <>
                      1080p needs a paid plan.{' '}
                      <button
                        type="button"
                        onClick={() => navigate('/plans')}
                        className="font-medium text-brand-light hover:underline"
                      >
                        See Plans to upgrade
                      </button>
                    </>
                  ) : (
                    'Free exports are capped at 720p; paid plans go to 1080p.'
                  )}
                </span>
              </div>

              <fieldset className="md:col-span-2">
                <legend className="text-sm font-medium text-white">Processing mode</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['eco', 'balanced', 'fast'] as const).map((m) => (
                    <ChoiceButton
                      key={m}
                      selected={spec.processingMode === m}
                      onClick={() => updateProcessingMode(m)}
                    >
                      {m === 'eco' ? 'Eco' : m === 'balanced' ? 'Balanced' : 'Fast'}
                    </ChoiceButton>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Processing mode follows the quality above (Eco = Draft,
                  Balanced = Standard, Fast = High quality).
                </p>
              </fieldset>

              {/* Batch 9: job type + campaign requirements (same as
                  New Job). Campaign jobs need requirements filled in
                  before the wizard can continue. */}
              <fieldset className="md:col-span-2">
                <legend className="text-sm font-medium text-white">Job type</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  <ChoiceButton
                    selected={spec.jobType === 'myself'}
                    onClick={() => updateSpec({ jobType: 'myself' })}
                  >
                    For myself
                  </ChoiceButton>
                  <ChoiceButton
                    selected={spec.jobType === 'campaign'}
                    onClick={() => updateSpec({ jobType: 'campaign' })}
                  >
                    For a campaign
                  </ChoiceButton>
                </div>
                {spec.jobType === 'campaign' ? (
                  <div className="mt-3 space-y-4 rounded-xl border border-ink-border bg-ink-panel2 p-4">
                    {/* Batch 14: ONE box — the full campaign brief
                        pasted from the campaign site (e.g. Genni).
                        The backend reads it and extracts what it can
                        follow (required vs optional, on-screen text,
                        captions, hashtags, audio links); anything it
                        cannot read becomes a manual check on the job
                        page. The old per-item sections are gone — the
                        user never fills them one by one. */}
                    <label className="block">
                      <span className="text-sm font-medium text-white">Campaign informations</span>
                      <textarea
                        value={spec.campaignRequirements}
                        onChange={(e) => updateSpec({ campaignRequirements: e.target.value })}
                        rows={10}
                        maxLength={5000}
                        placeholder="Paste the full campaign brief here — copied from the campaign site (e.g. Genni)…"
                        className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                      />
                      <span className="mt-1 flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                        <span>
                          The system reads the brief and follows required items strictly, optional
                          items best-effort. Anything it cannot read becomes a manual check on the
                          job page. It reads the standard campaign format — it does not understand
                          free-form prose the way a person would.
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {spec.campaignRequirements.length}/5000
                        </span>
                      </span>
                    </label>
                  </div>
                ) : null}
                {campaignInvalid ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">
                    Paste the campaign informations — the worker clips to that brief.
                  </p>
                ) : null}
              </fieldset>
            </div>

            <div className="mt-6 rounded-xl border border-brand/40 bg-brand/10 p-4">
              <p className="text-xs text-[var(--color-text-muted)]">Live summary</p>
              <p className="mt-1 text-sm font-medium text-white">{summary}</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Caption style: {captionLabel} · Content: {contentLabel} ·{' '}
                {spec.quality === 'draft'
                  ? 'Draft preview'
                  : spec.quality === 'high'
                    ? 'High quality'
                    : 'Standard'}{' '}
                · {LAYOUT_LABELS[spec.layout]} ·{' '}
                {spec.jobType === 'campaign' ? 'For a campaign' : 'For myself'}
              </p>
            </div>

            <div className="mt-6 flex justify-between">
              <button
                type="button"
                onClick={() => goTo(1)}
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                disabled={(projectId === null && linkSource === null) || !specValid}
                onClick={() => goTo(3)}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue to Process <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            {(projectId === null && linkSource === null) || !specValid ? (
              <p className="mt-2 text-right text-xs text-[var(--color-text-muted)]">
                {projectId === null && linkSource === null
                  ? 'Probe a video on Step 1 first — the style is saved into its project.'
                  : 'Fix the highlighted fields to continue.'}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section aria-label="Step 3 — Process">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">{t('processTitle')}</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {project ? `Project: ${project.title} · ` : ''}{summary}
            </p>
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">
              Transcription, highlight detection and rendering run on the job
              page through the connected worker — not in this wizard. Start
              processing below to create the job; the stages below show
              what the worker will do there.
            </p>

            <ol className="mt-5 space-y-2">
              {PIPELINE_STAGES.map((label, i) => {
                const done = audioResult !== null && i < 2
                const jobId =
                  i === 0 ? probe?.job_id : i === 1 ? audioResult?.job_id : undefined
                return (
                  <li
                    key={label}
                    className="flex items-center gap-3 rounded-xl bg-ink-panel2 px-4 py-3"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white">
                      {i + 1}
                    </span>
                    {done ? (
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                    ) : (
                      <Clock className="h-5 w-5 shrink-0 text-[var(--color-text-muted)]" />
                    )}
                    <span className="flex-1 text-sm font-medium text-white">{label}</span>
                    {done ? (
                      <span className="text-right text-xs text-emerald-300">
                        Done (probe + audio extraction verified)
                        {jobId ? (
                          <span className="block text-emerald-200/70">job {jobId}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        Runs on the job page
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>

            <div className="mt-6 flex justify-between">
              <button
                type="button"
                onClick={() => goTo(2)}
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                onClick={() => void startRealProcessing()}
                disabled={processing || !specValid || maintenanceOn || dailyExhausted}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {processing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {uploadProgress !== null && uploadProgress < 1
                      ? `Uploading… ${Math.round(uploadProgress * 100)}%`
                      : 'Creating job…'}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Start Processing
                  </>
                )}
              </button>
            </div>
            {processing && uploadProgress !== null ? (
              <p className="mt-3 text-right text-xs text-[var(--color-text-muted)]">
                Uploading your video — large videos can take a few minutes on a slow connection. Please keep this page open.
              </p>
            ) : null}
            {/* Batch 10: daily usage (admins have no limit, so no line)
                and the honest reason the button is disabled. */}
            {daily !== null && daily.limit !== null ? (
              <p className="mt-3 text-right text-xs text-[var(--color-text-muted)]">
                {daily.used_today} of {daily.limit} jobs used today
                {dailyExhausted
                  ? ' — you have used all your jobs for today. New jobs will be available tomorrow.'
                  : ''}
              </p>
            ) : null}
            {maintenanceOn ? (
              <p role="alert" className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
                {maintenanceMessage}
              </p>
            ) : null}
            {processingError ? (
              <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {processingError}
              </p>
            ) : (
              <p className="mt-2 text-right text-xs text-[var(--color-text-muted)]">
                Creates a real job and opens its page — the worker renders the clips there.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section aria-label="Step 4 — Review">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Review clips</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Clips are reviewed on the job page, where the worker renders
              them — with playback, viral scores, download and re-render.
              This wizard hands off to the job at Step 3, so there is no
              separate review list here.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => navigate('/jobs')}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
              >
                Open my jobs <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => goTo(3)}
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                <ArrowLeft className="h-4 w-4" /> Back to Process
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {step === 5 ? (
        <section aria-label="Step 5 — Ship">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Ship your clips</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Finished clips are downloaded and exported from the job page
              — single clips, all clips, or a ZIP from the Export Center.
              This app does not post to TikTok, Instagram or YouTube for
              you; you upload the downloaded clips yourself.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => navigate('/jobs')}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
              >
                Open my jobs <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => navigate('/exports')}
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                Export Center
              </button>
              <button
                type="button"
                onClick={() => goTo(4)}
                className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
