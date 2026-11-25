<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 11 (2026-11-25): a user's request for a paid plan. The
 * admin approves (creates the user_plan) or declines (with a reason)
 * in Admin Panel → Plan Requests. Payment happens outside the app.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('plan_requests', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('plan_id')->constrained()->restrictOnDelete();
            $table->text('note')->nullable();
            $table->string('status', 20)->default('pending');
            $table->text('decline_reason')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'status']);
            $table->index(['status', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('plan_requests');
    }
};
