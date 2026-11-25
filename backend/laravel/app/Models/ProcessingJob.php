<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use InvalidArgumentException;

class ProcessingJob extends Model
{
    use HasFactory;

    // Job states (spec §11). Keep in sync with the video-engine states in
    // services/video-engine — Laravel is the source of truth for job records.
    public const STATE_UPLOADED = 'uploaded';
    public const STATE_QUEUED = 'queued';
    public const STATE_PROBING = 'probing';
    public const STATE_EXTRACTING_AUDIO = 'extracting_audio';
    public const STATE_TRANSCRIBING = 'transcribing';
    public const STATE_DETECTING_SCENES = 'detecting_scenes';
    public const STATE_ANALYZING = 'analyzing';
    public const STATE_SELECTING_CLIPS = 'selecting_clips';
    public const STATE_RENDERING = 'rendering';
    public const STATE_CAPTIONING = 'captioning';
    public const STATE_VALIDATING = 'validating';
    public const STATE_COMPLETED = 'completed';
    public const STATE_FAILED = 'failed';
    public const STATE_CANCELLING = 'cancelling';
    public const STATE_CANCELLED = 'cancelled';

    public const STATES = [
        self::STATE_UPLOADED,
        self::STATE_QUEUED,
        self::STATE_PROBING,
        self::STATE_EXTRACTING_AUDIO,
        self::STATE_TRANSCRIBING,
        self::STATE_DETECTING_SCENES,
        self::STATE_ANALYZING,
        self::STATE_SELECTING_CLIPS,
        self::STATE_RENDERING,
        self::STATE_CAPTIONING,
        self::STATE_VALIDATING,
        self::STATE_COMPLETED,
        self::STATE_FAILED,
        self::STATE_CANCELLING,
        self::STATE_CANCELLED,
    ];

    public const TERMINAL_STATES = [
        self::STATE_COMPLETED,
        self::STATE_CANCELLED,
    ];

    /**
     * Worker stage names that name a pipeline state. When the worker
     * reports one of these stages, the stored state follows the stage
     * so the job page never shows a stale state (e.g. "probing" while
     * the stage is "rendering"). Stages not listed here
     * (acquiring_source, uploading_clips, claimed, ready, ...) carry
     * no state of their own and leave the state untouched.
     */
    public const STAGE_TO_STATE = [
        'probing' => self::STATE_PROBING,
        'extracting_audio' => self::STATE_EXTRACTING_AUDIO,
        'transcribing' => self::STATE_TRANSCRIBING,
        'detecting_scenes' => self::STATE_DETECTING_SCENES,
        'analyzing' => self::STATE_ANALYZING,
        'selecting_clips' => self::STATE_SELECTING_CLIPS,
        'rendering' => self::STATE_RENDERING,
        'captioning' => self::STATE_CAPTIONING,
        'validating' => self::STATE_VALIDATING,
    ];

