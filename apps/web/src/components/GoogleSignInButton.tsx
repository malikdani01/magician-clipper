import { useState } from 'react'
import { googleRedirectUrl } from '../lib/api'

/**
 * "Continue with Google" (Batch 11) — shared by the login and
 * register pages. The button is always visible; when the Google
 * keys are not configured yet the backend answers 422
 * google_not_configured and the click shows the honest message
 * "Google login abhi configure nahi hai" — never a fake login,
 * never a crash. When configured, the browser is sent to Google.
 */
export function GoogleSignInButton() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setError(null)
    setBusy(true)
    const result = await googleRedirectUrl()
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    window.location.href = result.url
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-ink-border bg-ink-panel2 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink-border disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* Google "G" mark (official colours, drawn inline — no asset). */}
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
          />
          <path
            fill="#FBBC05"
            d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z"
          />
          <path
            fill="#EA4335"
            d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.98 11.98 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
          />
        </svg>
        {busy ? 'Opening Google…' : 'Continue with Google'}
      </button>
      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}
