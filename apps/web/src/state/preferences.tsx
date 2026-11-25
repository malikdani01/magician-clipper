/**
 * Batch 5 (2026-11-25): appearance + language preferences.
 *
 * Theme ('dark' Aurora default / 'light') and language ('en' /
 * 'ur' Roman Urdu) live in one place:
 * - applied instantly in this browser (localStorage + the
 *   `data-theme` attribute on <html>, which the CSS tokens read);
 * - synced to the account via PATCH /api/v1/settings when signed in,
 *   so the choice survives devices (the server copy wins on load).
 * Signed out, the browser copy is the whole story.
 *
 * Must sit INSIDE AuthProvider (it reads the signed-in user).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { API_URL } from '../lib/api'
import { useAuth } from './auth'
import {
  translate,
  type Language,
  type Theme,
  type TranslationKey,
} from '../lib/i18n'

const THEME_KEY = 'magician-clipper.theme'
const LANGUAGE_KEY = 'magician-clipper.language'

function readStored<T extends string>(key: string, fallback: T, valid: readonly string[]): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw && (valid as readonly string[]).includes(raw)) return raw as T
  } catch {
    // Storage unavailable — the in-memory default still applies.
  }
  return fallback
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable — the in-memory value still applies.
  }
}

export interface PreferencesState {
  theme: Theme
  language: Language
  setTheme: (theme: Theme) => void
  setLanguage: (language: Language) => void
  /** Translate a UI-chrome key in the current language (English fallback). */
  t: (key: TranslationKey) => string
}

const PreferencesContext = createContext<PreferencesState | null>(null)

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { user, token } = useAuth()
  const [theme, setThemeState] = useState<Theme>(() =>
    readStored(THEME_KEY, 'dark', ['dark', 'light']),
  )
  const [language, setLanguageState] = useState<Language>(() =>
    readStored(LANGUAGE_KEY, 'en', ['en', 'ur']),
  )
  // True once the user changes a preference in THIS session. A
  // settings fetch that started before the change must not clobber
  // the fresh choice when it returns late (the auth state settles
  // after login and re-fires this effect while a fetch is in flight).
  const changedLocallyRef = useRef(false)

  // The CSS tokens read data-theme off <html>.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Server copy wins on sign-in: the account's saved theme/language
  // are the cross-device truth. (Local changes PATCH the server, so
  // the two only disagree when the choice was made on another device.)
  useEffect(() => {
    if (!user || !token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/settings`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        })
        if (!res.ok || cancelled) return
        const body = (await res.json()) as { settings?: Record<string, unknown> }
        const settings = body.settings ?? {}
        // A choice the user made after this fetch started wins — the
        // server copy is only the cross-device truth on load.
        if (changedLocallyRef.current) return
        if (typeof settings.theme === 'string' && (settings.theme === 'dark' || settings.theme === 'light')) {
          setThemeState(settings.theme)
          store(THEME_KEY, settings.theme)
        }
        if (typeof settings.language === 'string' && (settings.language === 'en' || settings.language === 'ur')) {
          setLanguageState(settings.language)
          store(LANGUAGE_KEY, settings.language)
        }
      } catch {
        // Backend unreachable — the browser copy stands in.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, token])

  /** Push one preference to the account (best effort, signed in only). */
  const syncToServer = useCallback(
    async (patch: Partial<{ theme: Theme; language: Language }>) => {
      if (!token) return
      try {
        await fetch(`${API_URL}/settings`, {
          method: 'PATCH',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(patch),
        })
      } catch {
        // The browser copy already applied; the server sync can retry
        // on the next change (or next sign-in load).
      }
    },
    [token],
  )

  const setTheme = useCallback(
    (next: Theme) => {
      changedLocallyRef.current = true
      setThemeState(next)
      store(THEME_KEY, next)
      void syncToServer({ theme: next })
    },
    [syncToServer],
  )

  const setLanguage = useCallback(
    (next: Language) => {
      changedLocallyRef.current = true
      setLanguageState(next)
      store(LANGUAGE_KEY, next)
      void syncToServer({ language: next })
    },
    [syncToServer],
  )

  const t = useCallback((key: TranslationKey) => translate(key, language), [language])

  const value = useMemo<PreferencesState>(
    () => ({ theme, language, setTheme, setLanguage, t }),
    [theme, language, setTheme, setLanguage, t],
  )

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesState {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error('usePreferences must be used inside PreferencesProvider')
  return ctx
}
