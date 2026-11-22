<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Records which caption style was actually burned onto a clip.
     * A clip re-rendered with a different style must say so — the job
     * settings hold the ORIGINAL style, the clip holds the truth.
     * Nullable: clips rendered before this column keep no style.
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->string('caption_style')->nullable()->after('thumbnail_path');
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn('caption_style');
        });
    }
};
