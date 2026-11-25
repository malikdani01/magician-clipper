<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 11 (2026-11-25): a user's bought plan. One active plan per
 * user at a time — approving/assigning a new plan ends the old one
 * early (status 'revoked', ends_at = now). Expiry is LAZY: no cron
 * ever flips it; every gated call re-checks ends_at and treats a
 * passed plan as Free immediately.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_plans', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            // restrictOnDelete: a plan that was ever bought cannot be
            // deleted while its history exists (the admin UI blocks
            // the delete too — this is the database backstop).
            $table->foreignId('plan_id')->constrained()->restrictOnDelete();
            $table->timestamp('starts_at');
            $table->timestamp('ends_at');
            $table->unsignedInteger('clips_used')->default(0);
            $table->string('status', 20)->default('active');
            $table->timestamps();

            $table->index(['user_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_plans');
    }
};
