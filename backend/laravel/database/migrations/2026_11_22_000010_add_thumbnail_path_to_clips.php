<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            // First-frame JPEG of the rendered clip, extracted by the
            // worker (which owns ffmpeg) at upload time and served by
            // GET /api/v1/clips/{clip}/thumbnail. Null for clips
            // rendered before thumbnails existed.
            $table->string('thumbnail_path')->nullable()->after('output_path');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn('thumbnail_path');
        });
    }
};
