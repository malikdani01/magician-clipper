<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 15 — Viral Intelligence (2026-11-28): clip performance
 * tracking. Rows are USER-ENTERED ONLY — the numbers a clip actually
 * got after the user posted it (views / likes / comments / shares).
 * Nothing here is ever measured by the system or fabricated: a clip
 * with no rows simply has no posted results, and every aggregation
 * built on this table shows an honest empty state instead.
 *
 * One row per save (the latest row per clip is the current result);
 * posting the same clip on two platforms is two rows. Deleting the
 * clip deletes its rows (cascade).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('clip_performances', function (Blueprint $table) {
            $table->id();
            $table->foreignId('clip_id')->constrained('clips')->cascadeOnDelete();
            $table->string('platform');
            $table->unsignedInteger('views')->default(0);
            $table->unsignedInteger('likes')->default(0);
            $table->unsignedInteger('comments')->default(0);
            $table->unsignedInteger('shares')->default(0);
            $table->date('posted_at')->nullable();
            $table->string('notes')->nullable();
            $table->timestamps();
            $table->index('clip_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('clip_performances');
    }
};
