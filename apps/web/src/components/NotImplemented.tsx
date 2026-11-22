import { Clock } from 'lucide-react'

interface NotImplementedProps {
  /** Which phase the feature is planned for, e.g. "Phase 2". */
  phase?: string
  /** Optional extra explanation. */
  detail?: string
}

/**
 * Badge + note shown next to any control that needs a backend/engine
 * that does not exist yet. Such controls are disabled, never fake.
 */
export function NotImplemented({ phase = 'Phase 2/3', detail }: NotImplementedProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
      <Clock className="h-3.5 w-3.5" />
      Not implemented yet ({phase})
      {detail ? <span className="font-normal text-amber-200/80">— {detail}</span> : null}
    </span>
  )
}
