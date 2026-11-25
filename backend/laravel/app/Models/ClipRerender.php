<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ClipRerender extends Model
{
    public const STATUS_QUEUED = 'queued';
    public const STATUS_PROCESSING = 'processing';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';

    protected $fillable = [
        'clip_id',
        'user_id',
        'caption_style',
        'status',
        'error_message',
        // Batch 9: A/B variant rows (is_variant) + the headline look
        // the variant renders with (null = the job's headline).
        'is_variant',
        'variant_headline_style',
    ];

    protected function casts(): array
    {
        return [
            'is_variant' => 'boolean',
        ];
    }

    public function clip(): BelongsTo
    {
        return $this->belongsTo(Clip::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * What the worker needs to do the re-render: the clip's window and
     * its job (for the source), plus the requested style.
     */
    public function toWorkerArray(): array
    {
        $clip = $this->clip;

        return [
            'id' => $this->id,
            'clip_id' => $this->clip_id,
            'job_id' => $clip?->job_id,
            'project_id' => $clip?->project_id,
            'caption_style' => $this->caption_style,
            // Batch 9: a variant row renders a NEW clip (Variant B)
            // instead of replacing the original file in place.
            'is_variant' => (bool) $this->is_variant,
            'variant_headline_style' => $this->variant_headline_style,
            'start_seconds' => $clip?->start_seconds,
            'end_seconds' => $clip?->end_seconds,
            'duration_seconds' => $clip?->duration_seconds,
            'status' => $this->status,
            'error_message' => $this->error_message,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }

    public function toUserArray(): array
    {
        return [
            'id' => $this->id,
            'clip_id' => $this->clip_id,
            'caption_style' => $this->caption_style,
            'is_variant' => (bool) $this->is_variant,
            'variant_headline_style' => $this->variant_headline_style,
            'status' => $this->status,
            'error_message' => $this->error_message,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
