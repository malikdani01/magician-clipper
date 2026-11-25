<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ClipRerender;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 9 (2026-11-25): OST position (style-derived default),
 * SFX setting, music bed upload + worker download, bulk re-render,
 * A/B variants, and clip face_tracked / variant_of_clip_id.
 */
class Batch9Test extends TestCase
{
    use RefreshDatabase;

    private const MUSE_KEY = 'test-muse-key-1234567890abcdef';

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.muse_job_api_key' => self::MUSE_KEY]);
        Storage::fake('local');
    }

    private function museHeaders(): array
    {
        return ['X-Muse-Api-Key' => self::MUSE_KEY];
    }

    private function baseJobPayload(array $overrides = []): array
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
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides);
    }

    private function createLinkJob(User $user, array $overrides = []): array
    {
        $response = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->baseJobPayload($overrides));
        $response->assertStatus(201);

        return $response->json('job');
    }

    /** A finished job with one ready clip (real MP4 on the fake disk). */
    private function createReadyClip(User $user, string $captionStyle = 'punchy'): Clip
    {
        $job = $this->createLinkJob($user);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file, 'title' => 'Clip 1', 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);

        $clip = Clip::where('job_id', $job['id'])->firstOrFail();
        $clip->update(['caption_style' => $captionStyle]);

        return $clip->fresh();
    }

    /** A 1s 440 Hz sine WAV written with pure PHP (no ffmpeg needed). */
    private function makeWavFile(string $name = 'bed.wav'): UploadedFile
    {
        $path = sys_get_temp_dir().'/'.uniqid('bed_', true).'.wav';
        $sampleRate = 8000;
        $samples = '';
        for ($i = 0; $i < $sampleRate; $i++) {
            $samples .= pack('v', (int) (12000 * sin(2 * M_PI * 440 * $i / $sampleRate)) + 32768);
        }
        $dataSize = strlen($samples);
        $header = 'RIFF'.pack('V', 36 + $dataSize).'WAVE'
            .'fmt '.pack('V', 16).pack('v', 1).pack('v', 1)
            .pack('V', $sampleRate).pack('V', $sampleRate * 2)
            .pack('v', 2).pack('v', 16)
            .'data'.pack('V', $dataSize);
        file_put_contents($path, $header.$samples);

        return new UploadedFile($path, $name, 'audio/wav', null, true);
    }

    // --- OST position -------------------------------------------------

    public function test_ost_position_defaults_derive_from_headline_style(): void
    {
        $user = User::factory()->create();

        $bold = $this->createLinkJob($user, ['headline_style' => 'bold_bar']);
        $this->assertSame('top', $bold['settings']['ost_position']);

        $lower = $this->createLinkJob($user, ['headline_style' => 'lower_third']);
        $this->assertSame('bottom', $lower['settings']['ost_position']);

        $centre = $this->createLinkJob($user, ['headline_style' => 'big_centre']);
        $this->assertSame('centre', $centre['settings']['ost_position']);

        // An explicit value always wins over the style default.
        $explicit = $this->createLinkJob($user, [
            'headline_style' => 'bold_bar',
            'ost_position' => 'bottom',
        ]);
        $this->assertSame('bottom', $explicit['settings']['ost_position']);
    }

    public function test_ost_position_rejects_unknown_value(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->baseJobPayload(['ost_position' => 'left']))
            ->assertStatus(422);
    }

    public function test_ost_position_round_trips_through_a_preset(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Centre OST',
                'settings' => $this->baseJobPayload([
                    'ost_position' => 'centre',
                    'sfx' => 'pop',
                ]),
            ])
            ->assertStatus(201)
            ->assertJsonPath('preset.settings.ost_position', 'centre')
            ->assertJsonPath('preset.settings.sfx', 'pop');

        // A preset made before ost_position existed still validates.
        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/presets', [
                'name' => 'Old preset',
                'settings' => $this->baseJobPayload(),
            ])
            ->assertStatus(201);
    }

    public function test_ost_animation_still_accepted_for_old_presets(): void
    {
        $user = User::factory()->create();

        $job = $this->createLinkJob($user, ['ost_animation' => 'slide']);
        $this->assertSame('slide', $job['settings']['ost_animation']);
    }

    // --- Caption + OST languages --------------------------------------

    public function test_ost_language_defaults_to_source_and_accepts_a_language_code(): void
    {
        $user = User::factory()->create();

        $default = $this->createLinkJob($user, []);
        $this->assertSame('source', $default['settings']['ost_language']);

        $spanish = $this->createLinkJob($user, ['ost_language' => 'es']);
        $this->assertSame('es', $spanish['settings']['ost_language']);
    }

    public function test_ost_language_rejects_unknown_code(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->baseJobPayload(['ost_language' => 'xx']))
            ->assertStatus(422);
    }

    public function test_caption_translation_accepts_the_expanded_language_list(): void
    {
        $user = User::factory()->create();

        $spanish = $this->createLinkJob($user, ['caption_translation' => 'es']);
        $this->assertSame('es', $spanish['settings']['caption_translation']);

        // The new list covers languages the old 4-code list did not.
        $japanese = $this->createLinkJob($user, ['caption_translation' => 'ja']);
        $this->assertSame('ja', $japanese['settings']['caption_translation']);
    }

    public function test_caption_translation_rejects_unknown_code(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->baseJobPayload(['caption_translation' => 'xx']))
            ->assertStatus(422);
    }

    // --- SFX ----------------------------------------------------------

    public function test_sfx_defaults_to_none_and_rejects_unknown_value(): void
    {
        $user = User::factory()->create();

        $job = $this->createLinkJob($user);
        $this->assertSame('none', $job['settings']['sfx']);

        $whoosh = $this->createLinkJob($user, ['sfx' => 'whoosh_pop']);
        $this->assertSame('whoosh_pop', $whoosh['settings']['sfx']);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->baseJobPayload(['sfx' => 'explosion']))
            ->assertStatus(422);
    }

    // --- Music bed ----------------------------------------------------

    public function test_music_bed_upload_stores_file_and_streams_to_worker(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user, 'sanctum')->post('/api/v1/jobs', array_merge(
            $this->baseJobPayload(),
            ['music_bed' => $this->makeWavFile('my-bed.wav')],
        ));
        $response->assertStatus(201);
        $job = $response->json('job');
        $this->assertSame('my-bed.wav', $job['music_bed_name']);

        $stored = ProcessingJob::findOrFail($job['id']);
        $this->assertNotNull($stored->music_bed_path);
        $this->assertStringStartsWith("music-beds/{$job['id']}/", $stored->music_bed_path);
        Storage::disk('local')->assertExists($stored->music_bed_path);

        // The worker payload carries a URL only when a bed is stored.
        $worker = $this->getJson(
            "/api/v1/muse/jobs/{$job['id']}",
            $this->museHeaders()
        )->assertStatus(200)->json('job');
        $this->assertStringContainsString("/music-bed", (string) $worker['music_bed_url']);

        // And the endpoint streams the file back.
        $this->get("/api/v1/muse/jobs/{$job['id']}/music-bed", $this->museHeaders())
            ->assertStatus(200)
            ->assertHeader('content-type', 'audio/x-wav');
    }

    public function test_music_bed_endpoint_404s_and_worker_url_is_null_without_a_bed(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->assertNull($job['music_bed_name'] ?? null);

        $this->get("/api/v1/muse/jobs/{$job['id']}/music-bed", $this->museHeaders())
            ->assertStatus(404)
            ->assertJsonPath('error', 'not_found');

        $worker = $this->getJson(
            "/api/v1/muse/jobs/{$job['id']}",
            $this->museHeaders()
        )->assertStatus(200)->json('job');
        $this->assertNull($worker['music_bed_url']);
    }

    public function test_music_bed_rejects_a_non_audio_file(): void
    {
        $user = User::factory()->create();
        $mp4 = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'not-audio.mp4',
            'video/mp4',
            null,
            true
        );

        $this->actingAs($user, 'sanctum')->post('/api/v1/jobs', array_merge(
            $this->baseJobPayload(),
            ['music_bed' => $mp4],
        ))->assertStatus(422);
    }

    // --- Bulk re-render ------------------------------------------------

    public function test_bulk_rerender_creates_one_row_per_clip(): void
    {
        $user = User::factory()->create();
        $clipA = $this->createReadyClip($user, 'punchy');
        $clipB = $this->createReadyClip($user, 'punchy');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/bulk-rerender', [
                'clip_ids' => [$clipA->id, $clipB->id],
                'caption_style' => 'neon',
            ])
            ->assertStatus(202)
            ->assertJsonCount(2, 'rerenders')
            ->assertJsonPath('rerenders.0.status', 'queued')
            ->assertJsonPath('skipped', []);

        $this->assertDatabaseCount('clip_rerenders', 2);
        $this->assertDatabaseHas('clip_rerenders', [
            'clip_id' => $clipA->id, 'caption_style' => 'neon', 'status' => 'queued',
        ]);
        $this->assertDatabaseHas('clip_rerenders', [
            'clip_id' => $clipB->id, 'caption_style' => 'neon', 'status' => 'queued',
        ]);
    }

    public function test_bulk_rerender_rejects_other_users_clips_and_bad_styles(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $mine = $this->createReadyClip($user, 'punchy');
        $theirs = $this->createReadyClip($other, 'punchy');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/bulk-rerender', [
                'clip_ids' => [$mine->id, $theirs->id],
                'caption_style' => 'neon',
            ])
            ->assertStatus(404);
        $this->assertDatabaseCount('clip_rerenders', 0);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/bulk-rerender', [
                'clip_ids' => [999999],
                'caption_style' => 'neon',
            ])
            ->assertStatus(404);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/bulk-rerender', [
                'clip_ids' => [$mine->id],
                'caption_style' => 'not_a_style',
            ])
            ->assertStatus(422);
    }

    public function test_bulk_rerender_skips_clips_already_on_that_style(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'neon');

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/bulk-rerender', [
                'clip_ids' => [$clip->id],
                'caption_style' => 'neon',
            ])
            ->assertStatus(202)
            ->assertJsonCount(0, 'rerenders')
            ->assertJsonCount(1, 'skipped');
        $this->assertDatabaseCount('clip_rerenders', 0);
    }

    // --- A/B variants ---------------------------------------------------

    public function test_variant_creates_an_is_variant_rerender_row(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/variants", [
                'caption_style' => 'neon',
                'headline_style' => 'big_centre',
            ])
            ->assertStatus(202)
            ->assertJsonPath('rerender.is_variant', true)
            ->assertJsonPath('rerender.caption_style', 'neon')
            ->assertJsonPath('rerender.variant_headline_style', 'big_centre')
            ->assertJsonPath('rerender.status', 'queued');

        $this->assertDatabaseHas('clip_rerenders', [
            'clip_id' => $clip->id,
            'caption_style' => 'neon',
            'is_variant' => true,
            'variant_headline_style' => 'big_centre',
        ]);
    }

    public function test_variant_rejects_an_identical_variant_and_bad_styles(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');

        // Same caption style + no headline change = the original.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/variants", ['caption_style' => 'punchy'])
            ->assertStatus(422);

        // Same caption style but a different headline IS a variant.
        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/variants", [
                'caption_style' => 'punchy',
                'headline_style' => 'big_centre',
            ])
            ->assertStatus(202);

        $this->actingAs($user, 'sanctum')
            ->postJson("/api/v1/clips/{$clip->id}/variants", ['caption_style' => 'nope'])
            ->assertStatus(422);
    }

    public function test_variant_upload_creates_a_new_variant_b_clip(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');
        $rerender = ClipRerender::create([
            'clip_id' => $clip->id,
            'user_id' => $user->id,
            'caption_style' => 'slam',
            'is_variant' => true,
            'variant_headline_style' => 'big_centre',
            'status' => ClipRerender::STATUS_PROCESSING,
        ]);

        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'variant.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/clips/{$clip->id}/variant-file",
            ['file' => $file, 'rerender_id' => $rerender->id, 'face_tracked' => 'true'],
            $this->museHeaders()
        )->assertStatus(200)
          ->assertJsonPath('rerender.status', ClipRerender::STATUS_READY);

        // The original clip is untouched; a NEW Variant B row exists.
        $this->assertSame('punchy', $clip->fresh()->caption_style);
        $variant = Clip::where('variant_of_clip_id', $clip->id)->firstOrFail();
        $this->assertSame('Clip 1 (Variant B)', $variant->title);
        $this->assertSame('slam', $variant->caption_style);
        $this->assertSame(0.8, (float) $variant->score);
        $this->assertTrue((bool) $variant->face_tracked);
        $this->assertSame($clip->job_id, $variant->job_id);
        $this->assertSame($clip->start_seconds, (float) $variant->start_seconds);
    }

    public function test_variant_upload_rejects_a_plain_rerender_row(): void
    {
        $user = User::factory()->create();
        $clip = $this->createReadyClip($user, 'punchy');
        $rerender = ClipRerender::create([
            'clip_id' => $clip->id,
            'user_id' => $user->id,
            'caption_style' => 'slam',
            'is_variant' => false,
            'status' => ClipRerender::STATUS_PROCESSING,
        ]);

        $file = new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'variant.mp4',
            'video/mp4',
            null,
            true
        );
        $this->post(
            "/api/v1/muse/clips/{$clip->id}/variant-file",
            ['file' => $file, 'rerender_id' => $rerender->id],
            $this->museHeaders()
        )->assertStatus(422);
        $this->assertSame(0, Clip::where('variant_of_clip_id', $clip->id)->count());
    }

    // --- Clip upload: face_tracked + variant_of_clip_id ---------------

    public function test_store_clip_accepts_face_tracked_and_variant_link(): void
    {
        $user = User::factory()->create();
        $job = $this->createLinkJob($user);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $file = fn () => new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            'clip.mp4',
            'video/mp4',
            null,
            true
        );

        $first = $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file(), 'title' => 'Clip A', 'face_tracked' => 'true'],
            $this->museHeaders()
        )->assertStatus(201)->json('clip');
        $this->assertTrue((bool) $first['face_tracked']);
        $this->assertNull($first['variant_of_clip_id']);

        // No face_tracked sent = false, never a guessed true.
        $second = $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file(), 'title' => 'Clip B'],
            $this->museHeaders()
        )->assertStatus(201)->json('clip');
        $this->assertFalse((bool) $second['face_tracked']);

        // Variant B of Clip A.
        $variant = $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file(), 'title' => 'Clip A — Variant B', 'variant_of_clip_id' => $first['id']],
            $this->museHeaders()
        )->assertStatus(201)->json('clip');
        $this->assertSame($first['id'], (int) $variant['variant_of_clip_id']);

        // A clip of ANOTHER job is not a valid variant parent.
        $otherClip = $this->createReadyClip($user, 'punchy');
        $this->post(
            "/api/v1/muse/jobs/{$job['id']}/clips",
            ['file' => $file(), 'title' => 'Bad variant', 'variant_of_clip_id' => $otherClip->id],
            $this->museHeaders()
        )->assertStatus(422);
    }
}
