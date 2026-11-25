<?php

namespace Tests\Feature;

use App\Models\BrandAsset;
use App\Models\Clip;
use App\Models\ClipRerender;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 4 (2026-11-25): title + hashtag suggestions, logo/watermark
 * overlay, thumbnail picker, favourite clips, best-settings insights,
 * bulk jobs.
 */
class Batch4Test extends TestCase
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

    private function validSettings(array $overrides = []): array
    {
        return array_merge([
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
        ], $overrides);
    }

    private function createLinkJob(User $user, array $overrides = []): array
    {
        $payload = array_merge(
            $this->validSettings(),
            ['source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
            $overrides
        );

        $response = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $payload);

        $response->assertStatus(201);

        return $response->json('job');
    }

    private function demoClipFile(string $name = 'clip.mp4'): UploadedFile
    {
        return new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            $name,
            'video/mp4',
            null,
            true
        );
    }

    /** A Ready job (state=completed) with one scored clip. */
    private function makeReadyJob(User $user, array $settings, float $score): ProcessingJob
    {
        $job = $this->createLinkJob($user, $settings);
        $model = ProcessingJob::findOrFail($job['id']);
        $model->update(['state' => ProcessingJob::STATE_COMPLETED]);
        Clip::create([
            'project_id' => $model->project_id,
            'job_id' => $model->id,
            'title' => 'Clip 1',
            'start_seconds' => 0,
            'end_seconds' => 20,
            'duration_seconds' => 20,
            'aspect_ratio' => '9:16',
            'status' => Clip::STATUS_READY,
            'score' => $score,
        ]);

        return $model->fresh();
    }

    private function uploadClipWithCandidates(int $jobId): Clip
    {
        $this->patchJson(
            "/api/v1/muse/jobs/{$jobId}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $this->post(
            "/api/v1/muse/jobs/{$jobId}/clips",
            [
                'file' => $this->demoClipFile(),
                'candidate_1' => UploadedFile::fake()->image('c1.jpg', 100, 100),
                'candidate_2' => UploadedFile::fake()->image('c2.jpg', 100, 100),
                'candidate_3' => UploadedFile::fake()->image('c3.jpg', 100, 100),
                'title' => 'Clip 1',
                'score' => 0.8,
            ],
            $this->museHeaders()
        )->assertStatus(201);

        return Clip::where('job_id', $jobId)->firstOrFail();
    }

    // --- 1. Title + hashtag suggestions ---

    public function test_suggestions_stored_from_worker_and_shown_on_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            [
                'status' => 'Ready',
                'title_suggestion' => 'Growing Tomatoes At Home',
                'hashtags' => ['#tomatoes', '#garden'],
            ],
            $this->museHeaders()
        )->assertStatus(200);

        $shown = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->json('job');

        $this->assertSame('Growing Tomatoes At Home', $shown['title_suggestion']);
        $this->assertSame(['#tomatoes', '#garden'], $shown['hashtags']);

        // A job with no suggestions reports nulls, never fake text.
        $silent = $this->createLinkJob($user);
        $shownSilent = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$silent['id']}")
            ->assertStatus(200)
            ->json('job');
        $this->assertNull($shownSilent['title_suggestion']);
        $this->assertNull($shownSilent['hashtags']);
    }

    public function test_suggestions_too_long_title_is_422(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready', 'title_suggestion' => str_repeat('x', 121)],
            $this->museHeaders()
        )->assertStatus(422);
    }

    // --- 2. Logo upload ---

    public function test_logo_upload_happy_path_and_upsert(): void
    {
        $user = User::factory()->create();

        $first = $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'logo',
            'file' => UploadedFile::fake()->image('logo.png', 120, 60),
        ]);
        $first->assertStatus(201);
        $asset = $first->json('asset');
        $this->assertSame('logo', $asset['kind']);
        $this->assertEquals(0, $asset['duration_seconds']);
        $this->assertGreaterThan(0, $asset['file_size_bytes']);
        $this->assertSame(1, BrandAsset::count());
        $oldPath = BrandAsset::firstOrFail()->path;
        Storage::disk('local')->assertExists($oldPath);

        // Uploading again replaces the one logo (upsert), deleting the
        // old file — never a second logo row.
        $second = $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'logo',
            'file' => UploadedFile::fake()->image('logo2.png', 200, 100),
        ]);
        $second->assertStatus(200);
        $this->assertSame(1, BrandAsset::count());
        $this->assertSame('logo2.png', BrandAsset::firstOrFail()->original_name);
        Storage::disk('local')->assertMissing($oldPath);
    }

    public function test_logo_upload_fake_image_is_422(): void
    {
        $user = User::factory()->create();
        $fake = UploadedFile::fake()->create('logo.png', 100, 'image/png');

        $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'logo',
            'file' => $fake,
        ])->assertStatus(422);

        $this->assertSame(0, BrandAsset::count());
    }

    public function test_logo_upload_video_file_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'logo',
            'file' => $this->demoClipFile('logo.mp4'),
        ])->assertStatus(422);

        $this->assertSame(0, BrandAsset::count());
    }

    public function test_logo_download_other_user_is_404(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();

        $uploaded = $this->actingAs($owner, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'logo',
            'file' => UploadedFile::fake()->image('logo.png', 120, 60),
        ]);
        $uploaded->assertStatus(201);
        $assetId = $uploaded->json('asset.id');

        // The owner can fetch the stored logo for preview.
        $this->actingAs($owner, 'sanctum')
            ->get("/api/v1/brand-kit/assets/{$assetId}/download")
            ->assertStatus(200)
            ->assertHeader('content-type', 'image/png');

        // Another user gets a 404, never the file.
        $this->actingAs($other, 'sanctum')
            ->get("/api/v1/brand-kit/assets/{$assetId}/download")
            ->assertStatus(404);
    }

    // --- 2b. logo_overlay setting ---

    public function test_logo_overlay_defaults_off_and_accepts_explicit_on(): void
    {
        $user = User::factory()->create();

        $default = $this->createLinkJob($user);
        $this->assertFalse($default['settings']['logo_overlay']);

        $on = $this->createLinkJob($user, ['logo_overlay' => true]);
        $this->assertTrue($on['settings']['logo_overlay']);
    }

    public function test_logo_overlay_invalid_value_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                 'logo_overlay' => 'maybe'],
            ))
            ->assertStatus(422);
    }

    // --- 3. Thumbnail picker ---

    public function test_thumbnail_candidates_stored_and_picker_sets(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipWithCandidates($job['id']);

        $candidates = $clip->thumbnail_candidates;
        $this->assertIsArray($candidates);
        $this->assertCount(3, $candidates);
        foreach ($candidates as $path) {
            Storage::disk('local')->assertExists($path);
        }

        // A candidate frame streams for the picker preview.
        $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/candidates/1")
            ->assertStatus(200)
            ->assertHeader('content-type', 'image/jpeg');

        // Picking candidate 2 makes it the clip's thumbnail.
        $picked = $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/thumbnail", ['candidate_index' => 2])
            ->assertStatus(200)
            ->json('clip');
        $this->assertSame($candidates[2], $picked['thumbnail_path']);
        $this->assertSame($candidates[2], $clip->fresh()->thumbnail_path);
    }

    public function test_thumbnail_picker_wrong_owner_is_403(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipWithCandidates($job['id']);

        $this->actingAs($other, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/thumbnail", ['candidate_index' => 0])
            ->assertStatus(403);
    }

    public function test_thumbnail_picker_bad_index_is_422(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipWithCandidates($job['id']);

        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/thumbnail", ['candidate_index' => 5])
            ->assertStatus(422);
    }

    public function test_thumbnail_picker_clip_without_candidates_is_422(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);
        $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $this->demoClipFile(), 'title' => 'Clip 1'],
            $this->museHeaders()
        )->assertStatus(201);
        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $this->assertNull($clip->thumbnail_candidates);

        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/thumbnail", ['candidate_index' => 0])
            ->assertStatus(422)
            ->assertJsonPath('message', 'No alternate frames for this clip.');
    }

    // --- 4. Favourite clips ---

    public function test_favourite_toggle_flips_and_wrong_owner_is_403(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipWithCandidates($job['id']);

        $this->assertFalse((bool) $clip->is_favourite);

        $on = $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/favourite", [])
            ->assertStatus(200)
            ->json('clip');
        $this->assertTrue($on['is_favourite']);

        $off = $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/favourite", [])
            ->assertStatus(200)
            ->json('clip');
        $this->assertFalse($off['is_favourite']);

        $this->actingAs($other, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/favourite", [])
            ->assertStatus(403);
    }

    public function test_favourite_survives_rerender_replacement(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipWithCandidates($job['id']);

        // Favourite the clip, then re-render it (a different caption
        // style) — the replacement must keep the flag.
        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/favourite", [])
            ->assertStatus(200);
        $this->assertTrue((bool) $clip->fresh()->is_favourite);

        $rerender = ClipRerender::create([
            'clip_id' => $clip->id,
            'user_id' => $user->id,
            'caption_style' => 'karaoke',
            // The worker marks the re-render processing before it
            // uploads the replacement file.
            'status' => ClipRerender::STATUS_PROCESSING,
        ]);

        $this->post(
            "/api/v1/muse/clips/{$clip->id}/file",
            [
                'file' => $this->demoClipFile('clip2.mp4'),
                'rerender_id' => $rerender->id,
                'candidate_1' => UploadedFile::fake()->image('n1.jpg', 100, 100),
            ],
            $this->museHeaders()
        )->assertStatus(200);

        $fresh = $clip->fresh();
        $this->assertTrue((bool) $fresh->is_favourite);
        // The re-render also replaced the candidates with fresh ones.
        $this->assertIsArray($fresh->thumbnail_candidates);
        $this->assertCount(1, $fresh->thumbnail_candidates);
    }

    // --- 5. Best-settings insights ---

    public function test_insights_needs_three_ready_jobs_per_value(): void
    {
        $user = User::factory()->create();

        // 2 punchy jobs — below the threshold, omitted entirely.
        $this->makeReadyJob($user, ['caption_style' => 'punchy'], 0.90);
        $this->makeReadyJob($user, ['caption_style' => 'punchy'], 0.80);

        $empty = $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/insights/settings')
            ->assertStatus(200)
            ->json();
        $this->assertSame([], $empty['caption_style']);
        $this->assertSame([], $empty['layout']);
        $this->assertSame([], $empty['duration_mode']);

        // The 3rd punchy job qualifies it: avg (90+80+70)/3 = 80.0.
        $this->makeReadyJob($user, ['caption_style' => 'punchy'], 0.70);

        $rows = $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/insights/settings')
            ->assertStatus(200)
            ->json();
        // assertEquals, not assertSame: JSON encodes 80.0 as 80.
        $this->assertEquals([
            ['value' => 'punchy', 'average_score' => 80.0, 'job_count' => 3],
        ], $rows['caption_style']);
        // Layout + duration mode also qualify now (all three jobs share
        // the defaults center_crop / exact).
        $this->assertSame('center_crop', $rows['layout'][0]['value']);
        $this->assertSame(3, $rows['layout'][0]['job_count']);
        $this->assertSame('exact', $rows['duration_mode'][0]['value']);
    }

    public function test_insights_ignores_other_users_and_unscored_jobs(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        // Another user's 3 punchy jobs must not count for this user.
        $this->makeReadyJob($other, ['caption_style' => 'punchy'], 0.95);
        $this->makeReadyJob($other, ['caption_style' => 'punchy'], 0.95);
        $this->makeReadyJob($other, ['caption_style' => 'punchy'], 0.95);

        // This user's Ready job with no scored clip is skipped.
        $job = $this->createLinkJob($user, ['caption_style' => 'punchy']);
        ProcessingJob::findOrFail($job['id'])
            ->update(['state' => ProcessingJob::STATE_COMPLETED]);

        $rows = $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/insights/settings')
            ->assertStatus(200)
            ->json();
        $this->assertSame([], $rows['caption_style']);
    }

    // --- 6. Bulk jobs ---

    private function bulkPayload(array $files): array
    {
        return array_merge($this->validSettings(), ['files' => $files]);
    }

    public function test_bulk_create_three_files_creates_three_jobs(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user, 'sanctum')->post('/api/v1/jobs', $this->bulkPayload([
            $this->demoClipFile('one.mp4'),
            $this->demoClipFile('two.mp4'),
            $this->demoClipFile('three.mp4'),
        ]));
        $response->assertStatus(201);
        $jobs = $response->json('jobs');
        $this->assertCount(3, $jobs);
        $this->assertSame(3, ProcessingJob::where('user_id', $user->id)->count());

        // Identical settings on every job, distinct sources.
        foreach ($jobs as $job) {
            $this->assertSame(3, $job['settings']['clip_count']);
            $this->assertSame('9:16', $job['settings']['aspect_ratio']);
            $this->assertSame('queued', $job['status']);
        }
        $paths = array_column(array_column($jobs, 'settings'), 'source_path');
        $this->assertCount(3, array_unique($paths));
        // No single-job key on the bulk response.
        $this->assertArrayNotHasKey('job', $response->json());
    }

    public function test_bulk_create_six_files_is_422(): void
    {
        $user = User::factory()->create();

        $files = [];
        for ($i = 0; $i < 6; $i++) {
            $files[] = $this->demoClipFile("file{$i}.mp4");
        }

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', $this->bulkPayload($files))
            ->assertStatus(422);

        $this->assertSame(0, ProcessingJob::where('user_id', $user->id)->count());
    }

    public function test_bulk_create_one_bad_file_creates_no_jobs(): void
    {
        $user = User::factory()->create();

        $bad = UploadedFile::fake()->create('bad.mp4', 100, 'video/mp4');

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', $this->bulkPayload([
                $this->demoClipFile('good.mp4'),
                $bad,
            ]))
            ->assertStatus(422);

        $this->assertSame(0, ProcessingJob::where('user_id', $user->id)->count());
    }
}
