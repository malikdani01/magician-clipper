<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * Batch 15 — Viral Intelligence (2026-11-28): one user-entered
 * posted-result row for a clip (views / likes / comments / shares
 * the clip actually got after the user posted it). The numbers are
 * typed in by the user on the job page — the system never measures
 * or invents them. The latest row per clip is the current result.
 */
class ClipPerformance extends Model
{
    use HasFactory;

    public const PLATFORMS = ['tiktok', 'instagram'];

    protected $fillable = [
        'clip_id',
        'platform',
        'views',
        'likes',
        'comments',
        'shares',
        'posted_at',
        'notes',
    ];

    protected function casts(): array
    {
        return [
            'views' => 'integer',
            'likes' => 'integer',
            'comments' => 'integer',
            'shares' => 'integer',
            'posted_at' => 'date',
        ];
    }

    public function clip()
    {
        return $this->belongsTo(Clip::class);
    }
}
