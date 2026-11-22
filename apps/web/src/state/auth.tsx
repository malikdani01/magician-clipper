import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  getStoredUser,
  getToken,
  laravelHealth,
  laravelLogin,
  laravelLogout,
  laravelMe,
  laravelRegister,
  setToken,
} from '../lib/api'

export interface AuthUser {
  id: number
  name: string
  email: string
  role: string
  plan: string
  storage_quota_mb?: number
}

const TOKEN_KEY = 'magician-clipper.token'
const USER_KEY = 'magician-clipper.user'

interface AuthState {
  user: AuthUser | null
  token: string | null
  loading: boolean
  /** True when the Laravel backend answered its health check. */
  authAvailable: boolean
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
  register: (
    name: string,
    email: string,
    password: string,
    passwordConfirmation: string,
  ) => Promise<{ ok: boolean; error?: string }>
  logout: () => void
  /** Re-read the signed-in account from the backend (GET /api/v1/me). */
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/** Accept either a bare user object or a `{ user }` wrapper (GET /me). */
function normalizeUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = (raw as { user?: unknown }).user ?? raw
  if (!candidate || typeof candidate !== 'object') return null
  const u = candidate as Record<string, unknown>
  if (typeof u.id !== 'number' || typeof u.email !== 'string') return null
  return {
    id: u.id,
    name: typeof u.name === 'string' ? u.name : '',
    email: u.email,
    role: typeof u.role === 'string' ? u.role : 'user',
    plan: typeof u.plan === 'string' ? u.plan : 'free',
    storage_quota_mb: typeof u.storage_quota_mb === 'number' ? u.storage_quota_mb : undefined,
  }
}

function storeSession(token: string, user: AuthUser) {
  setToken(token)
  try {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    // Private mode / blocked storage: the in-memory session still works
    // for this tab, but it will not survive a reload.
  }
}

function clearStoredSession() {
  setToken(null)
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Auth state — Phase 2, real Laravel Sanctum auth.
 *
 * On mount the stored token + user are loaded from localStorage and the
 * token is verified against GET /api/v1/me; a token the backend rejects
 * is cleared rather than trusted. No demo or fake credentials exist
 * anywhere in this module.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setTokenState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [authAvailable, setAuthAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function init() {
      const health = await laravelHealth()
      if (cancelled) return
      setAuthAvailable(health.ok)

      const storedToken = getToken() ?? (() => {
        try {
          return localStorage.getItem(TOKEN_KEY)
        } catch {
          return null
        }
      })()
      const storedUser = normalizeUser(getStoredUser())
      if (!storedToken) {
        setLoading(false)
        return
      }
      setTokenState(storedToken)
      if (storedUser) setUser(storedUser)

      // Verify the stored token with the backend; never trust it blindly.
      const me = await laravelMe()
      if (cancelled) return
      const verified = normalizeUser(me)
      if (verified) {
        setUser(verified)
        storeSession(storedToken, verified)
      } else {
        clearStoredSession()
        setTokenState(null)
        setUser(null)
      }
      setLoading(false)
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const result = await laravelLogin(email, password)
    if (!result.ok) return { ok: false as const, error: result.error }
    const authUser = normalizeUser(result.user)
    if (!authUser) {
      return { ok: false as const, error: 'Sign-in succeeded but the server returned an unusable account.' }
    }
    storeSession(result.token, authUser)
    setTokenState(result.token)
    setUser(authUser)
    return { ok: true as const }
  }, [])

  const register = useCallback(
    async (name: string, email: string, password: string, passwordConfirmation: string) => {
      const result = await laravelRegister(name, email, password, passwordConfirmation)
      if (!result.ok) return { ok: false as const, error: result.error }
      const authUser = normalizeUser(result.user)
      if (!authUser) {
        return { ok: false as const, error: 'Account created but the server returned an unusable account.' }
      }
      storeSession(result.token, authUser)
      setTokenState(result.token)
      setUser(authUser)
      return { ok: true as const }
    },
    [],
  )

  const logout = useCallback(() => {
    void laravelLogout().catch(() => {
      // Logout is best-effort: the local session is cleared regardless.
    })
    clearStoredSession()
    setTokenState(null)
    setUser(null)
  }, [])

  /** Re-read the signed-in account from the backend (GET /api/v1/me). */
  const refreshUser = useCallback(async () => {
    const me = await laravelMe()
    const verified = normalizeUser(me)
    if (verified) {
      const storedToken = getToken()
      if (storedToken) storeSession(storedToken, verified)
      setUser(verified)
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, token, loading, authAvailable, login, register, logout, refreshUser }),
    [user, token, loading, authAvailable, login, register, logout, refreshUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
