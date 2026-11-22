# Storage layout

All media lives on local disk under `storage/` (never as database blobs).
Paths are configurable via `.env` (`STORAGE_*_PATH`); the defaults below are
relative to the repo root. The `.gitignore` keeps directory structure
(`.gitkeep`) in git but never the media contents.

| Directory | Contents | Retention |
|---|---|---|
| `uploads/` | Original source videos, server-generated filenames | **Never deleted by cleanup.** Deleted only when the owning project is explicitly deleted by its owner/admin. |
| `projects/` | Per-project working data (transcripts, candidates, edits) | Kept with the project; deleted with the project. |
| `clips/` | Rendered clip MP4s | Kept until the clip/project is deleted. |
| `exports/` | Export bundles (single MP4s, ZIPs) | Kept until the export record is deleted or retention expiry (see below). |
| `thumbnails/` | Generated thumbnails/posters | Regenerable; may be purged when the owning media/clip is deleted. |
| `temp/` | Audio extraction, transcode intermediates, caption intermediates | **Cleaned after job completion or expiry** (`TEMP_RETENTION_HOURS`, default 24 h). Never contains originals. |
| `logs/` | Structured job/service logs (secrets redacted) | Rotated by the backend; keep recent runs for diagnostics. |

## Rules (spec §1, §4, §13)

1. **Originals are never deleted by cleanup.** Only an explicit project delete
   removes an upload, and only after confirmation.
2. Temp files are separate from originals and are cleaned after job
   completion or retention expiry.
3. Filenames are server-generated; uploaded paths are never trusted.
4. No internal filesystem paths are exposed to normal users — downloads go
   through signed/authorized URLs served by the backend.
5. Each user's projects and media are isolated by server-side authorization;
   storage paths must never be guessable across users.
6. Do not load entire large videos into RAM; processing streams from disk.
