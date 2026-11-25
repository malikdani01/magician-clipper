import { Fragment, type CSSProperties } from 'react'
import type { CaptionStyle } from '../lib/captionStyles'

/**
 * Shared caption-style preview (Batch 8) — moved verbatim from
 * Captions.tsx so the style picker and Captions Studio render the
 * SAME preview from the SAME code: same words, same colours, same
 * motion. A style must look identical wherever it is picked.
 */

/** Thick black outline for burned-in captions (white text, black edge). */
export const OUTLINE_SHADOW =
  '2px 0 0 #000, -2px 0 0 #000, 0 2px 0 #000, 0 -2px 0 #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000'

export const SOFT_SHADOW = '0 1px 3px #000, 0 0 6px rgba(0,0,0,0.8)'

/**
 * Looping preview animations. One cycle is 3.4s; each word/char gets a
 * staggered animation-delay, so the words play in sequence and the
 * card loops. The motion mirrors what the worker burns onto the
 * video: pop = scale-in, karaoke = colour fill, sweep = highlight
 * box, bounce = drop with overshoot, type = char reveal, slam =
 * oversized slam, neon/outline/gradient = pop with their look,
 * kinetic = slide in from the left, glow_pop = pop with a gold glow,
 * word_zoom = land big then settle, word_fade = fade in,
 * highlight box = one word at a time in a yellow box (only the
 * current word shows), bounce pop = overshoot + undershoot settle,
 * glitch pop = magenta-cyan colour flicker on each word change
 * (libass cannot do a true RGB split — the burn flickers colours).
 * Rendered once (see the samples section) — the cards just use the
 * class names.
 */
