/**
 * Job API client — Magician Clipper Phase 3 (New Job UI).
 *
 * Builds strictly against docs/api.md (the Phase 3 Job System contract):
 *   POST /api/v1/jobs        create a job (file OR link + dropdown settings)
 *   GET  /api/v1/jobs        list my jobs (paginated, `status` filter)
 *   GET  /api/v1/jobs/{id}   get one job — poll this for status + clips
 *   POST /api/v1/jobs/{id}/cancel
 *   POST /api/v1/jobs/{id}/retry
 *   GET  /api/v1/clips/{clip}/download   (via the clip's download_url)
 *
 * No mock data: every function hits the real Laravel backend and surfaces
 * the backend's exact error message on failure. Auth is the Sanctum
 * bearer token from lib/api (getToken).
 *
 * NOTE: the clip download_url is an absolute backend URL that requires
 * the bearer token, so downloads go through fetch + blob, not a plain
 * <a href> (a plain link would send no Authorization header and 401).
 */

import { API_URL, getToken, unreachableMessage } from './api'

export type JobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'

/** Clip layout (Batch 13: per-ratio — the six canvas-agnostic
 * layouts render on every ratio; the four vertical compositions
 * render on portrait frames, 9:16 and 4:5, only).
 * Batch 9 (2026-11-25): five more layouts — gradient_fill, stacked,
 * letterbox, face_closeup, framed. Single source of truth: the wizard
 * picker, JobDetail "Settings used", and the backend validation all
 * read this list (the worker has its own matching branches). */
export type ClipLayout =
  | 'center_crop'
  | 'split'
  | 'pip_facecam'
  | 'blur_fill'
  | 'streamer_full'
  | 'gradient_fill'
  | 'stacked'
  | 'letterbox'
  | 'face_closeup'
  | 'framed'

/** Which layouts genuinely render on each canvas (Batch 13).
 * The wizard shows only these per ratio; the worker falls back to
 * centre crop for anything else instead of faking it. */
export const LAYOUTS_BY_ASPECT: Record<string, ClipLayout[]> = {
  '9:16': [
    'center_crop', 'blur_fill', 'gradient_fill', 'letterbox',
    'face_closeup', 'framed', 'split', 'pip_facecam', 'streamer_full', 'stacked',
  ],
  '4:5': [
    'center_crop', 'blur_fill', 'gradient_fill', 'letterbox',
    'face_closeup', 'framed', 'split', 'pip_facecam', 'streamer_full', 'stacked',
  ],
  '16:9': ['center_crop', 'blur_fill', 'gradient_fill', 'letterbox', 'face_closeup', 'framed'],
  '1:1': ['center_crop', 'blur_fill', 'gradient_fill', 'letterbox', 'face_closeup', 'framed'],
}

export function layoutAllowedForAspect(layout: ClipLayout, aspect: string): boolean {
  return (LAYOUTS_BY_ASPECT[aspect] ?? LAYOUTS_BY_ASPECT['16:9']).includes(layout)
}

export const LAYOUT_LABELS: Record<ClipLayout, string> = {
  center_crop: 'Centre crop (full frame)',
  split: 'Split — streamer top, gameplay bottom',
  pip_facecam: 'Gameplay full + facecam corner',
  blur_fill: 'Blurred background fill',
  streamer_full: 'Streamer full frame',
  gradient_fill: 'Gradient fill — video centred on a smooth gradient',
  stacked: 'Podcast stack — video top, dark panel below',
  letterbox: 'Letterbox — cinematic black bars',
  face_closeup: 'Face close-up — tight crop following the speaker',
  framed: 'Framed — video inset with a clean border',
}

/** How clips are picked from the source (per job). */
export type SelectionMode = 'interesting_only' | 'fill_any'

export const SELECTION_MODE_LABELS: Record<SelectionMode, string> = {
  interesting_only: 'Interesting only',
  fill_any: 'Any parts — fill to count',
}

export const SELECTION_MODE_DESCRIPTIONS: Record<SelectionMode, string> = {
  interesting_only: 'Only the best parts — fewer clips if fewer good parts exist.',
  fill_any:
    'Always the full count — fills with any part of the video when good parts run out.',
}

/** On-screen headline look (Batch 2, 2026-11-25). */
export type HeadlineStyle = 'bold_bar' | 'lower_third' | 'big_centre'

export const HEADLINE_STYLE_LABELS: Record<HeadlineStyle, string> = {
  bold_bar: 'Bold bar (top)',
  lower_third: 'Lower third (bottom)',
  big_centre: 'Big centre',
}

export const HEADLINE_STYLE_DESCRIPTIONS: Record<HeadlineStyle, string> = {
  bold_bar: 'The current look — bold white text on a dark bar at the top.',
  lower_third: 'A band along the bottom, below the captions.',
  big_centre: 'Large centred text in the middle of the frame.',
}

/** Short "Best for: …" line per headline style, our own words (Batch 8). */
export const HEADLINE_STYLE_BEST_FOR: Record<HeadlineStyle, string> = {
  bold_bar: 'Strong hooks that must read at a glance',
  lower_third: 'Interviews and talking-head clips',
  big_centre: 'Bold statements and title moments',
}

/** Where the burn-in captions sit (Batch 2, 2026-11-25). */
export type CaptionPosition = 'bottom' | 'top' | 'middle'

export const CAPTION_POSITION_LABELS: Record<CaptionPosition, string> = {
  bottom: 'Bottom',
  top: 'Top',
  // Batch 9: the UI label is "Centre" (the user's word); the stored
  // value stays "middle" — only the label changed, never the value.
  middle: 'Centre',
}

/** OST position — WHERE the headline sits (Batch 9, 2026-11-25).
 * Independent of headline_style (the LOOK). Defaults derive from
 * the style server-side: bold_bar -> top, lower_third -> bottom,
 * big_centre -> centre. */
export type OstPosition = 'top' | 'centre' | 'bottom'

export const OST_POSITION_LABELS: Record<OstPosition, string> = {
  top: 'Top',
  centre: 'Centre',
  bottom: 'Bottom',
}

export function defaultOstPosition(headlineStyle: HeadlineStyle): OstPosition {
  return headlineStyle === 'lower_third'
    ? 'bottom'
    : headlineStyle === 'big_centre'
      ? 'centre'
      : 'top'
}

