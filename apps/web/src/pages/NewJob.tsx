import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
import { API_URL } from '../lib/api'
import {
  CAPTION_STYLES,
  getCaptionStyle,
  isCaptionStyleId,
} from '../lib/captionStyles'
import { createJob } from '../lib/jobs'
import { formatBytes } from '../lib/format'
import { useAuth } from '../state/auth'

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
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
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
  const { user, token } = useAuth()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  // Source
  const [sourceTab, setSourceTab] = useState<'upload' | 'link'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [link, setLink] = useState('')

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
  const [onScreenText, setOnScreenText] = useState(false)
  const [jobType, setJobType] = useState<'myself' | 'campaign'>('myself')
  const [campaignRequirements, setCampaignRequirements] = useState('')
  // Notes for Muse: free-text brief for THIS job (campaign details,
  // extra instructions, must-haves vs nice-to-haves). Sent with the
  // job so the worker — and Muse in chat — can read it and clip to it.
  // Optional for every job; campaign jobs already have their own
  // required requirements box above.
  const [notes, setNotes] = useState('')
  const [layout, setLayout] = useState<'center_crop' | 'split'>('center_crop')
  const [contentType, setContentType] = useState('general')
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard')

  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Default caption style from the user's saved settings (Captions Studio
  // saves it via PATCH /api/v1/settings). 'punchy' when nothing is saved.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const body = (await res.json()) as { settings?: { caption_style?: unknown } }
        const saved = body.settings?.caption_style
        if (!cancelled && isCaptionStyleId(saved)) setCaptionStyle(saved)
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

  const clearFile = () => {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  /** Client-side validation; the backend re-validates everything. */
  const validate = (): string | null => {
    if (sourceTab === 'upload' && !file) return 'Choose a video file to upload.'
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
    const result = await createJob({
      file: sourceTab === 'upload' ? file : null,
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
      onScreenText,
      jobType,
      campaignRequirements: campaignRequirements.trim(),
      notes: notes.trim(),
      // Split layout is 9:16 only — any other ratio falls back to centre crop.
      layout: aspectRatio === '9:16' ? layout : 'center_crop',
      contentType,
      quality,
    })
    setSubmitting(false)
    if (!result.ok) {
      setSubmitError(result.error)
      return
    }
    navigate(`/jobs/${result.job.id}`)
  }

  if (!user) {
    return (
      <div>
        <PageHeader
          title="New Job"
          subtitle="Turn a long video into short clips."
        />
        <EmptyState
          title="Sign in to create a job"
          description="Jobs are tied to your account so your clips stay yours. Sign in or register, then come back here."
          action={
            <div className="flex gap-2">
              <Link
                to="/login"
                className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
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
        title="AI Clipper"
        subtitle="Let AI find the best moments in your video"
        actions={
          <Link
            to="/jobs"
            className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
          >
            My Jobs
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Source */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Source video</h2>
            <div className="mt-4 flex gap-2" role="tablist" aria-label="Source type">
              <ChoiceButton selected={sourceTab === 'upload'} onClick={() => setSourceTab('upload')}>
                <span className="flex items-center gap-2">
                  <Upload className="h-4 w-4" /> Upload a file
                </span>
              </ChoiceButton>
              <ChoiceButton selected={sourceTab === 'link'} onClick={() => setSourceTab('link')}>
                <span className="flex items-center gap-2">
                  <Link2 className="h-4 w-4" /> Paste a link
                </span>
              </ChoiceButton>
            </div>

            {sourceTab === 'upload' ? (
              !file ? (
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
                  className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                    dragOver ? 'border-brand bg-brand/10' : 'border-ink-border bg-ink-panel2 hover:border-brand/60'
                  }`}
                >
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/15 text-brand-light">
                    <CloudUpload className="h-7 w-7" />
                  </span>
                  <p className="mt-3 text-base font-semibold text-white">
                    Drag &amp; drop your video here or click to browse
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    MP4, MOV, MKV, WEBM — up to 2 GB. The file is checked with
                    ffprobe on the server before the job is queued.
                  </p>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="video/*,.mkv"
                    className="hidden"
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-3 rounded-xl bg-ink-panel2 p-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
                    <FileVideo className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{file.name}</p>
                    <p className="text-sm text-[var(--color-text-muted)]">{formatBytes(file.size)}</p>
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
              )
            ) : (
              <div className="mt-4">
                <label className="block">
                  <span className="text-sm font-medium text-white">Video link</span>
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
                <legend className="text-sm font-medium text-white">Platform</legend>
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
                <legend className="text-sm font-medium text-white">Aspect ratio</legend>
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
                <span className="text-sm font-medium text-white">Number of clips</span>
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
                <legend className="text-sm font-medium text-white">Clip duration</legend>
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

              <div>
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
                <label className="mt-3 block">
                  <span className="text-sm font-medium text-white">Caption style</span>
                  <select
                    aria-label="Caption style"
                    value={captionStyle}
                    disabled={!captionsEnabled}
                    onChange={(e) => setCaptionStyle(e.target.value)}
                    className={`${selectClass} mt-2 disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {CAPTION_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    {getCaptionStyle(captionStyle).description}
                  </span>
                </label>
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
              </div>

              {aspectRatio === '9:16' ? (
                <label className="block">
                  <span className="text-sm font-medium text-white">Layout (9:16 only)</span>
                  <select
                    value={layout}
                    onChange={(e) => setLayout(e.target.value as 'center_crop' | 'split')}
                    className={`${selectClass} mt-2`}
                  >
                    <option value="center_crop">Centre crop (full frame)</option>
                    <option value="split">Split — streamer top, gameplay bottom</option>
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
                <legend className="text-sm font-medium text-white">Job type</legend>
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
                    <span className="text-sm font-medium text-white">Campaign requirements</span>
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
                <span className="text-sm font-medium text-white">Notes for Muse</span>
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
                className="flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand-light disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                {submitting ? 'Creating job…' : 'Analyze Video →'}
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
                ['On-screen text', onScreenText ? 'On' : 'Off'],
                ['Job type', jobType === 'myself' ? 'For myself' : 'For a campaign'],
                ['Layout', aspectRatio === '9:16' ? (layout === 'split' ? 'Split (streamer top / gameplay bottom)' : 'Centre crop') : 'Centre crop'],
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
