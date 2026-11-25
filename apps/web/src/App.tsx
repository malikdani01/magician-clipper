import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AdminLayout } from './layout/AdminLayout'
import { AppShell } from './layout/AppShell'
import { AuthProvider } from './state/auth'
import { PreferencesProvider } from './state/preferences'
import { ProjectProvider } from './state/projects'
import { SearchProvider } from './state/search'
import { BrandKitPage } from './pages/BrandKit'
import { CaptionsPage } from './pages/Captions'
import { ClipperPage } from './pages/Clipper'
import { CreateProjectPage } from './pages/CreateProject'
import { DashboardPage } from './pages/Dashboard'
import { EditorPage } from './pages/Editor'
import { ExportsPage } from './pages/Exports'
import { HelpPage } from './pages/Help'
import { JobDetailPage } from './pages/JobDetail'
import { JobsPage } from './pages/Jobs'
import { LibraryPage } from './pages/Library'
import { LoginPage } from './pages/Login'
import { NewJobPage } from './pages/NewJob'
import { NotFoundPage } from './pages/NotFound'
import { ProjectsPage } from './pages/Projects'
import { RegisterPage } from './pages/Register'
import { SettingsPage } from './pages/Settings'
import { UsagePage } from './pages/Usage'
import { AdminDashboardPage, AdminGenericPage } from './pages/admin/AdminPages'

export function App() {
  return (
    <BrowserRouter>
      <SearchProvider>
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
                <Route path="create" element={<CreateProjectPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="clipper" element={<ClipperPage />} />
                <Route path="jobs" element={<JobsPage />} />
                <Route path="jobs/new" element={<NewJobPage />} />
                <Route path="jobs/:id" element={<JobDetailPage />} />
                <Route path="editor" element={<EditorPage />} />
                <Route path="captions" element={<CaptionsPage />} />
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
            <Route path="users" element={<AdminGenericPage title="Users Management" subtitle="All registered users." />} />
            <Route path="projects" element={<AdminGenericPage title="Projects" subtitle="Every project on the platform." />} />
            <Route path="clips" element={<AdminGenericPage title="Generated Clips" subtitle="Every clip the engine has generated." />} />
            <Route path="jobs" element={<AdminGenericPage title="Processing Jobs" subtitle="Jobs in the processing queue." />} />
            <Route path="failed-jobs" element={<AdminGenericPage title="Failed Jobs" subtitle="Jobs that failed, with their errors." />} />
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
            <Route path="notifications" element={<AdminGenericPage title="Notifications" subtitle="Platform notifications and templates." />} />
            <Route path="tickets" element={<AdminGenericPage title="Support Tickets" subtitle="User support requests." />} />
            <Route path="logs" element={<AdminGenericPage title="System Logs" subtitle="Application and worker logs." />} />
            <Route path="monitor" element={<AdminGenericPage title="Server Monitor" subtitle="CPU, RAM, disk and queue health." />} />
            <Route path="reports" element={<AdminGenericPage title="Reports & Analytics" subtitle="Usage, revenue and growth reports." />} />
            <Route path="settings" element={<AdminGenericPage title="Admin Settings" subtitle="Platform-wide admin configuration." />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </PreferencesProvider>
          </AuthProvider>
        </ProjectProvider>
      </SearchProvider>
    </BrowserRouter>
  )
}
