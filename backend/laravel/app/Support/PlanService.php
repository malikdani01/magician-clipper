<?php

namespace App\Support;

use App\Models\Plan;
use App\Models\ProcessingJob;
use App\Models\User;
use App\Models\UserPlan;

/**
 * Paid plans (Batch 11) — the one place that resolves what a user
 * may do. Manual activation only: payment happens outside the app
 * and an admin activates the plan after confirming it. No payment
 * gateway exists anywhere in this batch.
 *
 * PRECEDENCE (most specific wins — stated on the Plans page and
 * pinned by tests):
 *   1. admin per-user override (Batch 10: daily_limit_override /
 *      max_clips_override) — wins over everything;
 *   2. the user's ACTIVE plan (its daily_clips + export tier);
 *   3. the platform Free defaults (Batch 10 platform_settings).
 * Admins are exempt from the daily limit (null = unlimited).
 *
 * EXPIRY IS LAZY: ends_at is checked on every gated call. A plan
 * whose ends_at passed flips to 'expired' the first time it is
 * looked at and Free applies immediately — no cron is ever involved.
 */
class PlanService
{
    /** Free tier export cap (short-side pixels) — no plan = 720p. */
    public const FREE_MAX_EXPORT_HEIGHT = 720;

    /**
     * The user's active plan, or null. A plan whose ends_at passed
     * is flipped to 'expired' right here (lazy expiry) and counts
     * as no plan from this call on.
     */
    public static function activePlan(User $user): ?UserPlan
    {
        $userPlan = $user->userPlans()
            ->where('status', UserPlan::STATUS_ACTIVE)
            ->latest('id')
            ->first();

        if ($userPlan === null) {
            return null;
        }

        if ($userPlan->ends_at->isPast()) {
            $userPlan->update(['status' => UserPlan::STATUS_EXPIRED]);

            return null;
        }

        return $userPlan->loadMissing('plan');
    }

    /**
     * Effective limits for a user, resolved by the precedence above.
     * Keys: daily_limit (?int, null = unlimited for admins),
     * daily_limit_source ('admin'|'override'|'plan'|'free'),
     * max_clips_per_job, max_export_height,
     * total_clips_remaining (?int, null = no lifetime cap),
     * plan (?array: id/name/ends_at, null when on Free).
     */
    public static function effectiveLimits(User $user): array
    {
        $plan = $user->isAdmin() ? null : self::activePlan($user);

        if ($user->isAdmin()) {
            $dailyLimit = null;
            $dailySource = 'admin';
        } elseif ($user->daily_limit_override !== null) {
            $dailyLimit = $user->daily_limit_override;
            $dailySource = 'override';
        } elseif ($plan !== null && $plan->plan->daily_clips !== null) {
            $dailyLimit = $plan->plan->daily_clips;
            $dailySource = 'plan';
        } else {
            $dailyLimit = PlatformSettings::limit('free_daily_limit');
            $dailySource = 'free';
        }

        return [
            'daily_limit' => $dailyLimit,
            'daily_limit_source' => $dailySource,
            'max_clips_per_job' => $user->max_clips_override
                ?? PlatformSettings::limit('max_clips_per_job'),
            'max_export_height' => $plan !== null
                ? $plan->plan->maxExportHeight()
                : self::FREE_MAX_EXPORT_HEIGHT,
            // Reservable total: the plan's lifetime total minus clips
            // already rendered AND clips promised by jobs still in
            // flight (a queued job has rendered nothing yet, but its
            // clips are already spoken for). Reservations release
            // automatically when a job fails / is cancelled / finishes
            // (only the clips it actually rendered stay counted).
            // Null when the plan has no lifetime total (unlimited).
            'total_clips_remaining' => ($plan !== null && $plan->plan->total_clips !== null)
                ? max(0, $plan->plan->total_clips - $plan->clips_used - self::clipsReserved($user))
                : null,
            'plan' => $plan !== null ? [
                'id' => $plan->plan->id,
                'name' => $plan->plan->name,
                'ends_at' => $plan->ends_at->toIso8601String(),
            ] : null,
        ];
    }

    /** Effective daily job limit (?int, null = unlimited for admins). */
    public static function effectiveDailyLimit(User $user): ?int
    {
        return self::effectiveLimits($user)['daily_limit'];
    }

    /** Effective max clips per job (per-user override wins). */
    public static function effectiveMaxClips(User $user): int
    {
        return self::effectiveLimits($user)['max_clips_per_job'];
    }

    /** Effective export cap in short-side pixels (720 free). */
    public static function effectiveMaxExportHeight(User $user): int
    {
        return self::effectiveLimits($user)['max_export_height'];
    }

