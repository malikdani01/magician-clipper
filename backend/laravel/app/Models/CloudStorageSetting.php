<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class CloudStorageSetting extends Model
{
    use HasFactory;

    public const PROVIDERS = ['r2', 's3', 'custom'];

    /** R2's public S3 endpoint — the preset fills it in for the user. */
    public const R2_ENDPOINT = 'https://<account-id>.r2.cloudflarestorage.com';

    protected $fillable = [
        'user_id',
        'provider',
        'endpoint',
        'bucket',
        'region',
        'access_key_id',
        'secret_access_key',
        'enabled',
    ];

    protected function casts(): array
    {
        return [
            // The secret is stored ENCRYPTED in the DB (Laravel's
            // encrypted cast) — never plaintext, never in logs, never
            // returned by the API (see toUserArray()).
            'secret_access_key' => 'encrypted',
            'enabled' => 'boolean',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    /**
     * The shape the API returns: everything the settings page needs
     * EXCEPT the secret (which is never sent back — the page shows
     * "saved" and only overwrites it when the user types a new one).
     */
    public function toUserArray(): array
    {
        return [
            'provider' => $this->provider,
            'endpoint' => $this->endpoint,
            'bucket' => $this->bucket,
            'region' => $this->region,
            'access_key_id' => $this->access_key_id,
            'secret_saved' => $this->secret_access_key !== null && $this->secret_access_key !== '',
            'enabled' => (bool) $this->enabled,
        ];
    }
}
