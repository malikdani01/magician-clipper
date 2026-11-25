import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
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
import { ENGINE_URL, extractAudio, probeVideo, type ProbeResult } from '../lib/api'
import { formatBytes, formatDuration } from '../lib/format'
import {
  CAPTION_POSITION_LABELS,
  CAPTION_TRANSLATION_LABELS,
  createJob,
  EXPORT_RATIO_OPTIONS,
  HEADLINE_STYLE_DESCRIPTIONS,
  HEADLINE_STYLE_LABELS,
  OST_ANIMATION_DESCRIPTIONS,
  OST_ANIMATION_LABELS,
  SELECTION_MODE_DESCRIPTIONS,
  SELECTION_MODE_LABELS,
  type CaptionPosition,
  type CaptionTranslation,
  type HeadlineStyle,
  type OstAnimation,
  type SelectionMode,
} from '../lib/jobs'
import { translateLegacyCaptionPreset } from '../lib/captionStyles'
import { listPresets, type JobPreset } from '../lib/presets'
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

/** The 18 caption presets (same ids as the Captions Studio page). */
const CAPTION_STYLES = [
  { id: 'bold-pop', label: 'Bold Pop' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'neon-glow', label: 'Neon Glow' },
  { id: 'word-slam', label: 'Word Slam' },
  { id: 'modern', label: 'Modern' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'minimal', label: 'Minimal' },
  // Batch 3 (2026-11-25): the five new styles, as wizard presets.
  { id: 'word-zoom', label: 'Word Zoom' },
  { id: 'word-fade', label: 'Word Fade' },
  { id: 'highlight-box', label: 'Highlight Box' },
  { id: 'bounce-pop', label: 'Bounce Pop' },
  { id: 'glitch-pop', label: 'Glitch Pop' },
  // Batch 6 (2026-11-25): the three platform styles, as wizard presets.
  { id: 'tiktok-bold', label: 'TikTok Bold' },
  { id: 'reels-clean', label: 'Reels Clean' },
  { id: 'shorts-minimal', label: 'Shorts Minimal' },
] as const

/**
 * These preset ids predate the real caption styles the worker burns in
 * (see lib/captionStyles). The mapping lives there now —
 * translateLegacyCaptionPreset maps each legacy preset to the real style
 * it most resembles — the job API rejects unknown style ids, so the
 * preset must never be sent as-is.
 */

/**
 * Real caption style id → the wizard's legacy preset id. The wizard's
 * caption-style select holds LEGACY ids (bold-pop, highlight, …) while
 * presets store REAL style ids (punchy, word_pop, …) — translateLegacy-
 * CaptionPreset passes real ids through unchanged, so it cannot bridge
 * the two. Styles with no legacy equivalent (typewriter, sweep,
 * outline, gradient, kinetic, glow_pop) have no wizard option: loading
 * a preset with one of those keeps the wizard's current preset. The
 * Batch 3 styles DO have wizard presets (word-zoom, word-fade,
 * highlight-box, bounce-pop, glitch-pop), as do the Batch 6 platform
 * styles (tiktok-bold, reels-clean, shorts-minimal).
 */
const REAL_STYLE_TO_LEGACY_PRESET: Record<string, string> = {
  punchy: 'bold-pop',
  word_pop: 'highlight',
  bounce: 'bounce',
  karaoke: 'karaoke',
  neon: 'neon-glow',
  slam: 'word-slam',
  clean_subs: 'modern',
  classic: 'podcast',
  title_card: 'cinematic',
  word_zoom: 'word-zoom',
  word_fade: 'word-fade',
  highlight_sweep: 'highlight-box',
  bounce_in: 'bounce-pop',
  glitch_pop: 'glitch-pop',
  tiktok_bold: 'tiktok-bold',
  reels_clean: 'reels-clean',
  shorts_minimal: 'shorts-minimal',
}

/** Preset quality → wizard processing mode. */
const QUALITY_TO_PROCESSING_MODE: Record<string, ClipSpec['processingMode']> = {
  draft: 'eco',
  standard: 'balanced',
  high: 'fast',
}

