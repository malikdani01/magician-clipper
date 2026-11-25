<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\Plan;
use App\Models\PlanRequest;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use App\Models\UserPlan;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Batch 11 (2026-11-25): plans (manual admin activation, no payment
 * gateway), Google sign-in's honest not-configured state, export
 * tiers, and the queue position + ETA. Every enforcement is
 * server-side and is tested here through the real HTTP endpoints.
 */
class Batch11Test extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        return User::factory()->admin()->create(['name' => 'Admin']);
    }

    private function makeUser(array $attrs = []): User
    {
        return User::factory()->create($attrs);
    }

    private function makePlan(array $attrs = []): Plan
    {
        return Plan::create(array_merge([
            'name' => 'Pro',
            'price_display' => 'Rs 499',
            'duration_days' => 30,
            'total_clips' => 100,
            'daily_clips' => 20,
            'max_export_quality' => '1080p',
            'features' => ['1080p export', '100 clips'],
            'active' => true,
        ], $attrs));
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 2,
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
            'settings' => [
                'platform' => 'tiktok',
                'aspect_ratio' => '9:16',
                'clip_count' => 2,
                'export_ratios' => ['9:16'],
            ],
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

    // --- Plans: admin CRUD ---------------------------------------------

    public function test_admin_creates_lists_updates_and_deletes_a_plan(): void
    {
        $admin = $this->admin();

        $created = $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/plans', [
                'name' => 'Starter',
                'price_display' => 'Rs 199',
                'duration_days' => 30,
                'total_clips' => 30,
                'daily_clips' => 5,
                'max_export_quality' => '720p',
                'features' => ['30 clips'],
            ])
            ->assertCreated()
            ->assertJsonPath('plan.name', 'Starter');
        $id = $created->json('plan.id');

        $this->actingAs($admin, 'sanctum')
            ->getJson('/api/v1/admin/plans')
            ->assertOk()
            ->assertJsonPath('plans.0.name', 'Starter')
            ->assertJsonPath('plans.0.active_users', 0);

        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/plans/{$id}", [
                'name' => 'Starter',
                'price_display' => 'Rs 249',
                'duration_days' => 30,
            ])
            ->assertOk()
            ->assertJsonPath('plan.price_display', 'Rs 249');

        // A plan nobody bought deletes cleanly.
        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/plans/{$id}")
            ->assertOk()
            ->assertJsonPath('deleted', true);
        $this->assertDatabaseMissing('plans', ['id' => $id]);
    }

    public function test_plan_validation_rejects_bad_tier_and_duration(): void
    {
        $admin = $this->admin();

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/admin/plans', [
                'name' => 'Bad',
                'price_display' => 'Rs 1',
                'duration_days' => 0,
                'max_export_quality' => '4k',
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['duration_days', 'max_export_quality']);
    }

    public function test_non_admin_cannot_manage_plans(): void
    {
        $this->actingAs($this->makeUser(), 'sanctum')
            ->postJson('/api/v1/admin/plans', [
                'name' => 'Nope',
                'price_display' => 'Rs 1',
                'duration_days' => 30,
            ])
            ->assertForbidden();
    }

    public function test_plan_with_purchase_history_cannot_be_deleted(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan();

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();

        $this->actingAs($admin, 'sanctum')
            ->deleteJson("/api/v1/admin/plans/{$plan->id}")
            ->assertStatus(422)
            ->assertJsonPath('error', 'invalid_state');
        $this->assertDatabaseHas('plans', ['id' => $plan->id]);
    }

    // --- Plans: request → approve → live limits ------------------------

    public function test_request_approve_gives_plan_limits_immediately(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan(['daily_clips' => 20, 'max_export_quality' => '1080p']);

        $request = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/plan-requests', ['plan_id' => $plan->id, 'note' => 'Paid via JazzCash'])
            ->assertCreated()
            ->assertJsonPath('request.status', 'pending');
        $requestId = $request->json('request.id');

        // A second pending request for the same plan is refused.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/plan-requests', ['plan_id' => $plan->id])
            ->assertStatus(422);

        $approved = $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/plan-requests/{$requestId}/approve")
            ->assertOk();
        $this->assertSame('active', $approved->json('user_plan.status'));
        $this->assertSame(0, $approved->json('user_plan.clips_used'));

        // The plan is live immediately: /me/plan names it, and the
        // export cap is 1080 (not the Free 720).
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('current.name', 'Pro')
            ->assertJsonPath('limits.max_export_height', 1080)
            ->assertJsonPath('limits.daily_limit_source', 'plan');

        // Approving the same request twice is refused.
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/plan-requests/{$requestId}/approve")
            ->assertStatus(422);
    }

    public function test_decline_requires_a_reason_and_user_sees_it(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan();

        $requestId = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/plan-requests', ['plan_id' => $plan->id])
            ->assertCreated()->json('request.id');

        // No reason = 422.
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/plan-requests/{$requestId}/decline", [])
            ->assertStatus(422);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/plan-requests/{$requestId}/decline", [
                'reason' => 'Payment not received yet.',
            ])
            ->assertOk()
            ->assertJsonPath('request.status', 'declined');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/plan-requests')
            ->assertOk()
            ->assertJsonPath('requests.0.status', 'declined')
            ->assertJsonPath('requests.0.decline_reason', 'Payment not received yet.');
    }

    public function test_requesting_an_inactive_plan_is_refused(): void
    {
        $user = $this->makeUser();
        $plan = $this->makePlan(['active' => false]);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/plan-requests', ['plan_id' => $plan->id])
            ->assertStatus(422);
    }

    public function test_assign_with_custom_end_date_and_revoke(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan();

        $assigned = $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", [
                'plan_id' => $plan->id,
                'ends_at' => now()->addDays(7)->toIso8601String(),
            ])
            ->assertCreated();
        $userPlanId = $assigned->json('user_plan.id');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('current.name', 'Pro');

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/user-plans/{$userPlanId}/revoke")
            ->assertOk()
            ->assertJsonPath('user_plan.status', 'revoked');

        // Revoked = Free again, immediately.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('current.name', 'Free')
            ->assertJsonPath('limits.max_export_height', 720);
    }

    public function test_assigning_a_second_plan_supersedes_the_first(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $planA = $this->makePlan(['name' => 'Plan A']);
        $planB = $this->makePlan(['name' => 'Plan B']);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $planA->id])
            ->assertCreated();
        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $planB->id])
            ->assertCreated();

        $this->assertSame(1, UserPlan::where('user_id', $user->id)
            ->where('status', UserPlan::STATUS_ACTIVE)->count());
        $this->assertSame('Plan B', UserPlan::where('user_id', $user->id)
            ->where('status', UserPlan::STATUS_ACTIVE)->first()->plan->name);
        $this->assertSame(1, UserPlan::where('user_id', $user->id)
            ->where('status', UserPlan::STATUS_REVOKED)->count());
    }

    // --- Enforcement: daily limit, total clips, export tier -----------

    public function test_plan_daily_limit_is_enforced_on_job_creation(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan(['daily_clips' => 1, 'total_clips' => null]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertCreated();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(429)
            ->assertJsonPath('error', 'daily_limit_reached')
            ->assertJsonPath('limit', 1);
    }

    public function test_per_user_override_beats_the_plan_daily_limit(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan(['daily_clips' => 1, 'total_clips' => null]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();
        // Override 2 > plan 1: the second job must succeed.
        $this->actingAs($admin, 'sanctum')
            ->patchJson("/api/v1/admin/users/{$user->id}/overrides", ['daily_limit_override' => 2])
            ->assertOk();
        // actingAs() reuses this in-memory user across requests, so
        // refresh it — in production every request loads the user
        // fresh from the DB and sees the override immediately.
        $user->refresh();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertCreated();
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertCreated();
        // And the third still fails — the override is 2, not infinite.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(429)
            ->assertJsonPath('limit', 2);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('limits.daily_limit_source', 'override');
    }

    public function test_plan_total_clips_counts_in_flight_jobs(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        // 3 clips total, 2 per job: the first job reserves 2, the
        // second would need 2 more — refused even though nothing
        // has rendered yet (the reservation is what makes it honest).
        $plan = $this->makePlan(['total_clips' => 3, 'daily_clips' => null]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 2]))
            ->assertCreated();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 2]))
            ->assertStatus(429)
            ->assertJsonPath('error', 'plan_clips_exhausted')
            ->assertJsonPath('clips_remaining', 1);

        // A 1-clip job still fits in the remaining 1.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['clip_count' => 1]))
            ->assertCreated();
    }

    public function test_free_user_cannot_request_1080p_but_plan_user_can(): void
    {
        $admin = $this->admin();
        $freeUser = $this->makeUser();
        $planUser = $this->makeUser();
        $plan = $this->makePlan(['max_export_quality' => '1080p']);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$planUser->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();

        // Free: 1080p is locked, with the upgrade hint.
        $this->actingAs($freeUser, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['export_quality' => '1080p']))
            ->assertStatus(422)
            ->assertJsonPath('error', 'export_tier_locked')
            ->assertJsonPath('max_export_height', 720);

        // Free without asking renders at the 720 cap.
        $freeJob = $this->actingAs($freeUser, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertCreated();
        $this->assertSame(720, $freeJob->json('job.settings.max_export_height'));
        $this->assertSame('720p', $freeJob->json('job.settings.export_quality'));

        // Plan user: 1080p works and the stored cap is 1080.
        $planJob = $this->actingAs($planUser, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['export_quality' => '1080p']))
            ->assertCreated();
        $this->assertSame(1080, $planJob->json('job.settings.max_export_height'));
        $this->assertSame('1080p', $planJob->json('job.settings.export_quality'));
    }

    public function test_rendered_clips_count_against_the_plan_total(): void
    {
        $admin = $this->admin();
        $user = $this->makeUser();
        $plan = $this->makePlan(['total_clips' => 5, 'daily_clips' => null]);

        $this->actingAs($admin, 'sanctum')
            ->postJson("/api/v1/admin/users/{$user->id}/plans", ['plan_id' => $plan->id])
            ->assertCreated();

        // A processing job with one rendered clip row: clips_used 1.
        $job = $this->makeJob($user, [
            'state' => ProcessingJob::STATE_RENDERING,
            'settings' => ['platform' => 'tiktok', 'aspect_ratio' => '9:16', 'clip_count' => 2],
        ]);
        $this->makeClip($job);

        $this->assertSame(0, UserPlan::where('user_id', $user->id)->first()->clips_used);

        // The worker uploading a clip counts one against the plan.
        \App\Support\PlanService::recordClipRendered($job->fresh());

        $this->assertSame(1, UserPlan::where('user_id', $user->id)->first()->clips_used);
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('current.clips_used', 1);
    }

    // --- Lazy expiry ----------------------------------------------------

    public function test_expired_plan_flips_back_to_free_lazily(): void
    {
        $user = $this->makeUser();
        $plan = $this->makePlan(['daily_clips' => 50, 'max_export_quality' => '1080p']);

        // A plan that ended yesterday — still 'active' in the DB.
        UserPlan::create([
            'user_id' => $user->id,
            'plan_id' => $plan->id,
            'starts_at' => now()->subDays(31),
            'ends_at' => now()->subDay(),
            'clips_used' => 0,
            'status' => UserPlan::STATUS_ACTIVE,
        ]);

        // The first gated read flips it and Free applies immediately.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/me/plan')
            ->assertOk()
            ->assertJsonPath('current.name', 'Free')
            ->assertJsonPath('limits.max_export_height', 720)
            ->assertJsonPath('limits.daily_limit_source', 'free');

        $this->assertSame(
            UserPlan::STATUS_EXPIRED,
            UserPlan::where('user_id', $user->id)->first()->status
        );

        // A 1080p request is now locked again.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['export_quality' => '1080p']))
            ->assertStatus(422)
            ->assertJsonPath('error', 'export_tier_locked');
    }

    // --- Google sign-in: honest not-configured state --------------------

    public function test_google_redirect_is_not_configured_without_keys(): void
    {
        $this->assertFalse(\App\Http\Controllers\Api\V1\GoogleAuthController::configured());

        $this->getJson('/api/v1/auth/google/redirect')
            ->assertStatus(422)
            ->assertJsonPath('error', 'google_not_configured')
            ->assertJsonPath('message', 'Google login abhi configure nahi hai — admin ko Google keys lagani hongi.');
    }

    public function test_google_callback_without_keys_redirects_with_error(): void
    {
        $response = $this->get('/api/v1/auth/google/callback?code=x&state=y');

        $response->assertRedirect();
        $this->assertStringContainsString(
            '/auth/google/callback?error=not_configured',
            $response->headers->get('Location')
        );
    }

    // --- Queue position + ETA -------------------------------------------

    public function test_queued_job_shows_position_and_eta_range(): void
    {
        $user = $this->makeUser();

        // Three completed jobs to learn from: 60s each for 2 clips
        // = 30s per clip on average.
        for ($i = 0; $i < 3; $i++) {
            $done = $this->makeJob($user, [
                'state' => ProcessingJob::STATE_COMPLETED,
                'started_at' => now()->subMinutes(10 + $i),
                'finished_at' => now()->subMinutes(9 + $i),
            ]);
            $this->makeClip($done);
            $this->makeClip($done);
        }

        $first = $this->makeJob($user);
        $second = $this->makeJob($user);

        $response = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$second->id}")
            ->assertOk();

        $queue = $response->json('job.queue');
        $this->assertSame('queued', $queue['status']);
        $this->assertSame(2, $queue['position']);
        $this->assertSame(1, $queue['jobs_ahead']);
        // 2 clips ahead × 30s = 60s → range 30–90.
        $this->assertSame(2, $queue['clips_ahead']);
        $this->assertSame(30, $queue['estimated_wait_seconds_min']);
        $this->assertSame(90, $queue['estimated_wait_seconds_max']);
        $this->assertSame(30.0, (float) $queue['avg_seconds_per_clip']);
        $this->assertSame(3, $queue['sample_jobs']);
        $this->assertStringContainsString('one at a time', $queue['note']);

        // The first job is position 1 with nothing ahead of it.
        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$first->id}")
            ->assertOk()
            ->assertJsonPath('job.queue.position', 1)
            ->assertJsonPath('job.queue.jobs_ahead', 0)
            ->assertJsonPath('job.queue.estimated_wait_seconds_min', 0)
            ->assertJsonPath('job.queue.estimated_wait_seconds_max', 0);
    }

    public function test_queue_estimate_is_absent_without_enough_history(): void
    {
        $user = $this->makeUser();
        $job = $this->makeJob($user);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->assertJsonPath('job.queue.position', 1)
            ->assertJsonPath('job.queue.estimated_wait_seconds_min', null)
            ->assertJsonPath('job.queue.estimated_wait_seconds_max', null)
            ->assertJsonPath('job.queue.sample_jobs', 0);
    }

    public function test_ready_job_has_no_queue_info(): void
    {
        $user = $this->makeUser();
        $job = $this->makeJob($user, ['state' => ProcessingJob::STATE_COMPLETED]);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->assertJsonPath('job.queue', null);
    }

    public function test_processing_job_reports_processing_not_a_position(): void
    {
        $user = $this->makeUser();
        $job = $this->makeJob($user, ['state' => ProcessingJob::STATE_RENDERING]);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->assertJsonPath('job.queue.status', 'processing')
            ->assertJsonPath('job.queue.position', 0);
    }

    // --- Email/password auth still works --------------------------------

    public function test_register_and_login_still_work_with_email_password(): void
    {
        $this->postJson('/api/v1/auth/register', [
            'name' => 'New User',
            'email' => 'new@example.com',
            'password' => 'password123',
            'password_confirmation' => 'password123',
        ])->assertCreated()->assertJsonPath('user.email', 'new@example.com');

        $this->postJson('/api/v1/auth/login', [
            'email' => 'new@example.com',
            'password' => 'password123',
        ])->assertOk()->assertJsonPath('user.email', 'new@example.com');
    }

    public function test_plans_page_lists_only_active_plans(): void
    {
        $user = $this->makeUser();
        $this->makePlan(['name' => 'Live Plan']);
        $this->makePlan(['name' => 'Hidden Plan', 'active' => false]);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/plans')
            ->assertOk()
            ->assertJsonCount(1, 'plans')
            ->assertJsonPath('plans.0.name', 'Live Plan');
    }
}
