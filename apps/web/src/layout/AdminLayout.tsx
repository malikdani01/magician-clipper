import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  BarChart3,
  Bell,
  Clapperboard,
  Coins,
  Cpu,
  CreditCard,
  Eye,
  FileWarning,
  Folder,
  Globe,
  LayoutDashboard,
  Menu,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Users,
  Wallet,
  WandSparkles,
  Wrench,
} from 'lucide-react'
import { AdminRoute } from '../components/AdminRoute'
import { NotificationsBell } from '../components/NotificationsBell'
import { API_URL, engineHealth, getToken, type EngineHealth } from '../lib/api'
import { useAuth } from '../state/auth'

/** The 21 admin nav items (prompt §8). */
const ADMIN_NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users Management', icon: Users },
  { to: '/admin/projects', label: 'Projects', icon: Folder },
  { to: '/admin/clips', label: 'Generated Clips', icon: Clapperboard },
  { to: '/admin/jobs', label: 'Processing Jobs', icon: RefreshCw },
  { to: '/admin/failed-jobs', label: 'Failed Jobs', icon: FileWarning },
  { to: '/admin/payments', label: 'Payments & Billing', icon: CreditCard },
  { to: '/admin/subscriptions', label: 'Subscriptions', icon: Wallet },
  { to: '/admin/credits', label: 'Credits Management', icon: Coins },
  { to: '/admin/ai-settings', label: 'AI Settings', icon: Cpu },
  { to: '/admin/ffmpeg', label: 'FFmpeg Settings', icon: Terminal },
  { to: '/admin/whisper', label: 'Whisper Settings', icon: Eye },
  { to: '/admin/opencv', label: 'OpenCV Settings', icon: SlidersHorizontal },
  { to: '/admin/queue', label: 'Queue & Worker Settings', icon: Server },
  { to: '/admin/website', label: 'Website Settings', icon: Globe },
  { to: '/admin/notifications', label: 'Notifications', icon: Bell },
  { to: '/admin/tickets', label: 'Support Tickets', icon: ShieldCheck },
  { to: '/admin/logs', label: 'System Logs', icon: ScrollText },
  { to: '/admin/monitor', label: 'Server Monitor', icon: Activity },
  { to: '/admin/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { to: '/admin/settings', label: 'Admin Settings', icon: Settings },
] as const

