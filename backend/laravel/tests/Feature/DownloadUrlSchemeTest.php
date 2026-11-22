<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Diagnostic / regression test for the live download failure
 * (2026-11-23): on the Render-hosted API the download_url must be
 * https (the frontend is https; an http:// URL is blocked by the
 * browser as mixed content and the download fetch throws, which the
 * UI reports as "Backend is not reachable"). Render terminates TLS
 * and forwards plain HTTP to the container, so the URL generator
 * must follow APP_URL's scheme, not the incoming request's scheme.
 */
class DownloadUrlSchemeTest extends TestCase
{
    use RefreshDatabase;

    public function test_download_url_uses_https_when_app_url_is_https(): void
    {
        // Provider boot reads APP_URL, so set it first, then re-run
        // boot (idempotent for the Gate policies it registers).
        config(['app.url' => 'https://clipper.example.com']);
        (new \App\Providers\AppServiceProvider($this->app))->boot();

        $user = User::factory()->create();
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'Test project',
            'content_type' => 'general',
            'status' => Project::STATUS_READY,
        ]);
        $job = ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
            'settings' => ['aspect_ratio' => '9:16'],
        ]);
        Clip::create([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'start_seconds' => 0,
            'end_seconds' => 30,
            'duration_seconds' => 30,
            'status' => Clip::STATUS_READY,
            'output_path' => 'clips/1/x.mp4',
            'file_size_bytes' => 1000,
        ]);

        $url = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertStatus(200)
            ->json('job.clips.0.download_url');

        $this->assertIsString($url);
        // The scheme must be https (the fix); the host comes from the
        // incoming request, which is correct on live — Render forwards
        // Host: magician-clipper.onrender.com — so assert scheme + path.
        $this->assertSame('https', parse_url($url, PHP_URL_SCHEME));
        $this->assertStringContainsString('/api/v1/clips/', $url);
        $this->assertStringEndsWith('/download', $url);
    }

    public function test_download_url_stays_http_when_app_url_is_http(): void
    {
        // Local dev must be unaffected: an http APP_URL keeps http URLs.
        config(['app.url' => 'http://127.0.0.1:8000']);
        (new \App\Providers\AppServiceProvider($this->app))->boot();

        $user = User::factory()->create();
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'Test project',
            'content_type' => 'general',
            'status' => Project::STATUS_READY,
        ]);
        $job = ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
            'settings' => ['aspect_ratio' => '9:16'],
        ]);
        Clip::create([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'start_seconds' => 0,
            'end_seconds' => 30,
            'duration_seconds' => 30,
            'status' => Clip::STATUS_READY,
            'output_path' => 'clips/1/x.mp4',
            'file_size_bytes' => 1000,
        ]);

        $url = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertStatus(200)
            ->json('job.clips.0.download_url');

        $this->assertIsString($url);
        $this->assertStringStartsWith('http://127.0.0.1:8000/api/v1/clips/', $url);
    }
}
