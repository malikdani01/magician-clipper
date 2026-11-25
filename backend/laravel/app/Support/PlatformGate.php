<?php

namespace App\Support;

use App\Models\Plan;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Http\JsonResponse;

/**
 * Server-side enforcement for Batch 10 platform controls.
 *
 * Every check returns null (allowed) or a JsonResponse that the
 * controller returns immediately. The user panel hides disabled
 * controls, but hiding is never the enforcement — these checks are
 * what actually stop a suspended user, a disabled feature, a blown
 * daily limit or a job during maintenance.
 */
class PlatformGate
{
    /**
     * One disabled-feature rejection, shared by every controller
     * that gates a feature (clips, brand assets, cloud storage).
     */
    public static function featureDenied(string $feature, string $message): JsonResponse
    {
        return response()->json([
            'error' => 'feature_disabled',
            'feature' => $feature,
            'message' => $message,
        ], 422);
    }

    /**
     * The gate that runs before ANY job is created (single + bulk):
     * suspended users get 403, maintenance mode gets 503 with the
     * admin's message. Reads are unaffected — this only gates
     * creation.
     */
    public static function forJobCreation(User $user): ?JsonResponse
    {
        if ($user->isSuspended()) {
            return response()->json([
                'error' => 'account_suspended',
                'message' => 'Your account is suspended — you cannot create jobs. Contact the admin.',
            ], 403);
        }

        if (PlatformSettings::maintenanceEnabled()) {
            return response()->json([
                'error' => 'maintenance_mode',
                'message' => PlatformSettings::maintenanceMessage(),
            ], 503);
        }

        return null;
    }

    /**
     * Reject a job whose settings use a feature the admin turned
     * OFF. $validated is the already-validated settings array;
     * $hasMusicBed covers the uploaded music-bed file (not a
     * settings field). One clear error per disabled feature — the
     * first one found wins, so the message always names the feature.
     */
    public static function forJobSettings(array $validated, bool $hasMusicBed = false): ?JsonResponse
    {
        $deny = fn (string $feature, string $message): JsonResponse
            => PlatformGate::featureDenied($feature, $message);

        if (($validated['captions_enabled'] ?? false) === true && ! PlatformSettings::feature('captions')) {
            return $deny('captions', 'Captions are disabled by the admin.');
        }
        if (! empty($validated['caption_style']) && ! PlatformSettings::feature('captions')) {
            return $deny('captions', 'Captions are disabled by the admin.');
        }
        if (($validated['on_screen_text'] ?? false) === true && ! PlatformSettings::feature('on_screen_text')) {
            return $deny('on_screen_text', 'On-screen text is disabled by the admin.');
        }
        // Batch 12: a REQUIRED on-screen text implies on-screen
        // text is on (buildSettings forces it) — so it must pass
        // the same gate, or a campaign job could silently re-enable
        // a feature the admin turned off. A client that sends OST
        // text without the flag gets Required, same as buildSettings.
        $requiredOst = ! empty($validated['campaign_ost'])
            && ($validated['campaign_ost_required'] ?? true);
        if ($requiredOst && ! PlatformSettings::feature('on_screen_text')) {
            return $deny('on_screen_text', 'On-screen text is disabled by the admin.');
        }
        if (($validated['beat_sync'] ?? false) === true && ! PlatformSettings::feature('beat_sync')) {
            return $deny('beat_sync', 'Beat sync is disabled by the admin.');
        }
        if ((! empty($validated['caption_translation']) && $validated['caption_translation'] !== 'none')
            || (! empty($validated['ost_language']) && $validated['ost_language'] !== 'source')) {
            if (! PlatformSettings::feature('translation')) {
                return $deny('translation', 'Translation is disabled by the admin.');
            }
        }
        if (($validated['logo_overlay'] ?? false) === true && ! PlatformSettings::feature('logo_overlay')) {
            return $deny('logo_overlay', 'Logo overlay is disabled by the admin.');
        }
        if (($hasMusicBed || (! empty($validated['sfx']) && $validated['sfx'] !== 'none'))
            && ! PlatformSettings::feature('music_bed_sfx')) {
            return $deny('music_bed_sfx', 'Music bed and sound effects are disabled by the admin.');
        }

        return null;
    }

    /**
     * Free daily limit: $newJobs more jobs today would exceed the
     * user's effective limit → 429 with the exact counts. Admins are
     * exempt (effectiveDailyLimit returns null for them).
     *
     * Batch 11: the limit is the effective one — admin per-user
     * override > active plan's daily_clips > Free platform default
     * (see PlanService for the precedence).
     */
    public static function dailyLimit(User $user, int $newJobs = 1): ?JsonResponse
    {
        $limit = PlanService::effectiveDailyLimit($user);
        if ($limit === null) {
            return null;
        }

        $usedToday = ProcessingJob::where('user_id', $user->id)
            ->whereDate('created_at', today())
            ->count();

        if ($usedToday + $newJobs > $limit) {
            return response()->json([
                'error' => 'daily_limit_reached',
                'message' => "Daily limit reached — you have used {$usedToday} of {$limit} jobs today. Try again tomorrow.",
                'limit' => $limit,
                'used_today' => $usedToday,
            ], 429);
        }

        return null;
    }

    /**
     * Batch 11: a paid plan's lifetime clip total. $newClips more
     * rendered clips would exceed the plan's remaining total → 429
     * with the exact counts. Free users have no lifetime total (only
     * the daily limit above), and a plan with total_clips = null is
     * unlimited. Admins are exempt.
     */
    public static function totalClips(User $user, int $newClips): ?JsonResponse
    {
        if ($user->isAdmin()) {
            return null;
        }

        $remaining = PlanService::effectiveLimits($user)['total_clips_remaining'];
        if ($remaining === null) {
            return null;
        }

        if ($newClips > $remaining) {
            return response()->json([
                'error' => 'plan_clips_exhausted',
                'message' => "Your plan has {$remaining} clips left — this job would render {$newClips}. Upgrade or wait for your next plan.",
                'clips_remaining' => $remaining,
                'clips_requested' => $newClips,
            ], 429);
        }

        return null;
    }

    /**
     * Batch 11: export tier. A '1080p' request from a user whose
     * effective cap is 720p → 422 naming the tier and the upgrade
     * path. Free users are capped at 720p; the tier caps resolution
     * and bitrate only (Batch 2 base quality is unchanged).
     */
    public static function exportTier(User $user, ?string $requestedQuality): ?JsonResponse
    {
        if ($requestedQuality === null || $requestedQuality === '720p') {
            return null;
        }

        $cap = PlanService::effectiveMaxExportHeight($user);
        $wanted = Plan::TIER_HEIGHTS[$requestedQuality] ?? 720;

        if ($wanted > $cap) {
            return response()->json([
                'error' => 'export_tier_locked',
                'message' => "1080p export needs a paid plan — your current tier caps exports at {$cap}p. See Plans to upgrade.",
                'max_export_height' => $cap,
                'requested' => $requestedQuality,
            ], 422);
        }

        return null;
    }

    /** How many jobs the user created today (for /platform + stats). */
    public static function usedToday(User $user): int
    {
        return ProcessingJob::where('user_id', $user->id)
            ->whereDate('created_at', today())
            ->count();
    }
}
