<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 15 — Viral Intelligence (2026-11-28): per-clip hook score
 * and retention curve, both measured by the worker from real signals
 * (never guessed), plus the loop-perfect flag.
 *
 * clips.hook_score: 0–100 opening-hook score for the clip's first
 * 3 seconds (speech density + opening energy vs the clip average +
 * question/exclamation + face present); null on clips rendered
 * before this batch or on clips the worker could not score.
 * clips.hook_reason: the measured facts behind the score, e.g.
 * "7 words in first 3s, opening louder than clip average, face on
 * screen"; null when there is no score.
 * clips.retention_curve: JSON array of per-second 0–100 attention
 * estimates (one entry per second of the rendered clip), from speech
 * density + audio RMS + visual change; null on older clips.
 * clips.loop_ready: true only when the job asked for loop-perfect
 * AND the worker matched the end frame to the start frame and baked
 * the 0.3s audio fades (false otherwise — never claimed in advance).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->integer('hook_score')->nullable();
            $table->string('hook_reason')->nullable();
            $table->json('retention_curve')->nullable();
            $table->boolean('loop_ready')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn(['hook_score', 'hook_reason', 'retention_curve', 'loop_ready']);
        });
    }
};