/** Sound-effect sting over clip cuts (Batch 9, 2026-11-25). */
export type Sfx = 'none' | 'whoosh' | 'pop' | 'whoosh_pop'

export const SFX_LABELS: Record<Sfx, string> = {
  none: 'None',
  whoosh: 'Whoosh',
  pop: 'Pop',
  whoosh_pop: 'Whoosh + Pop',
}

/** Per-job colour grade (Batch 9, 2026-11-25; Batch 13 added 'auto'
 * as the default plus clean / mono / vintage). The worker applies
 * the grade as a video filter on the final render only; 'none'
 * adds no filter — the render pipeline is untouched. 'auto' means
 * the worker analyses each clip and picks the look that suits it.
 * No preview is shown in the UI; the dropdown only selects the
 * grade. Grading improves the LOOK — it does not add resolution or
 * fix blur; the source is the ceiling. */
export type ColourGrade =
  | 'auto'
  | 'none'
  | 'clean'
  | 'vibrant'
  | 'warm'
  | 'cool'
  | 'cinematic'
  | 'mono'
  | 'vintage'

export const COLOUR_GRADE_LABELS: Record<ColourGrade, string> = {
  auto: 'Auto (per clip)',
  clean: 'Clean',
  vibrant: 'Vibrant',
  warm: 'Warm',
  cool: 'Cool',
  cinematic: 'Cinematic',
  mono: 'Mono',
  vintage: 'Vintage',
  none: 'Off',
}

/** One-line description per grade, shown under the wizard selector. */
export const COLOUR_GRADE_DESCRIPTIONS: Record<ColourGrade, string> = {
  auto: 'Analyses each clip and picks the grade that suits it — dark clips get brightened, washed-out clips get punch, colour casts get corrected.',
  clean: 'Gentle lift: a touch brighter, a touch more contrast and colour. The safe enhance.',
  vibrant: 'Stronger saturation and contrast — makes flat, washed-out footage pop.',
  warm: 'Warms the picture up — good for cool, blue-ish footage.',
  cool: 'Cools the picture down — good for overly warm, yellow-ish footage.',
  cinematic: 'Teal-orange style: deeper contrast, muted colour, slightly darker.',
  mono: 'Black & white, with a little extra contrast.',
  vintage: 'Faded and warm — an old-film feel.',
  none: 'No colour grade — the render is left exactly as shot.',
}

/** Headline entrance animation (Batch 7, 2026-11-25). Applies to the
 * on-screen headline only — 'none' is the pre-Batch-7 behaviour. */
export type OstAnimation = 'none' | 'slide' | 'fade' | 'pop'

export const OST_ANIMATION_LABELS: Record<OstAnimation, string> = {
  none: 'None',
  slide: 'Slide in',
  fade: 'Fade in',
  pop: 'Pop in',
}

export const OST_ANIMATION_DESCRIPTIONS: Record<OstAnimation, string> = {
  none: 'The headline appears instantly, as before.',
  slide: 'The headline slides into place over its first 0.3s.',
  fade: 'The headline fades in over its first 0.3s.',
  pop: 'The headline pops in from 60% size over its first 0.15s.',
}

/** Output languages for caption + headline translation (Batch 9,
 * 2026-11-25). MyMemory ISO 639-1 codes (zh-CN for Simplified
 * Chinese). A code MyMemory does not support falls back honestly —
 * the segment keeps its original text and the job note says so. */
export const TRANSLATION_LANGUAGES = {
  en: 'English',
  ur: 'Urdu',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ar: 'Arabic',
  tr: 'Turkish',
  id: 'Indonesian',
  bn: 'Bengali',
  pa: 'Punjabi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  mr: 'Marathi',
  gu: 'Gujarati',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  th: 'Thai',
  fa: 'Persian',
  ps: 'Pashto',
  sd: 'Sindhi',
  ne: 'Nepali',
  si: 'Sinhala',
} as const

export type TranslationLanguageCode = keyof typeof TRANSLATION_LANGUAGES

/** Captions auto-translate target (Batch 3, 2026-11-25; broadened
 * Batch 9). 'none' means the captions stay in the transcript's
 * original language. */
export type CaptionTranslation = 'none' | TranslationLanguageCode

export const CAPTION_TRANSLATION_LABELS: Record<CaptionTranslation, string> = {
  none: 'None (original language)',
  ...TRANSLATION_LANGUAGES,
}

/** On-screen headline language (Batch 9, 2026-11-25). 'source'
 * means the headline stays in the video's own language (today's
 * behaviour); any other value translates the DERIVED headline
 * (campaign verbatim first, else the transcript headline) through
 * the same MyMemory path as captions. The end-card text and
 * lower-third tag are the user's own words and are never
 * translated; keyword pop-ups match the spoken words and are
 * never translated either. */
export type OstLanguage = 'source' | TranslationLanguageCode

export const OST_LANGUAGE_LABELS: Record<OstLanguage, string> = {
  source: 'Source language',
  ...TRANSLATION_LANGUAGES,
}

/** Transcription/source language for captions (Batch 3) — which
 * language the speech is in. This is NOT the output language: the
 * output language is caption_translation / ost_language. */
export const CAPTION_LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'english', label: 'English' },
  { id: 'roman_urdu', label: 'Roman Urdu' },
  { id: 'hindi', label: 'Hindi' },
] as const

/** Ratios a job renders in (Batch 3, 2026-11-25). 9:16 is always on;
 * 1:1 and 16:9 are optional extras — the same clips in each ratio. */
export const EXPORT_RATIO_OPTIONS = ['9:16', '1:1', '16:9'] as const

