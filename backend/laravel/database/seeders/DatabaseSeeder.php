<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the application's database.
     *
     * Creates ONLY an admin user, and ONLY when explicitly requested with
     * environment variables — credentials are never hard-coded and never
     * committed. No fake demo projects or users are seeded.
     *
     * CREATE-ONLY BY ROLE (Batch 9, 2026-11-25): if ANY user with
     * role='admin' already exists, this seeder does NOTHING — it never
     * updates email or password, and never creates a second admin. The
     * Admin Panel → Settings form is the source of truth for admin
     * credentials: the admin changes them there, and a deploy-time
     * sync (or a firstOrCreate keyed on email) would revert every
     * panel change — or duplicate the admin once the panel changes
     * the email. Only when NO admin exists at all is one created
     * from ADMIN_EMAIL / ADMIN_PASSWORD (+ ADMIN_NAME default).
     *
     * Usage:
     *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<strong-password>' \
     *     php artisan db:seed
     *
     * Without ADMIN_EMAIL and ADMIN_PASSWORD the seeder creates nothing
     * and prints a warning.
     */
    public function run(): void
    {
        if (User::where('role', 'admin')->exists()) {
            $this->command->info(
                'DatabaseSeeder: an admin user already exists — nothing changed. '.
                'Admin credentials are managed in Admin Panel → Settings.'
            );

            return;
        }

        $email = env('ADMIN_EMAIL');
        $password = env('ADMIN_PASSWORD');

        if (empty($email) || empty($password)) {
            $this->command->warn(
                'DatabaseSeeder: ADMIN_EMAIL / ADMIN_PASSWORD not set — nothing seeded. '.
                'Set both env vars to create the initial admin user.'
            );

            return;
        }

        User::create([
            'name' => env('ADMIN_NAME', 'Admin'),
            'email' => $email,
            'password' => Hash::make($password),
            'role' => 'admin',
            'plan' => 'free',
        ]);

        $this->command->info("DatabaseSeeder: admin user created ({$email}).");
    }
}
