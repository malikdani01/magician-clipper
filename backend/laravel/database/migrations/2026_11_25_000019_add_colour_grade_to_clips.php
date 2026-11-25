<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 13 (2026-11-25): automatic per-clip colour grading — the
 * worker reports the grade each clip actually rendered with and, for
 * an auto pick, the reason it chose it.
 *
 * clips.colour_grade_applied: the resolved look id (clean / vibrant /
 * warm / cool / cinematic / mono / vintage); null when grading was
 * off or the clip predates this batch.
 * clips.colour_grade_reason: the auto picker's reason, e.g. "dark —
 * brightened and lifted"; null for a manual look (the UI calls it
 * the "chosen look") and for ungraded clips. All nullable: clips
 * made before this batch simply have none.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->string('colour_grade_applied')->nullable();
            $table->string('colour_grade_reason')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn(['colour_grade_applied', 'colour_grade_reason']);
        });
    }
};
