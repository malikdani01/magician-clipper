import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../state/auth'

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: 'Google login abhi configure nahi hai — admin ko Google keys lagani hongi.',
  invalid_state:
    'Google sign-in could not be verified (the session expired). Please try again from the sign-in page.',
  missing_code: 'Google did not return a sign-in code. Please try again.',
  token_exchange_failed: 'Google refused the sign-in. Please try again.',
  profile_failed: 'Google did not return your profile. Please try again.',
  account_suspended: 'Your account is suspended — you cannot sign in. Contact the admin.',
}

/**
 * Google sign-in landing page (Batch 11): Google's callback
 * redirects here with ?token=… (a fresh Sanctum token) or
 * ?error=<code>. The token is verified against GET /api/v1/me
 * before anything is stored; an error code shows a plain message
 * and a link back to sign-in. No token ever appears in the UI.
 */
export function AuthGoogleCallbackPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { loginWithToken, user } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    const token = searchParams.get('token')
    const errorCode = searchParams.get('error')
    if (errorCode) {
      setError(ERROR_MESSAGES[errorCode] ?? 'Google sign-in failed. Please try again.')
      setBusy(false)
      return
    }
    if (!token) {
      setError('Google sign-in returned nothing. Please try again from the sign-in page.')
      setBusy(false)
      return
    }
    let cancelled = false
    void loginWithToken(token).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setError(result.error ?? 'Google sign-in failed. Please try again.')
        setBusy(false)
        return
      }
      navigate(result.user?.role === 'admin' ? '/admin' : '/', { replace: true })
    })
    return () => {
      cancelled = true
    }
    // Runs once per callback landing — the token is single-use by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Already signed in (e.g. a reload after the token landed): go home.
  useEffect(() => {
    if (user && !busy) navigate('/', { replace: true })
  }, [user, busy, navigate])

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-white">Google sign-in</h1>
        {busy && !error ? (
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">Finishing your Google sign-in…</p>
        ) : null}
        {error ? (
          <>
            <p role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
              {error}
            </p>
            <p className="mt-5 text-center text-sm text-[var(--color-text-muted)]">
              <Link to="/login" className="font-medium text-brand-light hover:underline">
                Back to sign-in
              </Link>
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}
