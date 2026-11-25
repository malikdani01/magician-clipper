<?php

namespace Tests\Feature;

use App\Models\User;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Batch 9 (2026-11-25): the admin changes their own email + password
 * in Admin Panel → Settings (PATCH /api/v1/admin/settings/credentials),
 * and the seeder is create-only by role — it never touches credentials
 * after the first admin exists, so a panel change survives deploys.
 *
 * No credential value is asserted in plaintext beyond the test's own
 * inputs (the factory password is 'password'; the new test passwords
 * exist only inside this test file).
 */
class AdminCredentialsTest extends TestCase
{
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'current_password' => 'password',
            'new_email' => 'admin-new@example.com',
            'new_password' => 'new-password-123',
            'new_password_confirmation' => 'new-password-123',
        ], $overrides);
    }

    public function test_admin_can_change_their_own_credentials(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'admin@example.com']);

        $this->actingAs($admin, 'sanctum')
            ->patchJson('/api/v1/admin/settings/credentials', $this->payload())
            ->assertStatus(200)
            ->assertJsonPath('admin.email', 'admin-new@example.com');

        $admin->refresh();
        $this->assertSame('admin-new@example.com', $admin->email);
        $this->assertTrue(Hash::check('new-password-123', $admin->password));
        $this->assertFalse(Hash::check('password', $admin->password));
        $this->assertSame(1, User::where('role', 'admin')->count());
    }

    public function test_wrong_current_password_changes_nothing(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'admin@example.com']);

        $this->actingAs($admin, 'sanctum')
            ->patchJson(
                '/api/v1/admin/settings/credentials',
                $this->payload(['current_password' => 'not-the-password'])
            )
            ->assertStatus(422)
            ->assertJsonValidationErrors(['current_password']);

        $admin->refresh();
        $this->assertSame('admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('password', $admin->password));
        $this->assertSame(1, User::where('role', 'admin')->count());
    }

    public function test_email_taken_by_another_user_changes_nothing(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'admin@example.com']);
        User::factory()->create(['email' => 'someone@example.com']);

        $this->actingAs($admin, 'sanctum')
            ->patchJson(
                '/api/v1/admin/settings/credentials',
                $this->payload(['new_email' => 'someone@example.com'])
            )
            ->assertStatus(422)
            ->assertJsonValidationErrors(['new_email']);

        $admin->refresh();
        $this->assertSame('admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('password', $admin->password));
    }

    public function test_short_password_and_mismatched_confirmation_are_rejected(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'admin@example.com']);

        $this->actingAs($admin, 'sanctum')
            ->patchJson(
                '/api/v1/admin/settings/credentials',
                $this->payload(['new_password' => 'short', 'new_password_confirmation' => 'short'])
            )
            ->assertStatus(422)
            ->assertJsonValidationErrors(['new_password']);

        $this->actingAs($admin, 'sanctum')
            ->patchJson(
                '/api/v1/admin/settings/credentials',
                $this->payload(['new_password_confirmation' => 'different-password-123'])
            )
            ->assertStatus(422)
            ->assertJsonValidationErrors(['new_password']);

        $admin->refresh();
        $this->assertSame('admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('password', $admin->password));
    }

    public function test_non_admin_cannot_change_admin_credentials(): void
    {
        $user = User::factory()->create(['role' => 'user', 'email' => 'user@example.com']);
        $admin = User::factory()->admin()->create(['email' => 'admin@example.com']);

        $this->actingAs($user, 'sanctum')
            ->patchJson('/api/v1/admin/settings/credentials', $this->payload())
            ->assertStatus(403);

        $admin->refresh();
        $this->assertSame('admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('password', $admin->password));
    }

    public function test_seeder_does_nothing_when_an_admin_already_exists(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'panel-admin@example.com']);

        putenv('ADMIN_EMAIL=env-admin@example.com');
        putenv('ADMIN_PASSWORD=env-password-123');
        try {
            $this->seed(DatabaseSeeder::class);
        } finally {
            putenv('ADMIN_EMAIL');
            putenv('ADMIN_PASSWORD');
        }

        // No duplicate, no email/password change — the panel is the
        // source of truth once an admin exists.
        $this->assertSame(1, User::where('role', 'admin')->count());
        $admin->refresh();
        $this->assertSame('panel-admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('password', $admin->password));
    }

    public function test_seeder_creates_an_admin_when_none_exists(): void
    {
        $this->assertSame(0, User::where('role', 'admin')->count());

        putenv('ADMIN_EMAIL=seeded-admin@example.com');
        putenv('ADMIN_PASSWORD=seeded-password-123');
        try {
            $this->seed(DatabaseSeeder::class);
        } finally {
            putenv('ADMIN_EMAIL');
            putenv('ADMIN_PASSWORD');
        }

        $this->assertSame(1, User::where('role', 'admin')->count());
        $admin = User::where('role', 'admin')->first();
        $this->assertSame('seeded-admin@example.com', $admin->email);
        $this->assertTrue(Hash::check('seeded-password-123', $admin->password));
    }
}
