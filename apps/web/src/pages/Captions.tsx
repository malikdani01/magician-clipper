import { Fragment, useEffect, useState, type CSSProperties } from 'react'
import { Captions, Type } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { API_URL } from '../lib/api'
import { CAPTION_STYLES, getCaptionStyle, isCaptionStyleId, type CaptionStyle } from '../lib/captionStyles'
import { CAPTION_PRESETS } from '../lib/captions'
import { useAuth } from '../state/auth'
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

type StudioTab = 'styles' | 'customize' | 'preview'

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'styles', label: 'Styles' },
  { id: 'customize', label: 'Customize' },
  { id: 'preview', label: 'Preview' },
]

/** Thick black outline for burned-in captions (white text, black edge). */
const OUTLINE_SHADOW =
  '2px 0 0 #000, -2px 0 0 #000, 0 2px 0 #000, 0 -2px 0 #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000'

const SOFT_SHADOW = '0 1px 3px #000, 0 0 6px rgba(0,0,0,0.8)'

/**
 * Looping preview animations. One cycle is 3.4s; each word/char gets a
 * staggered animation-delay, so the words play in sequence and the
 * card loops. The motion mirrors what the worker burns onto the
 * video: pop = scale-in, karaoke = colour fill, sweep = highlight
 * box, bounce = drop with overshoot, type = char reveal, slam =
 * oversized slam, neon/outline/gradient = pop with their look.
 * Rendered once (see the samples section) — the cards just use the
 * class names.
 */
const PREVIEW_CSS = `
@keyframes cap-pop { 0% { opacity: 0; transform: scale(.3); } 7% { opacity: 1; transform: scale(1.15); } 12% { transform: scale(1); } 80% { opacity: 1; transform: scale(1); } 90%, 100% { opacity: 0; transform: scale(1); } }
@keyframes cap-bounce { 0% { opacity: 0; transform: translateY(-24px) scale(.8); } 8% { opacity: 1; transform: translateY(3px) scale(1.06); } 13% { transform: translateY(0) scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-karaoke { 0%, 16% { color: #fff; } 30%, 80% { color: #FACC15; } 90%, 100% { color: #fff; } }
@keyframes cap-sweep { 0%, 16% { background-color: transparent; color: #fff; } 30%, 80% { background-color: #FACC15; color: #000; } 90%, 100% { background-color: transparent; color: #fff; } }
@keyframes cap-type { 0% { opacity: 0; } 4% { opacity: 1; } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes cap-slam { 0% { opacity: 0; transform: scale(1.9); } 8% { opacity: 1; transform: scale(.93); } 12% { transform: scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-neon { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.3); } }
.cap-anim { display: inline-block; animation-duration: 3.4s; animation-iteration-count: infinite; animation-fill-mode: both; }
.cap-word-pop { animation-name: cap-pop; }
.cap-word-bounce { animation-name: cap-bounce; }
.cap-word-karaoke { animation-name: cap-karaoke; }
.cap-word-sweep { animation-name: cap-sweep; padding: 0 2px; border-radius: 3px; }
.cap-char-type { animation-name: cap-type; }
.cap-word-slam { animation-name: cap-slam; }
.cap-caret { display: inline-block; width: 2px; height: 1em; margin-left: 1px; vertical-align: -0.1em; background: #fff; animation: cap-caret 0.7s steps(1) infinite; }
.cap-neon-wrap { animation: cap-neon 1.6s ease-in-out infinite; }
`

const CYCLE = '3.4s'

/**
 * Live DOM preview of one caption style on a small 9:16 mock frame —
 * dark split background (streamer top, gameplay bottom), sample text
 * rendered in CSS approximating the real burned-in look. Animated
 * styles loop their motion (same words, same colours, same entrance
 * as the burned-in captions); static styles (title/subs) stay still.
 */
