<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Batch 5 (2026-11-25): one S3-compatible cloud-storage account
     * per user (Cloudflare R2 / AWS S3 / custom endpoint). The secret
     * is stored ENCRYPTED (see the model's 'encrypted' cast) — never
     * plaintext in the DB, never in logs. Disabled by default: until
     * the user fills this in AND turns it on, everything stays on the
     * local disk exactly as before.
     */
    public function up(): void
    {
        Schema::create('cloud_storage_settings', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('provider'); // r2 | s3 | custom
            $table->string('endpoint')->nullable();
            $table->string('bucket');
            $table->string('region');
            $table->string('access_key_id');
            $table->text('secret_access_key'); // encrypted cast on the model
            $table->boolean('enabled')->default(false);
            $table->timestamps();

            $table->unique(['user_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cloud_storage_settings');
    }
};
