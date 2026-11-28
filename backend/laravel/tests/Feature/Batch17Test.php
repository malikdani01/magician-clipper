<?php

namespace Tests\Feature;

use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Batch 17 (2026-11-28): Quality — Stabilization, Denoise + voice
 * cleanup, Speed ramps. All three are automatic, default ON, with
 * no wizard toggles (auto-grade precedent); the settings live in
 * JobSettingsRules (default true) + presets/clone so they survive
 * cloning. The worker measures each one per clip (vidstab/deshake
 * availability, source noise, speech-RMS guard, ramp plan) — the
 * backend only carries the on/off switches.
 */
class Batch17Test extends TestCase
{
    use RefreshDatabase;

    private function createJob(User $user, array $overrides = []): array
    {
        $response = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides));
        $response->assertStatus(201);

        return $response->json('job');
    }

    public function test_batch17_settings_default_on(): void
    {
        $user = User::factory()->create();
        $job = $this->createJob($user);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertTrue($stored['stabilization']);
        $this->assertTrue($stored['denoise_cleanup']);
        $this->assertTrue($stored['speed_ramps']);
    }

    public function test_batch17_settings_explicit_false_stored(): void
    {
        $user = User::factory()->create();
        $job = $this->createJob($user, [
            'stabilization' => false,
            'denoise_cleanup' => false,
            'speed_ramps' => false,
        ]);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertFalse($stored['stabilization']);
        $this->assertFalse($stored['denoise_cleanup']);
        $this->assertFalse($stored['speed_ramps']);
    }

    public function test_batch17_settings_invalid_value_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            'stabilization' => 'maybe',
        ])->assertStatus(422)->assertJsonValidationErrors(['stabilization']);
    }

    public function test_batch17_settings_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Batch 17 off',
                'settings' => [
                    'platform' => 'tiktok',
                    'aspect_ratio' => '9:16',
                    'clip_count' => 3,
                    'duration_mode' => 'exact',
                    'duration_seconds' => 30,
                    'stabilization' => false,
                    'denoise_cleanup' => true,
                    'speed_ramps' => false,
                ],
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.stabilization', false)
            ->assertJsonPath('preset.settings.denoise_cleanup', true)
            ->assertJsonPath('preset.settings.speed_ramps', false);

        // Listing the preset returns the same values.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.stabilization', false)
            ->assertJsonPath('presets.0.settings.denoise_cleanup', true)
            ->assertJsonPath('presets.0.settings.speed_ramps', false);
    }

    public function test_preset_with_invalid_batch17_value_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad speed ramps',
                'settings' => [
                    'platform' => 'tiktok',
                    'aspect_ratio' => '9:16',
                    'clip_count' => 3,
                    'duration_mode' => 'exact',
                    'duration_seconds' => 30,
                    'speed_ramps' => 'maybe',
                ],
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.speed_ramps']);
    }
}
