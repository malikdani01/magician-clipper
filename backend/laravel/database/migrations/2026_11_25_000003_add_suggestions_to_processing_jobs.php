<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 4 (2026-11-25): title + hashtag suggestions the worker
     * derives from the job's own transcript. Nullable: a silent job
     * has no transcript to derive from, and the job page says so.
     */
    public function up(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->string('title_suggestion', 120)->nullable()->after('note');
            $table->json('hashtags')->nullable()->after('title_suggestion');
        });
    }

    public function down(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn(['title_suggestion', 'hashtags']);
        });
    }
};
