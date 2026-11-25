import { useEffect, useState } from 'react'
import { Captions, Type } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { API_URL } from '../lib/api'
import { CAPTION_STYLES, getCaptionStyle, isCaptionStyleId, type CaptionPreviewAnim } from '../lib/captionStyles'
import { CaptionStylePreview, PREVIEW_CSS } from '../components/CaptionStylePreview'
import { useAuth } from '../state/auth'
import { usePreferences } from '../state/preferences'
import { getProject } from '../state/projects'
import { PageHeader } from '../components/PageHeader'

const FONT_FAMILIES = ['Inter', 'Arial', 'Georgia', 'Verdana', 'system-ui'] as const

type AnimationChoice = 'none' | 'bounce' | 'pop' | 'karaoke' | 'glow'

const ANIMATION_CLASS: Record<AnimationChoice, string> = {
  none: '',
  bounce: 'caption-anim-bounce',
  pop: 'caption-anim-pop',
  karaoke: 'caption-anim-karaoke',
  glow: 'caption-anim-glow',
}

const ANIMATION_OPTIONS: { id: AnimationChoice; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'pop', label: 'Pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'glow', label: 'Glow' },
]

/**
 * Seed the sample-text animation control from a real style's anim.
 * The control only offers none/bounce/pop/karaoke/glow, so styles
 * with no close equivalent seed the nearest motion (sweep → karaoke
 * fill; title/subs/typewriter → none; slam/outline/gradient/kinetic
 * → pop; word_zoom/glitch_pop/tiktok_bold → pop; word_fade →
 * none; highlight box → karaoke; bounce pop → bounce; reels_clean /
 * shorts_minimal → none — they have no motion by design). The
 * burned-in look is the style's own anim, not this seed.
 */
const ANIMATION_FOR_STYLE: Record<CaptionPreviewAnim, AnimationChoice> = {
  pop: 'pop',
  title: 'none',
  subs: 'none',
  karaoke: 'karaoke',
  bounce: 'bounce',
  typewriter: 'none',
  sweep: 'karaoke',
  neon: 'glow',
  slam: 'pop',
  outline: 'pop',
  gradient: 'pop',
  kinetic: 'pop',
  glow_pop: 'glow',
  word_zoom: 'pop',
  word_fade: 'none',
  highlight_sweep: 'karaoke',
  bounce_in: 'bounce',
  glitch_pop: 'pop',
  tiktok_bold: 'pop',
  reels_clean: 'none',
  shorts_minimal: 'none',
}

type StudioTab = 'styles' | 'customize' | 'preview'

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'styles', label: 'Styles' },
  { id: 'customize', label: 'Customize' },
  { id: 'preview', label: 'Preview' },
]

/**
 * Captions Studio — redesign (same-to-same as the design collage).
 * Style cards, the live preview and all controls below are real: they
 * restyle sample text in the browser. The fifteen worker styles at
 * the top are the styles the worker actually burns onto new jobs —
 * each sample loops its real animation, and clicking one saves it as
 * the default. "Apply to Clip" stays disabled — there is no clip in
 * context on this page. Re-rendering a finished clip with a new style
 * IS built: each clip on its job page has a Re-render control.
 * Layout follows the design reference: preset grid, a tall centre
 * preview, and a right-hand controls panel.
 */
