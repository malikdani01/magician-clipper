import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CloudUpload,
  FileVideo,
  Link2,
  Loader2,
  Upload,
  X,
} from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { CaptionStylePicker, HeadlineStylePicker } from '../components/StylePicker'
import { API_URL } from '../lib/api'
import { getCaptionStyle, isCaptionStyleId } from '../lib/captionStyles'
import {
  CAPTION_POSITION_LABELS,
  CAPTION_TRANSLATION_LABELS,
  createBulkJobs,
  createJob,
  EXPORT_RATIO_OPTIONS,
  getJob,
  HEADLINE_STYLE_LABELS,
  LAYOUT_LABELS,
  OST_ANIMATION_DESCRIPTIONS,
  OST_ANIMATION_LABELS,
  SELECTION_MODE_DESCRIPTIONS,
  SELECTION_MODE_LABELS,
  type CaptionPosition,
  type CaptionTranslation,
  type ClipLayout,
  type HeadlineStyle,
  type JobSettings,
  type OstAnimation,
  type SelectionMode,
} from '../lib/jobs'
import {
  createPreset,
  deletePreset,
  listPresets,
  type JobPreset,
  type PresetSettings,
} from '../lib/presets'
import { formatBytes } from '../lib/format'
import { useAuth } from '../state/auth'
import { usePreferences } from '../state/preferences'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm']

const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
] as const

const ASPECT_RATIOS = [
  { id: '9:16', label: 'Vertical (9:16)' },
  { id: '16:9', label: 'Landscape (16:9)' },
  { id: '1:1', label: 'Square (1:1)' },
  { id: '4:5', label: 'Portrait (4:5)' },
] as const

const CAPTION_LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'english', label: 'English' },
  { id: 'roman_urdu', label: 'Roman Urdu' },
  { id: 'hindi', label: 'Hindi' },
] as const

const CONTENT_TYPES = [
  { id: 'podcast', label: 'Podcast' },
  { id: 'interview', label: 'Interview' },
  { id: 'education', label: 'Education' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'commentary', label: 'Commentary' },
  { id: 'story', label: 'Story' },
  { id: 'general', label: 'General' },
] as const

