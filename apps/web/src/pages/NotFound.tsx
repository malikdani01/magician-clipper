import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'

export function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="This page does not exist. Use the sidebar to go somewhere real."
      icon={<Compass className="h-7 w-7" />}
      action={
        <Link
          to="/"
          className="inline-flex rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-light"
        >
          Back to Dashboard
        </Link>
      }
    />
  )
}
