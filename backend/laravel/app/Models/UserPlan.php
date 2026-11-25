<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A bought plan on a user (Batch 11). Status is 'active' while the
 * plan is in force, 'expired' once ends_at passes (flipped lazily —
 * see PlanService::activePlan, never by cron), 'revoked' when an
 * admin ends it early or a newer plan supersedes it.
 *
 * clips_used counts rendered clip rows (worker uploads via the Muse
 * Job API, main renders + A/B variants; replacements do not count).
 */
class UserPlan extends Model
{
    public const STATUS_ACTIVE = 'active';
    public const STATUS_EXPIRED = 'expired';
    public const STATUS_REVOKED = 'revoked';

    protected $fillable = [
        'user_id',
        'plan_id',
        'starts_at',
        'ends_at',
        'clips_used',
        'status',
    ];

    protected function casts(): array
    {
        return [
            'starts_at' => 'datetime',
            'ends_at' => 'datetime',
            'clips_used' => 'integer',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function plan()
    {
        return $this->belongsTo(Plan::class);
    }

    public function isActive(): bool
    {
        return $this->status === self::STATUS_ACTIVE && $this->ends_at->isFuture();
    }

    /** Clips left under this plan's lifetime total (null = unlimited). */
    public function clipsRemaining(): ?int
    {
        if ($this->plan->total_clips === null) {
            return null;
        }

        return max(0, $this->plan->total_clips - $this->clips_used);
    }
}
