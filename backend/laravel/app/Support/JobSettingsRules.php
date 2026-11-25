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
    public static function rules(): array
    {
        return [
            'platform' => ['required', 'string', Rule::in(['tiktok', 'instagram'])],
            'aspect_ratio' => ['required', 'string', Rule::in(['9:16', '16:9', '1:1', '4:5'])],
            'clip_count' => ['required', 'integer', 'min:1', 'max:50'],
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
            // Batch 3 (2026-11-25): beat-synced cuts/zoom (default ON),
            // captions auto-translate (default "none" = original
            // language), multi-ratio export (9:16 always on; the worker
            // also forces the job's own aspect_ratio into the list).
            'beat_sync' => ['sometimes', 'boolean'],
            'caption_translation' => ['sometimes', 'string', Rule::in(['none', 'ur', 'hi', 'en'])],
            'export_ratios' => ['sometimes', 'array', 'max:3'],
            'export_ratios.*' => ['string', Rule::in(['9:16', '1:1', '16:9'])],
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
            'layout' => ['sometimes', 'string', Rule::in(['center_crop', 'split', 'pip_facecam', 'blur_fill', 'streamer_full'])],
            'content_type' => ['sometimes', 'string', Rule::in(Project::CONTENT_TYPES)],
            'quality' => ['sometimes', 'string', Rule::in(['draft', 'standard', 'high'])],
        ];
    }
}
