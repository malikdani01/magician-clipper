import { useEffect, useState } from 'react'
import { AlertTriangle, SlidersHorizontal } from 'lucide-react'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import {
  LoadError,
  LoadingNote,
  SourceNote,
  fetchAdmin,
  mutateAdmin,
  useAdminFetch,
} from './AdminPages'

/* ------------------------------------------------------------------ */
/* Platform Controls (Batch 10, Phase 2)                               */
/* ------------------------------------------------------------------ */

interface PlatformSettingsPayload {
  limits: {
    free_daily_limit: number
    max_clips_per_job: number
    max_bulk_files: number
    max_upload_mb: number
  }
  features: Record<string, boolean>
  pages: Record<string, boolean>
  maintenance: { enabled: boolean; message: string }
  announcement: string
}

const FEATURE_LABELS: [string, string][] = [
  ['captions', 'Captions'],
  ['on_screen_text', 'On-screen text'],
  ['beat_sync', 'Beat sync'],
  ['translation', 'Translation (captions + on-screen text)'],
  ['logo_overlay', 'Logo overlay'],
  ['intro_outro', 'Intro & outro videos'],
  ['music_bed_sfx', 'Music bed + sound effects'],
  ['cloud_storage', 'Cloud storage (R2 / S3)'],
  ['bulk_jobs', 'Bulk jobs'],
  ['clip_rerender', 'Clip re-render'],
  ['favourites', 'Favourites'],
  ['thumbnail_picker', 'Thumbnail picker'],
]

const PAGE_LABELS: [string, string][] = [
  ['library', 'Video Library'],
  ['brand_kit', 'Brand Kit'],
  ['exports', 'Export History'],
  ['usage', 'Usage & Credits'],
  ['help', 'Help & Support'],
  ['editor', 'Studio Editor'],
]

const LIMIT_LABELS: [keyof PlatformSettingsPayload['limits'], string, string][] = [
  ['free_daily_limit', 'Free daily job limit', 'Jobs a free user can create per day (1–1000). Admins are exempt.'],
  ['max_clips_per_job', 'Max clips per job', 'Largest clip count a job can request (1–200).'],
  ['max_bulk_files', 'Max bulk files', 'Most files in one bulk job request (1–20).'],
  ['max_upload_mb', 'Max upload size (MB)', 'Largest source video upload (1–2048 MB — the server cap).'],
]

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#8b5cf6]"
      />
      <span>
        <span className="block text-sm font-medium text-white">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">{hint}</span> : null}
      </span>
    </label>
  )
}

export function AdminPlatformPage() {
  const { data, loading, error, retry } = useAdminFetch<PlatformSettingsPayload>(
    '/admin/platform-settings',
  )
  const [form, setForm] = useState<PlatformSettingsPayload | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (data && form === null) setForm(data)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  function update(patch: Partial<PlatformSettingsPayload>) {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setDirty(true)
    setNotice(null)
  }

  async function save() {
    if (!form) return
    setSaving(true)
    setSaveError(null)
    setNotice(null)
    try {
      const saved = await mutateAdmin<PlatformSettingsPayload>(
        '/admin/platform-settings',
        'PATCH',
        form,
      )
      setForm(saved)
      setDirty(false)
      setNotice('Platform settings saved — they apply immediately and are enforced server-side.')
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function reloadDefaults() {
    // Re-read the server state (discards unsaved edits).
    const fresh = await fetchAdmin<PlatformSettingsPayload>('/admin/platform-settings')
    setForm(fresh)
    setDirty(false)
    setNotice(null)
    setSaveError(null)
  }

  return (
    <div>
      <PageHeader
        title="Platform Controls"
        subtitle="Limits, feature toggles, page visibility, maintenance mode and the announcement banner. Every setting is enforced server-side — hiding a control in the user panel is never the only enforcement."
        icon={<SlidersHorizontal className="h-5 w-5" />}
      />

      {loading ? <LoadingNote /> : null}
      {error ? <LoadError error={error} onRetry={retry} /> : null}
      {notice ? (
        <div className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm font-medium text-emerald-300">
          {notice}
        </div>
      ) : null}
      {saveError ? (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm font-medium text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {saveError}
        </div>
      ) : null}

      {form ? (
        <>
          <section className="rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Limits</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Per-user overrides (set on a user&apos;s detail page) replace these defaults for that user only.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {LIMIT_LABELS.map(([key, label, hint]) => (
                <label key={key} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-white">{label}</span>
                  <input
                    type="number"
                    value={form.limits[key]}
                    onChange={(e) =>
                      update({
                        limits: { ...form.limits, [key]: Number(e.target.value) },
                      })
                    }
                    className="w-40 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Feature toggles</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Off means the user panel hides the control <em>and</em> the API rejects the request with a clear error.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {FEATURE_LABELS.map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={form.features[key] ?? true}
                  onChange={(v) =>
                    update({ features: { ...form.features, [key]: v } })
                  }
                />
              ))}
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Page visibility</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Hide whole user-panel pages. Dashboard, AI Clipper, My Projects and Settings are always visible.
              The four pages hidden in Batch 9 (New Job, Projects, Captions Studio, Create Project) stay hidden
              forever and are not listed here.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {PAGE_LABELS.map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={form.pages[key] ?? true}
                  onChange={(v) => update({ pages: { ...form.pages, [key]: v } })}
                />
              ))}
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Maintenance mode</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              While on, the user panel shows the message and new job creation is blocked (API 503). Reads keep working.
            </p>
            <div className="mt-4 space-y-3">
              <Toggle
                label="Maintenance mode on"
                checked={form.maintenance.enabled}
                onChange={(v) =>
                  update({ maintenance: { ...form.maintenance, enabled: v } })
                }
              />
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-white">Message shown to users</span>
                <textarea
                  value={form.maintenance.message}
                  onChange={(e) =>
                    update({
                      maintenance: { ...form.maintenance, message: e.target.value },
                    })
                  }
                  rows={2}
                  maxLength={500}
                  className="w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
                />
              </label>
            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-5">
            <h2 className="text-base font-semibold text-white">Announcement banner</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Shown on the user Dashboard until cleared. Empty = no banner.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={form.announcement}
                onChange={(e) => update({ announcement: e.target.value })}
                placeholder="e.g. New: 1080p exports are live!"
                maxLength={500}
                className="min-w-64 flex-1 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                disabled={form.announcement === ''}
                onClick={() => update({ announcement: '' })}
                className="rounded-xl border border-ink-border bg-ink-panel px-4 py-2.5 text-sm font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </section>

          <div className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel/95 p-4 backdrop-blur-xl">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save platform settings'}
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void reloadDefaults()}
              className="rounded-xl border border-ink-border bg-ink-panel px-4 py-2.5 text-sm font-medium text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-40"
            >
              Discard changes
            </button>
            {dirty ? (
              <span className="text-sm text-amber-300">Unsaved changes.</span>
            ) : (
              <span className="text-sm text-[var(--color-text-muted)]">All changes saved.</span>
            )}
          </div>
        </>
      ) : !loading && !error ? (
        <EmptyState
          title="No platform settings"
          description="The settings endpoint returned nothing. Try reloading."
          icon={<SlidersHorizontal className="h-7 w-7" />}
        />
      ) : null}
      <SourceNote source="Laravel /api/v1/admin/platform-settings" />
    </div>
  )
}
