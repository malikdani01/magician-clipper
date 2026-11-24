/**
 * In-app notifications API client — GET /api/v1/notifications,
 * PATCH /api/v1/notifications/{id}/read, POST /read-all.
 * Notifications are created by the backend when a job turns Ready or
 * Failed (one per job + type). All calls hit the real Laravel backend.
 */

import { API_URL, getToken } from './api'

export interface AppNotification {
  id: number
  type: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/** GET /api/v1/notifications — mine, newest first. */
export async function listNotifications(): Promise<AppNotification[]> {
  if (!getToken()) return []
  try {
    const res = await fetch(`${API_URL}/notifications`, { headers: authHeaders() })
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: AppNotification[]
      notifications?: AppNotification[]
    }
    if (Array.isArray(body.data)) return body.data
    if (Array.isArray(body.notifications)) return body.notifications
    return []
  } catch {
    return []
  }
}

/** PATCH /api/v1/notifications/{id}/read — mark one as read. */
export async function markNotificationRead(id: number): Promise<boolean> {
  if (!getToken()) return false
  try {
    const res = await fetch(`${API_URL}/notifications/${id}/read`, {
      method: 'PATCH',
      headers: authHeaders(),
    })
    return res.ok
  } catch {
    return false
  }
}

/** POST /api/v1/notifications/read-all — mark all mine as read. */
export async function markAllNotificationsRead(): Promise<boolean> {
  if (!getToken()) return false
  try {
    const res = await fetch(`${API_URL}/notifications/read-all`, {
      method: 'POST',
      headers: authHeaders(),
    })
    return res.ok
  } catch {
    return false
  }
}
