<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\BrandAsset;
use App\Support\VideoProbe;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class BrandAssetController extends Controller
{
    /**
     * GET /api/v1/brand-kit/assets — my brand assets (intro/outro),
     * newest first. Never another user's.
     */
    public function index(Request $request)
    {
        $assets = $request->user()->brandAssets()->latest()->get();

        return response()->json(['assets' => $assets]);
    }

    /**
     * POST /api/v1/brand-kit/assets — upload an intro or outro video.
     *
     * One asset per (user, kind): uploading again replaces the
     * previous one and deletes its file. The file must be a real
     * video per ffprobe, with duration > 0 and at most 15 seconds —
     * a longer file or a non-video is a 422, never a stored asset.
     */
    public function store(Request $request)
    {
        $validated = $request->validate([
            'kind' => ['required', 'string', Rule::in(BrandAsset::KINDS)],
            'file' => ['required', 'file', 'mimes:mp4,mov,webm', 'max:51200'],
        ]);

        $user = $request->user();
        $file = $request->file('file');
        $extension = strtolower($file->getClientOriginalExtension());
        $filename = $validated['kind'].'-'.Str::uuid()->toString().'.'.$extension;
        $relativePath = "brand-assets/{$user->id}/{$filename}";
        Storage::disk('local')->putFileAs("brand-assets/{$user->id}", $file, $filename);
        $absolutePath = Storage::disk('local')->path($relativePath);

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

        // Upsert per (user, kind): replacing deletes the old file so
        // a replaced intro never lingers on disk.
        $existing = BrandAsset::where('user_id', $user->id)
            ->where('kind', $validated['kind'])
            ->first();

        $attributes = [
            'path' => $relativePath,
            'original_name' => $file->getClientOriginalName(),
            'duration_seconds' => $probe['duration'],
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