export interface JobSettings {
  platform: 'tiktok' | 'instagram'
  aspect_ratio: '9:16' | '16:9' | '1:1' | '4:5'
  clip_count: number
  duration_mode: 'exact' | 'minimum' | 'maximum'
  duration_seconds: number
  duration_min_seconds: number | null
  duration_max_seconds: number | null
  captions_enabled: boolean
  captions_language: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  /** Burn-in caption style; absent on jobs created before styles existed. */
  caption_style?: string
  /** Clip selection mode; absent on jobs created before the mode existed. */
  selection_mode?: string
  on_screen_text: boolean
  /** Batch 1 enhancements (2026-11-25); absent on older jobs, where the
   * worker treats them as ON. */
  auto_zoom?: boolean
  face_tracking?: boolean
  silence_removal?: boolean
  filler_removal?: boolean
  /** Batch 15 (2026-11-28): pattern interrupts (default ON — no
   * wizard toggle, like auto colour grade) and loop-perfect clips
   * (default OFF — the wizard's Step 2 toggle). Absent on older
   * jobs, where the worker treats them as ON / OFF. */
  pattern_interrupts?: boolean
  loop_perfect?: boolean
  /** Batch 2 headline look + caption position (2026-11-25); absent on
   * older jobs, where the worker uses bold_bar / bottom. */
  headline_style?: string
  caption_position?: string
  /** Batch 9 OST position (2026-11-25); absent on older jobs, where
   * the worker uses the style default (bold_bar -> top,
   * lower_third -> bottom, big_centre -> centre). */
  ost_position?: string
  /** Batch 9 OST language (2026-11-25); absent means 'source' —
   * the headline stays in the video's own language. */
  ost_language?: string
  /** Batch 9 SFX sting (2026-11-25); absent means 'none'. */
  sfx?: string
  /** Batch 9 colour grade (2026-11-25); absent means 'none' —
   * no filter, the render pipeline is untouched. */
  colour_grade?: string
  /** Batch 3 beat sync (2026-11-25); absent on older jobs, where the
   * worker treats it as ON. */
  beat_sync?: boolean
  /** Batch 3 caption translation (2026-11-25); absent means "none". */
  caption_translation?: string
  /** Batch 3 export ratios (2026-11-25); absent means the job's own
   * aspect_ratio only. */
  export_ratios?: string[]
  /** Batch 11 export tier (2026-11-25); absent means the Free 720p
   * default — the server stores the plan's cap as
   * max_export_height and the worker renders at that cap. */
  export_quality?: '720p' | '1080p'
  /** Batch 4 logo overlay (2026-11-25); absent means OFF — the
   * worker treats a missing key as OFF. */
  logo_overlay?: boolean
  /** Batch 6 caption safe zone (2026-11-25); absent means ON — the
   * worker treats a missing key as ON. */
  caption_safe_zone?: boolean
  /** Batch 7 whole-clip on-screen text (2026-11-25); absent means
   * the defaults (persistent OFF, animation none, end card OFF,
   * keyword pop-ups OFF, no lower-third tag, no progress bar) — the
   * worker treats missing keys as the defaults. */
  ost_persistent?: boolean
  ost_animation?: string
  end_card?: boolean
  end_card_text?: string | null
  keyword_popups?: boolean
  lower_third_text?: string | null
  progress_bar?: boolean
  job_type: 'myself' | 'campaign'
  campaign_requirements: string | null
  /** Batch 12 structured campaign requirements (2026-11-25) — the
   * full brief plus three fields that each carry their own
   * Required/Optional flag. Required items are applied verbatim by
   * the worker (caption, hashtags first, OST burned) and never
   * translated; Optional items are hints / auto-derived. The
   * ost_hint is used only when the OST is Optional. */
  campaign_brief?: string | null
  campaign_caption?: string | null
  campaign_caption_required?: boolean
  campaign_hashtags?: string | null
  campaign_hashtags_required?: boolean
  campaign_ost?: string | null
  campaign_ost_required?: boolean
  ost_hint?: string | null
  /** Batch 14: the backend's deterministic parse of the brief
   * (CampaignBriefParser) — what was extracted (with priority) and
   * what was not parsed. Null on jobs created before this batch
   * (they fall back to the Batch 12 structured fields above). */
  campaign_parsed?: CampaignParsed | null
  /** Free-text notes for Muse (campaign brief, extra instructions). */
  notes?: string | null
  layout: ClipLayout
  content_type: string
  quality: 'draft' | 'standard' | 'high'
  source_type: 'upload' | 'link'
  source_url: string | null
  source_path: string | null
}

export interface JobClip {
  id: number
  title: string
  status: string
  start_seconds: number | null
  end_seconds: number | null
  duration_seconds: number | null
  aspect_ratio: string | null
  file_size_bytes: number | null
  score: number | null
  reason: string | null
  /** Per-signal viral-score breakdown (label -> 0-100), when the worker sent one. Null for older clips. */
  score_breakdown: Record<string, number> | null
  transcript_excerpt: string | null
  download_url: string
  /** First-frame JPEG path (null for clips rendered before thumbnails). */
  thumbnail_path: string | null
  /** Batch 4: up to 3 worker-extracted frames for the thumbnail
   * picker (null on clips rendered before the picker existed). */
  thumbnail_candidates: string[] | null
  /** Batch 4: favourite flag (false by default). */
  is_favourite: boolean
  /** Caption style burned into this clip (null when rendered before styles were stored). */
  caption_style: string | null
  /** Batch 9: whether the worker tracked the face through this clip
   * (false when it did not report it) and, for a Variant B clip, the
   * Variant A clip id it was rendered from (null = original). */
  face_tracked?: boolean
  variant_of_clip_id?: number | null
  /** Batch 12: per-clip campaign attachment — the clip's own title +
   * hashtags (derived from its own transcript), its post caption
   * (required verbatim or auto-derived), where the caption came
   * from, the exact OST text actually burned, and which required
   * items this clip applied. Null on clips rendered before this
   * batch. */
  title_suggestion?: string | null
  hashtags?: string[] | null
  post_caption?: string | null
  caption_source?: 'required' | 'auto' | 'example' | null
  ost_burned_text?: string | null
  required_items_applied?: string[] | null
  /** Batch 13: the grade this clip actually rendered with + the
   * auto picker's reason (null for a manual look or an ungraded
   * clip; null on clips rendered before this batch). */
  colour_grade_applied?: string | null
  colour_grade_reason?: string | null
  /** Batch 15 — Viral Intelligence (2026-11-28). Hook score 0–100
   * + reason, measured from the clip's first 3s by the worker
   * (an estimate, never a promise); per-second retention curve
   * (0–100, one entry per second, also estimated); loop_ready
   * true when the end was matched to the start frame for a smooth
   * loop. Null / false on clips rendered before this batch. */
  hook_score?: number | null
  hook_reason?: string | null
  retention_curve?: number[] | null
  loop_ready?: boolean
  /** Batch 15: the latest user-entered posted results for this
   * clip (null = none yet — never fabricated). */
  performance?: ClipPerformance | null
  created_at: string
}

