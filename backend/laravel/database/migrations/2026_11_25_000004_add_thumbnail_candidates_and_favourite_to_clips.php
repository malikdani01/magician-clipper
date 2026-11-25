<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 4 (2026-11-25): thumbnail-picker candidates (up to 3
     * frame paths the worker extracted per clip) and the per-clip
     * favourite flag. Nullable candidates: clips rendered before
     * this batch have none, and the picker says so honestly.
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->json('thumbnail_candidates')->nullable()->after('thumbnail_path');
            $table->boolean('is_favourite')->default(false)->after('thumbnail_candidates');
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn(['thumbnail_candidates', 'is_favourite']);
        });
    }
};
