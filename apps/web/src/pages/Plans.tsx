import { useEffect, useState } from 'react'
import { Check, Crown, Lock } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import {
  fetchMyPlan,
  fetchMyPlanRequests,
  fetchPlans,
  requestPlan,
  type MyPlanSummary,
  type PlanInfo,
  type PlanRequestInfo,
} from '../lib/api'

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function statusPill(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
    case 'declined':
      return 'bg-red-500/15 text-red-300 ring-red-500/30'
    default:
      return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
  }
}

/**
 * Plans (Batch 11) — the user's plan page.
 *
 * Free is the default (limits from the platform settings); paid
 * plans are requested here and activated by the admin after the
 * payment — which happens outside the app. There is no checkout,
 * no card handling, no payment gateway anywhere in this flow.
 * Export tiers: Free caps at 720p, paid plans go to 1080p.
 */
export function PlansPage() {
  const [plans, setPlans] = useState<PlanInfo[]>([])
  const [summary, setSummary] = useState<MyPlanSummary | null>(null)
  const [requests, setRequests] = useState<PlanRequestInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [requestingId, setRequestingId] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [p, s, r] = await Promise.all([fetchPlans(), fetchMyPlan(), fetchMyPlanRequests()])
      setPlans(p)
      setSummary(s)
      setRequests(r)
    } catch {
      setError('Could not load plans. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function onRequest(plan: PlanInfo) {
    setNotice(null)
    setError(null)
    setRequestingId(plan.id)
    const result = await requestPlan(plan.id)
    setRequestingId(null)
    if (!result.ok) {
      setError(result.error ?? 'Request failed.')
      return
    }
    setNotice(`Request sent for the ${plan.name} plan — the admin will activate it after confirming your payment.`)
    void load()
  }

  const current = summary?.current
  const pendingPlanIds = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.plan_id))
  const freeExportHeight = 720

  return (
    <div>
      <PageHeader
        title="Plans"
        subtitle="Free to start — upgrade when you need more clips, a higher daily limit or 1080p exports. Payment happens outside the app: request a plan and the admin activates it after confirming your payment."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Loading plans…</p>
      ) : (
        <>
          {/* Current plan */}
          <section aria-label="Current plan" className="mb-6 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-muted)]">
                  <Crown className="h-4 w-4 text-brand-light" /> Current plan
                </p>
                <h2 className="mt-1 text-xl font-bold text-white">{current?.name ?? 'Free'}</h2>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {current?.name === 'Free' || !current?.ends_at
                    ? 'The free plan — limits come from the platform defaults.'
                    : `Active until ${formatDate(current.ends_at)}`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-white">{current?.price_display ?? 'Free'}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Export up to {current?.max_export_quality ?? '720p'}
                </p>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-ink-panel2 px-3 py-2.5">
                <dt className="text-xs text-[var(--color-text-muted)]">Clips used</dt>
                <dd className="mt-0.5 text-sm font-semibold text-white">
                  {current?.clips_used === null || current?.clips_used === undefined
                    ? '—'
                    : `${current.clips_used}${current.total_clips !== null && current.total_clips !== undefined ? ` / ${current.total_clips}` : ''}`}
                </dd>
              </div>
              <div className="rounded-xl bg-ink-panel2 px-3 py-2.5">
                <dt className="text-xs text-[var(--color-text-muted)]">Clips remaining</dt>
                <dd className="mt-0.5 text-sm font-semibold text-white">
                  {current?.clips_remaining === null || current?.clips_remaining === undefined
                    ? 'No lifetime limit'
                    : current.clips_remaining}
                </dd>
                {current?.clips_reserved ? (
                  <dd className="text-xs text-[var(--color-text-muted)]">
                    {current.clips_reserved} promised by jobs in progress
                  </dd>
                ) : null}
              </div>
              <div className="rounded-xl bg-ink-panel2 px-3 py-2.5">
                <dt className="text-xs text-[var(--color-text-muted)]">Daily job limit</dt>
                <dd className="mt-0.5 text-sm font-semibold text-white">
                  {summary?.limits.daily_limit === null ? 'Unlimited' : summary?.limits.daily_limit}
                </dd>
              </div>
              <div className="rounded-xl bg-ink-panel2 px-3 py-2.5">
                <dt className="text-xs text-[var(--color-text-muted)]">Max clips per job</dt>
                <dd className="mt-0.5 text-sm font-semibold text-white">
                  {summary?.limits.max_clips_per_job ?? '—'}
                </dd>
              </div>
            </dl>

            {summary?.precedence ? (
              <p className="mt-4 text-xs text-[var(--color-text-muted)]">{summary.precedence}</p>
            ) : null}
          </section>

          {/* Available plans */}
          {plans.length === 0 ? (
            <EmptyState
              title="No paid plans yet"
              description="The admin has not created any paid plans. You are on the Free plan — 720p exports, 10 jobs a day."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => {
                const isCurrent = current?.plan_id === plan.id
                const pending = pendingPlanIds.has(plan.id)
                const locked1080 =
                  plan.max_export_quality === '1080p' &&
                  (summary?.limits.max_export_height ?? freeExportHeight) < 1080
                return (
                  <article
                    key={plan.id}
                    className={`flex flex-col rounded-2xl border bg-ink-panel p-5 ${
                      isCurrent ? 'border-brand/60' : 'border-ink-border'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                      {isCurrent ? (
                        <span className="rounded-full bg-brand/15 px-2.5 py-1 text-xs font-semibold text-brand-light ring-1 ring-brand/30">
                          Current plan
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-2xl font-bold text-white">{plan.price_display}</p>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      {plan.duration_days} days ·{' '}
                      {plan.total_clips === null ? 'Unlimited clips' : `${plan.total_clips} clips total`} ·{' '}
                      {plan.daily_clips === null ? 'Free daily limit' : `${plan.daily_clips} jobs a day`}
                    </p>
                    <p className="mt-2 flex items-center gap-1.5 text-sm text-white">
                      Export up to {plan.max_export_quality}
                      {locked1080 ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                          <Lock className="h-3.5 w-3.5" /> Locked until you upgrade
                        </span>
                      ) : null}
                    </p>
                    {plan.features && plan.features.length > 0 ? (
                      <ul className="mt-3 space-y-1.5">
                        {plan.features.map((f) => (
                          <li key={f} className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                            {f}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-4 flex-1" />
                    <button
                      type="button"
                      disabled={isCurrent || pending || requestingId === plan.id}
                      onClick={() => void onRequest(plan)}
                      className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isCurrent
                        ? 'Your current plan'
                        : pending
                          ? 'Request pending — waiting on the admin'
                          : requestingId === plan.id
                            ? 'Sending request…'
                            : `Request ${plan.name}`}
                    </button>
                  </article>
                )
              })}
            </div>
          )}

          {/* My requests */}
          {requests.length > 0 ? (
            <section aria-label="My plan requests" className="mt-8">
              <h2 className="text-lg font-bold text-white">My requests</h2>
              <ul className="mt-3 space-y-2">
                {requests.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-border bg-ink-panel px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {r.plan?.name ?? 'Plan'} · {r.plan?.price_display ?? ''}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Requested {formatDate(r.created_at)}
                        {r.status === 'declined' && r.decline_reason ? ` — ${r.decline_reason}` : ''}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusPill(r.status)}`}
                    >
                      {r.status === 'pending' ? 'Pending' : r.status === 'approved' ? 'Approved' : 'Declined'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