/** Batch 15: one user-entered posted-results row for a clip
 * (TikTok / Instagram only — real numbers the user typed in). */
export interface ClipPerformance {
  id: number
  clip_id: number
  platform: 'tiktok' | 'instagram'
  views: number
  likes: number
  comments: number
  shares: number
  posted_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ClipPerformanceInput {
  platform: 'tiktok' | 'instagram'
  views: number
  likes: number
  comments: number
  shares: number
  posted_at?: string | null
  notes?: string | null
}

export interface CampaignChecklistItem {
  key: 'caption' | 'hashtags' | 'ost'
  label: string
  /** The exact required text (or the required hashtag list). */
  required: string | string[]
  passed: boolean
  note: string
}

export interface CampaignChecklistData {
  items: CampaignChecklistItem[]
  all_passed: boolean
  failed_count: number
  checked_at: string
}

export interface ManualCheck {
  id: string
  text: string
  checked: boolean
}

/** Batch 14: the backend's deterministic parse of the pasted
 * campaign brief (CampaignBriefParser, PHP). `music_allowed` is
 * false when the brief forbids background music; `manual_lines`
 * are the brief lines the parser could not follow — they become
 * the job's manual checks. Audio links are for posting time only:
 * the worker never downloads or mixes campaign audio. */
export interface CampaignParsed {
  title: string | null
  ost: { required: boolean; must_include: boolean; choices: string[] }
  caption: { required: boolean; verbatim: string | null; examples: string[] }
  hashtags: string[]
  hashtags_required: boolean
  audio: { required: boolean; links: { label: string; url: string }[] }
  reference_videos: string[]
  music_allowed: boolean
  clip_types: string[]
  requirements: string[]
  not_allowed: string[]
  editing_rules: string[]
  unparsed: string[]
  manual_lines: string[]
}

export interface Job {
  id: number
  project_id: number
  status: JobStatus
  state: string
  stage: string | null
  progress: number | null
  /** Worker note: why fewer clips came back, or why some failed. */
  note: string | null
  /** True when the worker added the brand intro / outro to this job's clips. Absent on jobs rendered before the flags existed. */
  intro_applied?: boolean
  outro_applied?: boolean
  /** Batch 4: title + hashtag suggestions derived from the job's own
   * transcript. Null on silent jobs (no speech to derive from) and
   * on jobs rendered before suggestions existed. */
  title_suggestion?: string | null
  hashtags?: string[] | null
  /** Batch 9: the music bed's original file name (null = no bed). */
  music_bed_name?: string | null
  /** Batch 12: campaign compliance checklist (null when the job has
   * no required campaign items) and the manual brief checks the
   * user ticks by hand. */
  campaign_checklist?: CampaignChecklistData | null
  campaign_manual_checks?: ManualCheck[] | null
  /** Batch 11: queue position + estimated wait (null on ready /
   * failed / cancelled jobs — there is nothing to wait for). */
  queue?: import('../components/QueueInfo').QueueInfoData | null
  settings: JobSettings | null
  source_type: 'upload' | 'link'
  source_url: string | null
  clips: JobClip[]
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type JobResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; status?: number }

export interface CreateJobInput {
  /** Exactly one of `file` / `sourceUrl` must be set. */
  file?: File | null
  sourceUrl?: string
  platform: 'tiktok' | 'instagram'
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5'
  clipCount: number
  durationMode: 'exact' | 'minimum' | 'maximum'
  /** Exact length, or the min/max bound per mode (see the wizard, Clipper.tsx). */
  durationSeconds: number
  durationMinSeconds?: number | null
  durationMaxSeconds?: number | null
  captionsEnabled: boolean
  captionsLanguage: 'english' | 'roman_urdu' | 'hindi' | 'auto'
  /** Burn-in caption style id (see lib/captionStyles); defaults to 'punchy'. */
  captionStyle: string
  /** Clip selection mode (see SELECTION_MODE_LABELS); defaults to 'interesting_only'. */
  selectionMode?: SelectionMode
  onScreenText: boolean
  /** Batch 1 enhancements (see lib/jobs JobSettings); default ON. */
  autoZoom: boolean
  faceTracking: boolean
  silenceRemoval: boolean
  fillerRemoval: boolean
  /** Batch 15 (2026-11-28): pattern interrupts (no wizard toggle —
   * always ON, like auto colour grade) and loop-perfect clips
   * (Step 2 toggle, default OFF). */
  patternInterrupts?: boolean
  loopPerfect: boolean
  /** Batch 2 headline look (see HEADLINE_STYLE_LABELS); default 'bold_bar'. */
  headlineStyle: HeadlineStyle
  /** Batch 2 caption position; default 'bottom'. */
  captionPosition: CaptionPosition
  /** Batch 9 OST position (see OST_POSITION_LABELS); default follows
   * the headline style (bold_bar -> top, lower_third -> bottom,
   * big_centre -> centre). */
  ostPosition: OstPosition
  /** Batch 9 OST language (see OST_LANGUAGE_LABELS); default
   * 'source' — the headline stays in the video's own language. */
  ostLanguage: OstLanguage
  /** Batch 9 SFX sting (default 'none'). */
  sfx: Sfx
  /** Batch 9 colour grade (default 'none' — no filter). */
  colourGrade: ColourGrade
  /** Batch 9 music bed file (mp3/wav/m4a, max 50 MB) — uploaded with
   * the job; null = no music bed. */
  musicBed?: File | null
  /** Batch 3 beat sync (default ON) — snap cuts and zoom to the beat. */
  beatSync: boolean
  /** Batch 3 caption translation (default 'none'). */
  captionTranslation: CaptionTranslation
  /** Batch 3 export ratios (default ['9:16'] — 9:16 is always on). */
  exportRatios: string[]
  /** Batch 4 logo overlay (default OFF) — watermark the Brand Kit
   * logo onto every clip, bottom-right. */
  logoOverlay: boolean
  /** Batch 6 caption safe zone (default ON) — keep captions clear
   * of TikTok's right action rail and the bottom bar. */
  captionSafeZone: boolean
  /** Batch 7 whole-clip on-screen text (2026-11-25). */
  /** Keep the headline up for the full clip (default OFF — first 4s only, as before). */
  ostPersistent: boolean
  /** Headline entrance animation (default 'none'). */
  ostAnimation: OstAnimation
  /** Show a Follow card in the last 2s (default OFF). */
  endCard: boolean
  /** End-card text (default 'Follow for more', max 40 chars). */
  endCardText: string
  /** Pop up to 4 spoken keywords as large text (default OFF). */
  keywordPopups: boolean
  /** Persistent lower-third tag (empty = OFF, max 40 chars). */
  lowerThirdText: string
  /** Thin violet progress bar across the full clip (default OFF). */
  progressBar: boolean
  jobType: 'myself' | 'campaign'
  campaignRequirements?: string
  /** Free-text notes for Muse (campaign brief, extra instructions). */
  notes?: string
  layout: ClipLayout
  contentType: string
  quality: 'draft' | 'standard' | 'high'
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * The backend's exact error message: `message` first, then the first
 * Laravel validation error, then a fallback. Never invents a message.
 */
function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string' && b.message) return b.message
    if (typeof b.detail === 'string' && b.detail) return b.detail
    if (b.errors && typeof b.errors === 'object') {
      const entries = Object.entries(b.errors as Record<string, unknown>)
      const messages = entries.flatMap(([field, msgs]) =>
        Array.isArray(msgs)
          ? msgs.filter((m): m is string => typeof m === 'string').map((m) => `${field}: ${m}`)
          : [],
      )
      if (messages.length > 0) return messages.join(' ')
    }
  }
  return fallback
}

