import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Film,
  Loader2,
  Music,
  Play,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { BulkRerenderBar } from '../components/BulkRerenderBar'
import { ClipFavouriteButton, ClipThumbnailPicker } from '../components/ClipActions'
import { ClipPlayerModal } from '../components/ClipPlayerModal'
import { ClipThumbnail } from '../components/ClipThumbnail'
import { JobStatusPill, jobSummary } from '../components/JobStatusPill'
import { QueueInfo } from '../components/QueueInfo'
import { PageHeader } from '../components/PageHeader'
import { ScoreBreakdown } from '../components/ScoreBreakdown'
import { ViralChecklist } from '../components/ViralChecklist'
import { CaptionStylePicker } from '../components/StylePicker'
import { CAPTION_STYLES, getCaptionStyle } from '../lib/captionStyles'
import { formatBytes, formatDuration } from '../lib/format'
import { VIRAL_TONE_CLASS, viralScore } from '../lib/viralScore'
import {
  cancelJob,
  CAPTION_POSITION_LABELS,
  CAPTION_TRANSLATION_LABELS,
  COLOUR_GRADE_LABELS,
  createClipVariant,
  defaultOstPosition,
  downloadClip,
  downloadClipAudio,
  getClipRerenders,
  getJob,
  HEADLINE_STYLE_LABELS,
  LAYOUT_LABELS,
  OST_ANIMATION_LABELS,
  OST_LANGUAGE_LABELS,
  OST_POSITION_LABELS,
  requestClipRerender,
  retryJob,
  saveClipPerformance,
  SELECTION_MODE_LABELS,
  SFX_LABELS,
  type CampaignParsed,
  type CaptionPosition,
  type CaptionTranslation,
  type ClipLayout,
  type ClipRerender,
  type ColourGrade,
  type HeadlineStyle,
  type Job,
  type JobClip,
  type ManualCheck,
  type OstAnimation,
  type OstLanguage,
  type Sfx,
  updateCampaignChecks,
} from '../lib/jobs'
import { useAuth } from '../state/auth'
import { usePlatform } from '../lib/platform'
import { mapLaravelStatus, useProjects } from '../state/projects'

const POLL_MS = 5000

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function settingRows(job: Job): Array<[string, string]> {
  const s = job.settings
  if (!s) return []
  const duration =
    s.duration_mode === 'exact'
      ? `Exact ${s.duration_seconds}s`
      : s.duration_min_seconds != null && s.duration_max_seconds != null
        ? `${s.duration_mode === 'minimum' ? 'Min' : 'Max'} ${s.duration_seconds}s (range ${s.duration_min_seconds}–${s.duration_max_seconds}s)`
        : `${s.duration_mode} ${s.duration_seconds}s`
  const language =
    s.captions_language === 'roman_urdu'
      ? 'Roman Urdu'
      : s.captions_language === 'english'
        ? 'English'
        : s.captions_language === 'hindi'
          ? 'Hindi'
          : 'Auto-detect'
  const rows: Array<[string, string]> = [
    ['Platform', s.platform === 'tiktok' ? 'TikTok' : 'Instagram'],
    ['Aspect ratio', s.aspect_ratio],
    ['Clips requested', String(s.clip_count)],
    [
      'Clip selection',
      SELECTION_MODE_LABELS[
        s.selection_mode === 'fill_any' ? 'fill_any' : 'interesting_only'
      ],
    ],
    ['Duration', duration],
    ['Captions', s.captions_enabled ? `On (${language})` : 'Off'],
    ['Caption style', getCaptionStyle(s.caption_style).name],
    ['On-screen text', s.on_screen_text ? 'On' : 'Off'],
    // Batch 1 enhancements — absent on jobs made before them, where the
    // worker treats them as ON, so absent reads as On here too.
    ['Auto zoom', s.auto_zoom === false ? 'Off' : 'On'],
    ['Face tracking', s.face_tracking === false ? 'Off' : 'On'],
    ['Silence removal', s.silence_removal === false ? 'Off' : 'On'],
    ['Filler removal', s.filler_removal === false ? 'Off' : 'On'],
    // Batch 15 (2026-11-28) — pattern interrupts are always ON
    // (no wizard toggle); loop-perfect is the Step 2 toggle
    // (default OFF). Absent on older jobs means ON / OFF.
    ['Pattern interrupts', s.pattern_interrupts === false ? 'Off' : 'On'],
    ['Loop-perfect clip', s.loop_perfect ? 'On' : 'Off'],
    // Batch 16 (2026-11-28) — caption intelligence, all default ON
    // (no wizard toggles). Absent on older jobs means ON.
    ['Face-aware captions', s.face_aware_captions === false ? 'Off' : 'On'],
    ['Speaker colours', s.speaker_colours === false ? 'Off' : 'On'],
    ['Emotion emphasis', s.emotion_emphasis === false ? 'Off' : 'On'],
    ['Dynamic headline', s.dynamic_headline === false ? 'Off' : 'On'],
    ['Scroll-stopper first frame', s.scroll_stopper === false ? 'Off' : 'On'],
    // Batch 2 (2026-11-25) — absent on older jobs means the defaults
    // (bold bar, bottom), which is what the worker renders for them.
    [
      'Headline style',
      HEADLINE_STYLE_LABELS[
        (s.headline_style as HeadlineStyle | undefined) ?? 'bold_bar'
      ] ?? 'Bold bar (top)',
    ],
    // Batch 9 (2026-11-25) — OST position is where the headline
    // sits, independent of the style. Absent on older jobs means
    // the style default, labelled as the default.
    [
      'OST position',
      s.ost_position === 'top' || s.ost_position === 'centre' || s.ost_position === 'bottom'
        ? OST_POSITION_LABELS[s.ost_position]
        : `${OST_POSITION_LABELS[defaultOstPosition((s.headline_style as HeadlineStyle | undefined) ?? 'bold_bar')]} (default for ${HEADLINE_STYLE_LABELS[(s.headline_style as HeadlineStyle | undefined) ?? 'bold_bar']})`,
    ],
    // Batch 9 (2026-11-25) — SFX sting + music bed. Absent SFX
    // means 'none'; a null bed name means no bed was uploaded.
    [
      'Sound effect (SFX)',
      SFX_LABELS[(s.sfx as Sfx | undefined) ?? 'none'] ?? 'None',
    ],
    // Batch 9 (2026-11-25) — colour grade. Absent on older jobs
    // means 'none': no filter, the render pipeline untouched.
    [
      'Colour grade',
      COLOUR_GRADE_LABELS[(s.colour_grade as ColourGrade | undefined) ?? 'none'] ?? 'None (default)',
    ],
    ['Music bed', job.music_bed_name ?? 'No music bed'],
    [
      'Caption position',
      CAPTION_POSITION_LABELS[
        (s.caption_position as CaptionPosition | undefined) ?? 'bottom'
      ] ?? 'Bottom',
    ],
    // Batch 3 (2026-11-25) — absent on older jobs means the defaults
    // (beat sync ON, no translation, the job's own ratio only), which
    // is what the worker renders for them.
    ['Beat sync', s.beat_sync === false ? 'Off' : 'On'],
    [
      'Translate captions',
      CAPTION_TRANSLATION_LABELS[
        (s.caption_translation as CaptionTranslation | undefined) ?? 'none'
      ] ?? 'None (original language)',
    ],
    // Batch 9 (2026-11-25) — OST language. Absent on older jobs means
    // 'source': the headline stays in the video's own language, which
    // is what the worker renders for them. Only the derived headline
    // is translated — never the end card, tag or keyword pop-ups.
    [
      'OST language',
      OST_LANGUAGE_LABELS[
        (s.ost_language as OstLanguage | undefined) ?? 'source'
      ] ?? 'Source language',
    ],
    [
      'Export ratios',
      Array.isArray(s.export_ratios) && s.export_ratios.length > 0
        ? s.export_ratios.join(', ')
        : s.aspect_ratio,
    ],
    // Batch 4 (2026-11-25) — absent on older jobs means OFF (the
    // worker treats a missing key as OFF), which is what this shows.
    ['Logo overlay', s.logo_overlay ? 'On' : 'Off'],
    // Batch 6 (2026-11-25) — absent on older jobs means ON (the
    // worker treats a missing key as ON), which is what this shows.
    ['Caption safe zone', s.caption_safe_zone === false ? 'Off' : 'On'],
    // Batch 7 (2026-11-25) — absent on older jobs means OFF / 'none' /
    // empty (the worker treats a missing key as the default), which
    // is what this shows.
    ['Persistent headline', s.ost_persistent ? 'On' : 'Off'],
    [
      'Headline animation',
      OST_ANIMATION_LABELS[
        (s.ost_animation as OstAnimation | undefined) ?? 'none'
      ] ?? 'None',
    ],
    [
      'Follow end card',
      s.end_card ? (s.end_card_text?.trim() || 'Follow for more') : 'Off',
    ],
    ['Keyword pop-ups', s.keyword_popups ? 'On' : 'Off'],
    ['Lower-third tag', s.lower_third_text?.trim() || 'Off'],
    ['Progress bar', s.progress_bar ? 'On' : 'Off'],
    ['Job type', s.job_type === 'campaign' ? 'For a campaign' : 'For myself'],
    // Batch 9 (2026-11-25) — the old split-vs-centre-crop ternary
    // lied about blur_fill (and every other layout): use the label
    // for the stored layout, whatever it is.
    [
      'Layout',
      LAYOUT_LABELS[(s.layout as ClipLayout | undefined) ?? 'center_crop'] ?? 'Centre crop',
    ],
    ['Content type', s.content_type],
    ['Quality', s.quality === 'draft' ? 'Draft preview' : s.quality === 'high' ? 'High quality' : 'Standard'],
  ]
  if (s.job_type === 'campaign') {
    const brief = s.campaign_brief ?? s.campaign_requirements
    if (brief) rows.push(['Campaign brief', brief])
    if (s.campaign_caption) {
      rows.push([
        s.campaign_caption_required === false ? 'Post caption (Optional)' : 'Post caption (Required)',
        s.campaign_caption,
      ])
    }
    if (s.campaign_hashtags) {
      rows.push([
        s.campaign_hashtags_required === false ? 'Hashtags (Optional)' : 'Hashtags (Required)',
        s.campaign_hashtags,
      ])
    }
    if (s.campaign_ost) {
      rows.push([
        s.campaign_ost_required === false ? 'On-screen text (Optional)' : 'On-screen text (Required)',
        s.campaign_ost,
      ])
    }
    if (s.ost_hint) rows.push(['OST hint', s.ost_hint])
  }
  if (s.notes) {
    rows.push(['Notes for Muse', s.notes])
  }
  return rows
}

