<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\BrandAsset;
use App\Support\PlatformGate;
use App\Support\PlatformSettings;
use App\Support\VideoProbe;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class BrandAssetController extends Controller
{
    /**
     * GET /api/v1/brand-kit/assets — my brand assets (intro/outro/logo),
     * newest first. Never another user's.
     */
    public function index(Request $request)
    {
        $assets = $request->user()->brandAssets()->latest()->get();

        return response()->json(['assets' => $assets]);
    }

    /**
     * POST /api/v1/brand-kit/assets — upload an intro/outro video or a
     * logo image.
     *
     * One asset per (user, kind): uploading again replaces the
     * previous one and deletes its file. A video must be a real
     * video per ffprobe, with duration > 0 and at most 15 seconds —
     * a longer file or a non-video is a 422, never a stored asset.
     * A logo must be a real image (PNG/JPG/WebP, at most 5 MB);
     * getimagesize proves the bytes really are an image.
     */
    public function store(Request $request)
    {
        // Kind first: the file rules depend on it.
        $request->validate([
            'kind' => ['required', 'string', Rule::in(BrandAsset::KINDS)],
        ]);
        $kind = $request->input('kind');

        // Batch 10: logo upload needs the logo-overlay feature;
        // intro/outro upload needs the intro/outro feature.
        if ($kind === BrandAsset::KIND_LOGO && ! PlatformSettings::feature('logo_overlay')) {
            return PlatformGate::featureDenied('logo_overlay', 'Logo overlay is disabled by the admin.');
        }
        if ($kind !== BrandAsset::KIND_LOGO && ! PlatformSettings::feature('intro_outro')) {
            return PlatformGate::featureDenied('intro_outro', 'Intro and outro videos are disabled by the admin.');
        }

        $validated = $request->validate([
            'file' => $kind === BrandAsset::KIND_LOGO
                ? ['required', 'file', 'mimes:png,jpg,jpeg,webp', 'max:5120']
                : ['required', 'file', 'mimes:mp4,mov,webm', 'max:51200'],
        ]);
        $validated['kind'] = $kind;

        $user = $request->user();
        $file = $request->file('file');
        $extension = strtolower($file->getClientOriginalExtension());
        $filename = $validated['kind'].'-'.Str::uuid()->toString().'.'.$extension;
        $relativePath = "brand-assets/{$user->id}/{$filename}";
        Storage::disk('local')->putFileAs("brand-assets/{$user->id}", $file, $filename);
        $absolutePath = Storage::disk('local')->path($relativePath);

        // Batch 4: a logo is an image, not a video — it has no
        // duration (the column is a non-nullable float, so 0.0).
        // getimagesize reads the real header, so a renamed text
        // file is rejected here, not at render time.
        if ($kind === BrandAsset::KIND_LOGO) {
            // getimagesize warns (and Laravel turns the warning into
            // an exception) on unreadable bytes — suppress it and
            // treat the result as the verdict.
            if (@getimagesize($absolutePath) === false) {
                Storage::disk('local')->delete($relativePath);

                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'The uploaded file is not a valid image (PNG, JPG or WebP).',
                ], 422);
            }

            $durationSeconds = 0.0;
        } else {
            // The file must be a real, playable video — and a short one.
            if (VideoProbe::ffprobePath() === null) {
                Storage::disk('local')->delete($relativePath);

                return response()->json([
                    'error' => 'server_error',
                    'message' => 'Video validation is unavailable on this server (ffprobe is not installed).',
                ], 500);
            }

            $probe = VideoProbe::probe($absolutePath);
            if ($probe === null) {
                Storage::disk('local')->delete($relativePath);

                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'The uploaded file is not a playable video (FFprobe could not read it).',
                ], 422);
            }

            if ($probe['duration'] > BrandAsset::MAX_DURATION_SECONDS) {
                Storage::disk('local')->delete($relativePath);

                return response()->json([
                    'error' => 'validation_error',
                    'message' => 'Brand assets must be at most 15 seconds long (uploaded video is '
                        .number_format($probe['duration'], 1).' seconds).',
                ], 422);
            }

            $durationSeconds = $probe['duration'];
        }

        // Upsert per (user, kind): replacing deletes the old file so
        // a replaced intro never lingers on disk.
        $existing = BrandAsset::where('user_id', $user->id)
            ->where('kind', $validated['kind'])
            ->first();

        $attributes = [
            'path' => $relativePath,
            'original_name' => $file->getClientOriginalName(),
            'duration_seconds' => $durationSeconds,
            'file_size_bytes' => Storage::disk('local')->size($relativePath),
        ];

        if ($existing !== null) {
            $oldPath = $existing->path;
            $existing->update($attributes);
            if ($oldPath && $oldPath !== $relativePath) {
                Storage::disk('local')->delete($oldPath);
            }

            return response()->json(['asset' => $existing->fresh()], 200);
        }

        $asset = BrandAsset::create(array_merge($attributes, [
            'user_id' => $user->id,
            'kind' => $validated['kind'],
        ]));

        return response()->json(['asset' => $asset->fresh()], 201);
    }

    /**
     * GET /api/v1/brand-kit/assets/{asset}/download — stream one of my
     * brand assets (the logo preview in Brand Kit uses this).
     * Another user's asset is a 404, never a leak; a missing file
     * (wiped by a server restart) is a 404 saying so.
     */
    public function download(Request $request, BrandAsset $asset)
    {
        if ($asset->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such brand asset.',
            ], 404);
        }

        if (! $asset->path || ! Storage::disk('local')->exists($asset->path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This brand asset file was removed when the server restarted. Upload it again.',
            ], 404);
        }

        $mime = $asset->kind === BrandAsset::KIND_LOGO
            ? (match (strtolower(pathinfo($asset->path, PATHINFO_EXTENSION))) {
                'png' => 'image/png',
                'jpg', 'jpeg' => 'image/jpeg',
                'webp' => 'image/webp',
                default => 'application/octet-stream',
            })
            : 'video/mp4';

        return Storage::disk('local')->response($asset->path, null, [
            'Content-Type' => $mime,
        ]);
    }

    /**
     * DELETE /api/v1/brand-kit/assets/{asset} — delete one of my
     * brand assets (row + stored file). Another user's asset is a
     * 404, never a leak or a delete.
     */
    public function destroy(Request $request, BrandAsset $asset)
    {
        if ($asset->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such brand asset.',
            ], 404);
        }

        if ($asset->path) {
            Storage::disk('local')->delete($asset->path);
        }
        $asset->delete();

        return response()->json(['deleted' => true]);
    }
}
