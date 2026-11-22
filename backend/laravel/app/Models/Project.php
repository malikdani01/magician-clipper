<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Project extends Model
{
    use HasFactory;

    public const STATUS_DRAFT = 'draft';
    public const STATUS_PROCESSING = 'processing';
    public const STATUS_READY = 'ready';
    public const STATUS_FAILED = 'failed';

    public const STATUSES = [
        self::STATUS_DRAFT,
        self::STATUS_PROCESSING,
        self::STATUS_READY,
        self::STATUS_FAILED,
    ];

    public const CONTENT_TYPES = [
        'podcast',
        'interview',
        'education',
        'gaming',
        'commentary',
        'story',
        'general',
    ];

    protected $fillable = [
        'user_id',
        'title',
        'description',
        'status',
        'content_type',
    ];

    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function mediaAssets()
    {
        return $this->hasMany(MediaAsset::class);
    }

    public function processingJobs()
    {
        return $this->hasMany(ProcessingJob::class);
    }

    public function clips()
    {
        return $this->hasMany(Clip::class);
    }

    public function exports()
    {
        return $this->hasMany(Export::class);
    }
}
