<?php

namespace Tests\Feature;

use App\Models\JobPreset;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Job presets: a user saves a named set of job settings and reuses
 * them when creating jobs. Settings validate against the SAME rules
 * as job creation (JobSettingsRules), so the two can never drift.
 */
class JobPresetTest extends TestCase
{
    use RefreshDatabase;

    private function validSettings(array $overrides = []): array
    {
        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'captions_enabled' => true,
            'captions_language' => 'english',
            'on_screen_text' => false,
            'job_type' => 'myself',
            'layout' => 'center_crop',
        ], $overrides);
    }

    public function test_create_and_list_presets_scoped_to_owner(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'TikTok viral',
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.name', 'TikTok viral')
            ->assertJsonPath('preset.settings.platform', 'tiktok')
            ->assertJsonPath('preset.settings.clip_count', 3);

        $this->assertDatabaseHas('job_presets', [
            'user_id' => $user->id, 'name' => 'TikTok viral',
        ]);

        // The owner sees it; another user sees nothing.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonCount(1, 'presets')
            ->assertJsonPath('presets.0.name', 'TikTok viral');

        $this->actingAs($other, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonCount(0, 'presets');
    }

    /**
     * Batch 1 (2026-11-25): a preset saved with an enhancement OFF
     * must load OFF — the flags round-trip through save and list.
     */
    public function test_batch1_enhancement_flags_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'No enhancements',
                'settings' => $this->validSettings([
                    'auto_zoom' => false,
                    'face_tracking' => false,
                    'silence_removal' => false,
                    'filler_removal' => false,
                ]),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.auto_zoom', false)
            ->assertJsonPath('preset.settings.face_tracking', false)
            ->assertJsonPath('preset.settings.silence_removal', false)
            ->assertJsonPath('preset.settings.filler_removal', false);

        // Listing the preset returns the same OFF values.
        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.auto_zoom', false)
            ->assertJsonPath('presets.0.settings.face_tracking', false)
            ->assertJsonPath('presets.0.settings.silence_removal', false)
            ->assertJsonPath('presets.0.settings.filler_removal', false);
    }

    /**
     * Batch 1: a preset with a non-boolean enhancement value is rejected
     * by the same shared JobSettingsRules.
     */
    public function test_batch1_enhancement_invalid_value_rejected_in_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad preset',
                'settings' => $this->validSettings(['silence_removal' => 'yes-please']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.silence_removal']);
    }

    /**
     * Batch 2 (2026-11-25): headline style + caption position round-trip
     * through preset save and list; an invalid value is rejected by the
     * same shared JobSettingsRules.
     */
    public function test_batch2_headline_style_and_caption_position_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Big centre top captions',
                'settings' => $this->validSettings([
                    'headline_style' => 'big_centre',
                    'caption_position' => 'top',
                ]),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.headline_style', 'big_centre')
            ->assertJsonPath('preset.settings.caption_position', 'top');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.headline_style', 'big_centre')
            ->assertJsonPath('presets.0.settings.caption_position', 'top');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad style',
                'settings' => $this->validSettings(['headline_style' => 'neon']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.headline_style']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad position',
                'settings' => $this->validSettings(['caption_position' => 'sideways']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.caption_position']);
    }

    /**
     * Batch 3 (2026-11-25): beat sync + caption translation + export
     * ratios round-trip through preset save and list; invalid values
     * are rejected by the same shared JobSettingsRules.
     */
    public function test_batch3_beat_sync_translation_and_ratios_round_trip_through_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Urdu square export',
                'settings' => $this->validSettings([
                    'beat_sync' => false,
                    'caption_translation' => 'ur',
                    'export_ratios' => ['9:16', '1:1'],
                ]),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.beat_sync', false)
            ->assertJsonPath('preset.settings.caption_translation', 'ur')
            ->assertJsonPath('preset.settings.export_ratios', ['9:16', '1:1']);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/presets')
            ->assertStatus(200)
            ->assertJsonPath('presets.0.settings.beat_sync', false)
            ->assertJsonPath('presets.0.settings.caption_translation', 'ur')
            ->assertJsonPath('presets.0.settings.export_ratios', ['9:16', '1:1']);

        // Batch 9 (2026-11-25): the translation list expanded from
        // none/ur/hi/en to 32 languages, so 'fr' is valid now — the
        // rejection case uses a code that is in no list.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad translation',
                'settings' => $this->validSettings(['caption_translation' => 'xx']),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.caption_translation']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad ratio',
                'settings' => $this->validSettings(['export_ratios' => ['4:3']]),
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['settings.export_ratios.0']);
    }

    public function test_duplicate_name_for_same_user_is_422_but_other_users_may_reuse_it(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'My preset',
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(201);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'My preset',
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(422);

        // Same name, different user: fine.
        $this->actingAs($other, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'My preset',
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(201);
    }

    public function test_invalid_settings_are_rejected_with_422(): void
    {
        $user = User::factory()->create();

        // Unknown platform.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad platform',
                'settings' => $this->validSettings(['platform' => 'facebook']),
            ])
            ->assertStatus(422);

        // Missing a required settings field.
        $settings = $this->validSettings();
        unset($settings['platform']);
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Missing platform',
                'settings' => $settings,
            ])
            ->assertStatus(422);

        // Out-of-range clip count, unknown caption style, bad layout.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad count',
                'settings' => $this->validSettings(['clip_count' => 0]),
            ])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad style',
                'settings' => $this->validSettings(['caption_style' => 'not_a_style']),
            ])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Bad layout',
                'settings' => $this->validSettings(['layout' => 'not_a_layout']),
            ])
            ->assertStatus(422);

        $this->assertSame(0, JobPreset::count());
    }

    public function test_name_is_required_and_capped_at_100_chars(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', ['settings' => $this->validSettings()])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => str_repeat('a', 101),
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => str_repeat('a', 100),
                'settings' => $this->validSettings(),
            ])
            ->assertStatus(201);
    }

    public function test_delete_own_preset_and_404_for_another_users_preset(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();

        $preset = JobPreset::create([
            'user_id' => $owner->id,
            'name' => 'To delete',
            'settings' => $this->validSettings(),
        ]);
        $othersPreset = JobPreset::create([
            'user_id' => $other->id,
            'name' => 'Not mine',
            'settings' => $this->validSettings(),
        ]);

        // Another user's preset: 404, and it survives.
        $this->actingAs($owner, 'sanctum')
            ->deleteJson("/api/v1/presets/{$othersPreset->id}")
            ->assertStatus(404);
        $this->assertDatabaseHas('job_presets', ['id' => $othersPreset->id]);

        // Own preset: deleted.
        $this->actingAs($owner, 'sanctum')
            ->deleteJson("/api/v1/presets/{$preset->id}")
            ->assertStatus(200);
        $this->assertDatabaseMissing('job_presets', ['id' => $preset->id]);
    }

    public function test_job_creation_still_validates_the_same_settings(): void
    {
        // Regression guard for the rules extraction: JobController
        // must behave exactly as before (same accepts, same rejects).
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(),
                ['source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']
            ))
            ->assertStatus(201)
            ->assertJsonPath('job.settings.platform', 'tiktok');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge(
                $this->validSettings(['platform' => 'facebook']),
                ['source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']
            ))
            ->assertStatus(422);
    }
}
