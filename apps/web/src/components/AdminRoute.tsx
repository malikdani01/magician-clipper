import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '../state/auth'

/**
 * Admin route guard — Phase 2, real Laravel auth.
 *
 * - While auth state is loading: "Checking sign-in…".
 * - Admin user: renders the admin content.
 * - Signed-in non-admin: an honest 403 panel naming the signed-in email.
 * - No user: "Admin sign-in required" with a link to /login.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-border bg-ink-panel px-6 py-16 text-center">
        <p className="text-sm text-[var(--color-text-muted)]">Checking sign-in…</p>
      </div>
    )
  }

  if (user?.role === 'admin') return <>{children}</>

  if (user) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-border bg-ink-panel px-6 py-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-300">
          <ShieldAlert className="h-7 w-7" />
        </div>
        <h2 className="text-lg font-semibold text-white">Admin access required</h2>
        <p className="mt-2 max-w-md text-sm text-[var(--color-text-muted)]">
          Signed in as {user.email} — this area requires an admin account.
        </p>
        <Link
          to="/"
          className="mt-5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
        >
          Back to the user panel
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-border bg-ink-panel px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-300">
        <ShieldAlert className="h-7 w-7" />
      </div>
      <h2 className="text-lg font-semibold text-white">Admin sign-in required</h2>
      <p className="mt-2 max-w-md text-sm text-[var(--color-text-muted)]">
        Sign in with an admin account to open the admin panel. Admin accounts
        are created by the server administrator (DatabaseSeeder with
        ADMIN_EMAIL / ADMIN_PASSWORD) — there is no self-service admin signup.
      </p>
      <Link
        to="/login"
        className="mt-5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
      >
        Sign in
      </Link>
    </div>
  )
}