export function CaptionsPage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('project')
  const project = projectId ? getProject(projectId) : undefined
  const { token } = useAuth()
  const { t } = usePreferences()

  // Default caption style for new jobs — saved via PATCH /api/v1/settings.
  const [defaultStyle, setDefaultStyle] = useState<string>('punchy')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savingStyle, setSavingStyle] = useState(false)

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
        if (!cancelled && isCaptionStyleId(body.settings?.caption_style)) {
          setDefaultStyle(body.settings.caption_style)
        }
      } catch {
        // Backend unreachable — keep the 'punchy' default.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  /** Clicking a sample card saves it as the default for new jobs. */
  async function selectDefaultStyle(id: string) {
    setSaveMessage(null)
    setSaveError(null)
    if (!token) {
      setSaveError('Sign in to save a default caption style.')
      return
    }
    setSavingStyle(true)
    try {
      const res = await fetch(`${API_URL}/settings`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ caption_style: id }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) {
        const message =
          body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
        setSaveError(message)
        return
      }
      setDefaultStyle(id)
      setSaveMessage(
        `Default caption style saved — new jobs will use ${getCaptionStyle(id).name}.`,
      )
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not reach the backend.')
    } finally {
      setSavingStyle(false)
    }
  }

  const [tab, setTab] = useState<StudioTab>('styles')
  const [selectedId, setSelectedId] = useState<string>('punchy')
  const active = getCaptionStyle(selectedId)

  const [sampleText, setSampleText] = useState('Like & Subscribe!')
  const [fontFamily, setFontFamily] = useState<string>('Inter')
  const [fontSizePx, setFontSizePx] = useState<number>(56)
  const [textColor, setTextColor] = useState<string>('#FFFFFF')
  const [highlightColor, setHighlightColor] = useState<string>('#FACC15')
  const [animation, setAnimation] = useState<AnimationChoice>('pop')

  /** Picking a real style seeds the sample-text controls from it. */
  const selectPreset = (id: string) => {
    const style = getCaptionStyle(id)
    setSelectedId(style.id)
    setFontFamily('Inter')
    setFontSizePx(56)
    setTextColor('#FFFFFF')
    setHighlightColor(style.id === 'punchy' ? '#FACC15' : '#7C3AED')
    setAnimation(ANIMATION_FOR_STYLE[style.anim])
  }

  // Highlight colour shows as the box behind the sweep style, the glow
  // for neon/glow styles, and an underline accent for other styles.
  const highlightStyle =
    active.anim === 'sweep'
      ? { backgroundColor: highlightColor }
      : active.anim === 'neon' || active.anim === 'glow_pop'
        ? { textShadow: `0 0 12px ${highlightColor}, 0 0 32px ${highlightColor}` }
        : { textDecoration: 'underline', textDecorationColor: highlightColor, textUnderlineOffset: 8 }

  const preview = (
    <div className="relative mx-auto flex aspect-[9/16] w-full max-w-[280px] items-center justify-center overflow-hidden rounded-xl border border-white/10 px-4 text-center caption-preview">
      <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-[#3d2b63] to-[#241a3d]" />
      <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-[#14532d] to-[#052e16]" />
      <span className="absolute inset-x-0 top-1/2 h-px bg-white/25" />
      <span className="absolute left-2 top-2 text-[9px] font-semibold uppercase tracking-wide text-white/50">
        Streamer
      </span>
      <span className="absolute left-2 top-[calc(50%+6px)] text-[9px] font-semibold uppercase tracking-wide text-white/50">
        Gameplay
      </span>
      <p
        className={`relative font-bold text-white ${ANIMATION_CLASS[animation]} leading-snug`}
        style={{
          fontFamily,
          fontSize: `${fontSizePx}px`,
          color: textColor,
          ...highlightStyle,
        }}
      >
        {sampleText || ' '}
      </p>
    </div>
  )

  const controls = (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-white">{t('sampleText')}</span>
        <input
          type="text"
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder="Like & Subscribe!"
          className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-white">Font family</span>
        <select
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value)}
          className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="flex items-center justify-between text-sm font-medium text-white">
          Font size
          <span className="text-xs font-normal text-[var(--color-text-muted)]">{fontSizePx}px</span>
        </span>
        <input
          type="range"
          min={24}
          max={96}
          step={1}
          value={fontSizePx}
          onChange={(e) => setFontSizePx(Number(e.target.value))}
          aria-label="Font size in pixels"
          className="mt-2 w-full accent-[#7C3AED]"
        />
        <span className="flex justify-between text-xs text-[var(--color-text-muted)]">
          <span>24px</span>
          <span>96px</span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-white">Text colour</span>
          <span className="mt-2 flex items-center gap-3">
            <input
              type="color"
              value={textColor}
              onChange={(e) => setTextColor(e.target.value)}
              aria-label="Text colour"
              className="h-11 w-14 cursor-pointer rounded-lg border border-ink-border bg-ink-panel2"
            />
            <span className="text-sm text-[var(--color-text-muted)]">{textColor}</span>
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">Highlight colour</span>
          <span className="mt-2 flex items-center gap-3">
            <input
              type="color"
              value={highlightColor}
              onChange={(e) => setHighlightColor(e.target.value)}
              aria-label="Highlight colour"
              className="h-11 w-14 cursor-pointer rounded-lg border border-ink-border bg-ink-panel2"
            />
            <span className="text-sm text-[var(--color-text-muted)]">{highlightColor}</span>
          </span>
        </label>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Highlight colour shows as the box behind the Highlight Sweep style, the glow
        for Neon Glow, and an underline accent for other styles.
      </p>

      <label className="block">
        <span className="text-sm font-medium text-white">Animation</span>
        <select
          value={animation}
          onChange={(e) => setAnimation(e.target.value as AnimationChoice)}
          className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
        >
          {ANIMATION_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        disabled
        className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white opacity-40"
      >
        <Captions className="h-4 w-4" /> Apply to Clip →
      </button>
      <p className="text-center text-xs text-[var(--color-text-muted)]">
        To re-render a finished clip with a new style, open the clip on its
        job page — each clip has a Re-render control there. New jobs use
        the default style you save above.
      </p>
    </div>
  )

  return (
    <div>
      <PageHeader
        title={t('captionsTitle')}
        subtitle={t('captionsSubtitle')}
        actions={
          project ? (
            <span className="rounded-full border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              Selected project: <span className="text-white">{project.title}</span>
            </span>
          ) : undefined
        }
      />

      {/* Caption style samples — the burn-in look new jobs use */}
      <section className="mb-6 rounded-2xl border border-ink-border bg-ink-panel p-6">
        <style>{PREVIEW_CSS}</style>
        <h2 className="text-lg font-semibold text-white">Caption style samples</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Pick the default caption style for new jobs. Every sample below
          plays its real animation on loop — the style you choose is burned
          onto the clips by the worker with the same font, same colours and
          same motion. Click a card to save it as the default.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {CAPTION_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => void selectDefaultStyle(style.id)}
              aria-pressed={defaultStyle === style.id}
              disabled={savingStyle}
              className={`aurora-card rounded-2xl border bg-ink-panel2 p-3 text-center transition-colors disabled:cursor-wait ${
                defaultStyle === style.id
                  ? 'border-brand ring-1 ring-brand'
                  : 'border-ink-border hover:border-brand/60'
              }`}
            >
              <CaptionStylePreview style={style} />
              <span className="mt-2 flex items-center justify-center gap-2 text-sm font-semibold text-white">
                {style.name}
                {defaultStyle === style.id ? (
                  <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-white">
                    Default
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">
                {style.description}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          More samples can be added here later — send a sample video and it
          will be added as a new style.
        </p>
        {saveMessage ? (
          <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
            {saveMessage}
          </p>
        ) : null}
        {saveError ? (
          <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
            {saveError}
          </p>
        ) : null}
      </section>

      <div className="mb-5 flex gap-2" role="tablist" aria-label="Captions Studio views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-brand text-white'
                : 'border border-ink-border bg-ink-panel text-[var(--color-text-muted)] hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'preview' ? (
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Type className="h-5 w-5 text-brand-light" /> Preview — {active.name}
          </h2>
          <div className="mt-4">{preview}</div>
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Live preview on sample text — the burned-in look on a real
            clip matches the style you save as the default above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {tab === 'styles' ? (
            <div>
              <div className="grid grid-cols-2 gap-3">
                {CAPTION_STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    onClick={() => selectPreset(style.id)}
                    aria-pressed={selectedId === style.id}
                    className={`aurora-card rounded-2xl border bg-ink-panel p-3 text-center transition-colors ${
                      selectedId === style.id
                        ? 'border-brand ring-1 ring-brand'
                        : 'border-ink-border hover:border-brand/60'
                    }`}
                  >
                    <span className="flex h-16 items-center justify-center overflow-hidden px-1 text-sm font-bold leading-tight text-white">
                      {style.sample}
                    </span>
                    <span className="mt-2 block text-xs font-medium text-[var(--color-text-muted)]">
                      {style.name}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Selected style: <span className="font-medium text-white">{active.name}</span>.
                These are the real worker styles — the animated samples
                above are the ones actually burned onto new jobs.
              </p>
            </div>
          ) : null}

          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Type className="h-5 w-5 text-brand-light" /> Preview
            </h2>
            <div className="mt-4">{preview}</div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Style: <span className="font-medium text-white">{active.name}</span>
              {' '}· {fontFamily} {fontSizePx}px
            </p>
          </div>

          <div
            className={`rounded-2xl border border-ink-border bg-ink-panel p-6 ${
              tab === 'customize' ? 'lg:col-span-1' : ''
            }`}
          >
            <h2 className="text-lg font-semibold text-white">Customize</h2>
            <div className="mt-4">{controls}</div>
          </div>
        </div>
      )}
    </div>
  )
}
