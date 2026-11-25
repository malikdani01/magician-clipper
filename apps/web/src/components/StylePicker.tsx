import { Check } from 'lucide-react'
import {
  CAPTION_STYLES,
  fontForHeadlineStyle,
  isCaptionStyleAnimated,
  type CaptionStyle,
} from '../lib/captionStyles'
import {
  HEADLINE_STYLE_BEST_FOR,
  HEADLINE_STYLE_DESCRIPTIONS,
  HEADLINE_STYLE_LABELS,
  type HeadlineStyle,
} from '../lib/jobs'
import { CaptionStylePreview, OUTLINE_SHADOW, PREVIEW_CSS, PreviewBackdrop } from './CaptionStylePreview'

/**
 * Visual style pickers (Batch 8, 2026-11-25; redesigned Batch 9,
 * 2026-11-25) — the fix for the plain dropdowns. Each style is a CARD
 * with a live preview, name, description, Motion/Static badge and a
 * "Best for" line; the selected card gets the brand gradient border
 * plus a checkmark. The caption preview is the shared
 * CaptionStylePreview — the same component Captions Studio uses — so
 * a style looks identical wherever it is picked. Cards are real
 * <button>s (keyboard + screen reader usable, aria-pressed), never
 * divs with onClick. Style names/descriptions stay English even in
 * Roman Urdu mode: video text is never translated.
 *
 * Batch 9 redesign: TWO cards per row on EVERY screen size (the old
 * 1-column phone layout is what the user disliked), so the picker
 * reads like a style gallery; cards stay compact so two fit a 390px
 * phone. Every sample sits on the shared Aurora gradient backdrop —
 * the split streamer/gameplay frame is gone.
 */

const SELECTED_WRAP =
  'rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 p-[2px]'

function MotionBadge({ animated }: { animated: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        animated
          ? 'bg-violet-500/20 text-violet-300'
          : 'bg-white/10 text-[var(--color-text-muted)]'
      }`}
    >
      {animated ? 'Motion' : 'Static'}
    </span>
  )
}

function CardCheck() {
  return (
    <span
      aria-hidden="true"
      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow"
    >
      <Check className="h-4 w-4" />
    </span>
  )
}

/**
 * Caption style card picker. `options` defaults to all 25 styles;
 * the wizard passes its 18 legacy presets mapped to real styles.
 * `currentId` marks one style as the clip's current style (re-render
 * picker): it shows a "Current style" pill and cannot be picked.
 */
export function CaptionStylePicker({
  value,
  onChange,
  disabled = false,
  options = CAPTION_STYLES,
  currentId,
}: {
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  options?: CaptionStyle[]
  currentId?: string
}) {
  return (
    <div>
      <style>{PREVIEW_CSS}</style>
      <div
        role="group"
        aria-label="Caption style"
        className={`grid grid-cols-2 gap-2.5 sm:gap-3 ${disabled ? 'opacity-60' : ''}`}
      >
        {options.map((style) => {
          const selected = value === style.id
          const isCurrent = currentId === style.id
          const animated = isCaptionStyleAnimated(style)
          return (
            <div key={style.id} className={selected ? SELECTED_WRAP : undefined}>
              <button
                type="button"
                onClick={() => onChange(style.id)}
                disabled={disabled || isCurrent}
                aria-pressed={selected}
                aria-label={
                  isCurrent
                    ? `${style.name} caption style (current style, not selectable)`
                    : `Use ${style.name} caption style`
                }
                className={`relative flex w-full flex-col rounded-2xl border bg-ink-panel2 p-2.5 text-left transition-colors disabled:cursor-not-allowed sm:p-3 ${
                  selected
                    ? 'rounded-[14px] border-transparent'
                    : 'border-ink-border hover:border-brand/60'
                }`}
              >
                {selected ? <CardCheck /> : null}
                <span
                  className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${selected ? 'pr-8' : ''}`}
                >
                  <span className="text-[13px] font-semibold leading-tight text-white sm:text-sm">{style.name}</span>
                  <span className="flex items-center gap-1.5">
                    {isCurrent ? (
                      <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-white">
                        Current style
                      </span>
                    ) : null}
                    <MotionBadge animated={animated} />
                  </span>
                </span>
                <span className="mx-auto mt-2 block w-full max-w-[104px] sm:max-w-[132px]">
                  <CaptionStylePreview style={style} />
                </span>
                <span className="mt-2 block text-[11px] leading-snug text-[var(--color-text-muted)] sm:text-xs sm:leading-relaxed">
                  {style.description}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-[var(--color-text-muted)] sm:text-xs">
                  Best for: <span className="text-white/80">{style.bestFor}</span>
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Still sample text for the headline cards (Batch 8). */
const HEADLINE_SAMPLE = "LET'S TRY TO MAKE IT COUNT."

