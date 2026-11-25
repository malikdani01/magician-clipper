import { useState, type FormEvent } from 'react'
import { PageHeader } from '../../components/PageHeader'
import {
  AdminTable,
  Cell,
  LoadError,
  LoadingNote,
  Pager,
  SourceNote,
  TableRow,
  formatDate,
  mutateAdmin,
  useAdminFetch,
  type Paginated,
} from './AdminPages'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AdminPlanRow {
  id: number
  name: string
  price_display: string
  duration_days: number
  total_clips: number | null
  daily_clips: number | null
  max_export_quality: string
  features: string[] | null
  active: boolean
  active_users?: number
  pending_requests?: number
  created_at: string
}

export interface AdminPlanRequestRow {
  id: number
  user_id: number
  plan_id: number
  note: string | null
  status: string
  decline_reason: string | null
  created_at: string
  user?: { id: number; name: string; email: string }
  plan?: { id: number; name: string; price_display: string; duration_days: number }
}

const inputClass =
  'w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none'
const selectClass =
  'rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none'
const btnPrimary =
  'rounded-xl bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40'
const btnGhost =
  'rounded-xl border border-ink-border bg-ink-panel px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-40'
const btnDanger =
  'rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40'

/* ------------------------------------------------------------------ */
/* Plans list + CRUD                                                   */
/* ------------------------------------------------------------------ */

interface PlanFormState {
  name: string
  price_display: string
  duration_days: string
  total_clips: string
  daily_clips: string
  max_export_quality: '720p' | '1080p'
  features: string
  active: boolean
}

const EMPTY_FORM: PlanFormState = {
  name: '',
  price_display: '',
  duration_days: '30',
  total_clips: '',
  daily_clips: '',
  max_export_quality: '720p',
  features: '',
  active: true,
}

function formToPayload(form: PlanFormState) {
  return {
    name: form.name.trim(),
    price_display: form.price_display.trim(),
    duration_days: Number(form.duration_days),
    total_clips: form.total_clips.trim() === '' ? null : Number(form.total_clips),
    daily_clips: form.daily_clips.trim() === '' ? null : Number(form.daily_clips),
    max_export_quality: form.max_export_quality,
    features: form.features
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
    active: form.active,
  }
}

function rowToForm(row: AdminPlanRow): PlanFormState {
  return {
    name: row.name,
    price_display: row.price_display,
    duration_days: String(row.duration_days),
    total_clips: row.total_clips === null ? '' : String(row.total_clips),
    daily_clips: row.daily_clips === null ? '' : String(row.daily_clips),
    max_export_quality: row.max_export_quality === '1080p' ? '1080p' : '720p',
    features: (row.features ?? []).join('\n'),
    active: row.active,
  }
}

