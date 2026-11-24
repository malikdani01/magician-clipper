import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Captions,
  CreditCard,
  Folder,
  FolderPlus,
  HelpCircle,
  History,
  LayoutDashboard,
  ListVideo,
  Menu,
  Palette,
  PlusCircle,
  Scissors,
  Search,
  Settings,
  Video,
  Wand2,
  WandSparkles,
} from 'lucide-react'
import { NotificationsBell } from '../components/NotificationsBell'
import { useAuth } from '../state/auth'
import { useProjectSearch } from '../state/search'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/create', label: 'Create Project', icon: FolderPlus },
  { to: '/projects', label: 'My Projects', icon: Folder },
  { to: '/library', label: 'Video Library', icon: Video },
  { to: '/clipper', label: 'AI Clipper', icon: Wand2 },
  { to: '/jobs/new', label: 'New Job', icon: PlusCircle },
  { to: '/jobs', label: 'My Jobs', icon: ListVideo },
  { to: '/editor', label: 'Studio Editor', icon: Scissors },
  { to: '/captions', label: 'Captions Studio', icon: Captions },
  { to: '/brand-kit', label: 'Brand Kit', icon: Palette },
  { to: '/exports', label: 'Export History', icon: History },
  { to: '/usage', label: 'Usage & Credits', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/help', label: 'Help & Support', icon: HelpCircle },
] as const

function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const { user, loading } = useAuth()
  // While the stored session is still being verified, show a loading
  // state — never the guest UI. Rendering "Guest User" + Sign in /
  // Register for a signed-in user (even for a second) is the flash
  // the audit caught on every page.
  const initial = loading ? '…' : (user?.name ?? 'G').trim().charAt(0).toUpperCase() || 'G'

  return (
    <>
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-ink-border bg-ink-panel backdrop-blur-xl transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } md:static md:translate-x-0`}
      >
      <Link to="/" onClick={onClose} className="flex items-center gap-3 px-5 pb-2 pt-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c3aed] via-[#d946ef] to-[#22d3ee] text-white shadow-aurora">
          <WandSparkles className="h-5 w-5" />
        </span>
        <span className="leading-tight">
          <span className="block text-base font-bold text-white">Magician</span>
          <span className="block text-base font-bold text-brand-light">Clipper</span>
        </span>
      </Link>

      <nav className="mt-4 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item && item.end}
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-gradient-to-r from-[#7c3aed] via-[#c026d3] to-[#0891b2] text-white shadow-aurora'
                  : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-white'
              }`
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-ink-border p-4">
        {loading ? (
          <p className="text-sm text-[var(--color-text-muted)]">Checking sign-in…</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-sm font-bold text-white">
                {initial}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-semibold text-white">
                  {user?.name ?? 'Guest User'}
                </span>
                <span className="block truncate text-xs capitalize text-[var(--color-text-muted)]">
                  {user ? `${user.plan} Plan` : 'Free Plan · not signed in'}
                </span>
              </span>
            </div>
            {user ? (
              <Link
                to="/settings"
                className="mt-3 block rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-center text-xs font-medium text-white hover:bg-ink-border"
              >
                Account settings
              </Link>
            ) : (
              <div className="mt-3 flex gap-2">
                <Link
                  to="/login"
                  className="flex-1 rounded-xl btn-aurora px-3 py-2 text-center text-xs font-semibold text-white"
                >
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="flex-1 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2 text-center text-xs font-medium text-white hover:bg-ink-border"
                >
                  Register
                </Link>
              </div>
            )}
          </>
        )}
      </div>
      </aside>
    </>
  )
}

function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const { query, setQuery } = useProjectSearch()
  const { user, loading } = useAuth()
  const location = useLocation()
  const searchVisible = location.pathname === '/projects'
  const initial = loading ? '…' : (user?.name ?? 'G').trim().charAt(0).toUpperCase() || 'G'

  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center gap-4 border-b border-ink-border bg-ink-panel px-6 backdrop-blur-xl">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open menu"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ink-border bg-ink-panel2 text-white md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            searchVisible ? 'Search projects…' : 'Search projects, videos… (filters My Projects)'
          }
          aria-label="Search projects"
          className="w-full rounded-xl border border-ink-border bg-ink-panel2 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </div>

      <div className="ml-auto flex items-center gap-3">
        <Link
          to="/usage"
          title="Upgrades are not enabled — billing does not exist yet"
          className="btn-aurora hidden items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-colors sm:flex"
        >
          <Wand2 className="h-4 w-4" />
          Upgrade Plan
        </Link>
        <NotificationsBell />
        <Link
          to="/settings"
          aria-label="Account settings"
          title={loading ? 'Checking sign-in…' : user ? `${user.name} — ${user.plan} plan` : 'Not signed in — open settings'}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand-dark text-sm font-bold text-white"
        >
          {initial}
        </Link>
      </div>
    </header>
  )
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const location = useLocation()
  return (
    <div className="relative flex h-full">
      <div className="aurora-mesh" aria-hidden="true" />
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setMobileNavOpen(true)} />
        <main key={location.pathname} className="animate-page-in flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