export const PREVIEW_CSS = `
@keyframes cap-pop { 0% { opacity: 0; transform: scale(.3); } 7% { opacity: 1; transform: scale(1.15); } 12% { transform: scale(1); } 80% { opacity: 1; transform: scale(1); } 90%, 100% { opacity: 0; transform: scale(1); } }
@keyframes cap-bounce { 0% { opacity: 0; transform: translateY(-24px) scale(.8); } 8% { opacity: 1; transform: translateY(3px) scale(1.06); } 13% { transform: translateY(0) scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-karaoke { 0%, 16% { color: #fff; } 30%, 80% { color: #FACC15; } 90%, 100% { color: #fff; } }
@keyframes cap-sweep { 0%, 16% { background-color: transparent; color: #fff; } 30%, 80% { background-color: #FACC15; color: #000; } 90%, 100% { background-color: transparent; color: #fff; } }
@keyframes cap-type { 0% { opacity: 0; } 4% { opacity: 1; } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes cap-slam { 0% { opacity: 0; transform: scale(1.9); } 8% { opacity: 1; transform: scale(.93); } 12% { transform: scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-neon { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.3); } }
@keyframes cap-kinetic { 0% { opacity: 0; transform: translateX(-18px) scale(.85); } 8% { opacity: 1; transform: translateX(2px) scale(1.06); } 13% { transform: translateX(0) scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-glow-pop { 0% { opacity: 0; transform: scale(.3); text-shadow: 0 0 0 rgba(250,204,21,0); } 7% { opacity: 1; transform: scale(1.15); text-shadow: 0 0 8px #FACC15, 0 0 18px #FACC15; } 12% { transform: scale(1); text-shadow: 0 0 6px #FACC15, 0 0 14px #FACC15; } 80% { opacity: 1; transform: scale(1); text-shadow: 0 0 6px #FACC15, 0 0 14px #FACC15; } 90%, 100% { opacity: 0; } }
@keyframes cap-word-zoom { 0% { opacity: 1; transform: scale(1.2); } 10% { transform: scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-word-fade { 0% { opacity: 0; } 12% { opacity: 1; } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-highlight-sweep { 0%, 16% { opacity: 0; background-color: transparent; } 30%, 80% { opacity: 1; background-color: #FACC15; color: #000; } 90%, 100% { opacity: 0; background-color: transparent; } }
@keyframes cap-bounce-in { 0% { opacity: 0; transform: scale(0); } 7% { opacity: 1; transform: scale(1.18); } 12% { transform: scale(.95); } 17% { transform: scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
@keyframes cap-glitch-pop { 0% { opacity: 0; transform: scale(1.12); color: #FF00FF; } 5% { opacity: 1; transform: scale(1.12); color: #FF00FF; } 10% { color: #00FFFF; transform: scale(1.05); } 15% { color: #fff; transform: scale(1); } 80% { opacity: 1; } 90%, 100% { opacity: 0; } }
.cap-anim { display: inline-block; animation-duration: 3.4s; animation-iteration-count: infinite; animation-fill-mode: both; }
.cap-word-pop { animation-name: cap-pop; }
.cap-word-bounce { animation-name: cap-bounce; }
.cap-word-kinetic { animation-name: cap-kinetic; }
.cap-word-glow-pop { animation-name: cap-glow-pop; }
.cap-word-karaoke { animation-name: cap-karaoke; }
.cap-word-sweep { animation-name: cap-sweep; padding: 0 2px; border-radius: 3px; }
.cap-char-type { animation-name: cap-type; }
.cap-word-slam { animation-name: cap-slam; }
.cap-word-zoom { animation-name: cap-word-zoom; }
.cap-word-fade { animation-name: cap-word-fade; }
.cap-word-highlight-sweep { animation-name: cap-highlight-sweep; padding: 0 2px; border-radius: 3px; }
.cap-word-bounce-in { animation-name: cap-bounce-in; }
.cap-word-glitch-pop { animation-name: cap-glitch-pop; }
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
export function CaptionStylePreview({ style }: { style: CaptionStyle }) {
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
    <span className="relative mx-auto block aspect-[9/16] w-full max-w-[150px] overflow-hidden rounded-lg border border-white/10 caption-preview">
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

      {style.anim === 'kinetic' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-kinetic', 0.32)}
        </span>
      ) : null}

      {style.anim === 'glow_pop' ? (
        <span className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-[18px] font-black uppercase leading-tight text-white">
          {animatedWords('cap-word-glow-pop', 0.32)}
        </span>
      ) : null}

      {/* Batch 3 (2026-11-25): word zoom / word fade / highlight box /
          bounce pop / glitch pop — each loops the real motion the
          worker burns in. */}
      {style.anim === 'word_zoom' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-zoom', 0.32)}
        </span>
      ) : null}

      {style.anim === 'word_fade' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-fade', 0.32)}
        </span>
      ) : null}

      {style.anim === 'highlight_sweep' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-highlight-sweep', 0.5)}
        </span>
      ) : null}

      {style.anim === 'bounce_in' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-bounce-in', 0.32)}
        </span>
      ) : null}

      {style.anim === 'glitch_pop' ? (
        <span className={`${frameClass} text-[15px]`} style={{ textShadow: OUTLINE_SHADOW }}>
          {animatedWords('cap-word-glitch-pop', 0.32)}
        </span>
      ) : null}

      {/* Batch 6 (2026-11-25): platform styles — TikTok Bold pops the
          whole phrase in, bigger than Punchy, keyword in yellow;
          Reels Clean and Shorts Minimal are still by design (the
          worker burns them with no motion either). */}
      {style.anim === 'tiktok_bold' ? (
        <span
          className={frameClass}
          style={{ fontSize: 18, textShadow: OUTLINE_SHADOW }}
        >
          {animatedWords('cap-word-pop', 0.32, (word) =>
            word === style.highlightWord ? { color: '#FACC15' } : {},
          )}
        </span>
      ) : null}

      {style.anim === 'reels_clean' ? (
        <span
          className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[13px] font-bold leading-snug text-white"
          style={{ textShadow: SOFT_SHADOW }}
        >
          {style.sample}
        </span>
      ) : null}

      {style.anim === 'shorts_minimal' ? (
        <span
          className="absolute inset-x-2 top-1/2 -translate-y-1/2 text-center text-[11px] font-semibold leading-snug text-white"
          style={{ textShadow: SOFT_SHADOW }}
        >
          {style.sample}
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

