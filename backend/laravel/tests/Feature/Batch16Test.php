<?php

namespace Tests\Feature;

use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Batch 16 (2026-11-28): Captions/Text Intelligence — Face-aware
 * captions, Speaker colours, Emotion emphasis, Dynamic headline,
 * Scroll-stopper first frame. All five are automatic, default ON,
 * with no wizard toggles (pattern-interrupts precedent); the settings
 * live in JobSettingsRules (default true) + presets/clone so they
 * survive cloning.
 */
class Batch16Test extends TestCase
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

    public function test_batch16_settings_default_on(): void
    {
        $user = User::factory()->create();
        $job = $this->createJob($user);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertTrue($stored['face_aware_captions']);
        $this->assertTrue($stored['speaker_colours']);
        $this->assertTrue($stored['emotion_emphasis']);
        $this->assertTrue($stored['dynamic_headline']);
        $this->assertTrue($stored['scroll_stopper']);
    }

    public function test_batch16_settings_explicit_false_stored(): void
    {
        $user = User::factory()->create();
        $job = $this->createJob($user, [
            'face_aware_captions' => false,
            'speaker_colours' => false,
            'emotion_emphasis' => false,
            'dynamic_headline' => false,
            'scroll_stopper' => false,
        ]);

        $stored = ProcessingJob::findOrFail($job['id'])->settings;
        $this->assertFalse($stored['face_aware_captions']);
        $this->assertFalse($stored['speaker_colours']);
        $this->assertFalse($stored['emotion_emphasis']);
        $this->assertFalse($stored['dynamic_headline']);
        $this->assertFalse($stored['scroll_stopper']);
    }

    public function test_batch16_settings_invalid_value_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            'face_aware_captions' => 'maybe',
        ])->assertStatus(422)->assertJsonValidationErrors(['face_aware_captions']);
    }

    public function test_batch16_settings_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Batch 16 off',
                'settings' => [
                    'platform' => 'tiktok',
                    'aspect_ratio' => '9:16',
                    'clip_count' => 3,
                    'duration_mode' => 'exact',
                    'duration_seconds' => 30,
                    'face_aware_captions' => false,
                    'speaker_colours' => false,
                    'emotion_emphasis' => true,
                    'dynamic_headline' => false,
                    'scroll_stopper' => true,
                ],
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.face_aware_captions', false)
            ->assertJsonPath('preset.settings.speaker_colours', false)
            ->assertJsonPath('preset.settings.emotion_emphasis', true)
            ->assertJsonPath('preset.settings.dynamic_headline', false)
            ->assertJsonPath('preset.settings.scroll_stopper', true);

        // Listing the preset returns the same values.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.face_aware_captions', false)
            ->assertJsonPath('presets.0.settings.dynamic_headline', false)
            ->assertJsonPath('presets.0.settings.scroll_stopper', true);
    }

    public function test_preset_with_invalid_batch16_value_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad speaker colours',
                'settings' => [
                    'platform' => 'tiktok',
                    'aspect_ratio' => '9:16',
                    'clip_count' => 3,
                    'duration_mode' => 'exact',
                    'duration_seconds' => 30,
                    'speaker_colours' => 'maybe',
                ],
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.speaker_colours']);
    }
}
