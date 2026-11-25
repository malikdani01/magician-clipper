<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Append-only audit trail for admin actions (Batch 10).
 *
 * One row per admin action: who did it, what they did, which record
 * it targeted, and the details (never passwords or secret values).
 * The Admin Panel → System Logs page reads this table.
 */
class AdminActivityLog extends Model
{
    /** The table name does not follow Laravel's plural convention. */
    protected $table = 'admin_activity_log';

    /** Rows are written once and never updated. */
    public $timestamps = false;

    protected $fillable = [
        'admin_id',
        'action',
        'target_type',
        'target_id',
        'details',
        'created_at',
    ];

    protected function casts(): array
    {
        return [
            'details' => 'array',
            'created_at' => 'datetime',
        ];
    }

    public function admin()
    {
        return $this->belongsTo(User::class, 'admin_id');
    }

    /**
     * Record one admin action. Call this on EVERY admin mutation —
     * the Logs page is the proof that an action happened.
     * $details must never contain a password or secret value.
     */
    public static function record(User $admin, string $action, ?string $targetType = null, mixed $targetId = null, array $details = []): static
    {
        return static::create([
            'admin_id' => $admin->id,
            'action' => $action,
            'target_type' => $targetType,
            'target_id' => $targetId === null ? null : (int) $targetId,
            'details' => $details === [] ? null : $details,
            'created_at' => now(),
        ]);
    }
}