function isVideoFile(f: File): boolean {
  if (f.type.startsWith('video/')) return true
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(ext)
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

const selectClass =
  'w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none'
const inputClass =
  'w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none'
const numberClass =
  'w-24 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none'

/**
 * New Job — the FINAL SYSTEM flow (Phase 3 Job System).
 *
 * Source is either an uploaded video file OR a pasted link (YouTube /
 * TikTok / Google Drive / direct MP4). Every setting comes from a
 * dropdown, choice button or toggle — the only free text is the link
 * field and the campaign requirements box. Submit POSTs /api/v1/jobs
 * and, on success, redirects to the new job's detail page. Backend
 * errors are shown exactly as the server returned them.
 */
export function NewJobPage() {
  const { user, token, loading: authLoading } = useAuth()
  const { t } = usePreferences()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)

  // Source
  const [sourceTab, setSourceTab] = useState<'upload' | 'link'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [link, setLink] = useState('')

  // Link prefill: the Create Project cards and the Clipper wizard send
  // the user here with ?source=link&url=… — open the link tab with the
  // URL already pasted. Only on first mount.
  useEffect(() => {
    if (searchParams.get('source') === 'link') {
      const url = searchParams.get('url') ?? ''
      if (url) {
        setSourceTab('link')
        setLink(url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the user's saved job presets for the "Load preset" dropdown.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    listPresets().then((rows) => {
      if (!cancelled) setPresets(rows)
    })
    return () => {
      cancelled = true
    }
  }, [token])

  // Clone (?clone=<jobId>): copy an earlier job's settings into this
  // form. The source is never copied — the user picks the video/link
  // again below (the banner says so).
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
        applyJobSettings(result.job.settings)
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

  // Settings — dropdowns/toggles only
  const [platform, setPlatform] = useState<'tiktok' | 'instagram'>('tiktok')
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '16:9' | '1:1' | '4:5'>('9:16')
  const [clipCount, setClipCount] = useState(3)
  const [durationMode, setDurationMode] = useState<'exact' | 'minimum' | 'maximum'>('exact')
  const [exactSeconds, setExactSeconds] = useState(60)
  const [minSeconds, setMinSeconds] = useState(30)
  const [maxSeconds, setMaxSeconds] = useState(90)
  const [captionsEnabled, setCaptionsEnabled] = useState(true)
  const [captionsLanguage, setCaptionsLanguage] = useState<'english' | 'roman_urdu' | 'hindi' | 'auto'>('english')
  const [captionStyle, setCaptionStyle] = useState('punchy')
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('interesting_only')
  const [onScreenText, setOnScreenText] = useState(false)
  // Batch 1 clip enhancements — all default ON.
  const [autoZoom, setAutoZoom] = useState(true)
  const [faceTracking, setFaceTracking] = useState(true)
  const [silenceRemoval, setSilenceRemoval] = useState(true)
  const [fillerRemoval, setFillerRemoval] = useState(true)
  // Batch 2 headline style + caption position — defaults are the
  // pre-Batch-2 behaviour (bold bar, bottom).
  const [headlineStyle, setHeadlineStyle] = useState<HeadlineStyle>('bold_bar')
  const [captionPosition, setCaptionPosition] = useState<CaptionPosition>('bottom')
  // Batch 3 beat sync + caption translation + export ratios — defaults
  // are the pre-Batch-3 behaviour (beat sync on, no translation, 9:16 only).
  const [beatSync, setBeatSync] = useState(true)
  const [captionTranslation, setCaptionTranslation] = useState<CaptionTranslation>('none')
  const [exportRatios, setExportRatios] = useState<string[]>(['9:16'])
  // Batch 4 logo overlay — default OFF, so a watermark never surprises
  // the user. When ON and a logo is uploaded in Brand Kit, the worker
  // overlays it bottom-right on every clip of this job.
  const [logoOverlay, setLogoOverlay] = useState(false)
  // Batch 6 caption safe zone — default ON: captions keep clear of
  // TikTok's right action rail and the bottom bar. OFF restores
  // full-width centred captions.
  const [captionSafeZone, setCaptionSafeZone] = useState(true)
  // Batch 7 whole-clip on-screen text — all default OFF / 'none' /
  // empty (the pre-Batch-7 behaviour). The end card and pop-ups/tag
  // work on their own; only the persistent headline and its animation
  // need on-screen text on.
  const [ostPersistent, setOstPersistent] = useState(false)
  const [ostAnimation, setOstAnimation] = useState<OstAnimation>('none')
  const [endCard, setEndCard] = useState(false)
  const [endCardText, setEndCardText] = useState('')
  const [keywordPopups, setKeywordPopups] = useState(false)
  const [lowerThirdText, setLowerThirdText] = useState('')
  const [progressBar, setProgressBar] = useState(false)
  // Batch 4 bulk jobs — up to 5 files, one job per file with the same
  // settings. Off by default; the wizard stays single-file only.
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkFiles, setBulkFiles] = useState<File[]>([])
  const [createdJobs, setCreatedJobs] = useState<{ id: number; name: string }[] | null>(null)
  const [jobType, setJobType] = useState<'myself' | 'campaign'>('myself')
  const [campaignRequirements, setCampaignRequirements] = useState('')
  // Notes for Muse: free-text brief for THIS job (campaign details,
  // extra instructions, must-haves vs nice-to-haves). Sent with the
  // job so the worker — and Muse in chat — can read it and clip to it.
  // Optional for every job; campaign jobs already have their own
  // required requirements box above.
  const [notes, setNotes] = useState('')
  const [layout, setLayout] = useState<ClipLayout>('center_crop')
  const [contentType, setContentType] = useState('general')
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard')

  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Job presets (GET/POST/DELETE /api/v1/presets): named snapshots of
  // the settings below — no source, the video/link is always chosen
  // fresh when a preset is loaded.
  const [presets, setPresets] = useState<JobPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [presetMessage, setPresetMessage] = useState<string | null>(null)
  const [presetSaving, setPresetSaving] = useState(false)
  // Clone (?clone=<jobId>): settings copied from an earlier job. The
  // source is NEVER reused — the user picks the video/link again.
  const [clonedFrom, setClonedFrom] = useState<number | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  // Set once a preset/clone has applied settings, so the saved-default
  // caption style effect below does not clobber them afterwards.
  const settingsAppliedRef = useRef(false)

  // Default caption style from the user's saved settings (Captions Studio
  // saves it via PATCH /api/v1/settings). 'punchy' when nothing is saved.
  // Skipped once a preset/clone has applied settings — theirs wins.
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
        if (!cancelled && !settingsAppliedRef.current && isCaptionStyleId(saved)) setCaptionStyle(saved)
      } catch {
        // Backend unreachable — keep the 'punchy' default.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const handleFile = (f: File | undefined) => {
    if (!f) return
    if (!isVideoFile(f)) {
      setFormError(`"${f.name}" is not a video file. Please choose an MP4, MOV, MKV or WEBM file.`)
      return
    }
    setFormError(null)
    setFile(f)
    if (inputRef.current) inputRef.current.value = ''
  }

  /**
   * Batch 4 bulk: accept several files at once (drop or browse). Each
   * must be a video; the list caps at 5 and de-duplicates by name +
   * size. In single-file mode this just delegates to handleFile.
   */
  const handleFiles = (list: FileList | File[] | null | undefined) => {
    if (!list) return
    const picked = Array.from(list)
    if (picked.length === 0) return
    if (!bulkMode) {
      handleFile(picked[0])
      return
    }
    const bad = picked.find((f) => !isVideoFile(f))
    if (bad) {
      setFormError(`"${bad.name}" is not a video file. Please choose MP4, MOV, MKV or WEBM files.`)
      return
    }
    setFormError(null)
    setBulkFiles((current) => {
      const merged = [...current]
      for (const f of picked) {
        const duplicate = merged.some((m) => m.name === f.name && m.size === f.size)
        if (!duplicate) merged.push(f)
      }
      if (merged.length > 5) {
        setFormError('Bulk jobs take at most 5 files — only the first 5 were kept.')
        return merged.slice(0, 5)
      }
      return merged
    })
    if (inputRef.current) inputRef.current.value = ''
  }

  const clearFile = () => {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const clearBulkFile = (name: string, size: number) => {
    setBulkFiles((current) => current.filter((f) => !(f.name === name && f.size === size)))
    if (inputRef.current) inputRef.current.value = ''
  }

  /** Switching between single and bulk clears the chosen file(s). */
  const setBulk = (on: boolean) => {
    setBulkMode(on)
    setFile(null)
    setBulkFiles([])
    setCreatedJobs(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  /**
   * Copy a settings object (preset or cloned job) into this form.
   * Every field is validated against the known option lists first —
   * a stale/unknown value is ignored instead of breaking the form.
   * The source is never part of settings, so it is never copied.
   */
  const applyJobSettings = (s: PresetSettings | JobSettings | null | undefined) => {
    if (!s) return
    if (s.platform === 'tiktok' || s.platform === 'instagram') setPlatform(s.platform)
    if (
      s.aspect_ratio === '9:16' ||
      s.aspect_ratio === '16:9' ||
      s.aspect_ratio === '1:1' ||
      s.aspect_ratio === '4:5'
    ) {
      setAspectRatio(s.aspect_ratio)
    }
    if (typeof s.clip_count === 'number' && s.clip_count >= 1 && s.clip_count <= 50) {
      setClipCount(Math.round(s.clip_count))
    }
    if (
      s.duration_mode === 'exact' ||
      s.duration_mode === 'minimum' ||
      s.duration_mode === 'maximum'
    ) {
      setDurationMode(s.duration_mode)
      if (typeof s.duration_seconds === 'number' && s.duration_seconds > 0) {
        setExactSeconds(Math.round(s.duration_seconds))
      }
      if (typeof s.duration_min_seconds === 'number' && s.duration_min_seconds > 0) {
        setMinSeconds(Math.round(s.duration_min_seconds))
      }
      if (typeof s.duration_max_seconds === 'number' && s.duration_max_seconds > 0) {
        setMaxSeconds(Math.round(s.duration_max_seconds))
      }
    }
    if (typeof s.captions_enabled === 'boolean') setCaptionsEnabled(s.captions_enabled)
    if (
      s.captions_language === 'english' ||
      s.captions_language === 'roman_urdu' ||
      s.captions_language === 'hindi' ||
      s.captions_language === 'auto'
    ) {
      setCaptionsLanguage(s.captions_language)
    }
    if (typeof s.caption_style === 'string' && isCaptionStyleId(s.caption_style)) {
      setCaptionStyle(s.caption_style)
    }
    if (s.selection_mode === 'interesting_only' || s.selection_mode === 'fill_any') {
      setSelectionMode(s.selection_mode)
    }
    if (typeof s.on_screen_text === 'boolean') setOnScreenText(s.on_screen_text)
    if (typeof s.auto_zoom === 'boolean') setAutoZoom(s.auto_zoom)
    if (typeof s.face_tracking === 'boolean') setFaceTracking(s.face_tracking)
    if (typeof s.silence_removal === 'boolean') setSilenceRemoval(s.silence_removal)
    if (typeof s.filler_removal === 'boolean') setFillerRemoval(s.filler_removal)
    // Batch 2 (2026-11-25): headline style + caption position.
    if (s.headline_style === 'bold_bar' || s.headline_style === 'lower_third' || s.headline_style === 'big_centre') {
      setHeadlineStyle(s.headline_style)
    }
    if (s.caption_position === 'bottom' || s.caption_position === 'top' || s.caption_position === 'middle') {
      setCaptionPosition(s.caption_position)
    }
    // Batch 3 (2026-11-25): beat sync, caption translation, export ratios.
    if (typeof s.beat_sync === 'boolean') setBeatSync(s.beat_sync)
    if (
      s.caption_translation === 'none' ||
      s.caption_translation === 'ur' ||
      s.caption_translation === 'hi' ||
      s.caption_translation === 'en'
    ) {
      setCaptionTranslation(s.caption_translation)
    }
    if (Array.isArray(s.export_ratios)) {
      const ratios = s.export_ratios.filter((r) => r === '9:16' || r === '1:1' || r === '16:9')
      if (ratios.length > 0) {
        setExportRatios(ratios.includes('9:16') ? ratios : ['9:16', ...ratios])
      }
    }
    // Batch 4 (2026-11-25): logo overlay.
    if (typeof s.logo_overlay === 'boolean') setLogoOverlay(s.logo_overlay)
    // Batch 6 (2026-11-25): caption safe zone (default ON).
    if (typeof s.caption_safe_zone === 'boolean') setCaptionSafeZone(s.caption_safe_zone)
    // Batch 7 (2026-11-25): whole-clip on-screen text (defaults OFF).
    if (typeof s.ost_persistent === 'boolean') setOstPersistent(s.ost_persistent)
    if (
      s.ost_animation === 'none' ||
      s.ost_animation === 'slide' ||
      s.ost_animation === 'fade' ||
      s.ost_animation === 'pop'
    ) {
      setOstAnimation(s.ost_animation)
    }
    if (typeof s.end_card === 'boolean') setEndCard(s.end_card)
    if (typeof s.end_card_text === 'string') setEndCardText(s.end_card_text)
    if (typeof s.keyword_popups === 'boolean') setKeywordPopups(s.keyword_popups)
    if (typeof s.lower_third_text === 'string') setLowerThirdText(s.lower_third_text)
    if (typeof s.progress_bar === 'boolean') setProgressBar(s.progress_bar)
    if (s.job_type === 'myself' || s.job_type === 'campaign') setJobType(s.job_type)
    if (typeof s.campaign_requirements === 'string') setCampaignRequirements(s.campaign_requirements)
    if (typeof s.notes === 'string') setNotes(s.notes)
    if (
      s.layout === 'center_crop' ||
      s.layout === 'split' ||
      s.layout === 'pip_facecam' ||
      s.layout === 'blur_fill' ||
      s.layout === 'streamer_full'
    ) {
      setLayout(s.layout)
    }
    if (typeof s.content_type === 'string' && s.content_type) setContentType(s.content_type)
    if (s.quality === 'draft' || s.quality === 'standard' || s.quality === 'high') {
      setQuality(s.quality)
    }
  }

  /** Snapshot the current form settings for saving as a preset. */
  const snapshotSettings = (): PresetSettings => ({
    platform,
    aspect_ratio: aspectRatio,
    clip_count: clipCount,
    duration_mode: durationMode,
    duration_seconds:
      durationMode === 'exact' ? exactSeconds : durationMode === 'minimum' ? minSeconds : maxSeconds,
    duration_min_seconds: minSeconds,
    duration_max_seconds: maxSeconds,
    captions_enabled: captionsEnabled,
    captions_language: captionsLanguage,
    caption_style: captionStyle,
    selection_mode: selectionMode,
    on_screen_text: onScreenText,
    auto_zoom: autoZoom,
    face_tracking: faceTracking,
    silence_removal: silenceRemoval,
    filler_removal: fillerRemoval,
    headline_style: headlineStyle,
    caption_position: captionPosition,
    beat_sync: beatSync,
    caption_translation: captionTranslation,
    export_ratios: exportRatios,
    logo_overlay: logoOverlay,
    caption_safe_zone: captionSafeZone,
    ost_persistent: ostPersistent,
    ost_animation: ostAnimation,
    end_card: endCard,
    end_card_text: endCardText.trim() ? endCardText.trim() : null,
    keyword_popups: keywordPopups,
    lower_third_text: lowerThirdText.trim() ? lowerThirdText.trim() : null,
    progress_bar: progressBar,
    job_type: jobType,
    campaign_requirements: campaignRequirements.trim() ? campaignRequirements : null,
    notes: notes.trim() ? notes : null,
    layout,
    content_type: contentType,
    quality,
  })

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

  const handleLoadPreset = (id: number) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    applyJobSettings(preset.settings)
    settingsAppliedRef.current = true
    setPresetMessage(`Loaded preset "${preset.name}". Pick the video or link, then submit.`)
  }

  const handleDeletePreset = async (id: number) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    if (!window.confirm(`Delete preset "${preset.name}"?`)) return
    const result = await deletePreset(id)
    if (!result.ok) {
      setPresetMessage(result.error)
      return
    }
    setPresets((current) => current.filter((p) => p.id !== id))
    setPresetMessage(`Preset "${preset.name}" deleted.`)
  }

  /** Client-side validation; the backend re-validates everything. */
  const validate = (): string | null => {
    if (sourceTab === 'upload' && bulkMode && bulkFiles.length === 0) {
      return 'Choose at least one video file to upload (up to 5).'
    }
    if (sourceTab === 'upload' && !bulkMode && !file) return 'Choose a video file to upload.'
    if (sourceTab === 'link') {
      const url = link.trim()
      if (!url) return 'Paste a video link.'
      try {
        new URL(url)
      } catch {
        return 'That does not look like a valid link. Paste a full YouTube, TikTok, Drive or direct video URL.'
      }
    }
    if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > 50) {
      return 'Number of clips must be between 1 and 50.'
    }
    if (durationMode === 'exact') {
      if (!Number.isInteger(exactSeconds) || exactSeconds < 5 || exactSeconds > 180) {
        return 'Clip duration must be between 5 and 180 seconds.'
      }
    } else {
      if (
        !Number.isInteger(minSeconds) || minSeconds < 5 || minSeconds > 180 ||
        !Number.isInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > 180
      ) {
        return 'Clip durations must be between 5 and 180 seconds.'
      }
      if (minSeconds >= maxSeconds) {
        return 'Minimum duration must be less than maximum duration.'
      }
    }
    if (jobType === 'campaign' && campaignRequirements.trim() === '') {
      return 'Describe the campaign requirements — the worker clips to that brief.'
    }
    return null
  }

  const submit = async () => {
    setSubmitError(null)
    const error = validate()
    if (error) {
      setFormError(error)
      return
    }
    setFormError(null)
    setSubmitting(true)
    // The API requires duration_seconds in every mode: for exact it is
    // the exact length; for minimum/maximum it is the bound that mode
    // enforces (min / max). The min/max pair is sent as well.
    const durationSeconds =
      durationMode === 'exact' ? exactSeconds : durationMode === 'minimum' ? minSeconds : maxSeconds
    const input = {
      file: sourceTab === 'upload' && !bulkMode ? file : null,
      sourceUrl: sourceTab === 'link' ? link.trim() : undefined,
      platform,
      aspectRatio,
      clipCount,
      durationMode,
      durationSeconds,
      durationMinSeconds: durationMode === 'exact' ? null : minSeconds,
      durationMaxSeconds: durationMode === 'exact' ? null : maxSeconds,
      captionsEnabled,
      captionsLanguage,
      captionStyle,
      selectionMode,
      onScreenText,
      autoZoom,
      faceTracking,
      silenceRemoval,
      fillerRemoval,
      headlineStyle,
      captionPosition,
      beatSync,
      captionTranslation,
      exportRatios,
      logoOverlay,
      captionSafeZone,
      ostPersistent,
      ostAnimation,
      endCard,
      endCardText: endCardText.trim(),
      keywordPopups,
      lowerThirdText: lowerThirdText.trim(),
      progressBar,
      jobType,
      campaignRequirements: campaignRequirements.trim(),
      notes: notes.trim(),
      // Split layout is 9:16 only — any other ratio falls back to centre crop.
      layout: aspectRatio === '9:16' ? layout : 'center_crop',
      contentType,
      quality,
    }
    // Batch 4 bulk: one job per file with the same settings. The jobs
    // come back in upload order, so each pairs with its file by index.
    if (sourceTab === 'upload' && bulkMode) {
      const bulkResult = await createBulkJobs(bulkFiles, input)
      setSubmitting(false)
      if (!bulkResult.ok) {
        setSubmitError(bulkResult.error)
        return
      }
      setCreatedJobs(
        bulkResult.jobs.map((job, i) => ({ id: job.id, name: bulkFiles[i]?.name ?? `Job ${job.id}` })),
      )
      return
    }
    const result = await createJob(input)
    setSubmitting(false)
    if (!result.ok) {
      setSubmitError(result.error)
      return
    }
    navigate(`/jobs/${result.job.id}`)
  }

  // While the stored session is still being verified, show a loading
  // state — never the sign-in prompt for a signed-in user.
  if (authLoading) {
    return (
      <div>
        <PageHeader
          title={t('newJobTitle')}
          subtitle="Checking sign-in…"
        />
        <div className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-6 text-sm text-white">
          <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
          Checking sign-in…
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div>
        <PageHeader
          title={t('newJobTitle')}
          subtitle={t('newJobSubtitle')}
        />
        <EmptyState
          title="Sign in to create a job"
          description="Jobs are tied to your account so your clips stay yours. Sign in or register, then come back here."
          action={
            <div className="flex gap-2">
              <Link
                to="/login"
                className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
              >
                Register
              </Link>
            </div>
          }
        />
      </div>
    )
  }

  const durationSummary =
    durationMode === 'exact'
      ? `exact ${exactSeconds}s`
      : `${minSeconds}–${maxSeconds}s (${durationMode})`

  return (
    <div>
      <PageHeader
        title={t('newJobTitle')}
        subtitle={t('newJobSubtitle')}
        actions={
          <Link
            to="/jobs"
            className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
          >
            {t('navMyJobs')}
          </Link>
        }
      />

      {/* 4-step wizard — this page is step 1 (Upload). The worker runs
          steps 2–4 after submit: Analyze (transcription), Select Clips
          (interesting parts), Generate (render + captions). */}
      <ol className="mb-4 flex items-center justify-between gap-2 rounded-2xl border border-ink-border bg-ink-panel px-4 py-4 sm:px-8" aria-label="Clipping steps">
        {[
          { n: 1, label: 'Upload', active: true },
          { n: 2, label: 'Analyze', active: false },
          { n: 3, label: 'Select Clips', active: false },
          { n: 4, label: 'Generate', active: false },
        ].map((s) => (
          <li key={s.n} className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                s.active ? 'bg-brand text-white shadow-glow' : 'bg-ink-panel2 text-[var(--color-text-muted)]'
              }`}
              aria-current={s.active ? 'step' : undefined}
            >
              {s.n}
            </span>
            <span className={`text-xs font-medium ${s.active ? 'text-white' : 'text-[var(--color-text-muted)]'}`}>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {/* Clone banner — the source is never reused, so the user picks
          the video/link again below. */}
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

      {/* Job presets — load a saved settings snapshot, or save the
          current settings under a name. Presets hold settings only;
          the source is always chosen fresh. */}
      <section
        aria-label="Job presets"
        className="mb-4 rounded-2xl border border-ink-border bg-ink-panel p-6"
      >
        <h2 className="text-lg font-semibold text-white">Job presets</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Save this page's settings under a name, or load a saved preset
          into the form. Presets never include the video — you always pick
          the source fresh.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Load preset
            </span>
            <select
              value={selectedPresetId}
              onChange={(e) => {
                const id = Number(e.target.value)
                setSelectedPresetId(e.target.value)
                if (id > 0) handleLoadPreset(id)
              }}
              className="mt-1 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="">Choose a preset…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!selectedPresetId}
            onClick={() => void handleDeletePreset(Number(selectedPresetId))}
            className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete preset
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Save current settings as preset
            </span>
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Preset name, e.g. TikTok 30s punchy"
              maxLength={100}
              className="mt-1 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </label>
          <button
            type="button"
            disabled={presetSaving}
            onClick={() => void handleSavePreset()}
            className="btn-aurora rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {presetSaving ? 'Saving…' : 'Save preset'}
          </button>
        </div>
        {presetMessage ? (
          <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">
            {presetMessage}
          </p>
        ) : null}
      </section>

      {/* Batch 4 bulk result — links to every job just created. */}
      {createdJobs ? (
        <section
          role="status"
          className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6"
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold text-emerald-300">
            <Check className="h-5 w-5" /> Created {createdJobs.length} job{createdJobs.length === 1 ? '' : 's'}
          </h2>
          <ul className="mt-3 space-y-2">
            {createdJobs.map((j) => (
              <li key={j.id}>
                <Link
                  to={`/jobs/${j.id}`}
                  className="text-sm font-medium text-white underline decoration-emerald-400/60 underline-offset-2 hover:text-emerald-200"
                >
                  Job #{j.id} — {j.name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-emerald-200/80">
            Each job processes on its own — open a job to watch its clips
            appear.
          </p>
          <button
            type="button"
            onClick={() => {
              setCreatedJobs(null)
              setBulkFiles([])
              if (inputRef.current) inputRef.current.value = ''
            }}
            className="mt-4 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2 text-sm font-medium text-white hover:border-brand/60"
          >
            Create more jobs
          </button>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Source */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">{t('sourceVideo')}</h2>
            <div className="mt-4 flex gap-2" role="tablist" aria-label="Source type">
              <ChoiceButton selected={sourceTab === 'upload'} onClick={() => setSourceTab('upload')}>
                <span className="flex items-center gap-2">
                  <Upload className="h-4 w-4" /> {t('uploadVideo')}
                </span>
              </ChoiceButton>
              <ChoiceButton selected={sourceTab === 'link'} onClick={() => setSourceTab('link')}>
                <span className="flex items-center gap-2">
                  <Link2 className="h-4 w-4" /> {t('pasteLink')}
                </span>
              </ChoiceButton>
            </div>

            {sourceTab === 'upload' ? (
              <>
                {/* Batch 4 bulk: one job per file (up to 5) with the
                    same settings. Switching clears the chosen file(s). */}
                <div className="mt-4 flex items-center gap-3">
                  <Toggle checked={bulkMode} onChange={setBulk} label="Bulk jobs on or off" />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    Bulk jobs — up to 5 files, one job per file, same
                    settings
                  </span>
                </div>
                {bulkMode && bulkFiles.length > 0 ? (
                  <ul className="mt-4 space-y-2">
                    {bulkFiles.map((f) => (
                      <li key={`${f.name}-${f.size}`} className="flex items-center gap-3 rounded-xl bg-ink-panel2 p-4">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
                          <FileVideo className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-white">{f.name}</p>
                          <p className="text-sm text-[var(--color-text-muted)]">{formatBytes(f.size)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => clearBulkFile(f.name, f.size)}
                          aria-label={`Remove ${f.name}`}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-border text-[var(--color-text-muted)] hover:text-white"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {(bulkMode ? bulkFiles.length < 5 : !file) ? (
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
                    handleFiles(e.dataTransfer.files)
                  }}
                  className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                    dragOver ? 'border-brand bg-brand/10' : 'border-ink-border bg-ink-panel2 hover:border-brand/60'
                  }`}
                >
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/15 text-brand-light">
                    <CloudUpload className="h-7 w-7" />
                  </span>
                  <p className="mt-3 text-base font-semibold text-white">
                    Drag &amp; drop your video{bulkMode ? 's' : ''} here or click to browse
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    {bulkMode
                      ? 'MP4, MOV, MKV, WEBM — up to 2 GB each, max 5 files. Each file becomes its own job.'
                      : 'MP4, MOV, MKV, WEBM — up to 2 GB. The file is checked with ffprobe on the server before the job is queued.'}
                  </p>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="video/*,.mkv"
                    multiple={bulkMode}
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                </div>
                ) : bulkMode ? (
                  <p className="mt-4 text-sm text-[var(--color-text-muted)]">
                    5 files chosen — the maximum for one bulk submit. Remove
                    one to add another.
                  </p>
                ) : (
                <div className="mt-4 flex items-center gap-3 rounded-xl bg-ink-panel2 p-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
                    <FileVideo className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{file?.name ?? ''}</p>
                    <p className="text-sm text-[var(--color-text-muted)]">{file ? formatBytes(file.size) : ''}</p>
                  </div>
                  <button
                    type="button"
                    onClick={clearFile}
                    aria-label="Remove file"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-border text-[var(--color-text-muted)] hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                )}
              </>
            ) : (
              <div className="mt-4">
                <label className="block">
                  <span className="text-sm font-medium text-white">{t('videoLink')}</span>
                  <input
                    type="url"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=… or a TikTok / Drive / direct MP4 link"
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                  />
                </label>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  YouTube, TikTok, Google Drive, or a direct video-file link.
                  Other hosts are rejected by the server. The worker downloads
                  the video — make sure you have the right to process it.
                </p>
              </div>
            )}
          </section>

          {/* Settings */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Clipping Options</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Every setting is a dropdown, choice or toggle — no typing
              needed, except the link above and the campaign box below.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              <fieldset>
                <legend className="text-sm font-medium text-white">{t('platform')}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <ChoiceButton
                      key={p.id}
                      selected={platform === p.id}
                      onClick={() => setPlatform(p.id)}
                    >
                      {p.label}
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-sm font-medium text-white">{t('aspectRatio')}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {ASPECT_RATIOS.map((a) => (
                    <ChoiceButton
                      key={a.id}
                      selected={aspectRatio === a.id}
                      onClick={() => setAspectRatio(a.id)}
                    >
                      {a.label}
                    </ChoiceButton>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className="text-sm font-medium text-white">{t('clipCount')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  value={clipCount}
                  onChange={(e) => setClipCount(Number(e.target.value))}
                  aria-label="Number of clips (1 to 50)"
                  className={`${numberClass} mt-2`}
                />
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  As many as you want, up to 50. How many you actually get also depends on the
                  source — a short video with long clips can only fit a few. Shorter clips fit more.
                </span>
              </label>

              <fieldset>
                <legend className="text-sm font-medium text-white">{t('clipDuration')}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['exact', 'minimum', 'maximum'] as const).map((m) => (
                    <ChoiceButton
                      key={m}
                      selected={durationMode === m}
                      onClick={() => setDurationMode(m)}
                    >
                      {m === 'exact' ? 'Exact' : m === 'minimum' ? 'Minimum' : 'Maximum'}
                    </ChoiceButton>
                  ))}
                </div>
                {durationMode === 'exact' ? (
                  <label className="mt-3 flex items-center gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={5}
                      max={180}
                      value={exactSeconds}
                      onChange={(e) => setExactSeconds(Number(e.target.value))}
                      aria-label="Clip duration in seconds (5 to 180)"
                      className={numberClass}
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">seconds per clip</span>
                  </label>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">
                      <span className="text-sm text-[var(--color-text-muted)]">Min</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={180}
                        value={minSeconds}
                        onChange={(e) => setMinSeconds(Number(e.target.value))}
                        aria-label="Minimum clip duration in seconds (5 to 180)"
                        className={numberClass}
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="text-sm text-[var(--color-text-muted)]">Max</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={180}
                        value={maxSeconds}
                        onChange={(e) => setMaxSeconds(Number(e.target.value))}
                        aria-label="Maximum clip duration in seconds (5 to 180)"
                        className={numberClass}
                      />
                    </label>
                    <span className="text-sm text-[var(--color-text-muted)]">seconds</span>
                  </div>
                )}
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {durationMode === 'exact'
                    ? 'Each clip is exactly this long.'
                    : durationMode === 'minimum'
                      ? 'Clips are at least the minimum long, up to the maximum.'
                      : 'Clips are at most the maximum long, at least the minimum.'}
                </p>
              </fieldset>

              <div className="md:col-span-2">
                <span className="text-sm font-medium text-white">Captions / subtitles</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={captionsEnabled}
                    onChange={setCaptionsEnabled}
                    label="Captions on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {captionsEnabled ? 'Captions on' : 'Captions off'}
                  </span>
                </div>
                <label className="mt-3 block">
                  <span className="text-sm font-medium text-white">Caption language</span>
                  <select
                    value={captionsLanguage}
                    disabled={!captionsEnabled}
                    onChange={(e) =>
                      setCaptionsLanguage(
                        e.target.value as 'english' | 'roman_urdu' | 'hindi' | 'auto',
                      )
                    }
                    className={`${selectClass} mt-2 disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {CAPTION_LANGUAGES.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-3">
                  <span className="text-sm font-medium text-white">{t('captionStyle')}</span>
                  <div className="mt-2">
                    <CaptionStylePicker
                      value={captionStyle}
                      onChange={setCaptionStyle}
                      disabled={!captionsEnabled}
                    />
                  </div>
                </div>
              </div>

              <div>
                <span className="text-sm font-medium text-white">On-screen text</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={onScreenText}
                    onChange={setOnScreenText}
                    label="On-screen text on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {onScreenText ? 'On-screen text on' : 'On-screen text off'}
                  </span>
                </div>
              </div>

              {/* Batch 2 headline style + caption position — defaults are
                  the pre-Batch-2 behaviour (bold bar, bottom). Batch 8:
                  the headline picker is a static card grid (no motion). */}
              <div className="block md:col-span-2">
                <span className="text-sm font-medium text-white">Headline style</span>
                <div className="mt-2">
                  <HeadlineStylePicker
                    value={headlineStyle}
                    onChange={setHeadlineStyle}
                  />
                </div>
              </div>

              {/* Batch 7 whole-clip on-screen text (2026-11-25). The
                  persistent headline and its animation need on-screen
                  text on; the end card, keyword pop-ups, lower-third
                  tag and progress bar work on their own. */}
              <div>
                <span className="text-sm font-medium text-white">Persistent headline</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={ostPersistent}
                    onChange={setOstPersistent}
                    label="Persistent headline on or off"
                    disabled={!onScreenText}
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {ostPersistent ? 'Persistent headline on' : 'Persistent headline off'} — keep
                    the headline up for the whole clip instead of the first 4 seconds
                  </span>
                </div>
                {!onScreenText ? (
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Turn on-screen text on to use the persistent headline.
                  </span>
                ) : null}
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Headline animation</span>
                <select
                  value={ostAnimation}
                  disabled={!onScreenText}
                  onChange={(e) => setOstAnimation(e.target.value as OstAnimation)}
                  className={`${selectClass} mt-2 disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {(Object.keys(OST_ANIMATION_LABELS) as OstAnimation[]).map((a) => (
                    <option key={a} value={a}>
                      {OST_ANIMATION_LABELS[a]}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  {OST_ANIMATION_DESCRIPTIONS[ostAnimation]}
                </span>
              </label>

              <div>
                <span className="text-sm font-medium text-white">Follow end card</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={endCard}
                    onChange={setEndCard}
                    label="Follow end card on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {endCard ? 'End card on' : 'End card off'} — show a card
                    in the last 2 seconds of every clip
                  </span>
                </div>
                {endCard ? (
                  <label className="mt-3 block">
                    <span className="text-sm font-medium text-white">End card text</span>
                    <input
                      type="text"
                      value={endCardText}
                      maxLength={40}
                      placeholder="Follow for more"
                      onChange={(e) => setEndCardText(e.target.value)}
                      className={`${inputClass} mt-2`}
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
                    checked={keywordPopups}
                    onChange={setKeywordPopups}
                    label="Keyword pop-ups on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {keywordPopups ? 'Keyword pop-ups on' : 'Keyword pop-ups off'} — pop up to 4
                    important spoken words as large text at the moment they are said
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Lower-third tag</span>
                <input
                  type="text"
                  value={lowerThirdText}
                  maxLength={40}
                  placeholder="@yourchannel"
                  onChange={(e) => setLowerThirdText(e.target.value)}
                  className={`${inputClass} mt-2`}
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
                    checked={progressBar}
                    onChange={setProgressBar}
                    label="Progress bar on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {progressBar ? 'Progress bar on' : 'Progress bar off'} — a thin violet bar
                    along the bottom edge, growing across the full clip
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">{t('captionPosition')}</span>
                <select
                  value={captionPosition}
                  onChange={(e) => setCaptionPosition(e.target.value as CaptionPosition)}
                  className={`${selectClass} mt-2`}
                >
                  {(Object.keys(CAPTION_POSITION_LABELS) as CaptionPosition[]).map((p) => (
                    <option key={p} value={p}>
                      {CAPTION_POSITION_LABELS[p]}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Where the burn-in captions sit — never over the headline.
                </span>
              </label>

              {/* Batch 3 beat sync + caption translation + export ratios. */}
              <div>
                <span className="text-sm font-medium text-white">Beat sync</span>
                <div className="mt-2 flex items-center gap-3">
                  <Toggle
                    checked={beatSync}
                    onChange={setBeatSync}
                    label="Beat sync on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {beatSync ? 'Beat sync on' : 'Beat sync off'} — snap cuts
                    and zoom to the beat of the audio
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-white">Translate captions</span>
                <select
                  value={captionTranslation}
                  onChange={(e) => setCaptionTranslation(e.target.value as CaptionTranslation)}
                  className={`${selectClass} mt-2`}
                >
                  {(Object.keys(CAPTION_TRANSLATION_LABELS) as CaptionTranslation[]).map((t) => (
                    <option key={t} value={t}>
                      {CAPTION_TRANSLATION_LABELS[t]}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Translates the captions after transcription. If the free
                  translation service is unavailable, captions stay in the
                  original language and the job says so.
                </span>
              </label>

              <div>
                <span className="text-sm font-medium text-white">Export ratios</span>
                <div className="mt-2 flex flex-wrap items-center gap-4">
                  {EXPORT_RATIO_OPTIONS.map((ratio) => {
                    const checked = exportRatios.includes(ratio)
                    const locked = ratio === '9:16'
                    return (
                      <label key={ratio} className="flex items-center gap-2 text-sm text-white">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => {
                            setExportRatios(
                              checked
                                ? exportRatios.filter((r) => r !== ratio)
                                : [...exportRatios, ratio],
                            )
                          }}
                          className="h-4 w-4 accent-fuchsia-500 disabled:opacity-60"
                        />
                        {ratio}
                        {locked ? ' (always on)' : ''}
                      </label>
                    )
                  })}
                </div>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
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
                    checked={logoOverlay}
                    onChange={setLogoOverlay}
                    label="Logo overlay on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {logoOverlay ? 'Logo overlay on' : 'Logo overlay off'} — watermark your Brand Kit
                    logo on every clip (bottom-right)
                  </span>
                </div>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Upload the logo in Brand Kit first. If no logo is uploaded,
                  the job renders without one and says so.
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
                    checked={captionSafeZone}
                    onChange={setCaptionSafeZone}
                    label="Caption safe zone on or off"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {captionSafeZone ? 'Caption safe zone on' : 'Caption safe zone off'} — keep
                    captions clear of TikTok's right action rail and bottom bar
                  </span>
                </div>
              </div>

              {/* Batch 1 clip enhancements — all default ON. */}
              <div>
                <span className="text-sm font-medium text-white">Clip enhancements</span>
                <div className="mt-2 space-y-3">
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={autoZoom}
                      onChange={setAutoZoom}
                      label="Auto zoom on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Auto zoom — slow punch-in on the exciting parts
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={faceTracking}
                      onChange={setFaceTracking}
                      label="Face tracking on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Face tracking — keep the speaker centred as they move
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={silenceRemoval}
                      onChange={setSilenceRemoval}
                      label="Silence removal on or off"
                    />
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Remove silence — trim pauses over 0.7s, start on speech
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Toggle
                      checked={fillerRemoval}
                      onChange={setFillerRemoval}
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
                  value={contentType}
                  onChange={(e) => setContentType(e.target.value)}
                  className={`${selectClass} mt-2`}
                >
                  {CONTENT_TYPES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-white">Clip selection</span>
                <select
                  aria-label="Clip selection"
                  value={selectionMode}
                  onChange={(e) => setSelectionMode(e.target.value as SelectionMode)}
                  className={`${selectClass} mt-2`}
                >
                  {(Object.keys(SELECTION_MODE_LABELS) as SelectionMode[]).map((id) => (
                    <option key={id} value={id}>
                      {SELECTION_MODE_LABELS[id]}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  {SELECTION_MODE_DESCRIPTIONS[selectionMode]}
                </span>
              </label>

              {aspectRatio === '9:16' ? (
                <label className="block">
                  <span className="text-sm font-medium text-white">Layout (9:16 only)</span>
                  <select
                    value={layout}
                    onChange={(e) => setLayout(e.target.value as ClipLayout)}
                    className={`${selectClass} mt-2`}
                  >
                    {(Object.keys(LAYOUT_LABELS) as ClipLayout[]).map((id) => (
                      <option key={id} value={id}>
                        {LAYOUT_LABELS[id]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="block">
                <span className="text-sm font-medium text-white">Quality</span>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as 'draft' | 'standard' | 'high')}
                  className={`${selectClass} mt-2`}
                >
                  <option value="draft">Draft preview</option>
                  <option value="standard">Standard</option>
                  <option value="high">High quality</option>
                </select>
              </label>

              <fieldset className="md:col-span-2">
                <legend className="text-sm font-medium text-white">{t('jobType')}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  <ChoiceButton selected={jobType === 'myself'} onClick={() => setJobType('myself')}>
                    For myself
                  </ChoiceButton>
                  <ChoiceButton selected={jobType === 'campaign'} onClick={() => setJobType('campaign')}>
                    For a campaign
                  </ChoiceButton>
                </div>
                {jobType === 'campaign' ? (
                  <label className="mt-3 block">
                    <span className="text-sm font-medium text-white">{t('campaignRequirements')}</span>
                    <textarea
                      value={campaignRequirements}
                      onChange={(e) => setCampaignRequirements(e.target.value)}
                      rows={4}
                      maxLength={5000}
                      placeholder="What must the clips do for this campaign? Tone, hooks, product moments, things to avoid…"
                      className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                    />
                    <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                      Required for campaign jobs — the worker clips to this brief.
                    </span>
                  </label>
                ) : null}
              </fieldset>

              <label className="block md:col-span-2">
                <span className="text-sm font-medium text-white">{t('notes')}</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  maxLength={5000}
                  placeholder="Anything extra for this job? Paste the full campaign brief here — must-haves, nice-to-haves, tone, hooks, product moments, things to avoid…"
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                />
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Optional — sent with the job. Must-haves in here are always followed; nice-to-haves are followed when they make the clips better.
                </span>
              </label>
            </div>

            {formError ? (
              <p role="alert" className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {formError}
              </p>
            ) : null}
            {submitError ? (
              <div role="alert" className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
                  <AlertTriangle className="h-4 w-4" /> Job could not be created
                </p>
                <p className="mt-2 break-words text-sm text-red-200/90">{submitError}</p>
              </div>
            ) : null}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting}
                className="flex items-center gap-2 rounded-xl btn-aurora px-6 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                {submitting
                  ? t('createJob')
                  : sourceTab === 'upload' && bulkMode
                    ? `Create ${bulkFiles.length} job${bulkFiles.length === 1 ? '' : 's'} →`
                    : 'Analyze Video →'}
              </button>
            </div>
          </section>
        </div>

        {/* Right rail — live summary */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Summary</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ['Source', sourceTab === 'upload' ? (file ? file.name : 'No file chosen yet') : link.trim() || 'No link pasted yet'],
                ['Platform', platform === 'tiktok' ? 'TikTok' : 'Instagram'],
                ['Ratio', aspectRatio],
                ['Clips', `${clipCount} clip${clipCount === 1 ? '' : 's'}`],
                ['Duration', durationSummary],
                ['Captions', captionsEnabled ? `On (${CAPTION_LANGUAGES.find((l) => l.id === captionsLanguage)?.label ?? captionsLanguage})` : 'Off'],
                ['Caption style', captionsEnabled ? getCaptionStyle(captionStyle).name : 'Off'],
                ['Clip selection', SELECTION_MODE_LABELS[selectionMode]],
                ['On-screen text', onScreenText ? 'On' : 'Off'],
                ['Headline style', HEADLINE_STYLE_LABELS[headlineStyle]],
                ['Persistent headline', ostPersistent ? 'On' : 'Off'],
                ['Headline animation', OST_ANIMATION_LABELS[ostAnimation]],
                ['Follow end card', endCard ? (endCardText.trim() || 'Follow for more') : 'Off'],
                ['Keyword pop-ups', keywordPopups ? 'On' : 'Off'],
                ['Lower-third tag', lowerThirdText.trim() || 'Off'],
                ['Progress bar', progressBar ? 'On' : 'Off'],
                ['Caption position', CAPTION_POSITION_LABELS[captionPosition]],
                ['Beat sync', beatSync ? 'On' : 'Off'],
                ['Translate captions', CAPTION_TRANSLATION_LABELS[captionTranslation]],
                ['Export ratios', exportRatios.join(', ')],
                ['Logo overlay', logoOverlay ? 'On' : 'Off'],
                ['Caption safe zone', captionSafeZone ? 'On' : 'Off'],
                ['Auto zoom', autoZoom ? 'On' : 'Off'],
                ['Face tracking', faceTracking ? 'On' : 'Off'],
                ['Silence removal', silenceRemoval ? 'On' : 'Off'],
                ['Filler removal', fillerRemoval ? 'On' : 'Off'],
                ['Job type', jobType === 'myself' ? 'For myself' : 'For a campaign'],
                ['Layout', aspectRatio === '9:16' ? LAYOUT_LABELS[layout] : 'Centre crop'],
                ['Quality', quality === 'draft' ? 'Draft preview' : quality === 'standard' ? 'Standard' : 'High quality'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="break-words text-right font-medium text-white">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 border-t border-ink-border pt-4 text-xs leading-relaxed text-[var(--color-text-muted)]">
              After creating the job you land on its detail page, where the
              real stage and progress are shown as the worker processes it.
              Clips appear there when they are rendered and validated — never
              before.
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
              ].map((f) => (
                <li key={f} className="flex items-center gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  )
}
