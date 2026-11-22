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
        Schema::create('clips', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained('projects')->cascadeOnDelete();
            $table->foreignId('job_id')->nullable()->constrained('processing_jobs')->nullOnDelete();
            $table->string('title');
            $table->float('start_seconds');
            $table->float('end_seconds');
            $table->float('duration_seconds');
            // 9:16 | 16:9 | 1:1 | 4:5
            $table->string('aspect_ratio')->default('9:16');
            // pending | rendering | ready | failed
            $table->string('status')->default('pending');
            $table->string('output_path')->nullable();
            $table->unsignedBigInteger('file_size_bytes')->nullable();
            // Explainable highlight score (0-100) + contributing signals.
            $table->float('score')->nullable();
            $table->text('reason')->nullable();
            $table->text('transcript_excerpt')->nullable();
            $table->timestamps();

            $table->index(['project_id', 'status']);
            $table->index(['job_id', 'status']);
            $table->index('score');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('clips');
    }
};
