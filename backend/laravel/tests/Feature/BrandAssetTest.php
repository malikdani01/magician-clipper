<?php

namespace Tests\Feature;

use App\Models\BrandAsset;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Brand-kit intro/outro assets: upload validates as a real short video
 * (ffprobe, <= 15s), one asset per (user, kind) with replace deleting
 * the old file, listing/deletion scoped to the owner, and a
 * muse-guarded download endpoint for the worker.
 */
class BrandAssetTest extends TestCase
{
    use RefreshDatabase;

    private const MUSE_KEY = 'test-muse-key-1234567890abcdef';

    private string $tmpDir;

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.muse_job_api_key' => self::MUSE_KEY]);
        Storage::fake('local');

        $this->tmpDir = sys_get_temp_dir().'/clipper-brand-'.uniqid();
        mkdir($this->tmpDir, 0777, true);
        // 2s video with audio (valid brand asset) and 20s video (too long).
        $this->makeVideo("{$this->tmpDir}/short.mp4", 2, true);
        $this->makeVideo("{$this->tmpDir}/long.mp4", 20, true);
    }

    protected function tearDown(): void
    {
        foreach (glob("{$this->tmpDir}/*") ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->tmpDir);
        parent::tearDown();
    }

    private function makeVideo(string $path, int $seconds, bool $withAudio): void
    {
        $audio = $withAudio
            ? ' -f lavfi -i sine=frequency=440:duration='.$seconds.' -c:a aac -shortest'
            : ' -an';
        $command = 'ffmpeg -y -v error -f lavfi -i testsrc=duration='
            .$seconds.':size=320x240:rate=30'.$audio
            .' -c:v libx264 -pix_fmt yuv420p '.escapeshellarg($path);
        shell_exec($command);
        $this->assertFileExists($path, 'Test video generation failed — is ffmpeg installed?');
    }

    private function upload(User $user, string $kind, string $path, string $name = 'intro.mp4')
    {
        return $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => $kind,
            'file' => new UploadedFile($path, $name, 'video/mp4', null, true),
        ]);
    }

    public function test_upload_happy_path_stores_duration_and_size(): void
    {
        $user = User::factory()->create();

        $response = $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4");

        $response->assertStatus(201);
        $asset = $response->json('asset');
        $this->assertSame('intro', $asset['kind']);
        $this->assertEqualsWithDelta(2.0, $asset['duration_seconds'], 0.1);
        $this->assertGreaterThan(0, $asset['file_size_bytes']);
        $this->assertSame($user->id, $asset['user_id']);
        $this->assertSame('intro.mp4', $asset['original_name']);

        $row = BrandAsset::firstOrFail();
        $this->assertSame("brand-assets/{$user->id}/", substr($row->path, 0, strlen("brand-assets/{$user->id}/")));
        $this->assertTrue(Storage::disk('local')->exists($row->path));
        $this->assertSame(
            $row->file_size_bytes,
            Storage::disk('local')->size($row->path)
        );
    }

    public function test_non_video_upload_is_422(): void
    {
        $user = User::factory()->create();
        $fake = UploadedFile::fake()->create('intro.mp4', 100, 'video/mp4');

        $this->actingAs($user, 'sanctum')->post('/api/v1/brand-kit/assets', [
            'kind' => 'intro',
            'file' => $fake,
        ])->assertStatus(422);

        $this->assertSame(0, BrandAsset::count());
    }

    public function test_video_longer_than_15_seconds_is_422(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/long.mp4")
            ->assertStatus(422)
            ->assertJsonPath('error', 'validation_error');

        $this->assertSame(0, BrandAsset::count());
    }

    public function test_invalid_kind_is_422(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'bumper', "{$this->tmpDir}/short.mp4")
            ->assertStatus(422);

        $this->assertSame(0, BrandAsset::count());
    }

    public function test_replace_upserts_and_deletes_the_old_file(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4")->assertStatus(201);
        $oldPath = BrandAsset::firstOrFail()->path;
        $this->assertTrue(Storage::disk('local')->exists($oldPath));

        $response = $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4", 'intro-v2.mp4');
        $response->assertStatus(200);

        $this->assertSame(1, BrandAsset::count());
        $newPath = BrandAsset::firstOrFail()->path;
        $this->assertNotSame($oldPath, $newPath);
        $this->assertFalse(Storage::disk('local')->exists($oldPath));
        $this->assertTrue(Storage::disk('local')->exists($newPath));
        $this->assertSame('intro-v2.mp4', BrandAsset::firstOrFail()->original_name);
    }

    public function test_list_is_mine_only(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4")->assertStatus(201);
        $this->upload($user, 'outro', "{$this->tmpDir}/short.mp4", 'outro.mp4')->assertStatus(201);

        $this->actingAs($other, 'sanctum')
            ->getJson('/api/v1/brand-kit/assets')
            ->assertStatus(200)
            ->assertJsonCount(0, 'assets');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/brand-kit/assets')
            ->assertStatus(200)
            ->assertJsonCount(2, 'assets');
    }

    public function test_delete_removes_file_and_row(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'outro', "{$this->tmpDir}/short.mp4", 'outro.mp4')->assertStatus(201);
        $asset = BrandAsset::firstOrFail();
        $this->assertTrue(Storage::disk('local')->exists($asset->path));

        $this->actingAs($user, 'sanctum')
            ->deleteJson("/api/v1/brand-kit/assets/{$asset->id}")
            ->assertStatus(200);

        $this->assertSame(0, BrandAsset::count());
        $this->assertFalse(Storage::disk('local')->exists($asset->path));
    }

    public function test_other_user_delete_is_404_and_keeps_the_asset(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4")->assertStatus(201);
        $asset = BrandAsset::firstOrFail();

        $this->actingAs($other, 'sanctum')
            ->deleteJson("/api/v1/brand-kit/assets/{$asset->id}")
            ->assertStatus(404);

        $this->assertSame(1, BrandAsset::count());
        $this->assertTrue(Storage::disk('local')->exists($asset->path));
    }

    public function test_muse_download_streams_the_file_and_404s_when_missing(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4")->assertStatus(201);
        $asset = BrandAsset::firstOrFail();
        $bytes = Storage::disk('local')->get($asset->path);

        // No Muse key: 401.
        $this->get("/api/v1/muse/brand-assets/{$asset->id}/download")
            ->assertStatus(401);

        // With the key: the file streams back.
        $response = $this->get(
            "/api/v1/muse/brand-assets/{$asset->id}/download",
            ['X-Muse-Api-Key' => self::MUSE_KEY]
        );
        $response->assertStatus(200);
        $this->assertSame($bytes, $response->streamedContent());

        // File wiped from disk (row still there): honest 404.
        Storage::disk('local')->delete($asset->path);
        $this->get(
            "/api/v1/muse/brand-assets/{$asset->id}/download",
            ['X-Muse-Api-Key' => self::MUSE_KEY]
        )->assertStatus(404)
            ->assertJsonPath('error', 'not_found');
    }

    public function test_worker_payload_carries_brand_assets(): void
    {
        $user = User::factory()->create();

        $this->upload($user, 'intro', "{$this->tmpDir}/short.mp4")->assertStatus(201);
        $asset = BrandAsset::firstOrFail();

        $job = $this->actingAs($user, 'sanctum')->postJson('/api/v1/jobs', [
            'platform' => 'tiktok',
            'aspect_ratio' => '9:16',
            'clip_count' => 3,
            'duration_mode' => 'exact',
            'duration_seconds' => 30,
            'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ])->assertStatus(201)->json('job');

        $payload = $this->getJson(
            "/api/v1/muse/jobs/{$job['id']}",
            ['X-Muse-Api-Key' => self::MUSE_KEY]
        )->assertStatus(200)->json('job.brand_assets');

        $this->assertSame($asset->id, $payload['intro']['id']);
        $this->assertSame(
            url("/api/v1/muse/brand-assets/{$asset->id}/download"),
            $payload['intro']['download_url']
        );
        $this->assertEqualsWithDelta(2.0, $payload['intro']['duration_seconds'], 0.1);
        $this->assertNull($payload['outro']);
    }
}
