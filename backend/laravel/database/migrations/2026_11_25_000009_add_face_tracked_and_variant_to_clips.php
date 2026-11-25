<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 9 (2026-11-25): per-clip face tracking flag (reported by
     * the worker in storeClip; default false — the worker does not
     * send it for clips rendered before this batch, and those clips
     * honestly read as "not tracked" rather than inventing a value)
     * and the Variant B link: variant_of_clip_id points at the
     * Variant A clip of the same job (null = this clip is an
     * original, not a variant).
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->boolean('face_tracked')->default(false)->after('is_favourite');
            $table->unsignedBigInteger('variant_of_clip_id')->nullable()->after('face_tracked');
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn(['face_tracked', 'variant_of_clip_id']);
        });
    }
};
