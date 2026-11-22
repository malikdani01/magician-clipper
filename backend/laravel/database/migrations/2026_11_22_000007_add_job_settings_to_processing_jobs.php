<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Phase 3 (Muse-connected Job System): a job carries its source and its
     * full dropdown-only settings so the Muse worker can pick it up without
     * any chat round-trip.
     *
     * - settings: the validated job spec (platform, ratio, clip count,
     *   duration mode/seconds, captions + language, on-screen text,
     *   job type + campaign requirements, layout).
     * - source_type: 'upload' (file in Laravel storage) or 'link'.
     * - source_url: pasted link (YouTube / TikTok / Drive / direct MP4).
     * - source_path: relative path under storage/app for uploads
     *   (e.g. uploads/<uuid>.mp4). Internal paths are never exposed to
     *   normal users (spec §13); the Muse Job API returns them only to the
     *   key-authenticated worker running on the same machine.
     */
    public function up(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->json('settings')->nullable()->after('engine_job_id');
            $table->string('source_type', 16)->default('upload')->after('settings');
            $table->string('source_url')->nullable()->after('source_type');
            $table->string('source_path')->nullable()->after('source_url');
            $table->index(['state', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropIndex(['state', 'created_at']);
            $table->dropColumn(['settings', 'source_type', 'source_url', 'source_path']);
        });
    }
};