/** Processing mode → job quality (the worker renders at 'standard' unless told otherwise). */
const PROCESSING_MODE_TO_QUALITY: Record<string, 'draft' | 'standard' | 'high'> = {
  eco: 'draft',
  balanced: 'standard',
  fast: 'standard',
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
 * The caption preset and keywords-to-avoid have no field on ClipSpec,
 * so they live in wizard-local state only.
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

  // Step 1 — link import (goes through the New Job wizard, which the
  // worker serves end to end: the backend accepts source_url and the
  // worker downloads it with yt-dlp).
  const [linkUrl, setLinkUrl] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)

  // Step 3 — real processing: creates a Job via the API and navigates
  // to the job page, where the worker renders the clips.
  const [processing, setProcessing] = useState(false)
  const [processingError, setProcessingError] = useState<string | null>(null)

  // Step 1 — audio extraction (Phase 2 groundwork for transcription)
  const [audioStatus, setAudioStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>('idle')
  const [audioResult, setAudioResult] = useState<ExtractAudioResult | null>(null)
  const [audioError, setAudioError] = useState<string | null>(null)

  // Step 2 — style form (bound to the project's ClipSpec)
  const [spec, setSpec] = useState<ClipSpec>(() => defaultClipSpec())
  const [clipCountText, setClipCountText] = useState(() => String(spec.clipCount))
  const [clipCountError, setClipCountError] = useState<string | null>(null)
  const [durationText, setDurationText] = useState(() => String(spec.durationSeconds))
  const [durationError, setDurationError] = useState<string | null>(null)
  // No captionPreset / keywords-to-avoid field exists on ClipSpec —
  // these live in wizard-local state only and are shown as selected text.
  const [captionPreset, setCaptionPreset] = useState<string>('bold-pop')
  const [keywordsAvoid, setKeywordsAvoid] = useState('')

  // Job presets (GET /api/v1/presets) — load a saved settings snapshot
  // into the Step 2 form. Presets hold settings only; the source is
  // always the file picked on Step 1.
  const [presets, setPresets] = useState<JobPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [presetMessage, setPresetMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listPresets().then((rows) => {
      if (!cancelled) setPresets(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Stale-response guards: a probe/audio call that finishes after a newer
  // file was picked (or the user navigated away) is ignored.
  const probeRequestRef = useRef(0)
  const audioRequestRef = useRef(0)

  const project = projectId ? getProject(projectId) : undefined
  const specValid = clipCountError === null && durationError === null
  // Stepper: step 1 is always reachable; later steps need a probed project
  // and must have been visited (or be the immediate next step, so every
  // step stays reachable even though Step 4's Continue is disabled).
  const canGoToStep = (n: number) =>
    n === 1 || (projectId !== null && n <= maxStep + 1)

  const goTo = (n: number) => {
    setStep(n)
    setMaxStep((m) => Math.max(m, n))
  }

  /** Keep local spec state and the stored project spec in sync. */
  const updateSpec = (patch: Partial<ClipSpec>) => {
    const next = { ...spec, ...patch }
    setSpec(next)
    if (projectId) {
      updateProject(projectId, { spec: next })
    }
  }

  /**
   * Load a saved job preset into the Step 2 form. Every field is
   * validated against what this wizard accepts first — a value outside
   * the wizard's range (e.g. clip count above 20, duration outside
   * 5–300s) is skipped, not forced in. The caption style maps through
   * the legacy-preset table above; a real style with no wizard option
   * keeps the wizard's current preset and says so. Preset fields with
   * no wizard equivalent (layout is derived at submit, job type is
   * always "for myself" here, captions language is always Auto) are
   * not applied.
   */
  const handleLoadPreset = (id: number) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    const s = preset.settings
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
    // Batch 2 (2026-11-25): headline look + caption position.
    if (s.headline_style === 'bold_bar' || s.headline_style === 'lower_third' || s.headline_style === 'big_centre') {
      patch.headlineStyle = s.headline_style
    }
    if (s.caption_position === 'bottom' || s.caption_position === 'top' || s.caption_position === 'middle') {
      patch.captionPosition = s.caption_position
    }
    // Batch 3 (2026-11-25): beat sync, caption translation, export ratios.
    if (typeof s.beat_sync === 'boolean') patch.beatSync = s.beat_sync
    if (
      s.caption_translation === 'none' ||
      s.caption_translation === 'ur' ||
      s.caption_translation === 'hi' ||
      s.caption_translation === 'en'
    ) {
      patch.captionTranslation = s.caption_translation
    }
    if (Array.isArray(s.export_ratios)) {
      const ratios = s.export_ratios.filter((r) => r === '9:16' || r === '1:1' || r === '16:9')
      if (ratios.length > 0) {
        patch.exportRatios = ratios.includes('9:16') ? ratios : ['9:16', ...ratios]
      }
    }
    // Batch 4 (2026-11-25): logo overlay.
    if (typeof s.logo_overlay === 'boolean') patch.logoOverlay = s.logo_overlay
    // Batch 6 (2026-11-25): caption safe zone (default ON).
    if (typeof s.caption_safe_zone === 'boolean') patch.captionSafeZone = s.caption_safe_zone
    // Batch 7 (2026-11-25): whole-clip on-screen text (defaults OFF).
    if (typeof s.ost_persistent === 'boolean') patch.ostPersistent = s.ost_persistent
    if (
      s.ost_animation === 'none' ||
      s.ost_animation === 'slide' ||
      s.ost_animation === 'fade' ||
      s.ost_animation === 'pop'
    ) {
      patch.ostAnimation = s.ost_animation
    }
    if (typeof s.end_card === 'boolean') patch.endCard = s.end_card
    if (typeof s.end_card_text === 'string') patch.endCardText = s.end_card_text
    if (typeof s.keyword_popups === 'boolean') patch.keywordPopups = s.keyword_popups
    if (typeof s.lower_third_text === 'string') patch.lowerThirdText = s.lower_third_text
    if (typeof s.progress_bar === 'boolean') patch.progressBar = s.progress_bar
    if (CONTENT_TYPES.some((c) => c.id === s.content_type)) {
      patch.contentType = s.content_type as ClipSpec['contentType']
    }
    const processingMode = QUALITY_TO_PROCESSING_MODE[s.quality]
    if (processingMode) patch.processingMode = processingMode
    updateSpec(patch)
    const legacyPresetId =
      typeof s.caption_style === 'string' ? REAL_STYLE_TO_LEGACY_PRESET[s.caption_style] : undefined
    if (legacyPresetId) {
      setCaptionPreset(legacyPresetId)
    } else if (typeof s.caption_style === 'string') {
      skipped.push(
        `caption style (“${s.caption_style}” has no option in this wizard — kept the current preset)`,
      )
    }
    setPresetMessage(
      `Preset “${preset.name}” loaded.` +
        (skipped.length > 0 ? ` Not applied: ${skipped.join('; ')}.` : ''),
    )
  }

  /**
   * Link import: validate the URL, then hand it to the New Job wizard
   * with the link tab prefilled — that wizard + the worker download
   * the video (YouTube / TikTok / Drive / direct file). No download
   * is claimed here; the job page shows the real result.
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
    navigate(`/jobs/new?source=link&url=${encodeURIComponent(url)}`)
  }

  /**
   * Start Processing — the real one. Creates a Job from the probed file
   * + the style spec via the Job API and navigates to the job page,
   * where the connected worker transcribes, selects highlights and
   * renders the clips. The wizard itself never pretends to render.
   */
  const startRealProcessing = async () => {
    if (!file || !projectId || processing) return
    if (!specValid) return
    setProcessing(true)
    setProcessingError(null)
    const result = await createJob({
      file,
      platform: spec.platform,
      aspectRatio: spec.aspect,
      clipCount: spec.clipCount,
      durationMode: spec.durationMode,
      durationSeconds: spec.durationSeconds,
      durationMinSeconds: null,
      durationMaxSeconds: null,
      captionsEnabled: spec.captions,
      captionsLanguage: 'auto',
      captionStyle: translateLegacyCaptionPreset(captionPreset),
      selectionMode: spec.selectionMode ?? 'interesting_only',
      onScreenText: spec.onScreenText,
      autoZoom: spec.autoZoom ?? true,
      faceTracking: spec.faceTracking ?? true,
      silenceRemoval: spec.silenceRemoval ?? true,
      fillerRemoval: spec.fillerRemoval ?? true,
      headlineStyle: spec.headlineStyle ?? 'bold_bar',
      captionPosition: spec.captionPosition ?? 'bottom',
      beatSync: spec.beatSync ?? true,
      captionTranslation: spec.captionTranslation ?? 'none',
      exportRatios: spec.exportRatios ?? ['9:16'],
      logoOverlay: spec.logoOverlay ?? false,
      captionSafeZone: spec.captionSafeZone ?? true,
      ostPersistent: spec.ostPersistent ?? false,
      ostAnimation: spec.ostAnimation ?? 'none',
      endCard: spec.endCard ?? false,
      endCardText: (spec.endCardText ?? '').trim(),
      keywordPopups: spec.keywordPopups ?? false,
      lowerThirdText: (spec.lowerThirdText ?? '').trim(),
      progressBar: spec.progressBar ?? false,
      jobType: 'myself',
      notes: keywordsAvoid.trim()
        ? `Keywords to avoid: ${keywordsAvoid.trim()}`
        : undefined,
      layout: spec.aspect === '9:16' ? 'split' : 'center_crop',
      contentType: spec.contentType,
      quality: PROCESSING_MODE_TO_QUALITY[spec.processingMode] ?? 'standard',
    })
    setProcessing(false)
    if (!result.ok) {
      setProcessingError(result.error)
      return
    }
    navigate(`/jobs/${result.job.id}`)
  }

  const applyClipCount = (n: number) => {
    setClipCountText(String(n))
    setClipCountError(null)
    updateSpec({ clipCount: n })
  }

  const onClipCountText = (value: string) => {
    setClipCountText(value)
    const n = Number(value)
    if (value.trim() === '' || !Number.isInteger(n) || n < 1 || n > 20) {
      setClipCountError('Enter a whole number between 1 and 20.')
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
    setCaptionPreset('bold-pop')
    setKeywordsAvoid('')
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
    setCaptionPreset('bold-pop')
    setKeywordsAvoid('')
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
    spec.durationMode === 'exact' ? 'exact' : spec.durationMode === 'minimum' ? 'min' : 'max'
  const summary = `${spec.clipCount} clip${spec.clipCount === 1 ? '' : 's'} · ${durationModeLabel} ${spec.durationSeconds}s · ${spec.aspect} · ${spec.platform === 'tiktok' ? 'TikTok' : 'Instagram'} · captions ${spec.captions ? 'on' : 'off'} · ${SELECTION_MODE_LABELS[spec.selectionMode ?? 'interesting_only']}`
  const captionLabel =
    CAPTION_STYLES.find((s) => s.id === captionPreset)?.label ?? captionPreset
  const contentLabel =
    CONTENT_TYPES.find((c) => c.id === spec.contentType)?.label ?? spec.contentType

  return (
    <div>
      <PageHeader
        title="AI Clipper"
        subtitle="Let AI find the best moments in your video."
      />

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
              Paste a YouTube, Google Drive or direct video link. It opens
              in the New Job wizard — the worker downloads the video and
              the job page shows the real result.
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
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={projectId === null}
              onClick={() => goTo(2)}
              className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue to Style <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          {projectId === null ? (
            <p className="mt-2 text-right text-xs text-[var(--color-text-muted)]">
              {probeStatus === 'probing'
                ? IS_LOCAL_SITE
                  ? 'Probing with the engine — please wait.'
                  : 'Reading the video in your browser — please wait.'
                : probeStatus === 'error'
                  ? 'Probe failed — retry or choose a different file.'
                  : IS_LOCAL_SITE
                    ? 'Choose a video and let the engine probe it to continue.'
                    : 'Choose a video — your browser reads its duration and resolution — to continue.'}
            </p>
          ) : null}
            </div>

            {/* Right rail — design-reference Clipping Options + Why card.
                The controls below edit the same spec as Step 2 (Style);
                Step 2 stays the full form. */}
            <aside className="space-y-4">
              <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
                <h2 className="text-lg font-semibold text-white">Clipping Options</h2>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-white">Number of Clips</span>
                  <select
                    value={spec.clipCount}
                    onChange={(e) => applyClipCount(Number(e.target.value))}
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                  >
                    {[1, 3, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        {n} clip{n === 1 ? '' : 's'}
                      </option>
                    ))}
                    {![1, 3, 5, 10].includes(spec.clipCount) ? (
                      <option value={spec.clipCount}>{spec.clipCount} clips (custom)</option>
                    ) : null}
                  </select>
                </label>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-white">Clip Duration</span>
                  <select
                    value={spec.durationSeconds}
                    onChange={(e) => applyDuration(Number(e.target.value))}
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                  >
                    {[15, 20, 30, 45, 60].map((n) => (
                      <option key={n} value={n}>
                        {n} seconds
                      </option>
                    ))}
                    {![15, 20, 30, 45, 60].includes(spec.durationSeconds) ? (
                      <option value={spec.durationSeconds}>{spec.durationSeconds} seconds (custom)</option>
                    ) : null}
                  </select>
                </label>
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-white">Clip selection</span>
                  <select
                    value={spec.selectionMode ?? 'interesting_only'}
                    onChange={(e) =>
                      updateSpec({ selectionMode: e.target.value as SelectionMode })
                    }
                    aria-label="Clip selection"
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                  >
                    {(Object.keys(SELECTION_MODE_LABELS) as SelectionMode[]).map((id) => (
                      <option key={id} value={id}>
                        {SELECTION_MODE_LABELS[id]}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {SELECTION_MODE_DESCRIPTIONS[spec.selectionMode ?? 'interesting_only']}
                  </span>
                </label>
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">Vertical (9:16)</span>
                    <Toggle
                      checked={spec.aspect === '9:16'}
                      onChange={(v) => updateSpec({ aspect: v ? '9:16' : '16:9' })}
                      label="Vertical 9:16 on or off"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">Add Animated Captions</span>
                    <Toggle
                      checked={spec.captions}
                      onChange={(v) => updateSpec({ captions: v })}
                      label="Animated captions on or off"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">On-screen text</span>
                    <Toggle
                      checked={spec.onScreenText}
                      onChange={(v) => updateSpec({ onScreenText: v })}
                      label="On-screen text on or off"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={projectId === null}
                  onClick={() => goTo(2)}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue to Style <ArrowRight className="h-4 w-4" />
                </button>
                <p className="mt-2 text-center text-xs text-[var(--color-text-muted)]">
                  {projectId === null
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
              {file ? `Video: ${file.name} · ${formatBytes(file.size)}` : 'Set the style for this job.'}
              {project ? ` · Project: ${project.title}` : ''}
            </p>

            {/* Load preset — same pattern as the New Job page's presets
                card, compact. Loads the preset's settings into this
                form; the video stays the one picked on Step 1. */}
            <div className="mt-5 rounded-xl border border-ink-border bg-ink-panel2 p-4">
              <label className="block">
                <span className="text-sm font-medium text-white">Load preset</span>
                <select
                  value={selectedPresetId}
                  onChange={(e) => {
                    setSelectedPresetId(e.target.value)
                    const id = Number(e.target.value)
                    if (id > 0) handleLoadPreset(id)
                  }}
                  aria-label="Load a saved job preset into the style form"
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                >
                  <option value="">Choose a preset…</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {presetMessage ? (
                <p role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {presetMessage}
                </p>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {presets.length === 0
                    ? 'No presets saved yet — save one from the New Job page.'
                    : 'Loads a saved preset’s settings into this form.'}
                </p>
              )}
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
                      onClick={() => updateSpec({ aspect: a })}
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
                  {CLIP_COUNT_PRESETS.map((n) => (
                    <ChoiceButton
                      key={n}
                      selected={spec.clipCount === n}
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
                      max={20}
                      value={clipCountText}
                      onChange={(e) => onClipCountText(e.target.value)}
                      aria-label="Custom number of clips (1 to 20)"
                      className="w-20 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                    />
                  </label>
                </div>
                {clipCountError ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">{clipCountError}</p>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">Between 1 and 20 clips.</p>
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
                {durationError ? (
                  <p role="alert" className="mt-2 text-xs text-red-300">{durationError}</p>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                    {spec.durationMode === 'exact'
                      ? 'Each clip is exactly this long.'
                      : spec.durationMode === 'minimum'
                        ? 'Clips are at least this long.'
                        : 'Clips are at most this long.'}
                  </p>
                )}
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">Clip selection</legend>
                <select
                  value={spec.selectionMode ?? 'interesting_only'}
                  onChange={(e) =>
                    updateSpec({ selectionMode: e.target.value as SelectionMode })
                  }
                  aria-label="Clip selection"
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                >
                  {(Object.keys(SELECTION_MODE_LABELS) as SelectionMode[]).map((id) => (
                    <option key={id} value={id}>
                      {SELECTION_MODE_LABELS[id]}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {SELECTION_MODE_DESCRIPTIONS[spec.selectionMode ?? 'interesting_only']}
                </p>
              </fieldset>

              <div>
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
                <label className="mt-3 block">
                  <span className="text-sm font-medium text-white">Caption style</span>
                  <select
                    value={captionPreset}
                    disabled={!spec.captions}
                    onChange={(e) => setCaptionPreset(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {CAPTION_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Selected caption style: <span className="font-medium text-white">{captionLabel}</span>
                  {' '}— kept with this wizard session; captions are rendered in Phase 3.
                </p>
              </div>

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
              </div>

              {/* Batch 2 headline style + caption position — defaults
                  are the pre-Batch-2 behaviour (bold bar, bottom). */}
              <label className="block">
                <span className="text-sm font-medium text-white">Headline style</span>
                <select
                  value={spec.headlineStyle ?? 'bold_bar'}
                  onChange={(e) =>
                    updateSpec({ headlineStyle: e.target.value as HeadlineStyle })
                  }
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                >
                  {(Object.keys(HEADLINE_STYLE_LABELS) as HeadlineStyle[]).map((s) => (
                    <option key={s} value={s}>
                      {HEADLINE_STYLE_LABELS[s]}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  {HEADLINE_STYLE_DESCRIPTIONS[spec.headlineStyle ?? 'bold_bar']}
                </span>
              </label>

              {/* Batch 7 whole-clip on-screen text (2026-11-25). The
                  persistent headline and its animation need on-screen
                  text on; the end card, keyword pop-ups, lower-third
                  tag and progress bar work on their own. */}
              <div>
                <span className="text-sm font-medium text-white">Persistent headline</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.ostPersistent ?? false}
                    onChange={(v) => updateSpec({ ostPersistent: v })}
                    label="Persistent headline on or off"
                    disabled={!spec.onScreenText}
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.ostPersistent ? 'Persistent headline on' : 'Persistent headline off'} — keep
                    the headline up for the whole clip instead of the first 4 seconds
                  </span>
                </div>
                {!spec.onScreenText ? (
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Turn on-screen text on to use the persistent headline.
                  </span>
                ) : null}
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Headline animation</span>
                <select
                  value={spec.ostAnimation ?? 'none'}
                  disabled={!spec.onScreenText}
                  onChange={(e) =>
                    updateSpec({ ostAnimation: e.target.value as OstAnimation })
                  }
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {(Object.keys(OST_ANIMATION_LABELS) as OstAnimation[]).map((a) => (
                    <option key={a} value={a}>
                      {OST_ANIMATION_LABELS[a]}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  {OST_ANIMATION_DESCRIPTIONS[spec.ostAnimation ?? 'none']}
                </span>
              </label>

              <div>
                <span className="text-sm font-medium text-white">Follow end card</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.endCard ?? false}
                    onChange={(v) => updateSpec({ endCard: v })}
                    label="Follow end card on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.endCard ? 'End card on' : 'End card off'} — show a card
                    in the last 2 seconds of every clip
                  </span>
                </div>
                {spec.endCard ? (
                  <label className="mt-3 block">
                    <span className="text-sm font-medium text-white">End card text</span>
                    <input
                      type="text"
                      value={spec.endCardText ?? ''}
                      maxLength={40}
                      placeholder="Follow for more"
                      onChange={(e) => updateSpec({ endCardText: e.target.value })}
                      className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)]"
                    />
                    <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                      Leave empty for “Follow for more”. Max 40 characters.
                    </span>
                  </label>
                ) : null}
              </div>

              <div>
                <span className="text-sm font-medium text-white">Keyword pop-ups</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.keywordPopups ?? false}
                    onChange={(v) => updateSpec({ keywordPopups: v })}
                    label="Keyword pop-ups on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.keywordPopups ? 'Keyword pop-ups on' : 'Keyword pop-ups off'} — pop up to 4
                    important spoken words as large text at the moment they are said
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Lower-third tag</span>
                <input
                  type="text"
                  value={spec.lowerThirdText ?? ''}
                  maxLength={40}
                  placeholder="@yourchannel"
                  onChange={(e) => updateSpec({ lowerThirdText: e.target.value })}
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)]"
                />
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Your name or channel, shown at the bottom of the whole
                  clip. Empty = off. Never translated. Max 40 characters.
                </span>
              </label>

              <div>
                <span className="text-sm font-medium text-white">Progress bar</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.progressBar ?? false}
                    onChange={(v) => updateSpec({ progressBar: v })}
                    label="Progress bar on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {spec.progressBar ? 'Progress bar on' : 'Progress bar off'} — a thin violet bar
                    along the bottom edge, growing across the full clip
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Caption position</span>
                <select
                  value={spec.captionPosition ?? 'bottom'}
                  onChange={(e) =>
                    updateSpec({ captionPosition: e.target.value as CaptionPosition })
                  }
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                >
                  {(Object.keys(CAPTION_POSITION_LABELS) as CaptionPosition[]).map((p) => (
                    <option key={p} value={p}>
                      {CAPTION_POSITION_LABELS[p]}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Where the burn-in captions sit — never over the headline.
                </span>
              </label>

              {/* Batch 3 beat sync + caption translation + export ratios. */}
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

              <label className="block">
                <span className="text-sm font-medium text-white">Translate captions</span>
                <select
                  value={spec.captionTranslation ?? 'none'}
                  onChange={(e) =>
                    updateSpec({ captionTranslation: e.target.value as CaptionTranslation })
                  }
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                >
                  {(Object.keys(CAPTION_TRANSLATION_LABELS) as CaptionTranslation[]).map((t) => (
                    <option key={t} value={t}>
                      {CAPTION_TRANSLATION_LABELS[t]}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Translates the captions after transcription. If the free
                  translation service is unavailable, captions stay in the
                  original language and the job says so.
                </span>
              </label>

              <div>
                <span className="text-sm font-medium text-white">Export ratios</span>
                <div className="mt-2 flex flex-wrap items-center gap-4">
                  {EXPORT_RATIO_OPTIONS.map((ratio) => {
                    const ratios = spec.exportRatios ?? ['9:16']
                    const checked = ratios.includes(ratio)
                    const locked = ratio === '9:16'
                    return (
                      <label key={ratio} className="flex items-center gap-2 text-sm text-white">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => {
                            const next = checked
                              ? ratios.filter((r) => r !== ratio)
                              : [...ratios, ratio]
                            updateSpec({ exportRatios: next })
                          }}
                          className="h-4 w-4 accent-fuchsia-500 disabled:opacity-60"
                        />
                        {ratio}
                        {locked ? ' (always on)' : ''}
                      </label>
                    )
                  })}
                </div>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  The same clips render in each ratio — each gets its own
                  download. 1:1 and 16:9 use a centre crop.
                </span>
              </div>

              {/* Batch 4 logo overlay — default OFF. When ON and a logo
                  is uploaded in Brand Kit, the worker overlays it
                  bottom-right on every clip of this job. */}
              <div>
                <span className="text-sm font-medium text-white">Logo overlay</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={spec.logoOverlay ?? false}
                    onChange={(v) => updateSpec({ logoOverlay: v })}
                    label="Logo overlay on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    Logo overlay — watermark your Brand Kit logo on every
                    clip (bottom-right)
                  </span>
                </div>
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Upload the logo in Brand Kit first. If no logo is
                  uploaded, the job renders without one and says so.
                </span>
              </div>

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
                </div>
              </div>

              <label className="mt-3 block">
                <span className="text-sm font-medium text-white">Content type</span>
                  <select
                    value={spec.contentType}
                    onChange={(e) =>
                      updateSpec({ contentType: e.target.value as ClipSpec['contentType'] })
                    }
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white"
                  >
                    {CONTENT_TYPES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Content type: <span className="font-medium text-white">{contentLabel}</span>
                </p>

              <label className="block">
                <span className="text-sm font-medium text-white">Keywords to prioritise</span>
                <input
                  type="text"
                  value={spec.keywords}
                  onChange={(e) => updateSpec({ keywords: e.target.value })}
                  placeholder="e.g. funny moment, tutorial, reaction"
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)]"
                />
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Comma-separated — stored in the project spec.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-white">Keywords to avoid</span>
                <input
                  type="text"
                  value={keywordsAvoid}
                  onChange={(e) => setKeywordsAvoid(e.target.value)}
                  placeholder="e.g. sponsor read, silence"
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)]"
                />
                <span className="mt-2 block text-xs text-[var(--color-text-muted)]">
                  Comma-separated — kept with this wizard session; excluded when
                  matching runs in Phase 3.
                </span>
              </label>

              <fieldset className="md:col-span-2">
                <legend className="text-sm font-medium text-white">Processing mode</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['eco', 'balanced', 'fast'] as const).map((m) => (
                    <ChoiceButton
                      key={m}
                      selected={spec.processingMode === m}
                      onClick={() => updateSpec({ processingMode: m })}
                    >
                      {m === 'eco' ? 'Eco' : m === 'balanced' ? 'Balanced' : 'Fast'}
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="mt-6 rounded-xl border border-brand/40 bg-brand/10 p-4">
              <p className="text-xs text-[var(--color-text-muted)]">Live summary</p>
              <p className="mt-1 text-sm font-medium text-white">{summary}</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Caption style: {captionLabel} · Content: {contentLabel} ·{' '}
                {spec.processingMode === 'eco'
                  ? 'Eco'
                  : spec.processingMode === 'balanced'
                    ? 'Balanced'
                    : 'Fast'}{' '}
                processing
                {keywordsAvoid.trim() ? ` · Avoid: ${keywordsAvoid.trim()}` : ''}
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
                disabled={projectId === null || !specValid}
                onClick={() => goTo(3)}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue to Process <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            {projectId === null || !specValid ? (
              <p className="mt-2 text-right text-xs text-[var(--color-text-muted)]">
                {projectId === null
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
                disabled={processing || !specValid}
                className="flex items-center gap-2 rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {processing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Creating job…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Start Processing
                  </>
                )}
              </button>
            </div>
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
