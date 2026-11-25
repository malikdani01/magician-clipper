import { useEffect, useRef, useState } from 'react'
import { Check, Clapperboard, ImagePlus, Loader2, Palette, RotateCcw, Save, Trash2, Upload } from 'lucide-react'
import {
  CAPTION_STYLES,
  getCaptionStyle,
  translateLegacyCaptionPreset,
} from '../lib/captionStyles'
import {
  BRAND_LOGO_MAX_BYTES,
  deleteBrandAsset,
  fetchBrandAssetFile,
  listBrandAssets,
  uploadBrandAsset,
  type BrandAsset,
  type BrandAssetKind,
} from '../lib/brandAssets'
import { formatBytes, formatDuration } from '../lib/format'
import { PageHeader } from '../components/PageHeader'
import { usePreferences } from '../state/preferences'

const STORAGE_KEY = 'magician-clipper.brand-kit.v1'

interface BrandKitSaved {
  brandName: string
  primary: string
  accent: string
  font: string
  defaultCaptionPreset: string
}

const DEFAULTS: BrandKitSaved = {
  brandName: '',
  primary: '#7C3AED',
  accent: '#8B5CF6',
  font: 'Inter',
  defaultCaptionPreset: 'punchy',
}

function loadSaved(): BrandKitSaved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<BrandKitSaved>
    return {
      brandName: typeof parsed.brandName === 'string' ? parsed.brandName : DEFAULTS.brandName,
      primary: typeof parsed.primary === 'string' ? parsed.primary : DEFAULTS.primary,
      accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULTS.accent,
      font: typeof parsed.font === 'string' ? parsed.font : DEFAULTS.font,
      defaultCaptionPreset:
        // The stored value is a REAL caption style id. Older saves
        // hold a legacy wizard preset id (bold-pop, ...) — translate
        // it to its real style; anything unknown falls back to Punchy.
        typeof parsed.defaultCaptionPreset === 'string'
          ? translateLegacyCaptionPreset(parsed.defaultCaptionPreset)
          : DEFAULTS.defaultCaptionPreset,
    }
  } catch {
    return DEFAULTS
  }
}

/**
 * Intro & outro assets — real uploads to the backend (POST
 * /api/v1/brand-kit/assets, mp4/mov/webm ≤50 MB, ≤15 s). One asset per
 * kind; uploading a kind that already has one replaces it. The worker
 * adds the assets to clips of NEW jobs only — existing clips are
 * unchanged.
 */
function IntroOutroAssets() {
  const [assets, setAssets] = useState<BrandAsset[]>([])
  const { t } = usePreferences()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploadingKind, setUploadingKind] = useState<BrandAssetKind | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const introInputRef = useRef<HTMLInputElement>(null)
  const outroInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    listBrandAssets()
      .then((rows) => {
        if (!cancelled) setAssets(rows)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your intro/outro assets.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const assetFor = (kind: BrandAssetKind) => assets.find((a) => a.kind === kind)

  const handleUpload = async (kind: BrandAssetKind, file: File | undefined) => {
    if (!file) return
    setUploadingKind(kind)
    setUploadError(null)
    const result = await uploadBrandAsset(kind, file)
    setUploadingKind(null)
    if (!result.ok) {
      setUploadError(result.error)
      return
    }
    setAssets((current) => [
      ...current.filter((a) => a.kind !== kind),
      result.asset,
    ])
  }

  const handleRemove = async (asset: BrandAsset) => {
    if (!window.confirm(`Remove the ${asset.kind} clip “${asset.original_name}”? New jobs will no longer include it.`)) return
    setDeletingId(asset.id)
    setUploadError(null)
    const result = await deleteBrandAsset(asset.id)
    setDeletingId(null)
    if (!result.ok) {
      setUploadError(result.error)
      return
    }
    setAssets((current) => current.filter((a) => a.id !== asset.id))
  }

  const uploadRow = (kind: BrandAssetKind, label: string) => {
    const asset = assetFor(kind)
    const inputRef = kind === 'intro' ? introInputRef : outroInputRef
    return (
      <div className="rounded-xl border border-ink-border bg-ink-panel2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">{label}</p>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              MP4, MOV or WebM · max 50 MB · max 15 seconds
            </p>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploadingKind !== null}
            className="flex items-center gap-2 rounded-xl border border-dashed border-ink-border bg-ink-panel px-4 py-2.5 text-sm font-medium text-white hover:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploadingKind === kind ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 text-brand-light" />
            )}
            {uploadingKind === kind
              ? 'Uploading…'
              : asset
                ? `Replace ${kind} clip`
                : `Upload ${kind} clip`}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm"
            className="hidden"
            onChange={(e) => {
              void handleUpload(kind, e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
        {asset ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ink-panel px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{asset.original_name}</p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                {asset.duration_seconds != null
                  ? `${formatDuration(asset.duration_seconds)} · `
                  : ''}
                {formatBytes(asset.file_size_bytes)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleRemove(asset)}
              disabled={deletingId === asset.id}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deletingId === asset.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t('remove')}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            No {kind} clip set.
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin text-brand-light" />
          Loading intro/outro assets…
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {uploadRow('intro', t('introVideo'))}
          {uploadRow('outro', t('outroVideo'))}
        </div>
      )}
      {loadError ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {loadError}
        </p>
      ) : null}
      {uploadError ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {uploadError}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        Applies to new jobs created after this is set — existing clips are
        unchanged.
      </p>
    </div>
  )
}
/**
 * Logo asset (Batch 4) — a real upload to the backend (POST
 * /api/v1/brand-kit/assets, PNG/JPG/WebP ≤5 MB). One logo per user;
 * uploading again replaces it. When a job's "Logo overlay" setting is
 * on, the worker overlays this logo bottom-right on every clip of
 * that job. The preview below is the file the server stored (fetched
 * with the bearer token), never a local-only blob.
 */
