import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { useAuth } from '../state/auth'

const inputClass =
  'mt-2 w-full rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none'

/** Sign-up — Phase 2, real Laravel auth. No demo accounts, no prefilled credentials. */
export function RegisterPage() {
  const { register, loading, authAvailable } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (name.trim().length === 0) {
      setError('Enter your name.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== passwordConfirmation) {
      setError('Passwords do not match.')
      return
    }
    if (!authAvailable) {
      setError(
        'Backend is not reachable — start it with: cd backend/laravel && php artisan serve --host=127.0.0.1 --port=8000',
      )
      return
    }
    setSubmitting(true)
    const result = await register(name.trim(), email.trim(), password, passwordConfirmation)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error ?? 'Registration failed.')
      return
    }
    navigate('/')
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 sm:p-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
          <UserPlus className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-2xl font-bold text-white">Create an account</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          A regular user account. Admin accounts are created by the server
          administrator — there is no self-service admin signup.
        </p>

        {!authAvailable && !loading ? (
          <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
            Backend is not reachable — start it with:{' '}
            <code className="text-amber-200">
              cd backend/laravel &amp;&amp; php artisan serve --host=127.0.0.1 --port=8000
            </code>
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <label className="block">
            <span className="text-sm font-medium text-white">Name</span>
            <input
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-white">Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={passwordConfirmation}
              onChange={(e) => setPasswordConfirmation(e.target.value)}
              placeholder="Repeat your password"
              className={inputClass}
            />
          </label>

          {error ? (
            <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting || loading}
            className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-[var(--color-text-muted)]">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-light hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
