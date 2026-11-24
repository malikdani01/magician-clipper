<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;
use ZipArchive;

/**
 * Clips ZIP: POST /api/v1/clips/zip streams a server-side ZIP of the
 * requested clips. Files missing from disk (ephemeral-disk wipe) are
 * skipped and counted; when none remain the response is an honest
 * 404, never an empty ZIP. Other users' clips are a 404, never a leak.
 */
class ClipsZipTest extends TestCase
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

    private function createLinkJob(User $user): array
    {
        $response = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ]);
        $response->assertStatus(201);

        return $response->json('job');
    }

    /** A finished job's clip with a real MP4 on the (fake) disk. */
    private function createReadyClip(User $user, string $title = 'Clip 1'): Clip
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
            ['file' => $file, 'title' => $title, 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job['id']}/status",
            ['status' => 'Ready'],
            $this->museHeaders()
        )->assertStatus(200);

        return Clip::where('job_id', $job['id'])->firstOrFail();
    }

    private function openZipFromResponse(\Illuminate\Testing\TestResponse $response): ZipArchive
    {
        $file = $response->getFile();
        $this->assertNotNull($file, 'ZIP download response has no file.');
        $zip = new ZipArchive();
        $this->assertTrue($zip->open($file->getPathname()));
        $this->addToAssertionCount(1);

        return $zip;
    }

    public function test_zip_happy_path_streams_a_real_zip_with_both_headers(): void
    {
        $user = User::factory()->create();
        $clip1 = $this->createReadyClip($user, 'Clip 1');
        $clip2 = $this->createReadyClip($user, 'Clip 2');

        $response = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => [$clip1->id, $clip2->id]]);

        $response->assertStatus(200)
            ->assertHeader('content-type', 'application/zip')
            ->assertHeader('X-Clips-Included', '2')
            ->assertHeader('X-Clips-Skipped', '0');
        $this->assertStringContainsString(
            'clips-',
            $response->headers->get('Content-Disposition')
        );

        $zip = $this->openZipFromResponse($response);
        $this->assertSame(2, $zip->numFiles);
        $this->assertSame('Clip_1.mp4', $zip->getNameIndex(0));
        $this->assertSame('Clip_2.mp4', $zip->getNameIndex(1));
        $zip->close();
    }

    public function test_zip_skips_missing_files_and_reports_them(): void
    {
        $user = User::factory()->create();
        $clip1 = $this->createReadyClip($user, 'Clip 1');
        $clip2 = $this->createReadyClip($user, 'Clip 2');

        // Simulate the ephemeral-disk wipe: one clip's file is gone.
        Storage::disk('local')->delete($clip2->output_path);

        $response = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => [$clip1->id, $clip2->id]]);

        $response->assertStatus(200)
            ->assertHeader('X-Clips-Included', '1')
            ->assertHeader('X-Clips-Skipped', '1');

        $zip = $this->openZipFromResponse($response);
        $this->assertSame(1, $zip->numFiles);
        $this->assertSame('Clip_1.mp4', $zip->getNameIndex(0));
        $zip->close();
    }

    public function test_zip_with_no_files_left_is_an_honest_404(): void
    {
        $user = User::factory()->create();
        $clip1 = $this->createReadyClip($user, 'Clip 1');
        $clip2 = $this->createReadyClip($user, 'Clip 2');

        Storage::disk('local')->delete($clip1->output_path);
        Storage::disk('local')->delete($clip2->output_path);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => [$clip1->id, $clip2->id]])
            ->assertStatus(404)
            ->assertJsonPath(
                'message',
                'None of the selected clips still have files on the server — they were removed on a server restart.'
            );
    }

    public function test_zip_rejects_unknown_ids_and_other_users_clips_with_404(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $clip = $this->createReadyClip($owner, 'Clip 1');

        // Unknown id.
        $this->actingAs($owner, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => [$clip->id + 999]])
            ->assertStatus(404);

        // Another user's clip: 404, never a leak.
        $this->actingAs($other, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => [$clip->id]])
            ->assertStatus(404);
    }

    public function test_zip_validates_clip_ids(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => []])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => range(1, 51)])
            ->assertStatus(422);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/clips/zip', ['clip_ids' => ['not-an-id']])
            ->assertStatus(422);
    }
}
