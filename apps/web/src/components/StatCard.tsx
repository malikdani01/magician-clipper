import type { ReactNode } from 'react'
import { Sparkline } from './charts'

interface StatCardProps {
  label: string
  value: string
  sublabel?: string
  icon: ReactNode
  accent?: string
  /** Optional gradient (two CSS colours) for the card background, e.g. the admin metric cards. */
  gradient?: string
  /**
   * 30-day growth vs the previous 30 days, in percent. `null` means the
   * metric is new (no prior baseline); `undefined` hides the line.
   * Never faked: it comes from the admin API's real counts.
   */
  growthPct?: number | null
  /** Daily counts for the sparkline (last 14 days). */
  spark?: number[]
  sparkColor?: string
}

/**
 * A stat card — icon chip on the left, label + big value on the right,
 * matching the design-reference stat cards (user dashboard + admin
 * dashboard). Phase 1 values are all real zeros for a new account.
 * With growthPct/spark it also shows the design's green/red growth
 * line and the small trend sparkline, both from real data.
 */
export function StatCard({ label, value, sublabel, icon, accent, gradient, growthPct, spark, sparkColor }: StatCardProps) {
  const growthText =
    growthPct === undefined
      ? null
      : growthPct === null
        ? 'New in the last 30 days'
        : `${growthPct > 0 ? '↑' : growthPct < 0 ? '↓' : '→'} ${Math.abs(growthPct)}% vs prev. 30 days`
  const growthClass =
    growthPct === null || growthPct === undefined
      ? 'text-[var(--color-text-muted)]'
      : growthPct > 0
        ? 'text-emerald-300'
        : growthPct < 0
          ? 'text-red-300'
          : 'text-[var(--color-text-muted)]'

  return (
    <div
      className="aurora-card rounded-2xl border border-ink-border bg-ink-panel p-5 shadow-card backdrop-blur-xl"
      style={gradient ? { background: gradient } : undefined}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-aurora"
          style={
            accent
              ? { backgroundColor: accent }
              : { backgroundImage: 'var(--aurora-gradient)' }
          }
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--color-text-muted)]">{label}</p>
          <p className="mt-0.5 text-2xl font-bold leading-tight text-white">{value}</p>
          {sublabel ? (
            <p className="mt-0.5 text-xs leading-snug text-[var(--color-text-muted)]">{sublabel}</p>
          ) : null}
        </div>
      </div>
      {growthText || (spark && spark.length > 1) ? (
        <div className="mt-3 flex items-end justify-between gap-3">
          {growthText ? (
            <p className={`text-xs font-semibold leading-snug ${growthClass}`}>{growthText}</p>
          ) : (
            <span />
          )}
          {spark && spark.length > 1 ? (
            <Sparkline points={spark} color={sparkColor ?? '#FFFFFF'} width={84} height={34} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