export function AdminPlansPage() {
  const { data, loading, error, retry } = useAdminFetch<{ plans: AdminPlanRow[] }>('/admin/plans')
  const [editing, setEditing] = useState<AdminPlanRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [assignUserId, setAssignUserId] = useState('')
  const [assignPlanId, setAssignPlanId] = useState('')
  const [assignEndsAt, setAssignEndsAt] = useState('')
  const [assignError, setAssignError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)

  const plans = data?.plans ?? []

  function startCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setCreating(true)
  }

  function startEdit(row: AdminPlanRow) {
    setCreating(false)
    setForm(rowToForm(row))
    setFormError(null)
    setEditing(row)
  }

  async function saveForm(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!form.name.trim() || !form.price_display.trim()) {
      setFormError('Name and price are required.')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await mutateAdmin(`/admin/plans/${editing.id}`, 'PATCH', formToPayload(form))
        setNote(`Plan “${form.name.trim()}” updated.`)
      } else {
        await mutateAdmin('/admin/plans', 'POST', formToPayload(form))
        setNote(`Plan “${form.name.trim()}” created.`)
      }
      setEditing(null)
      setCreating(false)
      retry()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function deletePlan(row: AdminPlanRow) {
    if (!window.confirm(`Delete the “${row.name}” plan? This cannot be undone.`)) return
    setNote(null)
    try {
      await mutateAdmin(`/admin/plans/${row.id}`, 'DELETE')
      setNote(`Plan “${row.name}” deleted.`)
      retry()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  async function assignPlan(e: FormEvent) {
    e.preventDefault()
    setAssignError(null)
    setNote(null)
    const userId = Number(assignUserId)
    const planId = Number(assignPlanId)
    if (!userId || !planId) {
      setAssignError('Pick a plan and enter the user id.')
      return
    }
    setAssigning(true)
    try {
      await mutateAdmin(`/admin/users/${userId}/plans`, 'POST', {
        plan_id: planId,
        ...(assignEndsAt ? { ends_at: assignEndsAt } : {}),
      })
      setNote(`Plan assigned to user #${userId}. Any plan they had active ended early.`)
      setAssignUserId('')
      setAssignEndsAt('')
      retry()
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssigning(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Plans"
        subtitle="Paid plans, activated manually — a user requests a plan, you confirm the payment (outside the app) and approve it. No payment gateway exists in this app."
      />

      {note ? (
        <p role="status" className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
          {note}
        </p>
      ) : null}

      {loading ? (
        <LoadingNote />
      ) : error ? (
        <LoadError error={error} onRetry={retry} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={startCreate} className={btnPrimary}>
              + New plan
            </button>
            <p className="text-xs text-[var(--color-text-muted)]">
              {plans.length === 0
                ? 'No plans yet — users are on the Free plan (720p, 10 jobs a day).'
                : 'Leave Total clips / Daily clips empty for unlimited / the Free default.'}
            </p>
          </div>

          <AdminTable headers={['Plan', 'Price', 'Duration', 'Clips', 'Daily', 'Export', 'Users', 'Pending', 'Status', 'Actions']}>
            {plans.map((p) => (
              <TableRow key={p.id}>
                <Cell>
                  <span className="font-semibold">{p.name}</span>
                  {p.features && p.features.length > 0 ? (
                    <span className="block text-xs text-[var(--color-text-muted)]">{p.features.join(' · ')}</span>
                  ) : null}
                </Cell>
                <Cell>{p.price_display}</Cell>
                <Cell>{p.duration_days} days</Cell>
                <Cell>{p.total_clips === null ? 'Unlimited' : p.total_clips}</Cell>
                <Cell>{p.daily_clips === null ? 'Free default' : p.daily_clips}</Cell>
                <Cell>{p.max_export_quality}</Cell>
                <Cell>{p.active_users ?? 0}</Cell>
                <Cell>{p.pending_requests ?? 0}</Cell>
                <Cell>{p.active ? 'Active' : 'Inactive'}</Cell>
                <Cell>
                  <span className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => startEdit(p)} className={btnGhost}>
                      Edit
                    </button>
                    <button type="button" onClick={() => void deletePlan(p)} className={btnDanger}>
                      Delete
                    </button>
                  </span>
                </Cell>
              </TableRow>
            ))}
          </AdminTable>
          {plans.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">No plans yet.</p>
          ) : null}

          {(creating || editing) && (
            <form onSubmit={saveForm} className="mt-6 rounded-2xl border border-ink-border bg-ink-panel p-5">
              <h2 className="text-lg font-bold text-white">{editing ? `Edit “${editing.name}”` : 'New plan'}</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-white">Name</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Pro"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-white">Price (display only — no money moves in-app)</span>
                  <input
                    value={form.price_display}
                    onChange={(e) => setForm({ ...form, price_display: e.target.value })}
                    placeholder="Rs 499"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-white">Duration (days)</span>
                  <input
                    type="number"
                    min={1}
                    value={form.duration_days}
                    onChange={(e) => setForm({ ...form, duration_days: e.target.value })}
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-white">Total clips (empty = unlimited)</span>
                  <input
                    type="number"
                    min={1}
                    value={form.total_clips}
                    onChange={(e) => setForm({ ...form, total_clips: e.target.value })}
                    placeholder="e.g. 100"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-white">Daily jobs (empty = Free default)</span>
                  <input
                    type="number"
                    min={1}
                    value={form.daily_clips}
                    onChange={(e) => setForm({ ...form, daily_clips: e.target.value })}
                    placeholder="e.g. 20"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-white">Max export quality</span>
                  <select
                    value={form.max_export_quality}
                    onChange={(e) =>
                      setForm({ ...form, max_export_quality: e.target.value as '720p' | '1080p' })
                    }
                    className={selectClass}
                  >
                    <option value="720p">720p (Free tier)</option>
                    <option value="1080p">1080p</option>
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-sm font-medium text-white">Features (one per line)</span>
                  <textarea
                    rows={3}
                    value={form.features}
                    onChange={(e) => setForm({ ...form, features: e.target.value })}
                    placeholder={'1080p export\n100 clips'}
                    className={inputClass}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-white">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  />
                  Active (users can request it)
                </label>
              </div>
              {formError ? (
                <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
                  {formError}
                </p>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button type="submit" disabled={saving} className={btnPrimary}>
                  {saving ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false)
                    setEditing(null)
                  }}
                  className={btnGhost}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Assign a plan directly */}
          <form onSubmit={assignPlan} className="mt-6 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-lg font-bold text-white">Assign a plan to a user</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              No request needed. Any plan the user already has active ends early. Leave the end date empty for now +
              the plan&apos;s duration.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-sm font-medium text-white">User id</span>
                <input
                  type="number"
                  min={1}
                  value={assignUserId}
                  onChange={(e) => setAssignUserId(e.target.value)}
                  placeholder="e.g. 12"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-white">Plan</span>
                <select
                  value={assignPlanId}
                  onChange={(e) => setAssignPlanId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select a plan…</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.price_display}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-white">Custom end date (optional)</span>
                <input
                  type="date"
                  value={assignEndsAt}
                  onChange={(e) => setAssignEndsAt(e.target.value)}
                  className={inputClass}
                />
              </label>
              <button type="submit" disabled={assigning} className={btnPrimary}>
                {assigning ? 'Assigning…' : 'Assign plan'}
              </button>
            </div>
            {assignError ? (
              <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
                {assignError}
              </p>
            ) : null}
          </form>

          <SourceNote source="GET /admin/plans — plans table, with live active-user and pending-request counts." />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Plan requests                                                       */
/* ------------------------------------------------------------------ */

export function AdminPlanRequestsPage() {
  const [status, setStatus] = useState('pending')
  const [page, setPage] = useState(1)
  const query = new URLSearchParams({ page: String(page), ...(status ? { status } : {}) }).toString()
  const { data, loading, error, retry } = useAdminFetch<Paginated<AdminPlanRequestRow>>(
    `/admin/plan-requests?${query}`,
  )
  const [declineId, setDeclineId] = useState<number | null>(null)
  const [declineReason, setDeclineReason] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const rows = data?.data ?? []

  async function approve(row: AdminPlanRequestRow) {
    setNote(null)
    setBusyId(row.id)
    try {
      await mutateAdmin(`/admin/plan-requests/${row.id}/approve`, 'POST')
      setNote(`Approved — ${row.user?.name ?? `user #${row.user_id}`} now has the ${row.plan?.name ?? 'plan'} plan.`)
      retry()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function decline(row: AdminPlanRequestRow) {
    if (!declineReason.trim()) return
    setNote(null)
    setBusyId(row.id)
    try {
      await mutateAdmin(`/admin/plan-requests/${row.id}/decline`, 'POST', { reason: declineReason.trim() })
      setNote(`Declined — ${row.user?.name ?? `user #${row.user_id}`} will see the reason on their Plans page.`)
      setDeclineId(null)
      setDeclineReason('')
      retry()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Plan Requests"
        subtitle="Users ask for a paid plan here. Approve only after confirming the payment outside the app — approval activates the plan immediately."
      />

      {note ? (
        <p role="status" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {note}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          aria-label="Filter requests by status"
          className={selectClass}
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? (
        <LoadingNote />
      ) : error ? (
        <LoadError error={error} onRetry={retry} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No {status === 'pending' ? 'pending' : status} plan requests.
        </p>
      ) : (
        <>
          <AdminTable headers={['User', 'Plan', 'Note', 'Requested', 'Status', 'Actions']}>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <Cell>
                  <span className="font-semibold">{r.user?.name ?? `#${r.user_id}`}</span>
                  <span className="block text-xs text-[var(--color-text-muted)]">{r.user?.email ?? ''}</span>
                </Cell>
                <Cell>
                  {r.plan?.name ?? `#${r.plan_id}`}
                  <span className="block text-xs text-[var(--color-text-muted)]">{r.plan?.price_display ?? ''}</span>
                </Cell>
                <Cell muted>{r.note ?? '—'}</Cell>
                <Cell muted>{formatDate(r.created_at)}</Cell>
                <Cell>{r.status}</Cell>
                <Cell>
                  {r.status === 'pending' ? (
                    <span className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void approve(r)}
                        className={btnPrimary}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeclineId(r.id)
                          setDeclineReason('')
                        }}
                        className={btnDanger}
                      >
                        Decline
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {r.status === 'declined' && r.decline_reason ? r.decline_reason : '—'}
                    </span>
                  )}
                  {declineId === r.id ? (
                    <span className="mt-2 flex flex-col gap-2">
                      <input
                        value={declineReason}
                        onChange={(e) => setDeclineReason(e.target.value)}
                        placeholder="Reason — the user sees this"
                        aria-label="Decline reason"
                        className={inputClass}
                      />
                      <span className="flex gap-2">
                        <button
                          type="button"
                          disabled={!declineReason.trim() || busyId === r.id}
                          onClick={() => void decline(r)}
                          className={btnDanger}
                        >
                          Confirm decline
                        </button>
                        <button type="button" onClick={() => setDeclineId(null)} className={btnGhost}>
                          Cancel
                        </button>
                      </span>
                    </span>
                  ) : null}
                </Cell>
              </TableRow>
            ))}
          </AdminTable>
          <Pager page={page} lastPage={data?.last_page ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      )}
      <SourceNote source="GET /admin/plan-requests — plan_requests table with user + plan." />
    </div>
  )
}
