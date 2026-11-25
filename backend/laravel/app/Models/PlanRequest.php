<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A user's request for a paid plan (Batch 11). Pending until an
 * admin approves (creates the user_plan) or declines (with a reason)
 * in Admin Panel → Plan Requests.
 */
class PlanRequest extends Model
{
    public const STATUS_PENDING = 'pending';
    public const STATUS_APPROVED = 'approved';
    public const STATUS_DECLINED = 'declined';

    protected $fillable = [
        'user_id',
        'plan_id',
        'note',
        'status',
        'decline_reason',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function plan()
    {
        return $this->belongsTo(Plan::class);
    }
}
