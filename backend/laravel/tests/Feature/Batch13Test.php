<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 13 (2026-11-25): automatic per-clip colour grading + quality
 * boost v2.
 *
 * Grading: the per-job colour_grade setting gains 'auto' (the new
 * default — the worker analyses each clip and picks the look that
 * suits it) plus three new looks (clean / mono / vintage). The worker
 * reports the grade each clip actually rendered with (+ the auto
 * picker's reason) on the clip row.
 *
 * Quality: the Draft/Standard/High selector already existed and
 * needed no setting change — the worker now honours it (fast/20,
 * medium/18, slow/16). The job stores the quality value verbatim,
 * covered by the default test below.
 */
class Batch13Test extends TestCase
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
            'clip_count' => 2,
            'duration_mode' => 'exact',
            'duration_seconds' => 20,
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

    private function makeJob(User $user, array $settings, array $attrs = []): ProcessingJob
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'Test project',
            'status' => Project::STATUS_DRAFT,
            'content_type' => 'general',
        ]);

        return ProcessingJob::create(array_merge([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_QUEUED,
            'stage' => 'Queued',
            'progress' => 0,
            'settings' => $settings,
            'source_type' => 'link',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $attrs));
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

    private function makeProcessingJob(User $user): ProcessingJob
    {
        $job = $this->makeJob($user, array_merge($this->validSettings(), [
            'colour_grade' => 'auto',
            'quality' => 'high',
        ]), [
            'state' => ProcessingJob::STATE_RENDERING,
        ]);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        return $job;
    }

    // --- Job creation: grade setting + defaults ------------------------

    public function test_job_create_defaults_colour_grade_to_auto(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->assertSame('auto', $job['settings']['colour_grade']);
        // The quality selector is untouched by this batch — it still
        // defaults to Standard and is stored verbatim.
        $this->assertSame('standard', $job['settings']['quality']);
    }

    public function test_job_create_accepts_new_grades(): void
    {
        $user = User::factory()->create();

        foreach (['clean', 'mono', 'vintage', 'auto', 'none'] as $grade) {
            $job = $this->createLinkJob($user, ['colour_grade' => $grade]);
            $this->assertSame($grade, $job['settings']['colour_grade']);
        }
    }

    public function test_job_create_accepts_old_grades_unchanged(): void
    {
        $user = User::factory()->create();

        foreach (['vibrant', 'warm', 'cool', 'cinematic'] as $grade) {
            $job = $this->createLinkJob($user, ['colour_grade' => $grade]);
            $this->assertSame($grade, $job['settings']['colour_grade']);
        }
    }

    public function test_job_create_rejects_bogus_grade(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
                ['colour_grade' => 'teal']
            ))
            ->assertStatus(422);
    }

    // --- Addition 11: the layout is stored for EVERY ratio, not just
    // 9:16. The worker honours it per ratio (see
    // Batch13LayoutRatioTests); the API never silently discards it.
    public function test_job_create_stores_layout_for_every_ratio(): void
    {
        $user = User::factory()->create();

        $cases = [
            ['aspect_ratio' => '16:9', 'layout' => 'blur_fill'],
            ['aspect_ratio' => '1:1', 'layout' => 'framed'],
            ['aspect_ratio' => '4:5', 'layout' => 'split'],
            ['aspect_ratio' => '9:16', 'layout' => 'split'],
        ];
        foreach ($cases as $case) {
            $job = $this->createLinkJob($user, $case);
            $this->assertSame($case['aspect_ratio'], $job['settings']['aspect_ratio']);
            $this->assertSame($case['layout'], $job['settings']['layout']);
        }
    }

    // --- Parent fix (verifier blocker): one ratio in, same ratio out.
    // The backend no longer force-includes 9:16, and 4:5 is a valid
    // export ratio — a job stores (and renders) exactly the ratio it
    // was asked for.
    public function test_job_create_stores_single_export_ratio(): void
    {
        $user = User::factory()->create();

        $job = $this->createLinkJob($user, [
            'aspect_ratio' => '16:9',
            'export_ratios' => ['16:9'],
        ]);
        $this->assertSame(['16:9'], $job['settings']['export_ratios']);

        $job = $this->createLinkJob($user, [
            'aspect_ratio' => '4:5',
            'export_ratios' => ['4:5'],
        ]);
        $this->assertSame(['4:5'], $job['settings']['export_ratios']);

        // No export_ratios sent at all: the job's own ratio only.
        $job = $this->createLinkJob($user, ['aspect_ratio' => '1:1']);
        $this->assertSame(['1:1'], $job['settings']['export_ratios']);
    }

    // --- Worker clip upload: grade fields ------------------------------

    public function test_store_clip_accepts_grade_fields(): void
    {
        $user = User::factory()->create();
        $job = $this->makeProcessingJob($user);

        $this->post(
            "/api/v1/muse/jobs/{$job->id}/clips",
            [
                'file' => $this->demoClipFile(),
                'title' => 'Clip 1',
                'colour_grade_applied' => 'cool',
                'colour_grade_reason' => 'warm cast — cooled down',
            ],
            $this->museHeaders()
        )->assertStatus(201);

        $clip = Clip::where('job_id', $job->id)->first();
        $this->assertNotNull($clip);
        $this->assertSame('cool', $clip->colour_grade_applied);
        $this->assertSame('warm cast — cooled down', $clip->colour_grade_reason);
    }

    public function test_store_clip_without_grade_fields_stores_nulls(): void
    {
        $user = User::factory()->create();
        $job = $this->makeProcessingJob($user);

        $this->post(
            "/api/v1/muse/jobs/{$job->id}/clips",
            ['file' => $this->demoClipFile(), 'title' => 'Clip 1'],
            $this->museHeaders()
        )->assertStatus(201);

        $clip = Clip::where('job_id', $job->id)->first();
        $this->assertNotNull($clip);
        $this->assertNull($clip->colour_grade_applied);
        $this->assertNull($clip->colour_grade_reason);
    }

    public function test_store_clip_rejects_too_long_grade_reason(): void
    {
        $user = User::factory()->create();
        $job = $this->makeProcessingJob($user);

        $this->post(
            "/api/v1/muse/jobs/{$job->id}/clips",
            [
                'file' => $this->demoClipFile(),
                'title' => 'Clip 1',
                'colour_grade_applied' => 'clean',
                'colour_grade_reason' => str_repeat('x', 300),
            ],
            $this->museHeaders()
        )->assertStatus(422);
    }

    public function test_job_detail_returns_grade_fields(): void
    {
        $user = User::factory()->create();
        $job = $this->makeProcessingJob($user);

        $this->post(
            "/api/v1/muse/jobs/{$job->id}/clips",
            [
                'file' => $this->demoClipFile(),
                'title' => 'Clip 1',
                'colour_grade_applied' => 'vibrant',
                'colour_grade_reason' => 'washed out — contrast and colour boosted',
            ],
            $this->museHeaders()
        )->assertStatus(201);

        $response = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}");

        $response->assertStatus(200);
        $clips = $response->json('job.clips') ?? $response->json('clips');
        $this->assertNotEmpty($clips);
        $this->assertSame('vibrant', $clips[0]['colour_grade_applied']);
        $this->assertSame(
            'washed out — contrast and colour boosted',
            $clips[0]['colour_grade_reason']
        );
    }
}
