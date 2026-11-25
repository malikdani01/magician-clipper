<?php

namespace App\Support;

use App\Models\Project;
use App\Models\UserSetting;
use Illuminate\Validation\Rule;

/**
 * The ONE canonical set of job-creation settings rules.
 *
 * JobController::store and JobPresetController::store both validate
 * against these, so a preset can only ever hold settings a real job
 * would accept — and the two can never drift apart. If a setting is
 * added or its values change, change it here and both endpoints pick
 * it up. This covers ONLY the settings fields (platform … quality);
 * job-creation fields that are not settings (title, project_id, file,
 * source_url) stay in JobController::store.
 */
class JobSettingsRules
{
    /**
     * Batch 9 (2026-11-25): the broad MyMemory output-language list
     * shared by caption_translation and ost_language (ISO 639-1
     * codes; zh-CN for Simplified Chinese). Stated once so the two
     * rules and the worker's TRANSLATION_TARGETS cannot drift apart.
     */
    public static function translationLanguages(): array
    {
        return [
            'en', 'ur', 'hi', 'es', 'fr', 'de', 'pt', 'ar', 'tr', 'id',
            'bn', 'pa', 'ta', 'te', 'ml', 'mr', 'gu', 'ru', 'ja', 'ko',
            'zh-CN', 'it', 'nl', 'pl', 'uk', 'vi', 'th', 'fa', 'ps',
            'sd', 'ne', 'si',
        ];
    }

