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

    /**
     * One-time repair for projects created before the live status sync
     * (MuseJobController::updateStatus, 2026-11-23): their jobs finished
     * but the project row stayed "processing" forever, so Dashboard /
     * My Projects kept showing a finished project as Processing. For
     * every project still marked processing, if all its jobs are
     * finished and the latest one completed (or failed), adopt that
     * outcome. Projects with any job still open, with no jobs at all,
     * or whose latest job was cancelled are left alone — exactly like
     * the live sync does. Returns how many projects were flipped.
     */
    public static function backfillFinishedStatuses(): int
    {
        $finished = [
            ProcessingJob::STATE_COMPLETED,
            ProcessingJob::STATE_FAILED,
            ProcessingJob::STATE_CANCELLED,
        ];
        $flipped = 0;
        foreach (self::query()->where('status', self::STATUS_PROCESSING)->get() as $project) {
            $jobs = ProcessingJob::query()->where('project_id', $project->id)->orderBy('id')->get();
            if ($jobs->isEmpty()) {
                continue;
            }
            if ($jobs->contains(fn ($job) => ! in_array($job->state, $finished, true))) {
                continue;
            }
            $latest = $jobs->last();
            $next = match ($latest->state) {
                ProcessingJob::STATE_COMPLETED => self::STATUS_READY,
                ProcessingJob::STATE_FAILED => self::STATUS_FAILED,
                default => null,
            };
            if ($next !== null && $project->status !== $next) {
                $project->update(['status' => $next]);
                $flipped++;
            }
        }

        return $flipped;
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
