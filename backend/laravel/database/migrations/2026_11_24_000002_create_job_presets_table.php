<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Saved job-setting presets: a user names a set of job settings
     * (platform, ratio, clip count, …) and reuses it when creating jobs.
     * Names are unique per user (enforced in the controller + here).
     */
    public function up(): void
    {
        Schema::create('job_presets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('name');
            $table->json('settings');
            $table->timestamps();

            $table->unique(['user_id', 'name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('job_presets');
    }
};
