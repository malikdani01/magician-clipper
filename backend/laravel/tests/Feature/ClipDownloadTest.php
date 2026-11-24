<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class ClipDownloadTest extends TestCase
{
    use RefreshDatabase;

    private function makeClip(User $user, ?string $outputPath): Clip
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'download test',
            'status' => Project::STATUS_PROCESSING,
        ]);
        $job = ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
        ]);

        return Clip::create([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'start_seconds' => 0,
            'end_seconds' => 32,
            'duration_seconds' => 32,
            'status' => 'ready',
            'output_path' => $outputPath,
        ]);
    }

    public function test_download_without_a_rendered_file_is_404_not_found(): void
    {
        Storage::fake('local');
        $user = User::factory()->create();
        $clip = $this->makeClip($user, null);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/download")
            ->assertStatus(404)
            ->assertJson([
                'error' => 'not_found',
                'message' => 'This clip has no rendered file to download yet.',
            ]);
    }

    public function test_download_of_a_removed_file_says_so_plainly(): void
    {
        Storage::fake('local');
        $user = User::factory()->create();
        // Rendered once (output_path recorded) but the file is gone —
        // e.g. a redeploy wiped the ephemeral disk.
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/download")
            ->assertStatus(404)
            ->assertJson([
                'error' => 'file_removed',
                'message' => 'This clip was rendered, but its file was removed when the server restarted. Create the job again from the same video to get fresh downloadable clips.',
            ]);
    }

    public function test_download_streams_the_file_when_it_exists(): void
    {
        Storage::fake('local');
        $user = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');
        Storage::disk('local')->put('clips/1/clip_01.mp4', 'fake-mp4-bytes');

        $response = $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/download");

        $response->assertStatus(200);
        $this->assertSame('fake-mp4-bytes', $response->streamedContent());
    }
}
