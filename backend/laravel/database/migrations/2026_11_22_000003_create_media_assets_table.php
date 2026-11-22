<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('media_assets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained('projects')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('original_filename');
            // Server-generated filename; never trust the uploaded path (spec §13).
            $table->string('stored_filename')->unique();
            $table->string('mime')->nullable();
            $table->string('extension', 16);
            $table->unsignedBigInteger('size_bytes');
            // FFprobe-derived metadata (nullable until probing succeeds).
            $table->float('duration_seconds')->nullable();
            $table->unsignedInteger('width')->nullable();
            $table->unsignedInteger('height')->nullable();
            $table->float('fps')->nullable();
            $table->string('video_codec')->nullable();
            $table->string('audio_codec')->nullable();
            // Relative storage path (e.g. uploads/<uuid>.mp4). Internal
            // filesystem paths are never exposed to normal users (spec §13).
            $table->string('storage_path');
            // uploaded | probing | ready | failed
            $table->string('status')->default('uploaded');
            $table->timestamps();

            $table->index(['project_id', 'status']);
            $table->index(['user_id', 'created_at']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('media_assets');
    }
};