function isUnreachable(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && err.name === 'AbortError') ||
    /failed to fetch|networkerror|load failed|ECONNREFUSED/i.test(
      err instanceof Error ? err.message : String(err),
    )
  )
}

/**
 * POST a multipart FormData with real upload progress.
 *
 * Always-On round (2026-11-26): `fetch` reports no upload progress,
 * so a big video on a slow connection looked like a stuck spinner
 * until the client timeout killed it (the 2026-11-26 user failure).
 * XMLHttpRequest's `upload.onprogress` gives honest 0–100% progress.
 * Returns a real Response so the caller handles it exactly like the
 * fetch path. A timeout rejects with an AbortError-named error, the
 * same signal the fetch path produces when its timeout fires.
 */
function postFormWithProgress(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  timeoutMs: number,
  onUploadProgress?: (fraction: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.timeout = timeoutMs
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value)
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0 && onUploadProgress) {
        onUploadProgress(event.loaded / event.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status === 0) {
        reject(new TypeError('Failed to fetch'))
        return
      }
      resolve(new Response(xhr.responseText || null, { status: xhr.status }))
    }
    xhr.onerror = () => reject(new TypeError('Failed to fetch'))
    xhr.ontimeout = () => {
      const err = new Error('The request timed out')
      err.name = 'AbortError'
      reject(err)
    }
    xhr.send(form)
  })
}

/** Options for createJob. `onUploadProgress` fires (0–1) only on the
 *  file-upload path — the link path has nothing to upload. */
export interface CreateJobOptions {
  onUploadProgress?: (fraction: number) => void
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * Append the shared settings fields to a job-creation FormData.
 * Used by createJob (single file) and createBulkJobs (up to 5 files)
 * so the two can never drift apart. The caller appends the file(s)
 * itself first.
 */
function appendSettingsForm(form: FormData, input: CreateJobInput): void {
  form.append('platform', input.platform)
  form.append('aspect_ratio', input.aspectRatio)
  form.append('clip_count', String(input.clipCount))
  form.append('duration_mode', input.durationMode)
  form.append('duration_seconds', String(input.durationSeconds))
  if (input.durationMinSeconds != null) {
    form.append('duration_min_seconds', String(input.durationMinSeconds))
  }
  if (input.durationMaxSeconds != null) {
    form.append('duration_max_seconds', String(input.durationMaxSeconds))
  }
  form.append('captions_enabled', String(input.captionsEnabled))
  form.append('captions_language', input.captionsLanguage)
  form.append('caption_style', input.captionStyle)
  form.append('selection_mode', input.selectionMode ?? 'interesting_only')
  form.append('on_screen_text', String(input.onScreenText))
  form.append('auto_zoom', String(input.autoZoom))
  form.append('face_tracking', String(input.faceTracking))
  form.append('silence_removal', String(input.silenceRemoval))
  form.append('filler_removal', String(input.fillerRemoval))
  form.append('pattern_interrupts', String(input.patternInterrupts ?? true))
  form.append('loop_perfect', String(input.loopPerfect))
  form.append('headline_style', input.headlineStyle)
  form.append('caption_position', input.captionPosition)
  form.append('ost_position', input.ostPosition)
  form.append('ost_language', input.ostLanguage)
  form.append('sfx', input.sfx)
  form.append('colour_grade', input.colourGrade)
  if (input.musicBed) {
    form.append('music_bed', input.musicBed)
  }
  form.append('beat_sync', String(input.beatSync))
  form.append('caption_translation', input.captionTranslation)
  for (const ratio of input.exportRatios) {
    form.append('export_ratios[]', ratio)
  }
  form.append('logo_overlay', String(input.logoOverlay))
  form.append('caption_safe_zone', String(input.captionSafeZone))
  form.append('ost_persistent', String(input.ostPersistent))
  form.append('ost_animation', input.ostAnimation)
  form.append('end_card', String(input.endCard))
  if (input.endCardText.trim()) {
    form.append('end_card_text', input.endCardText.trim().slice(0, 40))
  }
  form.append('keyword_popups', String(input.keywordPopups))
  if (input.lowerThirdText.trim()) {
    form.append('lower_third_text', input.lowerThirdText.trim().slice(0, 40))
  }
  form.append('progress_bar', String(input.progressBar))
  form.append('job_type', input.jobType)
  if (input.jobType === 'campaign' && input.campaignRequirements) {
    form.append('campaign_requirements', input.campaignRequirements)
    form.append('campaign_brief', input.campaignRequirements)
  }
  if (input.notes) {
    form.append('notes', input.notes)
  }
  form.append('layout', input.layout)
  form.append('content_type', input.contentType)
  form.append('quality', input.quality)
}

/**
 * POST /api/v1/jobs. File source → multipart (via XMLHttpRequest so
 * the upload shows real progress); link source → JSON (fetch).
 * 600s timeout: a big upload can take minutes on a slow connection —
 * the old 120s cap killed real uploads (user failure 2026-11-26).
 */
export async function createJob(
  input: CreateJobInput,
  opts?: CreateJobOptions,
): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to create a job.' }
  }
  const { signal, cancel } = timeoutSignal(600000)
  try {
    let res: Response
    if (input.file) {
      const form = new FormData()
      form.append('file', input.file)
      appendSettingsForm(form, input)
      res = await postFormWithProgress(
        `${API_URL}/jobs`,
        form,
        authHeaders(),
        600000,
        opts?.onUploadProgress,
      )
    } else {
      res = await fetch(`${API_URL}/jobs`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_url: input.sourceUrl,
          platform: input.platform,
          aspect_ratio: input.aspectRatio,
          clip_count: input.clipCount,
          duration_mode: input.durationMode,
          duration_seconds: input.durationSeconds,
          duration_min_seconds: input.durationMinSeconds ?? null,
          duration_max_seconds: input.durationMaxSeconds ?? null,
          captions_enabled: input.captionsEnabled,
          captions_language: input.captionsLanguage,
          caption_style: input.captionStyle,
          selection_mode: input.selectionMode ?? 'interesting_only',
          on_screen_text: input.onScreenText,
          auto_zoom: input.autoZoom,
          face_tracking: input.faceTracking,
          silence_removal: input.silenceRemoval,
          filler_removal: input.fillerRemoval,
          headline_style: input.headlineStyle,
          caption_position: input.captionPosition,
          ost_position: input.ostPosition,
          ost_language: input.ostLanguage,
          sfx: input.sfx,
          colour_grade: input.colourGrade,
          beat_sync: input.beatSync,
          caption_translation: input.captionTranslation,
          export_ratios: input.exportRatios,
          logo_overlay: input.logoOverlay,
          caption_safe_zone: input.captionSafeZone,
          ost_persistent: input.ostPersistent,
          ost_animation: input.ostAnimation,
          end_card: input.endCard,
          end_card_text: input.endCardText.trim()
            ? input.endCardText.trim().slice(0, 40)
            : null,
          keyword_popups: input.keywordPopups,
          lower_third_text: input.lowerThirdText.trim()
            ? input.lowerThirdText.trim().slice(0, 40)
            : null,
          progress_bar: input.progressBar,
          job_type: input.jobType,
          campaign_requirements:
            input.jobType === 'campaign' ? (input.campaignRequirements ?? null) : null,
          campaign_brief:
            input.jobType === 'campaign' ? (input.campaignRequirements ?? null) : null,
          notes: input.notes ?? null,
          layout: input.layout,
          content_type: input.contentType,
          quality: input.quality,
        }),
        signal,
      })
    }
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not create the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: 'The server created the job but returned an unusable response.' }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? unreachableMessage(err instanceof Error && err.name === 'AbortError')
        : err instanceof Error
          ? err.message
          : 'Could not create the job.',
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Bulk create (Batch 4)                                               */
/* ------------------------------------------------------------------ */

