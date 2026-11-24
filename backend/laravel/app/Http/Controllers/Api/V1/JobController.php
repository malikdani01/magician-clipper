<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\MediaAsset;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Support\JobSettingsRules;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use InvalidArgumentException;

class JobController extends Controller
{
    /**
     * GET /api/v1/jobs — list my jobs (newest first, filter by status).
     * status is the public status: queued | processing | ready | failed |
     * cancelled.
     */
    public function index(Request $request)
    {
        $jobs = $request->user()->processingJobs()
            ->with('clips')
            ->when($request->filled('status'), function ($query) use ($request) {
                $status = strtolower($request->input('status'));
                $states = match ($status) {
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
                if ($states !== null) {
                    $query->whereIn('state', $states);
                }
            })
            ->latest()
            ->paginate(20);

        $jobs->getCollection()->transform(fn ($job) => $job->toUserArray());

        return response()->json($jobs);
    }

    /**
     * POST /api/v1/jobs — create a job (Phase 3, Muse-connected Job System).
     *
     * Source is EITHER an uploaded video file OR a pasted link (YouTube /
     * TikTok / Drive / direct MP4). Settings come ONLY from dropdowns /
     * toggles: platform, ratio, clip count, duration mode + seconds
     * (or min/max), captions + language, on-screen text, job type
     * (+ campaign requirements), layout, clip selection mode
     * (interesting_only / fill_any). No free-text settings except the
     * campaign requirements text and an optional title.
     *
     * A project is created automatically when project_id is omitted.
     * The job starts in state 'queued'; the Muse worker picks it up via
     * the Job API. Uploads are validated with FFprobe when the binary is
     * available — a file that does not probe as a playable video is
     * rejected with 422.
     */
    public function store(Request $request)
    {
        // Multipart (FormData) clients send booleans as the strings
        // "true"/"false"; Laravel's `boolean` rule only accepts
        // true/false/1/0/"1"/"0", so normalise the string forms first.
        // (JSON clients send real booleans and are unaffected.)
        foreach (['captions_enabled', 'on_screen_text'] as $boolField) {
            if ($request->has($boolField) && is_string($request->input($boolField))) {
                $request->merge([
                    $boolField => filter_var($request->input($boolField), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                        ?? $request->input($boolField),
                ]);
            }
        }

        // Settings rules live in JobSettingsRules so presets validate
        // against the exact same rules as job creation (no drift).
        $validated = $request->validate(array_merge([
            'title' => ['sometimes', 'nullable', 'string', 'max:255'],
            'project_id' => ['sometimes', 'nullable', 'integer', 'exists:projects,id'],
            'file' => ['sometimes', 'file', 'mimes:mp4,mov,mkv,webm', 'max:2097152'],
            'source_url' => ['sometimes', 'nullable', 'url', 'max:2048'],
        ], JobSettingsRules::rules()));

        $hasFile = $request->hasFile('file');
        $hasUrl = ! empty($validated['source_url']);

        if ($hasFile === $hasUrl) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'Provide exactly one source: either an uploaded video file or a source_url link.',
            ], 422);
        }

