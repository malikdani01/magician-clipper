<?php

namespace Tests\Feature;

use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class MuseJobApiTest extends TestCase
{
    use RefreshDatabase;

    private const MUSE_KEY = 'test-muse-key-1234567890abcdef';

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

    private function museHeaders(): array
    {
        return ['X-Muse-Api-Key' => self::MUSE_KEY];
    }

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.muse_job_api_key' => self::MUSE_KEY]);
        Storage::fake('local');
    }

    // --- FIX 1: unauthenticated /api/* calls return 401 JSON, never 500 ---

    public function test_unauthenticated_api_call_without_accept_header_returns_401_json(): void
    {
        $response = $this->call(
            'GET', '/api/v1/me', [], [], [],
            ['HTTP_ACCEPT' => 'text/html']
        );

        $response->assertStatus(401)
            ->assertHeader('Content-Type', 'application/json')
            ->assertJson(['code' => 'UNAUTHENTICATED']);
    }

    public function test_unauthenticated_muse_api_without_key_returns_401_json(): void
    {
        $this->getJson('/api/v1/muse/jobs?status=queued')->assertStatus(401);
    }

    // --- CORS (Worker B blocker fix): preflight gets ACAO headers ---

    public function test_cors_preflight_returns_allow_origin_for_frontend(): void
    {
        $response = $this->call(
            'OPTIONS', '/api/v1/auth/login', [], [], [],
            [
                'HTTP_ORIGIN' => 'http://localhost:5173',
                'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
                'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'authorization,content-type',
            ]
        );

        $response->assertStatus(204)
            ->assertHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
            ->assertHeader('Access-Control-Allow-Credentials', 'true');
    }

    public function test_cors_preflight_does_not_allow_unknown_origin(): void
    {
        $response = $this->call(
            'OPTIONS', '/api/v1/auth/login', [], [], [],
            [
                'HTTP_ORIGIN' => 'http://evil.example',
                'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
            ]
        );

        $response->assertStatus(204)
            ->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_muse_api_with_wrong_key_returns_401(): void
    {
        $this->getJson('/api/v1/muse/jobs?status=queued', ['X-Muse-Api-Key' => 'wrong-key'])
            ->assertStatus(401);
    }

    // --- User-facing job creation ---

    public function test_user_can_create_link_job_and_it_starts_queued(): void
    {
        $user = User::factory()->create();

        $job = $this->createLinkJob($user);

        $this->assertSame('queued', $job['status']);
        $this->assertSame('queued', $job['state']);
        $this->assertSame('link', $job['source_type']);
        $this->assertSame('tiktok', $job['settings']['platform']);
        $this->assertSame(3, $job['settings']['clip_count']);
        $this->assertSame([], $job['clips']);
        $this->assertDatabaseHas('processing_jobs', [
            'id' => $job['id'], 'state' => 'queued', 'source_type' => 'link',
        ]);
    }

    public function test_all_animated_caption_styles_are_accepted_on_job_create(): void
    {
        // Job creation is throttled (6/min per user), so each style gets
        // its own user — the point is the style validation, not the limit.
        foreach (['karaoke', 'bounce', 'typewriter', 'sweep', 'neon', 'slam', 'outline', 'gradient'] as $style) {
            $user = User::factory()->create();
            $job = $this->createLinkJob($user, ['caption_style' => $style]);

            $this->assertSame($style, $job['settings']['caption_style']);
        }

        // And an unknown style is still rejected.
        $user = User::factory()->create();
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                [
                    'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                    'caption_style' => 'not_a_style',
                ]
            ))
            ->assertStatus(422);
    }

    public function test_create_job_requires_exactly_one_source(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->validSettings())
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['source_url' => 'https://example.com/not-a-video-page']
            ))
            ->assertStatus(422);
    }

    public function test_create_job_rejects_non_video_upload(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['file' => UploadedFile::fake()->create('video.mp4', 100, 'video/mp4')]
            ))
            ->assertStatus(422)
            ->assertJsonPath('error', 'validation_error');
    }

    public function test_campaign_job_requires_requirements_text(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['job_type' => 'campaign',
                    'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
            ))
            ->assertStatus(422);
    }

    public function test_user_cannot_view_another_users_job(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $job = $this->createLinkJob($owner);

        $this->actingAs($other, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(403);
    }

    // --- Muse Job API: list / show / status ---

    public function test_muse_lists_queued_jobs_with_full_settings(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $response = $this->getJson(
            '/api/v1/muse/jobs?status=queued', $this->museHeaders()
        );

        $response->assertStatus(200);
        $data = $response->json('data');
        $this->assertCount(1, $data);
        $this->assertSame($job['id'], $data[0]['id']);
        $this->assertSame('https://www.youtube.com/watch?v=dQw4w9WgXcQ', $data[0]['source_url']);
        $this->assertSame(3, $data[0]['settings']['clip_count']);
    }

    public function test_muse_status_walk_queued_to_ready(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200)->assertJsonPath('job.status', 'processing');

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('job.status', 'ready')
            ->assertJsonPath('job.state', 'completed');

        // Ready is terminal: marking it Failed afterwards is a 422.
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Failed', 'error_reason' => 'too late'],
            $this->museHeaders()
        )->assertStatus(422);
    }

    public function test_project_status_follows_job_to_ready(): void
    {
        // Regression test (2026-11-23): projects were created as
        // "processing" and never updated, so a finished job still
        // showed as "Processing" at 100% in Recent projects.
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $projectId = ProcessingJob::findOrFail($job['id'])->project_id;

        $this->assertDatabaseHas('projects', ['id' => $projectId, 'status' => 'processing']);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);
        $this->assertDatabaseHas('projects', ['id' => $projectId, 'status' => 'processing']);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);
        $this->assertDatabaseHas('projects', ['id' => $projectId, 'status' => 'ready']);
    }

    // --- Cancel flow: queued -> cancelled directly; in-flight -> cancelling
    // -> cancelled by the worker; never stuck in 'cancelling' or 'failed'.

    public function test_cancel_queued_job_goes_straight_to_cancelled(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/jobs/{$job['id']}/cancel")
            ->assertStatus(200)
            ->assertJsonPath('job.state', 'cancelled')
            ->assertJsonPath('job.status', 'cancelled');

        // A cancelled job is no longer listed as queued for the worker.
        $this->getJson(
            '/api/v1/muse/jobs?status=queued', $this->museHeaders()
        )->assertStatus(200)->assertJsonPath('data', []);

        // And it cannot be cancelled again.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/jobs/{$job['id']}/cancel")
            ->assertStatus(422);
    }

    public function test_cancel_in_flight_job_then_worker_marks_cancelled(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        // Worker claims the job (queued -> processing).
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        // User cancels mid-flight: state becomes 'cancelling'.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/jobs/{$job['id']}/cancel")
            ->assertStatus(200)
            ->assertJsonPath('job.state', 'cancelling');

        // Worker stops at its next stage boundary and reports Cancelled.
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Cancelled'],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('job.state', 'cancelled')
            ->assertJsonPath('job.status', 'cancelled');

        // A cancelled job must NOT end up failed via the worker.
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Failed', 'error_reason' => 'too late'],
            $this->museHeaders()
        )->assertStatus(422);
    }

    public function test_worker_cannot_cancel_a_job_that_is_not_cancelling(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        // Still queued: the worker may not jump it to cancelled.
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Cancelled'],
            $this->museHeaders()
        )->assertStatus(422);
    }

    // --- Notes: free-text brief for Muse, stored with the job and
    // visible to the worker through the job detail.

    public function test_job_notes_persist_and_reach_the_worker(): void
    {
        $user = User::factory()->create();
        $notes = 'Campaign: GTA 6 launch. MUST show the strip-club scene. '
            . 'Nice to have: yellow keyword captions. Avoid: map browsing.';
        $job = $this->createLinkJob($user, ['notes' => $notes]);

        $this->assertSame($notes, $job['settings']['notes'] ?? null);

        $this->getJson(
            "/api/v1/muse/jobs/{$job['id']}", $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('job.settings.notes', $notes);
    }

    // --- Stale reclaim: a worker killed mid-job (VM restart, crash)
    // leaves the job in an in-flight state. The queued listing must
    // reclaim it after 30 idle minutes so the next poll re-runs it
    // instead of leaving it stuck "Processing" forever.

    private function leaveJobInFlight(array $job, string $state, int $idleMinutes): void
    {
        $model = ProcessingJob::find($job['id']);
        $model->state = $state;
        $model->updated_at = now()->subMinutes($idleMinutes);
        $model->timestamps = false; // keep the backdated updated_at
        $model->save();
    }

    public function test_queued_list_reclaims_stale_in_flight_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->leaveJobInFlight($job, ProcessingJob::STATE_PROBING, 31);

        $this->getJson('/api/v1/muse/jobs?status=queued', $this->museHeaders())
            ->assertStatus(200)
            ->assertJsonPath('data.0.id', $job['id'])
            ->assertJsonPath('data.0.stale', true);
    }

    public function test_queued_list_ignores_fresh_in_flight_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->leaveJobInFlight($job, ProcessingJob::STATE_PROBING, 1);

        $this->getJson('/api/v1/muse/jobs?status=queued', $this->museHeaders())
            ->assertStatus(200)
            ->assertJsonMissing(['id' => $job['id']]);
    }

    public function test_queued_list_never_reclaims_cancelling_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->leaveJobInFlight($job, ProcessingJob::STATE_CANCELLING, 120);

        $this->getJson('/api/v1/muse/jobs?status=queued', $this->museHeaders())
            ->assertStatus(200)
            ->assertJsonMissing(['id' => $job['id']]);
    }

    public function test_delete_clips_removes_records_and_files(): void
    {
        $user = User::factory()->create();
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

        $clip = \App\Models\Clip::where('job_id', $job['id'])->first();
        $this->assertNotNull($clip);
        Storage::disk('local')->assertExists($clip->output_path);

        $this->deleteJson(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            [],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('deleted', 1);

        $this->assertSame(0, \App\Models\Clip::where('job_id', $job['id'])->count());
        Storage::disk('local')->assertMissing($clip->output_path);
    }

    public function test_store_clip_with_thumbnail_and_thumbnail_endpoint(): void
    {
        $user = User::factory()->create();
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
            [
                'file' => $file,
                'thumbnail' => UploadedFile::fake()->image('thumb.jpg', 100, 100),
                'title' => 'Clip 1',
                'score' => 0.8,
            ],
            $this->museHeaders()
        )->assertStatus(201);

        $clip = \App\Models\Clip::where('job_id', $job['id'])->first();
        $this->assertNotNull($clip);
        $this->assertNotNull($clip->thumbnail_path);
        Storage::disk('local')->assertExists($clip->thumbnail_path);

        // The user-facing thumbnail endpoint streams the stored JPEG.
        $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/thumbnail")
            ->assertStatus(200)
            ->assertHeader('content-type', 'image/jpeg');

        // A clip without a thumbnail 404s instead of serving a fake image.
        $job2 = $this->createLinkJob($user);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job2['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);
        $file2 = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/jobs/{$job2['id']}/clips",
            ['file' => $file2, 'title' => 'Clip 1'],
            $this->museHeaders()
        )->assertStatus(201);
        $clip2 = \App\Models\Clip::where('job_id', $job2['id'])->first();
        $this->assertNull($clip2->thumbnail_path);
        $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip2->id}/thumbnail")
            ->assertStatus(404);
    }

    // --- Server-side export ZIP ---

    private function uploadClipForJob(array $job, string $title = 'Clip 1'): \App\Models\Clip
    {
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
            ['file' => $file, 'title' => $title, 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);

        return \App\Models\Clip::where('job_id', $job['id'])->first();
    }

    public function test_export_builds_real_zip_and_download_streams_it(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipForJob($job);
        $projectId = $job['project_id'];

        $response = $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/projects/{$projectId}/export");
        $response->assertStatus(201)
            ->assertJsonPath('export.status', 'ready')
            ->assertJsonPath('export.format', 'zip');

        $export = \App\Models\Export::findOrFail($response->json('export.id'));
        $this->assertSame([$clip->id], $export->clip_ids);
        Storage::disk('local')->assertExists($export->file_path);

        $zip = new \ZipArchive();
        $this->assertTrue($zip->open(Storage::disk('local')->path($export->file_path)));
        $this->assertSame(1, $zip->numFiles);
        $this->assertSame('Clip_1.mp4', $zip->getNameIndex(0));
        $zip->close();

        $this->actingAs($user, 'sanctum')
            ->get("/api/v1/exports/{$export->id}/download")
            ->assertStatus(200)
            ->assertHeader('content-type', 'application/zip');

        $this->assertDatabaseHas('exports', ['id' => $export->id, 'download_count' => 1]);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/exports')
            ->assertStatus(200)
            ->assertJsonPath('data.0.id', $export->id);
    }

    public function test_export_with_no_ready_clips_is_422_and_other_user_cannot_download(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $clip = $this->uploadClipForJob($job);
        $projectId = $job['project_id'];

        $exportId = $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/projects/{$projectId}/export")
            ->assertStatus(201)
            ->json('export.id');

        $other = User::factory()->create();
        $this->actingAs($other, 'sanctum')
            ->get("/api/v1/exports/{$exportId}/download")
            ->assertStatus(403);

        $emptyJob = $this->createLinkJob($user);
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/projects/{$emptyJob['project_id']}/export")
            ->assertStatus(422);
    }

    // --- Source download: the remote worker's channel for uploaded
    // videos (the local path is meaningless on another machine).

    private function createUploadJob(User $user): array
    {
        $file = new \Illuminate\Http\UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'demo-source-3min.mp4',
            'video/mp4',
            null,
            true // test upload: skip is_uploaded_file() check
        );

        $response = $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['file' => $file]
            ));

        $response->assertStatus(201);

        return $response->json('job');
    }

    public function test_muse_source_download_requires_key(): void
    {
        $user = User::factory()->create();
        $job = $this->createUploadJob($user);

        $this->getJson("/api/v1/muse/jobs/{$job['id']}/source")
            ->assertStatus(401);
    }

    public function test_muse_source_download_404_for_link_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->getJson(
            "/api/v1/muse/jobs/{$job['id']}/source", $this->museHeaders()
        )->assertStatus(404)
            ->assertJsonPath('error', 'not_found');
    }

    public function test_muse_source_download_streams_uploaded_file(): void
    {
        $user = User::factory()->create();
        $job = $this->createUploadJob($user);

        $response = $this->get(
            "/api/v1/muse/jobs/{$job['id']}/source", $this->museHeaders()
        );

        $response->assertStatus(200);
        $this->assertSame(
            filesize(base_path('../../demo/demo-source-3min.mp4')),
            (int) $response->headers->get('Content-Length')
        );
        $this->assertStringContainsString(
            '.mp4',
            $response->headers->get('Content-Disposition')
        );
    }

    public function test_muse_failed_status_keeps_exact_reason(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Failed', 'error_reason' => 'yt-dlp failed: video unavailable'],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('job.status', 'failed')
            ->assertJsonPath('job.error_message', 'yt-dlp failed: video unavailable');

        $this->assertDatabaseHas('processing_jobs', [
            'id' => $job['id'], 'state' => 'failed',
        ]);
    }

    public function test_muse_same_status_report_updates_stage_and_progress(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing', 'stage' => 'transcribing', 'progress' => 20],
            $this->museHeaders()
        )->assertStatus(200)
            ->assertJsonPath('job.stage', 'transcribing')
            ->assertJsonPath('job.progress', 20);
    }

    // --- Muse clip upload ---

    public function test_muse_clip_upload_requires_processing_job(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user); // still queued

        $this->postJson(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => UploadedFile::fake()->create('clip.mp4', 100, 'video/mp4')],
            $this->museHeaders()
        )->assertStatus(422);
    }

    public function test_muse_clip_upload_rejects_non_video(): void
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
            ['file' => UploadedFile::fake()->create('clip.mp4', 100, 'video/mp4')],
            $this->museHeaders()
        )->assertStatus(422);
    }

    // --- Settings (FIX 2) ---

    public function test_settings_show_returns_defaults_and_update_persists(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/settings')
            ->assertStatus(200)
            ->assertJsonPath('settings.default_processing_mode', 'balanced')
            ->assertJsonPath('settings.default_aspect_ratio', '9:16');

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', [
                'default_processing_mode' => 'eco',
                'default_aspect_ratio' => '1:1',
                'notifications_enabled' => false,
            ])
            ->assertStatus(200)
            ->assertJsonPath('settings.default_processing_mode', 'eco')
            ->assertJsonPath('settings.default_aspect_ratio', '1:1')
            ->assertJsonPath('settings.notifications_enabled', false);

        $this->assertDatabaseHas('user_settings', [
            'user_id' => $user->id,
            'default_processing_mode' => 'eco',
        ]);
    }

    public function test_settings_update_rejects_invalid_values(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['default_processing_mode' => 'turbo'])
            ->assertStatus(422);
    }

    public function test_settings_update_saves_profile_name_and_email_for_real(): void
    {
        $user = User::factory()->create(['name' => 'Old Name', 'email' => 'old@example.com']);
        $other = User::factory()->create(['email' => 'taken@example.com']);

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['name' => 'New Name', 'email' => 'new@example.com'])
            ->assertStatus(200)
            ->assertJsonPath('user.name', 'New Name')
            ->assertJsonPath('user.email', 'new@example.com');

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'name' => 'New Name',
            'email' => 'new@example.com',
        ]);

        // Another user's email is rejected, and the user's own email
        // can be re-sent unchanged.
        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['email' => 'taken@example.com'])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['email' => 'new@example.com'])
            ->assertStatus(200);
    }

    // --- Public status mapping ---

    public function test_public_status_mapping(): void
    {
        $this->assertSame('queued', (new ProcessingJob(['state' => 'uploaded']))->publicStatus());
        $this->assertSame('queued', (new ProcessingJob(['state' => 'queued']))->publicStatus());
        $this->assertSame('processing', (new ProcessingJob(['state' => 'transcribing']))->publicStatus());
        $this->assertSame('ready', (new ProcessingJob(['state' => 'completed']))->publicStatus());
        $this->assertSame('failed', (new ProcessingJob(['state' => 'failed']))->publicStatus());
    }
}
