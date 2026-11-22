"""SQLite job ledger (stdlib ``sqlite3`` only).

Database file: ``services/video-engine/data/jobs.db`` (gitignored).
Table ``jobs``: id, source_path, state, stage, progress, error_code,
error_message, created_at, updated_at.

State changes are validated against ``app.core.job_states``; an illegal
transition raises ``ValueError`` and leaves the row untouched.
"""

from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone

from app.core.config import settings
from app.core.job_states import is_valid_transition


def _db_path() -> str:
    settings.ensure_dirs()
    return os.path.join(settings.data_dir, "jobs.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create the ``jobs`` table if it does not exist."""
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id            TEXT PRIMARY KEY,
                source_path   TEXT NOT NULL,
                state         TEXT NOT NULL,
                stage         TEXT,
                progress      REAL NOT NULL DEFAULT 0.0,
                error_code    TEXT,
                error_message TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_job(source_path: str, state: str = "uploaded") -> dict:
    """Insert a new job row and return it as a dict."""
    job_id = str(uuid.uuid4())
    now = _now_iso()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, source_path, state, stage, progress,
                              error_code, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0.0, NULL, NULL, ?, ?)
            """,
            (job_id, source_path, state, state, now, now),
        )
    return get_job(job_id)  # type: ignore[return-value]


def get_job(job_id: str) -> dict | None:
    """Return the job row as a dict, or None if it does not exist."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return dict(row) if row else None


def update_job(
    job_id: str,
    *,
    state: str | None = None,
    stage: str | None = None,
    progress: float | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> dict | None:
    """Update a job row. State changes are validated against the state
    machine; ``ValueError`` is raised for an illegal transition."""
    job = get_job(job_id)
    if job is None:
        return None
    if state is not None and state != job["state"]:
        if not is_valid_transition(job["state"], state):
            raise ValueError(
                f"Illegal job transition: {job['state']!r} -> {state!r}"
            )
    fields: list[str] = []
    values: list[object] = []
    if state is not None:
        fields.append("state = ?")
        values.append(state)
    if stage is not None:
        fields.append("stage = ?")
        values.append(stage)
    if progress is not None:
        fields.append("progress = ?")
        values.append(max(0.0, min(1.0, float(progress))))
    if error_code is not None:
        fields.append("error_code = ?")
        values.append(error_code)
    if error_message is not None:
        fields.append("error_message = ?")
        values.append(error_message)
    fields.append("updated_at = ?")
    values.append(_now_iso())
    values.append(job_id)
    with _connect() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?", values)
    return get_job(job_id)


def list_jobs(limit: int = 50) -> list[dict]:
    """Return the most recent jobs (newest first)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]
