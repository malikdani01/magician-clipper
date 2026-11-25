import { Check } from 'lucide-react'
import { LAYOUT_LABELS, type ClipLayout } from '../lib/jobs'

/**
 * Layout card picker (Batch 9, 2026-11-25) — the wizard's layout
 * control, built on the same card system as the caption picker
 * (StylePicker): TWO cards per row on every screen size, gradient
 * border + checkmark on the selected card, compact so two fit a 390px
 * phone. Each card shows a schematic mini-preview — a CSS diagram of
 * the frame COMPOSITION (where the video sits, where the bars/panel/
 * frame go), not a video frame — so the preview is honest about what
 * it shows. The real render is proven by the worker pixel tests.
 *
 * Single source of truth is LAYOUT_LABELS (lib/jobs.ts): this picker
 * renders all 10 layouts from it, in that order.
 */

const SELECTED_WRAP =
  'rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-400 p-[2px]'

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

/** Schematic 9:16 composition diagram for one layout. */
function LayoutMiniPreview({ layout }: { layout: ClipLayout }) {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto aspect-[9/16] w-[72px] overflow-hidden rounded-[6px] bg-black sm:w-[84px]"
    >
      {layout === 'center_crop' ? (
        <>
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500" />
          <div className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25" />
        </>
      ) : layout === 'split' ? (
        <>
          <div className="absolute inset-x-0 top-0 h-[45%] bg-violet-500" />
          <div className="absolute inset-x-0 bottom-0 h-[55%] bg-emerald-500" />
          <div className="absolute inset-x-0 top-[45%] h-px bg-white/70" />
        </>
      ) : layout === 'pip_facecam' ? (
        <>
          <div className="absolute inset-0 bg-emerald-500" />
          <div className="absolute right-1 top-1 h-5 w-7 rounded-[2px] border border-white/85 bg-violet-400" />
        </>
      ) : layout === 'blur_fill' ? (
        <>
          <div className="absolute inset-0 scale-110 bg-gradient-to-br from-indigo-500 to-fuchsia-500 blur-[6px]" />
          <div className="absolute inset-x-0 top-[22%] h-[56%] bg-indigo-300" />
        </>
      ) : layout === 'streamer_full' ? (
        <>
          <div className="absolute inset-0 bg-violet-500" />
          <div className="absolute left-1/2 top-[38%] h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-300" />
        </>
      ) : layout === 'gradient_fill' ? (
        <>
          <div className="absolute inset-0 bg-[linear-gradient(155deg,#1e1b4b,#4c1d95,#7c3aed,#c026d3,#db2777)]" />
          <div className="absolute inset-x-0 top-[22%] h-[56%] bg-indigo-400" />
        </>
      ) : layout === 'stacked' ? (
        <>
          <div className="absolute inset-x-0 top-0 h-[65%] bg-emerald-500" />
          <div className="absolute inset-x-0 bottom-0 h-[35%] bg-slate-900" />
          <div className="absolute bottom-[22%] left-[12%] h-[3px] w-[76%] rounded bg-white/70" />
          <div className="absolute bottom-[12%] left-[12%] h-[3px] w-[55%] rounded bg-white/40" />
        </>
      ) : layout === 'letterbox' ? (
        <>
          <div className="absolute inset-0 bg-black" />
          <div className="absolute inset-x-0 top-[34%] h-[32%] bg-emerald-500" />
        </>
      ) : layout === 'face_closeup' ? (
        <>
          <div className="absolute inset-0 bg-indigo-950" />
          <div className="absolute bottom-0 left-1/2 h-[28%] w-[80%] -translate-x-1/2 rounded-t-full bg-violet-400" />
          <div className="absolute left-1/2 top-[42%] h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-200/90" />
        </>
      ) : (
        // framed
        <>
          <div className="absolute inset-0 bg-slate-900" />
          <div className="absolute inset-[6%] rounded-[2px] border-2 border-white/85 bg-indigo-400" />
        </>
      )}
    </div>
  )
}

export function LayoutPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ClipLayout
  onChange: (id: ClipLayout) => void
  disabled?: boolean
}) {
  const ids = Object.keys(LAYOUT_LABELS) as ClipLayout[]
  return (
    <div
      role="group"
      aria-label="Clip layout"
      className={`grid grid-cols-2 gap-2.5 sm:gap-3 ${disabled ? 'opacity-60' : ''}`}
    >
      {ids.map((id) => {
        const selected = value === id
        const [name, desc] = LAYOUT_LABELS[id].split(' — ')
        return (
          <div key={id} className={selected ? SELECTED_WRAP : undefined}>
            <button
              type="button"
              onClick={() => onChange(id)}
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`Use ${LAYOUT_LABELS[id]} layout`}
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
                  {name}
                </span>
              </span>
              <span className="mt-2 flex justify-center">
                <LayoutMiniPreview layout={id} />
              </span>
              {desc ? (
                <span className="mt-2 text-[11px] leading-snug text-[var(--color-text-muted)] sm:text-xs">
                  {desc}
                </span>
              ) : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}