        if (($validated['job_type'] ?? 'myself') === 'campaign'
            && empty($validated['campaign_requirements'])) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'campaign_requirements is required when job_type is campaign.',
            ], 422);
        }

        if (isset($validated['duration_min_seconds'], $validated['duration_max_seconds'])
            && $validated['duration_min_seconds'] >= $validated['duration_max_seconds']) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'duration_min_seconds must be less than duration_max_seconds.',
            ], 422);
        }

        $user = $request->user();

        $project = null;
        if (! empty($validated['project_id'])) {
            $project = Project::findOrFail($validated['project_id']);
            if (! $user->isAdmin() && $project->user_id !== $user->id) {
                return response()->json(['error' => 'forbidden', 'message' => 'You do not own this project.'], 403);
            }
        }

        $mediaAsset = null;
        $sourceType = 'link';
        $sourcePath = null;
        $sourceUrl = $validated['source_url'] ?? null;

        if ($hasUrl) {
            if (! $this->isAllowedSourceUrl($sourceUrl)) {
                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'source_url must be a YouTube, TikTok, Google Drive, or direct video-file (mp4/mov/mkv/webm) link.',
                ], 422);
            }
            $sourceType = 'link';
        } else {
            $sourceType = 'upload';
            $file = $request->file('file');
            $extension = strtolower($file->getClientOriginalExtension());
            $storedFilename = Str::uuid()->toString().'.'.$extension;
            $relativePath = 'uploads/'.$storedFilename;
            Storage::disk('local')->putFileAs('uploads', $file, $storedFilename);
            $absolutePath = Storage::disk('local')->path($relativePath);

            // Validate the upload is a real playable video (spec §13).
            $probe = $this->probeVideo($absolutePath);
            if ($probe === null) {
                Storage::disk('local')->delete($relativePath);

                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'The uploaded file is not a playable video (FFprobe could not read it).',
                ], 422);
            }

            if ($project === null) {
                $project = $user->projects()->create([
                    'title' => $validated['title'] ?? pathinfo($file->getClientOriginalName(), PATHINFO_FILENAME),
                    'description' => null,
                    'content_type' => $validated['content_type'] ?? 'general',
                    'status' => Project::STATUS_PROCESSING,
                ]);
            }

            $mediaAsset = MediaAsset::create([
                'project_id' => $project->id,
                'user_id' => $user->id,
                'original_filename' => $file->getClientOriginalName(),
                'stored_filename' => $storedFilename,
                'mime' => $file->getMimeType(),
                'extension' => $extension,
                'size_bytes' => $file->getSize(),
                'duration_seconds' => $probe['duration'],
                'width' => $probe['width'],
                'height' => $probe['height'],
                'fps' => $probe['fps'],
                'video_codec' => $probe['video_codec'],
                'audio_codec' => $probe['audio_codec'],
                'storage_path' => $relativePath,
                'status' => MediaAsset::STATUS_READY,
            ]);
            $sourcePath = $relativePath;
        }

        if ($project === null) {
            $project = $user->projects()->create([
                'title' => $validated['title'] ?? ('Clip job — '.parse_url($sourceUrl, PHP_URL_HOST)),
                'description' => null,
                'content_type' => $validated['content_type'] ?? 'general',
                'status' => Project::STATUS_PROCESSING,
            ]);
        }

        $settings = [
            'platform' => $validated['platform'],
            'aspect_ratio' => $validated['aspect_ratio'],
            // Cast: multipart (FormData) sends numbers as strings; the
            // stored settings must hold real numbers for the UI + worker.
            'clip_count' => (int) $validated['clip_count'],
            'duration_mode' => $validated['duration_mode'],
            'duration_seconds' => (int) $validated['duration_seconds'],
            'duration_min_seconds' => isset($validated['duration_min_seconds']) ? (int) $validated['duration_min_seconds'] : null,
            'duration_max_seconds' => isset($validated['duration_max_seconds']) ? (int) $validated['duration_max_seconds'] : null,
            'captions_enabled' => $validated['captions_enabled'] ?? true,
            'captions_language' => $validated['captions_language'] ?? 'auto',
            'caption_style' => $validated['caption_style'] ?? 'punchy',
            'selection_mode' => $validated['selection_mode'] ?? 'interesting_only',
            'on_screen_text' => $validated['on_screen_text'] ?? false,
            'job_type' => $validated['job_type'] ?? 'myself',
            'campaign_requirements' => $validated['campaign_requirements'] ?? null,
            'notes' => $validated['notes'] ?? null,
            'layout' => $validated['layout'] ?? 'center_crop',
            'content_type' => $validated['content_type'] ?? 'general',
            'quality' => $validated['quality'] ?? 'standard',
            'source_type' => $sourceType,
            'source_url' => $sourceUrl,
            'source_path' => $sourcePath,
        ];

        $job = ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'media_asset_id' => $mediaAsset?->id,
            'state' => ProcessingJob::STATE_QUEUED,
            'stage' => 'Queued',
            'progress' => 0,
            'settings' => $settings,
            'source_type' => $sourceType,
            'source_url' => $sourceUrl,
            'source_path' => $sourcePath,
        ]);

        return response()->json(['job' => $job->fresh()->toUserArray()], 201);
    }

    public function show(Request $request, ProcessingJob $job)
    {
        $this->authorize('view', $job->project);

        $job->load('clips');

        return response()->json(['job' => $job->toUserArray()]);
    }

    /**
     * POST /api/v1/jobs/{job}/cancel
     * Cancels a job. A job that has not started processing yet (uploaded /
     * queued) goes straight to 'cancelled' — no worker is involved, so
     * there is nothing to stop. An in-flight job goes to 'cancelling' and
     * the worker moves it to 'cancelled' at its next stage boundary (it
     * checks the job state before rendering each clip). Terminal jobs
     * cannot be cancelled.
     */
    public function cancel(Request $request, ProcessingJob $job)
    {
        $this->authorize('update', $job->project);

        if ($job->isTerminal()) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Job is already {$job->state} and cannot be cancelled.",
            ], 422);
        }

        // Not started yet: cancel immediately, no worker round-trip.
        $target = in_array($job->state, [
            ProcessingJob::STATE_UPLOADED,
            ProcessingJob::STATE_QUEUED,
        ], true)
            ? ProcessingJob::STATE_CANCELLED
            : ProcessingJob::STATE_CANCELLING;

        try {
            $job->transitionTo($target);
        } catch (InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        return response()->json(['job' => $job->fresh()->toUserArray()]);
    }

    /**
     * POST /api/v1/jobs/{job}/retry
     * Re-queues a failed job. Only 'failed' jobs can be retried — the
     * state machine enforces this (ProcessingJob::VALID_TRANSITIONS).
     */
    public function retry(Request $request, ProcessingJob $job)
    {
        $this->authorize('update', $job->project);

        try {
            $job->transitionTo(ProcessingJob::STATE_QUEUED);
        } catch (InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        // No re-dispatch needed: the Muse worker polls Queued jobs and
        // picks this one up on its next pass.

        return response()->json(['job' => $job->fresh()->toUserArray()]);
    }

    /**
     * Allowed link sources: YouTube, TikTok, Google Drive, or a direct
     * video-file URL. Anything else is rejected — the worker must never be
     * asked to fetch an arbitrary URL.
     */
    private function isAllowedSourceUrl(string $url): bool
    {
        $host = strtolower(parse_url($url, PHP_URL_HOST) ?? '');
        $host = preg_replace('/^www\./', '', $host);
        $allowedHosts = ['youtube.com', 'youtu.be', 'tiktok.com', 'vt.tiktok.com',
            'drive.google.com', 'docs.google.com'];
        if (in_array($host, $allowedHosts, true)) {
            return true;
        }
        $path = strtolower(parse_url($url, PHP_URL_PATH) ?? '');

        return (bool) preg_match('/\.(mp4|mov|mkv|webm)$/', $path);
    }

    /**
     * Probe a local video file with ffprobe. Returns
     * [duration, width, height, fps, video_codec, audio_codec] or null
     * when ffprobe is unavailable / the file is not a playable video.
     * When ffprobe is missing entirely, returns a nulls array so the
     * upload is accepted and the worker probes it instead (the worker
     * fails the job with the exact reason if the file is invalid).
     */
    private function probeVideo(string $absolutePath): ?array
    {
        $ffprobe = trim((string) shell_exec('command -v ffprobe'));
        if ($ffprobe === '') {
            return ['duration' => null, 'width' => null, 'height' => null,
                'fps' => null, 'video_codec' => null, 'audio_codec' => null];
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
        $audio = null;
        foreach ($data['streams'] as $stream) {
            if ($stream['codec_type'] === 'video' && $video === null) {
                $video = $stream;
            }
            if ($stream['codec_type'] === 'audio' && $audio === null) {
                $audio = $stream;
            }
        }
        if ($video === null) {
            return null;
        }
        $duration = (float) ($data['format']['duration'] ?? $video['duration'] ?? 0);
        if ($duration <= 0) {
            return null;
        }
        $fps = 0.0;
        if (! empty($video['avg_frame_rate']) && str_contains($video['avg_frame_rate'], '/')) {
            [$num, $den] = explode('/', $video['avg_frame_rate']);
            $fps = ((float) $den) > 0 ? ((float) $num) / ((float) $den) : 0.0;
        }

        return [
            'duration' => $duration,
            'width' => (int) ($video['width'] ?? 0),
            'height' => (int) ($video['height'] ?? 0),
            'fps' => $fps,
            'video_codec' => $video['codec_name'] ?? null,
            'audio_codec' => $audio['codec_name'] ?? null,
        ];
    }
}