/**
 * Re-render control for one clip: pick a different caption style and
 * queue a re-render. The worker re-renders the SAME window and replaces
 * the file in place; this polls the re-render status while it is
 * queued/processing and refreshes the job when it lands, so the new
 * style and file show without a manual reload.
 */
function ClipRerenderControl({
  clip,
  onRerendered,
}: {
  clip: JobClip
  onRerendered: () => void
}) {
  const otherStyles = CAPTION_STYLES.filter((s) => s.id !== (clip.caption_style ?? ''))
  const [style, setStyle] = useState<string>(otherStyles[0]?.id ?? 'punchy')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<ClipRerender | null>(null)
  const prevStatusRef = useRef<string | null>(null)

  // Escape closes the style picker (same pattern as ClipPlayerModal).
  useEffect(() => {
    if (!pickerOpen) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen])

  // Keep the picker on a valid style when the clip changes (new file landed).
  useEffect(() => {
    const next = CAPTION_STYLES.filter((s) => s.id !== (clip.caption_style ?? ''))[0]?.id
    if (next) setStyle(next)
  }, [clip.caption_style])

  const refresh = useCallback(async () => {
    const list = await getClipRerenders(clip.id)
    const first = list[0] ?? null
    const prev = prevStatusRef.current
    setLatest(first)
    prevStatusRef.current = first?.status ?? null
    // A re-render that just finished changes the clip file + style.
    if (
      first &&
      (first.status === 'ready' || first.status === 'failed') &&
      (prev === 'queued' || prev === 'processing')
    ) {
      onRerendered()
    }
  }, [clip.id, onRerendered])

  useEffect(() => {
    void refresh()
    if (!latest || latest.status === 'queued' || latest.status === 'processing') {
      const timer = setInterval(() => void refresh(), 5000)
      return () => clearInterval(timer)
    }
    return undefined
  }, [refresh, latest?.status])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const result = await requestClipRerender(clip.id, style)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    prevStatusRef.current = null
    setLatest(result.rerender)
  }

  const inFlight = latest?.status === 'queued' || latest?.status === 'processing'

  return (
    <div className="mt-3 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-white">
          Captions: {getCaptionStyle(clip.caption_style).name}
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={submitting || inFlight}
          aria-label="Choose a caption style for re-render"
          className="rounded-lg border border-ink-border bg-ink-panel2 px-2 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Choose a style: {getCaptionStyle(style).name}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || inFlight}
          className="flex items-center gap-1.5 rounded-lg btn-aurora px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {inFlight ? 'Re-rendering…' : 'Re-render with this style'}
        </button>
      </div>
      {pickerOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Choose a caption style for re-render"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-border bg-ink-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">Re-render with a new style</p>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  The clip is re-rendered with the same window and replaces
                  the file in place. The current style cannot be picked —
                  re-rendering to the same style would change nothing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label="Close style picker"
                className="shrink-0 rounded-lg p-1.5 text-white hover:bg-ink-panel2"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4">
              <CaptionStylePicker
                value={style}
                onChange={setStyle}
                currentId={clip.caption_style ?? undefined}
              />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(false)
                  void submit()
                }}
                disabled={submitting || inFlight}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Re-render with {getCaptionStyle(style).name}
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-xl border border-ink-border px-4 py-2.5 text-sm font-medium text-white hover:bg-ink-panel2"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {latest ? (
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          {latest.status === 'ready'
            ? `Re-rendered with ${getCaptionStyle(latest.caption_style).name} — the file above is the new version.`
            : latest.status === 'failed'
              ? `Re-render failed${latest.error_message ? `: ${latest.error_message}` : '.'}`
              : `Re-render ${latest.status} with ${getCaptionStyle(latest.caption_style).name}…`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Batch 9: create an A/B variant of one clip — a different caption
 * style and/or headline style. The worker renders the SAME window
 * and uploads a NEW clip (Variant B) instead of replacing this file;
 * this polls the clip's re-render history until the variant row
 * lands, then refreshes the job so Variant B appears next to this
 * clip. A variant identical to the original is rejected by the
 * server with an honest message.
 */
function ClipVariantControl({
  clip,
  onVariantReady,
}: {
  clip: JobClip
  onVariantReady: () => void
}) {
  const [style, setStyle] = useState<string>('neon')
  const [headline, setHeadline] = useState<string>('same')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<ClipRerender | null>(null)
  const prevStatusRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const list = await getClipRerenders(clip.id)
    const variant = list.find((r) => r.is_variant) ?? null
    const prev = prevStatusRef.current
    setLatest(variant)
    prevStatusRef.current = variant?.status ?? null
    if (
      variant &&
      (variant.status === 'ready' || variant.status === 'failed') &&
      (prev === 'queued' || prev === 'processing')
    ) {
      onVariantReady()
    }
  }, [clip.id, onVariantReady])

  useEffect(() => {
    void refresh()
    if (!latest || latest.status === 'queued' || latest.status === 'processing') {
      const timer = setInterval(() => void refresh(), 5000)
      return () => clearInterval(timer)
    }
    return undefined
  }, [refresh, latest?.status])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const result = await createClipVariant(
      clip.id,
      style,
      headline === 'same' ? null : headline,
    )
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    prevStatusRef.current = null
    setLatest(result.rerender)
  }

  const inFlight = latest?.status === 'queued' || latest?.status === 'processing'

  return (
    <div className="mt-3 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-white">Create Variant B</span>
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          Captions
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            disabled={submitting || inFlight}
            aria-label="Caption style for the variant"
            className="rounded-lg border border-ink-border bg-ink-panel2 px-2 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {CAPTION_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          Headline
          <select
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            disabled={submitting || inFlight}
            aria-label="Headline style for the variant (optional)"
            className="rounded-lg border border-ink-border bg-ink-panel2 px-2 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="same">Same as original</option>
            {(Object.keys(HEADLINE_STYLE_LABELS) as HeadlineStyle[]).map((h) => (
              <option key={h} value={h}>
                {HEADLINE_STYLE_LABELS[h]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || inFlight}
          className="flex items-center gap-1.5 rounded-lg btn-aurora px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {inFlight ? 'Rendering variant…' : 'Create variant'}
        </button>
      </div>
      {latest ? (
        <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          {latest.status === 'ready'
            ? `Variant B ready with ${getCaptionStyle(latest.caption_style).name} — it appears next to this clip.`
            : latest.status === 'failed'
              ? `Variant failed${latest.error_message ? `: ${latest.error_message}` : '.'}`
              : `Variant ${latest.status} with ${getCaptionStyle(latest.caption_style).name}…`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Copy-to-clipboard button with a brief "Copied" state. Falls back to
 * a hidden textarea when the Clipboard API is unavailable.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // Clipboard unavailable — the text is still visible to copy by hand.
      }
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-border px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-ink-panel2"
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? 'Copied' : label}
    </button>
  )
}

/**
 * Batch 4: the worker's title + hashtag suggestions, derived from the
 * job's own transcript. Shown when the job has any; a Ready job whose
 * clips have no transcript at all (silent source) honestly says so
 * instead. A job rendered before suggestions existed shows nothing —
 * its clips have transcripts, so "no speech" would be a lie.
 */
function SuggestionsCard({ job }: { job: Job }) {
  const hasTitle = job.title_suggestion != null && job.title_suggestion !== ''
  const hashtags = Array.isArray(job.hashtags) ? job.hashtags : []
  if (!hasTitle && hashtags.length === 0) {
    if (job.status !== 'ready') return null
    const anySpeech = job.clips.some(
      (c) => c.transcript_excerpt != null && c.transcript_excerpt !== '',
    )
    if (anySpeech) return null
    return (
      <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="text-lg font-semibold text-white">Suggested title &amp; hashtags</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          No suggestions — this clip has no speech.
        </p>
      </section>
    )
  }
  return (
    <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
      <h2 className="text-lg font-semibold text-white">Suggested title &amp; hashtags</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Derived from this job&apos;s own transcript — copy and edit before posting.
      </p>
      {hasTitle ? (
        <div className="mt-4 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm font-medium text-white">{job.title_suggestion}</p>
          <CopyButton text={job.title_suggestion ?? ''} label="Copy title" />
        </div>
      ) : null}
      {hashtags.length > 0 ? (
        <div className="mt-3 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 break-words text-sm text-brand-light">
            {hashtags.join(' ')}
          </p>
          <CopyButton text={hashtags.join(' ')} label="Copy hashtags" />
        </div>
      ) : null}
    </section>
  )
}

/**
 * Batch 12: one clip's attached post caption — the title, caption
 * and hashtags to post with the clip, with Copy buttons. Labelled
 * "Campaign required" when the caption came from the campaign's
 * Required field, "Campaign example" (Batch 14) when it is one of
 * the brief's example caption lines, "Auto-generated" when the
 * worker derived it from the clip's own transcript. Renders nothing
 * when the clip has no caption data at all (clips rendered before
 * this batch, or silent clips with no required caption).
 */
function PostCaptionCard({ clip }: { clip: JobClip }) {
  const title = clip.title_suggestion ?? clip.title
  const hashtags = Array.isArray(clip.hashtags) ? clip.hashtags : []
  const caption = clip.post_caption ?? ''
  if (!clip.title_suggestion && caption === '' && hashtags.length === 0) return null
  const required = clip.caption_source === 'required'
  const example = clip.caption_source === 'example'
  const allText = [title, caption, hashtags.join(' ')]
    .filter((p) => p !== '')
    .join('\n')
  return (
    <div className="w-full rounded-xl border border-ink-border bg-ink-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Post caption</h3>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
            required
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : example
                ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                : 'border-ink-border bg-ink-panel2 text-[var(--color-text-muted)]'
          }`}
        >
          {required ? 'Campaign required' : example ? 'Campaign example' : 'Auto-generated'}
        </span>
      </div>
      <p className="mt-3 min-w-0 break-words text-sm font-medium text-white">{title}</p>
      {caption !== '' ? (
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 break-words text-sm text-white/90">{caption}</p>
          <CopyButton text={caption} label="Copy caption" />
        </div>
      ) : null}
      {hashtags.length > 0 ? (
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 break-words text-sm text-brand-light">
            {hashtags.join(' ')}
          </p>
          <CopyButton text={hashtags.join(' ')} label="Copy hashtags" />
        </div>
      ) : null}
      {clip.ost_burned_text ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          On-screen text burned: <span className="font-medium text-white">{clip.ost_burned_text}</span>
        </p>
      ) : null}
      <div className="mt-3 flex justify-end">
        <CopyButton text={allText} label="Copy all" />
      </div>
    </div>
  )
}

/**
 * Batch 15: hook score badge (0–100, measured from the clip's first
 * 3 seconds — an estimate, never a promise of virality) + the
 * Loop-ready chip when the end was matched to the start frame.
 * Nothing renders for clips made before Batch 15.
 */
function hookBand(score: number): { label: string; className: string } {
  if (score >= 75) {
    return { label: 'Strong', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }
  }
  if (score >= 50) {
    return { label: 'OK', className: 'border-amber-500/40 bg-amber-500/10 text-amber-300' }
  }
  return { label: 'Weak', className: 'border-red-500/40 bg-red-500/10 text-red-300' }
}

function HookBadge({ clip }: { clip: JobClip }) {
  if (clip.hook_score == null) return null
  const band = hookBand(clip.hook_score)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${band.className}`}>
        Hook {clip.hook_score}/100 · {band.label}
      </span>
      {clip.loop_ready ? (
        <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-300">
          Loop-ready
        </span>
      ) : null}
      <span className="text-[11px] text-[var(--color-text-muted)]">
        estimate — measured from the clip&apos;s first 3 seconds
      </span>
      {clip.hook_reason ? (
        <span className="w-full text-xs text-[var(--color-text-muted)]">{clip.hook_reason}</span>
      ) : null}
    </div>
  )
}

/** Start seconds of every attention dip: score below 40 for 2+
 * consecutive seconds (max 3 listed). */
function retentionDropoffs(curve: number[]): number[] {
  const starts: number[] = []
  let run = 0
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] < 40) {
      run += 1
      if (run === 2) starts.push(i - 1)
    } else {
      run = 0
    }
  }
  return starts.slice(0, 3)
}

