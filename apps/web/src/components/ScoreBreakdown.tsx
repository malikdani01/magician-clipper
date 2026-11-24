/**
 * Viral score breakdown — labelled bars for one clip's per-signal
 * scores (label -> 0-100), as sent by the worker. Shown only when the
 * clip carries a breakdown; older clips (null) render nothing at all.
 * The bars are the worker's own signal values, not a new estimate.
 */

const BAR_TONE: Record<string, string> = {
  Speech: 'from-[#7c3aed] to-[#d946ef]',
  Coverage: 'from-[#0891b2] to-[#22d3ee]',
  Completeness: 'from-[#059669] to-[#34d399]',
  Silence: 'from-[#64748b] to-[#94a3b8]',
  Energy: 'from-[#ea580c] to-[#f59e0b]',
  Gameplay: 'from-[#7c3aed] to-[#22d3ee]',
  Stability: 'from-[#4f46e5] to-[#818cf8]',
}

function barClass(label: string): string {
  return BAR_TONE[label] ?? 'from-[#7c3aed] to-[#d946ef]'
}

export function ScoreBreakdown({
  breakdown,
}: {
  breakdown: Record<string, number> | null | undefined
}) {
  if (!breakdown || Object.keys(breakdown).length === 0) return null
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1])
  return (
    <div className="mt-2 w-full">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Why this score
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {entries.map(([label, value]) => {
          const v = Math.max(0, Math.min(100, Math.round(value)))
          return (
            <li key={label} className="flex items-center gap-2 text-xs">
              <span className="w-24 shrink-0 truncate text-[var(--color-text-muted)]">
                {label}
              </span>
              <span
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-label={`${label} ${v} out of 100`}
                aria-valuenow={v}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  className={`block h-full rounded-full bg-gradient-to-r ${barClass(label)}`}
                  style={{ width: `${v}%` }}
                />
              </span>
              <span className="w-7 shrink-0 text-right font-semibold tabular-nums text-white">
                {v}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
