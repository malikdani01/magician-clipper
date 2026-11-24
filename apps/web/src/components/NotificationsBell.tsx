import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from '../lib/notifications'
import { useAuth } from '../state/auth'

function timeAgo(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Real notifications bell, shared by the user TopBar and the admin
 * header. The backend creates one notification when a job turns Ready
 * or Failed (one per job + type). Polls every 30s while signed in.
 * Clicking a notification marks it read and opens its job page.
 */
export function NotificationsBell() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (!token) {
      setItems([])
      return
    }
    setItems(await listNotifications())
  }, [token])

  useEffect(() => {
    if (!token) return
    setLoading(true)
    void refresh().finally(() => setLoading(false))
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [token, refresh])

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open ])

  const unread = items.filter((n) => n.read_at === null).length

  const openNotification = async (n: AppNotification) => {
    if (n.read_at === null) {
      setItems((current) =>
        current.map((x) =>
          x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x,
        ),
      )
      void markNotificationRead(n.id)
    }
    setOpen(false)
    if (n.link && n.link.startsWith('/')) navigate(n.link)
  }

  const markAllRead = async () => {
    setItems((current) =>
      current.map((n) => (n.read_at === null ? { ...n, read_at: new Date().toISOString() } : n)),
    )
    await markAllNotificationsRead()
    void refresh()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          void refresh()
        }}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-ink-border bg-ink-panel2 text-[var(--color-text-muted)] transition-colors hover:text-white"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-gradient-to-br from-[#d946ef] to-[#7c3aed] px-1 text-[11px] font-bold text-white shadow-aurora">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-12 z-20 w-80 overflow-hidden rounded-2xl border border-ink-border bg-ink-panel shadow-card backdrop-blur-xl sm:right-6 sm:top-[4.25rem] sm:w-96">
          <div className="flex items-center justify-between gap-3 border-b border-ink-border px-4 py-3">
            <h3 className="text-sm font-semibold text-white">Notifications</h3>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="flex items-center gap-1 text-xs font-medium text-brand-light hover:underline"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            ) : null}
          </div>
          {loading && items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-muted)]">
              Loading notifications…
            </p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-text-muted)]">
              No notifications yet — when a job finishes or fails, it will
              show up here.
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => void openNotification(n)}
                    className={`block w-full px-4 py-3 text-left transition-colors hover:bg-white/5 ${
                      n.read_at === null ? 'bg-brand/10' : ''
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      {n.read_at === null ? (
                        <span
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gradient-to-br from-[#d946ef] to-[#22d3ee]"
                          aria-label="Unread"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-white">
                          {n.title}
                        </span>
                        {n.body ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-text-muted)]">
                            {n.body}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                          {timeAgo(n.created_at)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
