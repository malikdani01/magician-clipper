import { useEffect, useState } from 'react'
import { Bell, Cloud, CreditCard, HardDrive, ShieldCheck, SlidersHorizontal, User } from 'lucide-react'
import { API_URL } from '../lib/api'
import { CAPTION_STYLES, getCaptionStyle, isCaptionStyleId } from '../lib/captionStyles'
import { formatBytes } from '../lib/format'
import { useAuth } from '../state/auth'
import { useProjects } from '../state/projects'
import { NotImplemented } from '../components/NotImplemented'
import { CloudStorageForm } from '../components/CloudStorageForm'
import { LANGUAGES, THEMES, type TranslationKey } from '../lib/i18n'
import { usePreferences } from '../state/preferences'
import { PageHeader } from '../components/PageHeader'

type SettingsTab = 'profile' | 'security' | 'notifications' | 'preferences' | 'storage' | 'cloud' | 'billing'

const TABS: { id: SettingsTab; labelKey: TranslationKey; icon: typeof User }[] = [
  { id: 'profile', labelKey: 'tabProfile', icon: User },
  { id: 'security', labelKey: 'tabSecurity', icon: ShieldCheck },
  { id: 'notifications', labelKey: 'tabNotifications', icon: Bell },
  { id: 'preferences', labelKey: 'tabPreferences', icon: SlidersHorizontal },
  { id: 'storage', labelKey: 'tabStorage', icon: HardDrive },
  { id: 'cloud', labelKey: 'tabCloudStorage', icon: Cloud },
  { id: 'billing', labelKey: 'tabBilling', icon: CreditCard },
]

const LOCAL_KEY = 'magician-clipper.settings.v1'

interface LocalSettings {
  name: string
  email: string
  notifications: { jobComplete: boolean; jobFailed: boolean; productNews: boolean }
  preferences: { defaultExportFormat: string; captionsByDefault: boolean }
}

const DEFAULT_LOCAL: LocalSettings = {
  name: '',
  email: '',
  notifications: { jobComplete: true, jobFailed: true, productNews: false },
  preferences: { defaultExportFormat: 'mp4', captionsByDefault: true },
}

function loadLocal(): LocalSettings {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (!raw) return DEFAULT_LOCAL
    const parsed = JSON.parse(raw) as Partial<LocalSettings>
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
      notifications: { ...DEFAULT_LOCAL.notifications, ...(parsed.notifications ?? {}) },
      preferences: { ...DEFAULT_LOCAL.preferences, ...(parsed.preferences ?? {}) },
    }
  } catch {
    return DEFAULT_LOCAL
  }
}

function saveLocal(settings: LocalSettings) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(settings))
  } catch {
    // Storage unavailable — the in-memory values still apply for this tab.
  }
}

const inputClass =
  'mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Settings — redesign (same-to-same as the design collage).
 * Profile save hits the real PATCH /api/v1/settings, which now stores
 * name/email on the account for real (the endpoint used to silently
 * drop them). Signed out, settings are stored in this browser only
 * and labelled as such. Notifications and preferences are
 * browser-local. Password change has no backend endpoint and stays
 * disabled. Billing does not exist.
 */
