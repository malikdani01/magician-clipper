<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use App\Support\CampaignBriefParser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Batch 14 (2026-11-25): "Campaign informations" auto-read. The
 * wizard sends only ONE box — the full campaign brief pasted from
 * the campaign site — and the backend parses it deterministically
 * (no LLM: CampaignBriefParser recognises the Genni format only)
 * and derives the Batch 12 structured fields from the parse. The
 * worker and the checklist then run on the parsed items; anything
 * the parser cannot read becomes a manual check.
 *
 * Fixture: the real Genni brief for "Bruiser Wolf - Ain't Got
 * Time" (8525), tests/Fixtures/campaign-brief-bruiser-wolf.txt.
 */
class Batch14Test extends TestCase
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

    /** The fixture brief, minus its two `#` comment header lines.
     * Trimmed: Laravel's TrimStrings middleware trims the brief on
     * the way in, so the stored value is the trimmed text. */
    private function fixtureBrief(): string
    {
        $raw = file_get_contents(
            base_path('tests/Fixtures/campaign-brief-bruiser-wolf.txt')
        );
        $this->assertIsString($raw);

        return trim((string) preg_replace("/^#.*\n/m", '', $raw));
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
            'job_type' => 'campaign',
            'layout' => 'center_crop',
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ], $overrides);
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

    /**
     * Settings as buildSettings stores them for the fixture brief:
     * the parse + the derived structured fields (first OST choice,
     * no verbatim caption, no hashtags).
     */
    private function parsedFixtureSettings(array $overrides = []): array
    {
        $parsed = CampaignBriefParser::parse($this->fixtureBrief());

        return array_merge([
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 2,
            'job_type' => 'campaign',
            'campaign_brief' => $this->fixtureBrief(),
            'campaign_requirements' => $this->fixtureBrief(),
            'campaign_parsed' => $parsed,
            'campaign_caption' => null,
            'campaign_caption_required' => false,
            'campaign_hashtags' => null,
            'campaign_hashtags_required' => false,
            'campaign_ost' => 'is you okay??',
            'campaign_ost_required' => true,
            'on_screen_text' => true,
        ], $overrides);
    }

    private function markReady(ProcessingJob $job): void
    {
        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);
    }

    // --- Parser: the Bruiser Wolf fixture ----------------------------

    public function test_parser_extracts_bruiser_wolf_fixture(): void
    {
        $p = CampaignBriefParser::parse($this->fixtureBrief());

        $this->assertSame("Bruiser Wolf - Ain't Got Time (8525)", $p['title']);

        // ON-SCREEN TEXT (REQUIRED): three YOUR CHOICE lines.
        $this->assertTrue($p['ost']['required']);
        $this->assertTrue($p['ost']['must_include']);
        $this->assertSame([
            'is you okay??',
            'me leaving the function at 10:01',
            'my calendar vs my bank account',
        ], $p['ost']['choices']);

        // CAPTION GUIDELINES (OPTIONAL): three example lines, none
        // required, no verbatim caption.
        $this->assertFalse($p['caption']['required']);
        $this->assertNull($p['caption']['verbatim']);
        $this->assertSame([
            'When the backflip does not go to plan',
            'Me leaving before it gets weird',
            'Some days you just ain’t got time',
        ], $p['caption']['examples']);

        // AUDIO (REQUIRED): both sound links, labelled.
        $this->assertTrue($p['audio']['required']);
        $this->assertSame([
            ['label' => 'TikTok sound', 'url' => 'https://www.tiktok.com/music/Ain%27t-Got-Time-7695951376502933505'],
            ['label' => 'Instagram sound', 'url' => 'https://www.instagram.com/reels/audio/1495376365982138'],
        ], $p['audio']['links']);

        // The brief has no hashtag line.
        $this->assertSame([], $p['hashtags']);
        $this->assertFalse($p['hashtags_required']);

        // EDITING GUIDELINES: background music NOT ALLOWED.
        $this->assertFalse($p['music_allowed']);

        // EXAMPLE VIDEOS: the Instagram reels link.
        $this->assertSame(
            ['https://www.instagram.com/reels/DeiMZINPP12/'],
            $p['reference_videos']
        );

        // THE TWO CLIP TYPES: both lines.
        $this->assertCount(2, $p['clip_types']);
        $this->assertStringStartsWith('Fail compilations:', $p['clip_types'][0]);
        $this->assertStringStartsWith('Relatable "no time" moments:', $p['clip_types'][1]);

        // REQUIREMENTS + NOT ALLOWED are non-empty (they become
        // manual checks — the worker cannot verify them).
        $this->assertNotEmpty($p['requirements']);
        $this->assertNotEmpty($p['not_allowed']);

        // The hook window and the beat-cut instruction were NOT
        // parsed into a rule — they must appear as manual checks.
        $this->assertContains(
            'The fail or punchline should land on the hook at 0:34-0:54, where the title line repeats.',
            $p['manual_lines']
        );
        $this->assertContains('Cut each moment to hit on the beat.', $p['manual_lines']);
        $this->assertContains('Cut each moment to hit on the beat.', $p['unparsed']);
        $this->assertNotEmpty($p['manual_lines']);
    }

    public function test_parser_empty_brief_is_empty_parse(): void
    {
        foreach ([null, '', "   \n  "] as $brief) {
            $p = CampaignBriefParser::parse($brief);
            $this->assertNull($p['title']);
            $this->assertSame([], $p['ost']['choices']);
            $this->assertFalse($p['ost']['required']);
            $this->assertSame([], $p['caption']['examples']);
            $this->assertFalse($p['audio']['required']);
            $this->assertSame([], $p['audio']['links']);
            $this->assertTrue($p['music_allowed']);
            $this->assertSame([], $p['manual_lines']);
        }
    }

    public function test_parser_synthetic_minimal_brief(): void
    {
        $brief = <<<'BRIEF'
            Test Campaign (123)
            ON-SCREEN TEXT (OPTIONAL)
            YOUR CHOICE
            hello world
            second line here
            CAPTION GUIDELINES (REQUIRED)
            Caption: The exact caption.
            #one #two, #three
            BRIEF;
        $p = CampaignBriefParser::parse($brief);

        $this->assertSame('Test Campaign (123)', $p['title']);
        $this->assertFalse($p['ost']['required']);
        $this->assertSame(['hello world', 'second line here'], $p['ost']['choices']);
        $this->assertTrue($p['caption']['required']);
        $this->assertSame('The exact caption.', $p['caption']['verbatim']);
        $this->assertSame(['#one', '#two', '#three'], $p['hashtags']);
        $this->assertTrue($p['hashtags_required']);
        $this->assertTrue($p['music_allowed']);
    }

    public function test_parser_bare_caption_header_parses_verbatim_caption(): void
    {
        // A bare "CAPTION (REQUIRED)" header (no "GUIDELINES") must
        // route to the caption bucket — a verbatim caption under it
        // is applied, not left as a manual check.
        $p = CampaignBriefParser::parse(
            "Test Campaign (123)\nCAPTION (REQUIRED)\nCaption: The exact caption."
        );

        $this->assertTrue($p['caption']['required']);
        $this->assertSame('The exact caption.', $p['caption']['verbatim']);
        $this->assertNotContains('Caption: The exact caption.', $p['manual_lines']);
    }

    public function test_parser_crlf_brief_parses_identically_to_lf(): void
    {
        // Browsers normalise textarea line breaks to CRLF on
        // submit, so the stored brief is CRLF — the parse must be
        // byte-identical to the LF parse.
        $lf = $this->fixtureBrief();
        $crlf = str_replace("\n", "\r\n", $lf);

        $this->assertSame(
            CampaignBriefParser::parse($lf),
            CampaignBriefParser::parse($crlf)
        );
    }

    public function test_parser_first_instruction_line_is_not_a_title(): void
    {
        // Regression: the Batch 12 two-line brief has no title line
        // — its first line is a rule, and BOTH lines must become
        // manual checks (the old parser swallowed the first line as
        // a "title" and only one check survived).
        $p = CampaignBriefParser::parse(
            "Show the laptop in every clip.\nKeep the hook in the first 2 seconds."
        );
        $this->assertNull($p['title']);
        $this->assertSame([
            'Show the laptop in every clip.',
            'Keep the hook in the first 2 seconds.',
        ], $p['manual_lines']);
    }

    // --- Job creation ------------------------------------------------

    public function test_campaign_create_with_empty_brief_still_422s(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'job_type' => 'campaign',
                'campaign_brief' => '',
            ]))
            ->assertStatus(422);
    }

    public function test_campaign_create_with_fixture_stores_parsed_json_and_derives_fields(): void
    {
        $user = User::factory()->create();

        // The wizard sends ONLY the brief now — no structured fields.
        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'campaign_brief' => $this->fixtureBrief(),
            ]))
            ->assertCreated();
        $settings = $res->json('job.settings');

        $this->assertSame($this->fixtureBrief(), $settings['campaign_brief']);
        $this->assertSame($settings['campaign_brief'], $settings['campaign_requirements']);

        // The parse is stored on the job.
        $parsed = $settings['campaign_parsed'];
        $this->assertIsArray($parsed);
        $this->assertSame([
            'is you okay??',
            'me leaving the function at 10:01',
            'my calendar vs my bank account',
        ], $parsed['ost']['choices']);
        $this->assertFalse($parsed['music_allowed']);
        $this->assertCount(2, $parsed['audio']['links']);
        $this->assertSame(
            ['https://www.instagram.com/reels/DeiMZINPP12/'],
            $parsed['reference_videos']
        );

        // Derived structured fields: first OST choice, required;
        // no verbatim caption, no hashtags (the brief has none).
        $this->assertSame('is you okay??', $settings['campaign_ost']);
        $this->assertTrue($settings['campaign_ost_required']);
        $this->assertNull($settings['campaign_caption']);
        $this->assertFalse($settings['campaign_caption_required']);
        $this->assertNull($settings['campaign_hashtags']);
        $this->assertFalse($settings['campaign_hashtags_required']);

        // A required OST forces on-screen text on (Batch 12 rule,
        // now driven by the parse).
        $this->assertTrue($settings['on_screen_text']);

        // Manual checks come from the parsed lines only — the
        // auto-enforced items (OST choices, audio links, caption
        // examples) are NOT manual work.
        $checks = $res->json('job.campaign_manual_checks');
        $this->assertCount(count($parsed['manual_lines']), $checks);
        $texts = array_column($checks, 'text');
        $this->assertContains(
            'The fail or punchline should land on the hook at 0:34-0:54, where the title line repeats.',
            $texts
        );
        $this->assertNotContains('is you okay??', $texts);
        $this->assertFalse($checks[0]['checked']);
    }

    public function test_campaign_create_with_sent_structured_fields_sent_values_win(): void
    {
        // Batch 12 API contract: a client that still sends the
        // structured fields gets exactly what it sent — the parse
        // only fills in what was omitted.
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'campaign_brief' => $this->fixtureBrief(),
                'campaign_ost' => 'MY OWN TEXT',
                'campaign_ost_required' => true,
                'campaign_caption' => 'My caption.',
                'campaign_caption_required' => true,
            ]))
            ->assertCreated();
        $settings = $res->json('job.settings');

        $this->assertSame('MY OWN TEXT', $settings['campaign_ost']);
        $this->assertSame('My caption.', $settings['campaign_caption']);
        // The parse is still stored (the job page shows it).
        $this->assertIsArray($settings['campaign_parsed']);
        $this->assertSame('is you okay??', $settings['campaign_parsed']['ost']['choices'][0]);
    }

    public function test_parsed_ost_gate_rejects_when_feature_off(): void
    {
        // The brief's required OST must pass the same feature gate
        // as a sent required OST — the gate parses the brief too.
        $admin = User::factory()->admin()->create(['name' => 'Admin']);
        $user = User::factory()->create();
        $this->actingAs($admin, 'sanctum')
            ->patchJson('/api/v1/admin/platform-settings', ['features' => ['on_screen_text' => false]])
            ->assertOk();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'campaign_brief' => $this->fixtureBrief(),
                'on_screen_text' => false,
            ]))
            ->assertStatus(422)
            ->assertJsonPath('error', 'feature_disabled')
            ->assertJsonPath('feature', 'on_screen_text');
    }

    // --- Checklist, re-based on parsed items ------------------------

    public function test_checklist_passes_when_clips_burn_first_choice(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->parsedFixtureSettings());
        $this->makeClip($job, [
            'ost_burned_text' => 'is you okay??',
            'required_items_applied' => ['ost'],
        ]);
        // A clip burning a DIFFERENT parsed choice still passes —
        // any choice line is an acceptable burn.
        $this->makeClip($job, [
            'title' => 'Clip 2',
            'start_seconds' => 20,
            'end_seconds' => 40,
            'ost_burned_text' => 'me leaving the function at 10:01',
            'required_items_applied' => ['ost'],
        ]);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertNotNull($checklist);
        $this->assertTrue($checklist['all_passed']);
        $this->assertSame(0, $checklist['failed_count']);
        // Only the OST item exists: the fixture has no required
        // caption and no hashtags.
        $this->assertCount(1, $checklist['items']);
        $this->assertSame('ost', $checklist['items'][0]['key']);
        $this->assertTrue($checklist['items'][0]['passed']);
        $this->assertSame([
            'is you okay??',
            'me leaving the function at 10:01',
            'my calendar vs my bank account',
        ], $checklist['items'][0]['required']);
    }

    public function test_checklist_fails_when_a_clip_burns_different_text(): void
    {
        $user = User::factory()->create();
        $job = $this->makeJob($user, $this->parsedFixtureSettings());
        $this->makeClip($job, [
            'ost_burned_text' => 'is you okay??',
            'required_items_applied' => ['ost'],
        ]);
        $this->makeClip($job, [
            'title' => 'Clip 2',
            'start_seconds' => 20,
            'end_seconds' => 40,
            'ost_burned_text' => 'SOMETHING ELSE ENTIRELY',
            'required_items_applied' => ['ost'],
        ]);
        $this->markReady($job);

        $checklist = $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/jobs/{$job->id}")
            ->assertOk()
            ->json('job.campaign_checklist');

        $this->assertFalse($checklist['all_passed']);
        $this->assertSame(1, $checklist['failed_count']);
        $this->assertFalse($checklist['items'][0]['passed']);
        $this->assertStringContainsString('Clip 2', $checklist['items'][0]['note']);
    }

    // --- Manual checks from the parse -------------------------------

    public function test_manual_checks_from_parsed_can_be_ticked_and_bogus_ids_ignored(): void
    {
        $user = User::factory()->create();

        $res = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', $this->payload([
                'campaign_brief' => $this->fixtureBrief(),
            ]))
            ->assertCreated();
        $jobId = $res->json('job.id');
        $checks = $res->json('job.campaign_manual_checks');
        $this->assertNotEmpty($checks);
        $hookId = null;
        foreach ($checks as $check) {
            if ($check['text'] === 'The fail or punchline should land on the hook at 0:34-0:54, where the title line repeats.') {
                $hookId = $check['id'];
            }
        }
        $this->assertNotNull($hookId, 'The hook line must be a manual check.');

        $saved = $this->actingAs($user, 'sanctum')
            ->patchJson("/api/v1/jobs/{$jobId}/campaign-checks", [
                'manual_checks' => [
                    ['id' => $hookId, 'checked' => true],
                    ['id' => 'not-a-brief-line', 'checked' => true],
                ],
            ])
            ->assertOk()
            ->json('job.campaign_manual_checks');

        $this->assertCount(count($checks), $saved);
        $byId = collect($saved)->keyBy('id');
        $this->assertTrue($byId[$hookId]['checked']);
        foreach ($saved as $check) {
            if ($check['id'] !== $hookId) {
                $this->assertFalse($check['checked']);
            }
        }
    }
}
