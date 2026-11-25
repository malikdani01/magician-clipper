<?php

namespace Tests\Feature;

use App\Models\JobPreset;
use App\Models\User;
use App\Models\UserSetting;
use App\Support\DatabaseBackup;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

/**
 * Batch 9 (2026-11-25) — `db:backup` / `db:restore` round-trip on a
 * scratch FILE SQLite database (the phpunit default is :memory:,
 * which has no file to back up — the command refuses that honestly,
 * see AdminBackupTest).
 *
 * No RefreshDatabase here: this class swaps the default sqlite
 * connection to a scratch file in setUp and restores it in
 * tearDown, so the backup/restore commands run against a real file
 * exactly like local dev.
 */
class DatabaseBackupRestoreTest extends TestCase
{
    private string $scratchDir;

    private string $scratchDb;

    private string $backupDir;

    private string $originalDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->scratchDir = storage_path('framework/testing/deploy-safety');
        $this->scratchDb = $this->scratchDir.'/scratch.sqlite';
        $this->backupDir = $this->scratchDir.'/backups';
        File::deleteDirectory($this->scratchDir);
        File::makeDirectory($this->backupDir, 0755, true);

        $this->originalDatabase = (string) config('database.connections.sqlite.database');
        config(['database.connections.sqlite.database' => $this->scratchDb]);
        DB::purge('sqlite');
        $this->artisan('migrate', ['--force' => true]);
    }

    protected function tearDown(): void
    {
        config(['database.connections.sqlite.database' => $this->originalDatabase]);
        DB::purge('sqlite');
        File::deleteDirectory($this->scratchDir);

        parent::tearDown();
    }

    public function test_sqlite_backup_and_restore_roundtrip_via_artisan(): void
    {
        $user = User::factory()->create(['name' => 'Backup Owner']);
        $preset = JobPreset::create([
            'user_id' => $user->id,
            'name' => 'Roundtrip preset',
            'settings' => ['caption_style' => 'marker', 'quality' => 'high'],
        ]);
        UserSetting::create([
            'user_id' => $user->id,
            'theme' => 'light',
            'language' => 'ur',
            'caption_style' => 'marker',
        ]);
        $before = DatabaseBackup::tableCounts();
        $this->assertSame(1, $before['users']);
        $this->assertSame(1, $before['job_presets']);

        // --- Backup via the real command. ---
        $this->assertSame(0, Artisan::call('db:backup', ['--path' => $this->backupDir]));
        $backups = glob($this->backupDir.'/*.sql.gz') ?: [];
        $this->assertCount(1, $backups);
        $backupFile = $backups[0];
        $this->assertGreaterThan(0, filesize($backupFile));

        // --- Mutate the live database. ---
        $preset->delete();
        $user->update(['name' => 'Mutated Name']);
        $this->assertNotSame($before, DatabaseBackup::tableCounts());

        // --- Restore refuses without --force (nothing changes). ---
        $this->assertSame(1, Artisan::call('db:restore', ['file' => $backupFile]));
        $this->assertSame('Mutated Name', User::find($user->id)->name);
        $this->assertCount(1, glob($this->backupDir.'/*.sql.gz') ?: []);

        // --- Restore with --force: safety backup first, then restore. ---
        $this->assertSame(0, Artisan::call('db:restore', [
            'file' => $backupFile,
            '--force' => true,
            '--path' => $this->backupDir,
        ]));
        DB::purge('sqlite');

        $this->assertSame($before, DatabaseBackup::tableCounts());
        $this->assertSame('Backup Owner', User::find($user->id)->name);
        $this->assertNotNull(JobPreset::find($preset->id));
        $this->assertSame('marker', JobPreset::find($preset->id)->settings['caption_style']);
        // The safety backup was taken before the restore: 2 files now.
        $this->assertCount(2, glob($this->backupDir.'/*.sql.gz') ?: []);
    }

    public function test_restore_refuses_a_missing_file(): void
    {
        $this->assertSame(1, Artisan::call('db:restore', [
            'file' => $this->backupDir.'/does-not-exist.sql.gz',
            '--force' => true,
            '--path' => $this->backupDir,
        ]));
        // No safety backup was taken for a file that does not exist.
        $this->assertCount(0, glob($this->backupDir.'/*.sql.gz') ?: []);
    }
}
