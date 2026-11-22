<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Project;
use Illuminate\Http\Request;

class MediaController extends Controller
{
    /**
     * GET /api/v1/projects/{project}/media — Phase 3.
     * Lists the project's uploaded media assets with FFprobe metadata.
     */
    public function index(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        return response()->json([
            'media' => $project->mediaAssets()->latest()->paginate(20),
        ]);
    }

    /**
     * POST /api/v1/projects/{project}/upload — Phase 3.
     * Accepts a video file, validates extension/MIME/size, stores it under
     * a server-generated filename, then probes it with FFprobe.
     * NOT implemented in Phase 1: do not accept uploads until the probe
     * and validation path exists (spec §13).
     */
    public function upload(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        return $this->notImplemented(
            'Video upload is not implemented yet (Phase 3). Uploads require the FFprobe validation path.'
        );
    }
}
