<?php

namespace Tests\Feature;

use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ProjectStatusBackfillTest extends TestCase
{
    use RefreshDatabase;
    private function staleProject(User $user, string $state): Project
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'stale project',
            'status' => Project::STATUS_PROCESSING,
        ]);
        ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => $state,
        ]);

        return $project;
    }

    public function test_backfill_flips_a_completed_jobs_stale_project_to_ready(): void
    {
        $user = User::factory()->create();
        $project = $this->staleProject($user, ProcessingJob::STATE_COMPLETED);

        $this->assertSame(1, Project::backfillFinishedStatuses());
        $this->assertDatabaseHas('projects', ['id' => $project->id, 'status' => 'ready']);
    }

    public function test_backfill_flips_a_failed_jobs_stale_project_to_failed(): void
    {
        $user = User::factory()->create();
        $project = $this->staleProject($user, ProcessingJob::STATE_FAILED);

        $this->assertSame(1, Project::backfillFinishedStatuses());
        $this->assertDatabaseHas('projects', ['id' => $project->id, 'status' => 'failed']);
    }

    public function test_backfill_leaves_a_project_with_an_open_job_alone(): void
    {
        $user = User::factory()->create();
        $project = $this->staleProject($user, ProcessingJob::STATE_RENDERING);

        $this->assertSame(0, Project::backfillFinishedStatuses());
        $this->assertDatabaseHas('projects', ['id' => $project->id, 'status' => 'processing']);
    }

    public function test_backfill_leaves_a_project_with_no_jobs_alone(): void
    {
        $user = User::factory()->create();
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'empty project',
            'status' => Project::STATUS_PROCESSING,
        ]);

        $this->assertSame(0, Project::backfillFinishedStatuses());
        $this->assertDatabaseHas('projects', ['id' => $project->id, 'status' => 'processing']);
    }

    public function test_backfill_uses_the_latest_job_when_earlier_ones_differ(): void
    {
        $user = User::factory()->create();
        $project = $this->staleProject($user, ProcessingJob::STATE_FAILED);
        ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
        ]);

        $this->assertSame(1, Project::backfillFinishedStatuses());
        $this->assertDatabaseHas('projects', ['id' => $project->id, 'status' => 'ready']);
    }
}
