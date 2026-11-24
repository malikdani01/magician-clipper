<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class JobCreationSettingsTest extends TestCase
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

    public function test_selection_mode_defaults_to_interesting_only(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201)
            ->assertJsonPath('job.settings.selection_mode', 'interesting_only');
    }

    public function test_selection_mode_fill_any_is_accepted_and_stored(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['selection_mode' => 'fill_any']))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.selection_mode', 'fill_any');
    }

    public function test_selection_mode_invalid_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['selection_mode' => 'best_only']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['selection_mode']);
    }

    public function test_new_caption_styles_are_accepted(): void
    {
        $user = User::factory()->create();

        foreach (['kinetic', 'glow_pop'] as $style) {
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

    /** Batch 1 (2026-11-25): all four enhancements default ON. */
    public function test_batch1_enhancements_default_on_when_omitted(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201)
            ->assertJsonPath('job.settings.auto_zoom', true)
            ->assertJsonPath('job.settings.face_tracking', true)
            ->assertJsonPath('job.settings.silence_removal', true)
            ->assertJsonPath('job.settings.filler_removal', true);
    }

    /** Batch 1: an explicit OFF is stored, not silently turned back on. */
    public function test_batch1_enhancements_explicit_false_is_stored(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'auto_zoom' => false,
                'face_tracking' => false,
                'silence_removal' => false,
                'filler_removal' => false,
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.auto_zoom', false)
            ->assertJsonPath('job.settings.face_tracking', false)
            ->assertJsonPath('job.settings.silence_removal', false)
            ->assertJsonPath('job.settings.filler_removal', false);
    }

    /** Batch 1: a non-boolean value is rejected with 422. */
    public function test_batch1_enhancements_invalid_value_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['auto_zoom' => 'maybe']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['auto_zoom']);
    }

    /**
     * Batch 1: multipart (FormData) clients send booleans as the strings
     * "true"/"false"; the store must normalise them instead of 422ing.
     */
    public function test_batch1_enhancements_string_booleans_from_form_data_are_normalised(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', $this->payload([
                'auto_zoom' => 'false',
                'face_tracking' => 'true',
                'silence_removal' => 'false',
                'filler_removal' => 'true',
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.auto_zoom', false)
            ->assertJsonPath('job.settings.face_tracking', true)
            ->assertJsonPath('job.settings.silence_removal', false)
            ->assertJsonPath('job.settings.filler_removal', true);
    }

    /** Batch 2 (2026-11-25): headline style + caption position default to the pre-Batch-2 behaviour. */
    public function test_batch2_headline_style_and_caption_position_default(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload())
            ->assertStatus(201)
            ->assertJsonPath('job.settings.headline_style', 'bold_bar')
            ->assertJsonPath('job.settings.caption_position', 'bottom');
    }

    /** Batch 2: explicit non-default values are stored. */
    public function test_batch2_headline_style_and_caption_position_explicit_values_are_stored(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'headline_style' => 'big_centre',
                'caption_position' => 'top',
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.headline_style', 'big_centre')
            ->assertJsonPath('job.settings.caption_position', 'top');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'headline_style' => 'lower_third',
                'caption_position' => 'middle',
            ]))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.headline_style', 'lower_third')
            ->assertJsonPath('job.settings.caption_position', 'middle');
    }

    /** Batch 2: an unknown headline style or caption position is rejected with 422. */
    public function test_batch2_headline_style_and_caption_position_invalid_values_are_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['headline_style' => 'neon']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['headline_style']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload(['caption_position' => 'sideways']))
            ->assertStatus(422)
            ->assertJsonValidationErrors(['caption_position']);
    }
}
