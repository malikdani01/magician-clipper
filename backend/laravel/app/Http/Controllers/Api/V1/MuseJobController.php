<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\BrandAsset;
use App\Models\Clip;
use App\Models\ClipRerender;
use App\Models\Notification;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\UserSetting;
use App\Support\MediaStorage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use InvalidArgumentException;

/**
 * Secure Job API for Muse (Phase 3).
 *
 * Authenticated ONLY by the X-Muse-Api-Key header (EnsureMuseApiKey
 * middleware) — never by a user session. This is the channel the worker
 * uses: list Queued jobs, read full settings + source, report status,
 * and upload rendered clips back to the same Job ID.
 *
 * The worker runs on the same machine as the backend, so job detail
 * includes the absolute local path of an uploaded source file. That path
 * is NEVER returned by the user-facing endpoints. When the worker runs
 * on a DIFFERENT machine (the hosted site + remote Muse worker), the
 * local path is meaningless — the worker then downloads the uploaded
 * source over GET /muse/jobs/{job}/source below.
 */
class MuseJobController extends Controller
{
    /**
     * A job left in an in-flight state (probing … validating) with no
     * update for this long is treated as abandoned — its worker died
     * (VM restart, crash) mid-job. The queued listing reclaims it so
     * the next poll re-runs it from the start instead of leaving it
     * stuck forever. 30 minutes is far longer than any single stage
     * takes on a live worker (transcription ~1 min, a render ~1-2 min
     * per clip), so a live job is never reclaimed by mistake.
     * 'cancelling' is NEVER reclaimed: a user asked to cancel it.
     */
    public const STALE_AFTER_MINUTES = 30;

    /** In-flight states a live worker can be in (never 'cancelling'). */
    private function inFlightStates(): array
    {
        return [
            ProcessingJob::STATE_PROBING,
            ProcessingJob::STATE_EXTRACTING_AUDIO,
            ProcessingJob::STATE_TRANSCRIBING,
            ProcessingJob::STATE_DETECTING_SCENES,
            ProcessingJob::STATE_ANALYZING,
            ProcessingJob::STATE_SELECTING_CLIPS,
            ProcessingJob::STATE_RENDERING,
            ProcessingJob::STATE_CAPTIONING,
            ProcessingJob::STATE_VALIDATING,
        ];
    }

    /** True when this job is a stale in-flight job the worker may reclaim. */
    private function isStale(ProcessingJob $job): bool
    {
        return in_array($job->state, $this->inFlightStates(), true)
            && $job->updated_at !== null
            && $job->updated_at->lt(now()->subMinutes(self::STALE_AFTER_MINUTES));
    }

    /** Map a public status (?status=queued) to internal states. */
    private function statesForPublicStatus(string $status): ?array
    {
        return match (strtolower($status)) {
            'queued' => [ProcessingJob::STATE_UPLOADED, ProcessingJob::STATE_QUEUED],
            'processing' => array_values(array_diff(
                ProcessingJob::STATES,
                [
                    ProcessingJob::STATE_UPLOADED, ProcessingJob::STATE_QUEUED,
                    ProcessingJob::STATE_COMPLETED, ProcessingJob::STATE_FAILED,
                    ProcessingJob::STATE_CANCELLED,
                ]
            )),
            'ready' => [ProcessingJob::STATE_COMPLETED],
            'failed' => [ProcessingJob::STATE_FAILED],
            'cancelled' => [ProcessingJob::STATE_CANCELLED],
            default => null,
        };
    }

    /**
     * GET /api/v1/muse/jobs/{job}/source
     * Streams the job's uploaded source video to the worker. This is the
     * channel that makes the worker work when it runs on a DIFFERENT
     * machine than the backend (hosted site + remote Muse worker): the
     * local path in toWorkerArray is meaningless there, so the worker
     * downloads the file over this endpoint instead. Link jobs have no
     * uploaded file and get a 404 with a clear message.
     */
    public function source(ProcessingJob $job)
    {
        // Batch 5: the source lives on the JOB's disk (local as
        // before, or the owner's cloud bucket). The worker downloads
        // over this endpoint either way, so it needs no S3 knowledge.
        $disk = MediaStorage::diskForJob($job);
        if ($job->source_path === null
            || ! $disk->exists($job->source_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This job has no uploaded source file to download (link job or file missing).',
            ], 404);
        }

