<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Clip extends Model
{
    use HasFactory;

    public const STATUS_PENDING = 'pending';
    public const STATUS_RENDERING = 'rendering';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';

    public const STATUSES = [
        self::STATUS_PENDING,
        self::STATUS_RENDERING,
        self::STATUS_READY,
        self::STATUS_FAILED,
    ];

    public const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5'];

    protected $fillable = [
        'project_id',
        'job_id',
        'title',
        'start_seconds',
        'end_seconds',
        'duration_seconds',
        'aspect_ratio',
        'status',
        'output_path',
        // Batch 5: which disk the clip's files live on ('local' or
        // 'cloud'). Defaults to 'local' — every existing clip keeps
        // working untouched.
        'disk',
        'thumbnail_path',
        // Batch 4: up to 3 worker-extracted frames for the thumbnail
        // picker (null on clips rendered before the picker existed),
        // and the per-clip favourite flag.
        'thumbnail_candidates',
        'is_favourite',
        // Batch 9: face tracking as reported by the worker (default
        // false) and the Variant B link (null = original clip).
        'face_tracked',
        'variant_of_clip_id',
        'caption_style',
        'file_size_bytes',
        'score',
        'score_breakdown',
        'reason',
        'transcript_excerpt',
        // Batch 12: per-clip campaign attachment — the clip's own
        // title + hashtags (derived from its own transcript), its
        // post caption (required verbatim or auto-derived), where the
        // caption came from, the exact OST text actually burned, and
        // which required items this clip applied.
        'title_suggestion',
        'hashtags',
        'post_caption',
        'caption_source',
        'ost_burned_text',
        'required_items_applied',
        // Batch 13: the grade this clip actually rendered with +
        // the auto picker's reason (null for a manual look).
        'colour_grade_applied',
        'colour_grade_reason',
        // Batch 15 — Viral Intelligence: the worker-measured
        // opening-hook score (0–100) + reason, the per-second
        // retention curve, and whether the clip was rendered
        // loop-perfect (end matched to start + audio fades).
        'hook_score',
        'hook_reason',
        'retention_curve',
        'loop_ready',
    ];

    protected function casts(): array
    {
        return [
            'start_seconds' => 'float',
            'end_seconds' => 'float',
            'duration_seconds' => 'float',
            'file_size_bytes' => 'integer',
            'score' => 'float',
            'score_breakdown' => 'array',
            'thumbnail_candidates' => 'array',
            'is_favourite' => 'boolean',
            'face_tracked' => 'boolean',
            'variant_of_clip_id' => 'integer',
            // Batch 12: per-clip campaign attachment.
            'hashtags' => 'array',
            'required_items_applied' => 'array',
            // Batch 15: per-second retention curve (array of ints).
            'retention_curve' => 'array',
            'hook_score' => 'integer',
            'loop_ready' => 'boolean',
        ];
    }

    public function project()
    {
        return $this->belongsTo(Project::class);
    }

    /** The Variant A clip this clip is a Variant B of (null = original). */
    public function variantOf()
    {
        return $this->belongsTo(Clip::class, 'variant_of_clip_id');
    }

    /** Variant B clips rendered from this clip. */
    public function variants()
    {
        return $this->hasMany(Clip::class, 'variant_of_clip_id');
    }

    public function job()
    {
        return $this->belongsTo(ProcessingJob::class, 'job_id');
    }

    public function rerenders()
    {
        return $this->hasMany(ClipRerender::class);
    }

    /** Batch 15: user-entered posted results for this clip (newest first). */
    public function performances()
    {
        return $this->hasMany(ClipPerformance::class)->orderByDesc('id');
    }

    /** Batch 15: the latest posted-result row, or null when never posted. */
    public function latestPerformance()
    {
        return $this->hasOne(ClipPerformance::class)->latestOfMany();
    }

    /**
     * A clip is complete only after a real playable output file has been
     * generated and validated (spec §1). 'ready' without an output path
     * is a data error, never a success.
     */
    public function isComplete(): bool
    {
        return $this->status === self::STATUS_READY
            && $this->output_path !== null
            && $this->file_size_bytes > 0;
    }
}
