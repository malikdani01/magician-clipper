<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreProjectRequest;
use App\Http\Requests\UpdateProjectRequest;
use App\Models\Project;
use Illuminate\Http\Request;

class ProjectController extends Controller
{
    public function index(Request $request)
    {
        $projects = $request->user()->projects()
            ->withCount(['mediaAssets', 'clips', 'processingJobs'])
            ->latest()
            ->paginate(20);

        return response()->json($projects);
    }

    public function store(StoreProjectRequest $request)
    {
        $project = $request->user()->projects()->create([
            'title' => $request->validated('title'),
            'description' => $request->validated('description'),
            'content_type' => $request->validated('content_type', 'general'),
            'status' => Project::STATUS_DRAFT,
        ]);

        return response()->json(['project' => $project], 201);
    }

    public function show(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        $project->load(['mediaAssets', 'processingJobs', 'clips', 'exports']);

        return response()->json(['project' => $project]);
    }

    public function update(UpdateProjectRequest $request, Project $project)
    {
        $this->authorize('update', $project);

        $project->update($request->validated());

        return response()->json(['project' => $project->fresh()]);
    }

    public function destroy(Request $request, Project $project)
    {
        $this->authorize('delete', $project);

        // Deleting a project cascades to its media, jobs, clips and exports
        // (foreign keys). Stored files are removed by a cleanup job in
        // Phase 3; originals are never deleted silently mid-processing.
        $project->delete();

        return response()->json(['message' => 'Project deleted.'], 200);
    }

    /**
     * POST /api/v1/projects/{project}/analyze — Phase 3.
     * Starts a processing job (probe -> transcribe -> analyze -> render).
     * Requires the Python video-engine; no fake progress is ever returned.
     */
    public function analyze(Request $request, Project $project)
    {
        $this->authorize('view', $project);

        return $this->notImplemented(
            'Video analysis is not implemented yet (Phase 3). The video engine must be running and a media asset uploaded first.'
        );
    }
}