    /**
     * Batch 10: $maxClips is the caller's effective cap — the
     * platform default for presets, the signed-in user's effective
     * cap (per-user override wins) for job creation.
     */
    public static function rules(?int $maxClips = null): array
    {
        $maxClips ??= PlatformSettings::limit('max_clips_per_job');

        return [
            'platform' => ['required', 'string', Rule::in(['tiktok', 'instagram'])],
            'aspect_ratio' => ['required', 'string', Rule::in(['9:16', '16:9', '1:1', '4:5'])],
            'clip_count' => ['required', 'integer', 'min:1', 'max:'.$maxClips],
            'duration_mode' => ['required', 'string', Rule::in(['exact', 'minimum', 'maximum'])],
            'duration_seconds' => ['required', 'integer', 'min:5', 'max:180'],
            'duration_min_seconds' => ['sometimes', 'nullable', 'integer', 'min:5', 'max:180'],
            'duration_max_seconds' => ['sometimes', 'nullable', 'integer', 'min:5', 'max:180'],
            'captions_enabled' => ['sometimes', 'boolean'],
            'captions_language' => ['sometimes', 'string', Rule::in(['english', 'roman_urdu', 'hindi', 'auto'])],
            'caption_style' => ['sometimes', 'nullable', 'string', Rule::in(UserSetting::CAPTION_STYLES)],
            'selection_mode' => ['sometimes', 'string', Rule::in(['interesting_only', 'fill_any'])],
            'on_screen_text' => ['sometimes', 'boolean'],
            // Batch 1 enhancements (2026-11-25): all default ON for new
            // jobs (JobController::store applies ?? true); the worker
            // also treats a missing key as ON, for jobs made before them.
            'auto_zoom' => ['sometimes', 'boolean'],
            'face_tracking' => ['sometimes', 'boolean'],
            'silence_removal' => ['sometimes', 'boolean'],
            'filler_removal' => ['sometimes', 'boolean'],
            // Batch 2 (2026-11-25): headline look + caption position.
            // Defaults are the pre-Batch-2 behaviour (bold_bar top
            // headline, captions at the bottom / on the divider).
            'headline_style' => ['sometimes', 'string', Rule::in(['bold_bar', 'lower_third', 'big_centre'])],
            'caption_position' => ['sometimes', 'string', Rule::in(['bottom', 'top', 'middle'])],
            // Batch 9 (2026-11-25): OST position — WHERE the headline
            // sits, independent of headline_style (the LOOK). The
            // default is derived from the style in
            // JobController::buildSettings (bold_bar -> top,
            // lower_third -> bottom, big_centre -> centre); an
            // explicit value here always wins.
            'ost_position' => ['sometimes', 'nullable', 'string', Rule::in(['top', 'centre', 'bottom'])],
            // Batch 9 (2026-11-25): OST language — the headline's
            // output language. 'source' (default) keeps the
            // headline in the video's own language; any other value
            // translates the derived headline through MyMemory (same
            // honest fallback as captions: on failure the headline
            // stays in the source language). End-card text,
            // lower-third tag and keyword pop-ups are never
            // translated (they are the user's own words / the spoken
            // words). Same broad list as caption_translation.
            'ost_language' => ['sometimes', 'nullable', 'string', Rule::in(array_merge(['source'], self::translationLanguages()))],
            // Batch 9 (2026-11-25): sound-effect sting over clip
            // cuts (default 'none'). The worker mixes the named SFX
            // files; 'whoosh_pop' is both, whoosh then pop.
            'sfx' => ['sometimes', 'string', Rule::in(['none', 'whoosh', 'pop', 'whoosh_pop'])],
            // Batch 9 (2026-11-25): per-job colour grade (default
            // 'none'). The worker applies it as a video filter on
            // the final render only; 'none' adds no filter at all.
            'colour_grade' => ['sometimes', 'nullable', 'string', Rule::in(['none', 'vibrant', 'warm', 'cool', 'cinematic'])],
            // Batch 3 (2026-11-25): beat-synced cuts/zoom (default ON),
            // captions auto-translate (default "none" = original
            // language), multi-ratio export (9:16 always on; the worker
            // also forces the job's own aspect_ratio into the list).
            'beat_sync' => ['sometimes', 'boolean'],
            // Batch 9 (2026-11-25): caption translation targets
            // broadened from ur/hi/en to the full MyMemory list
            // (same list as ost_language, minus 'source'/'none'
            // handling — 'none' keeps the original language).
            'caption_translation' => ['sometimes', 'string', Rule::in(array_merge(['none'], self::translationLanguages()))],
            'export_ratios' => ['sometimes', 'array', 'max:3'],
            'export_ratios.*' => ['string', Rule::in(['9:16', '1:1', '16:9'])],
            // Batch 11 (2026-11-25): export tier — '720p' (Free) or
            // '1080p' (paid plan). The tier caps resolution + bitrate
            // only. The API rejects an above-tier request in
            // PlatformGate::exportTier; the worker caps the render
            // at settings.max_export_height (set server-side from
            // the user's effective plan — never trusted from the
            // client). Omitted = the user's effective tier.
            'export_quality' => ['sometimes', 'string', Rule::in(['720p', '1080p'])],
            // Batch 6 (2026-11-25): caption safe zone (default ON) —
            // captions keep clear of TikTok's right action rail and
            // the bottom bar (worker caps the block at ~78% of frame
            // width, left-of-centre); OFF restores full-width centred
            // captions. The worker also treats a missing key as ON.
            'caption_safe_zone' => ['sometimes', 'boolean'],
            // Batch 7 (2026-11-25): on-screen text for the whole clip.
            // ost_persistent (default OFF) keeps the headline up for
            // the full clip instead of the first 4s; ost_animation
            // (default "none") is the headline's entrance; end_card
            // (default OFF) shows a Follow card in the last 2s
            // (end_card_text, max 40 chars, default "Follow for
            // more"); keyword_popups (default OFF) pops up to 4
            // spoken keywords; lower_third_text (max 40 chars, empty
            // = OFF) is a persistent lower-third tag; progress_bar
            // (default OFF) is a thin violet bar growing across the
            // full clip. The worker treats missing keys as the
            // defaults, so old jobs render exactly as before.
            'ost_persistent' => ['sometimes', 'boolean'],
            // Batch 9 (2026-11-25): the OST animation control was
            // removed from the New Job + wizard UI — OST is always
            // static now. The field stays ACCEPTED here (and in
            // presets) so old presets / API clients that still send
            // it validate instead of breaking; the worker treats any
            // value as 'none'.
            'ost_animation' => ['sometimes', 'string', Rule::in(['none', 'slide', 'fade', 'pop'])],
            'end_card' => ['sometimes', 'boolean'],
            'end_card_text' => ['sometimes', 'nullable', 'string', 'max:40'],
            'keyword_popups' => ['sometimes', 'boolean'],
            'lower_third_text' => ['sometimes', 'nullable', 'string', 'max:40'],
            'progress_bar' => ['sometimes', 'boolean'],
            // Batch 4 (2026-11-25): logo overlay (default OFF — a
            // watermark must never surprise the user).
            'logo_overlay' => ['sometimes', 'boolean'],
            'job_type' => ['sometimes', 'string', Rule::in(['myself', 'campaign'])],
            'campaign_requirements' => ['sometimes', 'nullable', 'string', 'max:5000'],
            'notes' => ['sometimes', 'nullable', 'string', 'max:5000'],
            // Batch 9 (2026-11-25): five more 9:16 layouts — gradient_fill,
            // stacked, letterbox, face_closeup, framed. The worker falls
            // back to centre crop for any layout at a non-9:16 ratio.
            'layout' => ['sometimes', 'string', Rule::in(['center_crop', 'split', 'pip_facecam', 'blur_fill', 'streamer_full', 'gradient_fill', 'stacked', 'letterbox', 'face_closeup', 'framed'])],
            'content_type' => ['sometimes', 'string', Rule::in(Project::CONTENT_TYPES)],
            'quality' => ['sometimes', 'string', Rule::in(['draft', 'standard', 'high'])],
        ];
    }
}
