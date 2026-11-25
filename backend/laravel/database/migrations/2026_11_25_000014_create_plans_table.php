<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 11 (2026-11-25): paid plans. Plans are created by the admin
 * in Admin Panel → Plans — there is NO seeded paid plan and NO
 * payment gateway. Payment happens outside the app; the admin
 * activates a plan after confirming it (manual flow, like the SMM
 * panel). A user with no active plan is on the Free plan, whose
 * limits come from the Batch 10 platform settings.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('plans', function (Blueprint $table) {
            $table->id();
            $table->string('name', 100);
            // Display price only ("Rs 499", "$9.99") — no money ever
            // moves through the app, so there is no numeric price.
            $table->string('price_display', 100);
            $table->unsignedInteger('duration_days');
            // Total clips the plan covers over its whole lifetime
            // (null = unlimited). Counted from rendered clip rows.
            $table->unsignedInteger('total_clips')->nullable();
            // Clips (jobs) per day under this plan (null = the free
            // platform default applies).
            $table->unsignedInteger('daily_clips')->nullable();
            // Export tier: '720p' (free tier) or '1080p'.
            $table->string('max_export_quality', 10)->default('720p');
            $table->json('features')->nullable();
            $table->boolean('active')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('plans');
    }
};
