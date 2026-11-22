<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Per-user settings (Phase 2, implemented in Phase 3 — FIX 2).
     * One row per user; the SettingsController creates it on first access
     * with the defaults below. No secrets are stored here.
     */
    public function up(): void
    {
        Schema::create('user_settings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->unique()->constrained('users')->cascadeOnDelete();
            $table->string('default_processing_mode', 16)->default('balanced');
            $table->string('default_aspect_ratio', 8)->default('9:16');
            $table->string('default_caption_preset', 100)->default('Bold Pop');
            $table->string('default_quality', 16)->default('standard');
            $table->boolean('notifications_enabled')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_settings');
    }
};
