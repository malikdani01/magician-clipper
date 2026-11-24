<?php

namespace Tests\Feature;

use App\Models\Notification;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Ready-notification wording: 1 clip is singular, 2+ clips plural.
 * Also covers the intro/outro-applied flags the worker reports with
 * its status updates (stored whenever present, exposed on the job).
 */
class NotificationPluralTest extends TestCase
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
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ]);
        $response->assertStatus(201);

        return $response->json('job');
    }

    private function setStatus(int $jobId, array $payload): \Illuminate\Testing\TestResponse
    {
        return $this->patchJson(
            "/api/v1/muse/jobs/{$jobId}/status",
            $payload,
            $this->museHeaders()
        );
    }

    private function uploadClip(int $jobId, string $title): void
    {
        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/jobs/{$jobId}/clips",
            ['file' => $file, 'title' => $title, 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);
    }

    public function test_ready_with_one_clip_uses_singular_body(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->setStatus($job['id'], ['status' => 'Processing'])->assertStatus(200);
        $this->uploadClip($job['id'], 'Clip 1');
        $this->setStatus($job['id'], ['status' => 'Ready'])->assertStatus(200);

        $notification = Notification::firstOrFail();
        $this->assertSame('1 clip is ready to preview and download.', $notification->body);
    }

    public function test_ready_with_two_clips_uses_plural_body(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->setStatus($job['id'], ['status' => 'Processing'])->assertStatus(200);
        $this->uploadClip($job['id'], 'Clip 1');
        $this->uploadClip($job['id'], 'Clip 2');
        $this->setStatus($job['id'], ['status' => 'Ready'])->assertStatus(200);

        $notification = Notification::firstOrFail();
        $this->assertSame('2 clips are ready to preview and download.', $notification->body);
    }

    public function test_ready_with_zero_clips_uses_plural_body(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->setStatus($job['id'], ['status' => 'Ready'])->assertStatus(200);

        $notification = Notification::firstOrFail();
        $this->assertSame('0 clips are ready to preview and download.', $notification->body);
    }

    public function test_failed_body_is_unchanged(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->setStatus($job['id'], [
            'status' => 'Failed',
            'error_reason' => 'engine crashed',
        ])->assertStatus(200);

        $notification = Notification::firstOrFail();
        $this->assertSame('engine crashed', $notification->body);
    }

    public function test_intro_outro_flags_are_stored_and_exposed(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        // Flags ride on a mid-flight report too, not only on Ready.
        $this->setStatus($job['id'], [
            'status' => 'Processing',
            'intro_applied' => true,
            'outro_applied' => false,
        ])->assertStatus(200);

        $shown = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->json('job');
        $this->assertTrue($shown['intro_applied']);
        $this->assertFalse($shown['outro_applied']);

        // The final Ready report updates them.
        $this->setStatus($job['id'], [
            'status' => 'Ready',
            'intro_applied' => true,
            'outro_applied' => true,
        ])->assertStatus(200)
            ->assertJsonPath('job.intro_applied', true)
            ->assertJsonPath('job.outro_applied', true);
    }

    public function test_flags_default_to_false(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $shown = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job['id']}")
            ->assertStatus(200)
            ->json('job');
        $this->assertFalse($shown['intro_applied']);
        $this->assertFalse($shown['outro_applied']);
    }
}