export type BulkJobResult =
  | { ok: true; jobs: Job[] }
  | { ok: false; error: string; status?: number }

/**
 * POST /api/v1/jobs with `files[]` — up to 5 source files, ONE shared
 * settings form, one job per file. Returns the created jobs in upload
 * order. The backend probes every file before creating any job, so a
 * bad file fails the whole request with no jobs created.
 */
export async function createBulkJobs(
  files: File[],
  input: CreateJobInput,
): Promise<BulkJobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to create jobs.' }
  }
  if (files.length < 1 || files.length > 5) {
    return { ok: false, error: 'Pick between 1 and 5 video files.' }
  }
  const { signal, cancel } = timeoutSignal(600000)
  try {
    const form = new FormData()
    for (const file of files) {
      form.append('files[]', file)
    }
    appendSettingsForm(form, input)
    const res = await fetch(`${API_URL}/jobs`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not create the jobs (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const jobs = (body as { jobs?: Job[] }).jobs
    if (!Array.isArray(jobs) || jobs.some((j) => typeof j.id !== 'number')) {
      return { ok: false, error: 'The server created the jobs but returned an unusable response.' }
    }
    return { ok: true, jobs }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? unreachableMessage(err instanceof Error && err.name === 'AbortError')
        : err instanceof Error
          ? err.message
          : 'Could not create the jobs.',
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Clip favourites + thumbnail picker (Batch 4)                        */
/* ------------------------------------------------------------------ */

export type ClipResult =
  | { ok: true; clip: JobClip }
  | { ok: false; error: string; status?: number }

async function patchClip(
  clipId: number,
  path: 'favourite' | 'thumbnail',
  payload: Record<string, unknown>,
): Promise<ClipResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to do that.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/${path}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not update the clip (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const clip = (body as { clip?: JobClip }).clip
    if (!clip || typeof clip.id !== 'number') {
      return { ok: false, error: 'The server did not return the updated clip.' }
    }
    return { ok: true, clip }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : 'Could not update the clip.',
    }
  } finally {
    cancel()
  }
}

/** PATCH /api/v1/clips/{id}/favourite — flip the heart. */
export async function toggleClipFavourite(clipId: number): Promise<ClipResult> {
  return patchClip(clipId, 'favourite', {})
}

/**
 * PATCH /api/v1/clips/{id}/thumbnail — set one of the candidate frames
 * (0-based index into thumbnail_candidates) as the clip's thumbnail.
 */
export async function setClipThumbnail(clipId: number, candidateIndex: number): Promise<ClipResult> {
  return patchClip(clipId, 'thumbnail', { candidate_index: candidateIndex })
}

/**
 * Fetch one thumbnail-picker candidate frame
 * (GET /api/v1/clips/{id}/candidates/{index}) with the bearer token
 * and return an object URL for an <img>, or null when it is missing.
 * The caller owns the object URL.
 */
export async function fetchClipCandidate(clipId: number, index: number): Promise<string | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/candidates/${index}`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* List / get                                                          */
/* ------------------------------------------------------------------ */

export interface JobListPage {
  jobs: Job[]
  total: number
  currentPage: number
  lastPage: number
}

/**
 * GET /api/v1/jobs — Laravel paginator shape:
 * `{ data: [...], total, current_page, last_page, ... }`.
 * Returns an empty page (not an error) when signed out, so list pages
 * can show their sign-in state instead of a crash.
 */
export async function listJobs(
  opts: { status?: JobStatus | 'all'; page?: number; perPage?: number } = {},
): Promise<JobListPage> {
  const empty: JobListPage = { jobs: [], total: 0, currentPage: 1, lastPage: 1 }
  if (!getToken()) return empty
  const params = new URLSearchParams()
  if (opts.status && opts.status !== 'all') params.set('status', opts.status)
  params.set('page', String(opts.page ?? 1))
  params.set('per_page', String(opts.perPage ?? 20))
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs?${params.toString()}`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return empty
    const body = (await res.json()) as {
      data?: Job[]
      total?: number
      current_page?: number
      last_page?: number
    }
    return {
      jobs: Array.isArray(body.data) ? body.data : [],
      total: typeof body.total === 'number' ? body.total : 0,
      currentPage: typeof body.current_page === 'number' ? body.current_page : 1,
      lastPage: typeof body.last_page === 'number' ? body.last_page : 1,
    }
  } catch {
    return empty
  } finally {
    cancel()
  }
}

