<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class BrandAsset extends Model
{
    use HasFactory;

    public const KIND_INTRO = 'intro';
    public const KIND_OUTRO = 'outro';

    public const KINDS = [
        self::KIND_INTRO,
        self::KIND_OUTRO,
    ];

    /** Maximum asset length: brand stingers are short by design. */
    public const MAX_DURATION_SECONDS = 15.0;

    protected $fillable = [
        'user_id',
        'kind',
        'path',
        'original_name',
        'duration_seconds',
        'file_size_bytes',
    ];

    protected function casts(): array
    {
        return [
            'duration_seconds' => 'float',
            'file_size_bytes' => 'integer',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
