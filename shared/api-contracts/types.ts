/**
 * Magician Clipper — shared API types (Phase 1 contract).
 *
 * Mirrors shared/api-contracts/api-v1.yaml (OpenAPI 3.0) and
 * shared/api-contracts/job-states.json. Keep all three in sync:
 * if a schema changes in the YAML, update this file and the state machine.
 *
 * Consumed by apps/web (frontend). The backend (Laravel) is the source of
 * truth for these shapes at runtime; this file is the frontend's compile-time
 * mirror of the contract.
 */

/** Job state machine — spec §11. Valid transitions: job-states.json. */
export type JobState =
  | 'uploaded'
  | 'queued'
  | 'probing'
  | 'extracting_audio'
  | 'transcribing'
  | 'detecting_scenes'
  | 'analyzing'
  | 'selecting_clips'
  | 'rendering'
  | 'captioning'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

export const TERMINAL_JOB_STATES: JobState[] = ['completed', 'failed', 'cancelled'];

export type ProjectStatus = 'draft' | 'processing' | 'completed' | 'failed';
export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type DurationMode = 'exact' | 'minimum' | 'maximum';
export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';
export type ProcessingMode = 'eco' | 'balanced' | 'fast';
export type ContentType =
  | 'podcast'
  | 'interview'
  | 'education'
  | 'gaming'
  | 'commentary'
  | 'story'
  | 'general';
export type Quality = 'draft' | 'standard' | 'high';
export type ClipStatus = 'pending' | 'rendering' | 'ready' | 'failed';
export type ExportStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type ExportFormat = 'mp4' | 'zip';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  /** Billing not implemented in Phase 1; informational only. */
  plan?: 'free' | 'pro' | null;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  user: User;
  token: string;
  token_type: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description?: string | null;
  status: ProjectStatus;
  source_duration_seconds?: number | null;
  clip_count: number;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaAsset {
  id: string;
  project_id: string;
  /** User-supplied name, display only. */
  original_filename: string;
  /** Server-generated filename; never trust the upload path. */
  stored_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  frame_rate?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  audio_streams?: number | null;
  bitrate?: number | null;
  preview_url?: string | null;
  created_at: string;
}

export interface ProcessingJob {
  id: string;
  project_id: string;
  media_asset_id: string;
  type: 'analyze' | 'render' | 'export';
  state: JobState;
  /** Human-readable stage, e.g. "Transcribing speech". */
  stage_label?: string | null;
  /**
   * Real, measurable progress only (0–100). 0 with an indeterminate stage
   * is honest; a fabricated percentage is not allowed.
   */
  progress_percent: number;
  error_code?: string | null;
  /** User-facing, sanitized error; never contains paths or secrets. */
  error_message?: string | null;
  attempts: number;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalyzeRequest {
  media_asset_id: string;
  /** Presets 1/3/5/10 or custom within limits. */
  clip_count: number;
  duration_mode: DurationMode;
  /** Presets 15/20/30/45/60 or custom (seconds). */
  duration_seconds: number;
  aspect_ratio: AspectRatio;
  captions_enabled?: boolean;
  /** e.g. "Bold Pop", "Highlight Box", "Bounce", "Karaoke", "Neon Glow". */
  caption_preset?: string;
  /** ISO 639-1 code, or null for auto-detect. */
  language?: string | null;
  processing_mode?: ProcessingMode;
  content_type?: ContentType;
  keywords_include?: string[];
  keywords_exclude?: string[];
  quality?: Quality;
}

export interface Clip {
  id: string;
  project_id: string;
  job_id: string;
  title?: string | null;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  aspect_ratio: AspectRatio;
  /** Explainable highlight score (0–1). */
  score?: number | null;
  /** Why this moment was selected. */
  highlight_reason?: string | null;
  /** Contributing signals, e.g. "speech_activity", "scene_change". */
  signals?: string[];
  transcript_excerpt?: string | null;
  status: ClipStatus;
  preview_url?: string | null;
  download_url?: string | null;
  thumbnail_url?: string | null;
  included: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Export {
  id: string;
  project_id: string;
  name: string;
  clip_count: number;
  format: ExportFormat;
  status: ExportStatus;
  file_size_bytes?: number | null;
  download_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  default_processing_mode?: ProcessingMode;
  default_aspect_ratio?: AspectRatio;
  default_caption_preset?: string;
  default_quality?: Quality;
  notifications_enabled?: boolean;
}

export interface AdminDashboard {
  total_users: number;
  active_users: number;
  total_projects: number;
  total_clips: number;
  jobs_processing: number;
  jobs_completed: number;
  jobs_failed: number;
  storage_used_bytes: number;
  queue_depth: number;
  worker_healthy: boolean;
  recent_users: User[];
  recent_projects: Project[];
}

export interface AdminUser extends User {
  project_count: number;
  job_count: number;
  storage_used_bytes: number;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  cpu_percent?: number | null;
  ram_percent?: number | null;
  disk_free_bytes?: number | null;
  worker_healthy: boolean;
  ffmpeg_version?: string | null;
  whisper_model?: string | null;
  whisper_model_available: boolean;
  database_ok: boolean;
  /** null when Redis is not configured (optional). */
  redis_ok?: boolean | null;
  /** null when Ollama is disabled. */
  ollama_ok?: boolean | null;
  checked_at: string;
}

export interface LogEntry {
  id: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  /** Sanitized; secrets and internal paths redacted. */
  message: string;
  context?: Record<string, unknown> | null;
  created_at: string;
}

export interface PaginationMeta {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ErrorResponse {
  message: string;
  code?: string;
  errors?: Record<string, string[]>;
}
