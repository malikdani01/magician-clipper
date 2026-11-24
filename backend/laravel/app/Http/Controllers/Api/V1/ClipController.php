<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\ClipRerender;
use App\Models\Project;
use App\Models\UserSetting;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use ZipArchive;

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
     * POST /api/v1/clips/zip — stream a ZIP of the requested clips.
     * Every clip must exist and belong to the requesting user (admins
     * may take any); an unknown id or someone else's clip is a 404,
     * never a leak. Clips whose files are gone from disk (the hosted
     * site's ephemeral disk is wiped on restart) are skipped and
     * counted in X-Clips-Skipped; when NO clip file exists at all the
     * response is a 404 JSON saying so honestly, never an empty ZIP.
     */
    public function zip(Request $request)
    {
        $validated = $request->validate([
            'clip_ids' => ['required', 'array', 'min:1', 'max:50'],
            'clip_ids.*' => ['integer'],
        ]);

        $ids = array_values(array_unique($validated['clip_ids']));
        $clips = Clip::with('project')->whereIn('id', $ids)->get();

        // Unknown id, or a clip owned by someone else: 404.
        if ($clips->count() !== count($ids)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'One or more of the requested clips could not be found.',
            ], 404);
        }
        foreach ($clips as $clip) {
            if (! $request->user()->isAdmin() && $clip->project->user_id !== $request->user()->id) {
                return response()->json([
                    'error' => 'not_found',
                    'message' => 'One or more of the requested clips could not be found.',
                ], 404);
            }
        }

        $included = [];
        $skipped = 0;
        foreach ($clips as $clip) {
            if ($clip->output_path === null
                || ! Storage::disk('local')->exists($clip->output_path)) {
                $skipped++;
                continue;
            }
            $included[] = $clip;
        }

        if ($included === []) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'None of the selected clips still have files on the server — they were removed on a server restart.',
            ], 404);
        }

        $relativePath = 'tmp/clips-'.Str::uuid()->toString().'.zip';
        $absolutePath = Storage::disk('local')->path($relativePath);
        Storage::disk('local')->makeDirectory('tmp');

        $zip = new ZipArchive();
        if ($zip->open($absolutePath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            return response()->json([
                'error' => 'export_failed',
                'message' => 'Could not create the clips ZIP file.',
            ], 500);
        }

        $usedNames = [];
        foreach ($included as $clip) {
            $base = preg_replace('/[^A-Za-z0-9._-]+/', '_', (string) ($clip->title ?? 'clip'));
            $base = trim($base, '._') ?: 'clip';
            $name = "{$base}.mp4";
            $suffix = 2;
            while (isset($usedNames[$name])) {
                $name = "{$base}-{$suffix}.mp4";
                $suffix++;
            }
            $usedNames[$name] = true;
            $zip->addFile(Storage::disk('local')->path($clip->output_path), $name);
        }
        $zip->close();

        return response()
            ->download($absolutePath, 'clips-'.time().'.zip', [
                'X-Clips-Included' => count($included),
                'X-Clips-Skipped' => $skipped,
            ])
            ->deleteFileAfterSend(true);
    }

    /**
     * GET /api/v1/clips/{clip}/download — stream the rendered clip file.
     * Ownership is enforced (ClipPolicy::view); a clip without a stored
     * file is a 404, never a fabricated download. Two cases are kept
     * apart: never rendered yet (output_path is null) vs rendered but
     * the file is gone from disk — on the hosted site a redeploy wipes
     * the ephemeral disk, so the second case says so plainly instead
     * of "not ready yet", which would send the user retrying a
     * download that can never succeed.
     */
    public function download(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        if ($clip->output_path === null) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no rendered file to download yet.',
            ], 404);
        }

        if (! Storage::disk('local')->exists($clip->output_path)) {
            return response()->json([
                'error' => 'file_removed',
                'message' => 'This clip was rendered, but its file was removed when the server restarted. Create the job again from the same video to get fresh downloadable clips.',
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
     * POST /api/v1/clips/{clip}/render — queue a re-render of one clip
     * with a different caption style. The clip itself is NOT rendered
     * here: the request is queued and the connected worker picks it up
     * (GET /muse/rerenders), re-renders the clip's SAME window with the
     * new style, and replaces the file in place. Returns 202 with the
     * queued re-render; the job page polls GET .../rerenders for its
     * status. A clip with no rendered file yet cannot be re-rendered,
     * and only one queued/processing re-render per clip may exist —
     * a second request while one is in flight is a 409, not a queue
     * of duplicates.
     */
    public function render(Request $request, Clip $clip)
    {
        $this->authorize('render', $clip);

        $validated = $request->validate([
            'caption_style' => ['required', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
        ]);

        if ($clip->output_path === null) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This clip has no rendered file yet — there is nothing to re-render.',
            ], 422);
        }

        // Effective style: the clip's own, else the job's (clips rendered
        // before styles were recorded carry null — the job's style is
        // what the worker burned in).
        $effectiveStyle = $clip->caption_style
            ?? ($clip->job?->settings['caption_style'] ?? null);
        if ($effectiveStyle === $validated['caption_style']) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'This clip already uses that caption style.',
            ], 422);
        }

        $inFlight = ClipRerender::where('clip_id', $clip->id)
            ->whereIn('status', [ClipRerender::STATUS_QUEUED, ClipRerender::STATUS_PROCESSING])
            ->exists();
        if ($inFlight) {
            return response()->json([
                'error' => 'conflict',
                'message' => 'A re-render for this clip is already queued or processing.',
            ], 409);
        }

        $rerender = ClipRerender::create([
            'clip_id' => $clip->id,
            'user_id' => $request->user()->id,
            'caption_style' => $validated['caption_style'],
            'status' => ClipRerender::STATUS_QUEUED,
        ]);

        return response()->json(['rerender' => $rerender->toUserArray()], 202);
    }

    /**
     * GET /api/v1/clips/{clip}/rerenders — re-render history for one
     * clip, latest first. The job page polls this while a re-render is
     * queued/processing and shows the result when it lands.
     */
    public function rerenders(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        return response()->json([
            'rerenders' => $clip->rerenders()->latest()->get()->map(
                fn (ClipRerender $r) => $r->toUserArray()
            )->all(),
        ]);
    }
}
