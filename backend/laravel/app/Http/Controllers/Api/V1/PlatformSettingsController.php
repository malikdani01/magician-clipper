<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\AdminActivityLog;
use App\Support\PlatformGate;
use App\Support\PlatformSettings;
use Illuminate\Http\Request;

/**
 * Platform Controls (Batch 10, Phase 2).
 *
 * The admin reads/saves the platform settings; every signed-in user
 * reads the public view (GET /api/v1/platform) so the user panel can
 * hide disabled controls, show the maintenance banner and the
 * announcement, and display the daily limit. The public view never
 * exposes anything admin-only — it is exactly the settings that
 * shape the user panel.
 */
class PlatformSettingsController extends Controller
{
    /**
     * GET /api/v1/admin/platform-settings — the full settings for
     * the admin form (identical shape to the public view, plus the
     * daily-usage numbers are not included: they are per-user).
     */
    public function show(Request $request)
    {
        return response()->json(PlatformSettings::all());
    }

    /**
     * PATCH /api/v1/admin/platform-settings — save the admin's
     * payload. Unknown keys are ignored, values are clamped to
     * their ranges, and the change is written to the activity log
     * (which keys changed — never a secret value).
     */
    public function update(Request $request)
    {
        $input = $request->validate([
            'limits' => ['sometimes', 'array'],
            'limits.free_daily_limit' => ['sometimes', 'integer', 'min:1', 'max:1000'],
            'limits.max_clips_per_job' => ['sometimes', 'integer', 'min:1', 'max:200'],
            'limits.max_bulk_files' => ['sometimes', 'integer', 'min:1', 'max:20'],
            'limits.max_upload_mb' => ['sometimes', 'integer', 'min:1', 'max:2048'],
            'features' => ['sometimes', 'array'],
            'features.*' => ['sometimes', 'boolean'],
            'pages' => ['sometimes', 'array'],
            'pages.*' => ['sometimes', 'boolean'],
            'maintenance' => ['sometimes', 'array'],
            'maintenance.enabled' => ['sometimes', 'boolean'],
            'maintenance.message' => ['sometimes', 'nullable', 'string', 'max:500'],
            'announcement' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        $saved = PlatformSettings::save($input);

        AdminActivityLog::record($request->user(), 'platform.settings_updated', null, null, [
            'groups' => array_keys($input),
        ]);

        return response()->json($saved);
    }

    /**
     * GET /api/v1/platform — the public (signed-in) view: limits,
     * feature toggles, page visibility, maintenance mode and the
     * announcement, plus this user's daily usage. The user panel
     * reads this once per session.
     */
    public function publicView(Request $request)
    {
        $user = $request->user();
        $settings = PlatformSettings::all();
        $limit = PlatformSettings::dailyLimitFor($user);
        $used = PlatformGate::usedToday($user);

        $settings['daily'] = [
            'limit' => $limit,
            'used_today' => $used,
            'remaining' => $limit === null ? null : max(0, $limit - $used),
        ];

        return response()->json($settings);
    }
}
