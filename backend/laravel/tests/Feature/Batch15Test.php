<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ClipPerformance;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 15 (2026-11-28): Viral Intelligence — Hook Score, Retention
 * curve, Pattern interrupts, Loop-perfect clips, Clip performance
 * tracking. Performance numbers are user-entered only: the API
 * stores what the user posts and aggregates ONLY those rows; with
 * no rows the insights endpoint returns honest empty arrays, never
 * invented numbers.
 */
class Batch15Test extends TestCase
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

    private function createProcessingJob(User $user, array $overrides = []): array
    {
        $response = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides));
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

    private function makeClip(User $user, array $jobOverrides = [], array $attrs = []): Clip
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'Test project',
            'status' => Project::STATUS_DRAFT,
            'content_type' => 'general',
        ]);

        $job = ProcessingJob::create(array_merge([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
            'stage' => 'Ready',
            'progress' => 100,
            'settings' => ['caption_style' => 'punchy'],
            'source_type' => 'link',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $jobOverrides));

        return Clip::create(array_merge([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'status' => Clip::STATUS_READY,
            'start_seconds' => 0,
            'end_seconds' => 25,
            'duration_seconds' => 25,
            'output_path' => 'clips/test-'.$job->id.'.mp4',
            'file_size_bytes' => 12345,
        ], $attrs));
    }

    // --- Hook score / retention curve / loop_ready (worker upload) ---

    public function test_viral_intelligence_fields_stored_and_returned_on_the_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);
        $curve = array_fill(0, 20, 70);

        $this->uploadClip($job['id'], [
            'hook_score' => 82,
            'hook_reason' => '9 word(s) in first 3s; opens with a question',
            'retention_curve' => json_encode($curve),
            'loop_ready' => 'true',
        ])->assertStatus(201);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $this->assertSame(82, $clip->hook_score);
        $this->assertSame('9 word(s) in first 3s; opens with a question', $clip->hook_reason);
        $this->assertSame($curve, $clip->retention_curve);
        $this->assertTrue($clip->loop_ready);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.hook_score', 82)
            ->assertJsonPath('job.clips.0.hook_reason', '9 word(s) in first 3s; opens with a question')
            ->assertJsonPath('job.clips.0.retention_curve', $curve)
            ->assertJsonPath('job.clips.0.loop_ready', true);
    }

    public function test_viral_intelligence_fields_null_when_worker_does_not_send_them(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        $this->uploadClip($job['id'], [])->assertStatus(201);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $this->assertNull($clip->hook_score);
        $this->assertNull($clip->hook_reason);
        $this->assertNull($clip->retention_curve);
        $this->assertFalse($clip->loop_ready);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.hook_score', null)
            ->assertJsonPath('job.clips.0.retention_curve', null)
            ->assertJsonPath('job.clips.0.loop_ready', false);
    }

    public function test_malformed_retention_curve_is_422_and_stores_nothing(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        foreach ([
            'not-json',
            json_encode([101]),          // out of range
            json_encode([-1]),           // out of range
            json_encode([85.5]),         // float, not integer
            json_encode(['high']),       // non-integer value
            json_encode(array_fill(0, 1001, 50)), // over the 1000 cap
            '{"a": 1}',                  // object, not array
        ] as $bad) {
            $this->uploadClip($job['id'], ['retention_curve' => $bad])
                ->assertStatus(422);
        }

        $this->assertSame(0, Clip::where('job_id', $job['id'])->count());
    }

    public function test_hook_score_out_of_range_is_422(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        $this->uploadClip($job['id'], ['hook_score' => 101])->assertStatus(422);
        $this->uploadClip($job['id'], ['hook_score' => -1])->assertStatus(422);

        $this->assertSame(0, Clip::where('job_id', $job['id'])->count());
    }

    // --- New job settings ---

    public function test_job_settings_accept_pattern_interrupts_and_loop_perfect(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user, [
            'pattern_interrupts' => false,
            'loop_perfect' => true,
        ]);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertFalse($stored['pattern_interrupts']);
        $this->assertTrue($stored['loop_perfect']);
    }

    public function test_job_settings_default_pattern_interrupts_on_loop_perfect_off(): void
    {
        $user = User::factory()->create();
        $job = $this->createProcessingJob($user);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertTrue($stored['pattern_interrupts']);
        $this->assertFalse($stored['loop_perfect']);
    }

    // --- Clip performance tracking ---

    public function test_performance_row_created_and_latest_returned_on_the_job(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/performance", [
                'platform' => 'tiktok',
                'views' => 1200,
                'likes' => 85,
                'comments' => 12,
                'shares' => 4,
                'posted_at' => '2026-11-28',
                'notes' => 'Posted in the evening.',
            ])
            ->assertStatus(201)
            ->assertJsonPath('performance.views', 1200)
            ->assertJsonPath('performance.platform', 'tiktok');

        // A second save is a new row; the job JSON shows the latest.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/performance", [
                'platform' => 'tiktok',
                'views' => 2500,
                'likes' => 190,
                'comments' => 20,
                'shares' => 9,
            ])
            ->assertStatus(201);

        $this->assertSame(2, ClipPerformance::where('clip_id', $clip->id)->count());

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$clip->job_id}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.performance.views', 2500)
            ->assertJsonPath('job.clips.0.performance.likes', 190);
    }

    public function test_performance_without_a_row_is_null_on_the_job(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$clip->job_id}")
            ->assertStatus(200)
            ->assertJsonPath('job.clips.0.performance', null);
    }

    public function test_performance_other_user_gets_403(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $clip = $this->makeClip($owner);

        $this->actingAs($other, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/performance", [
                'platform' => 'tiktok',
                'views' => 100,
            ])
            ->assertStatus(403);

        $this->assertSame(0, ClipPerformance::where('clip_id', $clip->id)->count());
    }

    public function test_performance_validation_rejects_negative_counts_and_bad_platform(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/performance", [
                'platform' => 'tiktok',
                'views' => -1,
            ])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/performance", [
                'platform' => 'youtube',
                'views' => 10,
            ])
            ->assertStatus(422);

        $this->assertSame(0, ClipPerformance::where('clip_id', $clip->id)->count());
    }

    // --- Performance insights ---

    public function test_insights_performance_empty_state_is_honest(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/insights/performance')
            ->assertStatus(200)
            ->assertJson([
                'total_clips' => 0,
                'caption_style' => [],
                'duration_band' => [],
            ]);
    }

    public function test_insights_performance_aggregates_latest_rows_only(): void
    {
        $user = User::factory()->create();

        // Punchy, 25s clips: views 1000 / 2000 / 3000 → avg 2000.
        $punchy = [];
        for ($i = 0; $i < 3; $i++) {
            $punchy[] = $this->makeClip($user, ['settings' => ['caption_style' => 'punchy']]);
        }
        // Minimal, 40s clips: views 100 / 200 / 300 → avg 200, but the
        // first clip's latest row is 10000, so the real avg is 3500.
        $minimal = [];
        for ($i = 0; $i < 3; $i++) {
            $minimal[] = $this->makeClip($user, [
                'settings' => ['caption_style' => 'minimal'],
            ], ['start_seconds' => 0, 'end_seconds' => 40, 'duration_seconds' => 40]);
        }
        // Bold, only 2 clips: below the 3-clip minimum, never shown
        // even with huge views. They are 50s long so they land in the
        // 45s+ band (2 clips there, also below the minimum) instead of
        // polluting the 20–30s band the punchy clips use.
        $bold = [];
        for ($i = 0; $i < 2; $i++) {
            $bold[] = $this->makeClip($user, ['settings' => ['caption_style' => 'bold']],
                ['start_seconds' => 0, 'end_seconds' => 50, 'duration_seconds' => 50]);
        }

        foreach ([[$punchy[0], 1000], [$punchy[1], 2000], [$punchy[2], 3000]] as [$clip, $views]) {
            ClipPerformance::create([
                'clip_id' => $clip->id, 'platform' => 'tiktok',
                'views' => $views, 'likes' => 0, 'comments' => 0, 'shares' => 0,
            ]);
        }
        foreach ([[$minimal[0], 100], [$minimal[1], 200], [$minimal[2], 300]] as [$clip, $views]) {
            ClipPerformance::create([
                'clip_id' => $clip->id, 'platform' => 'tiktok',
                'views' => $views, 'likes' => 0, 'comments' => 0, 'shares' => 0,
            ]);
        }
        // The first minimal clip gets a newer row — only the latest counts.
        ClipPerformance::create([
            'clip_id' => $minimal[0]->id, 'platform' => 'tiktok',
            'views' => 10000, 'likes' => 0, 'comments' => 0, 'shares' => 0,
        ]);
        foreach ($bold as $clip) {
            ClipPerformance::create([
                'clip_id' => $clip->id, 'platform' => 'tiktok',
                'views' => 99999, 'likes' => 0, 'comments' => 0, 'shares' => 0,
            ]);
        }

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/insights/performance')
            ->assertStatus(200)
            ->assertJsonPath('total_clips', 8)
            ->assertJsonPath('caption_style.0.value', 'minimal')
            ->assertJsonPath('caption_style.0.average_views', 3500)
            ->assertJsonPath('caption_style.0.clip_count', 3)
            ->assertJsonPath('caption_style.1.value', 'punchy')
            ->assertJsonPath('caption_style.1.average_views', 2000)
            ->assertJsonPath('duration_band.0.value', '30–45s')
            ->assertJsonPath('duration_band.0.average_views', 3500)
            ->assertJsonPath('duration_band.1.value', '20–30s')
            ->assertJsonPath('duration_band.1.average_views', 2000);
    }
}
