<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 5 (2026-11-25): which disk a clip's / job's files live on.
     * 'local' is the Render/local disk as before; 'cloud' is the
     * user's configured S3-compatible bucket (see
     * cloud_storage_settings). Defaults to 'local', so every existing
     * record keeps working untouched.
     */
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->string('disk')->default('local')->after('output_path');
        });
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->string('disk')->default('local')->after('source_path');
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn('disk');
        });
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn('disk');
        });
    }
};
