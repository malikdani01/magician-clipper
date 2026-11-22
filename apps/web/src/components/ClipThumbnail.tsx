import { useEffect, useState } from 'react'
import { Video } from 'lucide-react'
import { fetchClipThumbnail } from '../lib/jobs'

/**
 * A clip's first-frame thumbnail. Fetches the JPEG from the backend
 * (bearer <redacted>) and shows it; when the clip has no thumbnail stored
 * (rendered before thumbnails existed) it falls back to an honest
 * video-icon tile — never a stock or fake image.
 */
export function ClipThumbnail({
  clipId,
  hasThumbnail,
  alt,
  className,
}: {
  clipId: number
  hasThumbnail: boolean
  alt: string
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasThumbnail) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      objectUrl = await fetchClipThumbnail(clipId)
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
      setUrl(objectUrl)
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [clipId, hasThumbnail])

  if (url) {
    return <img src={url} alt={alt} className={className} />
  }

  return (
    <span
      className={`flex items-center justify-center bg-gradient-to-br from-ink-panel2 to-brand-dark/40 text-brand-light ${className ?? ''}`}
      aria-label={alt}
    >
      <Video className="h-10 w-10" />
    </span>
  )
}
