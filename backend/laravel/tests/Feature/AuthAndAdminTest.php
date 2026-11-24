<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class AuthAndAdminTest extends TestCase
{
    use RefreshDatabase;

    public function test_unauthenticated_me_returns_401(): void
    {
        $this->getJson('/api/v1/me')->assertStatus(401);
    }

    public function test_register_returns_token_and_user(): void
    {
        $response = $this->postJson('/api/v1/auth/register', [
            'name' => 'Test User',
            'email' => 'test@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
        ]);

        $response->assertStatus(201)
            ->assertJsonStructure(['user' => ['id', 'name', 'email', 'role'], 'token', 'token_type']);

        $this->assertDatabaseHas('users', ['email' => 'test@example.com']);
    }

    public function test_login_with_wrong_password_fails(): void
    {
        User::factory()->create(['email' => 'test@example.com']);

        $this->postJson('/api/v1/auth/login', [
            'email' => 'test@example.com',
            'password' => 'wrong-password',
        ])->assertStatus(422);
    }

    public function test_non_admin_cannot_reach_admin_dashboard(): void
    {
        $user = User::factory()->create(['role' => 'user']);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(403)
            ->assertJson(['error' => 'forbidden']);
    }

    public function test_admin_can_reach_admin_dashboard(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(200)
            ->assertJsonStructure(['users', 'projects', 'clips', 'jobs'])
            ->assertJsonStructure([
                'daily', 'usage', 'nav_counts',
                'recent_jobs', 'recent_clips',
            ]);
    }

    public function test_admin_dashboard_new_users_window_is_30_days(): void
    {
        // Regression (audit 2026-11-24): the card said "2 new in the
        // last 7 days" under a "New in the last 30 days" heading — the
        // count and the heading used different windows. Both are 30
        // days now, matching the growth and daily-series windows.
        $admin = User::factory()->admin()->create();
        User::factory()->create(['created_at' => now()->subDays(10)]);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(200)
            ->assertJsonPath('users.new_last_30_days', 2);
    }

    public function test_admin_dashboard_usage_counts_job_settings(): void
    {
        // Regression test (2026-11-23): jobUsage() used SQLite-only
        // json_extract(), which 500'd the dashboard on production
        // Postgres. Usage must be counted from the settings JSON
        // without any database-specific function.
        $admin = User::factory()->admin()->create();
        $user = User::factory()->create();
        $payload = fn (string $platform, string $style) => [
            'platform' => $platform,
            'aspect_ratio' => '9:16',
            'clip_count' => 2,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'captions_enabled' => true,
            'captions_language' => 'english',
            'caption_style' => $style,
            'on_screen_text' => false,
            'job_type' => 'myself',
            'layout' => 'center_crop',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ];
        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', $payload('tiktok', 'punchy'))->assertStatus(201);
        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', $payload('tiktok', 'word_pop'))->assertStatus(201);
        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', $payload('instagram', 'punchy'))->assertStatus(201);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(200)
            ->assertJsonPath('usage.platforms.0.label', 'tiktok')
            ->assertJsonPath('usage.platforms.0.value', 2)
            ->assertJsonPath('usage.platforms.1.label', 'instagram')
            ->assertJsonPath('usage.caption_styles.0.label', 'punchy')
            ->assertJsonPath('usage.caption_styles.0.value', 2);
    }

    public function test_admin_system_logs_returns_tail_lines(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/system/logs?lines=10')
            ->assertStatus(200)
            ->assertJsonStructure(['lines', 'total_lines', 'file']);
    }

    public function test_non_admin_cannot_read_system_logs(): void
    {
        $user = User::factory()->create(['role' => 'user']);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/admin/system/logs')
            ->assertStatus(403);
    }

    public function test_system_logs_redacts_secret_values(): void
    {
        $admin = User::factory()->admin()->create();
        $path = storage_path('logs/laravel.log');
        $original = is_file($path) ? file_get_contents($path) : null;

        try {
            file_put_contents(
                $path,
                "[2026-11-22 16:00:00] testing.INFO: probe MUSE_JOB_API_KEY=fake-secret-xyz123 and password=hunter2-here\n",
                FILE_APPEND
            );

            $response = $this->actingAs($admin, 'sanctum')
                ->getJson('/api/v1/admin/system/logs?lines=50');

            $response->assertStatus(200);
            $this->assertStringNotContainsString('fake-secret-xyz123', $response->getContent());
            $this->assertStringNotContainsString('hunter2-here', $response->getContent());
            $this->assertStringContainsString('[redacted]', $response->getContent());
        } finally {
            if ($original === null) {
                @unlink($path);
            } else {
                file_put_contents($path, $original);
            }
        }
    }

    public function test_me_stats_counts_only_the_signed_in_users_jobs_and_clips(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
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
        ])->assertStatus(201);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/stats')
            ->assertStatus(200)
            ->assertJsonPath('jobs_total', 1)
            ->assertJsonPath('jobs_processing', 1)
            ->assertJsonPath('clips_total', 0);

        $this->actingAs($other, 'sanctum')
            ->getJson('/api/v1/me/stats')
            ->assertStatus(200)
            ->assertJsonPath('jobs_total', 0)
            ->assertJsonPath('clips_total', 0);
    }

    public function test_user_cannot_view_another_users_project(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $project = $owner->projects()->create(['title' => 'Mine']);

        $this->actingAs($other, 'sanctum')
            ->getJson("/api/v1/projects/{$project->id}")
            ->assertStatus(403);
    }

    public function test_admin_clips_lists_real_clips_with_job_and_owner(): void
    {
        // Regression (audit 2026-11-24): the admin clips page said
        // "no admin clips list endpoint yet" while the dashboard
        // counted 5 real clips. The list must show those same clips.
        $admin = User::factory()->admin()->create();
        $user = User::factory()->create(['name' => 'Clip Owner']);
        $project = $user->projects()->create(['title' => 'Owner project']);
        $job = $user->processingJobs()->create([
            'project_id' => $project->id,
            'state' => ProcessingJob::STATE_COMPLETED,
            'stage' => 'ready',
            'progress' => 100,
            'settings' => ['platform' => 'tiktok'],
            'source_type' => 'link',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ]);
        Clip::create([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Test clip',
            'status' => Clip::STATUS_READY,
            'start_seconds' => 7.0,
            'end_seconds' => 39.0,
            'duration_seconds' => 32.0,
            'aspect_ratio' => '9:16',
            'file_size_bytes' => 13_100_000,
            'score' => 0.75,
        ]);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/clips')
            ->assertStatus(200)
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.title', 'Test clip')
            ->assertJsonPath('data.0.status', 'ready')
            ->assertJsonPath('data.0.file_size_bytes', 13_100_000)
            ->assertJsonPath('data.0.job.id', $job->id)
            ->assertJsonPath('data.0.job.user.name', 'Clip Owner')
            ->assertJsonPath('data.0.job.project.title', 'Owner project');

        // The dashboard count and the list agree on the same clips.
        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(200)
            ->assertJsonPath('clips.total', 1)
            ->assertJsonPath('clips.ready', 1);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/admin/clips')
            ->assertStatus(403);
    }

    public function test_storage_total_is_clips_plus_sources_and_agrees_everywhere(): void
    {
        // Regression (audit 2026-11-24): the user dashboard said
        // 42.9 MB while Usage and the admin dashboard said 15.6 MB —
        // three different definitions. One canonical total (rendered
        // clips + source files) must be reported by all three.
        Storage::fake('local');
        $admin = User::factory()->admin()->create();
        $user = User::factory()->create();
        $project = $user->projects()->create(['title' => 'Storage project']);
        $job = $user->processingJobs()->create([
            'project_id' => $project->id,
            'state' => ProcessingJob::STATE_COMPLETED,
            'stage' => 'ready',
            'progress' => 100,
            'settings' => ['platform' => 'tiktok'],
            'source_type' => 'upload',
            'source_path' => 'uploads/test-source.mp4',
        ]);
        Storage::disk('local')->put('uploads/test-source.mp4', str_repeat('0', 1_500_000));
        foreach ([13_100_000, 10_100_000] as $i => $size) {
            Clip::create([
                'project_id' => $project->id,
                'job_id' => $job->id,
                'title' => 'Clip '.($i + 1),
                'status' => Clip::STATUS_READY,
                'start_seconds' => 0.0,
                'end_seconds' => 32.0,
                'duration_seconds' => 32.0,
                'aspect_ratio' => '9:16',
                'file_size_bytes' => $size,
                'score' => 0.7,
            ]);
        }
        $expected = 13_100_000 + 10_100_000 + 1_500_000;

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/stats')
            ->assertStatus(200)
            ->assertJsonPath('clips_total', 2)
            ->assertJsonPath('storage_bytes', $expected);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertStatus(200)
            ->assertJsonPath('storage.app_bytes', $expected);
    }
}
