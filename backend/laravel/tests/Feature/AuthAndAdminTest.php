<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
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
                'daily', 'usage', 'resources', 'nav_counts',
                'recent_jobs', 'recent_clips',
            ]);
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
}
