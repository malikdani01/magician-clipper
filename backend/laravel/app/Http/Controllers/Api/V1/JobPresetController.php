<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\JobPreset;
use App\Support\JobSettingsRules;
use App\Support\PlatformGate;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class JobPresetController extends Controller
{
    /**
     * GET /api/v1/presets — my saved job presets, newest first.
     */
    public function index(Request $request)
    {
        $presets = $request->user()->jobPresets()->latest()->get();

        return response()->json(['presets' => $presets]);
    }

    /**
     * POST /api/v1/presets — save a named set of job settings.
     * The settings are validated against the SAME rules as job
     * creation (JobSettingsRules), so a preset can only ever hold
     * settings a real job would accept. Names are unique per user.
     */
    public function store(Request $request)
    {
        $user = $request->user();

        $settingsRules = collect(JobSettingsRules::rules())
            ->mapWithKeys(fn ($rules, $field) => ["settings.{$field}" => $rules])
            ->all();

        $validated = $request->validate(array_merge([
            'name' => [
                'required', 'string', 'max:100',
                Rule::unique('job_presets')->where('user_id', $user->id),
            ],
            'settings' => ['required', 'array'],
        ], $settingsRules));

        // Batch 10: a preset must not hold settings for a feature the
        // admin turned off — it could never be used to create a job.
        if (($featureError = PlatformGate::forJobSettings($validated['settings'])) !== null) {
            return $featureError;
        }

        $preset = JobPreset::create([
            'user_id' => $user->id,
            'name' => $validated['name'],
            'settings' => $validated['settings'],
        ]);

        return response()->json(['preset' => $preset->fresh()], 201);
    }

    /**
     * DELETE /api/v1/presets/{preset} — delete one of my presets.
     * Another user's preset is a 404, never a leak or a delete.
     */
    public function destroy(Request $request, JobPreset $preset)
    {
        if ($preset->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such preset.',
            ], 404);
        }

        $preset->delete();

        return response()->json(['deleted' => true]);
    }
}
