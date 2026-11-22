<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * One row per clip re-render request: the user picks a different
     * caption style for an existing clip, the Muse worker picks the
     * queued request up, re-renders the SAME window with the new style,
     * and replaces the clip file in place. Statuses: queued |
     * processing | ready | failed. A rerender is NOT a new job — it
     * never appears in the jobs list and never counts toward job usage.
     */
    public function up(): void
    {
        Schema::create('clip_rerenders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('clip_id')->constrained('clips')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('caption_style');
            // queued | processing | ready | failed
            $table->string('status')->default('queued');
            $table->text('error_message')->nullable();
            $table->timestamps();

            $table->index(['clip_id', 'status']);
            $table->index('status');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('clip_rerenders');
    }
};
