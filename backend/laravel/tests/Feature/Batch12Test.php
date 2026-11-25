<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use App\Support\CampaignChecklist;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 12 (2026-11-25): campaign requirements — structured brief
 * fields with Required/Optional selectors, required items applied
 * verbatim by the worker, per-clip attached post captions, and the
 * server-computed compliance checklist. Every rule is enforced
 * server-side and tested here through the real HTTP endpoints.
 */
class Batch12Test extends TestCase
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

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 2,
            'duration_mode' => 'exact',
            'duration_seconds' => 20,
            'captions_enabled' => true,
            'captions_language' => 'english',
            'caption_style' => 'punchy',
            'on_screen_text' => false,
            'job_type' => 'myself',
            'layout' => 'center_crop',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides);
    }

    private function campaignPayload(array $overrides = []): array
    {
        return $this->payload(array_merge([
            'job_type' => 'campaign',
            'campaign_brief' => "Show the laptop in every clip.\nKeep the hook in the first 2 seconds.",
            'campaign_caption' => 'The laptop that changed my workflow.',
            'campaign_caption_required' => true,
            'campaign_hashtags' => '#laptop #workflow #tech',
            'campaign_hashtags_required' => true,
            'campaign_ost' => 'NEW LAPTOP DROP',
            'campaign_ost_required' => true,
        ], $overrides));
    }

    private function makeJob(User $user, array $settings, array $attrs = []): ProcessingJob
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'Test project',
            'status' => Project::STATUS_DRAFT,
            'content_type' => 'general',
        ]);

        return ProcessingJob::create(array_merge([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_QUEUED,
            'stage' => 'Queued',
            'progress' => 0,
            'settings' => $settings,
            'source_type' => 'link',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $attrs));
    }

    private function makeClip(ProcessingJob $job, array $attrs = []): Clip
    {
        return Clip::create(array_merge([
            'project_id' => $job->project_id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'status' => Clip::STATUS_READY,
            'start_seconds' => 0,
            'end_seconds' => 20,
            'duration_seconds' => 20,
            'output_path' => 'clips/test-'.$job->id.'.mp4',
            'file_size_bytes' => 12345,
        ], $attrs));
    }

    private function campaignSettings(array $overrides = []): array
    {
        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 2,
            'job_type' => 'campaign',
            'campaign_brief' => "Show the laptop in every clip.\nKeep the hook in the first 2 seconds.",
            'campaign_requirements' => "Show the laptop in every clip.\nKeep the hook in the first 2 seconds.",
            'campaign_caption' => 'The laptop that changed my workflow.',
            'campaign_caption_required' => true,
            'campaign_hashtags' => '#laptop #workflow #tech',
            'campaign_hashtags_required' => true,
            'campaign_ost' => 'NEW LAPTOP DROP',
            'campaign_ost_required' => true,
            'on_screen_text' => true,
        ], $overrides);
    }

    private function matchingClips(ProcessingJob $job): void
    {
        $this->makeClip($job, [
            'title' => 'Clip 1',
            'post_caption' => 'The laptop that changed my workflow.',
            'caption_source' => 'required',
            'hashtags' => ['#laptop', '#workflow', '#tech', '#review'],
            'title_suggestion' => 'The Laptop That Changed My Workflow',
            'ost_burned_text' => 'NEW LAPTOP DROP',
            'required_items_applied' => ['caption', 'hashtags', 'ost'],
        ]);
        $this->makeClip($job, [
            'title' => 'Clip 2',
            'start_seconds' => 20,
            'end_seconds' => 40,
            'post_caption' => 'The laptop that changed my workflow.',
            'caption_source' => 'required',
            'hashtags' => ['#laptop', '#workflow', '#tech'],
            'title_suggestion' => 'Why This Laptop Wins',
            'ost_burned_text' => 'NEW LAPTOP DROP',
            'required_items_applied' => ['caption', 'hashtags', 'ost'],
        ]);
    }

    private function markReady(ProcessingJob $job): void
    {
        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);
    }

    // --- Job creation: campaign fields --------------------------------

    public function test_campaign_job_requires_a_brief(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'job_type' => 'campaign',
            ]))
            ->assertStatus(422);
    }

    public function test_campaign_settings_stored_with_required_flags(): void
    {
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload())
            ->assertCreated();
        $settings = $res->json('job.settings');

        $this->assertSame('The laptop that changed my workflow.', $settings['campaign_caption']);
        $this->assertTrue($settings['campaign_caption_required']);
        $this->assertSame('#laptop #workflow #tech', $settings['campaign_hashtags']);
        $this->assertTrue($settings['campaign_hashtags_required']);
        $this->assertSame('NEW LAPTOP DROP', $settings['campaign_ost']);
        $this->assertTrue($settings['campaign_ost_required']);
        $this->assertSame(
            "Show the laptop in every clip.\nKeep the hook in the first 2 seconds.",
            $settings['campaign_brief']
        );
        // Back-compat: the old free-text key carries the same brief.
        $this->assertSame($settings['campaign_brief'], $settings['campaign_requirements']);
    }

    public function test_required_ost_forces_on_screen_text_on(): void
    {
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload(['on_screen_text' => false]))
            ->assertCreated();

        $this->assertTrue($res->json('job.settings.on_screen_text'));
    }

    public function test_required_ost_is_rejected_when_ost_feature_is_off(): void
    {
        // A required OST implies on-screen text is on — it must pass
        // the same feature gate, or a campaign job could silently
        // re-enable a feature the admin turned off.
        $admin = User::factory()->admin()->create(['name' => 'Admin']);
        $user = User::factory()->create();
        $this->actingAs($admin, 'sanctum')
            ->patchJson('/api/v1/admin/platform-settings', ['features' => ['on_screen_text' => false]])
            ->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload(['on_screen_text' => false]))
            ->assertStatus(422)
            ->assertJsonPath('error', 'feature_disabled')
            ->assertJsonPath('feature', 'on_screen_text');
    }

    public function test_campaign_caption_over_2200_chars_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload([
                'campaign_caption' => str_repeat('x', 2201),
            ]))
            ->assertStatus(422);
    }

    public function test_campaign_ost_over_60_chars_is_rejected(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload([
                'campaign_ost' => str_repeat('x', 61),
            ]))
            ->assertStatus(422);
    }

    public function test_optional_campaign_fields_default_to_required_when_typed(): void
    {
        // An API client that sends text but omits the flag gets
        // Required — the wizard always sends the flag explicitly.
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'job_type' => 'campaign',
                'campaign_brief' => 'Brief here.',
                'campaign_caption' => 'Some caption.',
            ]))
            ->assertCreated();

        $this->assertTrue($res->json('job.settings.campaign_caption_required'));
        $this->assertFalse($res->json('job.settings.campaign_hashtags_required'));
        $this->assertFalse($res->json('job.settings.campaign_ost_required'));
    }

    // --- Hashtag parsing ----------------------------------------------

    public function test_parse_hashtags_keeps_order_adds_hash_dedupes(): void
    {
        $this->assertSame(
            ['#laptop', '#workflow', '#Tech'],
            CampaignChecklist::parseHashtags('#laptop workflow, #Tech #LAPTOP')
        );
        $this->assertSame([], CampaignChecklist::parseHashtags(null));
        $this->assertSame([], CampaignChecklist::parseHashtags('   '));
    }

    // --- Checklist computation -----------------------------------------

    public function test_checklist_all_pass_when_everything_matches(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->matchingClips($job);
        $this->markReady($job);

        $res = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk();
        $checklist = $res->json('job.campaign_checklist');

        $this->assertNotNull($checklist);
        $this->assertTrue($checklist['all_passed']);
        $this->assertSame(0, $checklist['failed_count']);
        $this->assertCount(3, $checklist['items']);
        foreach ($checklist['items'] as $item) {
            $this->assertTrue($item['passed'], "Item {$item['key']} should pass.");
        }
        // Manual checks are initialised from the brief lines.
        $this->assertCount(2, $res->json('job.campaign_manual_checks'));
        $this->assertFalse($res->json('job.campaign_manual_checks.0.checked'));
        // Per-clip attachment is exposed on the job payload.
        $clips = $res->json('job.clips');
        $this->assertSame('required', $clips[0]['caption_source']);
        $this->assertSame('NEW LAPTOP DROP', $clips[0]['ost_burned_text']);
        $this->assertSame(
            ['#laptop', '#workflow', '#tech', '#review'],
            $clips[0]['hashtags']
        );
    }

    public function test_checklist_fails_when_a_required_hashtag_is_missing(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->matchingClips($job);
        // Clip 2 loses #tech — the checklist must catch it.
        Clip::where('job_id', $job->id)->where('title', 'Clip 2')
            ->update(['hashtags' => ['#laptop', '#workflow']]);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertFalse($checklist['all_passed']);
        $this->assertSame(1, $checklist['failed_count']);
        $byKey = collect($checklist['items'])->keyBy('key');
        $this->assertFalse($byKey['hashtags']['passed']);
        $this->assertStringContainsString('Clip 2', $byKey['hashtags']['note']);
        $this->assertStringContainsString('#tech', $byKey['hashtags']['note']);
        $this->assertTrue($byKey['caption']['passed']);
        $this->assertTrue($byKey['ost']['passed']);
    }

    public function test_checklist_fails_when_ost_differs(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->matchingClips($job);
        Clip::where('job_id', $job->id)->where('title', 'Clip 1')
            ->update(['ost_burned_text' => 'SOMETHING ELSE']);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertFalse($checklist['all_passed']);
        $byKey = collect($checklist['items'])->keyBy('key');
        $this->assertFalse($byKey['ost']['passed']);
        $this->assertStringContainsString('SOMETHING ELSE', $byKey['ost']['note']);
    }

    public function test_checklist_fails_when_caption_differs(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->matchingClips($job);
        Clip::where('job_id', $job->id)->where('title', 'Clip 1')
            ->update(['post_caption' => 'A different caption.']);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $byKey = collect($checklist['items'])->keyBy('key');
        $this->assertFalse($byKey['caption']['passed']);
        $this->assertStringContainsString('Clip 1', $byKey['caption']['note']);
    }

    public function test_checklist_is_null_without_required_items(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 1,
            'job_type' => 'myself',
        ]);
        $this->makeClip($job);
        $this->markReady($job);

        $res = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk();

        $this->assertNull($res->json('job.campaign_checklist'));
    }

    public function test_checklist_skips_optional_items(): void
    {
        $user = User::factory()->create();
        // Caption Optional: only hashtags + OST are required.
        $job = $this->makeJob($user, $this->campaignSettings([
            'campaign_caption_required' => false,
        ]));
        $this->matchingClips($job);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertCount(2, $checklist['items']);
        $this->assertSame(['hashtags', 'ost'], array_column($checklist['items'], 'key'));
    }

    public function test_checklist_fails_when_no_clips_rendered(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertFalse($checklist['all_passed']);
        $this->assertSame(3, $checklist['failed_count']);
    }

    public function test_checklist_ignores_variant_clips(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->matchingClips($job);
        // A Variant B with wrong values must not fail the checklist —
        // only the original deliverables count.
        $this->makeClip($job, [
            'title' => 'Clip 1 (Variant B)',
            'variant_of_clip_id' => 1,
            'post_caption' => 'Wrong caption.',
            'hashtags' => ['#wrong'],
            'ost_burned_text' => 'WRONG',
        ]);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertTrue($checklist['all_passed']);
    }

    // --- Manual checks --------------------------------------------------

    public function test_manual_checks_initialised_at_creation(): void
    {
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->campaignPayload())
            ->assertCreated();

        $checks = $res->json('job.campaign_manual_checks');
        $this->assertCount(2, $checks);
        $this->assertSame('Show the laptop in every clip.', $checks[0]['text']);
        $this->assertFalse($checks[0]['checked']);
    }

    public function test_manual_checks_can_be_ticked_and_unknown_ids_ignored(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->markReady($job);

        $checks = $job->fresh()->campaign_manual_checks;
        $this->assertCount(2, $checks);

        $res = $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/jobs/{$job->id}/campaign-checks", [
                'manual_checks' => [
                    ['id' => $checks[0]['id'], 'checked' => true],
                    ['id' => 'not-a-brief-line', 'checked' => true],
                ],
            ])
            ->assertOk();

        $saved = $res->json('job.campaign_manual_checks');
        $this->assertCount(2, $saved);
        $this->assertTrue($saved[0]['checked']);
        $this->assertFalse($saved[1]['checked']);
    }

    public function test_manual_checks_other_user_is_forbidden(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings());
        $this->markReady($job);

        $this->actingAs($other, 'sanctum')
            ->patchJson("/api/v1/jobs/{$job->id}/campaign-checks", [
                'manual_checks' => [],
            ])
            ->assertStatus(403);
    }

    // --- Worker clip upload: campaign fields ----------------------------

    public function test_store_clip_accepts_campaign_fields(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings(), [
            'state' => ProcessingJob::STATE_RENDERING,
        ]);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
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
            "/api/v1/muse/jobs/{$job->id}/clips",
            [
                'file' => $file,
                'title' => 'Clip 1',
                'title_suggestion' => 'The Laptop That Changed My Workflow',
                'hashtags' => json_encode(['#laptop', '#workflow', '#tech']),
                'post_caption' => 'The laptop that changed my workflow.',
                'caption_source' => 'required',
                'ost_burned_text' => 'NEW LAPTOP DROP',
                'required_items_applied' => json_encode(['caption', 'hashtags', 'ost']),
            ],
            $this->museHeaders()
        )->assertStatus(201);

        $clip = Clip::where('job_id', $job->id)->first();
        $this->assertNotNull($clip);
        $this->assertSame('The Laptop That Changed My Workflow', $clip->title_suggestion);
        $this->assertSame(['#laptop', '#workflow', '#tech'], $clip->hashtags);
        $this->assertSame('The laptop that changed my workflow.', $clip->post_caption);
        $this->assertSame('required', $clip->caption_source);
        $this->assertSame('NEW LAPTOP DROP', $clip->ost_burned_text);
        $this->assertSame(['caption', 'hashtags', 'ost'], $clip->required_items_applied);
    }

    public function test_store_clip_rejects_malformed_campaign_json(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->campaignSettings(), [
            'state' => ProcessingJob::STATE_RENDERING,
        ]);
        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
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
            "/api/v1/muse/jobs/{$job->id}/clips",
            [
                'file' => $file,
                'title' => 'Clip 1',
                'hashtags' => 'not-json',
            ],
            $this->museHeaders()
        )->assertStatus(422);
    }
}
