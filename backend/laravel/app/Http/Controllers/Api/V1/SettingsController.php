<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\UserSetting;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class SettingsController extends Controller
{
    /**
     * GET /api/v1/settings — per-user settings (Phase 3 — FIX 2).
     * Returns the user's row, creating it with defaults on first access.
     * No user_settings row existed before this fix (both actions were
     * 501 stubs); defaults are returned, never fabricated values.
     */
    public function show(Request $request)
    {
        $settings = UserSetting::firstOrCreate(
            ['user_id' => $request->user()->id],
            UserSetting::DEFAULTS
        );

        return response()->json(['settings' => $settings]);
    }

    /**
     * PATCH /api/v1/settings — real validated update (Phase 3 — FIX 2).
     * Only the whitelisted fields below are accepted; everything is
     * validated against the same enums the frontend offers. Returns the
     * updated settings.
     *
     * Profile fields (name/email) update the User row itself — they used
     * to be silently dropped by this validation (the frontend reported
     * "Profile saved" while nothing was stored). They are validated
     * here and saved for real; the updated user is returned alongside.
     */
    public function update(Request $request)
    {
        $validated = $request->validate([
            'default_processing_mode' => ['sometimes', 'required', 'string', Rule::in(UserSetting::PROCESSING_MODES)],
            'default_aspect_ratio' => ['sometimes', 'required', 'string', Rule::in(UserSetting::ASPECT_RATIOS)],
            'default_caption_preset' => ['sometimes', 'required', 'string', 'max:100'],
            'default_quality' => ['sometimes', 'required', 'string', Rule::in(UserSetting::QUALITIES)],
            'caption_style' => ['sometimes', 'required', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
            'notifications_enabled' => ['sometimes', 'required', 'boolean'],
            // Batch 5: appearance + language preferences.
            'theme' => ['sometimes', 'required', 'string', Rule::in(UserSetting::THEMES)],
            'language' => ['sometimes', 'required', 'string', Rule::in(UserSetting::LANGUAGES)],
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'email' => ['sometimes', 'required', 'email', 'max:255', Rule::unique('users', 'email')->ignore($request->user()->id)],
        ]);

        $user = $request->user();
        $profile = array_intersect_key($validated, ['name' => true, 'email' => true]);
        if ($profile !== []) {
            $user->update($profile);
        }

        $settings = UserSetting::firstOrCreate(
            ['user_id' => $user->id],
            UserSetting::DEFAULTS
        );
        $settings->update(array_diff_key($validated, $profile));

        return response()->json([
            'settings' => $settings->fresh(),
            'user' => $user->fresh()->only(['id', 'name', 'email', 'role', 'plan']),
        ]);
    }
}
