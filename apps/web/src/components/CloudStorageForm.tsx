/**
 * Batch 5 (2026-11-25): Cloud Storage settings form (Settings → Cloud Storage).
 *
 * The user fills in their OWN S3-compatible account — no account is
 * created here. Cloudflare R2's free tier (10 GB storage, no egress
 * fees) covers this use; keys come from the Cloudflare dashboard →
 * R2 → Manage R2 API Tokens. The secret is stored ENCRYPTED on the
 * backend and is never shown again — the field only overwrites it
 * when the user types a new one.
 *
 * "Test connection" really tries the bucket (put + read + delete a
 * tiny test object) and reports the real outcome. "Use cloud storage"
 * stays OFF until the user turns it on — until then, and whenever
 * cloud is off or unconfigured, everything works on the local disk
 * exactly as before.
 */
import { useEffect, useState } from 'react'
import { Cloud, Loader2 } from 'lucide-react'
import {
  CLOUD_PROVIDERS,
  getCloudStorage,
  saveCloudStorage,
  testCloudStorage,
  type CloudProvider,
} from '../lib/cloudStorage'
import { usePreferences } from '../state/preferences'

const inputClass =
  'mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'

export function CloudStorageForm() {
  const { t } = usePreferences()
  const [provider, setProvider] = useState<CloudProvider>('r2')
  const [endpoint, setEndpoint] = useState('')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('auto')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [secretSaved, setSecretSaved] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    getCloudStorage()
      .then((saved) => {
        if (cancelled || !saved) return
        setProvider(saved.provider)
        setEndpoint(saved.endpoint ?? '')
        setBucket(saved.bucket)
        setRegion(saved.region)
        setAccessKeyId(saved.access_key_id)
        setSecretSaved(saved.secret_saved)
        setEnabled(saved.enabled)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load cloud storage settings.')
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const providerHint = CLOUD_PROVIDERS.find((p) => p.id === provider)?.endpointHint ?? ''

  async function save() {
    setSaveMessage(null)
    setSaveError(null)
    setTestResult(null)
    setSaving(true)
    const result = await saveCloudStorage({
      provider,
      endpoint: endpoint.trim(),
      bucket: bucket.trim(),
      region: region.trim(),
      access_key_id: accessKeyId.trim(),
      secret_access_key: secret,
      enabled,
    })
    setSaving(false)
    if (!result.ok) {
      setSaveError(result.error ?? 'Could not save cloud storage settings.')
      return
    }
    setSecret('')
    setSecretSaved(result.settings?.secret_saved ?? secretSaved)
    setSaveMessage('Cloud storage settings saved.')
  }

  async function test() {
    setTestResult(null)
    setTesting(true)
    const result = await testCloudStorage()
    setTesting(false)
    setTestResult(result)
  }

  if (!loaded) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading cloud storage settings…
      </p>
    )
  }

  return (
    <div className="max-w-lg">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Cloud className="h-5 w-5 text-brand-light" /> {t('tabCloudStorage')}
      </h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t('cloudStorageDesc')}</p>
      <div className="mt-4 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3 text-sm leading-relaxed text-[var(--color-text-muted)]">
        <p className="font-medium text-white">Where to get the keys</p>
        <p className="mt-1">
          Cloudflare R2 (free tier — 10 GB storage, no egress fees): Cloudflare dashboard → R2 →
          Manage R2 API Tokens → Create API Token. The token gives you an Access Key ID, a Secret
          Access Key, and your account&apos;s endpoint URL
          (https://&lt;account-id&gt;.r2.cloudflarestorage.com). AWS S3 needs no endpoint — just
          the bucket name, region and an IAM access key.
        </p>
      </div>
      {loadError ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {loadError}
        </p>
      ) : null}

      <div className="mt-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudProvider')}</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as CloudProvider)}
            className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
          >
            {CLOUD_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudEndpoint')}</span>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={providerHint}
            disabled={provider === 's3'}
            className={inputClass}
          />
          {provider === 's3' ? (
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              AWS S3 uses the SDK default endpoint — no URL needed.
            </span>
          ) : null}
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudBucket')}</span>
          <input
            type="text"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="magician-clipper-clips"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudRegion')}</span>
          <input
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="auto"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudAccessKey')}</span>
          <input
            type="text"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-white">{t('cloudSecretKey')}</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={secretSaved ? t('secretSaved') : 'Paste the secret access key'}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
            Stored encrypted on the server. It is never shown again — leave this empty to keep the
            saved secret.
          </span>
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-3">
          <span className="text-sm font-medium text-white">{t('cloudEnabled')}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-5 w-5 accent-[var(--color-primary)]"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : t('saveChanges')}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          className="rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-semibold text-white hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing ? t('testingConnection') : t('testConnection')}
        </button>
      </div>

      {saveMessage ? (
        <p className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
          {saveMessage}
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          {saveError}
        </p>
      ) : null}
      {testResult ? (
        <p
          role="status"
          className={`mt-3 rounded-xl border px-3 py-2.5 text-sm ${
            testResult.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-300'
          }`}
        >
          {testResult.ok ? t('connectionOk') : `${t('connectionFailed')}: ${testResult.message}`}
        </p>
      ) : null}
    </div>
  )
}