/** GET /api/v1/jobs/{id} — 404 means not found or not owned by the caller. */
export async function getJob(id: number): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to view this job.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs/${id}`, {
      headers: authHeaders(),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (res.status === 404) {
      return { ok: false, error: 'Job not found. It may have been deleted or belong to another account.', status: 404 }
    }
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not load the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: 'The server returned an unusable job.' }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? unreachableMessage()
        : err instanceof Error
          ? err.message
          : 'Could not load the job.',
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Cancel / retry (both supported by the user-facing API)              */
/* ------------------------------------------------------------------ */

export async function cancelJob(id: number): Promise<JobResult> {
  return postJobAction(id, 'cancel')
}

/**
 * Batch 15: save posted results for one clip
 * (POST /api/v1/clips/{clip}/performance). Every save posts a new
 * row; the latest row is the current one. Counts are the user's own
 * numbers — the client never fills them in.
 */
export async function saveClipPerformance(
  clipId: number,
  input: ClipPerformanceInput,
): Promise<{ ok: true; performance: ClipPerformance } | { ok: false; error: string }> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to do that.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/performance`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: input.platform,
        views: input.views,
        likes: input.likes,
        comments: input.comments,
        shares: input.shares,
        posted_at: input.posted_at ?? null,
        notes: input.notes ?? null,
      }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: serverMessage(body, 'Could not save the posted results.') }
    }
    const performance = (body as { performance?: ClipPerformance } | null)?.performance
    if (!performance) {
      return { ok: false, error: 'The server did not return the saved results.' }
    }
    return { ok: true, performance }
  } catch (err) {
    return { ok: false, error: isUnreachable(err) ? unreachableMessage() : 'Could not save the posted results.' }
  } finally {
    cancel()
  }
}

export async function retryJob(id: number): Promise<JobResult> {
  return postJobAction(id, 'retry')
}

/**
 * Batch 12: tick the manual campaign brief checks
 * (PATCH /api/v1/jobs/{id}/campaign-checks). Only brief lines the
 * server knows can be ticked — an unknown id is ignored there.
 */
export async function updateCampaignChecks(
  id: number,
  manualChecks: ManualCheck[],
): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to do that.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs/${id}/campaign-checks`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manual_checks: manualChecks.map((c) => ({ id: c.id, checked: c.checked })),
      }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not save the manual checks (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: 'The server did not return the updated job.' }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Could not reach the server — check your connection and try again.'
        : `Could not save the manual checks (${err instanceof Error ? err.message : 'unknown error'})`,
    }
  } finally {
    cancel()
  }
}

async function postJobAction(id: number, action: 'cancel' | 'retry'): Promise<JobResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to do that.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/jobs/${id}/${action}`, {
      method: 'POST',
      headers: authHeaders(),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not ${action} the job (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const job = (body as { job?: Job }).job
    if (!job || typeof job.id !== 'number') {
      return { ok: false, error: `The server did not return the updated job after ${action}.` }
    }
    return { ok: true, job }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : `Could not ${action} the job.`,
    }
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Clip re-renders (queue a clip with a different caption style)       */
/* ------------------------------------------------------------------ */

/** One re-render request for a clip (see ClipRerender in the backend). */
export interface ClipRerender {
  id: number
  clip_id: number
  caption_style: string
  /** Batch 9: true when this row renders a NEW Variant B clip
   * instead of replacing the original file in place. */
  is_variant?: boolean
  variant_headline_style?: string | null
  status: 'queued' | 'processing' | 'ready' | 'failed'
  error_message: string | null
  created_at: string
  updated_at: string
}

export type RerenderResult =
  | { ok: true; rerender: ClipRerender }
  | { ok: false; error: string; status?: number }

/**
 * POST /api/v1/clips/{id}/render — queue a re-render of one clip with a
 * different caption style. The worker re-renders the SAME window and
 * replaces the file in place; the job page polls getClipRerenders.
 */
export async function requestClipRerender(
  clipId: number,
  captionStyle: string,
): Promise<RerenderResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to re-render a clip.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/render`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption_style: captionStyle }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not queue the re-render (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const rerender = (body as { rerender?: ClipRerender }).rerender
    if (!rerender || typeof rerender.id !== 'number') {
      return { ok: false, error: 'The server did not return the queued re-render.' }
    }
    return { ok: true, rerender }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : 'Could not queue the re-render.',
    }
  } finally {
    cancel()
  }
}

export type BulkRerenderResult =
  | {
      ok: true
      rerenders: ClipRerender[]
      skipped: { clip_id: number; reason: string }[]
    }
  | { ok: false; error: string; status?: number }

/**
 * POST /api/v1/clips/bulk-rerender — queue a re-render of several
 * clips with one caption style. Returns the created rows plus any
 * clips skipped (no file yet, already on that style, or a re-render
 * already in flight) with the reason for each.
 */
export async function requestBulkRerender(
  clipIds: number[],
  captionStyle: string,
): Promise<BulkRerenderResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to re-render clips.' }
  }
  if (clipIds.length === 0) {
    return { ok: false, error: 'Select at least one clip first.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/bulk-rerender`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_ids: clipIds, caption_style: captionStyle }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not queue the re-renders (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const parsed = body as {
      rerenders?: ClipRerender[]
      skipped?: { clip_id: number; reason: string }[]
    }
    return {
      ok: true,
      rerenders: Array.isArray(parsed.rerenders) ? parsed.rerenders : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : 'Could not queue the re-renders.',
    }
  } finally {
    cancel()
  }
}

