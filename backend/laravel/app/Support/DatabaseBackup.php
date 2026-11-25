<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;
use Symfony\Component\Process\Process;

/**
 * Database backup + restore (Batch 9, 2026-11-25 — deploy-safety work).
 *
 * The rule this exists to enforce: a deploy NEVER changes anything the
 * user has saved. Deploy-time code only ever creates missing rows (see
 * DatabaseSeeder, create-only by role), and this service is the safety
 * net underneath: `php artisan db:backup` snapshots the whole database
 * so a bad deploy can be undone with `php artisan db:restore`.
 *
 * HONEST BOUNDARY: the backup covers the DATABASE ONLY — jobs, clips
 * metadata, settings, presets, users, brand asset records. It does
 * NOT back up clip / upload / brand-asset FILES: those live on the
 * server's ephemeral disk and are wiped on deploy. Files need cloud
 * storage (Batch 5, Settings → Cloud Storage); the panel says this
 * plainly and never implies files are backed up.
 *
 * Formats:
 * - PostgreSQL: `pg_dump --no-owner --no-acl --clean --if-exists`,
 *   streamed straight into gzip. --clean/--if-exists is what makes a
 *   restore into a POPULATED database work (tables are dropped first);
 *   without it a restore would die on duplicate tables. The password
 *   is passed ONLY via the PGPASSWORD environment variable — never in
 *   the command line, never in logs; error output is redacted.
 * - SQLite (local dev): the `sqlite3` CLI's `.backup` command makes a
 *   transaction-consistent copy, then gzip. If the CLI is missing, a
 *   plain file copy is used instead and the backup is marked
 *   method=sqlite-copy (a hot copy can be inconsistent if a write
 *   lands mid-copy — the method is reported honestly, never hidden).
 *   An in-memory SQLite database (:memory:, the phpunit default) has
 *   no file to back up — that is refused with a clear error.
 *
 * Cloud: when the given (or first) admin has cloud storage configured
 * and enabled, the finished .sql.gz is ALSO uploaded to their bucket
 * under `backups/<filename>` via MediaStorage. A failed cloud upload
 * never fails the backup — the local file exists either way, and the
 * failure is reported in the metadata (cloud_error) instead of hidden.
 */
class DatabaseBackup
{
    /** Subdirectory of storage/app where local backups live. */
    public const BACKUP_DIR = 'backups';

    public const PREFIX = 'clipper-backup-';

    /** Tables whose row counts are reported before/after a restore. */
    public const COUNTED_TABLES = [
        'users',
        'processing_jobs',
        'clips',
        'job_presets',
        'user_settings',
        'cloud_storage_settings',
        'brand_assets',
    ];

