<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 5 (2026-11-25): appearance + language preferences on the
     * per-user settings row. Dark Aurora stays the default; Roman Urdu
     * is opt-in. Absent on older rows means the defaults (the backend
     * treats null as 'dark'/'en' too, so a pre-batch row behaves).
     */
    public function up(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->string('theme')->default('dark')->after('notifications_enabled');
            $table->string('language')->default('en')->after('theme');
        });
    }

    public function down(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->dropColumn(['theme', 'language']);
        });
    }
};
