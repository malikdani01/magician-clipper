import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  /** Optional icon shown in a purple chip left of the title (admin dashboard style). */
  icon?: ReactNode
}

export function PageHeader({ title, subtitle, actions, icon }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c3aed] via-[#d946ef] to-[#22d3ee] text-white shadow-aurora">
            {icon}
          </span>
        ) : null}
        <div>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
