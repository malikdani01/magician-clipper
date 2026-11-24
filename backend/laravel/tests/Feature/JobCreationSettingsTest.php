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
}
