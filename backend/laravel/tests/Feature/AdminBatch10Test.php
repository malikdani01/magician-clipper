<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

/**
 * Batch 10 (2026-11-25): the full Admin Panel — user management,
 * platform controls (limits, feature + page toggles, maintenance,
 * announcement) and system pages (monitor, logs, broadcast,
 * reports). Every enforcement is server-side and is tested here
 * through the real HTTP endpoints.
 */
class AdminBatch10Test extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        return User::factory()->admin()->create(['name' => 'Admin']);
    }

    /**
     * Log in through the real endpoint. actingAs() switches the
     * default guard to sanctum for the rest of the test, and the
     * sanctum guard has no attempt() — so the web guard must be
     * restored first.
     */
    private function loginAs(string $email, string $password = 'password')
    {
        \Illuminate\Support\Facades\Auth::shouldUse('web');

        return $this->postJson('/api/v1/auth/login', [
            'email' => $email, 'password' => $password,
        ]);
    }

    private function makeUser(array $attrs = []): User
    {
        return User::factory()->create($attrs);
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'captions_enabled' => true,
            'captions_language' => 'english',
            'caption_style' => 'punchy',
            'on_screen_text' => false,
            'job_type' => 'myself',
            'layout' => 'center_crop',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides);
    }

    private function makeProject(User $user, array $attrs = []): Project
    {
        return Project::create(array_merge([
            'user_id' => $user->id,
            'title' => 'Test project',
            'status' => Project::STATUS_DRAFT,
            'content_type' => 'general',
        ], $attrs));
    }

    private function makeJob(User $user, array $attrs = []): ProcessingJob
    {
        $project = $attrs['project'] ?? $this->makeProject($user);
        unset($attrs['project']);

        return ProcessingJob::create(array_merge([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_QUEUED,
            'stage' => 'Queued',
            'progress' => 0,
            'settings' => ['platform' => 'tiktok'],
            'source_type' => 'link',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $attrs));
    }

    private function makeClip(ProcessingJob $job, array $attrs = []): Clip
    {
        return Clip::create(array_merge([
            'project_id' => $job->project_id,
            'job_id' => $job->id,
            'title' => 'Test clip',
            'status' => Clip::STATUS_READY,
            'start_seconds' => 0,
            'end_seconds' => 20,
            'duration_seconds' => 20,
            'output_path' => 'clips/test-'.$job->id.'.mp4',
            'file_size_bytes' => 12345,
        ], $attrs));
    }

    /** Save platform settings as the admin (returns the response). */
    private function setPlatform(User $admin, array $patch)
    {
        return $this->actingAs($admin, 'sanctum')
            ->patchJson('/api/v1/admin/platform-settings', $patch);
    }

    // --- Phase 1: users -------------------------------------------------

    public function test_admin_users_list_searches_sorts_and_paginates(): void
    {
        $admin = $this->admin();
        $this->makeUser(['name' => 'Zara Searchable', 'email' => 'zara@example.com']);
        $this->makeUser(['name' => 'Ali Plain', 'email' => 'ali@example.com']);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/users?search=zara')
            ->assertOk()
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.email', 'zara@example.com');

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/users?sort=name&dir=asc')
            ->assertOk()
            ->assertJsonPath('data.0.name', 'Admin');
    }

    public function test_non_admin_cannot_list_users(): void
    {
        $this->actingAs($this->makeUser(), 'sanctum')
            ->getJson('/api/v1/admin/users')
            ->assertForbidden();
    }

    public function test_admin_user_detail_shows_counts_jobs_and_settings(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user);
        $this->makeClip($job);

        $this->actingAs($admin, 'sanctum')
            ->getJson("/api/v1/admin/users/{$user->id}")
            ->assertOk()
            ->assertJsonPath('counts.projects', 1)
            ->assertJsonPath('counts.jobs', 1)
            ->assertJsonPath('counts.clips', 1)
            ->assertJsonPath('jobs.0.id', $job->id);
    }

    public function test_admin_can_change_a_users_role(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$user->id}/role", ['role' => 'admin'])
            ->assertOk()
            ->assertJsonPath('user.role', 'admin');

        $this->assertSame('admin', $user->fresh()->role);
    }

    public function test_admin_cannot_demote_themselves(): void
    {
        $admin = $this->admin();
        $other = $this->makeUser();
        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$other->id}/role", ['role' => 'admin'])
            ->assertOk();

        // Self-demotion is refused even with two admins.
        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$admin->id}/role", ['role' => 'user'])
            ->assertStatus(422);

        // Demoting the other admin works while one admin remains.
        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$other->id}/role", ['role' => 'user'])
            ->assertOk();

        // Note: the last-admin guard itself is defence-in-depth — it
        // can only trigger when the caller is not the target, which
        // cannot happen while exactly one admin exists (the only
        // admin IS the target, and the self-guard fires first).
        $this->assertSame(1, User::where('role', 'admin')->count());
    }

    public function test_suspended_user_cannot_log_in_or_create_jobs(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/suspend")
            ->assertOk()
            ->assertJsonPath('user.suspended_at', fn ($v) => $v !== null);

        $this->loginAs($user->email)->assertStatus(403)
            ->assertJsonPath('error', 'account_suspended');

        // actingAs reuses the in-memory model — refresh it so the
        // suspension set by the admin endpoint is visible.
        $user->refresh();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(403)
            ->assertJsonPath('error', 'account_suspended');

        // Activating restores both.
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/activate")
            ->assertOk();

        $this->loginAs($user->email)->assertOk();

        $user->refresh();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201);
    }

    public function test_admin_cannot_suspend_self(): void
    {
        $admin = $this->admin();

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$admin->id}/suspend")
            ->assertStatus(422);

        // Suspending another admin works while one admin remains.
        $other = $this->makeUser();
        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$other->id}/role", ['role' => 'admin'])
            ->assertOk();
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$other->id}/suspend")
            ->assertOk();

        // And a suspended admin cannot log in either.
        $this->loginAs($other->email)->assertStatus(403)
            ->assertJsonPath('error', 'account_suspended');
    }

    public function test_admin_can_delete_a_user_with_exact_counts(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user);
        $this->makeClip($job);

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/users/{$user->id}")
            ->assertOk()
            ->assertJsonPath('deleted.projects', 1)
            ->assertJsonPath('deleted.jobs', 1)
            ->assertJsonPath('deleted.clips', 1);

        $this->assertDatabaseMissing('users', ['id' => $user->id]);
        $this->assertDatabaseMissing('processing_jobs', ['id' => $job->id]);
        $this->assertDatabaseMissing('projects', ['user_id' => $user->id]);
    }

    public function test_admin_cannot_delete_themselves(): void
    {
        $admin = $this->admin();

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/users/{$admin->id}")
            ->assertStatus(422);
    }

    public function test_admin_password_reset_returns_a_working_one_time_password(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $response = $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/reset-password")
            ->assertOk();

        $temporary = $response->json('temporary_password');
        $this->assertIsString($temporary);
        $this->assertSame(12, mb_strlen($temporary));

        $this->loginAs($user->email, $temporary)->assertOk();

        $this->loginAs($user->email, 'password')->assertStatus(422);
    }

    public function test_per_user_daily_limit_override_is_enforced(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$user->id}/overrides", ['daily_limit_override' => 1])
            ->assertOk()
            ->assertJsonPath('user.daily_limit_override', 1);

        $user->refresh();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(429)
            ->assertJsonPath('error', 'daily_limit_reached')
            ->assertJsonPath('limit', 1)
            ->assertJsonPath('used_today', 1);
    }

    public function test_per_user_max_clips_override_is_enforced(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$user->id}/overrides", ['max_clips_override' => 2])
            ->assertOk();

        $user->refresh();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 3]))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['clip_count']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 2]))
            ->assertStatus(201);
    }

    // --- Phase 1: jobs / clips / projects ------------------------------

    public function test_admin_jobs_list_filters_by_state_user_and_search(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $failed = $this->makeJob($user, ['state' => ProcessingJob::STATE_FAILED]);
        $queued = $this->makeJob($user);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/jobs?state=failed')
            ->assertOk()
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.id', $failed->id);

        $this->actingAs($admin, 'sanctum')
            ->getJson("/api/v1/admin/jobs?user_id={$user->id}")
            ->assertOk()
            ->assertJsonPath('total', 2);

        $this->actingAs($admin, 'sanctum')
            ->getJson("/api/v1/admin/jobs?search={$queued->id}")
            ->assertOk()
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.id', $queued->id);
    }

    public function test_admin_can_cancel_a_processing_job_but_not_a_terminal_one(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user, ['state' => ProcessingJob::STATE_RENDERING]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/jobs/{$job->id}/cancel")
            ->assertOk()
            ->assertJsonPath('job.state', ProcessingJob::STATE_CANCELLING);

        $done = $this->makeJob($user, ['state' => ProcessingJob::STATE_COMPLETED]);
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/jobs/{$done->id}/cancel")
            ->assertStatus(422);
    }

    public function test_admin_can_retry_a_failed_job_but_not_a_queued_one(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $failed = $this->makeJob($user, [
            'state' => ProcessingJob::STATE_FAILED,
            'error_code' => 'render_failed',
            'error_message' => 'ffmpeg exited with code 1',
        ]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/jobs/{$failed->id}/retry")
            ->assertOk()
            ->assertJsonPath('job.state', ProcessingJob::STATE_QUEUED);

        $queued = $this->makeJob($user);
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/jobs/{$queued->id}/retry")
            ->assertStatus(422);
    }

    public function test_admin_failed_jobs_list_shows_the_exact_error(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $failed = $this->makeJob($user, [
            'state' => ProcessingJob::STATE_FAILED,
            'error_code' => 'render_failed',
            'error_message' => 'ffmpeg exited with code 1',
        ]);
        $this->makeJob($user);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/jobs/failed')
            ->assertOk()
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.id', $failed->id)
            ->assertJsonPath('data.0.error_code', 'render_failed')
            ->assertJsonPath('data.0.error_message', 'ffmpeg exited with code 1');
    }

    public function test_admin_can_delete_a_job_and_its_clips(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user);
        $clip = $this->makeClip($job);
        $this->makeClip($job, ['title' => 'Second clip']);

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/jobs/{$job->id}")
            ->assertOk()
            ->assertJsonPath('deleted.clips', 2);

        $this->assertDatabaseMissing('processing_jobs', ['id' => $job->id]);
        $this->assertDatabaseMissing('clips', ['id' => $clip->id]);
    }

    public function test_admin_clips_list_searches_and_deletes(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user);
        $clip = $this->makeClip($job, ['title' => 'Needle clip']);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/clips?search=Needle')
            ->assertOk()
            ->assertJsonPath('total', 1)
            ->assertJsonPath('data.0.id', $clip->id);

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/clips/{$clip->id}")
            ->assertOk();

        $this->assertDatabaseMissing('clips', ['id' => $clip->id]);
    }

    public function test_admin_can_delete_a_project_with_exact_counts(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $project = $this->makeProject($user);
        $job = $this->makeJob($user, ['project' => $project]);
        $this->makeClip($job);

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/projects/{$project->id}")
            ->assertOk()
            ->assertJsonPath('deleted.jobs', 1)
            ->assertJsonPath('deleted.clips', 1);

        $this->assertDatabaseMissing('projects', ['id' => $project->id]);
        $this->assertDatabaseMissing('processing_jobs', ['id' => $job->id]);
    }

    public function test_every_admin_action_is_written_to_the_activity_log(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$user->id}/role", ['role' => 'admin'])
            ->assertOk();
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/suspend")
            ->assertOk();

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/activity-log')
            ->assertOk()
            ->assertJsonPath('total', 2)
            ->assertJsonFragment(['action' => 'user.role_changed'])
            ->assertJsonFragment(['action' => 'user.suspended']);
    }

    // --- Phase 2: platform controls -------------------------------------

    public function test_platform_settings_default_to_pre_batch10_behaviour(): void
    {
        $admin = $this->admin();

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/platform-settings')
            ->assertOk()
            ->assertJsonPath('limits.free_daily_limit', 10)
            ->assertJsonPath('limits.max_clips_per_job', 50)
            ->assertJsonPath('limits.max_bulk_files', 5)
            ->assertJsonPath('limits.max_upload_mb', 2048)
            ->assertJsonPath('features.captions', true)
            ->assertJsonPath('features.bulk_jobs', true)
            ->assertJsonPath('pages.library', true)
            ->assertJsonPath('maintenance.enabled', false)
            ->assertJsonPath('announcement', '');
    }

    public function test_non_admin_cannot_read_or_write_platform_settings(): void
    {
        $user = $this->makeUser();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/admin/platform-settings')
            ->assertForbidden();
        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/admin/platform-settings', ['limits' => ['free_daily_limit' => 1]])
            ->assertForbidden();
    }

    public function test_public_platform_view_includes_daily_usage(): void
    {
        $user = $this->makeUser();
        $this->makeJob($user);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/platform')
            ->assertOk()
            ->assertJsonPath('limits.free_daily_limit', 10)
            ->assertJsonPath('features.captions', true)
            ->assertJsonPath('daily.limit', 10)
            ->assertJsonPath('daily.used_today', 1)
            ->assertJsonPath('daily.remaining', 9);

        // Admins are exempt from the daily limit (null = unlimited).
        $this->actingAs($this->admin(), 'sanctum')
            ->getJson('/api/v1/platform')
            ->assertOk()
            ->assertJsonPath('daily.limit', null)
            ->assertJsonPath('daily.remaining', null);
    }

    public function test_platform_view_requires_authentication(): void
    {
        $this->getJson('/api/v1/platform')->assertUnauthorized();
    }

    public function test_free_daily_limit_is_enforced_and_reported(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['limits' => ['free_daily_limit' => 1]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(429)
            ->assertJsonPath('error', 'daily_limit_reached')
            ->assertJsonPath('limit', 1)
            ->assertJsonPath('used_today', 1);

        // The limit change is visible in the public view.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/platform')
            ->assertOk()
            ->assertJsonPath('daily.limit', 1)
            ->assertJsonPath('daily.remaining', 0);
    }

    public function test_max_clips_per_job_comes_from_platform_settings(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['limits' => ['max_clips_per_job' => 2]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 3]))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['clip_count']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 2]))
            ->assertStatus(201);
    }

    public function test_max_upload_mb_comes_from_platform_settings(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['limits' => ['max_upload_mb' => 1]])->assertOk();

        $file = UploadedFile::fake()->create('video.mp4', 2048, 'video/mp4');
        $payload = $this->payload();
        unset($payload['source_url']);
        $payload['file'] = $file;

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $payload)
            ->assertStatus(422)
            ->assertJsonValidationErrors(['file']);
    }

    public function test_max_bulk_files_comes_from_platform_settings(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['limits' => ['max_bulk_files' => 1]])->assertOk();

        $payload = $this->payload();
        unset($payload['source_url']);
        $payload['files'] = [
            UploadedFile::fake()->create('a.mp4', 100, 'video/mp4'),
            UploadedFile::fake()->create('b.mp4', 100, 'video/mp4'),
        ];

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $payload)
            ->assertStatus(422)
            ->assertJsonValidationErrors(['files']);
    }

    public function test_disabled_captions_reject_job_creation_but_off_is_fine(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['features' => ['captions' => false]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(422)
            ->assertJsonPath('error', 'feature_disabled')
            ->assertJsonPath('feature', 'captions');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'captions_enabled' => false, 'caption_style' => null,
            ]))
            ->assertStatus(201);
    }

    public function test_each_disabled_feature_rejects_its_setting(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $cases = [
            ['on_screen_text', ['on_screen_text' => true]],
            ['beat_sync', ['beat_sync' => true]],
            ['translation', ['caption_translation' => 'ur']],
            ['translation', ['ost_language' => 'ur']],
            ['logo_overlay', ['logo_overlay' => true]],
            ['music_bed_sfx', ['sfx' => 'whoosh']],
        ];

        foreach ($cases as [$feature, $override]) {
            $this->setPlatform($admin, ['features' => [$feature => false]])->assertOk();
            $this->actingAs($user, 'sanctum')
                ->postJson('/api/v1/jobs', $this->payload($override))
                ->assertStatus(422)
                ->assertJsonPath('error', 'feature_disabled')
                ->assertJsonPath('feature', $feature);
            $this->setPlatform($admin, ['features' => [$feature => true]])->assertOk();
        }
    }

    public function test_disabled_bulk_jobs_reject_bulk_creation(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['features' => ['bulk_jobs' => false]])->assertOk();

        $payload = $this->payload();
        unset($payload['source_url']);
        $payload['files'] = [UploadedFile::fake()->create('a.mp4', 100, 'video/mp4')];

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $payload)
            ->assertStatus(422)
            ->assertJsonPath('error', 'feature_disabled')
            ->assertJsonPath('feature', 'bulk_jobs');
    }

    public function test_disabled_features_reject_clips_brand_assets_and_cloud(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $job = $this->makeJob($user);
        $clip = $this->makeClip($job);

        $this->setPlatform($admin, ['features' => [
            'clip_rerender' => false, 'favourites' => false, 'thumbnail_picker' => false,
            'logo_overlay' => false, 'intro_outro' => false, 'cloud_storage' => false,
        ]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/render", ['caption_style' => 'word_pop'])
            ->assertStatus(422)->assertJsonPath('feature', 'clip_rerender');
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/variants", ['caption_style' => 'word_pop'])
            ->assertStatus(422)->assertJsonPath('feature', 'clip_rerender');
        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/favourite")
            ->assertStatus(422)->assertJsonPath('feature', 'favourites');
        $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/clips/{$clip->id}/thumbnail", ['candidate_index' => 0])
            ->assertStatus(422)->assertJsonPath('feature', 'thumbnail_picker');

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/brand-kit/assets', [
                'kind' => 'logo',
                'file' => UploadedFile::fake()->image('logo.png'),
            ])
            ->assertStatus(422)->assertJsonPath('feature', 'logo_overlay');
        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/brand-kit/assets', [
                'kind' => 'intro',
                'file' => UploadedFile::fake()->create('intro.mp4', 100, 'video/mp4'),
            ])
            ->assertStatus(422)->assertJsonPath('feature', 'intro_outro');

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', [
                'provider' => 'r2', 'endpoint' => 'https://example.r2.dev',
                'bucket' => 'clips', 'region' => 'auto',
                'access_key_id' => 'key', 'secret_access_key' => 'secret',
            ])
            ->assertStatus(422)->assertJsonPath('feature', 'cloud_storage');
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/cloud-storage/test')
            ->assertStatus(422)->assertJsonPath('feature', 'cloud_storage');
    }

    public function test_disabled_feature_blocks_presets_too(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['features' => ['captions' => false]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Caption preset',
                'settings' => [
                    'platform' => 'tiktok', 'aspect_ratio' => '9:16',
                    'clip_count' => 3, 'duration_mode' => 'exact',
                    'duration_seconds' => 30, 'captions_enabled' => true,
                ],
            ])
            ->assertStatus(422)
            ->assertJsonPath('feature', 'captions');
    }

    public function test_maintenance_mode_blocks_creation_with_the_message_but_not_reads(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['maintenance' => [
            'enabled' => true, 'message' => 'Down for upgrades — back soon.',
        ]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(503)
            ->assertJsonPath('error', 'maintenance_mode')
            ->assertJsonPath('message', 'Down for upgrades — back soon.');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/jobs')
            ->assertOk();

        $this->setPlatform($admin, ['maintenance' => ['enabled' => false]])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201);
    }

    public function test_announcement_is_visible_in_the_public_view(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();

        $this->setPlatform($admin, ['announcement' => 'New: 1080p exports are live!'])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/platform')
            ->assertOk()
            ->assertJsonPath('announcement', 'New: 1080p exports are live!');

        $this->setPlatform($admin, ['announcement' => ''])->assertOk();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/platform')
            ->assertOk()
            ->assertJsonPath('announcement', '');
    }

    public function test_platform_settings_update_is_logged(): void
    {
        $admin = $this->admin();

        $this->setPlatform($admin, ['limits' => ['free_daily_limit' => 5]])->assertOk();

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/activity-log')
            ->assertOk()
            ->assertJsonFragment(['action' => 'platform.settings_updated']);
    }

    // --- Phase 3: system & communication ------------------------------

    public function test_broadcast_reaches_every_users_bell(): void
    {
        $admin = $this->admin();
        $userA = $this->makeUser();
        $userB = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/notifications/broadcast', [
                'title' => 'Heads up', 'message' => 'Maintenance tonight.', 'target' => 'all',
            ])
            ->assertOk()
            ->assertJsonPath('recipients', 3);

        foreach ([$userA, $userB, $admin] as $user) {
            $this->actingAs($user, 'sanctum')
                ->getJson('/api/v1/notifications')
                ->assertOk()
                ->assertJsonFragment(['title' => 'Heads up', 'body' => 'Maintenance tonight.']);
        }
    }

    public function test_broadcast_to_one_user_reaches_only_them(): void
    {
        $admin = $this->admin();
        $userA = $this->makeUser();
        $userB = $this->makeUser();

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/notifications/broadcast', [
                'title' => 'Just you', 'message' => 'Private note.',
                'target' => 'user', 'user_id' => $userA->id,
            ])
            ->assertOk()
            ->assertJsonPath('recipients', 1);

        $this->actingAs($userA, 'sanctum')
            ->getJson('/api/v1/notifications')
            ->assertOk()
            ->assertJsonFragment(['title' => 'Just you']);

        $this->actingAs($userB, 'sanctum')
            ->getJson('/api/v1/notifications')
            ->assertOk()
            ->assertJsonMissing(['title' => 'Just you']);
    }

    public function test_broadcast_validates_its_input(): void
    {
        $admin = $this->admin();

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/notifications/broadcast', [
                'title' => 'No message', 'target' => 'all',
            ])
            ->assertStatus(422);

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/notifications/broadcast', [
                'title' => 'No user', 'message' => 'x', 'target' => 'user',
            ])
            ->assertStatus(422);
    }

    public function test_reports_show_real_daily_aggregates_and_top_users(): void
    {
        $admin = $this->admin();
        $userA = $this->makeUser();
        $userB = $this->makeUser();

        $jobA = $this->makeJob($userA);
        $this->makeClip($jobA);
        $this->makeClip($jobA, ['title' => 'A2']);
        $this->makeClip($jobA, ['title' => 'A3']);
        $jobB = $this->makeJob($userB);
        $this->makeClip($jobB);

        $today = now()->toDateString();

        $response = $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/reports')
            ->assertOk();

        $daily = collect($response->json('daily'))->firstWhere('date', $today);
        $this->assertSame(2, $daily['jobs']);
        $this->assertSame(4, $daily['clips']);

        $top = $response->json('top_users');
        $this->assertSame($userA->id, $top[0]['id']);
        $this->assertSame(3, (int) $top[0]['clips_count']);
        $this->assertSame($userB->id, $top[1]['id']);
        $this->assertSame(1, (int) $top[1]['clips_count']);

        $this->assertSame(2, $response->json('totals.jobs'));
        $this->assertSame(4, $response->json('totals.clips'));
    }

    public function test_monitor_reports_real_system_facts(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $this->makeJob($user, ['state' => ProcessingJob::STATE_FAILED]);
        $this->makeJob($user);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/monitor')
            ->assertOk()
            ->assertJsonPath('worker.last_report_at', null)
            ->assertJsonPath('queue.queued_jobs', 1)
            ->assertJsonPath('queue.failed_jobs', 1)
            ->assertJsonPath('database.ok', true)
            ->assertJsonPath('totals.users', 2)
            ->assertJsonPath('totals.jobs', 2)
            ->assertJsonStructure([
                'database' => ['size_bytes'],
                'disk' => ['total_bytes', 'free_bytes', 'app_files_bytes'],
            ]);
    }

    public function test_dashboard_counts_are_real(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $this->makeJob($user);
        $this->makeJob($user, ['state' => ProcessingJob::STATE_FAILED]);

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/dashboard')
            ->assertOk()
            ->assertJsonPath('users.total', 2)
            ->assertJsonPath('jobs.total', 2)
            ->assertJsonPath('jobs.failed', 1)
            ->assertJsonPath('nav_counts.failed_jobs', 1);
    }
}
