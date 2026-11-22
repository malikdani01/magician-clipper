import type { ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'

interface EmptyStateProps {
  title: string
  description: string
  action?: ReactNode
  icon?: ReactNode
}

/** Honest empty state used everywhere a list has no real data yet. */
export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-border bg-ink-panel px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-panel2 text-brand-light">
        {icon ?? <FolderOpen className="h-7 w-7" />}
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
