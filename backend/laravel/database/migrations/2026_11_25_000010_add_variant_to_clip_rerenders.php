<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 9 (2026-11-25): A/B variant re-renders. A variant row is
     * a re-render request that renders a NEW clip (Variant B) instead
     * of replacing the original file in place; is_variant marks it,
     * and variant_headline_style (null = same headline as the job)
     * records the headline look the variant was rendered with.
     */
    public function up(): void
    {
        Schema::table('clip_rerenders', function (Blueprint $table) {
            $table->boolean('is_variant')->default(false)->after('caption_style');
            $table->string('variant_headline_style')->nullable()->after('is_variant');
        });
    }

    public function down(): void
    {
        Schema::table('clip_rerenders', function (Blueprint $table) {
            $table->dropColumn(['is_variant', 'variant_headline_style']);
        });
    }
};
