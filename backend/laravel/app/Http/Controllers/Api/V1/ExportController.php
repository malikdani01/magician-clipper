<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\Export;
use App\Models\Project;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use ZipArchive;

class ExportController extends Controller
{
    public function index(Request $request)
    {
        $exports = $request->user()->exports()
            ->with('project:id,title')
            ->latest()
            ->paginate(20);

        return response()->json($exports);
    }

    public function show(Request $request, Export $export)
    {
        if (! $request->user()->isAdmin() && $export->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'You do not own this export.',
            ], 403);
        }

        return response()->json(['export' => $export->load('project:id,title')]);
    }

    /**
     * POST /api/v1/projects/{project}/export — builds a ZIP of the
     * project's ready clips with PHP ZipArchive (no ffmpeg needed, so
     * it works on the Render API image too) and records it in export
     * history. Only clips with a stored, playable file are included;
     * a project with no ready clips gets a 422, never an empty ZIP.
     */
    public function store(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        $clips = $project->clips()
            ->where('status', Clip::STATUS_READY)
            ->whereNotNull('output_path')
            ->orderBy('id')
            ->get()
            ->filter(fn (Clip $clip) => Storage::disk('local')->exists($clip->output_path));

        if ($clips->isEmpty()) {
            return response()->json([
                'error' => 'validation_error',
                'message' => 'This project has no ready clips to export yet.',
            ], 422);
        }

        $export = Export::create([
            'project_id' => $project->id,
            'user_id' => $request->user()->id,
            'clip_ids' => $clips->pluck('id')->all(),
            'format' => 'zip',
            'status' => Export::STATUS_PROCESSING,
        ]);

        $relativePath = "exports/export-{$export->id}.zip";
        $absolutePath = Storage::disk('local')->path($relativePath);
        Storage::disk('local')->makeDirectory('exports');

        $zip = new ZipArchive();
        if ($zip->open($absolutePath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            $export->update(['status' => Export::STATUS_FAILED]);

            return response()->json([
                'error' => 'export_failed',
                'message' => 'Could not create the export ZIP file.',
            ], 500);
        }

        $usedNames = [];
        foreach ($clips as $clip) {
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

        $export->update([
            'status' => Export::STATUS_READY,
            'file_path' => $relativePath,
            'file_size_bytes' => Storage::disk('local')->size($relativePath),
        ]);

        return response()->json(['export' => $export->fresh()->load('project:id,title')], 201);
    }

    /**
     * GET /api/v1/exports/{export}/download — stream the stored ZIP.
     * Ownership is enforced; a ready export without a stored file is
     * a 404, never a fabricated download.
     */
    public function download(Request $request, Export $export)
    {
        if (! $request->user()->isAdmin() && $export->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'You do not own this export.',
            ], 403);
        }

        if ($export->file_path === null
            || ! Storage::disk('local')->exists($export->file_path)) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'This export has no file to download yet.',
            ], 404);
        }

        $export->increment('download_count');

        $filename = ($export->project?->title ?? 'export').'-clips.zip';

        return Storage::disk('local')->download($export->file_path, $filename);
    }
}
