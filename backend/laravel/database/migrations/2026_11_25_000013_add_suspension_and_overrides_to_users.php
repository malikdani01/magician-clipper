<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 10 (2026-11-25): per-user admin controls.
     * - suspended_at: set when an admin suspends the account; a
     *   suspended user cannot log in and cannot create jobs.
     * - daily_limit_override / max_clips_override: per-user limits
     *   that replace the platform defaults for this user only
     *   (null = use the platform setting).
     * All three are null for every existing user — no behaviour
     * changes until an admin sets one.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->timestamp('suspended_at')->nullable()->after('storage_quota_mb');
            $table->unsignedInteger('daily_limit_override')->nullable()->after('suspended_at');
            $table->unsignedInteger('max_clips_override')->nullable()->after('daily_limit_override');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['suspended_at', 'daily_limit_override', 'max_clips_override']);
        });
    }
};
