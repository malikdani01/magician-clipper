<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Batch 7 (2026-11-25): on-screen text for the whole clip — persistent
 * headline, entrance animation, Follow end card, keyword pop-ups,
 * lower-third tag, progress bar — through job creation and presets.
 */
class Batch7Test extends TestCase
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

    private function batch7Settings(): array
    {
        return [
            'ost_persistent' => true,
            'ost_animation' => 'slide',
            'end_card' => true,
            'end_card_text' => 'Follow me!',
            'keyword_popups' => true,
            'lower_third_text' => '@magicianclips',
            'progress_bar' => true,
        ];
    }

    // --- 1. Defaults ---

    /** All Batch 7 settings default to off/"none"/null when omitted. */
    public function test_batch7_defaults_when_omitted(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201)
            ->assertJsonPath('job.settings.ost_persistent', false)
            ->assertJsonPath('job.settings.ost_animation', 'none')
            ->assertJsonPath('job.settings.end_card', false)
            ->assertJsonPath('job.settings.end_card_text', null)
            ->assertJsonPath('job.settings.keyword_popups', false)
            ->assertJsonPath('job.settings.lower_third_text', null)
            ->assertJsonPath('job.settings.progress_bar', false);
    }

    /** All seven settings are stored when set. */
    public function test_batch7_settings_are_stored(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload($this->batch7Settings()))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.ost_persistent', true)
            ->assertJsonPath('job.settings.ost_animation', 'slide')
            ->assertJsonPath('job.settings.end_card', true)
            ->assertJsonPath('job.settings.end_card_text', 'Follow me!')
            ->assertJsonPath('job.settings.keyword_popups', true)
            ->assertJsonPath('job.settings.lower_third_text', '@magicianclips')
            ->assertJsonPath('job.settings.progress_bar', true);
    }

    // --- 2. Animation values ---

    public function test_each_animation_value_is_accepted(): void
    {
        $user = User::factory()->create();

        foreach (['none', 'slide', 'fade', 'pop'] as $animation) {
            $this->actingAs($user, 'sanctum')
                ->postJson('/api/v1/jobs', $this->payload(['ost_animation' => $animation]))
                ->assertStatus(201)
                ->assertJsonPath('job.settings.ost_animation', $animation);
        }
    }

    public function test_unknown_animation_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['ost_animation' => 'spin']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['ost_animation']);
    }

    // --- 3. Text limits (40 chars) ---

    public function test_end_card_text_over_40_chars_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'end_card_text' => str_repeat('a', 41),
            ]))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['end_card_text']);
    }

    public function test_lower_third_text_over_40_chars_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'lower_third_text' => str_repeat('a', 41),
            ]))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['lower_third_text']);
    }

    public function test_text_at_exactly_40_chars_is_accepted(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'end_card_text' => str_repeat('a', 40),
                'lower_third_text' => str_repeat('b', 40),
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.end_card_text', str_repeat('a', 40))
            ->assertJsonPath('job.settings.lower_third_text', str_repeat('b', 40));
    }

    // --- 4. FormData booleans ---

    /**
     * Multipart (FormData) clients send booleans as the strings
     * "true"/"false"; the controller normalises them before validation.
     */
    public function test_batch7_booleans_from_form_are_stored_as_booleans(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', $this->payload([
                'ost_persistent' => 'true',
                'end_card' => 'true',
                'keyword_popups' => 'false',
                'progress_bar' => 'true',
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.ost_persistent', true)
            ->assertJsonPath('job.settings.end_card', true)
            ->assertJsonPath('job.settings.keyword_popups', false)
            ->assertJsonPath('job.settings.progress_bar', true);
    }

    // --- 5. Presets round-trip ---

    public function test_batch7_settings_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Batch 7 full',
                'settings' => $this->payload($this->batch7Settings()),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.ost_persistent', true)
            ->assertJsonPath('preset.settings.ost_animation', 'slide')
            ->assertJsonPath('preset.settings.end_card', true)
            ->assertJsonPath('preset.settings.end_card_text', 'Follow me!')
            ->assertJsonPath('preset.settings.keyword_popups', true)
            ->assertJsonPath('preset.settings.lower_third_text', '@magicianclips')
            ->assertJsonPath('preset.settings.progress_bar', true);

        // Listing the preset returns the same values.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.ost_persistent', true)
            ->assertJsonPath('presets.0.settings.ost_animation', 'slide')
            ->assertJsonPath('presets.0.settings.end_card_text', 'Follow me!')
            ->assertJsonPath('presets.0.settings.lower_third_text', '@magicianclips')
            ->assertJsonPath('presets.0.settings.progress_bar', true);
    }

    public function test_preset_with_invalid_animation_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad animation',
                'settings' => $this->payload(['ost_animation' => 'spin']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.ost_animation']);
    }

    public function test_preset_with_long_end_card_text_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Long end card',
                'settings' => $this->payload(['end_card_text' => str_repeat('a', 41)]),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.end_card_text']);
    }

    public function test_preset_with_long_lower_third_text_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Long lower third',
                'settings' => $this->payload(['lower_third_text' => str_repeat('a', 41)]),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.lower_third_text']);
    }
}
