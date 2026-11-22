<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Job states (spec §11): uploaded, queued, probing, extracting_audio,
     * transcribing, detecting_scenes, analyzing, selecting_clips, rendering,
     * captioning, validating, completed, failed, cancelling, cancelled.
     * Transitions are enforced in App\Models\ProcessingJob::VALID_TRANSITIONS.
     */
    public function up(): void
    {
        Schema::create('processing_jobs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained('projects')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('media_asset_id')->nullable()->constrained('media_assets')->nullOnDelete();
            $table->string('state')->default('uploaded');
            // Human-readable stage label mirroring the pipeline step
            // (Checking media, Extracting audio, Transcribing, ...).
            $table->string('stage')->nullable();
            // Real percentage only when measurable; null = indeterminate.
            $table->unsignedTinyInteger('progress')->nullable();
            $table->string('error_code')->nullable();
            $table->text('error_message')->nullable();
            // Id of the corresponding job in the Python video-engine, if any.
            $table->string('engine_job_id')->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();

            $table->index(['project_id', 'state']);
            $table->index(['user_id', 'state']);
            $table->index('state');
            $table->index('engine_job_id');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('processing_jobs');
    }
};
