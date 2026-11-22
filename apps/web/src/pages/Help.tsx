import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Captions, ChevronDown, LifeBuoy, Palette, Scissors, Wand2 } from 'lucide-react'
import { NotImplemented } from '../components/NotImplemented'
import { PageHeader } from '../components/PageHeader'

const FAQS = [
  {
    q: 'What video formats can I import?',
    a: 'MP4, MOV, MKV and WEBM. When you upload a video, the video engine probes it with FFprobe and shows its real duration, size and resolution. Files you only preview in the clipper are read in your browser and never leave your computer.',
  },
  {
    q: 'Where are my videos stored?',
    a: 'Videos you upload are stored on the server (Laravel storage) under your account, and projects are listed in the app. A file you only pick for a local preview is read in your browser and never uploaded.',
  },
  {
    q: 'Why do some buttons say "Not implemented yet"?',
    a: 'Those actions need a backend endpoint or an engine feature that is not built yet — for example support tickets, password change, billing, or AI clipping. They are disabled rather than faked, and each one names what is missing.',
  },
  {
    q: 'How do I become an admin?',
    a: 'Sign-in is real now (Laravel accounts). Admin accounts are created by the server administrator using the DatabaseSeeder with ADMIN_EMAIL / ADMIN_PASSWORD — there is no self-service admin signup. Sign in at /login with an admin account, then open the admin panel.',
  },
  {
    q: 'What are the system requirements?',
    a: 'The app targets Windows 10 on an i7 with 8 GB of RAM, CPU-only, local-first and zero-budget. The web app itself runs in any modern browser. Uploads are probed by the video engine; transcription and clip generation arrive in Phase 3.',
  },
] as const

/** Help & Support — Phase 2. FAQ accordion works; support tickets need a backend. */
export function HelpPage() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <div>
      <PageHeader title="Help & Support" subtitle="Guides, answers and support." />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { to: '/clipper', label: 'Import & clip a video', icon: <Wand2 className="h-5 w-5" /> },
          { to: '/editor', label: 'Trim in the Studio Editor', icon: <Scissors className="h-5 w-5" /> },
          { to: '/captions', label: 'Style animated captions', icon: <Captions className="h-5 w-5" /> },
          { to: '/brand-kit', label: 'Set up your Brand Kit', icon: <Palette className="h-5 w-5" /> },
        ].map((g) => (
          <Link
            key={g.to}
            to={g.to}
            className="flex items-center gap-3 rounded-2xl border border-ink-border bg-ink-panel p-4 text-sm font-medium text-white transition-colors hover:border-brand/60"
          >
            <span className="text-brand-light">{g.icon}</span>
            {g.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6 lg:col-span-2">
          <h2 className="text-lg font-semibold text-white">Frequently asked questions</h2>
          <div className="mt-4 space-y-2">
            {FAQS.map((faq, i) => {
              const isOpen = open === i
              return (
                <div key={faq.q} className="rounded-xl border border-ink-border bg-ink-panel2">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-sm font-medium text-white"
                  >
                    {faq.q}
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {isOpen ? (
                    <p className="px-4 pb-4 text-sm leading-relaxed text-[var(--color-text-muted)]">
                      {faq.a}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-ink-border bg-ink-panel p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
            <LifeBuoy className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-white">Need more help?</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Support tickets need the backend — not implemented. There is no
            ticket system yet.
          </p>
          <div className="mt-4">
            <NotImplemented phase="Phase 2" detail="support tickets need the backend — not implemented" />
          </div>
          <button
            type="button"
            disabled
            className="mt-4 w-full cursor-not-allowed rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white opacity-40"
          >
            Open a Support Ticket
          </button>
        </div>
      </div>
    </div>
  )
}
