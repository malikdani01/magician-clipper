<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\ClipPerformance;
use App\Models\ClipRerender;
use App\Models\Project;
use App\Models\UserSetting;
use App\Support\MediaStorage;
use App\Support\PlatformGate;
use App\Support\PlatformSettings;
use App\Support\VideoProbe;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use ZipArchive;

class ClipController extends Controller
{
    /** The disk a clip's files live on (its own recorded disk). */
    private function diskFor(Clip $clip)
    {
        return MediaStorage::disk($clip->disk ?? MediaStorage::DISK_LOCAL, $clip->job?->user);
    }

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
                || ! $this->diskFor($clip)->exists($clip->output_path)) {
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
        $tempCopies = [];
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
            // Batch 5: a cloud clip has no local path — download a
            // temp copy for the ZIP, then remove it again.
            [$localPath, $isTemp] = MediaStorage::localPathFor(
                $clip->disk ?? MediaStorage::DISK_LOCAL, $clip->output_path, $clip->job?->user
            );
            if ($isTemp) {
                $tempCopies[] = $localPath;
            }
            $zip->addFile($localPath, $name);
        }
        $zip->close();
        foreach ($tempCopies as $temp) {
            @unlink($temp);
        }

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

        if (! $this->diskFor($clip)->exists($clip->output_path)) {
            return response()->json([
                'error' => 'file_removed',
                'message' => 'This clip was rendered, but its file was removed when the server restarted. Create the job again from the same video to get fresh downloadable clips.',
            ], 404);
        }

        $filename = ($clip->title ?? 'clip').'.mp4';

        return $this->diskFor($clip)->download($clip->output_path, $filename);
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
            || ! $this->diskFor($clip)->exists($clip->thumbnail_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no thumbnail yet.',
            ], 404);
        }

        return $this->diskFor($clip)->response($clip->thumbnail_path);
    }

    /**
     * GET /api/v1/clips/{clip}/audio — stream the clip's audio as a
     * .m4a download (AAC 128k, extracted on demand with ffmpeg).
     * Ownership is enforced (ClipPolicy::view), like download. The
     * extracted file is cached under audio/{clip_id}.m4a and reused
     * while it is at least as new as the clip file — a re-rendered
     * clip (newer output file) re-extracts. A clip with no audio
     * stream is a 404 saying so plainly, never a silent empty file;
     * a missing ffmpeg binary is a 500 saying so.
     */
    public function audio(Request $request, Clip $clip)
    {
        $this->authorize('view', $clip);

        if ($clip->output_path === null) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no rendered file to extract audio from yet.',
            ], 404);
        }

        if (! $this->diskFor($clip)->exists($clip->output_path)) {
            return response()->json([
                'error' => 'file_removed',
                'message' => 'This clip was rendered, but its file was removed when the server restarted. Create the job again from the same video to get fresh downloadable clips.',
            ], 404);
        }

        $ffmpeg = VideoProbe::ffmpegPath();
        if ($ffmpeg === null) {
            return response()->json([
                'error' => 'server_error',
                'message' => 'Audio extraction is unavailable on this server (ffmpeg is not installed).',
            ], 500);
        }

        $filename = ($clip->title ?? 'clip').'.m4a';
        $relativePath = 'audio/'.$clip->id.'.m4a';

        // Reuse the cached extraction while it is at least as new as
        // the clip file it came from. (The audio cache itself always
        // lives on the local disk; only the clip may be on cloud.)
        if (Storage::disk('local')->exists($relativePath)
            && Storage::disk('local')->lastModified($relativePath)
                >= $this->diskFor($clip)->lastModified($clip->output_path)) {
            return Storage::disk('local')->download($relativePath, $filename);
        }

        // A clip with no audio stream has nothing to extract — say so
        // instead of producing an empty file. (When ffprobe itself is
        // missing the check is skipped and ffmpeg's own failure below
        // reports the problem.)
        // Batch 5: a cloud clip is downloaded to a temp file first —
        // ffmpeg only reads local files.
        [$clipPath, $isTemp] = MediaStorage::localPathFor(
            $clip->disk ?? MediaStorage::DISK_LOCAL, $clip->output_path, $clip->job?->user
        );
        $probe = VideoProbe::probe($clipPath);
        if ($probe !== null && ! $probe['has_audio']) {
            if ($isTemp) {
                @unlink($clipPath);
            }

            return response()->json([
                'error' => 'not_found',
                'message' => 'This clip has no audio track.',
            ], 404);
        }

        Storage::disk('local')->makeDirectory('audio');
        $command = escapeshellcmd($ffmpeg)
            .' -y -v error -i '
            .escapeshellarg($clipPath)
            .' -vn -c:a aac -b:a 128k '
            .escapeshellarg(Storage::disk('local')->path($relativePath));
        $output = [];
        $exitCode = 0;
        exec($command, $output, $exitCode);
        if ($isTemp) {
            @unlink($clipPath);
        }

        if ($exitCode !== 0
            || ! Storage::disk('local')->exists($relativePath)
            || Storage::disk('local')->size($relativePath) === 0) {
            Storage::disk('local')->delete($relativePath);

            return response()->json([
                'error' => 'server_error',
                'message' => 'Could not extract audio from this clip.',
            ], 500);
        }

        return Storage::disk('local')->download($relativePath, $filename);
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

        // Batch 10: clip re-render is an admin-controlled feature.
        if (! PlatformSettings::feature('clip_rerender')) {
            return PlatformGate::featureDenied('clip_rerender', 'Clip re-render is disabled by the admin.');
        }

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
     * POST /api/v1/clips/bulk-rerender — queue a re-render of several
     * clips with one caption style. Same ownership checks as the
     * single re-render (zip() pattern): every id must exist and belong
     * to the requesting user, or the whole request is a 404. One
     * clip_rerenders row (queued) is created per clip that CAN be
     * re-rendered; a clip with no rendered file, already on that
     * style, or with a re-render already in flight is skipped and
     * listed in `skipped` with its reason — never a row that can do
     * nothing. Returns 202 with the created rows + the skips.
     */
    public function bulkRerender(Request $request)
    {
        // Batch 10: clip re-render is an admin-controlled feature.
        if (! PlatformSettings::feature('clip_rerender')) {
            return PlatformGate::featureDenied('clip_rerender', 'Clip re-render is disabled by the admin.');
        }

        $validated = $request->validate([
            'clip_ids' => ['required', 'array', 'min:1', 'max:50'],
            'clip_ids.*' => ['integer'],
            'caption_style' => ['required', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
        ]);

        $ids = array_values(array_unique($validated['clip_ids']));
        $clips = Clip::with('project')->whereIn('id', $ids)->get();

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

        $rerenders = [];
        $skipped = [];
        foreach ($clips as $clip) {
            if ($clip->output_path === null) {
                $skipped[] = ['clip_id' => $clip->id, 'reason' => 'This clip has no rendered file yet.'];
                continue;
            }
            $effectiveStyle = $clip->caption_style
                ?? ($clip->job?->settings['caption_style'] ?? null);
            if ($effectiveStyle === $validated['caption_style']) {
                $skipped[] = ['clip_id' => $clip->id, 'reason' => 'This clip already uses that caption style.'];
                continue;
            }
            $inFlight = ClipRerender::where('clip_id', $clip->id)
                ->whereIn('status', [ClipRerender::STATUS_QUEUED, ClipRerender::STATUS_PROCESSING])
                ->exists();
            if ($inFlight) {
                $skipped[] = ['clip_id' => $clip->id, 'reason' => 'A re-render for this clip is already queued or processing.'];
                continue;
            }
            $rerenders[] = ClipRerender::create([
                'clip_id' => $clip->id,
                'user_id' => $request->user()->id,
                'caption_style' => $validated['caption_style'],
                'status' => ClipRerender::STATUS_QUEUED,
            ])->toUserArray();
        }

        return response()->json(['rerenders' => $rerenders, 'skipped' => $skipped], 202);
    }

    /**
     * POST /api/v1/clips/{clip}/variants — queue an A/B variant of one
     * clip. Unlike render(), this does NOT replace the clip's file:
     * the row is marked is_variant and the worker renders the SAME
     * window with the chosen caption style (+ optional headline style)
     * and uploads it as a NEW clip row with variant_of_clip_id set
     * (MuseJobController::storeClip). A variant is rejected only when
     * it would be identical to the original (same caption style AND
     * same-or-absent headline style); the caption style may match the
     * original when the headline differs. Ownership is enforced by
     * the same 'render' policy as the single re-render.
     */
    public function createVariant(Request $request, Clip $clip)
    {
        $this->authorize('render', $clip);

        // Batch 10: clip re-render (variants included) is an
        // admin-controlled feature.
        if (! PlatformSettings::feature('clip_rerender')) {
            return PlatformGate::featureDenied('clip_rerender', 'Clip re-render is disabled by the admin.');
        }

        $validated = $request->validate([
            'caption_style' => ['required', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
            'headline_style' => ['sometimes', 'nullable', 'string', Rule::in(['bold_bar', 'lower_third', 'big_centre'])],
        ]);

        if ($clip->output_path === null) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This clip has no rendered file yet — there is nothing to make a variant of.',
            ], 422);
        }

        $effectiveStyle = $clip->caption_style
            ?? ($clip->job?->settings['caption_style'] ?? null);
        $jobHeadline = $clip->job?->settings['headline_style'] ?? 'bold_bar';
        $variantHeadline = $validated['headline_style'] ?? null;
        if ($effectiveStyle === $validated['caption_style']
            && ($variantHeadline === null || $variantHeadline === $jobHeadline)) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'A variant must differ from the original — pick a different caption style or headline style.',
            ], 422);
        }

        $rerender = ClipRerender::create([
            'clip_id' => $clip->id,
            'user_id' => $request->user()->id,
            'caption_style' => $validated['caption_style'],
            'status' => ClipRerender::STATUS_QUEUED,
            'is_variant' => true,
            'variant_headline_style' => $variantHeadline,
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

    /**
     * POST /api/v1/clips/{clip}/performance — save a posted result
     * for one clip (Batch 15 — Viral Intelligence).
     *
     * The numbers are USER-ENTERED ONLY: views / likes / comments /
     * shares the clip actually got after the user posted it. The
     * system never measures or invents them. Each save is a new row;
     * the latest row per clip is the current result (the job page
     * shows it, "Edit" just saves a corrected row). Ownership is
     * enforced (ClipPolicy::update — another user's clip is a 403);
     * negative counts are rejected (422).
     */
    public function storePerformance(Request $request, Clip $clip)
    {
        $this->authorize('update', $clip);

        $validated = $request->validate([
            'platform' => ['required', 'string', Rule::in(ClipPerformance::PLATFORMS)],
            'views' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'likes' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'comments' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'shares' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'posted_at' => ['sometimes', 'nullable', 'date'],
            'notes' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        $performance = ClipPerformance::create([
            'clip_id' => $clip->id,
            'platform' => $validated['platform'],
            'views' => $validated['views'] ?? 0,
            'likes' => $validated['likes'] ?? 0,
            'comments' => $validated['comments'] ?? 0,
            'shares' => $validated['shares'] ?? 0,
            'posted_at' => $validated['posted_at'] ?? null,
            'notes' => $validated['notes'] ?? null,
        ]);

        return response()->json(['performance' => $performance->fresh()], 201);
    }

    /**
     * PATCH /api/v1/clips/{clip}/favourite — toggle the per-clip
     * favourite flag. Ownership is enforced (ClipPolicy::update).
     * A re-render never touches the flag (the clip row is updated
     * in place in MuseJobController::replaceClipFile), so a favourite
     * survives re-renders.
     */
    public function toggleFavourite(Request $request, Clip $clip)
    {
        $this->authorize('update', $clip);

        // Batch 10: favourites are an admin-controlled feature.
        if (! PlatformSettings::feature('favourites')) {
            return PlatformGate::featureDenied('favourites', 'Favourites are disabled by the admin.');
        }

        $clip->is_favourite = ! $clip->is_favourite;
        $clip->save();

        return response()->json(['clip' => $clip->fresh()]);
    }

    /**
     * PATCH /api/v1/clips/{clip}/thumbnail — pick one of the
     * worker-extracted candidate frames as the clip's thumbnail.
     * The candidate index is 0-based into thumbnail_candidates; an
     * out-of-range index is a 422, a clip with no candidates a 422.
     * Ownership is enforced (ClipPolicy::update).
     */
    public function setThumbnail(Request $request, Clip $clip)
    {
        $this->authorize('update', $clip);

        // Batch 10: the thumbnail picker is an admin-controlled feature.
        if (! PlatformSettings::feature('thumbnail_picker')) {
            return PlatformGate::featureDenied('thumbnail_picker', 'The thumbnail picker is disabled by the admin.');
        }

        $validated = $request->validate([
            'candidate_index' => ['required', 'integer', 'min:0'],
        ]);

        $candidates = (array) ($clip->thumbnail_candidates ?? []);
        if ($candidates === []) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'No alternate frames for this clip.',
            ], 422);
        }
        if (! array_key_exists($validated['candidate_index'], $candidates)) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'That candidate does not exist for this clip.',
            ], 422);
        }

        $clip->thumbnail_path = $candidates[$validated['candidate_index']];
        $clip->save();

        return response()->json(['clip' => $clip->fresh()]);
    }

    /**
     * GET /api/v1/clips/{clip}/candidates/{index} — stream one
     * candidate frame as an image. Ownership is enforced
     * (ClipPolicy::view); a missing candidate or file is a 404.
     */
    public function candidate(Request $request, Clip $clip, int $index)
    {
        $this->authorize('view', $clip);

        $candidates = (array) ($clip->thumbnail_candidates ?? []);
        if (! array_key_exists($index, $candidates)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such candidate frame.',
            ], 404);
        }

        $path = $candidates[$index];
        if (! is_string($path) || ! $this->diskFor($clip)->exists($path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'Candidate frame file not found.',
            ], 404);
        }

        return $this->diskFor($clip)->response($path, null, [
            'Content-Type' => 'image/jpeg',
        ]);
    }
}