export function SettingsPage() {
  const { user, token, refreshUser } = useAuth()
  const { theme, language, setTheme, setLanguage, t } = usePreferences()
  const { projects } = useProjects()
  const [tab, setTab] = useState<SettingsTab>('profile')
  const [local, setLocal] = useState<LocalSettings>(loadLocal)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)

  // Batch 9 (2026-11-25): the default caption style moved here from
  // the hidden Captions Studio page — same behaviour: GET on mount,
  // PATCH { caption_style } on change, and the wizard pre-selects
  // the saved default for new jobs.
  const [defaultCaptionStyle, setDefaultCaptionStyle] = useState<string>('punchy')
  const [defaultStyleMessage, setDefaultStyleMessage] = useState<string | null>(null)
  const [defaultStyleError, setDefaultStyleError] = useState<string | null>(null)
  const [savingDefaultStyle, setSavingDefaultStyle] = useState(false)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const body = (await res.json()) as { settings?: { caption_style?: unknown } }
        if (!cancelled && isCaptionStyleId(body.settings?.caption_style)) {
          setDefaultCaptionStyle(body.settings.caption_style)
        }
      } catch {
        // Backend unreachable — keep the 'punchy' default.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  async function saveDefaultCaptionStyle(id: string) {
    setDefaultStyleMessage(null)
    setDefaultStyleError(null)
    if (!token) {
      setDefaultStyleError('Sign in to save a default caption style.')
      return
    }
    setSavingDefaultStyle(true)
    try {
      const res = await fetch(`${API_URL}/settings`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ caption_style: id }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) {
        const message =
          body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
        setDefaultStyleError(message)
        return
      }
      setDefaultCaptionStyle(id)
      setDefaultStyleMessage(
        `Default caption style saved — new jobs will use ${getCaptionStyle(id).name}.`,
      )
    } catch (e) {
      setDefaultStyleError(e instanceof Error ? e.message : 'Could not reach the backend.')
    } finally {
      setSavingDefaultStyle(false)
    }
  }

  // Real on-disk storage (uploaded sources + rendered clips) from the
  // server; falls back to the browser project sum while loading.
  const [serverStorageBytes, setServerStorageBytes] = useState<number | null>(null)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/me/stats`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const body = (await res.json()) as { storage_bytes?: unknown }
        if (!cancelled && typeof body.storage_bytes === 'number') {
          setServerStorageBytes(body.storage_bytes)
        }
      } catch {
        // Backend unreachable — the browser-local sum below stands in.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  // Prefill from the signed-in account when available, else the browser copy.
  useEffect(() => {
    setName(user?.name ?? local.name)
    setEmail(user?.email ?? local.email)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  function updateLocal(next: LocalSettings) {
    setLocal(next)
    saveLocal(next)
  }

  async function saveProfile() {
    setProfileMessage(null)
    setProfileError(null)
    if (!user || !token) {
      updateLocal({ ...local, name, email })
      setProfileMessage('Saved in this browser — account sync pending (sign in).')
      return
    }
    setSavingProfile(true)
    try {
      const res = await fetch(`${API_URL}/settings`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, email }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) {
        const message =
          body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
        setProfileError(message)
        return
      }
      setProfileMessage('Profile saved to your account.')
      await refreshUser()
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : 'Could not reach the backend.')
    } finally {
      setSavingProfile(false)
    }
  }

  const storageUsedBytes =
    serverStorageBytes ?? projects.reduce((sum, p) => sum + (p.fileSize ?? 0), 0)
  const quotaMb = user?.storage_quota_mb

  return (
    <div>
      <PageHeader title={t('settingsTitle')} subtitle={t('settingsSubtitle')} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="lg:col-span-1">
          <div
            className="flex flex-col gap-1 rounded-2xl border border-ink-border bg-ink-panel p-3"
            role="tablist"
            aria-label="Settings sections"
          >
            {TABS.map((tabItem) => (
              <button
                key={tabItem.id}
                type="button"
                role="tab"
                aria-selected={tab === tabItem.id}
                onClick={() => setTab(tabItem.id)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                  tab === tabItem.id
                    ? 'bg-brand text-white'
                    : 'text-[var(--color-text-muted)] hover:bg-ink-panel2 hover:text-white'
                }`}
              >
                <tabItem.icon className="h-4 w-4 shrink-0" />
                {t(tabItem.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-3">
        {tab === 'profile' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Profile settings</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {user
                ? `Signed in as ${user.email} (${user.role}, ${user.plan} plan). Saving attempts the real backend settings endpoint.`
                : 'Not signed in — changes are saved in this browser only until you sign in.'}
            </p>
            <div className="mt-5 flex items-center gap-4">
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-xl font-bold text-white">
                {(name || user?.name || 'G').trim().charAt(0).toUpperCase() || 'G'}
              </span>
              <div>
                <button
                  type="button"
                  disabled
                  title="Profile photo upload needs backend media storage — not implemented yet"
                  className="cursor-not-allowed rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2 text-sm font-medium text-[var(--color-text-muted)]"
                >
                  Change Photo
                </button>
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  Photo upload is not implemented yet — the initial above stands
                  in for your avatar.
                </p>
              </div>
            </div>
            <div className="mt-5 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-white">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-white">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className={inputClass}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={saveProfile}
              disabled={savingProfile}
              className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savingProfile ? 'Saving…' : 'Save Changes'}
            </button>
            {profileMessage ? (
              <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
                {profileMessage}
              </p>
            ) : null}
            {profileError ? (
              <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
                {profileError}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === 'security' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Security</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {user
                ? `Signed in as ${user.email}.`
                : 'Sign in to manage account security.'}
            </p>
            <div className="mt-5 space-y-4 opacity-50">
              <label className="block">
                <span className="text-sm font-medium text-white">Current password</span>
                <input type="password" disabled className={inputClass} />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-white">New password</span>
                <input type="password" disabled className={inputClass} />
              </label>
            </div>
            <button
              type="button"
              disabled
              className="mt-5 cursor-not-allowed rounded-xl bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-[var(--color-text-muted)]"
            >
              Change Password
            </button>
            <div className="mt-3">
              <NotImplemented phase="Not built" detail="password change endpoint does not exist yet" />
            </div>
          </div>
        ) : null}

        {tab === 'notifications' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Notifications</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Saved in this browser — account sync pending (sign in).
            </p>
            <div className="mt-5 space-y-3">
              {(
                [
                  ['jobComplete', 'Job completed'],
                  ['jobFailed', 'Job failed'],
                  ['productNews', 'Product news and updates'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
                  <span className="text-sm font-medium text-white">{label}</span>
                  <input
                    type="checkbox"
                    checked={local.notifications[key]}
                    onChange={(e) =>
                      updateLocal({
                        ...local,
                        notifications: { ...local.notifications, [key]: e.target.checked },
                      })
                    }
                    className="h-5 w-5 accent-[var(--color-primary)]"
                  />
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {tab === 'preferences' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Preferences</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Saved in this browser — account sync pending (sign in).
            </p>
            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
                <h3 className="text-sm font-semibold text-white">{t('appearance')}</h3>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-sm font-medium text-white">{t('themeLabel')}</span>
                    <select
                      value={theme}
                      onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
                      className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                    >
                      {THEMES.map((th) => (
                        <option key={th.id} value={th.id}>
                          {t(th.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium text-white">{t('languageLabel')}</span>
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value as 'en' | 'ur')}
                      className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                    >
                      {LANGUAGES.map((lang) => (
                        <option key={lang.id} value={lang.id}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Saved to your account when you are signed in, and in this browser otherwise.
                </p>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-white">Default export format</span>
                <select
                  value={local.preferences.defaultExportFormat}
                  onChange={(e) =>
                    updateLocal({
                      ...local,
                      preferences: { ...local.preferences, defaultExportFormat: e.target.value },
                    })
                  }
                  className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
                >
                  <option value="mp4">MP4</option>
                  <option value="webm">WebM</option>
                  <option value="mov">MOV</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
                <span className="text-sm font-medium text-white">Captions on by default</span>
                <input
                  type="checkbox"
                  checked={local.preferences.captionsByDefault}
                  onChange={(e) =>
                    updateLocal({
                      ...local,
                      preferences: { ...local.preferences, captionsByDefault: e.target.checked },
                    })
                  }
                  className="h-5 w-5 accent-[var(--color-primary)]"
                />
              </label>
              <div>
                <label className="block">
                  <span className="text-sm font-medium text-white">Default caption style</span>
                  <select
                    value={defaultCaptionStyle}
                    disabled={savingDefaultStyle}
                    onChange={(e) => void saveDefaultCaptionStyle(e.target.value)}
                    aria-label="Default caption style"
                    className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {CAPTION_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  New jobs in the AI Clipper start with this style. Saved to your account.
                </p>
                {defaultStyleMessage ? (
                  <p className="mt-2 text-sm text-emerald-300">{defaultStyleMessage}</p>
                ) : null}
                {defaultStyleError ? (
                  <p className="mt-2 text-sm text-red-300">{defaultStyleError}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'storage' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Storage</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Storage used:{' '}
              <span className="font-medium text-white">
                {storageUsedBytes === 0 ? '0 GB' : formatBytes(storageUsedBytes)}
              </span>
              {storageUsedBytes === 0 ? ' — no uploads or clips yet.' : ` across your projects and clips.`}
              {typeof quotaMb === 'number' ? ` Plan quota: ${quotaMb} MB.` : ''}
            </p>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              {serverStorageBytes !== null
                ? 'Counted from the real files on the server (uploaded sources + rendered clips).'
                : 'Counted from the real file sizes of your projects in this browser.'}
            </p>
          </div>
        ) : null}

        {tab === 'cloud' ? (
          <CloudStorageForm />
        ) : null}

        {tab === 'billing' ? (
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-white">Billing</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Not enabled — billing does not exist yet. Plans, payments and
              subscriptions do not exist yet.
            </p>
            <div className="mt-4">
              <NotImplemented phase="Not built" detail="billing does not exist yet" />
            </div>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  )
}
