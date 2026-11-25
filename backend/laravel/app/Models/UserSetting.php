<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class UserSetting extends Model
{
    use HasFactory;

    public const PROCESSING_MODES = ['eco', 'balanced', 'fast'];
    public const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5'];
    public const QUALITIES = ['draft', 'standard', 'high'];
    // Batch 6 (2026-11-25) adds three platform styles: tiktok_bold,
    // reels_clean, shorts_minimal (23 total).
    public const CAPTION_STYLES = ['punchy', 'word_pop', 'title_card', 'clean_subs', 'classic', 'karaoke', 'bounce', 'typewriter', 'sweep', 'neon', 'slam', 'outline', 'gradient', 'kinetic', 'glow_pop', 'word_zoom', 'word_fade', 'highlight_sweep', 'bounce_in', 'glitch_pop', 'tiktok_bold', 'reels_clean', 'shorts_minimal'];

    /** Batch 5 (2026-11-25): appearance + language preferences. */
    public const THEMES = ['dark', 'light'];
    public const LANGUAGES = ['en', 'ur'];

    public const DEFAULTS = [
        'default_processing_mode' => 'balanced',
        'default_aspect_ratio' => '9:16',
        'default_caption_preset' => 'Bold Pop',
        'default_quality' => 'standard',
        'caption_style' => 'punchy',
        'notifications_enabled' => true,
        'theme' => 'dark',
        'language' => 'en',
    ];

    protected $fillable = [
        'user_id',
        'default_processing_mode',
        'default_aspect_ratio',
        'default_caption_preset',
        'default_quality',
        'caption_style',
        'notifications_enabled',
        'theme',
        'language',
    ];

    protected function casts(): array
    {
        return [
            'notifications_enabled' => 'boolean',
        ];
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