    /**
     * Clips promised by the user's jobs still in flight (uploaded /
     * queued / processing / cancelling): each job's expected rendered
     * rows from its stored settings. These count against the plan
     * total until the job ends — a job that fails releases its
     * reservation; a job that finishes keeps only the clips it
     * actually rendered (counted in clips_used).
     */
    public static function clipsReserved(User $user): int
    {
        $jobs = ProcessingJob::where('user_id', $user->id)
            ->whereNotIn('state', array_merge(
                ProcessingJob::TERMINAL_STATES,
                [ProcessingJob::STATE_FAILED, ProcessingJob::STATE_CANCELLED]
            ))
            ->get(['settings']);

        return $jobs->sum(fn ($job) => QueueEstimate::expectedClipRows($job->settings ?? []));
    }

    /**
     * The Plans page payload: the current plan (or Free), its usage
     * and the effective limits, plus the precedence note the page
     * shows. The Free "plan" is virtual — it is never a plans row.
     */
    public static function planSummary(User $user): array
    {
        $limits = self::effectiveLimits($user);
        $plan = self::activePlan($user);

        return [
            'current' => $plan !== null ? [
                'user_plan_id' => $plan->id,
                'plan_id' => $plan->plan->id,
                'name' => $plan->plan->name,
                'price_display' => $plan->plan->price_display,
                'starts_at' => $plan->starts_at->toIso8601String(),
                'ends_at' => $plan->ends_at->toIso8601String(),
                'clips_used' => $plan->clips_used,
                'total_clips' => $plan->plan->total_clips,
                // Remaining you can still spend: total − rendered −
                // promised by jobs in flight (see effectiveLimits).
                'clips_remaining' => $limits['total_clips_remaining'],
                'clips_reserved' => self::clipsReserved($user),
                'daily_clips' => $plan->plan->daily_clips,
                'max_export_quality' => $plan->plan->max_export_quality,
            ] : [
                'name' => 'Free',
                'price_display' => 'Free',
                'clips_used' => null,
                'total_clips' => null,
                'clips_remaining' => null,
                'clips_reserved' => 0,
                'daily_clips' => $limits['daily_limit'],
                'max_export_quality' => '720p',
            ],
            'limits' => [
                'daily_limit' => $limits['daily_limit'],
                'daily_limit_source' => $limits['daily_limit_source'],
                'max_clips_per_job' => $limits['max_clips_per_job'],
                'max_export_height' => $limits['max_export_height'],
                'total_clips_remaining' => $limits['total_clips_remaining'],
            ],
            // The precedence rule, stated once here so the Plans page
            // and the tests quote the same words.
            'precedence' => 'Admin per-user limits override your plan, and your plan overrides the Free defaults.',
        ];
    }

    /**
     * Grant a plan to a user (admin approve / admin assign). Any
     * currently active plan ends early (status 'revoked', ends_at =
     * now) — one active plan at a time. Returns the new UserPlan.
     */
    public static function grantPlan(User $user, Plan $plan, ?\DateTimeInterface $endsAt = null): UserPlan
    {
        // Lazy-expire first, so a plan whose ends_at already passed
        // keeps its real end date instead of being "revoked now".
        self::activePlan($user);

        foreach ($user->userPlans()->where('status', UserPlan::STATUS_ACTIVE)->get() as $old) {
            $old->update([
                'status' => UserPlan::STATUS_REVOKED,
                'ends_at' => now(),
            ]);
        }

        return UserPlan::create([
            'user_id' => $user->id,
            'plan_id' => $plan->id,
            'starts_at' => now(),
            'ends_at' => $endsAt ?? now()->addDays($plan->duration_days),
            'clips_used' => 0,
            'status' => UserPlan::STATUS_ACTIVE,
        ]);
    }

    /** End a user_plan early (admin revoke). */
    public static function revokePlan(UserPlan $userPlan): UserPlan
    {
        $userPlan->update([
            'status' => UserPlan::STATUS_REVOKED,
            'ends_at' => now(),
        ]);

        return $userPlan->fresh();
    }

    /**
     * Count one rendered clip against the job owner's active plan.
     * Called by the Muse Job API whenever a NEW clip row is stored
     * (main renders + A/B variants); replacements do not count.
     * No active plan (or an expired one) = nothing to count.
     */
    public static function recordClipRendered(ProcessingJob $job): void
    {
        $user = $job->user;
        if ($user === null) {
            return;
        }

        $plan = self::activePlan($user);
        if ($plan === null) {
            return;
        }

        $plan->increment('clips_used');
    }
}
