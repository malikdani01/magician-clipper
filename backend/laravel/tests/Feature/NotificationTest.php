<?php

namespace Tests\Feature;

use App\Models\Notification;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Job notifications: when the worker moves a job to Ready or Failed,
 * the job owner gets exactly one notification per (job, type) — a
 * repeated Ready report (same-status) creates no second one. The
 * user can list, mark one read, and mark all read.
 */
class NotificationTest extends TestCase
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

    private function uploadOneClip(int $jobId): void
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
            ['file' => $file, 'title' => 'Clip 1', 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);
    }

    public function test_ready_transition_creates_exactly_one_notification(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        // Processing alone notifies nobody.
        $this->setStatus($job['id'], ['status' => 'Processing'])->assertStatus(200);
        $this->assertSame(0, Notification::count());

        $this->uploadOneClip($job['id']);

        $this->setStatus($job['id'], ['status' => 'Ready'])->assertStatus(200);
        $this->assertSame(1, Notification::count());

        $notification = Notification::firstOrFail();
        $this->assertSame($user->id, $notification->user_id);
        $this->assertSame($job['id'], $notification->job_id);
        $this->assertSame('job_ready', $notification->type);
        $this->assertSame("Job #{$job['id']} is ready", $notification->title);
        $this->assertSame('1 clips are ready to preview and download.', $notification->body);
        $this->assertSame("/jobs/{$job['id']}", $notification->link);
        $this->assertNull($notification->read_at);

        // A repeated Ready report is the same-status early return and
        // must NOT create a second notification.
        $this->setStatus($job['id'], ['status' => 'Ready'])->assertStatus(200);
        $this->assertSame(1, Notification::count());
    }

    public function test_failed_transition_creates_exactly_one_notification_with_the_reason(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);

        $this->setStatus($job['id'], [
            'status' => 'Failed',
            'error_reason' => 'yt-dlp failed: video unavailable',
        ])->assertStatus(200);

        $this->assertSame(1, Notification::count());
        $notification = Notification::firstOrFail();
        $this->assertSame('job_failed', $notification->type);
        $this->assertSame("Job #{$job['id']} failed", $notification->title);
        $this->assertSame('yt-dlp failed: video unavailable', $notification->body);
        $this->assertSame("/jobs/{$job['id']}", $notification->link);

        // A repeated Failed report is the same-status early return.
        $this->setStatus($job['id'], [
            'status' => 'Failed',
            'error_reason' => 'yt-dlp failed: video unavailable',
        ])->assertStatus(200);
        $this->assertSame(1, Notification::count());
    }

    public function test_list_read_and_read_all_are_scoped_to_the_owner(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $job1 = $this->createLinkJob($user);
        $this->setStatus($job1['id'], ['status' => 'Ready'])->assertStatus(200);
        $job2 = $this->createLinkJob($user);
        $this->setStatus($job2['id'], [
            'status' => 'Failed',
            'error_reason' => 'engine crashed',
        ])->assertStatus(200);

        // Another user sees none of them.
        $this->actingAs($other, 'sanctum')
            ->getJson('/api/v1/notifications')
            ->assertStatus(200)
            ->assertJsonCount(0, 'data');

        // Owner lists newest first, both unread.
        $listed = $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/notifications')
            ->assertStatus(200)
            ->assertJsonCount(2, 'data')
            ->json('data');
        $this->assertNull($listed[0]['read_at']);
        $this->assertNull($listed[1]['read_at']);
        $newestId = $listed[0]['id'];

        // Another user cannot mark the owner's notification read.
        $this->actingAs($other, 'sanctum')
            ->patchJson("/api/v1/notifications/{$newestId}/read")
            ->assertStatus(404);
        $this->assertNull(Notification::findOrFail($newestId)->read_at);

        // Owner marks one read.
        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/notifications/{$newestId}/read")
            ->assertStatus(200);
        $this->assertNotNull(Notification::findOrFail($newestId)->read_at);

        // Read-all marks the remaining one.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/notifications/read-all')
            ->assertStatus(200)
            ->assertJsonPath('updated', 1);
        $this->assertSame(0, Notification::where('user_id', $user->id)->unread()->count());

        // Read-all again: nothing left to mark.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/notifications/read-all')
            ->assertStatus(200)
            ->assertJsonPath('updated', 0);
    }
}
