<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Brand-kit intro/outro assets (2026-11-25): one short video clip
     * per user per kind, stitched onto rendered clips by the worker.
     * The unique (user_id, kind) index enforces "one intro, one
     * outro" — uploading again replaces the previous asset.
     */
    public function up(): void
    {
        Schema::create('brand_assets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('kind');
            $table->string('path');
            $table->string('original_name');
            $table->float('duration_seconds');
            $table->unsignedBigInteger('file_size_bytes');
            $table->timestamps();

            $table->unique(['user_id', 'kind']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('brand_assets');
    }
};
