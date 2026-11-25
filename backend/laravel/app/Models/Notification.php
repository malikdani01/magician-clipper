<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Notification extends Model
{
    use HasFactory;

    public const TYPE_JOB_READY = 'job_ready';
    public const TYPE_JOB_FAILED = 'job_failed';
    /** Batch 10: an admin broadcast (all users or one user). */
    public const TYPE_BROADCAST = 'broadcast';

    protected $fillable = [
        'user_id',
        'job_id',
        'type',
        'title',
        'body',
        'link',
        'read_at',
    ];

    protected function casts(): array
    {
        return [
            'read_at' => 'datetime',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function job()
    {
        return $this->belongsTo(ProcessingJob::class, 'job_id');
    }

    public function scopeUnread($query)
    {
        return $query->whereNull('read_at');
    }

    public function isRead(): bool
    {
        return $this->read_at !== null;
    }
}
