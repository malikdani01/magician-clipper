/**
 * Tiny SVG charts (no chart library) — sparklines, area charts and ring
 * gauges, all drawn from real counts. Used by the admin dashboard to
 * match the design reference (stat-card sparklines, Analytics Overview
 * area chart, Server Resource Usage rings) without faking any data.
 */

function pointsToPath(points: number[], width: number, height: number, pad = 2): string {
  if (points.length === 0) return ''
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = Math.max(1, max - min)
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0
  return points
    .map((v, i) => {
      const x = pad + i * step
      const y = height - pad - ((v - min) / span) * (height - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** Small sparkline for a stat card (last N daily counts). */
export function Sparkline({
  points,
  color,
  width = 96,
  height = 36,
}: {
  points: number[]
  color: string
  width?: number
  height?: number
}) {
  if (points.length < 2) return null
  const line = pointsToPath(points, width, height)
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      role="img"
      aria-label="Trend"
    >
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path
        d={`${line} L${width - 2},${height} L2,${height} Z`}
        fill={color}
        opacity="0.12"
      />
    </svg>
  )
}

/** Area chart with a gradient fill, for the Analytics Overview card. */
export function AreaChart({
  points,
  color,
  height = 220,
  labels,
}: {
  points: number[]
  color: string
  height?: number
  /** [first, last] x-axis labels (dates). */
  labels?: [string, string]
}) {
  const width = 720
  if (points.length < 2) {
    return (
      <p className="py-10 text-center text-sm text-[var(--color-text-muted)]">
        Not enough data to chart yet — values appear as activity happens.
      </p>
    )
  }
  const line = pointsToPath(points, width, height, 4)
  const max = Math.max(...points)
  const id = `area-${color.replace(/[^a-z0-9]/gi, '')}`
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Daily values, peak ${max}`}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={width}
            y1={height * f}
            y2={height * f}
            stroke="#26264A"
            strokeWidth="1"
          />
        ))}
        <path d={`${line} L${width - 4},${height} L4,${height} Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        {points.map((v, i) => {
          if (v !== max) return null
          const x = 4 + (i * (width - 8)) / (points.length - 1)
          const y = height - 4 - (v / Math.max(1, max)) * (height - 8)
          return <circle key={i} cx={x} cy={y} r="4" fill={color} stroke="#0B0B1E" strokeWidth="2" />
        })}
      </svg>
      {labels ? (
        <div className="mt-1 flex justify-between text-xs text-[var(--color-text-muted)]">
          <span>{labels[0]}</span>
          <span>{labels[1]}</span>
        </div>
      ) : null}
    </div>
  )
}

/** Ring gauge (0-100%) with a centre label, for Server Resource Usage. */
export function RingGauge({
  value,
  color,
  label,
  sublabel,
}: {
  value: number | null
  color: string
  label: string
  sublabel?: string
}) {
  const r = 34
  const c = 2 * Math.PI * r
  const shown = value === null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <div className="relative h-20 w-20">
        <svg viewBox="0 0 84 84" className="h-full w-full -rotate-90" role="img" aria-label={`${label} ${value === null ? 'unavailable' : `${value}%`}`}>
          <circle cx="42" cy="42" r={r} fill="none" stroke="#26264A" strokeWidth="8" />
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(shown / 100) * c} ${c}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-bold leading-none text-white">
            {value === null ? '—' : `${Math.round(value)}%`}
          </span>
          <span className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{label}</span>
        </div>
      </div>
      {sublabel ? (
        <span className="text-[11px] text-[var(--color-text-muted)]">{sublabel}</span>
      ) : null}
    </div>
  )
}
