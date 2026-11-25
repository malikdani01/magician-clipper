<?php

namespace App\Support;

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
     * exempt (dailyLimitFor returns null for them).
     */
    public static function dailyLimit(User $user, int $newJobs = 1): ?JsonResponse
    {
        $limit = PlatformSettings::dailyLimitFor($user);
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

    /** How many jobs the user created today (for /platform + stats). */
    public static function usedToday(User $user): int
    {
        return ProcessingJob::where('user_id', $user->id)
            ->whereDate('created_at', today())
            ->count();
    }
}
