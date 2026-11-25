<?php

namespace App\Console\Commands;

use App\Support\DatabaseBackup;
use Illuminate\Console\Command;

/**
 * php artisan db:restore <file> --force — restore a database backup
 * (Batch 9, 2026-11-25 — deploy-safety work).
 *
 * SAFETY, in order:
 * 1. Refuses to run without --force (a restore overwrites live data).
 * 2. Takes a FRESH backup of the current database first, so a bad
 *    restore can itself be undone. If that safety backup fails, the
 *    restore does not run at all.
 * 3. Restores (psql for PostgreSQL, file replacement for SQLite),
 *    then prints row counts before/after so the admin can see the
 *    restore landed.
 *
 * Restore is an artisan command ON PURPOSE — never a panel button:
 * a web request can time out mid-restore and leave a half-restored
 * database. The panel shows this exact command instead.
 */
class DbRestoreCommand extends Command
{
    protected $signature = 'db:restore
        {file : Backup file to restore (.sql or .sql.gz)}
        {--force : Required — restoring overwrites the current database}
        {--path= : Directory the safety backup is written into (default: storage/app/backups)}';

    protected $description = 'Restore a database backup (takes a fresh safety backup first; requires --force).';

    public function handle(): int
    {
        if (! $this->option('force')) {
            $this->error('Refusing to restore without --force: restoring overwrites the current database.');
            $this->line('Re-run with --force once you have checked the file is the backup you mean.');

            return self::FAILURE;
        }

        $file = $this->argument('file');
        if (! is_file($file)) {
            // Bare filename → look in the backup directory.
            $candidate = DatabaseBackup::backupDirectory($this->option('path') ?: null)
                .DIRECTORY_SEPARATOR.basename($file);
            if (is_file($candidate)) {
                $file = $candidate;
            }
        }
        if (! is_file($file)) {
            $this->error("Backup file not found: {$file}");

            return self::FAILURE;
        }

        $before = DatabaseBackup::tableCounts();
        $this->line('Current rows: '.$this->formatCounts($before));

        // Safety first: snapshot the live database before touching it.
        try {
            $safety = DatabaseBackup::create(null, $this->option('path') ?: null);
        } catch (\Throwable $e) {
            $this->error('Safety backup failed ('.$e->getMessage().') — restore aborted, nothing changed.');

            return self::FAILURE;
        }
        $this->info('Safety backup taken: '.$safety['filename']);

        try {
            DatabaseBackup::restore($file);
        } catch (\Throwable $e) {
            $this->error('Restore failed: '.$e->getMessage());
            $this->line('Your data is untouched by the failed restore itself — but the safety backup above is the way back if anything looks wrong.');

            return self::FAILURE;
        }

        // The SQLite restore replaced the database file under the live
        // connection — drop the stale handle so the counts below read
        // the restored file, not the old inode.
        if (config('database.default') === 'sqlite') {
            \Illuminate\Support\Facades\DB::purge('sqlite');
        }

        $after = DatabaseBackup::tableCounts();
        $this->info('Restore complete: '.basename($file));
        $this->line('Restored rows: '.$this->formatCounts($after));

        return self::SUCCESS;
    }

    private function formatCounts(array $counts): string
    {
        $parts = [];
        foreach ($counts as $table => $count) {
            $parts[] = "{$table}={$count}";
        }

        return implode(', ', $parts);
    }
}