function CaptionStylePreview({ style }: { style: CaptionStyle }) {
  const words = style.sample.split(' ')
  const delay = (i: number, step: number) => ({ animationDelay: `${i * step}s` })

  /**
   * Words as animated spans with a real space BETWEEN them. The space
   * must sit outside the inline-block span — a trailing space inside
   * one collapses and the words run together.
   */
  const animatedWords = (
    className: string,
    step: number,
    wordStyle?: (word: string, i: number) => CSSProperties,
  ) =>
    words.map((word, i) => (
      <Fragment key={`${word}-${i}`}>
        <span
          className={`cap-anim ${className}`}
          style={{
            ...delay(i, step),
            animationDuration: CYCLE,
            ...(wordStyle ? wordStyle(word, i) : {}),
          }}
        >
          {word}
        </span>{' '}
      </Fragment>
    ))

  const frameClass =
    'absolute inset-x-1 top-1/2 -translate-y-1/2 text-center font-black uppercase leading-tight text-white'

  return (
    <span className="relative mx-auto block aspect-[9/16] w-full max-w-[150px] overflow-hidden rounded-lg border border-white/10">
      <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-[#3d2b63] to-[#241a3d]" />
      <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-[#14532d] to-[#052e16]" />
      <span className="absolute inset-x-0 top-1/2 h-px bg-white/25" />
      <span className="absolute left-1.5 top-1.5 text-[7px] font-semibold uppercase tracking-wide text-white/50">
        Streamer
      </span>
      <span className="absolute left-1.5 top-[calc(50%+5px)] text-[7px] font-semibold uppercase tracking-wide text-white/50">
        Gameplay
      </span>

      {style.anim === 'pop' ? (
        <span
          className={frameClass}
          style={{
            fontSize: style.id === 'word_pop' ? 30 : 15,
            lineHeight: style.id === 'word_pop' ? 1 : undefined,
            textShadow: OUTLINE_SHADOW,
          }}
        >
          {animatedWords('cap-word-pop', 0.32, (word) =>
            word === style.highlightWord ? { color: '#FACC15' } : {},
          )}
        </span>
      ) : null}

      {style.anim === 'karaoke' || style.anim === 'sweep' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords(style.anim === 'karaoke' ? 'cap-word-karaoke' : 'cap-word-sweep', 0.5)}
        </span>
      ) : null}

      {style.anim === 'bounce' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-bounce', 0.32)}
        </span>
      ) : null}

      {style.anim === 'typewriter' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {style.sample.split('').map((ch, i) =>
            ch === ' ' ? (
              <span key={`sp-${i}`}>{'\u00a0'}</span>
            ) : (
              <span
                key={`${ch}-${i}`}
                className="cap-anim cap-char-type"
                style={{ ...delay(i, 0.12), animationDuration: CYCLE }}
              >
                {ch}
              </span>
            ),
          )}
          <span className="cap-caret" />
        </span>
      ) : null}

      {style.anim === 'neon' ? (
        <span className="cap-neon-wrap absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[18px] font-black uppercase leading-tight">
          {animatedWords('cap-word-pop', 0.32, () => ({
            color: '#A5F3FC',
            textShadow: '0 0 6px #22D3EE, 0 0 14px #22D3EE, 0 0 22px #E879F9',
          }))}
        </span>
      ) : null}

      {style.anim === 'slam' ? (
        <span
          className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[30px] font-black uppercase leading-none text-white"
          style={{ textShadow: OUTLINE_SHADOW }}
        >
          <span className="cap-anim cap-word-slam" style={{ animationDuration: CYCLE }}>
            {style.sample}
          </span>
        </span>
      ) : null}

      {style.anim === 'outline' ? (
        <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[18px] font-black uppercase leading-tight">
          {animatedWords('cap-word-pop', 0.32, () => ({
            color: 'transparent',
            WebkitTextStroke: '1.5px #fff',
          }))}
        </span>
      ) : null}

      {style.anim === 'gradient' ? (
        <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[17px] font-black uppercase leading-tight">
          {animatedWords('cap-word-pop', 0.32, (_word, i) => ({
            color: (style.wordColors ?? ['#FACC15'])[
              i % (style.wordColors ?? ['#FACC15']).length
            ],
            textShadow: OUTLINE_SHADOW,
          }))}
        </span>
      ) : null}

      {style.anim === 'title' ? (
        <>
          <span className="absolute inset-x-2 top-1/2 -translate-y-1/2 rounded-md bg-white px-2 py-1.5 text-center text-[11px] font-black uppercase leading-tight text-black">
            {style.sample}
          </span>
          <span
            className="absolute inset-x-2 bottom-2 text-center text-[8px] leading-snug text-white"
            style={{ textShadow: SOFT_SHADOW }}
          >
            If we can get into the water, we swim for it.
          </span>
        </>
      ) : null}

      {style.anim === 'subs' ? (
        <span
          className="absolute inset-x-2 bottom-2 text-center text-[9px] leading-snug text-white"
          style={{ textShadow: SOFT_SHADOW }}
        >
          {style.sample}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Captions Studio — redesign (same-to-same as the design collage).
 * Style cards, the live preview and all controls below are real: they
 * restyle sample text in the browser. The thirteen worker styles at
 * the top are the styles the worker actually burns onto new jobs —
 * each sample loops its real animation, and clicking one saves it as
 * the default. "Apply to Clip" stays disabled: re-rendering a
 * finished clip with a new style is not built yet.
 * Layout follows the design reference: preset grid, a tall centre
 * preview, and a right-hand controls panel.
 */
export function CaptionsPage() {
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('project')
  const project = projectId ? getProject(projectId) : undefined
  const { token } = useAuth()

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
  const [selectedId, setSelectedId] = useState<string>('bold-pop')
  const active = CAPTION_PRESETS.find((p) => p.id === selectedId) ?? CAPTION_PRESETS[0]

  const [sampleText, setSampleText] = useState('Like & Subscribe!')
  const [fontFamily, setFontFamily] = useState<string>(active.fontFamily)
  const [fontSizePx, setFontSizePx] = useState<number>(active.fontSizePx)
  const [textColor, setTextColor] = useState<string>(active.color)
  const [highlightColor, setHighlightColor] = useState<string>(active.highlightColor)
  const [animation, setAnimation] = useState<AnimationChoice>(active.animation)

  const selectPreset = (id: string) => {
    const preset = CAPTION_PRESETS.find((p) => p.id === id)
    if (!preset) return
    setSelectedId(id)
    setFontFamily(preset.fontFamily)
    setFontSizePx(preset.fontSizePx)
    setTextColor(preset.color)
    setHighlightColor(preset.highlightColor)
    setAnimation(preset.animation)
  }

  // Highlight colour shows as the box behind "Highlight Box", the glow
  // colour for "Neon Glow", and an underline accent for other styles.
  const highlightStyle =
    active.id === 'highlight'
      ? { backgroundColor: highlightColor }
      : active.id === 'neon-glow'
        ? { textShadow: `0 0 12px ${highlightColor}, 0 0 32px ${highlightColor}` }
        : { textDecoration: 'underline', textDecorationColor: highlightColor, textUnderlineOffset: 8 }

  const preview = (
    <div className="relative mx-auto flex aspect-[9/16] w-full max-w-[280px] items-center justify-center overflow-hidden rounded-xl border border-white/10 px-4 text-center">
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
        className={`relative ${active.className} ${ANIMATION_CLASS[animation]} leading-snug`}
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
        <span className="text-sm font-medium text-white">Sample text</span>
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
        Highlight colour shows as the box behind Highlight Box, the glow for Neon Glow,
        and an underline accent for other styles.
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
        Re-rendering a finished clip with a new style is not built yet —
        new jobs use the default style you save above.
      </p>
    </div>
  )

  return (
    <div>
      <PageHeader
        title="Captions Studio"
        subtitle="Add stunning animated captions."
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
              className={`rounded-2xl border bg-ink-panel2 p-3 text-center transition-colors disabled:cursor-wait ${
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
            <Type className="h-5 w-5 text-brand-light" /> Preview — {active.label}
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
                {CAPTION_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => selectPreset(preset.id)}
                    aria-pressed={selectedId === preset.id}
                    className={`rounded-2xl border bg-ink-panel p-3 text-center transition-colors ${
                      selectedId === preset.id
                        ? 'border-brand ring-1 ring-brand'
                        : 'border-ink-border hover:border-brand/60'
                    }`}
                  >
                    <span
                      className={`flex h-16 items-center justify-center overflow-hidden text-lg leading-tight ${preset.className}`}
                    >
                      {preset.sample}
                    </span>
                    <span className="mt-2 block text-xs font-medium text-[var(--color-text-muted)]">
                      {preset.label}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                Selected style: <span className="font-medium text-white">{active.label}</span>.
                Design preview on sample text — the worker styles above are
                the ones actually burned onto new jobs.
              </p>
            </div>
          ) : null}

          <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Type className="h-5 w-5 text-brand-light" /> Preview
            </h2>
            <div className="mt-4">{preview}</div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Style: <span className="font-medium text-white">{active.label}</span>
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
