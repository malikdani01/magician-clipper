<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\DatabaseBackup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Batch 9 (2026-11-25) — admin Backup & Restore endpoints
 * (GET /admin/backup, POST /admin/backup, GET /admin/backup/download).
 *
 * The backup CREATE path on a real file database is covered by
 * DatabaseBackupRestoreTest (same service code); here the test DB is
 * :memory:, so a create must fail HONESTLY (no file to back up) —
 * that refusal is asserted too.
 */
class AdminBackupTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $regular;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = User::factory()->create(['role' => 'admin']);
        $this->regular = User::factory()->create(['role' => 'user']);
    }

    public function test_non_admin_is_forbidden_on_all_backup_endpoints(): void
    {
        Sanctum::actingAs($this->regular);

        $this->getJson('/api/v1/admin/backup')->assertForbidden();
        $this->postJson('/api/v1/admin/backup')->assertForbidden();
        $this->getJson('/api/v1/admin/backup/download')->assertForbidden();
    }

    public function test_unauthenticated_is_unauthorized(): void
    {
        $this->getJson('/api/v1/admin/backup')->assertUnauthorized();
        $this->postJson('/api/v1/admin/backup')->assertUnauthorized();
    }

    public function test_info_reports_no_backup_yet(): void
    {
        Sanctum::actingAs($this->admin);

        $response = $this->getJson('/api/v1/admin/backup');
        $response->assertOk();
        $this->assertNull($response->json('backup'));
        $this->assertFalse($response->json('cloud_configured'));
        $this->assertStringContainsString('db:restore', $response->json('restore_command'));
        $this->assertStringContainsString('--force', $response->json('restore_command'));
    }

    public function test_info_and_download_serve_the_latest_backup_file(): void
    {
        $dir = DatabaseBackup::backupDirectory();
        $filename = 'clipper-backup-20990101-000000.sql.gz';
        $path = $dir.DIRECTORY_SEPARATOR.$filename;
        $contents = 'dummy-backup-bytes-'.random_int(1000, 9999);
        file_put_contents($path, gzencode($contents));
        // Newest by mtime, so latest() must pick this file even if
        // older real backups sit in the same directory.
        touch($path, time() + 3600);

        try {
            Sanctum::actingAs($this->admin);

            $info = $this->getJson('/api/v1/admin/backup');
            $info->assertOk();
            $this->assertSame($filename, $info->json('backup.filename'));
            $this->assertSame('local', $info->json('backup.location'));
            $this->assertStringContainsString($filename, $info->json('restore_command'));

            $download = $this->getJson('/api/v1/admin/backup/download');
            $download->assertOk();
            $this->assertSame($contents, gzdecode($download->streamedContent()));
        } finally {
            @unlink($path);
        }
    }

    public function test_download_without_any_backup_is_a_404(): void
    {
        Sanctum::actingAs($this->admin);

        $this->getJson('/api/v1/admin/backup/download')
            ->assertNotFound()
            ->assertJsonPath('message', 'No backup exists yet — create one first.');
    }

    public function test_create_backup_on_an_in_memory_database_fails_honestly(): void
    {
        // The phpunit database is :memory: — there is no file to back
        // up, and the endpoint must say so instead of faking success.
        Sanctum::actingAs($this->admin);

        $response = $this->postJson('/api/v1/admin/backup');
        $response->assertServerError();
        $this->assertStringContainsString('in-memory', $response->json('message'));
    }
}
