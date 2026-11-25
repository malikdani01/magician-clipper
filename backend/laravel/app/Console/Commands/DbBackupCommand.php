<?php

namespace App\Console\Commands;

use App\Support\DatabaseBackup;
use Illuminate\Console\Command;

/**
 * php artisan db:backup — snapshot the whole database to a
 * timestamped .sql.gz (Batch 9, 2026-11-25 — deploy-safety work).
 *
 * PostgreSQL: pg_dump --no-owner --no-acl --clean --if-exists,
 * streamed into gzip. SQLite (local dev): a transaction-consistent
 * copy via the sqlite3 CLI (.backup), gzipped. When the admin has
 * cloud storage configured, the backup is ALSO uploaded to their
 * bucket under backups/<filename>.
 *
 * DATABASE ONLY: clip / upload / brand-asset FILES are not in the
 * backup (they live on the ephemeral disk — see DatabaseBackup).
 */
class DbBackupCommand extends Command
{
    protected $signature = 'db:backup
        {--path= : Directory to write the backup into (default: storage/app/backups)}';

    protected $description = 'Back up the database to a timestamped .sql.gz file (PostgreSQL via pg_dump, SQLite via file backup).';

    public function handle(): int
    {
        try {
            $meta = DatabaseBackup::create(null, $this->option('path') ?: null);
        } catch (\Throwable $e) {
            $this->error('Backup failed: '.$e->getMessage());

            return self::FAILURE;
        }

        $this->info('Backup created: '.$meta['filename']);
        $this->line('  Location: '.$meta['path']);
        $this->line('  Size: '.number_format($meta['size_bytes']).' bytes');
        $this->line('  Driver: '.$meta['driver'].' ('.$meta['method'].')');
        if ($meta['cloud_key'] !== null) {
            $this->line('  Cloud: uploaded to '.$meta['cloud_key']);
        } elseif ($meta['cloud_error'] !== null) {
            $this->warn('  Cloud: upload failed — '.$meta['cloud_error']);
        } else {
            $this->line('  Cloud: not configured — local file only (wiped on deploy; download it).');
        }
        $this->line('  Restore with: '.DatabaseBackup::restoreCommand($meta['filename']));

        return self::SUCCESS;
    }
}
