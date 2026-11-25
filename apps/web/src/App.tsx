import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AdminLayout } from './layout/AdminLayout'
import { AppShell } from './layout/AppShell'
import { AuthProvider } from './state/auth'
import { PreferencesProvider } from './state/preferences'
import { ProjectProvider } from './state/projects'
import { BrandKitPage } from './pages/BrandKit'
import { ClipperPage } from './pages/Clipper'
import { DashboardPage } from './pages/Dashboard'
import { EditorPage } from './pages/Editor'
import { ExportsPage } from './pages/Exports'
import { HelpPage } from './pages/Help'
import { JobDetailPage } from './pages/JobDetail'
import { JobsPage } from './pages/Jobs'
import { LibraryPage } from './pages/Library'
import { LoginPage } from './pages/Login'
import { NotFoundPage } from './pages/NotFound'
import { RegisterPage } from './pages/Register'
import { SettingsPage } from './pages/Settings'
import { UsagePage } from './pages/Usage'
import { AdminDashboardPage, AdminGenericPage, AdminSettingsPage } from './pages/admin/AdminPages'
import { AdminClipsPage, AdminFailedJobsPage, AdminJobsPage, AdminProjectsPage, AdminUserDetailPage, AdminUsersPage } from './pages/admin/AdminUsers'
import { AdminPlatformPage } from './pages/admin/AdminPlatform'
import { AdminLogsPage, AdminMonitorPage, AdminNotificationsPage, AdminReportsPage } from './pages/admin/AdminSystem'

/**
 * Batch 9 (2026-11-25): the hidden creation/list pages redirect to
 * their replacements, preserving the query string so old bookmarks
 * keep working — /jobs/new?clone=12 lands in the wizard with the
 * clone loaded, ?source=link&url=… lands with the link pre-filled.
 * The components themselves were deleted; only these redirects remain.
 */
function RedirectToClipper() {
  const { search } = useLocation()
  return <Navigate to={{ pathname: '/clipper', search }} replace />
}

export function App() {
  return (
    <BrowserRouter>
      <ProjectProvider>
        <AuthProvider>
          <PreferencesProvider>
            <Routes>
              {/* Auth pages — outside the app shell (no sidebar). */}
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />

              {/* User panel */}
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="create" element={<Navigate to="/clipper" replace />} />
                <Route path="projects" element={<Navigate to="/jobs" replace />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="clipper" element={<ClipperPage />} />
                <Route path="jobs" element={<JobsPage />} />
                <Route path="jobs/new" element={<RedirectToClipper />} />
                <Route path="jobs/:id" element={<JobDetailPage />} />
                <Route path="editor" element={<EditorPage />} />
                <Route path="captions" element={<Navigate to="/settings" replace />} />
                <Route path="brand-kit" element={<BrandKitPage />} />
                <Route path="exports" element={<ExportsPage />} />
                <Route path="usage" element={<UsagePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="help" element={<HelpPage />} />
              </Route>

          {/* Admin panel — all content behind the AdminRoute guard (see AdminLayout).
              The guard checks the real Laravel session: admins pass, signed-in
              non-admins get a 403, signed-out visitors get a sign-in notice. */}
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboardPage />} />
            {/* Batch 10: full admin pages (users, projects, clips, jobs,
                failed jobs, platform controls, notifications, logs,
                monitor, reports). The remaining routes stay honest
                placeholders until their backend exists. */}
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="users/:id" element={<AdminUserDetailPage />} />
            <Route path="projects" element={<AdminProjectsPage />} />
            <Route path="clips" element={<AdminClipsPage />} />
            <Route path="jobs" element={<AdminJobsPage />} />
            <Route path="failed-jobs" element={<AdminFailedJobsPage />} />
            <Route path="platform" element={<AdminPlatformPage />} />
            <Route
              path="payments"
              element={<AdminGenericPage title="Payments & Billing" subtitle="Payments and invoices." billingNotEnabled />}
            />
            <Route
              path="subscriptions"
              element={<AdminGenericPage title="Subscriptions" subtitle="Active and past subscriptions." billingNotEnabled />}
            />
            <Route path="credits" element={<AdminGenericPage title="Credits Management" subtitle="Credit balances and adjustments." />} />
            <Route path="ai-settings" element={<AdminGenericPage title="AI Settings" subtitle="Moment detection and clipping model settings." />} />
            <Route path="ffmpeg" element={<AdminGenericPage title="FFmpeg Settings" subtitle="Encoding presets and FFmpeg paths." />} />
            <Route path="whisper" element={<AdminGenericPage title="Whisper Settings" subtitle="Transcription model and language settings." />} />
            <Route path="opencv" element={<AdminGenericPage title="OpenCV Settings" subtitle="Scene detection and face tracking settings." />} />
            <Route path="queue" element={<AdminGenericPage title="Queue & Worker Settings" subtitle="Queue, workers and concurrency." />} />
            <Route path="website" element={<AdminGenericPage title="Website Settings" subtitle="Site name, branding and public pages." />} />
            <Route path="notifications" element={<AdminNotificationsPage />} />
            <Route path="tickets" element={<AdminGenericPage title="Support Tickets" subtitle="User support requests." />} />
            <Route path="logs" element={<AdminLogsPage />} />
            <Route path="monitor" element={<AdminMonitorPage />} />
            <Route path="reports" element={<AdminReportsPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </PreferencesProvider>
        </AuthProvider>
      </ProjectProvider>
    </BrowserRouter>
  )
}