    /**
     * Directory local backups live in (created on demand).
     * A $directory override exists so tests can isolate their files.
     */
    public static function backupDirectory(?string $directory = null): string
    {
        $dir = $directory ?? storage_path('app/'.self::BACKUP_DIR);
        if (! is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        return $dir;
    }

    /**
     * Filename for a backup taken right now (UTC timestamp + a short
     * random suffix: two backups in the SAME second must never share
     * a filename, or the second would overwrite the first — which is
     * exactly what a restore's safety backup would do to the backup
     * being restored).
     */
    public static function filenameForNow(): string
    {
        return self::PREFIX.gmdate('Ymd-His').'-'.bin2hex(random_bytes(3)).'.sql.gz';
    }

    /**
     * Create a backup now. Returns metadata (never a credential):
     * filename, path, size_bytes, created_at, driver, method,
     * cloud_key (null when cloud is not configured or the upload
     * failed), cloud_error (null on success / when cloud is off).
     *
     * @throws RuntimeException when the dump itself fails.
     */
    public static function create(?User $user = null, ?string $directory = null): array
    {
        $driver = config('database.default');
        $dir = self::backupDirectory($directory);
        $filename = self::filenameForNow();
        $path = $dir.DIRECTORY_SEPARATOR.$filename;

        $method = match ($driver) {
            'pgsql' => self::dumpPostgres($path),
            'sqlite' => self::dumpSqlite($path),
            default => throw new RuntimeException(
                "Database backup is not supported for driver '{$driver}' — only pgsql and sqlite."
            ),
        };

        $createdAt = gmdate('c');
        $cloudKey = null;
        $cloudError = null;
        $owner = $user ?? User::where('role', 'admin')->orderBy('id')->first();
        if ($owner !== null) {
            try {
                $cloudKey = self::uploadToCloud($owner, $path, $filename);
            } catch (\Throwable $e) {
                // Local backup exists; a failed upload must not fail it.
                $cloudError = $e->getMessage();
            }
        }

        return [
            'filename' => $filename,
            'path' => $path,
            'size_bytes' => is_file($path) ? filesize($path) : 0,
            'created_at' => $createdAt,
            'driver' => $driver,
            'method' => $method,
            'cloud_key' => $cloudKey,
            'cloud_error' => $cloudError,
        ];
    }

    /**
     * Metadata for the newest local backup, or null when none exists.
     * $directory override is for tests; production always uses the
     * default directory.
     */
    public static function latest(?string $directory = null): ?array
    {
        $dir = self::backupDirectory($directory);
        $files = glob($dir.DIRECTORY_SEPARATOR.self::PREFIX.'*.sql.gz') ?: [];
        if ($files === []) {
            return null;
        }
        usort($files, fn ($a, $b) => filemtime($b) <=> filemtime($a));
        $path = $files[0];

        return [
            'filename' => basename($path),
            'path' => $path,
            'size_bytes' => filesize($path),
            'created_at' => gmdate('c', filemtime($path)),
            'driver' => config('database.default'),
            'method' => null,
            'cloud_key' => null,
            'cloud_error' => null,
        ];
    }

    /** Exact shell command the admin runs to restore a backup file. */
    public static function restoreCommand(string $filename): string
    {
        return 'php artisan db:restore storage/app/'.self::BACKUP_DIR.'/'.$filename.' --force';
    }

    /** Row counts for the key tables (restore sanity check). */
    public static function tableCounts(): array
    {
        $counts = [];
        foreach (self::COUNTED_TABLES as $table) {
            if (! Schema::hasTable($table)) {
                continue;
            }
            $counts[$table] = DB::table($table)->count();
        }

        return $counts;
    }

    /**
     * Restore a backup file (.sql or .sql.gz) into the CURRENT database.
     * Callers MUST take a fresh backup first (DbRestoreCommand does) —
     * a restore overwrites live data and cannot be undone otherwise.
     *
     * @throws RuntimeException when the file is missing or the restore fails.
     */
    public static function restore(string $file): void
    {
        if (! is_file($file)) {
            throw new RuntimeException("Backup file not found: {$file}");
        }

        $driver = config('database.default');
        match ($driver) {
            'pgsql' => self::restorePostgres($file),
            'sqlite' => self::restoreSqlite($file),
            default => throw new RuntimeException(
                "Database restore is not supported for driver '{$driver}' — only pgsql and sqlite."
            ),
        };
    }

    // ------------------------------------------------------------------
    // PostgreSQL
    // ------------------------------------------------------------------

    /** Stream pg_dump into $path (gzipped). Returns the method string. */
    private static function dumpPostgres(string $path): string
    {
        self::requireBinary('pg_dump', 'postgresql-client');

        $cfg = config('database.connections.pgsql');
        $command = [
            'pg_dump',
            '--no-owner',
            '--no-acl',
            '--clean',
            '--if-exists',
            '-h', (string) ($cfg['host'] ?? '127.0.0.1'),
            '-p', (string) ($cfg['port'] ?? 5432),
            '-U', (string) ($cfg['username'] ?? 'postgres'),
            '-d', (string) ($cfg['database'] ?? 'postgres'),
        ];

        $gz = gzopen($path, 'wb9');
        if ($gz === false) {
            throw new RuntimeException("Could not open backup file for writing: {$path}");
        }
        try {
            $process = new Process($command, null, self::pgEnv($cfg), null, 900);
            $process->run(function ($type, $buffer) use ($gz): void {
                if ($type === Process::OUT) {
                    gzwrite($gz, $buffer);
                }
            });
            if (! $process->isSuccessful()) {
                throw new RuntimeException(
                    'pg_dump failed: '.self::tailLines(self::redact($process->getErrorOutput(), $cfg), 10)
                );
            }
        } finally {
            gzclose($gz);
        }

        return 'pg_dump';
    }

    /** Restore a .sql[.gz] dump via psql (ON_ERROR_STOP so a bad dump fails loudly). */
    private static function restorePostgres(string $file): void
    {
        self::requireBinary('psql', 'postgresql-client');

        $cfg = config('database.connections.pgsql');
        $sql = self::decompressToTemp($file, 'sql');

        try {
            $process = new Process([
                'psql',
                '-v', 'ON_ERROR_STOP=1',
                '-h', (string) ($cfg['host'] ?? '127.0.0.1'),
                '-p', (string) ($cfg['port'] ?? 5432),
                '-U', (string) ($cfg['username'] ?? 'postgres'),
                '-d', (string) ($cfg['database'] ?? 'postgres'),
                '-f', $sql,
            ], null, self::pgEnv($cfg), null, 900);
            $process->run();
            if (! $process->isSuccessful()) {
                throw new RuntimeException(
                    'psql restore failed: '.self::tailLines(self::redact($process->getErrorOutput(), $cfg), 10)
                );
            }
        } finally {
            @unlink($sql);
        }
    }

    /** Environment for pg_dump/psql: password ONLY via env, never argv. */
    private static function pgEnv(array $cfg): array
    {
        $env = ['PGCONNECT_TIMEOUT' => '10'];
        if (! empty($cfg['password'])) {
            $env['PGPASSWORD'] = (string) $cfg['password'];
        }

        return $env;
    }

    // ------------------------------------------------------------------
    // SQLite
    // ------------------------------------------------------------------

    /** Copy the live SQLite file (consistent .backup when possible). */
    private static function dumpSqlite(string $path): string
    {
        $dbFile = config('database.connections.sqlite.database');
        if ($dbFile === ':memory:' || $dbFile === '' || $dbFile === null) {
            throw new RuntimeException(
                'Cannot back up an in-memory SQLite database (:memory:) — it has no file. '.
                'Use a file database (local dev default) or PostgreSQL.'
            );
        }
        if (! is_file($dbFile)) {
            throw new RuntimeException("SQLite database file not found: {$dbFile}");
        }

        $tmp = $path.'.tmp.sqlite';
        $method = 'sqlite-copy';
        if (self::binaryExists('sqlite3')) {
            // .backup takes a consistent snapshot even while the app
            // writes — unlike a raw copy. The destination is quoted
            // inside the dot-command (SQLite string literal escaping).
            $quoted = str_replace("'", "''", $tmp);
            $process = new Process(
                ['sqlite3', $dbFile, ".backup '{$quoted}'"],
                null, null, null, 300
            );
            $process->run();
            if ($process->isSuccessful() && is_file($tmp)) {
                $method = 'sqlite-backup';
            } else {
                // Fall through to a plain copy; the method string says so.
                @unlink($tmp);
            }
        }
        if ($method === 'sqlite-copy') {
            if (! copy($dbFile, $tmp)) {
                throw new RuntimeException("Could not copy SQLite database file: {$dbFile}");
            }
        }

        self::gzipFile($tmp, $path);
        @unlink($tmp);

        return $method;
    }

    /** Restore a SQLite backup: decompress, then replace the DB file. */
    private static function restoreSqlite(string $file): void
    {
        $dbFile = config('database.connections.sqlite.database');
        if ($dbFile === ':memory:' || $dbFile === '' || $dbFile === null) {
            throw new RuntimeException(
                'Cannot restore into an in-memory SQLite database (:memory:) — it has no file.'
            );
        }

        $sql = self::decompressToTemp($file, 'sqlite');
        try {
            // Close the live connection FIRST: this app runs SQLite in
            // WAL mode, so an open handle still holds post-backup
            // transactions in its -wal file — if it closed AFTER the
            // copy, its checkpoint would write those transactions back
            // into the freshly restored file and resurrect the very
            // data the restore just replaced (found 2026-11-25: a
            // restore "succeeded" yet the mutated rows came back).
            // Closing first checkpoints the WAL into the CURRENT file
            // and drops the -wal; the copy below then replaces it.
            DB::purge('sqlite');
            if (! copy($sql, $dbFile)) {
                throw new RuntimeException("Could not write restored SQLite file: {$dbFile}");
            }
        } finally {
            @unlink($sql);
        }
        // Drop stale WAL sidecars from the replaced file (a stray -wal
        // must never shadow the restored database).
        @unlink($dbFile.'-wal');
        @unlink($dbFile.'-shm');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static function requireBinary(string $binary, string $package): void
    {
        if (! self::binaryExists($binary)) {
            throw new RuntimeException(
                "'{$binary}' is not installed on this server. The Docker image installs it ".
                "via the '{$package}' package — deploy the current image, then retry."
            );
        }
    }

    private static function binaryExists(string $binary): bool
    {
        $process = new Process(['which', $binary]);
        $process->run();

        return $process->isSuccessful();
    }

    /** Gzip $source into $dest (streamed, chunk by chunk). */
    private static function gzipFile(string $source, string $dest): void
    {
        $in = fopen($source, 'rb');
        $out = gzopen($dest, 'wb9');
        if ($in === false || $out === false) {
            if ($in !== false) {
                fclose($in);
            }
            if ($out !== false) {
                gzclose($out);
            }
            throw new RuntimeException("Could not compress backup file: {$dest}");
        }
        while (! feof($in)) {
            $chunk = fread($in, 1 << 20);
            if ($chunk !== false && $chunk !== '') {
                gzwrite($out, $chunk);
            }
        }
        fclose($in);
        gzclose($out);
    }

    /** Decompress a .sql.gz (or copy a plain .sql) to a temp file. Returns its path. */
    private static function decompressToTemp(string $file, string $suffix): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'clipper-restore-').'.'.$suffix;
        if (str_ends_with($file, '.gz')) {
            $in = gzopen($file, 'rb');
            $out = fopen($tmp, 'wb');
            if ($in === false || $out === false) {
                if ($in !== false) {
                    gzclose($in);
                }
                if ($out !== false) {
                    fclose($out);
                }
                throw new RuntimeException("Could not read backup file: {$file}");
            }
            while (! gzeof($in)) {
                $chunk = gzread($in, 1 << 20);
                if ($chunk !== false && $chunk !== '') {
                    fwrite($out, $chunk);
                }
            }
            gzclose($in);
            fclose($out);
        } elseif (! copy($file, $tmp)) {
            throw new RuntimeException("Could not read backup file: {$file}");
        }

        return $tmp;
    }

    /** Upload a finished backup to the admin's configured cloud bucket. Returns the cloud key. */
    private static function uploadToCloud(User $owner, string $path, string $filename): ?string
    {
        $disk = MediaStorage::buildCloudDisk($owner);
        if ($disk === null) {
            return null;
        }
        $key = self::BACKUP_DIR.'/'.$filename;
        if (! $disk->put($key, file_get_contents($path))) {
            throw new RuntimeException("Cloud upload failed for key {$key} (put returned false).");
        }

        return $key;
    }

    /** Last $n lines of a process error stream, for a readable failure. */
    private static function tailLines(string $text, int $n): string
    {
        $lines = array_filter(array_map('trim', explode("\n", $text)));
        $lines = array_slice($lines, -$n);

        return $lines === [] ? '(no error output)' : implode(' | ', $lines);
    }

    /** Redact the DB password if it ever appears in process output. */
    private static function redact(string $text, array $cfg): string
    {
        $password = (string) ($cfg['password'] ?? '');
        if ($password !== '' && str_contains($text, $password)) {
            $text = str_replace($password, '***', $text);
        }

        return $text;
    }
}
