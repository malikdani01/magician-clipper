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
        'thumbnail_path',
        'caption_style',
        'file_size_bytes',
        'score',
        'score_breakdown',
        'reason',
        'transcript_excerpt',
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
        ];
    }

    public function project()
    {
        return $this->belongsTo(Project::class);
    }

    public function job()
    {
        return $this->belongsTo(ProcessingJob::class, 'job_id');
    }

    public function rerenders()
    {
        return $this->hasMany(ClipRerender::class);
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
