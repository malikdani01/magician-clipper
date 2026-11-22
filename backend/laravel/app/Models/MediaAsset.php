<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class MediaAsset extends Model
{
    use HasFactory;

    public const STATUS_UPLOADED = 'uploaded';
    public const STATUS_PROBING = 'probing';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';

    public const STATUSES = [
        self::STATUS_UPLOADED,
        self::STATUS_PROBING,
        self::STATUS_READY,
        self::STATUS_FAILED,
    ];

    protected $fillable = [
        'project_id',
        'user_id',
        'original_filename',
        'stored_filename',
        'mime',
        'extension',
        'size_bytes',
        'duration_seconds',
        'width',
        'height',
        'fps',
        'video_codec',
        'audio_codec',
        'storage_path',
        'status',
    ];

    protected function casts(): array
    {
        return [
            'size_bytes' => 'integer',
            'duration_seconds' => 'float',
            'width' => 'integer',
            'height' => 'integer',
            'fps' => 'float',
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

    public function processingJobs()
    {
        return $this->hasMany(ProcessingJob::class);
    }
}