export function AdminLayout() {
  const { user, loading } = useAuth()
  const isAdmin = user?.role === 'admin'
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [engine, setEngine] = useState<EngineHealth | null>(null)
  // Real sidebar badge counts (in-flight jobs, failed jobs) from the
  // admin dashboard endpoint. No badge renders when the count is 0 —
  // the design's red badges only appear when there is something to see.
  const [navCounts, setNavCounts] = useState<{ processing_jobs: number; failed_jobs: number } | null>(null)
  // ffmpeg/ffprobe versions as last reported by the worker (the hosted
  // site has no engine URL to probe).
  const [reportedEngine, setReportedEngine] = useState<{ ffmpeg: string | null; ffprobe: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    engineHealth().then((h) => {
      if (!cancelled) setEngine(h)
    })
    const token = getToken()
    if (token) {
      fetch(`${API_URL}/admin/dashboard`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!cancelled && body?.nav_counts) setNavCounts(body.nav_counts)
          if (!cancelled && body?.engine) setReportedEngine(body.engine)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [])

  const badgeFor = (to: string): number | null => {
    if (!navCounts) return null
    if (to === '/admin/jobs') return navCounts.processing_jobs
    if (to === '/admin/failed-jobs') return navCounts.failed_jobs
    return null
  }

  // While the stored session is still being verified, never show
  // "Sign-in required" for a signed-in admin — show a loading state.
  const initial = loading ? '…' : (user?.name ?? 'A').trim().charAt(0).toUpperCase() || 'A'
  const location = useLocation()

  return (
    <div className="relative flex h-full">
      <div className="aurora-mesh" aria-hidden="true" />
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-border bg-ink-panel backdrop-blur-xl">
        <Link to="/admin" className="flex items-center gap-3 px-5 pb-2 pt-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c3aed] via-[#d946ef] to-[#22d3ee] text-white shadow-aurora">
            <WandSparkles className="h-5 w-5" />
          </span>
          <span className="leading-tight">
            <span className="block text-base font-bold text-white">Magician Clipper</span>
            <span className="block text-xs text-[var(--color-text-muted)]">Admin Panel</span>
          </span>
        </Link>

        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {ADMIN_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item && item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-[#7c3aed] via-[#c026d3] to-[#0891b2] text-white shadow-aurora'
                    : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {(() => {
                const badge = badgeFor(item.to)
                return badge !== null && badge > 0 ? (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                    {badge}
                  </span>
                ) : null
              })()}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-3 border-t border-ink-border p-4">
          <div className="rounded-xl border border-ink-border bg-ink-panel2 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-white">
              <Activity className="h-3.5 w-3.5 text-brand-light" />
              System Status
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <span
                className={`h-2 w-2 rounded-full ${engine?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`}
              />
              {engine === null
                ? 'Checking video engine…'
                : engine.ok
                  ? 'All Systems Online'
                  : 'Video engine down'}
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {engine?.ok
                ? `FFmpeg ${engine.ffmpeg ?? reportedEngine?.ffmpeg ?? 'version unknown'}`
                : 'Engine health is checked live.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-sm font-bold text-white">
              {initial}
            </span>
            <span className="min-w-0 leading-tight">
              {loading ? (
                <span className="block truncate text-sm text-[var(--color-text-muted)]">
                  Checking sign-in…
                </span>
              ) : (
                <>
                  <span className="block truncate text-sm font-semibold text-white">
                    {isAdmin ? user.name : 'Admin'}
                  </span>
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    {isAdmin ? 'Super Admin' : 'Sign-in required'}
                  </span>
                </>
              )}
            </span>
          </div>
          <Link
            to="/"
            className="flex items-center justify-center gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-xs font-medium text-white hover:bg-ink-border"
          >
            <Wrench className="h-3.5 w-3.5" />
            Back to user panel
          </Link>
        </div>
      </aside>

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-ink-border bg-ink-panel px-6 backdrop-blur-xl">
          <Menu className="h-5 w-5 shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
          <form
            className="relative w-full max-w-md"
            onSubmit={(e) => {
              e.preventDefault()
              const q = search.trim()
              navigate(q ? `/admin/users?q=${encodeURIComponent(q)}` : '/admin/users')
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users, projects, or anything…"
              aria-label="Search users and projects"
              className="w-full rounded-xl border border-ink-border bg-ink-panel2 py-2.5 pl-10 pr-16 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-ink-border px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
              Enter ↵
            </kbd>
          </form>

          <div className="ml-auto flex items-center gap-3">
            <span
              className={`hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold sm:flex ${
                engine?.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
              title={
                engine === null
                  ? 'Checking the video engine…'
                  : engine.ok
                    ? 'Video engine is up'
                    : `Video engine is down — ${engine.error ?? engine.status}`
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${engine?.ok ? 'bg-emerald-400' : 'bg-amber-400'}`}
              />
              {engine?.ok ? 'Live' : 'Engine down'}
            </span>
            <NotificationsBell />
            <span className="flex items-center gap-2">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-sm font-bold text-white">
                {initial}
              </span>
              <span className="hidden leading-tight md:block">
                <span className="block text-sm font-semibold text-white">
                  {loading ? '…' : isAdmin ? user.name : 'Admin'}
                </span>
                <span className="block text-xs text-[var(--color-text-muted)]">{loading ? 'Checking sign-in…' : 'Super Admin'}</span>
              </span>
            </span>
          </div>
        </header>
        <main key={location.pathname} className="animate-page-in flex-1 overflow-y-auto p-6">
          <AdminRoute>
            <Outlet />
          </AdminRoute>
        </main>
      </div>
    </div>
  )
}