    /**
     * Allowed state transitions. A transition not listed here is invalid
     * and must be rejected, never silently applied (spec §11/§12).
     *
     * Notes:
     * - 'failed' -> 'queued' is the retry path (retry re-queues the job).
     * - 'rendering' may go straight to 'validating' when captions are off.
     * - Any in-flight state may move to 'cancelling' (user/admin cancel);
     *   only 'cancelling' may move to 'cancelled'.
     */
    public const VALID_TRANSITIONS = [
        self::STATE_UPLOADED => [self::STATE_QUEUED, self::STATE_CANCELLING, self::STATE_CANCELLED, self::STATE_FAILED],
        self::STATE_QUEUED => [self::STATE_PROBING, self::STATE_CANCELLING, self::STATE_CANCELLED, self::STATE_FAILED],
        self::STATE_PROBING => [self::STATE_EXTRACTING_AUDIO, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_EXTRACTING_AUDIO => [self::STATE_TRANSCRIBING, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_TRANSCRIBING => [self::STATE_DETECTING_SCENES, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_DETECTING_SCENES => [self::STATE_ANALYZING, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_ANALYZING => [self::STATE_SELECTING_CLIPS, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_SELECTING_CLIPS => [self::STATE_RENDERING, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_RENDERING => [self::STATE_CAPTIONING, self::STATE_VALIDATING, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_CAPTIONING => [self::STATE_VALIDATING, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_VALIDATING => [self::STATE_COMPLETED, self::STATE_CANCELLING, self::STATE_FAILED],
        self::STATE_COMPLETED => [],
        self::STATE_FAILED => [self::STATE_QUEUED],
        self::STATE_CANCELLING => [self::STATE_CANCELLED, self::STATE_FAILED],
        self::STATE_CANCELLED => [],
    ];

    // Public-facing job status for the Muse-connected Job System (Phase 3).
    // The internal state machine keeps the fine-grained pipeline states
    // (spec §11); the public status is the simple Queued -> Processing ->
    // Ready / Failed view the user panel and the Muse worker use.
    public const PUBLIC_STATUS_QUEUED = 'queued';
    public const PUBLIC_STATUS_PROCESSING = 'processing';
    public const PUBLIC_STATUS_READY = 'ready';
    public const PUBLIC_STATUS_FAILED = 'failed';
    public const PUBLIC_STATUS_CANCELLED = 'cancelled';

    public const PUBLIC_STATUSES = [
        self::PUBLIC_STATUS_QUEUED,
        self::PUBLIC_STATUS_PROCESSING,
        self::PUBLIC_STATUS_READY,
        self::PUBLIC_STATUS_FAILED,
        self::PUBLIC_STATUS_CANCELLED,
    ];

    protected $fillable = [
        'project_id',
        'user_id',
        'media_asset_id',
        'state',
        'stage',
        'progress',
        'error_code',
        'error_message',
        'note',
        'intro_applied',
        'outro_applied',
        // Batch 4: title + hashtag suggestions from the job's own
        // transcript (null on silent jobs / jobs made before them).
        'title_suggestion',
        'hashtags',
        'engine_job_id',
        'settings',
        'source_type',
        'source_url',
        'source_path',
        // Batch 5: which disk the source file lives on ('local' or
        // 'cloud'). Defaults to 'local'.
        'disk',
        'started_at',
        'finished_at',
    ];

    protected function casts(): array
    {
        return [
            'progress' => 'integer',
            'settings' => 'array',
            'hashtags' => 'array',
            'intro_applied' => 'boolean',
            'outro_applied' => 'boolean',
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    /**
     * Public status derived from the internal state:
     * uploaded/queued -> queued; completed -> ready; failed -> failed;
     * cancelled -> cancelled; every in-flight state -> processing.
     */
    public function publicStatus(): string
    {
        return match ($this->state) {
            self::STATE_UPLOADED, self::STATE_QUEUED => self::PUBLIC_STATUS_QUEUED,
            self::STATE_COMPLETED => self::PUBLIC_STATUS_READY,
            self::STATE_FAILED => self::PUBLIC_STATUS_FAILED,
            self::STATE_CANCELLED => self::PUBLIC_STATUS_CANCELLED,
            default => self::PUBLIC_STATUS_PROCESSING,
        };
    }

    /**
     * Walk the state machine from the current state to $to along the
     * shortest valid path (BFS over VALID_TRANSITIONS), applying each
     * intermediate transition. Throws InvalidArgumentException when no
     * valid path exists — the transition is rejected, never silently
     * applied. Used by the Muse Job API, which only speaks the public
     * statuses (Queued/Processing/Ready/Failed) while the stored state
     * machine keeps its fine-grained pipeline states.
     */
    public function advanceTo(string $to, ?string $stage = null, ?int $progress = null): static
    {
        if ($this->state === $to) {
            if ($stage !== null) {
                $this->stage = $stage;
            }
            if ($progress !== null) {
                $this->progress = max(0, min(100, $progress));
            }
            $this->save();

            return $this;
        }

        if (! in_array($to, self::STATES, true)) {
            throw new InvalidArgumentException("Unknown job state: {$to}");
        }

        $queue = [[$this->state]];
        $visited = [$this->state => true];
        $path = null;
        while ($queue !== []) {
            $candidate = array_shift($queue);
            $last = end($candidate);
            foreach (self::VALID_TRANSITIONS[$last] ?? [] as $next) {
                if (isset($visited[$next])) {
                    continue;
                }
                $visited[$next] = true;
                $nextPath = [...$candidate, $next];
                if ($next === $to) {
                    $path = $nextPath;
                    break 2;
                }
                $queue[] = $nextPath;
            }
        }

        if ($path === null) {
            throw new InvalidArgumentException(
                "Invalid job state transition: {$this->state} -> {$to}"
            );
        }

        foreach (array_slice($path, 1) as $step) {
            $isLast = $step === $to;
            $this->transitionTo($step, $isLast ? $stage : null, $isLast ? $progress : null);
        }

        return $this;
    }

    /**
     * User-facing representation: job + settings + clip list with duration,
     * size and download info. Internal filesystem paths are NOT included
     * (spec §13); clips expose a download URL instead.
     */
    public function toUserArray(): array
    {
        // Clips rendered before caption_style was recorded (2026-11-23)
        // carry null — the job's own style is what the worker burned in,
        // so it is the honest fallback for display and re-render checks.
        $jobStyle = $this->settings['caption_style'] ?? null;
        $clips = $this->clips()->orderBy('id')->get()->map(function ($clip) use ($jobStyle) {
            return [
                'id' => $clip->id,
                'title' => $clip->title,
                'status' => $clip->status,
                'start_seconds' => $clip->start_seconds,
                'end_seconds' => $clip->end_seconds,
                'duration_seconds' => $clip->duration_seconds,
                'aspect_ratio' => $clip->aspect_ratio,
                'file_size_bytes' => $clip->file_size_bytes,
                'score' => $clip->score,
                'score_breakdown' => $clip->score_breakdown,
                'reason' => $clip->reason,
                'transcript_excerpt' => $clip->transcript_excerpt,
                'thumbnail_path' => $clip->thumbnail_path,
                // Batch 4: thumbnail-picker candidates (null on older
                // clips) and the favourite flag.
                'thumbnail_candidates' => $clip->thumbnail_candidates,
                'is_favourite' => (bool) $clip->is_favourite,
                'caption_style' => $clip->caption_style ?? $jobStyle,
                'download_url' => url("/api/v1/clips/{$clip->id}/download"),
                'created_at' => $clip->created_at,
            ];
        })->all();

        return [
            'id' => $this->id,
            'project_id' => $this->project_id,
            'status' => $this->publicStatus(),
            'state' => $this->state,
            'stage' => $this->stage,
            'progress' => $this->progress,
            'settings' => $this->settings,
            'source_type' => $this->source_type,
            'source_url' => $this->source_url,
            'clips' => $clips,
            'error_code' => $this->error_code,
            'error_message' => $this->error_message,
            'note' => $this->note,
            'intro_applied' => (bool) $this->intro_applied,
            'outro_applied' => (bool) $this->outro_applied,
            // Batch 4: title + hashtag suggestions (null when the job
            // had no speech to derive them from).
            'title_suggestion' => $this->title_suggestion,
            'hashtags' => $this->hashtags,
            'started_at' => $this->started_at,
            'finished_at' => $this->finished_at,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }

    public function project()
    {
        return $this->belongsTo(Project::class);
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function mediaAsset()
    {
        return $this->belongsTo(MediaAsset::class);
    }

    public function clips()
    {
        return $this->hasMany(Clip::class, 'job_id');
    }

    public function isTerminal(): bool
    {
        return in_array($this->state, self::TERMINAL_STATES, true);
    }

    public function canTransitionTo(string $to): bool
    {
        return in_array($to, self::VALID_TRANSITIONS[$this->state] ?? [], true);
    }

    /**
     * Advance the stored state to the pipeline state a worker stage
     * names, when that state is reachable from here. Unknown stages,
     * backwards targets and terminal/failed/cancelling jobs leave the
     * state untouched — the stage string itself is still recorded by
     * the caller, so nothing is lost.
     */
    public function followStage(?string $stage): static
    {
        if ($stage === null) {
            return $this;
        }

        if ($this->isTerminal()
            || $this->state === self::STATE_FAILED
            || $this->state === self::STATE_CANCELLING) {
            return $this;
        }

        $target = self::STAGE_TO_STATE[$stage] ?? null;
        if ($target === null || $target === $this->state) {
            return $this;
        }

        // Only ever move forward along the pipeline: the state
        // machine's failed -> queued retry edge would otherwise let
        // advanceTo() walk backwards through a failure (rendering ->
        // failed -> queued -> probing). A stage naming an earlier
        // state is ignored, never a 422.
        $order = [
            self::STATE_UPLOADED,
            self::STATE_QUEUED,
            self::STATE_PROBING,
            self::STATE_EXTRACTING_AUDIO,
            self::STATE_TRANSCRIBING,
            self::STATE_DETECTING_SCENES,
            self::STATE_ANALYZING,
            self::STATE_SELECTING_CLIPS,
            self::STATE_RENDERING,
            self::STATE_CAPTIONING,
            self::STATE_VALIDATING,
            self::STATE_COMPLETED,
        ];
        $currentPos = array_search($this->state, $order, true);
        $targetPos = array_search($target, $order, true);
        if ($currentPos === false || $targetPos === false || $targetPos <= $currentPos) {
            return $this;
        }

        try {
            return $this->advanceTo($target);
        } catch (InvalidArgumentException) {
            // Backwards or otherwise illegal: keep the state.
            return $this;
        }
    }

    /**
     * Throw unless the transition from the current state to $to is allowed.
     */
    public function assertValidTransition(string $to): void
    {
        if (! in_array($to, self::STATES, true)) {
            throw new InvalidArgumentException("Unknown job state: {$to}");
        }

        if (! $this->canTransitionTo($to)) {
            throw new InvalidArgumentException(
                "Invalid job state transition: {$this->state} -> {$to}"
            );
        }
    }

    /**
     * Move to $to after validating the transition. Sets started_at on the
     * first move out of 'uploaded'/'queued' and finished_at on terminal
     * states. Returns $this for chaining.
     */
    public function transitionTo(string $to, ?string $stage = null, ?int $progress = null): static
    {
        $this->assertValidTransition($to);

        $this->state = $to;

        if ($stage !== null) {
            $this->stage = $stage;
        }

        if ($progress !== null) {
            $this->progress = max(0, min(100, $progress));
        }

        if ($this->started_at === null && ! in_array($to, [self::STATE_UPLOADED, self::STATE_QUEUED], true)) {
            $this->started_at = now();
        }

        if (in_array($to, self::TERMINAL_STATES, true) || $to === self::STATE_FAILED) {
            $this->finished_at = now();
        }

        // A retry clears the previous failure record.
        if ($to === self::STATE_QUEUED) {
            $this->error_code = null;
            $this->error_message = null;
            $this->finished_at = null;
        }

        $this->save();

        return $this;
    }

    /**
     * Record a failure: moves to 'failed' (from any non-terminal state)
     * and keeps a safe error code/message. Never expose internals here.
     */
    public function fail(?string $errorCode = null, ?string $errorMessage = null): static
    {
        if ($this->isTerminal()) {
            throw new InvalidArgumentException(
                "Cannot fail a job in terminal state: {$this->state}"
            );
        }

        $this->error_code = $errorCode;
        $this->error_message = $errorMessage;

        return $this->transitionTo(self::STATE_FAILED);
    }
}