const HEADLINE_STYLES: HeadlineStyle[] = ['bold_bar', 'lower_third', 'big_centre']

/**
 * Headline style card picker — the SAME card treatment as captions,
 * but STATIC by design (user request 2026-11-25 ~12:01 PKT): each
 * card shows a still sample of that headline layout on the shared
 * Aurora gradient backdrop, nothing animates, nothing plays. Two
 * cards per row on every screen size, like the caption picker
 * (Batch 9 redesign).
 */
export function HeadlineStylePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: HeadlineStyle
  onChange: (style: HeadlineStyle) => void
  disabled?: boolean
}) {
  return (
    <div
      role="group"
      aria-label="Headline style"
      className={`grid grid-cols-2 gap-2.5 sm:gap-3 ${disabled ? 'opacity-60' : ''}`}
    >
      {HEADLINE_STYLES.map((style) => {
        const selected = value === style
        // Batch 9 FONT MAP: each headline sample renders in its own
        // typeface — the same font the worker burns in.
        const hFont = fontForHeadlineStyle(style)
        const hFontCss = {
          fontFamily: hFont.family,
          fontWeight: hFont.weight,
          fontStyle: hFont.style,
        } as const
        return (
          <div key={style} className={selected ? SELECTED_WRAP : undefined}>
            <button
              type="button"
              onClick={() => onChange(style)}
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`Use ${HEADLINE_STYLE_LABELS[style]} headline style`}
              className={`relative flex w-full flex-col rounded-2xl border bg-ink-panel2 p-2.5 text-left transition-colors disabled:cursor-not-allowed sm:p-3 ${
                selected
                  ? 'rounded-[14px] border-transparent'
                  : 'border-ink-border hover:border-brand/60'
              }`}
            >
              {selected ? <CardCheck /> : null}
              <span
                className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${selected ? 'pr-8' : ''}`}
              >
                <span className="text-[13px] font-semibold leading-tight text-white sm:text-sm">
                  {HEADLINE_STYLE_LABELS[style]}
                </span>
                <MotionBadge animated={false} />
              </span>
              <span className="relative mx-auto mt-2 block aspect-[9/16] w-full max-w-[104px] overflow-hidden rounded-lg border border-white/10 caption-preview sm:max-w-[132px]">
                <PreviewBackdrop />
                {style === 'bold_bar' ? (
                  <span
                    className="absolute inset-x-2 top-2 rounded bg-black/70 px-2 py-1 text-center text-[11px] font-black uppercase leading-tight text-white"
                    style={hFontCss}
                  >
                    {HEADLINE_SAMPLE}
                  </span>
                ) : null}
                {style === 'lower_third' ? (
                  <span
                    className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1.5 text-center text-[10px] font-bold uppercase leading-tight text-white"
                    style={hFontCss}
                  >
                    {HEADLINE_SAMPLE}
                  </span>
                ) : null}
                {style === 'big_centre' ? (
                  <span
                    className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[15px] font-black uppercase leading-tight text-white"
                    style={{ ...hFontCss, textShadow: OUTLINE_SHADOW }}
                  >
                    {HEADLINE_SAMPLE}
                  </span>
                ) : null}
              </span>
              <span className="mt-2 block text-[11px] leading-snug text-[var(--color-text-muted)] sm:text-xs sm:leading-relaxed">
                {HEADLINE_STYLE_DESCRIPTIONS[style]}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-[var(--color-text-muted)] sm:text-xs">
                Best for:{' '}
                <span className="text-white/80">{HEADLINE_STYLE_BEST_FOR[style]}</span>
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
