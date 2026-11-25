<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Batch 6 (2026-11-25): caption quality — caption safe zone (default
 * ON) and three platform caption styles (tiktok_bold, reels_clean,
 * shorts_minimal) through job creation and presets.
 */
class Batch6Test extends TestCase
{
    use RefreshDatabase;

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

    // --- 1. Caption safe zone ---

    /** Safe zone defaults ON when the job omits it (like the Batch 1 enhancements). */
    public function test_caption_safe_zone_defaults_on_when_omitted(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201)
            ->assertJsonPath('job.settings.caption_safe_zone', true);
    }

    /** An explicit OFF is stored, not silently turned back on. */
    public function test_caption_safe_zone_explicit_false_is_stored(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['caption_safe_zone' => false]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.caption_safe_zone', false);
    }

    public function test_caption_safe_zone_invalid_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['caption_safe_zone' => 'maybe']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['caption_safe_zone']);
    }

    /**
     * Multipart (FormData) clients send booleans as the strings
     * "true"/"false"; the controller normalises them before validation,
     * so a string "false" stores as real false instead of 422ing.
     */
    public function test_caption_safe_zone_string_false_from_form_is_stored_as_false(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', $this->payload(['caption_safe_zone' => 'false']))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.caption_safe_zone', false);
    }

    // --- 2. Three platform caption styles ---

    public function test_new_platform_caption_styles_are_accepted(): void
    {
        $user = User::factory()->create();

        foreach (['tiktok_bold', 'reels_clean', 'shorts_minimal'] as $style) {
            $this->actingAs($user, 'sanctum')
                ->postJson('/api/v1/jobs', $this->payload(['caption_style' => $style]))
                ->assertStatus(201)
                ->assertJsonPath('job.settings.caption_style', $style);
        }
    }

    public function test_unknown_caption_style_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['caption_style' => 'not-a-style']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['caption_style']);
    }

    // --- 3. Presets round-trip ---

    public function test_safe_zone_and_new_styles_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'TikTok Bold safe',
                'settings' => $this->payload([
                    'caption_safe_zone' => false,
                    'caption_style' => 'tiktok_bold',
                ]),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.caption_safe_zone', false)
            ->assertJsonPath('preset.settings.caption_style', 'tiktok_bold');

        // Listing the preset returns the same values.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.caption_safe_zone', false)
            ->assertJsonPath('presets.0.settings.caption_style', 'tiktok_bold');
    }

    public function test_preset_with_invalid_safe_zone_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad safe zone',
                'settings' => $this->payload(['caption_safe_zone' => 'maybe']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.caption_safe_zone']);
    }

    public function test_preset_with_unknown_style_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad style',
                'settings' => $this->payload(['caption_style' => 'not-a-style']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.caption_style']);
    }
}
