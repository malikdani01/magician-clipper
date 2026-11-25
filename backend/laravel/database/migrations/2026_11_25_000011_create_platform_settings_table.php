<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 10 (2026-11-25): platform-wide settings, stored as
     * key/value rows. The table starts EMPTY — every key falls back
     * to its code default (see App\Support\PlatformSettings) until an
     * admin saves a value in Admin Panel → Platform Controls. No
     * migration ever writes a setting row: deploy-time code must
     * never change live settings.
     */
    public function up(): void
    {
        Schema::create('platform_settings', function (Blueprint $table) {
            $table->string('key')->primary();
            $table->text('value')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('platform_settings');
    }
};
