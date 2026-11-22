<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ClipRerender;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Clip re-renders (Stronger Clipper round, 2026-11-23): a user queues a
 * re-render of one clip with a different caption style; the worker
 * picks it up, re-renders the SAME window, and replaces the file in
 * place. Also covers the worker-sent job note (why fewer clips were
 * delivered) and the thumbnail_path / caption_style clip fields.
 */
class ClipRerenderTest extends TestCase
{
    use RefreshDatabase;

    private const MUSE_KEY = 'test-muse-key-1234567890abcdef';

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.muse_job_api_key' => self::MUSE_KEY]);
        Storage::fake('local');
    }

    private function museHeaders(): array
    {
        return ['X-Muse-Api-Key' => self::MUSE_KEY];
    }

    private function createLinkJob(User $user): array
    {
        $response = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'captions_enabled' => true,
            'captions_language' => 'english',
            'on_screen_text' => false,
            'job_type' => 'myself',
            'layout' => 'center_crop',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ]);
        $response->assertStatus(201);

        return $response->json('job');
    }

    /** A finished job with one ready clip (real MP4 on the fake disk). */
    private function createReadyClip(User $user, string $captionStyle = 'punchy'): Clip
    {
        $job = $this->createLinkJob($user);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file, 'title' => 'Clip 1', 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $clip->update(['caption_style' => $captionStyle]);

        return $clip->fresh();
    }

    public function test_render_queues_rerender_and_rejects_a_second_in_flight(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'neon'])
            ->assertStatus(202)
            ->assertJsonPath('rerender.status', 'queued')
            ->assertJsonPath('rerender.caption_style', 'neon');

        // A second request while one is queued is a conflict, not a queue
        // of duplicates.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'slam'])
            ->assertStatus(409);

        $this->assertDatabaseHas('clip_rerenders', [
            'clip_id' => $clip->id,
            'caption_style' => 'neon',
            'status' => 'queued',
        ]);
    }

    public function test_render_rejects_unknown_style_and_the_current_style(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'neon');

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'not-a-style'])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'neon'])
            ->assertStatus(422)
            ->assertJsonPath('message', 'This clip already uses that caption style.');
    }

    public function test_clip_without_a_stored_style_falls_back_to_the_job_style(): void
    {
        $user = User::factory()->create();
        // createReadyClip stores 'slam'; clear it to simulate a clip
        // rendered before styles were recorded (e.g. Job #25's clips).
        $clip = $this->createReadyClip($user, 'slam');
        $clip->update(['caption_style' => null]);

        // The job JSON reports the job's style for the clip.
        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$clip->job_id}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.caption_style', 'punchy');

        // And re-rendering with the job's style is rejected as "already".
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'punchy'])
            ->assertStatus(422)
            ->assertJsonPath('message', 'This clip already uses that caption style.');
    }

    public function test_render_requires_the_clip_owner(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $clip = $this->createReadyClip($owner);

        $this->actingAs($other, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'neon'])
            ->assertStatus(403);
    }

    public function test_worker_note_is_stored_and_returned_on_the_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            [
                'status' => 'Ready',
                'note' => 'Only 2 of 5 requested clips could be selected — the source has very little speech.',
            ],
            $this->museHeaders()
        )->assertStatus(200);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->assertJsonPath(
                'job.note',
                'Only 2 of 5 requested clips could be selected — the source has very little speech.'
            );
    }

    public function test_job_clips_include_thumbnail_path_and_caption_style(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'slam');

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$clip->job_id}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.caption_style', 'slam')
            ->assertJsonStructure(['job' => ['clips' => [['thumbnail_path']]]]);
    }

    public function test_muse_rerender_flow_replaces_the_file_in_place(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');
        $oldPath = $clip->output_path;
        Storage::disk('local')->assertExists($oldPath);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'neon'])
            ->assertStatus(202);
        $rerender = ClipRerender::where('clip_id', $clip->id)->firstOrFail();

        // Worker lists queued re-renders.
        $listed = $this->getJson('/api/v1/muse/rerenders', $this->museHeaders())
            ->assertStatus(200)
            ->assertJsonPath('rerenders.0.id', $rerender->id)
            ->assertJsonPath('rerenders.0.caption_style', 'neon')
            ->json('rerenders.0');
        // Numeric comparison: JSON may encode 0.0 as 0.
        $this->assertEqualsWithDelta((float) $clip->start_seconds, (float) $listed['start_seconds'], 0.001);

        // A finished re-render cannot be claimed again.
        $this->patchJson(
            "/api/v1/muse/rerenders/{$rerender->id}/status",
            ['status' => 'ready'],
            $this->museHeaders()
        )->assertStatus(422);

        // Claim it, then upload the replacement file.
        $this->patchJson(
            "/api/v1/muse/rerenders/{$rerender->id}/status",
            ['status' => 'processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $replacement = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip-neon.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/clips/{$clip->id}/file",
            [
                'file' => $replacement,
                'rerender_id' => $rerender->id,
                'thumbnail' => UploadedFile::fake()->image('thumb.jpg', 100, 100),
            ],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('rerender.status', 'ready');

        $clip->refresh();
        $this->assertSame('neon', $clip->caption_style);
        $this->assertNotSame($oldPath, $clip->output_path);
        Storage::disk('local')->assertExists($clip->output_path);
        Storage::disk('local')->assertExists($clip->thumbnail_path);
        // The old file is deleted only after the new one is recorded.
        Storage::disk('local')->assertMissing($oldPath);
        $this->assertSame('ready', $rerender->fresh()->status);
    }

    public function test_replace_file_rejects_unknown_or_unclaimed_rerender(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'neon'])
            ->assertStatus(202);
        $rerender = ClipRerender::where('clip_id', $clip->id)->firstOrFail();

        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        // Unknown re-render id.
        $this->post(
            "/api/v1/muse/clips/{$clip->id}/file",
            ['file' => $file, 'rerender_id' => $rerender->id + 999],
            $this->museHeaders()
        )->assertStatus(404);

        // Known re-render, but still queued (not claimed as processing).
        $file2 = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/clips/{$clip->id}/file",
            ['file' => $file2, 'rerender_id' => $rerender->id],
            $this->museHeaders()
        )->assertStatus(422);
    }
}
