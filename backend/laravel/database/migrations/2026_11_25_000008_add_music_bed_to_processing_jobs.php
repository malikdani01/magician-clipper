<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 9 (2026-11-25): optional music bed per job. Nullable:
     * jobs created without a bed (the normal case) have neither
     * column set, and the UI says "No music bed" honestly. The file
     * itself lives on the local disk under music-beds/{job_id}/.
     */
    public function up(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->string('music_bed_path')->nullable()->after('source_path');
            $table->string('music_bed_name')->nullable()->after('music_bed_path');
        });
    }

    public function down(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn(['music_bed_path', 'music_bed_name']);
        });
    }
};