function LogoAsset() {
  const [asset, setAsset] = useState<BrandAsset | null>(null)
  const { t } = usePreferences()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    listBrandAssets()
      .then((rows) => {
        if (cancelled) return
        const logo = rows.find((a) => a.kind === 'logo') ?? null
        setAsset(logo)
        if (logo) {
          void fetchBrandAssetFile(logo.id).then((url) => {
            if (!cancelled && url) setPreviewUrl(url)
          })
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load your logo.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    },
    [previewUrl],
  )

  const handleUpload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setUploadError(null)
    const result = await uploadBrandAsset('logo', file)
    setUploading(false)
    if (!result.ok) {
      setUploadError(result.error)
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setAsset(result.asset)
    const url = await fetchBrandAssetFile(result.asset.id)
    if (url) setPreviewUrl(url)
  }

  const handleRemove = async () => {
    if (!asset) return
    if (!window.confirm(`Remove the logo “${asset.original_name}”? Jobs with logo overlay on will render without it.`)) return
    setDeleting(true)
    setUploadError(null)
    const result = await deleteBrandAsset(asset.id)
    setDeleting(false)
    if (!result.ok) {
      setUploadError(result.error)
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setAsset(null)
  }

  if (loading) {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin text-brand-light" />
        Loading logo…
      </p>
    )
  }

  return (
    <div>
      <div className="mt-2 flex items-center gap-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 rounded-xl border border-dashed border-ink-border bg-ink-panel2 px-4 py-3 text-sm font-medium text-white hover:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-brand-light" />
          ) : (
            <ImagePlus className="h-4 w-4 text-brand-light" />
          )}
          {uploading ? 'Uploading…' : asset ? 'Change logo' : 'Upload logo'}
        </button>
        {previewUrl ? (
          <img src={previewUrl} alt="Brand logo preview" className="h-12 w-12 rounded-lg object-contain bg-white/5" />
        ) : asset ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            {asset.original_name} — preview unavailable (file removed on a server restart; upload it again).
          </span>
        ) : (
          <span className="text-xs text-[var(--color-text-muted)]">
            No logo yet — upload a PNG, JPG or WebP (max 5 MB).
          </span>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            void handleUpload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      {asset ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ink-panel px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{asset.original_name}</p>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {formatBytes(asset.file_size_bytes)} · PNG/JPG/WebP, max {formatBytes(BRAND_LOGO_MAX_BYTES)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleRemove()}
            disabled={deleting}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t('remove')}
          </button>
        </div>
      ) : null}
      {loadError ? (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {loadError}
        </p>
      ) : null}
      {uploadError ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {uploadError}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        The logo is watermarked bottom-right on clips of jobs with “Logo
        overlay” on. Uploading a new logo replaces this one.
      </p>
    </div>
  )
}
export function BrandKitPage() {
  const [initial] = useState(loadSaved)
  const { t } = usePreferences()
  const [brandName, setBrandName] = useState(initial.brandName)
  const [primary, setPrimary] = useState(initial.primary)
  const [accent, setAccent] = useState(initial.accent)
  const [font, setFont] = useState(initial.font)
  const [defaultCaptionPreset, setDefaultCaptionPreset] = useState(initial.defaultCaptionPreset)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const handleSave = () => {
    const payload: BrandKitSaved = {
      brandName,
      primary,
      accent,
      font,
      defaultCaptionPreset,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      setSavedNote('Saved in this browser — backend sync pending (Laravel)')
    } catch {
      setSavedNote('Could not save in this browser (local storage unavailable).')
    }
  }

  const handleReset = () => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage unavailable — still restore the on-screen defaults.
    }
    setBrandName(DEFAULTS.brandName)
    setPrimary(DEFAULTS.primary)
    setAccent(DEFAULTS.accent)
    setFont(DEFAULTS.font)
    setDefaultCaptionPreset(DEFAULTS.defaultCaptionPreset)
    setSavedNote('Brand kit reset to defaults.')
  }

  const activePreset = getCaptionStyle(defaultCaptionPreset)

  return (
    <div>
      <PageHeader
        title={t('brandKitTitle')}
        subtitle={t('brandKitSubtitle')}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
          <div className="space-y-5">
            <label className="block">
              <span className="text-sm font-medium text-white">Brand name</span>
              <input
                type="text"
                value={brandName}
                onChange={(e) => {
                  setBrandName(e.target.value)
                  setSavedNote(null)
                }}
                placeholder="e.g. Magician Clipper"
                className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none"
              />
            </label>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-white">Primary colour</span>
                <span className="mt-2 flex items-center gap-3">
                  <input
                    type="color"
                    value={primary}
                    onChange={(e) => {
                      setPrimary(e.target.value)
                      setSavedNote(null)
                    }}
                    aria-label="Primary colour"
                    className="h-11 w-14 cursor-pointer rounded-lg border border-ink-border bg-ink-panel2"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">{primary}</span>
                </span>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-white">Accent colour</span>
                <span className="mt-2 flex items-center gap-3">
                  <input
                    type="color"
                    value={accent}
                    onChange={(e) => {
                      setAccent(e.target.value)
                      setSavedNote(null)
                    }}
                    aria-label="Accent colour"
                    className="h-11 w-14 cursor-pointer rounded-lg border border-ink-border bg-ink-panel2"
                  />
                  <span className="text-sm text-[var(--color-text-muted)]">{accent}</span>
                </span>
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-white">Font</span>
              <select
                value={font}
                onChange={(e) => {
                  setFont(e.target.value)
                  setSavedNote(null)
                }}
                className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
              >
                <option>Inter</option>
                <option>Arial</option>
                <option>Georgia</option>
                <option>Verdana</option>
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-white">Default caption style</span>
              <select
                value={defaultCaptionPreset}
                onChange={(e) => {
                  setDefaultCaptionPreset(e.target.value)
                  setSavedNote(null)
                }}
                className="mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white focus:border-brand focus:outline-none"
              >
                {CAPTION_STYLES.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.name}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="text-sm font-medium text-white">{t('logoImage')}</span>
              <LogoAsset />
            </div>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white"
            >
              <Save className="h-4 w-4" /> Save Brand Kit
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-5 py-2.5 text-sm font-semibold text-white"
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </button>
          </div>
          {savedNote ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-emerald-300">
              <Check className="h-4 w-4" /> {savedNote}
            </p>
          ) : (
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Save stores the brand kit in this browser only. Backend sync is pending
              (Laravel).
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Palette className="h-5 w-5 text-brand-light" /> {t('livePreview')}
          </h2>
          <div
            className="brand-preview mt-4 flex h-48 flex-col items-center justify-center rounded-xl px-4 text-center"
            style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}
          >
            <p className="text-lg font-bold text-white" style={{ fontFamily: font }}>
              {brandName || 'Your Brand'}
            </p>
            <p className="mt-1 text-sm font-bold text-white">{activePreset.sample}</p>
            <p className="mt-1 text-xs text-white/80">
              Default caption style: {activePreset.name}
            </p>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
            The preview updates as you edit. It is saved in this browser when you press
            Save; backend sync is pending (Laravel).
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-ink-border bg-ink-panel p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Clapperboard className="h-5 w-5 text-brand-light" /> Intro &amp; outro assets
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Optional brand intro/outro clips you own, added to the start and end of
          every export. Only use clips you have the rights to.
        </p>
        <IntroOutroAssets />
      </div>
    </div>
  )
}
