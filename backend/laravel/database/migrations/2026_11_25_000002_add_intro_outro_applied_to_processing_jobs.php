<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Whether the worker actually stitched the user's brand-kit
     * intro / outro onto this job's clips (2026-11-25). The worker
     * reports both flags with its final Ready status; the frontend
     * renders a badge from them. Default false: old jobs and jobs
     * rendered without brand assets simply never had them applied.
     */
    public function up(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->boolean('intro_applied')->default(false);
            $table->boolean('outro_applied')->default(false);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn(['intro_applied', 'outro_applied']);
        });
    }
};
