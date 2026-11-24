<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Score breakdown: the worker sends a per-signal breakdown
 * ({"hook": 92, "retention": 78, ...}) as a JSON-encoded string with
 * the clip upload; it is stored on the clip and returned in the job's
 * clip list. Malformed input is a 422 and stores nothing.
 */
class ScoreBreakdownTest extends TestCase
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

    private function createProcessingJob(User $user): array
    {
        $response = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ]);
        $response->assertStatus(201);
        $job = $response->json('job');

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        return $job;
    }

    private function uploadClip(int $jobId, array $fields): \Illuminate\Testing\TestResponse
    {
        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );

        return $this->post(
            "/api/v1/muse/jobs/{$jobId}/clips",
            array_merge(['file' => $file, 'title' => 'Clip 1', 'score' => 0.8], $fields),
            $this->museHeaders()
        );
    }

    public function test_score_breakdown_is_stored_and_returned_on_the_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        $breakdown = ['hook' => 92, 'retention' => 78, 'clarity' => 85];

        $this->uploadClip($job['id'], ['score_breakdown' => json_encode($breakdown)])
            ->assertStatus(201);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $this->assertSame($breakdown, $clip->score_breakdown);

        // The user-facing job JSON carries it on the clip entry.
        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.score_breakdown', $breakdown);
    }

    public function test_score_breakdown_is_null_when_the_worker_does_not_send_it(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        $this->uploadClip($job['id'], [])->assertStatus(201);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $this->assertNull($clip->score_breakdown);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.score_breakdown', null);
    }

    public function test_malformed_score_breakdown_is_422_and_stores_nothing(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        foreach ([
            'not-json',
            '{"hook": 150}',       // out of range
            '{"hook": -1}',        // out of range
            '{"hook": "high"}',    // non-integer value
            '{"hook": 85.5}',      // float, not integer
            '[1, 2, 3]',           // array, not object
            '"just a string"',     // scalar, not object
        ] as $bad) {
            $this->uploadClip($job['id'], ['score_breakdown' => $bad])
                ->assertStatus(422);
        }

        $this->assertSame(0, Clip::where('job_id', $job['id'])->count());
    }
}
