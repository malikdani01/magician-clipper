<?php

namespace Tests\Feature;

use App\Models\CloudStorageSetting;
use App\Models\ProcessingJob;
use App\Models\User;
use App\Support\MediaStorage;
use Aws\CommandInterface;
use Aws\Result;
use Aws\S3\S3Client;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Storage;
use Mockery;
use Tests\TestCase;

/**
 * Batch 5 (2026-11-25): light theme + Roman Urdu preferences, cloud
 * storage settings (encrypted secret, test connection), and the
 * cloud-OFF = local-disk fallback.
 *
 * What the mocked-S3 tests do and do NOT prove: the mock stands in
 * for the network, so they prove the code path (the controller builds
 * the disk from the stored settings, puts/reads/deletes a test object
 * through the S3 adapter, and reports the real outcome) — NOT that a
 * real bucket, key or endpoint works. Only a real bucket proves that.
 */
class Batch5Test extends TestCase
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

    private function validCloudPayload(array $overrides = []): array
    {
        return array_merge([
            'provider' => 'r2',
            'endpoint' => 'https://test-account-123.r2.cloudflarestorage.com',
            'bucket' => 'test-bucket',
            'region' => 'auto',
            'access_key_id' => 'test-key-123',
            'secret_access_key' => 'test-secret-123',
            'enabled' => false,
        ], $overrides);
    }

    private function saveCloudSettings(User $user, array $overrides = []): CloudStorageSetting
    {
        return CloudStorageSetting::create(array_merge(
            ['user_id' => $user->id],
            $this->validCloudPayload($overrides)
        ));
    }

    /** A fake S3 client: put/read/delete succeed, no network involved. */
    private function bindFakeS3Client(bool $failUpload = false): void
    {
        $mock = Mockery::mock(S3Client::class);
        if ($failUpload) {
            $mock->shouldReceive('upload')->andThrow(new \RuntimeException('boom: connection refused'));
        } else {
            $mock->shouldReceive('upload')->andReturnNull();
        }
        $mock->shouldReceive('doesObjectExistV2')->andReturnTrue();
        $command = Mockery::mock(CommandInterface::class);
        $mock->shouldReceive('getCommand')->with('DeleteObject', Mockery::any())->andReturn($command);
        $mock->shouldReceive('execute')->with($command)->andReturn(new Result([]));
        $this->app->bind('clipper.s3-client', fn () => $mock);
    }

    private function demoClipFile(string $name = 'clip.mp4'): UploadedFile
    {
        return new UploadedFile(
            base_path('../../demo/demo-source-3min.mp4'),
            $name,
            'video/mp4',
            null,
            true
        );
    }

    // --- 1. Theme + language preferences ---

    public function test_theme_preference_stored_and_returned(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['theme' => 'light'])
            ->assertStatus(200)
            ->assertJsonPath('settings.theme', 'light');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/settings')
            ->assertStatus(200)
            ->assertJsonPath('settings.theme', 'light');
    }

    public function test_language_preference_stored_and_returned(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['language' => 'ur'])
            ->assertStatus(200)
            ->assertJsonPath('settings.language', 'ur');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/settings')
            ->assertStatus(200)
            ->assertJsonPath('settings.language', 'ur');
    }

    public function test_invalid_theme_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['theme' => 'neon'])
            ->assertStatus(422);
    }

    public function test_invalid_language_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/settings', ['language' => 'xx'])
            ->assertStatus(422);
    }

    public function test_preferences_default_to_dark_and_english(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/settings')
            ->assertStatus(200)
            ->assertJsonPath('settings.theme', 'dark')
            ->assertJsonPath('settings.language', 'en');
    }

    // --- 2. Cloud storage settings ---

    public function test_cloud_settings_saved_without_returning_secret(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload())
            ->assertStatus(200);

        $body = $response->json('cloud_storage');
        $this->assertSame('r2', $body['provider']);
        $this->assertSame('test-bucket', $body['bucket']);
        $this->assertTrue($body['secret_saved']);
        $this->assertArrayNotHasKey('secret_access_key', $body);
        $this->assertFalse($body['enabled']);
    }

    public function test_cloud_secret_stored_encrypted_not_plaintext(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload())
            ->assertStatus(200);

        $raw = CloudStorageSetting::where('user_id', $user->id)->firstOrFail()
            ->getRawOriginal('secret_access_key');
        $this->assertNotSame('test-secret-123', $raw);
        $this->assertStringNotContainsString('test-secret-123', (string) $raw);
        $this->assertSame('test-secret-123', Crypt::decryptString((string) $raw));
    }

    public function test_cloud_settings_validation_rejects_bad_bucket(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload(['bucket' => 'My Bucket!']))
            ->assertStatus(422);
    }

    public function test_cloud_settings_validation_rejects_bad_endpoint(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload(['endpoint' => 'not-a-url']))
            ->assertStatus(422);
    }

    public function test_cloud_settings_r2_requires_endpoint(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload(['endpoint' => '']))
            ->assertStatus(422);
    }

    public function test_cloud_settings_s3_without_endpoint_is_ok(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload([
                'provider' => 's3',
                'endpoint' => null,
                'region' => 'us-east-1',
            ]))
            ->assertStatus(200)
            ->assertJsonPath('cloud_storage.provider', 's3');
    }

    public function test_cloud_settings_secret_required_on_first_save(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload(['secret_access_key' => '']))
            ->assertStatus(422);
    }

    public function test_cloud_settings_second_save_keeps_secret_when_empty(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user);

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/cloud-storage', $this->validCloudPayload([
                'bucket' => 'renamed-bucket',
                'secret_access_key' => '',
            ]))
            ->assertStatus(200)
            ->assertJsonPath('cloud_storage.bucket', 'renamed-bucket')
            ->assertJsonPath('cloud_storage.secret_saved', true);

        $raw = CloudStorageSetting::where('user_id', $user->id)->firstOrFail()
            ->getRawOriginal('secret_access_key');
        $this->assertSame('test-secret-123', Crypt::decryptString((string) $raw));
    }

    public function test_cloud_settings_get_returns_null_when_nothing_saved(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/v1/cloud-storage')
            ->assertStatus(200)
            ->assertJsonPath('cloud_storage', null);
    }

    public function test_cloud_settings_are_per_user(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $this->saveCloudSettings($owner);

        $this->actingAs($other, 'sanctum')
            ->getJson('/api/v1/cloud-storage')
            ->assertStatus(200)
            ->assertJsonPath('cloud_storage', null);
    }

    // --- 3. Test connection (mocked S3 client — no real bucket) ---

    public function test_test_connection_with_mocked_client_reports_success(): void
    {
        $user = User::factory()->create();
        // Saved but NOT enabled: testing must work before enabling.
        $this->saveCloudSettings($user, ['enabled' => false]);
        $this->bindFakeS3Client();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/cloud-storage/test')
            ->assertStatus(200)
            ->assertJsonPath('ok', true);
    }

    public function test_test_connection_with_failing_client_reports_failure(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user, ['enabled' => false]);
        $this->bindFakeS3Client(failUpload: true);

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/cloud-storage/test')
            ->assertStatus(422)
            ->assertJsonPath('ok', false);
    }

    public function test_test_connection_without_settings_is_422(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/cloud-storage/test')
            ->assertStatus(422)
            ->assertJsonPath('ok', false);
    }

    // --- 4. MediaStorage disk resolution ---

    public function test_disk_name_is_local_without_settings(): void
    {
        $user = User::factory()->create();

        $this->assertSame('local', MediaStorage::diskNameFor($user));
    }

    public function test_disk_name_is_cloud_when_enabled(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user, ['enabled' => true]);

        $this->assertSame('cloud', MediaStorage::diskNameFor($user));
    }

    public function test_disk_name_is_local_when_disabled(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user, ['enabled' => false]);

        $this->assertSame('local', MediaStorage::diskNameFor($user));
    }

    public function test_mocked_cloud_disk_round_trip(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user, ['enabled' => true]);
        $this->bindFakeS3Client();

        $disk = MediaStorage::buildCloudDisk($user);
        $this->assertNotNull($disk);
        $disk->put('probe.txt', 'hello cloud');
        $this->assertTrue($disk->exists('probe.txt'));
        $disk->delete('probe.txt');
    }

    public function test_build_cloud_disk_returns_null_when_disabled(): void
    {
        $user = User::factory()->create();
        $this->saveCloudSettings($user, ['enabled' => false]);

        $this->assertNull(MediaStorage::buildCloudDisk($user));
    }

    // --- 5. Cloud OFF = local disk behaviour unchanged ---

    public function test_cloud_off_upload_job_stays_on_local_disk(): void
    {
        $user = User::factory()->create();

        // A file upload is multipart, not JSON.
        $response = $this->actingAs($user, 'sanctum')
            ->post('/api/v1/jobs', array_merge($this->validSettings(), [
                'file' => $this->demoClipFile(),
            ]));
        $response->assertStatus(201);

        $job = ProcessingJob::findOrFail($response->json('job.id'));
        $this->assertSame('local', $job->disk);
        $this->assertNotNull($job->source_path);
        $this->assertTrue(Storage::disk('local')->exists($job->source_path));
    }

    public function test_cloud_off_clip_upload_stores_disk_local(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user, 'sanctum')
            ->postJson('/api/v1/jobs', array_merge($this->validSettings(), [
                'source_url' => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            ]));
        $response->assertStatus(201);
        $job = ProcessingJob::findOrFail($response->json('job.id'));
        $this->assertSame('local', $job->disk);

        $this->patchJson(
            "/api/v1/muse/jobs/{$job->id}/status",
            ['status' => 'Processing'],
            $this->museHeaders()
        )->assertStatus(200);

        $this->post(
            "/api/v1/muse/jobs/{$job->id}/clips",
            ['file' => $this->demoClipFile(), 'title' => 'Clip 1', 'score' => 0.8],
            $this->museHeaders()
        )->assertStatus(201);

        $clip = $job->fresh()->clips()->firstOrFail();
        $this->assertSame('local', $clip->disk);
        $this->assertTrue(Storage::disk('local')->exists($clip->output_path));
    }
}