/**
 * Batch 15: retention curve sparkline (plain SVG, no new
 * dependency) + drop-off list. Per-second scores are estimates
 * from speech, audio energy and visual change — labelled as such.
 * Nothing renders for clips made before Batch 15.
 */
function RetentionSparkline({ curve }: { curve: number[] | null | undefined }) {
  if (!Array.isArray(curve) || curve.length === 0) return null
  const width = 240
  const height = 36
  const points = curve
    .map((v, i) => {
      const x = curve.length === 1 ? 0 : (i / (curve.length - 1)) * width
      const y = height - (Math.min(100, Math.max(0, v)) / 100) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const dropoffs = retentionDropoffs(curve)
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-white">Retention (estimated)</p>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1 block max-w-[240px]"
        role="img"
        aria-label="Estimated retention curve, one score per second"
      >
        <polyline points={points} fill="none" stroke="#34d399" strokeWidth="2" />
      </svg>
      {dropoffs.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {dropoffs.map((s) => (
            <li key={s} className="text-xs text-[var(--color-text-muted)]">
              {formatDuration(s)} — attention dip
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Batch 15: posted results — the user's own real numbers for this
 * clip, entered after posting. Every Save posts a new row; the
 * latest row is the current one. Empty state is honest: no numbers
 * are shown until the user types them in.
 */
function PostedResultsForm({ clip, onSaved }: { clip: JobClip; onSaved: () => void }) {
  const saved = clip.performance ?? null
  const [editing, setEditing] = useState(false)
  const [platform, setPlatform] = useState<'tiktok' | 'instagram'>('tiktok')
  const [views, setViews] = useState('')
  const [likes, setLikes] = useState('')
  const [comments, setComments] = useState('')
  const [shares, setShares] = useState('')
  const [postedAt, setPostedAt] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setPlatform(saved?.platform ?? 'tiktok')
    setViews(saved ? String(saved.views) : '')
    setLikes(saved ? String(saved.likes) : '')
    setComments(saved ? String(saved.comments) : '')
    setShares(saved ? String(saved.shares) : '')
    setPostedAt(saved?.posted_at ?? '')
    setNotes(saved?.notes ?? '')
    setError(null)
    setEditing(true)
  }

  const count = (v: string): number | null => {
    if (v.trim() === '') return 0
    if (!/^\d+$/.test(v.trim())) return null
    return Number(v.trim())
  }

  const save = async () => {
    const parsed = [count(views), count(likes), count(comments), count(shares)]
    if (parsed.some((n) => n === null)) {
      setError('Counts must be whole numbers (0 or more).')
      return
    }
    setSaving(true)
    setError(null)
    const result = await saveClipPerformance(clip.id, {
      platform,
      views: parsed[0] as number,
      likes: parsed[1] as number,
      comments: parsed[2] as number,
      shares: parsed[3] as number,
      posted_at: postedAt || null,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setEditing(false)
    onSaved()
  }

  const inputClass =
    'w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2 text-sm text-white'

  return (
    <div className="w-full rounded-xl border border-ink-border bg-ink-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Posted results</h3>
        {saved && !editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="rounded-lg border border-ink-border px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-panel2"
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">Platform</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as 'tiktok' | 'instagram')}
              className={inputClass}
            >
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['Views', views, setViews],
                ['Likes', likes, setLikes],
                ['Comments', comments, setComments],
                ['Shares', shares, setShares],
              ] as const
            ).map(([label, value, setValue]) => (
              <label key={label} className="block">
                <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">Posted date (optional)</span>
            <input
              type="date"
              value={postedAt}
              onChange={(e) => setPostedAt(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">Notes (optional)</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. posted in the evening"
              maxLength={500}
              className={inputClass}
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-red-300">{error}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-xl btn-aurora px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded-xl border border-ink-border px-4 py-2 text-sm font-semibold text-white hover:bg-ink-panel2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : saved ? (
        <div className="mt-3 space-y-1 text-sm text-white">
          <p>
            <span className="text-[var(--color-text-muted)]">
              {saved.platform === 'tiktok' ? 'TikTok' : 'Instagram'}
              {saved.posted_at ? ` · posted ${saved.posted_at}` : ''} —{' '}
            </span>
            {saved.views.toLocaleString()} views · {saved.likes.toLocaleString()} likes ·{' '}
            {saved.comments.toLocaleString()} comments · {saved.shares.toLocaleString()} shares
          </p>
          {saved.notes ? (
            <p className="text-xs text-[var(--color-text-muted)]">{saved.notes}</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-[var(--color-text-muted)]">
            No posted results yet — add the real numbers after you post this clip.
          </p>
          <button
            type="button"
            onClick={startEdit}
            className="mt-3 rounded-xl border border-ink-border px-4 py-2 text-sm font-semibold text-white hover:bg-ink-panel2"
          >
            Add results
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Batch 14: what the system read from the pasted brief — the
 * deterministic parse (CampaignBriefParser), shown with priority
 * (Required vs Optional). Only renders when the job has a parse
 * (jobs created before this batch show the Batch 12 "Settings used"
 * rail instead). Audio links are for posting time only — the worker
 * never downloads or mixes campaign audio, so the user adds the
 * official sound themselves when posting. The reference video was
 * analysed once during the run; its measured pacing/aspect are in
 * the job note.
 */
function ParsedBriefSection({
  parsed,
  appliedOst,
}: {
  parsed: CampaignParsed
  appliedOst: string | null
}) {
  const ostChoices = parsed.ost.choices
  const hasOst = ostChoices.length > 0
  const hasCaption = parsed.caption.verbatim !== null || parsed.caption.examples.length > 0
  const hasAudio = parsed.audio.links.length > 0
  const hasReference = parsed.reference_videos.length > 0
  const unparsedCount = parsed.unparsed.length
  if (!hasOst && !hasCaption && parsed.hashtags.length === 0 && !hasAudio && !hasReference && parsed.music_allowed && unparsedCount === 0) {
    return null
  }
  return (
    <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
      <h2 className="text-lg font-semibold text-white">What the system read from the brief</h2>
      {parsed.title ? (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">{parsed.title}</p>
      ) : null}
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Required items are followed strictly, optional items best-effort. The parser reads the
        standard campaign format — it does not understand free-form prose the way a person would.
      </p>
      <div className="mt-4 space-y-4">
        {hasOst ? (
          <div>
            <h3 className="text-sm font-semibold text-white">
              On-screen text{' '}
              <span className="text-xs font-medium text-emerald-300">
                {parsed.ost.required ? 'Required' : 'Optional'}
              </span>
            </h3>
            <ul className="mt-2 space-y-1">
              {ostChoices.map((choice) => (
                <li key={choice} className="flex items-start gap-2 text-sm text-white">
                  <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">•</span>
                  <span className="min-w-0 break-words">
                    {choice}
                    {appliedOst === choice ? (
                      <span className="ml-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                        Applied to every clip
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              The first choice is burned verbatim on every clip; any of the lines above is accepted
              by the checklist.
            </p>
          </div>
        ) : null}
        {hasCaption ? (
          <div>
            <h3 className="text-sm font-semibold text-white">
              Post caption{' '}
              <span className="text-xs font-medium text-emerald-300">
                {parsed.caption.required ? 'Required' : 'Optional'}
              </span>
            </h3>
            {parsed.caption.verbatim ? (
              <p className="mt-2 break-words text-sm text-white">{parsed.caption.verbatim}</p>
            ) : null}
            {parsed.caption.examples.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Example lines from the brief — rotated across clips:
                </p>
                <ul className="mt-1 space-y-1">
                  {parsed.caption.examples.map((example) => (
                    <li key={example} className="flex items-start gap-2 text-sm text-white">
                      <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">•</span>
                      <span className="min-w-0 break-words">{example}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
        {parsed.hashtags.length > 0 ? (
          <div>
            <h3 className="text-sm font-semibold text-white">
              Hashtags{' '}
              <span className="text-xs font-medium text-emerald-300">
                {parsed.hashtags_required ? 'Required' : 'Optional'}
              </span>
            </h3>
            <p className="mt-2 break-words text-sm text-brand-light">{parsed.hashtags.join(' ')}</p>
          </div>
        ) : null}
        {hasAudio ? (
          <div>
            <h3 className="text-sm font-semibold text-white">
              Official sound{' '}
              <span className="text-xs font-medium text-emerald-300">
                {parsed.audio.required ? 'Required' : 'Optional'}
              </span>
            </h3>
            <ul className="mt-2 space-y-2">
              {parsed.audio.links.map((link) => (
                <li key={link.url} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words text-sm text-white">
                    <span className="font-medium">{link.label}:</span>{' '}
                    <span className="text-[var(--color-text-muted)]">{link.url}</span>
                  </span>
                  <CopyButton text={link.url} label={`Copy ${link.label} link`} />
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Add this sound yourself when you post — clips are delivered without the campaign audio.
            </p>
          </div>
        ) : null}
        {!parsed.music_allowed ? (
          <p className="text-sm text-white">
            Background music:{' '}
            <span className="font-medium text-amber-300">NOT ALLOWED by the brief</span>
            {' — no music bed was mixed into these clips.'}
          </p>
        ) : null}
        {hasReference ? (
          <div>
            <h3 className="text-sm font-semibold text-white">Reference video</h3>
            <ul className="mt-2 space-y-1">
              {parsed.reference_videos.map((url) => (
                <li key={url} className="break-words text-sm text-[var(--color-text-muted)]">
                  {url}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Analysed once during the run — see the job note for the measured pacing and aspect.
              Only measurable style signals are matched; creative choices cannot be copied by code.
            </p>
          </div>
        ) : null}
        {unparsedCount > 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            {unparsedCount} line{unparsedCount === 1 ? '' : 's'} from the brief could not be read
            automatically — {unparsedCount === 1 ? 'it is' : 'they are'} a manual check below.
          </p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Batch 12: the campaign section — the compliance banner, the
 * server-computed checklist, the manual brief checks, and the
 * job-level caption actions. Only campaign jobs render it. The
 * checklist appears once the job completes; the manual checks are
 * tickable from job creation (they are the visual / subjective
 * rules the worker cannot verify — the honest limit is stated in
 * the copy below, not hidden).
 */
function CampaignSection({
  job,
  onJobUpdated,
}: {
  job: Job
  onJobUpdated: (job: Job) => void
}) {
  const s = job.settings
  const [checks, setChecks] = useState<ManualCheck[]>(job.campaign_manual_checks ?? [])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    setChecks(job.campaign_manual_checks ?? [])
  }, [job.campaign_manual_checks])

  if (!s || s.job_type !== 'campaign') return null
  const checklist = job.campaign_checklist ?? null
  const failedAuto = checklist && !checklist.all_passed ? checklist.failed_count : 0
  const pendingManual = checks.filter((c) => !c.checked).length
  const failedTotal = failedAuto + pendingManual
  const readyOriginals = job.clips.filter(
    (c) => c.variant_of_clip_id == null && c.status === 'ready',
  )
  const hasCaptionData = readyOriginals.some(
    (c) =>
      (c.post_caption ?? '') !== '' ||
      (Array.isArray(c.hashtags) && c.hashtags.length > 0) ||
      c.title_suggestion != null,
  )
  const captionsText = readyOriginals
    .map((c) =>
      [c.title_suggestion ?? c.title, c.post_caption ?? '', (c.hashtags ?? []).join(' ')]
        .filter((p) => p !== '')
        .join('\n'),
    )
    .join('\n\n')
  const downloadCaptions = () => {
    const blob = new Blob([`Job #${job.id} — Post captions\n\n${captionsText}\n`], {
      type: 'text/plain',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `job-${job.id}-captions.txt`
    a.click()
    URL.revokeObjectURL(url)
  }
  const toggleCheck = async (id: string) => {
    const next = checks.map((c) => (c.id === id ? { ...c, checked: !c.checked } : c))
    setChecks(next)
    setSavingId(id)
    setCheckError(null)
    const result = await updateCampaignChecks(job.id, next)
    setSavingId(null)
    if (!result.ok) {
      setChecks(checks)
      setCheckError(result.error)
      return
    }
    onJobUpdated(result.job)
  }

  return (
    <div className="space-y-4">
      {s.campaign_parsed ? (
        <ParsedBriefSection parsed={s.campaign_parsed} appliedOst={s.campaign_ost ?? null} />
      ) : null}
      {job.status === 'ready' && failedTotal > 0 ? (
        <div
          role="alert"
          className="rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            {failedAuto > 0
              ? `${failedAuto} required cheez miss ho rahi hai — submit karne se pehle check karein`
              : `${pendingManual} manual check${pendingManual === 1 ? '' : 's'} baaki hai — submit karne se pehle tick karein`}
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            {failedAuto > 0 && pendingManual > 0
              ? `The checklist below names exactly what is missing. Plus ${pendingManual} manual check${pendingManual === 1 ? '' : 's'} still need${pendingManual === 1 ? 's' : ''} your eyes.`
              : failedAuto > 0
                ? 'The checklist below names exactly what is missing.'
                : 'The auto-checks all pass — the remaining items need your eyes, not the worker.'}
          </p>
        </div>
      ) : null}

      <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="text-lg font-semibold text-white">Campaign checklist</h2>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Auto-checks verify TEXT items only — the required caption, hashtags and on-screen text,
          compared against what the worker actually applied. Visual / subjective rules (jaise
          &lsquo;laptop dikhana hai&rsquo;, &lsquo;Stokes Twins hone chahiye&rsquo;) the worker detect
          nahi kar sakta — unhe neeche manually tick karein.
        </p>
        {checklist ? (
          <ul className="mt-4 space-y-3">
            {checklist.items.map((item) => (
              <li key={item.key} className="flex items-start gap-3 rounded-xl bg-ink-panel2 p-3">
                {item.passed ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">
                    {item.label}{' '}
                    <span className={item.passed ? 'text-emerald-300' : 'text-red-300'}>
                      {item.passed ? '✓ Pass' : '✗ Fail'}
                    </span>
                  </p>
                  <p className="mt-0.5 break-words text-xs text-[var(--color-text-muted)]">
                    Required:{' '}
                    <span className="font-medium text-white">
                      {Array.isArray(item.required) ? item.required.join(' ') : item.required}
                    </span>
                  </p>
                  <p className="mt-0.5 break-words text-xs text-[var(--color-text-muted)]">
                    {item.note}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-text-muted)]">
            {job.status === 'ready'
              ? 'No required campaign items on this job — nothing to check.'
              : 'The checklist appears here once the job completes.'}
          </p>
        )}
        {checks.length > 0 ? (
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-white">Manual checks — from the brief</h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Tick each line once you have checked it by eye on the clips.
            </p>
            <ul className="mt-3 space-y-2">
              {checks.map((check) => (
                <li key={check.id} className="flex items-start gap-3 rounded-xl bg-ink-panel2 p-3">
                  <input
                    type="checkbox"
                    checked={check.checked}
                    disabled={savingId === check.id}
                    onChange={() => void toggleCheck(check.id)}
                    aria-label={`Manual check: ${check.text}`}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-fuchsia-500"
                  />
                  <span
                    className={`min-w-0 flex-1 break-words text-sm ${
                      check.checked ? 'text-[var(--color-text-muted)] line-through' : 'text-white'
                    }`}
                  >
                    {check.text}
                  </span>
                  {savingId === check.id ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-light" />
                  ) : null}
                </li>
              ))}
            </ul>
            {checkError ? (
              <p role="alert" className="mt-2 text-xs text-red-300">
                {checkError}
              </p>
            ) : null}
          </div>
        ) : null}
        {job.status === 'ready' && hasCaptionData ? (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-ink-border/60 pt-4">
            <CopyButton text={captionsText} label="Copy all captions" />
            <button
              type="button"
              onClick={downloadCaptions}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-border px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-ink-panel2"
            >
              <Download className="h-3.5 w-3.5" />
              Download captions (.txt)
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const jobId = Number(id)
  const { user, loading: authLoading } = useAuth()
  // Batch 10 (2026-11-25): platform gating — a feature is off ONLY
  // when the payload says so (`=== false`); loading/unavailable
  // renders everything unchanged.
  const { platform } = usePlatform()
  const rerenderOff = platform?.features.clip_rerender === false
  const favouritesOff = platform?.features.favourites === false
  const thumbnailPickerOff = platform?.features.thumbnail_picker === false
  const { projects, updateProject } = useProjects()
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [acting, setActing] = useState<'cancel' | 'retry' | null>(null)
  const [downloadingId, setDownloadingId] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [audioDownloadingId, setAudioDownloadingId] = useState<number | null>(null)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [previewingClip, setPreviewingClip] = useState<JobClip | null>(null)
  // Batch 9: bulk re-render selection (checkboxes on the clip cards).
  const [selectedClips, setSelectedClips] = useState<ReadonlySet<number>>(new Set())
  const toggleClipSelected = (id: number) =>
    setSelectedClips((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const requestRef = useRef(0)

  const fetchJob = useCallback(async () => {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      setError('That job id is not valid.')
      setLoading(false)
      return
    }
    const reqId = ++requestRef.current
    const result = await getJob(jobId)
    if (reqId !== requestRef.current) return // stale response
    if (!result.ok) {
      setError(result.error)
    } else {
      setJob(result.job)
      setError(null)
    }
    setLoading(false)
  }, [jobId])

  useEffect(() => {
    requestRef.current += 1
    setJob(null)
    setError(null)
    setLoading(true)
    void fetchJob()
  }, [fetchJob])

  // Poll every 5s while the job is still running; stop on terminal states.
  useEffect(() => {
    if (!job) return
    if (job.status !== 'queued' && job.status !== 'processing') return
    const timer = setInterval(() => void fetchJob(), POLL_MS)
    return () => clearInterval(timer)
  }, [job?.status, fetchJob])

  // When the job reaches a terminal state, refresh its project's status
  // in the store so Dashboard / My Projects flip without a reload. The
  // status guard makes this a no-op once the store already agrees.
  useEffect(() => {
    if (!job) return
    if (job.status !== 'ready' && job.status !== 'failed') return
    const project = projects.find((p) => p.laravelId === job.project_id)
    if (!project) return
    const next = mapLaravelStatus(job.status)
    if (project.status !== next) updateProject(project.id, { status: next })
  }, [job, projects, updateProject])

  const doCancel = async () => {
    if (!job) return
    if (!window.confirm(`Cancel job #${job.id}? The worker stops and any unfinished clips are discarded.`)) return
    setActing('cancel')
    setActionError(null)
    const result = await cancelJob(job.id)
    setActing(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setJob(result.job)
  }

  const doRetry = async () => {
    if (!job) return
    setActing('retry')
    setActionError(null)
    const result = await retryJob(job.id)
    setActing(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setJob(result.job)
  }

  const doDownload = async (clip: JobClip) => {
    setDownloadingId(clip.id)
    setDownloadError(null)
    const result = await downloadClip(clip)
    setDownloadingId(null)
    if (!result.ok) setDownloadError(result.error)
  }

  const doDownloadAudio = async (clip: JobClip) => {
    setAudioDownloadingId(clip.id)
    setAudioError(null)
    const result = await downloadClipAudio(clip)
    setAudioDownloadingId(null)
    if (!result.ok) setAudioError(result.error)
  }

  // While the stored session is still being verified, show a loading
  // state — never the sign-in prompt for a signed-in user.
  if (authLoading) {
    return (
      <div>
        <PageHeader title="Job" subtitle="Checking sign-in…" />
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
        <PageHeader title="Job" subtitle="Job detail." />
        <EmptyState
          title="Sign in to view this job"
          description="Jobs are tied to your account. Sign in to see this job and its clips."
          action={
            <Link
              to="/login"
              className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          }
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Job" subtitle="Loading…" />
        <div className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-6 text-sm text-white">
          <Loader2 className="h-5 w-5 animate-spin text-brand-light" />
          Loading job #{Number.isInteger(jobId) ? jobId : id}…
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div>
        <PageHeader title="Job not found" subtitle="This job could not be loaded." />
        <EmptyState
          title="Job not found"
          description={error ?? 'This job does not exist or belongs to another account.'}
          action={
            <Link
              to="/jobs"
              className="rounded-xl btn-aurora px-5 py-2.5 text-sm font-semibold text-white"
            >
              Back to My Jobs
            </Link>
          }
        />
      </div>
    )
  }

  const isActive = job.status === 'queued' || job.status === 'processing'
  const isTerminal = job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled'
  const hasProgress = typeof job.progress === 'number'

  // Batch 9: Variant B clips render directly after their Variant A
  // (originals best-viral-score first, variants in id order). A
  // variant whose parent is missing still shows, at the end, instead
  // of vanishing.
  const orderedClips = (() => {
    const originals = [...job.clips]
      .filter((c) => c.variant_of_clip_id == null)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    const ordered = originals.flatMap((o) => [
      o,
      ...job.clips
        .filter((v) => v.variant_of_clip_id === o.id)
        .sort((a, b) => a.id - b.id),
    ])
    const seen = new Set(ordered.map((c) => c.id))
    ordered.push(...job.clips.filter((c) => !seen.has(c.id)))
    return ordered
  })()

  return (
    <div>
      <PageHeader
        title={`Job #${job.id}`}
        subtitle={jobSummary(job)}
        actions={
          <Link
            to="/jobs"
            className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
          >
            <ArrowLeft className="h-4 w-4" /> All jobs
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Status */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <JobStatusPill status={job.status} />
                {job.intro_applied || job.outro_applied ? (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                    {job.intro_applied && job.outro_applied
                      ? 'Intro + outro applied'
                      : job.intro_applied
                        ? 'Intro applied'
                        : 'Outro applied'}
                  </span>
                ) : null}
                {isActive ? (
                  <span className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin text-brand-light" />
                    Updating every 5s
                  </span>
                ) : null}
              </div>
              <div className="flex gap-2">
                {!isTerminal ? (
                  <button
                    type="button"
                    onClick={() => void doCancel()}
                    disabled={acting !== null}
                    className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acting === 'cancel' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                    Cancel job
                  </button>
                ) : null}
                {job.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => void doRetry()}
                    disabled={acting !== null}
                    className="flex items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {acting === 'retry' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Retry job
                  </button>
                ) : null}
                <Link
                  to={`/clipper?clone=${job.id}`}
                  title="Copy this job's settings into a new job. You will pick the video again — the old source is not reused."
                  className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-border"
                >
                  <Copy className="h-4 w-4" />
                  Clone job
                </Link>
              </div>
            </div>

            {job.stage ? (
              <p className="mt-4 text-sm text-white">
                Stage: <span className="font-semibold">{job.stage}</span>
              </p>
            ) : null}
            {hasProgress ? (
              <div className="mt-3">
                <div
                  className="h-2 overflow-hidden rounded-full bg-ink-panel2"
                  role="progressbar"
                  aria-valuenow={job.progress ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="progress-shimmer h-full rounded-full bg-gradient-to-r from-[#7c3aed] via-[#d946ef] to-[#22d3ee] transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, job.progress ?? 0))}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {job.progress}% — reported by the worker, not estimated.
                </p>
              </div>
            ) : isActive ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                The worker has not reported a measurable percentage for this
                stage yet — showing the stage only, no estimated progress.
              </p>
            ) : null}

            {/* Batch 11: queue position + estimated wait (refreshes
                with the 5s poll while the job is queued/processing). */}
            {(job.status === 'queued' || job.status === 'processing') && job.queue ? (
              <div className="mt-4 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
                <QueueInfo queue={job.queue} />
                {job.queue.status === 'queued' && job.queue.note ? (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{job.queue.note}</p>
                ) : null}
              </div>
            ) : null}

            {job.status === 'failed' ? (
              <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
                  <AlertTriangle className="h-4 w-4" /> This job failed
                </p>
                {job.error_code ? (
                  <p className="mt-2 text-xs text-red-200/70">Error code: {job.error_code}</p>
                ) : null}
                <p className="mt-1 break-words text-sm text-red-200/90">
                  {job.error_message ?? 'No failure reason was reported.'}
                </p>
                <p className="mt-2 text-xs text-red-200/70">
                  Your source and settings are preserved — retry re-queues the
                  same job.
                </p>
              </div>
            ) : null}

            {job.status === 'cancelled' ? (
              <p className="mt-4 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3 text-sm text-[var(--color-text-muted)]">
                This job was cancelled. Create a new job to try again with the
                same settings.
              </p>
            ) : null}

            {job.note ? (
              <div
                role="note"
                className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                  <AlertTriangle className="h-4 w-4" /> A note from the worker
                </p>
                <p className="mt-1 text-sm text-amber-200/90">{job.note}</p>
              </div>
            ) : null}

            {actionError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {actionError}
              </p>
            ) : null}

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Created', formatTime(job.created_at)],
                ['Started', formatTime(job.started_at)],
                ['Finished', formatTime(job.finished_at)],
                ['Clips', `${job.clips.length} of ${job.settings?.clip_count ?? '?'}`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-ink-panel2 p-3">
                  <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="mt-1 break-words text-sm font-medium text-white">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Batch 12: campaign checklist + banner + manual checks. */}
          <CampaignSection job={job} onJobUpdated={setJob} />

          {/* Batch 4: title + hashtag suggestions from this job's own
              transcript (or the honest "no speech" line). */}
          <SuggestionsCard job={job} />

          {/* Clips — best viral score first so the strongest clip is on top */}
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Film className="h-5 w-5 text-brand-light" />
              Clips ({job.clips.length})
            </h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Viral score is an estimate from each clip&apos;s speech, gameplay, energy and scene
              signals — not a guarantee it will go viral.
            </p>
            {job.settings?.clip_count != null &&
            job.clips.length > 0 &&
            job.clips.length < job.settings.clip_count ? (
              <p className="mt-2 text-xs text-amber-300">
                Only {job.clips.length} of {job.settings.clip_count} requested clips fit this
                source — the rest had no usable speech or would overlap a clip already picked.
                Shorter clips or a longer, talk-heavy source fits more.
              </p>
            ) : null}
            {selectedClips.size > 0 && !rerenderOff ? (
              <BulkRerenderBar
                clipIds={[...selectedClips]}
                onDone={() => void fetchJob()}
              />
            ) : null}
            {job.clips.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                {job.status === 'ready'
                  ? 'The job is marked ready but no clips were returned. Check again in a moment — if it stays empty, the worker may have finished without uploading clips.'
                  : isActive
                    ? 'No clips yet — they appear here as the worker renders and validates them.'
                    : 'No clips were produced for this job.'}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {orderedClips
                  .map((clip) => {
                    const viral = viralScore(clip.score)
                    return (
                  <li
                    key={clip.id}
                    className="aurora-card flex flex-wrap items-center gap-4 rounded-xl border border-ink-border bg-ink-panel2 p-4"
                  >
                    {rerenderOff ? null : (
                      <input
                        type="checkbox"
                        checked={selectedClips.has(clip.id)}
                        onChange={() => toggleClipSelected(clip.id)}
                        aria-label={`Select ${clip.title} for bulk re-render`}
                        className="h-4 w-4 shrink-0 accent-fuchsia-500"
                      />
                    )}
                    <ClipThumbnail
                      clipId={clip.id}
                      hasThumbnail={clip.thumbnail_path != null}
                      alt={`First frame of ${clip.title}`}
                      className="h-24 w-14 shrink-0 rounded-xl object-cover"
                    />
                    <div
                      className={`flex shrink-0 flex-col items-center rounded-xl border px-3 py-2 ${VIRAL_TONE_CLASS[viral.tone]}`}
                      title="Viral score — estimate from speech, gameplay, energy and scene signals"
                    >
                      <span className="text-xl font-bold leading-none">
                        {viral.value ?? '—'}
                      </span>
                      <span className="mt-1 max-w-24 text-center text-[10px] leading-tight">
                        {viral.value != null ? 'Viral score' : viral.label}
                      </span>
                    </div>
                    <div className="min-w-[15rem] flex-1">
                      <p className="truncate font-semibold text-white">
                        {clip.title}
                        {clip.variant_of_clip_id != null ? (
                          <span className="ml-2 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 align-middle text-[10px] font-semibold text-fuchsia-300">
                            Variant B
                          </span>
                        ) : null}
                      </p>
                      {viral.value != null ? (
                        <p className="mt-0.5 text-xs font-medium text-[var(--color-text-muted)]">
                          {viral.label}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                        {clip.duration_seconds != null
                          ? `${formatDuration(clip.duration_seconds)} · `
                          : ''}
                        {clip.aspect_ratio ? `${clip.aspect_ratio} · ` : ''}
                        {clip.file_size_bytes != null ? formatBytes(clip.file_size_bytes) : 'Size unknown'}
                        {clip.start_seconds != null && clip.end_seconds != null
                          ? ` · ${formatDuration(clip.start_seconds)}–${formatDuration(clip.end_seconds)} in source`
                          : ''}
                      </p>
                      {clip.reason ? (
                        <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">{clip.reason}</p>
                      ) : null}
                      {clip.transcript_excerpt ? (
                        <p className="mt-1 line-clamp-2 text-xs italic text-[var(--color-text-muted)]">
                          “{clip.transcript_excerpt}”
                        </p>
                      ) : null}
                      <ScoreBreakdown breakdown={clip.score_breakdown} />
                      {/* Batch 15: hook score + retention curve (both
                          estimates) and the loop-ready chip. */}
                      <HookBadge clip={clip} />
                      <RetentionSparkline curve={clip.retention_curve} />
                      <ViralChecklist clip={clip} job={job} />
                      {/* Batch 13: the grade this clip actually
                          rendered with. Auto carries the picker's
                          reason; a manual look is the "chosen look";
                          'none' shows Off. Old clips (pre-Batch 13)
                          fall back to the job's setting. */}
                      {clip.colour_grade_applied ? (
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          Colour grade: {COLOUR_GRADE_LABELS[clip.colour_grade_applied as ColourGrade] ?? clip.colour_grade_applied}
                          {clip.colour_grade_reason ? ` — ${clip.colour_grade_reason}` : ' (chosen look)'}
                        </p>
                      ) : job.settings?.colour_grade && job.settings.colour_grade !== 'none' ? (
                        job.settings.colour_grade === 'auto' ? (
                          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                            Colour grade: Auto — grade not recorded for this clip
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                            Colour grade: {COLOUR_GRADE_LABELS[job.settings.colour_grade as ColourGrade] ?? job.settings.colour_grade} (chosen look)
                          </p>
                        )
                      ) : (
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          Colour grade: Off
                        </p>
                      )}
                    </div>
                    {/* Batch 10: re-render (single + variant) is hidden
                        with an honest note when clip re-render is off. */}
                    {rerenderOff ? (
                      <p className="mt-3 w-full text-xs text-[var(--color-text-muted)]">
                        Clip re-render is disabled by the admin.
                      </p>
                    ) : (
                      <>
                        <ClipRerenderControl
                          clip={clip}
                          onRerendered={() => void fetchJob()}
                        />
                        {clip.variant_of_clip_id == null ? (
                          <ClipVariantControl
                            clip={clip}
                            onVariantReady={() => void fetchJob()}
                          />
                        ) : null}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setPreviewingClip(clip)}
                      className="flex shrink-0 items-center gap-2 rounded-xl border border-ink-border px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-panel2"
                    >
                      <Play className="h-4 w-4" />
                      Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => void doDownload(clip)}
                      disabled={downloadingId === clip.id}
                      className="flex shrink-0 items-center gap-2 rounded-xl btn-aurora px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {downloadingId === clip.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {downloadingId === clip.id ? 'Downloading…' : 'Download'}
                    </button>
                    {clip.status === 'ready' ? (
                      <button
                        type="button"
                        onClick={() => void doDownloadAudio(clip)}
                        disabled={audioDownloadingId === clip.id}
                        className="flex shrink-0 items-center gap-2 rounded-xl border border-ink-border px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink-panel2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {audioDownloadingId === clip.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Music className="h-4 w-4" />
                        )}
                        {audioDownloadingId === clip.id ? 'Downloading…' : 'Audio'}
                      </button>
                    ) : null}
                    {/* Batch 10: favourite hearts are hidden when
                        favourites are off. */}
                    {favouritesOff ? null : (
                      <ClipFavouriteButton clip={clip} onChanged={() => void fetchJob()} />
                    )}
                    {/* Batch 10: thumbnail picker hidden when off. */}
                    {thumbnailPickerOff ? null : (
                      <div className="w-full border-t border-ink-border/60 pt-3">
                        <ClipThumbnailPicker clip={clip} onChanged={() => void fetchJob()} />
                      </div>
                    )}
                    {/* Batch 12: per-clip attached post caption. */}
                    <PostCaptionCard clip={clip} />
                    {/* Batch 15: user-entered posted results. */}
                    <PostedResultsForm clip={clip} onSaved={() => void fetchJob()} />
                  </li>
                    )
                  })}
              </ul>
            )}
            {downloadError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                Download failed: {downloadError}
              </p>
            ) : null}
            {audioError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                Audio download failed: {audioError}
              </p>
            ) : null}
            {previewingClip ? (
              <ClipPlayerModal
                clip={previewingClip}
                onClose={() => setPreviewingClip(null)}
              />
            ) : null}
          </section>
        </div>

        {/* Right rail — source + exact settings */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Source</h2>
            {job.source_type === 'link' && job.source_url ? (
              <a
                href={job.source_url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block break-all text-sm text-brand-light hover:underline"
              >
                {job.source_url}
              </a>
            ) : (
              <p className="mt-3 text-sm text-white">Uploaded video file</p>
            )}
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Project #{job.project_id} · Job #{job.id} · internal state “{job.state}”
            </p>
          </div>

          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="text-lg font-semibold text-white">Settings used</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {settingRows(job).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-[var(--color-text-muted)]">{label}</dt>
                  <dd className="break-words text-right font-medium text-white">{value}</dd>
                </div>
              ))}
            </dl>
            {settingRows(job).length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-text-muted)]">
                The server did not return settings for this job.
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}
