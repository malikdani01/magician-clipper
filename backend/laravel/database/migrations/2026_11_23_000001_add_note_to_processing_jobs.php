<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The worker reports human-readable job notes through the status
     * endpoint (e.g. "only 2 of 5 requested clips could be selected —
     * the source has very little speech"). The job page shows the note
     * so the user always knows WHY fewer clips came back, instead of
     * guessing. Nullable: old jobs simply have no note.
     */
    public function up(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->text('note')->nullable()->after('error_message');
        });
    }

    public function down(): void
    {
        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn('note');
        });
    }
};
