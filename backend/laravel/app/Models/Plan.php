<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A paid plan (Batch 11). Created/edited by the admin only; there
 * is no payment gateway — payment happens outside the app and the
 * admin activates the plan after confirming it.
 *
 * Export tiers: '720p' (the free tier) or '1080p'. The tier caps
 * resolution AND bitrate only — the Batch 2 base quality (CRF 18,
 * loudnorm, AAC 192k) is the same for every tier.
 */
class Plan extends Model
{
    public const EXPORT_QUALITIES = ['720p', '1080p'];

    /** Short-side pixel cap for each tier (the "p" in 720p/1080p). */
    public const TIER_HEIGHTS = [
        '720p' => 720,
        '1080p' => 1080,
    ];

    protected $fillable = [
        'name',
        'price_display',
        'duration_days',
        'total_clips',
        'daily_clips',
        'max_export_quality',
        'features',
        'active',
    ];

    protected function casts(): array
    {
        return [
            'duration_days' => 'integer',
            'total_clips' => 'integer',
            'daily_clips' => 'integer',
            'features' => 'array',
            'active' => 'boolean',
        ];
    }

    public function userPlans()
    {
        return $this->hasMany(UserPlan::class);
    }

    public function planRequests()
    {
        return $this->hasMany(PlanRequest::class);
    }

    /** The tier's short-side pixel cap (720 or 1080). */
    public function maxExportHeight(): int
    {
        return self::TIER_HEIGHTS[$this->max_export_quality] ?? 720;
    }
}
