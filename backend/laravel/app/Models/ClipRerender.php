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
    ];

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
            'status' => $this->status,
            'error_message' => $this->error_message,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
