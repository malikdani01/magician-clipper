<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Batch 12 (2026-11-25): campaign requirements — per-clip attached
 * post captions and the compliance checklist.
 *
 * clips: the worker reports each clip's own title + hashtags (derived
 * from that clip's own transcript), its post caption (required verbatim
 * or auto-derived), whether the caption came from the campaign, the
 * exact OST text actually burned, and which required items it applied.
 *
 * processing_jobs: campaign_checklist (computed by the server on job
 * completion — one pass/fail entry per required item) and
 * campaign_manual_checks (the brief lines the user flagged as manual
 * checks, with their ticked state). All nullable: jobs made before
 * this batch, and non-campaign jobs, simply have none.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->string('title_suggestion')->nullable();
            $table->json('hashtags')->nullable();
            $table->text('post_caption')->nullable();
            $table->string('caption_source')->nullable();
            $table->string('ost_burned_text')->nullable();
            $table->json('required_items_applied')->nullable();
        });

        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->json('campaign_checklist')->nullable();
            $table->json('campaign_manual_checks')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('clips', function (Blueprint $table) {
            $table->dropColumn([
                'title_suggestion',
                'hashtags',
                'post_caption',
                'caption_source',
                'ost_burned_text',
                'required_items_applied',
            ]);
        });

        Schema::table('processing_jobs', function (Blueprint $table) {
            $table->dropColumn(['campaign_checklist', 'campaign_manual_checks']);
        });
    }
};