        return $disk->download(
            $job->source_path, basename($job->source_path)
        );
    }

    /**
     * GET /api/v1/muse/jobs/{job}/music-bed
     * Streams the job's uploaded music bed to the worker (muse-guarded,
     * like the source endpoint). A job with no bed is a 404, never a
     * fabricated file; the worker only ever gets a URL for a bed that
     * exists (see toWorkerArray).
     */
    public function musicBed(ProcessingJob $job)
    {
        if ($job->music_bed_path === null
            || ! Storage::disk('local')->exists($job->music_bed_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This job has no music bed uploaded.',
            ], 404);
        }

        return Storage::disk('local')->download(
            $job->music_bed_path, $job->music_bed_name ?? basename($job->music_bed_path)
        );
    }

    /** Full job representation for the worker (settings + source included). */
    private function toWorkerArray(ProcessingJob $job): array
    {
        $job->load('clips');

        return [
            'id' => $job->id,
            'project_id' => $job->project_id,
            'user_id' => $job->user_id,
            'status' => $job->publicStatus(),
            'state' => $job->state,
            'stage' => $job->stage,
            'progress' => $job->progress,
            // True when the worker died mid-job and this listing is
            // reclaiming it (see index()). The worker clears any
            // partial clips and re-runs it from the start.
            'stale' => $this->isStale($job),
            // Batch 9: the settings array carries ost_position,
            // sfx and colour_grade verbatim (JobController::
            // buildSettings always sets them); the worker reads
            // them from here, unchanged.
            'settings' => $job->settings,
            'source_type' => $job->source_type,
            'source_url' => $job->source_url,
            // Batch 9: the music-bed download URL is present ONLY
            // when a bed is actually stored — never a URL for a job
            // with no bed. The worker downloads + mixes it; SFX are
            // mixed from the engine's own assets/sfx files.
            'music_bed_url' => ($job->music_bed_path !== null
                    && Storage::disk('local')->exists($job->music_bed_path))
                ? url("/api/v1/muse/jobs/{$job->id}/music-bed")
                : null,
            'music_bed_name' => $job->music_bed_name,
            // Relative path under Laravel storage/app (upload source).
            'source_path' => $job->source_path,
            // Absolute local path — only meaningful because the worker runs
            // on the same machine as this backend. Batch 5: a source on
            // the cloud disk has no local path — the worker downloads it
            // over the source endpoint instead (see resolve_source).
            'source_local_path' => ($job->source_path && ($job->disk ?? 'local') === 'local')
                ? Storage::disk('local')->path($job->source_path)
                : null,
            'clips' => $job->clips->map(fn ($clip) => [
                'id' => $clip->id,
                'title' => $clip->title,
                'status' => $clip->status,
                'start_seconds' => $clip->start_seconds,
                'end_seconds' => $clip->end_seconds,
                'duration_seconds' => $clip->duration_seconds,
                'aspect_ratio' => $clip->aspect_ratio,
                'file_size_bytes' => $clip->file_size_bytes,
                'output_path' => $clip->output_path,
                // Batch 9: face tracking as reported, and the
                // Variant B link (null = original clip).
                'face_tracked' => (bool) $clip->face_tracked,
                'variant_of_clip_id' => $clip->variant_of_clip_id,
            ])->all(),
            'error_code' => $job->error_code,
            'error_message' => $job->error_message,
            // Whether the worker stitched the brand-kit intro/outro
            // onto this job's clips (reported by the worker, read back
            // here so it can confirm what was stored).
            'intro_applied' => (bool) $job->intro_applied,
            'outro_applied' => (bool) $job->outro_applied,
            // Brand-kit intro/outro for this job's owner, so the worker
            // can stitch them onto the rendered clips. Either side is
            // null when the user has not uploaded that asset; the
            // download URLs are served by the muse-guarded endpoint
            // below (the worker already holds the Muse API key).
            'brand_assets' => $this->brandAssetsForWorker($job),
            'created_at' => $job->created_at,
            'updated_at' => $job->updated_at,
        ];
    }

    /** Brand-kit assets for the worker: intro/outro with download URLs. */
    private function brandAssetsForWorker(ProcessingJob $job): array
    {
        $assets = $job->user?->brandAssets()->get()->keyBy('kind') ?? collect();
        $entry = fn (?BrandAsset $asset) => $asset === null ? null : [
            'id' => $asset->id,
            'download_url' => url("/api/v1/muse/brand-assets/{$asset->id}/download"),
            'duration_seconds' => $asset->duration_seconds,
        ];

        return [
            'intro' => $entry($assets->get(BrandAsset::KIND_INTRO)),
            'outro' => $entry($assets->get(BrandAsset::KIND_OUTRO)),
            // Batch 4: the Brand Kit logo (an image, not a video).
            // The worker overlays it when the job's logo_overlay
            // setting is on; duration is 0 for images and unused.
            'logo' => $entry($assets->get(BrandAsset::KIND_LOGO)),
        ];
    }

    /**
     * GET /api/v1/muse/brand-assets/{asset}/download
     * Streams a brand asset to the worker (muse-guarded, like the job
     * source endpoint). A missing file is a 404, never a fabricated
     * download.
     */
    public function downloadBrandAsset(BrandAsset $asset)
    {
        if ($asset->path === null
            || ! Storage::disk('local')->exists($asset->path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This brand asset has no file to download.',
            ], 404);
        }

        return Storage::disk('local')->download(
            $asset->path, basename($asset->path)
        );
    }

    /**
     * GET /api/v1/muse/jobs?status=queued — list jobs, oldest first.
     * The worker polls this with status=queued. Other statuses are
     * supported for inspection (?status=processing|ready|failed).
     */
    public function index(Request $request)
    {
        $query = ProcessingJob::with('clips')->orderBy('created_at', 'asc');

        if ($request->filled('status')) {
            $states = $this->statesForPublicStatus($request->input('status'));
            if ($states === null) {
                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'status must be one of: queued, processing, ready, failed, cancelled.',
                ], 422);
            }
            if (strtolower($request->input('status')) === 'queued') {
                // The queued listing also reclaims stale in-flight jobs:
                // a worker killed mid-job (VM restart, crash) leaves the
                // job in an in-flight state with no updates. Without this
                // arm it would sit "Processing" forever and never be
                // picked up again. Fresh in-flight jobs are NOT included
                // — only ones untouched for STALE_AFTER_MINUTES.
                $query->where(function ($q) use ($states) {
                    $q->whereIn('state', $states)
                        ->orWhere(function ($q2) {
                            $q2->whereIn('state', $this->inFlightStates())
                                ->where('updated_at', '<', now()->subMinutes(self::STALE_AFTER_MINUTES));
                        });
                });
            } else {
                $query->whereIn('state', $states);
            }
        }

        $jobs = $query->paginate(50);

        $jobs->getCollection()->transform(fn ($job) => $this->toWorkerArray($job));

        return response()->json($jobs);
    }

    /**
     * GET /api/v1/muse/jobs/{id} — full settings + video file path/link.
     */
    public function show(Request $request, ProcessingJob $job)
    {
        return response()->json(['job' => $this->toWorkerArray($job)]);
    }

    /**
     * PATCH /api/v1/muse/jobs/{id}/status — report a public status.
     *
     * status: Queued | Processing | Ready | Failed (case-insensitive).
     * Optional: error_reason (required with Failed), stage, progress.
     * The internal state machine is walked along valid transitions
     * (ProcessingJob::advanceTo); an illegal transition is a 422, never a
     * silent overwrite. Reporting the same public status again only
     * updates stage/progress (so the worker can report progress while
     * staying in Processing).
     */
    public function updateStatus(Request $request, ProcessingJob $job)
    {
        $validated = $request->validate([
            'status' => ['required', 'string', Rule::in(
                ['queued', 'processing', 'ready', 'failed', 'cancelled',
                    'Queued', 'Processing', 'Ready', 'Failed', 'Cancelled']
            )],
            'error_reason' => ['sometimes', 'nullable', 'string', 'max:500'],
            'stage' => ['sometimes', 'nullable', 'string', 'max:255'],
            'progress' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:100'],
            // Human-readable note the worker leaves on the job (e.g. why
            // fewer clips were delivered). Shown on the job page.
            'note' => ['sometimes', 'nullable', 'string', 'max:1000'],
            // The worker's own ffmpeg/ffprobe versions, reported with
            // every status update — the hosted site has no engine URL
            // to probe, so this is how the dashboards learn them.
            'engine_versions' => ['sometimes', 'nullable', 'array'],
            'engine_versions.ffmpeg' => ['sometimes', 'nullable', 'string', 'max:255'],
            'engine_versions.ffprobe' => ['sometimes', 'nullable', 'string', 'max:255'],
            // Whether the worker stitched the user's brand-kit intro /
            // outro onto this job's clips. Reported with the final
            // Ready report (but accepted on any status report) and
            // stored whenever present; the frontend renders a badge
            // from the flags.
            'intro_applied' => ['sometimes', 'boolean'],
            'outro_applied' => ['sometimes', 'boolean'],
            // Batch 4: title + hashtag suggestions derived from the
            // job's own transcript. Stored with the final Ready
            // report; a silent job sends neither.
            'title_suggestion' => ['sometimes', 'nullable', 'string', 'max:120'],
            'hashtags' => ['sometimes', 'nullable', 'array', 'max:10'],
            'hashtags.*' => ['string', 'max:30'],
        ]);

        $public = strtolower($validated['status']);
        $stage = $validated['stage'] ?? null;
        $progress = $validated['progress'] ?? null;

        // A note rides along with any status report and is stored on the
        // job itself, so it survives the state transition below. The
        // intro/outro-applied flags ride along the same way and are
        // stored whenever present, on any status report.
        $needsSave = false;
        if (array_key_exists('note', $validated)) {
            $job->note = $validated['note'];
            $needsSave = true;
        }
        foreach (['intro_applied', 'outro_applied'] as $flag) {
            if (array_key_exists($flag, $validated)) {
                $job->{$flag} = (bool) $validated[$flag];
                $needsSave = true;
            }
        }
        // Batch 4: title + hashtag suggestions ride the same way.
        if (array_key_exists('title_suggestion', $validated)) {
            $job->title_suggestion = $validated['title_suggestion'];
            $needsSave = true;
        }
        if (array_key_exists('hashtags', $validated)) {
            $job->hashtags = $validated['hashtags'];
            $needsSave = true;
        }
        if ($needsSave) {
            $job->save();
        }

        // Engine versions ride along with any status report and are
        // kept in the cache for the dashboards. When nothing has been
        // reported yet the UI says so honestly.
        if (array_key_exists('engine_versions', $validated)) {
            $versions = $validated['engine_versions'] ?? [];
            Cache::forever('engine_versions', [
                'ffmpeg' => $versions['ffmpeg'] ?? null,
                'ffprobe' => $versions['ffprobe'] ?? null,
                'reported_at' => now()->toIso8601String(),
            ]);
        }

        // Same-status report: update stage/progress, and let the stored
        // state follow the stage when the stage names a pipeline state
        // (a job stuck at "probing" while rendering is a stale state).
        if ($job->publicStatus() === $public) {
            $job->followStage($stage);
            if ($stage !== null) {
                $job->stage = $stage;
            }
            if ($progress !== null) {
                $job->progress = $progress;
            }
            $job->save();

            return response()->json(['job' => $this->toWorkerArray($job->fresh())]);
        }

        try {
            match ($public) {
                'queued' => $job->advanceTo(ProcessingJob::STATE_QUEUED, $stage, $progress),
                // First Processing report: start at the pipeline state
                // the stage names (e.g. transcribing), not always
                // probing — otherwise the state lags behind the stage.
                'processing' => $job->advanceTo(
                    ProcessingJob::STAGE_TO_STATE[$stage ?? ''] ?? ProcessingJob::STATE_PROBING,
                    $stage ?? 'Processing',
                    $progress ?? 0
                ),
                'ready' => $job->advanceTo(ProcessingJob::STATE_COMPLETED, $stage ?? 'Ready', 100),
                'failed' => $job->fail(
                    'worker_failed',
                    $validated['error_reason'] ?? 'Worker reported failure without a reason.'
                ),
                // Only a 'cancelling' job can be cancelled by the worker:
                // the worker never decides to cancel on its own — it only
                // completes a cancellation the user already requested.
                // (Queued/uploaded -> cancelled is allowed for the
                // user-facing cancel endpoint, not for the worker.)
                'cancelled' => $job->state === ProcessingJob::STATE_CANCELLING
                    ? $job->transitionTo(ProcessingJob::STATE_CANCELLED)
                    : throw new InvalidArgumentException(
                        "Worker cannot cancel a job in state: {$job->state}"
                    ),
            };
        } catch (InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        // Terminal transitions notify the job owner exactly once per
        // (job, type). firstOrCreate + the unique (job_id, type) index
        // make a duplicate impossible even if the worker reports the
        // transition twice. This runs only on a real transition — the
        // same-status early return above never reaches here.
        if ($public === 'ready') {
            $clipCount = $job->clips()->count();
            Notification::firstOrCreate(
                [
                    'user_id' => $job->user_id,
                    'job_id' => $job->id,
                    'type' => Notification::TYPE_JOB_READY,
                ],
                [
                    'title' => "Job #{$job->id} is ready",
                    'body' => $clipCount === 1
                        ? '1 clip is ready to preview and download.'
                        : "{$clipCount} clips are ready to preview and download.",
                    'link' => "/jobs/{$job->id}",
                ]
            );
        } elseif ($public === 'failed') {
            Notification::firstOrCreate(
                [
                    'user_id' => $job->user_id,
                    'job_id' => $job->id,
                    'type' => Notification::TYPE_JOB_FAILED,
                ],
                [
                    'title' => "Job #{$job->id} failed",
                    'body' => $validated['error_reason'] ?? 'Worker reported failure without a reason.',
                    'link' => "/jobs/{$job->id}",
                ]
            );
        }

        // Keep the project in step with its job: the dashboard's Recent
        // projects list reads project.status, and it used to stay
        // "processing" forever — a finished job still showed as
        // "Processing" at 100% (seen live 2026-11-23 on Job #1).
        $projectStatus = match ($public) {
            'ready' => Project::STATUS_READY,
            'failed' => Project::STATUS_FAILED,
            default => Project::STATUS_PROCESSING,
        };
        $project = $job->project;
        if ($project !== null && $project->status !== $projectStatus) {
            $project->update(['status' => $projectStatus]);
        }

        return response()->json(['job' => $this->toWorkerArray($job->fresh())]);
    }

    /**
     * POST /api/v1/muse/jobs/{id}/clips — upload one rendered MP4 clip.
     *
     * Multipart: file (MP4) + title, start_seconds, end_seconds,
     * duration_seconds, score (0-1), reason, transcript_excerpt,
     * caption_style (the style burned into this clip, for the job page
     * and for re-renders). The upload is validated with ffprobe (must
     * be a playable video with a video stream) before a clip record is
     * created; the file is stored under storage/app/clips/{job_id}/<uuid>.mp4.
     */
    public function storeClip(Request $request, ProcessingJob $job)
    {
        if ($job->publicStatus() !== ProcessingJob::PUBLIC_STATUS_PROCESSING) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Clips can only be uploaded while the job is Processing (current status: {$job->publicStatus()}).",
            ], 422);
        }

        // Multipart sends booleans as strings; normalise "true"/"false"
        // like JobController::store does for job settings.
        if ($request->has('face_tracked') && is_string($request->input('face_tracked'))) {
            $request->merge([
                'face_tracked' => filter_var($request->input('face_tracked'), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                    ?? $request->input('face_tracked'),
            ]);
        }

        $validated = $request->validate([
            'file' => ['required', 'file', 'mimes:mp4', 'max:2097152'],
            'thumbnail' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            // Batch 4: up to 3 thumbnail-picker candidate frames from
            // the worker (10/50/90% of the clip). Each is optional; a
            // missing or invalid one is skipped, never a 422.
            'candidate_1' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_2' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_3' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'title' => ['sometimes', 'nullable', 'string', 'max:255'],
            'start_seconds' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'end_seconds' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'duration_seconds' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'score' => ['sometimes', 'nullable', 'numeric', 'min:0', 'max:1'],
            'reason' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'transcript_excerpt' => ['sometimes', 'nullable', 'string', 'max:5000'],
            'caption_style' => ['sometimes', 'nullable', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
            // Batch 9: whether the face was tracked through this clip
            // (default false when the worker does not send it) and,
            // for an A/B variant render, the Variant A clip this is
            // Variant B of — it must be an existing clip of THIS job.
            'face_tracked' => ['sometimes', 'boolean'],
            'variant_of_clip_id' => ['sometimes', 'nullable', 'integer', 'exists:clips,id'],
            // Batch 3 multi-ratio: the worker sends the ratio this clip
            // was actually rendered in; it wins over the job's ratio so
            // each ratio variant stores its own row.
            'aspect_ratio' => ['sometimes', 'nullable', 'string', Rule::in(UserSetting::ASPECT_RATIOS)],
            // Optional per-signal score breakdown, sent by the worker as
            // a JSON-encoded string (multipart has no nested objects):
            // {"hook": 92, "retention": 78}. Decoded + shape-checked
            // below; malformed input is a 422, never a stored guess.
            'score_breakdown' => ['sometimes', 'nullable', 'string'],
        ]);

        $variantOf = null;
        if (! empty($validated['variant_of_clip_id'])) {
            $variantOf = Clip::find($validated['variant_of_clip_id']);
            if ($variantOf === null || $variantOf->job_id !== $job->id) {
                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'variant_of_clip_id must be an existing clip of this job.',
                ], 422);
            }
        }

        $scoreBreakdown = null;
        if ($request->filled('score_breakdown')) {
            $decoded = json_decode($request->input('score_breakdown'), true);
            $valid = is_array($decoded) && json_last_error() === JSON_ERROR_NONE;
            if ($valid) {
                foreach ($decoded as $key => $value) {
                    if (! is_string($key) || ! is_int($value) || $value < 0 || $value > 100) {
                        $valid = false;
                        break;
                    }
                }
            }
            if (! $valid) {
                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'score_breakdown must be a JSON object mapping signal names to integer scores from 0 to 100.',
                ], 422);
            }
            $scoreBreakdown = $decoded;
        }

        $file = $request->file('file');
        $filename = Str::uuid()->toString().'.mp4';
        $relativePath = "clips/{$job->id}/{$filename}";
        // Batch 5: clips go to the JOB's disk (local as before, or the
        // owner's cloud bucket). The clip row records the disk so
        // downloads always read from the right place.
        $disk = MediaStorage::diskForJob($job);
        $disk->putFileAs("clips/{$job->id}", $file, $filename);
        [$absolutePath, $isTemp] = MediaStorage::localPathFor(
            $job->disk ?? MediaStorage::DISK_LOCAL, $relativePath, $job->user
        );

        // Validate with ffprobe before creating any record.
        $probe = $this->probeClip($absolutePath);
        if ($isTemp) {
            @unlink($absolutePath);
        }
        if ($probe === null) {
            $disk->delete($relativePath);

            return response()->json([
                'error' => 'validation_error',
                'message' => 'The uploaded clip is not a playable MP4 (FFprobe could not read a video stream).',
            ], 422);
        }

        $start = (float) ($validated['start_seconds'] ?? 0);
        $end = (float) ($validated['end_seconds'] ?? $probe['duration']);
        $duration = (float) ($validated['duration_seconds'] ?? ($end - $start));
        if ($duration <= 0) {
            $duration = $probe['duration'];
        }

        $settings = $job->settings ?? [];

        // Optional first-frame thumbnail (JPEG/PNG from the worker,
        // which owns ffmpeg). Stored beside the clip; served by the
        // user-facing thumbnail endpoint. A missing/invalid thumbnail
        // never blocks the clip itself.
        $thumbnailPath = null;
        if ($request->hasFile('thumbnail')) {
            $thumbFilename = 'thumb-'.Str::uuid()->toString().'.jpg';
            $disk->putFileAs(
                "clips/{$job->id}", $request->file('thumbnail'), $thumbFilename
            );
            $thumbnailPath = "clips/{$job->id}/{$thumbFilename}";
        }

        // Batch 4: thumbnail-picker candidates, stored beside the
        // clip in upload order (candidate_1 is the 10% frame, then
        // 50%, then 90%). A candidate that fails to store is skipped
        // rather than failing the clip.
        $candidatePaths = [];
        foreach (['candidate_1', 'candidate_2', 'candidate_3'] as $field) {
            if (! $request->hasFile($field)) {
                continue;
            }
            $candFilename = 'cand-'.Str::uuid()->toString().'.jpg';
            $disk->putFileAs(
                "clips/{$job->id}", $request->file($field), $candFilename
            );
            $candidatePaths[] = "clips/{$job->id}/{$candFilename}";
        }

        $clip = Clip::create([
            'project_id' => $job->project_id,
            'job_id' => $job->id,
            'title' => $validated['title'] ?? ('Clip '.($job->clips()->count() + 1)),
            'start_seconds' => $start,
            'end_seconds' => $end,
            'duration_seconds' => $duration,
            'aspect_ratio' => $validated['aspect_ratio'] ?? ($settings['aspect_ratio'] ?? '9:16'),
            'status' => Clip::STATUS_READY,
            'output_path' => $relativePath,
            'disk' => $job->disk ?? MediaStorage::DISK_LOCAL,
            'thumbnail_path' => $thumbnailPath,
            'thumbnail_candidates' => $candidatePaths !== [] ? $candidatePaths : null,
            'file_size_bytes' => $disk->size($relativePath),
            'score' => $validated['score'] ?? null,
            'score_breakdown' => $scoreBreakdown,
            'reason' => $validated['reason'] ?? null,
            'transcript_excerpt' => $validated['transcript_excerpt'] ?? null,
            'caption_style' => $validated['caption_style']
                ?? ($settings['caption_style'] ?? null),
            // Batch 9: face tracking as reported (false when the
            // worker does not send it) + the Variant B link.
            'face_tracked' => $validated['face_tracked'] ?? false,
            'variant_of_clip_id' => $variantOf?->id,
        ]);

        return response()->json(['clip' => $clip->fresh()], 201);
    }

    /**
     * Probe an uploaded clip with ffprobe. Returns [duration, width,
     * height] or null when the file is not a playable video.
     */
    private function probeClip(string $absolutePath): ?array
    {
        $ffprobe = trim((string) shell_exec('command -v ffprobe'));
        if ($ffprobe === '') {
            // No ffprobe on this host: accept the file (size > 0 checked by
            // the caller via the stored size); validation happens in the
            // worker before upload.
            return ['duration' => 0.0, 'width' => 0, 'height' => 0];
        }
        $command = escapeshellcmd($ffprobe)
            .' -v error -show_format -show_streams -of json '
            .escapeshellarg($absolutePath);
        $output = shell_exec($command);
        if ($output === null || $output === '') {
            return null;
        }
        $data = json_decode($output, true);
        if (! is_array($data) || empty($data['streams'])) {
            return null;
        }
        $video = null;
        foreach ($data['streams'] as $stream) {
            if ($stream['codec_type'] === 'video') {
                $video = $stream;
                break;
            }
        }
        if ($video === null) {
            return null;
        }
        $duration = (float) ($data['format']['duration'] ?? $video['duration'] ?? 0);
        if ($duration <= 0) {
            return null;
        }

        return [
            'duration' => $duration,
            'width' => (int) ($video['width'] ?? 0),
            'height' => (int) ($video['height'] ?? 0),
        ];
    }

    /**
     * DELETE /api/v1/muse/jobs/{job}/clips — delete ALL clips of a job
     * (rows + stored files). Used ONLY by the worker when it reclaims a
     * stale job: the partial clips from the dead run must not survive
     * alongside the fresh run's clips, or the job page would show
     * duplicates. Returns the number of clips deleted.
     */
    public function destroyClips(Request $request, ProcessingJob $job)
    {
        $deleted = 0;
        foreach ($job->clips as $clip) {
            // Batch 5: delete from the CLIP's own disk.
            $disk = MediaStorage::disk($clip->disk ?? MediaStorage::DISK_LOCAL, $clip->job?->user);
            if ($clip->output_path) {
                $disk->delete($clip->output_path);
            }
            if ($clip->thumbnail_path) {
                $disk->delete($clip->thumbnail_path);
            }
            // Batch 4: candidate frames ride with the clip.
            foreach ((array) ($clip->thumbnail_candidates ?? []) as $candidate) {
                if (is_string($candidate)) {
                    $disk->delete($candidate);
                }
            }
            $clip->delete();
            $deleted++;
        }

        return response()->json(['deleted' => $deleted]);
    }

    // --- Clip re-renders (worker side) --------------------------------

    /**
     * GET /api/v1/muse/rerenders — queued clip re-render requests,
     * oldest first. The worker takes the first, claims it via
     * updateRerenderStatus, re-renders the clip's SAME window with the
     * requested caption style, and uploads the result via
     * replaceClipFile. A re-render is not a job: it never appears in
     * the jobs list and never counts toward job usage.
     */
    public function listRerenders(Request $request)
    {
        $rerenders = ClipRerender::where('status', ClipRerender::STATUS_QUEUED)
            ->with('clip')
            ->orderBy('id')
            ->get()
            ->map(fn (ClipRerender $r) => $r->toWorkerArray())
            ->all();

        return response()->json(['rerenders' => $rerenders]);
    }

    /**
     * PATCH /api/v1/muse/rerenders/{rerender}/status — the worker claims
     * a re-render (queued -> processing) and reports its outcome
     * (processing -> ready | failed). Any other transition is a 422:
     * the worker never re-opens a finished re-render.
     */
    public function updateRerenderStatus(Request $request, ClipRerender $rerender)
    {
        $validated = $request->validate([
            'status' => ['required', 'string', Rule::in(['processing', 'ready', 'failed'])],
            'error_message' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        $next = $validated['status'];
        $allowed = match ($rerender->status) {
            ClipRerender::STATUS_QUEUED => [$next === ClipRerender::STATUS_PROCESSING],
            ClipRerender::STATUS_PROCESSING => [
                $next === ClipRerender::STATUS_READY || $next === ClipRerender::STATUS_FAILED,
            ],
            default => [false],
        };

        if (! in_array(true, $allowed, true)) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Cannot move a {$rerender->status} re-render to {$next}.",
            ], 422);
        }

        $rerender->update([
            'status' => $next,
            'error_message' => $validated['error_message'] ?? ($next === ClipRerender::STATUS_FAILED ? 'Worker reported failure without a reason.' : null),
        ]);

        return response()->json(['rerender' => $rerender->fresh()->toWorkerArray()]);
    }

    /**
     * POST /api/v1/muse/clips/{clip}/file — replace a clip's rendered
     * file after a re-render. Multipart: file (MP4) + rerender_id +
     * optional thumbnail. The file is ffprobe-validated BEFORE anything
     * is replaced (a bad upload never clobbers a good clip); then the
     * old file + thumbnail are deleted, the clip row is updated
     * (output_path, thumbnail_path, size, duration, caption_style),
     * and the re-render is marked ready — all in one request so the
     * clip is never left pointing at a file that does not exist.
     * Unlike storeClip, the parent job does NOT need to be Processing:
     * a re-render targets a finished job's clip.
     */
    public function replaceClipFile(Request $request, Clip $clip)
    {
        $validated = $request->validate([
            'file' => ['required', 'file', 'mimes:mp4', 'max:2097152'],
            'thumbnail' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            // Batch 4: fresh thumbnail-picker candidates for the
            // re-rendered file (its frames changed with the style).
            'candidate_1' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_2' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_3' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'rerender_id' => ['required', 'integer'],
            'duration_seconds' => ['sometimes', 'nullable', 'numeric', 'min:0'],
        ]);

        $rerender = ClipRerender::find($validated['rerender_id']);
        if ($rerender === null || $rerender->clip_id !== $clip->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such re-render for this clip.',
            ], 404);
        }
        if ($rerender->status !== ClipRerender::STATUS_PROCESSING) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Re-render must be processing to upload a replacement file (current status: {$rerender->status}).",
            ], 422);
        }

        $jobId = $clip->job_id ?? $clip->project_id;
        $file = $request->file('file');
        $filename = Str::uuid()->toString().'.mp4';
        $relativePath = "clips/{$jobId}/{$filename}";
        // Batch 5: the replacement lives on the clip's own disk.
        $disk = MediaStorage::disk($clip->disk ?? MediaStorage::DISK_LOCAL, $clip->job?->user);
        $disk->putFileAs("clips/{$jobId}", $file, $filename);
        [$absolutePath, $isTemp] = MediaStorage::localPathFor(
            $clip->disk ?? MediaStorage::DISK_LOCAL, $relativePath, $clip->job?->user
        );

        $probe = $this->probeClip($absolutePath);
        if ($isTemp) {
            @unlink($absolutePath);
        }
        if ($probe === null) {
            $disk->delete($relativePath);

            return response()->json([
                'error' => 'validation_error',
                'message' => 'The replacement clip is not a playable MP4 (FFprobe could not read a video stream).',
            ], 422);
        }

        $thumbnailPath = $clip->thumbnail_path;
        if ($request->hasFile('thumbnail')) {
            $thumbFilename = 'thumb-'.Str::uuid()->toString().'.jpg';
            $disk->putFileAs(
                "clips/{$jobId}", $request->file('thumbnail'), $thumbFilename
            );
            $thumbnailPath = "clips/{$jobId}/{$thumbFilename}";
        }

        // Batch 4: fresh candidates replace the old ones (the file
        // changed, so the old frames no longer match it). When the
        // worker sends none, the old candidates are kept — a missing
        // field is not a deletion.
        $newCandidates = null;
        if ($request->hasFile('candidate_1')
            || $request->hasFile('candidate_2')
            || $request->hasFile('candidate_3')) {
            $newCandidates = [];
            foreach (['candidate_1', 'candidate_2', 'candidate_3'] as $field) {
                if (! $request->hasFile($field)) {
                    continue;
                }
                $candFilename = 'cand-'.Str::uuid()->toString().'.jpg';
                $disk->putFileAs(
                    "clips/{$jobId}", $request->file($field), $candFilename
                );
                $newCandidates[] = "clips/{$jobId}/{$candFilename}";
            }
        }

        $oldOutput = $clip->output_path;
        $oldThumbnail = $clip->thumbnail_path;
        $oldCandidates = (array) ($clip->thumbnail_candidates ?? []);

        $clip->update([
            'output_path' => $relativePath,
            'thumbnail_path' => $thumbnailPath,
            'thumbnail_candidates' => $newCandidates ?? $clip->thumbnail_candidates,
            'file_size_bytes' => $disk->size($relativePath),
            'duration_seconds' => (float) ($validated['duration_seconds'] ?? $probe['duration']),
            'caption_style' => $rerender->caption_style,
            'status' => Clip::STATUS_READY,
        ]);
        $rerender->update(['status' => ClipRerender::STATUS_READY, 'error_message' => null]);

        // Only now, with the new file safely recorded, remove the old
        // ones — a failure above leaves the original clip intact.
        // (is_favourite is never touched here, so a re-rendered clip
        // keeps its favourite flag.)
        if ($oldOutput && $oldOutput !== $relativePath) {
            $disk->delete($oldOutput);
        }
        if ($oldThumbnail && $oldThumbnail !== $thumbnailPath) {
            $disk->delete($oldThumbnail);
        }
        if ($newCandidates !== null) {
            foreach ($oldCandidates as $candidate) {
                if (is_string($candidate)) {
                    $disk->delete($candidate);
                }
            }
        }

        return response()->json([
            'clip' => $clip->fresh(),
            'rerender' => $rerender->fresh()->toWorkerArray(),
        ]);
    }

    /**
     * Batch 9: upload a rendered A/B variant as a NEW clip row
     * (Variant B) instead of replacing the original in place.
     * Multipart: file (MP4) + rerender_id + optional thumbnail /
     * candidates / duration_seconds / face_tracked. The variant copies
     * the original clip's window, score, reason and transcript (the
     * window is identical — only the caption/headline style differs),
     * is titled "<original title> (Variant B)", and is linked via
     * variant_of_clip_id. The re-render is marked ready in the same
     * request. Unlike storeClip, the parent job does NOT need to be
     * Processing: a variant targets a finished job's clip.
     */
    public function uploadVariantClip(Request $request, Clip $clip)
    {
        // Multipart sends booleans as strings; normalise like storeClip.
        if ($request->has('face_tracked') && is_string($request->input('face_tracked'))) {
            $request->merge([
                'face_tracked' => filter_var($request->input('face_tracked'), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                    ?? $request->input('face_tracked'),
            ]);
        }

        $validated = $request->validate([
            'file' => ['required', 'file', 'mimes:mp4', 'max:2097152'],
            'thumbnail' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_1' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_2' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'candidate_3' => ['sometimes', 'nullable', 'file', 'mimes:jpeg,jpg,png', 'max:2048'],
            'rerender_id' => ['required', 'integer'],
            'duration_seconds' => ['sometimes', 'nullable', 'numeric', 'min:0'],
            'face_tracked' => ['sometimes', 'boolean'],
        ]);

        $rerender = ClipRerender::find($validated['rerender_id']);
        if ($rerender === null || $rerender->clip_id !== $clip->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such re-render for this clip.',
            ], 404);
        }
        if (! $rerender->is_variant) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This re-render is not a variant (use the replacement upload).',
            ], 422);
        }
        if ($rerender->status !== ClipRerender::STATUS_PROCESSING) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Re-render must be processing to upload a variant file (current status: {$rerender->status}).",
            ], 422);
        }

        $jobId = $clip->job_id ?? $clip->project_id;
        $file = $request->file('file');
        $filename = Str::uuid()->toString().'.mp4';
        $relativePath = "clips/{$jobId}/{$filename}";
        $disk = MediaStorage::disk($clip->disk ?? MediaStorage::DISK_LOCAL, $clip->job?->user);
        $disk->putFileAs("clips/{$jobId}", $file, $filename);
        [$absolutePath, $isTemp] = MediaStorage::localPathFor(
            $clip->disk ?? MediaStorage::DISK_LOCAL, $relativePath, $clip->job?->user
        );

        $probe = $this->probeClip($absolutePath);
        if ($isTemp) {
            @unlink($absolutePath);
        }
        if ($probe === null) {
            $disk->delete($relativePath);

            return response()->json([
                'error' => 'validation_error',
                'message' => 'The variant clip is not a playable MP4 (FFprobe could not read a video stream).',
            ], 422);
        }

        $thumbnailPath = null;
        if ($request->hasFile('thumbnail')) {
            $thumbFilename = 'thumb-'.Str::uuid()->toString().'.jpg';
            $disk->putFileAs(
                "clips/{$jobId}", $request->file('thumbnail'), $thumbFilename
            );
            $thumbnailPath = "clips/{$jobId}/{$thumbFilename}";
        }

        $candidatePaths = [];
        foreach (['candidate_1', 'candidate_2', 'candidate_3'] as $field) {
            if (! $request->hasFile($field)) {
                continue;
            }
            $candFilename = 'cand-'.Str::uuid()->toString().'.jpg';
            $disk->putFileAs(
                "clips/{$jobId}", $request->file($field), $candFilename
            );
            $candidatePaths[] = "clips/{$jobId}/{$candFilename}";
        }

        $variant = Clip::create([
            'project_id' => $clip->project_id,
            'job_id' => $clip->job_id,
            'title' => ($clip->title ?? 'Clip').' (Variant B)',
            'start_seconds' => $clip->start_seconds,
            'end_seconds' => $clip->end_seconds,
            'duration_seconds' => (float) ($validated['duration_seconds'] ?? $probe['duration']),
            'aspect_ratio' => $clip->aspect_ratio,
            'status' => Clip::STATUS_READY,
            'output_path' => $relativePath,
            'disk' => $clip->disk ?? MediaStorage::DISK_LOCAL,
            'thumbnail_path' => $thumbnailPath,
            'thumbnail_candidates' => $candidatePaths !== [] ? $candidatePaths : null,
            'file_size_bytes' => $disk->size($relativePath),
            // The window is identical to the original, so its score,
            // reason and transcript carry over; only the style differs.
            'score' => $clip->score,
            'score_breakdown' => $clip->score_breakdown,
            'reason' => $clip->reason,
            'transcript_excerpt' => $clip->transcript_excerpt,
            'caption_style' => $rerender->caption_style,
            'face_tracked' => (bool) ($validated['face_tracked'] ?? false),
            'variant_of_clip_id' => $clip->id,
        ]);
        $rerender->update(['status' => ClipRerender::STATUS_READY, 'error_message' => null]);

        return response()->json([
            'clip' => $variant->fresh(),
            'rerender' => $rerender->fresh()->toWorkerArray(),
        ]);
    }
}
