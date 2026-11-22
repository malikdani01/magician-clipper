<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\Project;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

class ClipController extends Controller
{
    public function index(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        return response()->json([
            'clips' => $project->clips()->latest()->paginate(20),
        ]);
    }

    public function show(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        return response()->json(['clip' => $clip]);
    }

    /**
     * PATCH /api/v1/clips/{clip} — manual boundary / metadata edit.
     * Start/end are clamped to the source duration in Phase 3 when the
     * media asset is probed; here we validate the basic invariant
     * (0 <= start < end) and keep the clip's stored duration in sync.
     */
    public function update(Request $request, Clip $clip)
    {
        $this->authorize('update', $clip);

        $validated = $request->validate([
            'title' => ['sometimes', 'required', 'string', 'max:255'],
            'start_seconds' => ['sometimes', 'required', 'numeric', 'min:0'],
            'end_seconds' => ['sometimes', 'required', 'numeric', 'min:0'],
            'aspect_ratio' => ['sometimes', 'required', 'string', Rule::in(Clip::ASPECT_RATIOS)],
        ]);

        $start = $validated['start_seconds'] ?? $clip->start_seconds;
        $end = $validated['end_seconds'] ?? $clip->end_seconds;

        if ($end <= $start) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'end_seconds must be greater than start_seconds.',
            ], 422);
        }

        $validated['duration_seconds'] = $end - $start;

        $clip->update($validated);

        return response()->json(['clip' => $clip->fresh()]);
    }

    /**
     * GET /api/v1/clips/{clip}/download — stream the rendered clip file.
     * Ownership is enforced (ClipPolicy::view); a 'ready' clip without a
     * stored file is a 404, never a fabricated download.
     */
    public function download(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        if ($clip->output_path === null
            || ! Storage::disk('local')->exists($clip->output_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no rendered file to download yet.',
            ], 404);
        }

        $filename = ($clip->title ?? 'clip').'.mp4';

        return Storage::disk('local')->download($clip->output_path, $filename);
    }

    /**
     * GET /api/v1/clips/{clip}/thumbnail — stream the first-frame JPEG
     * the worker extracted at upload time. Ownership is enforced
     * (ClipPolicy::view); a clip without a stored thumbnail is a 404,
     * never a fabricated image.
     */
    public function thumbnail(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        if ($clip->thumbnail_path === null
            || ! Storage::disk('local')->exists($clip->thumbnail_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no thumbnail yet.',
            ], 404);
        }

        return Storage::disk('local')->response($clip->thumbnail_path);
    }

    /**
     * POST /api/v1/clips/{clip}/render — Phase 3.
     * Re-renders one clip with FFmpeg (trim / reframe / caption burn-in)
     * and validates the output before marking it ready.
     */
    public function render(Request $request, Clip $clip)
    {
        $this->authorize('render', $clip);

        return $this->notImplemented(
            'Clip rendering is not implemented yet (Phase 3). Rendering requires the video engine and a validated output file.'
        );
    }
}
