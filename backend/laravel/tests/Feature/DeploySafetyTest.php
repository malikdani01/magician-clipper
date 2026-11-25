<?php

namespace Tests\Feature;

use App\Models\CloudStorageSetting;
use App\Models\JobPreset;
use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Batch 9 (2026-11-25) — deploy safety: anything the user has set
 * and saved must NEVER change on a new deploy. The deploy runs
 * `php artisan migrate --force` + `php artisan db:seed --force`
 * (docker-entrypoint.sh + render.yaml preDeployCommand), so this
 * test re-runs exactly those two commands against a database that
 * already holds edited user data — and asserts EVERYTHING is
 * byte-identical afterwards: settings, presets, cloud settings,
 * admin email + password hash.
 *
 * The audit behind it (2026-11-25): no updateOrCreate anywhere in
 * app/ or database/; SettingsController firstOrCreate creates
 * defaults only when the row is missing; Notification firstOrCreate
 * is keyed on the unique (job_id, type); no migration writes data
 * except the one-time project-status backfill (already ran, never
 * re-runs); the seeder is create-only by role. This test is the
 * proof that the whole deploy path honours that rule.
 */
class DeploySafetyTest extends TestCase
{
    use RefreshDatabase;

    public function test_deploy_rerun_changes_nothing(): void
    {
        // --- Arrange: a user who has edited everything. ---
        $user = User::factory()->create();
        UserSetting::create([
            'user_id' => $user->id,
            'default_processing_mode' => 'fast',
            'default_aspect_ratio' => '16:9',
            'default_caption_preset' => 'Comic Pop',
            'default_quality' => 'high',
            'caption_style' => 'marker',
            'notifications_enabled' => false,
            'theme' => 'light',
            'language' => 'ur',
        ]);
        JobPreset::create([
            'user_id' => $user->id,
            'name' => 'Parity proof preset',
            'settings' => [
                'caption_style' => 'typewriter',
                'layout' => 'blur_fill',
                'quality' => 'high',
                'duration_mode' => 'minimum',
                'duration_min_seconds' => 50,
                'duration_max_seconds' => 90,
            ],
        ]);
        CloudStorageSetting::create([
            'user_id' => $user->id,
            'provider' => 'r2',
            'endpoint' => 'https://example.r2.cloudflarestorage.com',
            'bucket' => 'clipper-backups-test',
            'region' => 'auto',
            'access_key_id' => 'test-access-key',
            'secret_access_key' => 'test-secret-value',
            'enabled' => true,
        ]);

        // --- Arrange: an admin whose credentials were changed IN THE
        // PANEL (not via env) — the exact case a deploy must not revert.
        $admin = User::factory()->create([
            'role' => 'admin',
            'email' => 'panel-admin@example.com',
            'password' => Hash::make('panel-changed-password-123'),
        ]);

        $snapshot = $this->snapshotRows();

        // --- Act: simulate a deploy. Env vars deliberately DISAGREE
        // with the panel-changed credentials — a sync-by-env seeder
        // would revert them here; the create-only seeder must not.
        putenv('ADMIN_EMAIL=env-admin@example.com');
        putenv('ADMIN_PASSWORD=env-password-value');
        try {
            $this->artisan('migrate', ['--force' => true]);
            $this->artisan('db:seed', ['--force' => true]);
        } finally {
            putenv('ADMIN_EMAIL');
            putenv('ADMIN_PASSWORD');
        }

        // --- Assert: byte-identical, every table. ---
        $this->assertSame($snapshot, $this->snapshotRows());
        $this->assertSame(1, User::where('role', 'admin')->count());
        $admin->refresh();
        $this->assertSame('panel-admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('panel-changed-password-123', $admin->password));
        $this->assertFalse(Hash::check('env-password-value', $admin->password));
    }

    /** Raw stored rows (incl. encrypted secret + password hash). */
    private function snapshotRows(): array
    {
        $rows = [];
        foreach (['users', 'user_settings', 'job_presets', 'cloud_storage_settings'] as $table) {
            $rows[$table] = DB::table($table)->orderBy('id')->get()
                ->map(fn ($row) => (array) $row)
                ->all();
        }

        return $rows;
    }
}
