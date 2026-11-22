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
     * Usage:
     *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<strong-password>' \
     *     php artisan db:seed
     *
     * Without ADMIN_EMAIL and ADMIN_PASSWORD the seeder creates nothing
     * and prints a warning.
     */
    public function run(): void
    {
        $email = env('ADMIN_EMAIL');
        $password = env('ADMIN_PASSWORD');

        if (empty($email) || empty($password)) {
            $this->command->warn(
                'DatabaseSeeder: ADMIN_EMAIL / ADMIN_PASSWORD not set — nothing seeded. '.
                'Set both env vars to create the initial admin user.'
            );

            return;
        }

        $admin = User::firstOrCreate(
            ['email' => $email],
            [
                'name' => env('ADMIN_NAME', 'Admin'),
                'password' => Hash::make($password),
                'role' => 'admin',
                'plan' => 'free',
            ]
        );

        if ($admin->wasRecentlyCreated) {
            $this->command->info("DatabaseSeeder: admin user created ({$email}).");
        } else {
            $this->command->info("DatabaseSeeder: admin user already exists ({$email}); password unchanged.");
        }
    }
}
