<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\MediaAsset;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Support\JobSettingsRules;
use App\Support\MediaStorage;
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
        foreach (['captions_enabled', 'on_screen_text', 'auto_zoom',
                  'face_tracking', 'silence_removal', 'filler_removal',
                  'beat_sync', 'logo_overlay', 'caption_safe_zone',
                  'ost_persistent', 'end_card', 'keyword_popups',
                  'progress_bar'] as $boolField) {
            if ($request->has($boolField) && is_string($request->input($boolField))) {
                $request->merge([
                    $boolField => filter_var($request->input($boolField), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE)
                        ?? $request->input($boolField),
                ]);
            }
        }

        // Batch 4: bulk creation — several files, one shared settings
        // form, one job per file. Branched before the single-file
        // validation below (which requires exactly one source).
        if ($request->hasFile('files')) {
            return $this->storeBulk($request);
        }

        // Settings rules live in JobSettingsRules so presets validate
        // against the exact same rules as job creation (no drift).
        $validated = $request->validate(array_merge([
            'title' => ['sometimes', 'nullable', 'string', 'max:255'],
            'project_id' => ['sometimes', 'nullable', 'integer', 'exists:projects,id'],
            'file' => ['sometimes', 'file', 'mimes:mp4,mov,mkv,webm', 'max:2097152'],
            'source_url' => ['sometimes', 'nullable', 'url', 'max:2048'],
            // Batch 9: optional music bed (mp3/wav/m4a, max 50 MB).
            // ffprobe-validated as audio in checkMusicBed below.
            'music_bed' => ['sometimes', 'file', 'mimes:mp3,wav,m4a', 'max:51200'],
        ], JobSettingsRules::rules()));

        $hasFile = $request->hasFile('file');
        $hasUrl = ! empty($validated['source_url']);

        if ($hasFile === $hasUrl) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'Provide exactly one source: either an uploaded video file or a source_url link.',
            ], 422);
        }

        if (($sharedError = $this->checkSharedRules($validated)) !== null) {
            return $sharedError;
        }

        if (($bedError = $this->checkMusicBed($request)) !== null) {
            return $bedError;
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
            // Batch 5: the source goes to the user's disk — local as
            // before, or their cloud bucket when configured + enabled.
            $diskName = MediaStorage::diskNameFor($user);
            $disk = MediaStorage::disk($diskName, $user);
            $disk->putFileAs('uploads', $file, $storedFilename);
            [$absolutePath, $isTemp] = MediaStorage::localPathFor($diskName, $relativePath, $user);

            // Validate the upload is a real playable video (spec §13).
            $probe = $this->probeVideo($absolutePath);
            if ($isTemp) {
                @unlink($absolutePath);
            }
            if ($probe === null) {
                $disk->delete($relativePath);

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

        $settings = $this->buildSettings($validated, $sourceType, $sourceUrl, $sourcePath);

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
            // Batch 5: the disk the source lives on (local, or the
            // user's cloud bucket). Link jobs have no file; 'local'
            // is the harmless default there.
            'disk' => $diskName ?? MediaStorage::DISK_LOCAL,
        ]);

        // Batch 9: the music bed is stored after the job exists so
        // its path can carry the job id.
        $this->storeMusicBed($request, $job);

        return response()->json(['job' => $job->fresh()->toUserArray()], 201);
    }

    /**
     * Batch 4: bulk job creation — up to 5 source files with ONE
     * shared settings form, one job per file, identical settings.
     * Every file is probed with ffprobe BEFORE any job is created,
     * so one bad file rejects the whole request with no jobs made.
     * A project_id puts all jobs in that project; otherwise each
     * file gets its own project (title = the file name). Returns
     * ['jobs' => [...]]; the single-file response is unchanged.
     */
    private function storeBulk(Request $request)
    {
        $validated = $request->validate(array_merge([
            'title' => ['sometimes', 'nullable', 'string', 'max:255'],
            'project_id' => ['sometimes', 'nullable', 'integer', 'exists:projects,id'],
            'files' => ['required', 'array', 'min:1', 'max:5'],
            'files.*' => ['file', 'mimes:mp4,mov,mkv,webm', 'max:2097152'],
            // Batch 9: one shared music bed for all bulk jobs.
            'music_bed' => ['sometimes', 'file', 'mimes:mp3,wav,m4a', 'max:51200'],
        ], JobSettingsRules::rules()));

        if (! empty($request->input('source_url'))) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'Bulk jobs take files only — a source_url cannot be shared across multiple jobs.',
            ], 422);
        }

        if (($sharedError = $this->checkSharedRules($validated)) !== null) {
            return $sharedError;
        }

        if (($bedError = $this->checkMusicBed($request)) !== null) {
            return $bedError;
        }

        $user = $request->user();

        $project = null;
        if (! empty($validated['project_id'])) {
            $project = Project::findOrFail($validated['project_id']);
            if (! $user->isAdmin() && $project->user_id !== $user->id) {
                return response()->json(['error' => 'forbidden', 'message' => 'You do not own this project.'], 403);
            }
        }

        /** @var \Illuminate\Http\UploadedFile[] $files */
        $files = $request->file('files');

        // Probe EVERY file first — a single unplayable file rejects
        // the request before any job (or file) is created.
        $probes = [];
        foreach ($files as $file) {
            $probe = $this->probeVideo($file->getPathname());
            if ($probe === null) {
                return response()->json([
                    'error' => 'validation_error',
                    'message' => "The uploaded file '{$file->getClientOriginalName()}' is not a playable video (FFprobe could not read it).",
                ], 422);
            }
            $probes[] = $probe;
        }

        $jobs = [];
        // Batch 5: bulk sources go to the user's disk, like single jobs.
        $diskName = MediaStorage::diskNameFor($user);
        $disk = MediaStorage::disk($diskName, $user);
        foreach ($files as $index => $file) {
            $probe = $probes[$index];
            $extension = strtolower($file->getClientOriginalExtension());
            $storedFilename = Str::uuid()->toString().'.'.$extension;
            $relativePath = 'uploads/'.$storedFilename;
            $disk->putFileAs('uploads', $file, $storedFilename);

            $jobProject = $project ?? $user->projects()->create([
                'title' => $validated['title'] ?? pathinfo($file->getClientOriginalName(), PATHINFO_FILENAME),
                'description' => null,
                'content_type' => $validated['content_type'] ?? 'general',
                'status' => Project::STATUS_PROCESSING,
            ]);

            $mediaAsset = MediaAsset::create([
                'project_id' => $jobProject->id,
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

            $settings = $this->buildSettings($validated, 'upload', null, $relativePath);

            $job = ProcessingJob::create([
                'project_id' => $jobProject->id,
                'user_id' => $user->id,
                'media_asset_id' => $mediaAsset->id,
                'state' => ProcessingJob::STATE_QUEUED,
                'stage' => 'Queued',
                'progress' => 0,
                'settings' => $settings,
                'source_type' => 'upload',
                'source_url' => null,
                'source_path' => $relativePath,
                'disk' => $diskName,
            ]);
            $jobs[] = $job->fresh()->toUserArray();
            // Batch 9: the shared music bed is copied under each
            // bulk job's own id.
            $this->storeMusicBed($request, $job);
        }

        // storeMusicBed updates the rows after toUserArray was taken;
        // re-read so the response carries the bed name honestly.
        $jobs = ProcessingJob::whereIn('id', array_map(fn ($j) => $j['id'], $jobs))
            ->orderBy('id')
            ->get()->map(fn ($j) => $j->toUserArray())->all();

        return response()->json(['jobs' => $jobs], 201);
    }

    /**
     * Cross-field checks shared by single + bulk creation: a
     * campaign job needs its requirements text, and a min/max
     * duration pair must be ordered. Returns a 422 response or null.
     */
    private function checkSharedRules(array $validated): ?\Illuminate\Http\JsonResponse
    {
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

        return null;
    }

    /**
     * Build the stored settings array from validated input. Shared
     * by single + bulk creation so the two can never drift apart.
     * Defaults mirror the pre-feature behaviour for every key an
     * old client omits.
     */
    private function buildSettings(array $validated, string $sourceType, ?string $sourceUrl, ?string $sourcePath): array
    {
        return [
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
            // Batch 1 enhancements: ON unless the job explicitly turns
            // one off (the frontend sends all four; old API clients
            // that omit them get the new behaviour, as does the worker).
            'auto_zoom' => $validated['auto_zoom'] ?? true,
            'face_tracking' => $validated['face_tracking'] ?? true,
            'silence_removal' => $validated['silence_removal'] ?? true,
            'filler_removal' => $validated['filler_removal'] ?? true,
            // Batch 2: headline look + caption position — defaults are
            // the pre-Batch-2 behaviour (bold_bar headline, bottom
            // captions), so old API clients are unaffected.
            'headline_style' => $validated['headline_style'] ?? 'bold_bar',
            'caption_position' => $validated['caption_position'] ?? 'bottom',
            // Batch 9: OST position — WHERE the headline sits,
            // independent of headline_style (the look). Default map
            // when absent: bold_bar -> top, lower_third -> bottom,
            // big_centre -> centre. An explicit ost_position always
            // wins over the style default.
            'ost_position' => $validated['ost_position']
                ?? self::defaultOstPosition($validated['headline_style'] ?? 'bold_bar'),
            // Batch 9: OST language — 'source' unless asked for
            // (the headline stays in the video's own language); the
            // worker translates the derived headline when set.
            'ost_language' => $validated['ost_language'] ?? 'source',
            // Batch 9: SFX sting over cuts — 'none' unless asked for.
            'sfx' => $validated['sfx'] ?? 'none',
            // Batch 9: colour grade — 'none' unless asked for; 'none'
            // leaves the render pipeline untouched (the worker adds
            // no filter for it).
            'colour_grade' => $validated['colour_grade'] ?? 'none',
            // Batch 3: beat sync ON unless explicitly off (the worker
            // treats a missing key as ON too); caption translation off
            // ("none") unless asked for; multi-ratio export defaults
            // to the job's own ratio only, with 9:16 always included.
            'beat_sync' => $validated['beat_sync'] ?? true,
            'caption_translation' => $validated['caption_translation'] ?? 'none',
            'export_ratios' => self::normaliseExportRatios(
                $validated['export_ratios'] ?? null,
                $validated['aspect_ratio'],
            ),
            // Batch 6: caption safe zone ON unless explicitly off
            // (the worker treats a missing key as ON too); OFF keeps
            // the pre-Batch-6 full-width centred captions.
            'caption_safe_zone' => $validated['caption_safe_zone'] ?? true,
            // Batch 7: whole-clip on-screen text — all default OFF /
            // "none" / null, so old clients and old jobs render
            // exactly as before (the worker treats missing keys as
            // these defaults too).
            'ost_persistent' => $validated['ost_persistent'] ?? false,
            'ost_animation' => $validated['ost_animation'] ?? 'none',
            'end_card' => $validated['end_card'] ?? false,
            'end_card_text' => $validated['end_card_text'] ?? null,
            'keyword_popups' => $validated['keyword_popups'] ?? false,
            'lower_third_text' => $validated['lower_third_text'] ?? null,
            'progress_bar' => $validated['progress_bar'] ?? false,
            // Batch 4: logo overlay OFF unless explicitly on — a
            // watermark must never surprise the user (the worker also
            // treats a missing key as OFF).
            'logo_overlay' => $validated['logo_overlay'] ?? false,
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
    }

    /**
     * Batch 9: the style-derived OST position default (see
     * buildSettings). Kept as its own method so the map is stated
     * once and tests can pin it: bold_bar -> top, lower_third ->
     * bottom, big_centre -> centre.
     */
    public static function defaultOstPosition(string $headlineStyle): string
    {
        return match ($headlineStyle) {
            'lower_third' => 'bottom',
            'big_centre' => 'centre',
            default => 'top',
        };
    }

    /**
     * Batch 9: probe an uploaded music-bed file with ffprobe. Returns
     * true when the file has an audio stream, false when it is not
     * audio at all, and null when ffprobe is unavailable — in that
     * case the upload is accepted and the worker validates it instead
     * (same "ffprobe missing" posture as probeVideo).
     */
    private function probeAudio(string $absolutePath): ?bool
    {
        $ffprobe = trim((string) shell_exec('command -v ffprobe'));
        if ($ffprobe === '') {
            return null;
        }
        $command = escapeshellcmd($ffprobe)
            .' -v error -show_streams -of json '
            .escapeshellarg($absolutePath);
        $output = shell_exec($command);
        if ($output === null || $output === '') {
            return false;
        }
        $data = json_decode($output, true);
        if (! is_array($data) || empty($data['streams'])) {
            return false;
        }
        foreach ($data['streams'] as $stream) {
            if (($stream['codec_type'] ?? null) === 'audio') {
                return true;
            }
        }

        return false;
    }

    /**
     * Batch 9: reject a music-bed upload that is not audio. Probes
     * the file BEFORE any job is created; returns a 422 response or
     * null when the file is fine (or absent / unprobeable).
     */
    private function checkMusicBed(Request $request): ?\Illuminate\Http\JsonResponse
    {
        if (! $request->hasFile('music_bed')) {
            return null;
        }
        $probe = $this->probeAudio($request->file('music_bed')->getPathname());
        if ($probe === false) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'The music bed file is not an audio file (FFprobe could not read an audio stream).',
            ], 422);
        }

        return null;
    }

    /**
     * Batch 9: store an already-validated music-bed upload under
     * music-beds/{job_id}/ on the LOCAL disk and record its path +
     * original name on the job. No file uploaded = nothing stored
     * and both columns stay null ("No music bed").
     */
    private function storeMusicBed(Request $request, ProcessingJob $job): void
    {
        if (! $request->hasFile('music_bed')) {
            return;
        }
        $file = $request->file('music_bed');
        $extension = strtolower($file->getClientOriginalExtension());
        $storedFilename = Str::uuid()->toString().'.'.$extension;
        $relativePath = "music-beds/{$job->id}/{$storedFilename}";
        Storage::disk('local')->putFileAs("music-beds/{$job->id}", $file, $storedFilename);
        $job->update([
            'music_bed_path' => $relativePath,
            'music_bed_name' => $file->getClientOriginalName(),
        ]);
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
    /**
     * Batch 3: normalise the export_ratios list for storage. The job's
     * own aspect_ratio always renders first, 9:16 is always included
     * (it is the default and the UI keeps it checked), duplicates are
     * dropped, and anything outside the validated set is ignored —
     * validation already rejected those, so this is defence in depth
     * for callers that build settings without the rules (presets are
     * validated too, but a stored preset predates this field).
     */
    private static function normaliseExportRatios(mixed $ratios, string $primary): array
    {
        $allowed = ['9:16', '1:1', '16:9'];
        $out = [];
        foreach ([$primary, '9:16', ...(is_array($ratios) ? $ratios : [])] as $ratio) {
            if (is_string($ratio) && in_array($ratio, $allowed, true) && ! in_array($ratio, $out, true)) {
                $out[] = $ratio;
            }
        }
        // A 4:5 job's primary ratio is not in the exportable set — the
        // worker still renders it (it forces the primary ratio in), so
        // store the plain default instead of an empty list.
        return $out !== [] ? $out : ['9:16'];
    }

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
