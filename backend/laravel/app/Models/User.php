<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    /** @use HasFactory<\Database\Factories\UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var list<string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'role',
        'plan',
        'storage_quota_mb',
        // Batch 11: Google sign-in link (null for password-only accounts).
        'google_id',
        // Batch 10: admin-set suspension + per-user limit overrides.
        'suspended_at',
        'daily_limit_override',
        'max_clips_override',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var list<string>
     */
    protected $hidden = [
        'password',
        'remember_token',
    ];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'storage_quota_mb' => 'integer',
            // Batch 10: suspension + per-user limit overrides.
            'suspended_at' => 'datetime',
            'daily_limit_override' => 'integer',
            'max_clips_override' => 'integer',
        ];
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    /** Batch 10: a suspended account cannot log in or create jobs. */
    public function isSuspended(): bool
    {
        return $this->suspended_at !== null;
    }

    public function projects()
    {
        return $this->hasMany(Project::class);
    }

    public function mediaAssets()
    {
        return $this->hasMany(MediaAsset::class);
    }

    public function processingJobs()
    {
        return $this->hasMany(ProcessingJob::class);
    }

    public function exports()
    {
        return $this->hasMany(Export::class);
    }

    public function jobPresets()
    {
        return $this->hasMany(JobPreset::class);
    }

    public function brandAssets()
    {
        return $this->hasMany(BrandAsset::class);
    }

    /** Batch 11: bought plans (at most one active at a time). */
    public function userPlans()
    {
        return $this->hasMany(UserPlan::class);
    }

    /** Batch 11: requests for paid plans. */
    public function planRequests()
    {
        return $this->hasMany(PlanRequest::class);
    }
}
