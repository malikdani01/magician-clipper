<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Per-signal score breakdown for a clip (e.g. {"hook": 92,
     * "retention": 78, "clarity": 85}) — the worker's explainable
     * scoring detail behind the single 0-1 score. Nullable: clips
     * rendered before the worker sent breakdowns carry null.
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->json('score_breakdown')->nullable()->after('score');
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn('score_breakdown');
        });
    }
};
