<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Default caption style for new jobs (punchy by default).
     * The column default fills existing rows with 'punchy'; the
     * worker also defaults to 'punchy' when a job has no caption_style.
     */
    public function up(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->string('caption_style', 16)->default('punchy')->after('default_quality');
        });
    }

    public function down(): void
    {
        Schema::table('user_settings', function (Blueprint $table) {
            $table->dropColumn('caption_style');
        });
    }
};