/**
 * POST /api/v1/clips/{id}/variants — queue an A/B variant of one
 * clip. The worker renders the SAME window with the chosen caption
 * style (+ optional headline style) and uploads it as a NEW clip
 * (Variant B) instead of replacing the original file.
 */
export async function createClipVariant(
  clipId: number,
  captionStyle: string,
  headlineStyle?: string | null,
): Promise<RerenderResult> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to create a variant.' }
  }
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/variants`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caption_style: captionStyle,
        headline_style: headlineStyle ?? null,
      }),
      signal,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        error: serverMessage(body, `Could not queue the variant (HTTP ${res.status})`),
        status: res.status,
      }
    }
    const rerender = (body as { rerender?: ClipRerender }).rerender
    if (!rerender || typeof rerender.id !== 'number') {
      return { ok: false, error: 'The server did not return the queued variant.' }
    }
    return { ok: true, rerender }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable.'
        : err instanceof Error
          ? err.message
          : 'Could not queue the variant.',
    }
  } finally {
    cancel()
  }
}

/** GET /api/v1/clips/{id}/rerenders — re-render history, latest first. */
export async function getClipRerenders(clipId: number): Promise<ClipRerender[]> {
  if (!getToken()) return []
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/rerenders`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { rerenders?: ClipRerender[] }
    return Array.isArray(body.rerenders) ? body.rerenders : []
  } catch {
    return []
  } finally {
    cancel()
  }
}

/* ------------------------------------------------------------------ */
/* Clip download                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch a clip's first-frame thumbnail (GET /api/v1/clips/{id}/thumbnail)
 * with the bearer token and return an object URL for an <img>, or null
 * when the clip has no thumbnail (clips rendered before thumbnails
 * existed, or the file is missing). The caller owns the object URL.
 */
export async function fetchClipThumbnail(clipId: number): Promise<string | null> {
  if (!getToken()) return null
  const { signal, cancel } = timeoutSignal(15000)
  try {
    const res = await fetch(`${API_URL}/clips/${clipId}/thumbnail`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  } finally {
    cancel()
  }
}

/**
 * Fetch one clip's MP4 as a blob via its download_url with the bearer
 * token. Shared by downloads and the in-app preview player. Returns the
 * exact backend error when the file is not ready / not found.
 */
export async function fetchClipBlob(clip: JobClip): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to download clips.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(clip.download_url, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) {
      let detail = `Download failed (HTTP ${res.status})`
      try {
        const body: unknown = await res.json()
        detail = serverMessage(body, detail)
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      return { ok: false, error: detail }
    }
    return { ok: true, blob: await res.blob() }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — the clip could not be downloaded.'
        : err instanceof Error
          ? err.message
          : 'Download failed.',
    }
  } finally {
    cancel()
  }
}

/**
 * Download one clip via its download_url with the bearer token, then
 * trigger a browser download of the real MP4. Returns the exact
 * backend error when the file is not ready / not found.
 */
export async function downloadClip(clip: JobClip): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await fetchClipBlob(clip)
  if (!result.ok) return result
  const url = URL.createObjectURL(result.blob)
  const safeTitle = (clip.title || `clip-${clip.id}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeTitle}.mp4`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { ok: true }
}

/**
 * Download one clip's audio track as .m4a (GET /api/v1/clips/{id}/audio).
 * Same blob-download pattern as downloadClip: the bearer token is sent,
 * the backend's exact error is surfaced (404 when the clip file is gone
 * or the clip has no audio track). Only call for ready clips — a clip
 * with no file has no audio to export.
 */
export async function downloadClipAudio(
  clip: JobClip,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!getToken()) {
    return { ok: false, error: 'Sign in to download clip audio.' }
  }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${API_URL}/clips/${clip.id}/audio`, {
      headers: authHeaders(),
      signal,
    })
    if (!res.ok) {
      let detail = `Audio download failed (HTTP ${res.status})`
      try {
        const body: unknown = await res.json()
        detail = serverMessage(body, detail)
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      return { ok: false, error: detail }
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const safeTitle = (clip.title || `clip-${clip.id}`)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 100)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeTitle}.m4a`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — the audio could not be downloaded.'
        : err instanceof Error
          ? err.message
          : 'Audio download failed.',
    }
  } finally {
    cancel()
  }
}

/**
 * POST /api/v1/clips/zip — download several clips as one ZIP. The
 * server builds the ZIP from the clip files still on disk and skips
 * files wiped by a server restart; the skipped count comes back in the
 * X-Clips-Skipped header (0 when everything was there). When none of
 * the selected clips still have files, the server answers 404 with an
 * honest message instead of an empty ZIP.
 */
export async function downloadClipsZip(
  clipIds: number[],
): Promise<
  | { ok: true; included: number; skipped: number }
  | { ok: false; error: string }
> {
  if (!getToken()) return { ok: false, error: 'Sign in to download clips.' }
  if (clipIds.length === 0) return { ok: false, error: 'Select at least one clip first.' }
  const { signal, cancel } = timeoutSignal(120000)
  try {
    const res = await fetch(`${API_URL}/clips/zip`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip_ids: clipIds }),
      signal,
    })
    if (!res.ok) {
      let detail = `Could not build the ZIP (HTTP ${res.status})`
      try {
        const body: unknown = await res.json()
        detail = serverMessage(body, detail)
      } catch {
        // Non-JSON error body — keep the HTTP status message.
      }
      return { ok: false, error: detail }
    }
    const blob = await res.blob()
    const included = Number(res.headers.get('X-Clips-Included') ?? clipIds.length)
    const skipped = Number(res.headers.get('X-Clips-Skipped') ?? 0)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `clips-${new Date().toISOString().slice(0, 10)}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true, included, skipped }
  } catch (err) {
    return {
      ok: false,
      error: isUnreachable(err)
        ? 'Backend is not reachable — the ZIP could not be built.'
        : err instanceof Error
          ? err.message
          : 'Could not build the ZIP.',
    }
  } finally {
    cancel()
  }
}
