<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 11 (2026-11-25): Google sign-in. google_id links a Google
 * account to a local user (matched by email first — an existing
 * account is linked, a new email creates the account). Null for
 * email/password-only accounts; unique so one Google account can
 * never link to two local users.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('google_id')->nullable()->unique()->after('email');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('google_id');
        });
    }
};
