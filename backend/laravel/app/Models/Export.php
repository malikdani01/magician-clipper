<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Export extends Model
{
    use HasFactory;

    public const STATUS_PENDING = 'pending';
    public const STATUS_PROCESSING = 'processing';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';

    public const STATUSES = [
        self::STATUS_PENDING,
        self::STATUS_PROCESSING,
        self::STATUS_READY,
        self::STATUS_FAILED,
    ];

    public const FORMATS = ['mp4', 'zip'];

    protected $fillable = [
        'project_id',
        'user_id',
        'clip_ids',
        'format',
        'status',
        'file_path',
        'file_size_bytes',
        'download_count',
    ];

    protected function casts(): array
    {
        return [
            'clip_ids' => 'array',
            'file_size_bytes' => 'integer',
            'download_count' => 'integer',
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

    public function clips()
    {
        return Clip::whereIn('id', $this->clip_ids ?? [])->get();
    }
}
