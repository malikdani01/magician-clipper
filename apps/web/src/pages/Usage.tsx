import { useEffect, useState } from 'react'
import { Coins, Crown, HardDrive } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { StatCard } from '../components/StatCard'
import { formatBytes } from '../lib/format'
import { API_URL, getStoredUser, getToken } from '../lib/api'
import { useProjects } from '../state/projects'

/**
 * Usage & Credits — Phase 2.
 * No credits system exists yet, so nothing is invented: usage is 0 and
 * the remaining balance is honestly shown as "not enabled". Storage is
 * the canonical server total (rendered clips + source files) — the same
 * number the dashboard shows. The plan comes from the stored
 * signed-in user when there is one; otherwise it is honestly "Free
 * Plan — not signed in".
 */
export function UsagePage() {
  const { projects } = useProjects()
  const [stats, setStats] = useState<{ storage_bytes: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    const token = getToken()
    if (token) {
      fetch(`${API_URL}/me/stats`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!cancelled && body) setStats(body as { storage_bytes: number })
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [])

  // Canonical storage total from the server; falls back to the browser
  // project store's sum only while stats are loading.
  const storageBytes = stats?.storage_bytes ?? projects.reduce((sum, p) => sum + (p.fileSize || 0), 0)

  const storedUser = getStoredUser() as { plan?: string } | null
  const planLabel =
    storedUser && typeof storedUser.plan === 'string' && storedUser.plan
      ? storedUser.plan
      : 'Free Plan — not signed in'

  return (
    <div>
      <PageHeader title="Usage & Credits" subtitle="Track your plan usage and credits." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Credits used"
          value="0"
          sublabel="Nothing processed yet"
          icon={<Coins className="h-5 w-5" />}
          accent="#7C3AED"
        />
        <StatCard
          label="Credits remaining"
          value="—"
          sublabel="Credits system not enabled yet"
          icon={<Crown className="h-5 w-5" />}
          accent="#2563EB"
        />
        <StatCard
          label="Storage used"
          value={formatBytes(storageBytes)}
          sublabel={
            storageBytes === 0
              ? 'Nothing uploaded yet'
              : 'Sources + rendered clips on disk'
          }
          icon={<HardDrive className="h-5 w-5" />}
          accent="#059669"
        />
      </div>

      <div className="mt-6 rounded-2xl border border-ink-border bg-ink-panel p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-white">Current plan</h2>
          <span className="rounded-full bg-brand/15 px-3 py-1 text-xs font-semibold capitalize text-brand-light">
            {storedUser?.plan ?? 'Free'}
          </span>
        </div>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          {planLabel}
          {storedUser
            ? ' — plan comes from your signed-in account.'
            : ' — sign in to see your account plan. No plan limits are enforced and no credits have been issued.'}
        </p>
        <button
          type="button"
          disabled
          title="Upgrades are not enabled — billing does not exist yet"
          className="mt-4 cursor-not-allowed rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white opacity-40"
        >
          Upgrade Plan
        </button>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Upgrades are not enabled — billing does not exist yet.
        </p>
      </div>
    </div>
  )
}
