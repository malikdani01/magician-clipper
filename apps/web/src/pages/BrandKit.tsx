import { useRef, useState } from 'react'
import { Check, Clapperboard, ImagePlus, Palette, RotateCcw, Save } from 'lucide-react'
import {
  CAPTION_STYLES,
  getCaptionStyle,
  translateLegacyCaptionPreset,
} from '../lib/captionStyles'
import { NotImplemented } from '../components/NotImplemented'
import { PageHeader } from '../components/PageHeader'

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
 * Brand Kit — Phase 2.
 * Saving is real in this browser: Save writes the kit to localStorage.
 * There is no backend sync yet (Laravel), and the logo file itself is
 * never saved — only its in-browser preview is shown.
 */
export function BrandKitPage() {
  const [initial] = useState(loadSaved)
  const [brandName, setBrandName] = useState(initial.brandName)
  const [primary, setPrimary] = useState(initial.primary)
  const [accent, setAccent] = useState(initial.accent)
  const [font, setFont] = useState(initial.font)
  const [defaultCaptionPreset, setDefaultCaptionPreset] = useState(initial.defaultCaptionPreset)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const logoInputRef = useRef<HTMLInputElement>(null)

  const handleLogo = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return
    if (logoUrl) URL.revokeObjectURL(logoUrl)
    setLogoUrl(URL.createObjectURL(f))
  }

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
    if (logoUrl) URL.revokeObjectURL(logoUrl)
    setLogoUrl(null)
    setSavedNote('Brand kit reset to defaults.')
  }

  const activePreset = getCaptionStyle(defaultCaptionPreset)

  return (
    <div>
      <PageHeader
        title="Brand Kit"
        subtitle="Your colours, logo and fonts — applied to every clip."
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
              <span className="text-sm font-medium text-white">Logo</span>
              <div className="mt-2 flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className="flex items-center gap-2 rounded-xl border border-dashed border-ink-border bg-ink-panel2 px-4 py-3 text-sm font-medium text-white hover:border-brand/60"
                >
                  <ImagePlus className="h-4 w-4 text-brand-light" />
                  {logoUrl ? 'Change logo' : 'Upload logo'}
                </button>
                {logoUrl ? (
                  <img src={logoUrl} alt="Brand logo preview" className="h-12 w-12 rounded-lg object-contain bg-white/5" />
                ) : (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    No logo yet — previewed in your browser only, not saved.
                  </span>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleLogo(e.target.files?.[0])}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Logo preview only — logo file is not saved (backend upload arrives with
                Laravel media).
              </p>
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
            <Palette className="h-5 w-5 text-brand-light" /> Live preview
          </h2>
          <div
            className="mt-4 flex h-48 flex-col items-center justify-center rounded-xl px-4 text-center"
            style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="" className="mb-3 h-12 w-12 rounded-lg object-contain bg-black/20" />
            ) : null}
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
        <div className="mt-4">
          <NotImplemented phase="Phase 3" detail="intro/outro upload needs backend media storage" />
        </div>
        <div className="mt-4 flex flex-wrap gap-3 opacity-60">
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-xl border border-dashed border-ink-border bg-ink-panel2 px-4 py-3 text-sm font-medium text-white"
          >
            Upload intro clip
          </button>
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-xl border border-dashed border-ink-border bg-ink-panel2 px-4 py-3 text-sm font-medium text-white"
          >
            Upload outro clip
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          No intro or outro is set. Applying intro/outro to a clip needs the
          Phase 3 render pipeline.
        </p>
      </div>
    </div>
  )
}
