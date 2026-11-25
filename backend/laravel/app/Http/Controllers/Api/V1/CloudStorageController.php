<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\CloudStorageSetting;
use App\Support\MediaStorage;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Batch 5 (2026-11-25): the user's S3-compatible cloud-storage
 * account (Cloudflare R2 / AWS S3 / custom endpoint).
 *
 * - GET /api/v1/cloud-storage — the saved settings WITHOUT the secret
 *   (the page shows "saved" and only overwrites it when the user
 *   types a new one).
 * - PATCH /api/v1/cloud-storage — save settings. The secret is stored
 *   ENCRYPTED (model cast) and never returned or logged.
 * - POST /api/v1/cloud-storage/test — actually tries the bucket: puts
 *   a tiny test object and deletes it again, and reports the real
 *   outcome. No real account is created here — the user fills in
 *   their own R2/S3 keys (see the settings page for where to get them).
 */
class CloudStorageController extends Controller
{
    public function show(Request $request)
    {
        $settings = CloudStorageSetting::where('user_id', $request->user()->id)->first();

        return response()->json([
            'cloud_storage' => $settings === null ? null : $settings->toUserArray(),
        ]);
    }

    public function update(Request $request)
    {
        $validated = $request->validate([
            'provider' => ['required', 'string', Rule::in(CloudStorageSetting::PROVIDERS)],
            // R2 and custom endpoints need an endpoint URL; plain AWS
            // S3 uses the SDK default. Validated as a real URL.
            'endpoint' => ['nullable', 'string', 'max:255', 'url'],
            'bucket' => ['required', 'string', 'max:63', 'regex:/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/'],
            'region' => ['required', 'string', 'max:64'],
            'access_key_id' => ['required', 'string', 'max:255'],
            // The secret is required on first save; on later saves an
            // empty value keeps the stored one (it is never sent back).
            'secret_access_key' => ['nullable', 'string', 'max:1024'],
            'enabled' => ['sometimes', 'boolean'],
        ]);

        $user = $request->user();
        $existing = CloudStorageSetting::where('user_id', $user->id)->first();

        if ($validated['provider'] !== 's3' && empty($validated['endpoint'])) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'An endpoint URL is required for Cloudflare R2 and custom S3-compatible providers.',
            ], 422);
        }
        if ($existing === null && empty($validated['secret_access_key'])) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'A secret access key is required when saving cloud storage for the first time.',
            ], 422);
        }

        $data = [
            'provider' => $validated['provider'],
            'endpoint' => $validated['endpoint'] ?? null,
            'bucket' => $validated['bucket'],
            'region' => $validated['region'],
            'access_key_id' => $validated['access_key_id'],
            'enabled' => $validated['enabled'] ?? $existing?->enabled ?? false,
        ];
        if (! empty($validated['secret_access_key'])) {
            $data['secret_access_key'] = $validated['secret_access_key'];
        }

        if ($existing === null) {
            $settings = CloudStorageSetting::create(array_merge(
                ['user_id' => $user->id],
                $data
            ));
        } else {
            $existing->update($data);
            $settings = $existing->fresh();
        }

        return response()->json(['cloud_storage' => $settings->toUserArray()]);
    }

    /**
     * POST /api/v1/cloud-storage/test — prove the bucket works before
     * the user turns cloud storage on: put a tiny test object, read it
     * back, delete it again. Any failure returns the real error
     * message (with the secret never in it) — never a fake "OK".
     */
    public function test(Request $request)
    {
        $settings = CloudStorageSetting::where('user_id', $request->user()->id)->first();
        if ($settings === null) {
            return response()->json([
                'ok' => false,
                'message' => 'No cloud storage settings saved yet — save them first, then test.',
            ], 422);
        }

        // Test the saved settings even while cloud is still switched
        // off — the user tests first, then enables.
        $disk = MediaStorage::buildCloudDisk($request->user(), null, false);
        if ($disk === null) {
            return response()->json([
                'ok' => false,
                'message' => 'Cloud storage is incomplete (missing bucket or access key) — check the saved settings.',
            ], 422);
        }

        $key = 'magician-clipper-test-'.Str::random(12).'.txt';
        try {
            // put() returns false (rather than throwing) when the
            // write fails — a failed write is a failed test, never
            // a pass.
            if (! $disk->put($key, 'magician-clipper connection test')) {
                return response()->json([
                    'ok' => false,
                    'message' => 'The test file could not be written to the bucket — check the bucket name and the key permissions.',
                ], 422);
            }
            if (! $disk->exists($key)) {
                return response()->json([
                    'ok' => false,
                    'message' => 'The test file was written but could not be read back from the bucket.',
                ], 422);
            }
            $disk->delete($key);

            return response()->json([
                'ok' => true,
                'message' => "Connected to bucket '{$settings->bucket}' — write, read and delete all worked.",
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'ok' => false,
                'message' => 'Could not reach the bucket: '.$e->getMessage(),
            ], 422);
        }
    }
}
