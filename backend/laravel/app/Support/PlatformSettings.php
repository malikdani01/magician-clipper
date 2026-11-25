<?php

namespace App\Support;

use App\Models\PlatformSetting;
use App\Models\User;
use Illuminate\Support\Facades\Cache;

/**
 * Platform-wide settings (Batch 10).
 *
 * ONE source of truth for every admin-controlled limit, feature
 * toggle, page toggle, maintenance mode and the announcement banner.
 * Values live in the platform_settings table (key/value rows); the
 * table starts EMPTY and every key falls back to its code default
 * below until an admin saves a value — so a fresh install and a
 * deploy both behave exactly like the pre-Batch-10 defaults.
 *
 * Cached forever under a single key; every write forgets the cache.
 * Reads are typed: limits are ints, features/pages are bools,
 * maintenance_message/announcement are strings.
 *
 * Where each limit lived BEFORE Batch 10 (moved here, same values):
 * - free daily limit: did not exist — free users were unlimited.
 *   The default 10 is new, enforced from Batch 10 on.
 * - max clips per job: hardcoded max:50 in JobSettingsRules.
 * - max bulk files: hardcoded max:5 in JobController::storeBulk.
 * - max upload MB: hardcoded max:2097152 KB in JobController.
 */
class PlatformSettings
{
    private const CACHE_KEY = 'platform_settings:v1';

    /** The 12 feature toggles (Batch 10, Phase 2). */
    public const FEATURES = [
        'captions',
        'on_screen_text',
        'beat_sync',
        'translation',
        'logo_overlay',
        'intro_outro',
        'music_bed_sfx',
        'cloud_storage',
        'bulk_jobs',
        'clip_rerender',
        'favourites',
        'thumbnail_picker',
    ];

    /** User-panel pages an admin may hide (Batch 10, Phase 2). */
    public const PAGES = [
        'library',
        'brand_kit',
        'exports',
        'usage',
        'help',
        'editor',
    ];

    /**
     * Code defaults — the exact pre-Batch-10 behaviour, except the
     * free daily limit (10), which is new: before Batch 10 free
     * users had no daily cap at all.
     */
    public static function defaults(): array
    {
        return [
            'limits' => [
                'free_daily_limit' => 10,
                'max_clips_per_job' => 50,
                'max_bulk_files' => 5,
                'max_upload_mb' => 2048,
            ],
            'features' => array_fill_keys(self::FEATURES, true),
            'pages' => array_fill_keys(self::PAGES, true),
            'maintenance' => [
                'enabled' => false,
                'message' => 'Magician Clipper is under maintenance — please check back soon.',
            ],
            'announcement' => '',
        ];
    }

    /** Full settings array (defaults + saved rows), cached. */
    public static function all(): array
    {
        return Cache::rememberForever(self::CACHE_KEY, function () {
            $settings = self::defaults();

            foreach (PlatformSetting::all() as $row) {
                self::applyFlatKey($settings, $row->key, $row->value);
            }

            return $settings;
        });
    }

    public static function forgetCache(): void
    {
        Cache::forget(self::CACHE_KEY);
    }

    /** One flat key (e.g. 'feature.captions') applied onto the nested array. */
    private static function applyFlatKey(array &$settings, string $key, ?string $value): void
    {
        $parts = explode('.', $key, 2);
        if (count($parts) !== 2) {
            // Top-level keys: maintenance_enabled, maintenance_message, announcement.
            match ($key) {
                'maintenance_enabled' => $settings['maintenance']['enabled'] = self::toBool($value),
                'maintenance_message' => $settings['maintenance']['message'] = (string) ($value ?? ''),
                'announcement' => $settings['announcement'] = (string) ($value ?? ''),
                default => null,
            };

            return;
        }

        [$group, $name] = $parts;
        match ($group) {
            'limit' => $settings['limits'][$name] = self::toInt($value, $settings['limits'][$name] ?? 0),
            'feature' => $settings['features'][$name] = self::toBool($value),
            'page' => $settings['pages'][$name] = self::toBool($value),
            default => null,
        };
    }

    private static function toBool(?string $value): bool
    {
        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
    }

    private static function toInt(?string $value, int $fallback): int
    {
        return is_numeric($value) ? (int) $value : $fallback;
    }

    // --- Typed readers -------------------------------------------------

    public static function limit(string $name): int
    {
        return (int) (self::all()['limits'][$name] ?? self::defaults()['limits'][$name]);
    }

    public static function feature(string $name): bool
    {
        return (bool) (self::all()['features'][$name] ?? true);
    }

    public static function page(string $name): bool
    {
        return (bool) (self::all()['pages'][$name] ?? true);
    }

    public static function maintenanceEnabled(): bool
    {
        return (bool) (self::all()['maintenance']['enabled'] ?? false);
    }

    public static function maintenanceMessage(): string
    {
        $message = (string) (self::all()['maintenance']['message'] ?? '');

        return $message !== '' ? $message : self::defaults()['maintenance']['message'];
    }

    public static function announcement(): string
    {
        return (string) (self::all()['announcement'] ?? '');
    }

    /**
     * Effective daily job limit for a user. Admins are exempt (null =
     * unlimited) — the free daily limit is a free-plan limit, and the
     * admin is the operator, not a free-plan user. A per-user
     * override replaces the platform default for that user only.
     */
    public static function dailyLimitFor(User $user): ?int
    {
        if ($user->isAdmin()) {
            return null;
        }

        return $user->daily_limit_override ?? self::limit('free_daily_limit');
    }

    /** Effective max clips per job for a user (override wins). */
    public static function maxClipsFor(User $user): int
    {
        return $user->max_clips_override ?? self::limit('max_clips_per_job');
    }

    // --- Admin writes --------------------------------------------------

    /**
     * Save an admin's platform-settings payload (the nested shape
     * from all()). Unknown keys are ignored, never stored. Values
     * are clamped to their ranges (a max upload above the PHP upload
     * cap would be a lie — PHP rejects the file first — so the max
     * is 2048 MB). Rows are written with an explicit find-or-new +
     * save (never updateOrCreate — deploy-time code must never
     * overwrite rows, and this path keeps that rule literal).
     *
     * @return array the saved settings (fresh, from all())
     */
    public static function save(array $input): array
    {
        $flat = self::flatten($input);

        foreach ($flat as $key => $value) {
            $row = PlatformSetting::where('key', $key)->first();
            if ($row === null) {
                $row = new PlatformSetting(['key' => $key]);
            }
            $row->value = (string) $value;
            $row->save();
        }

        self::forgetCache();

        return self::all();
    }

    /**
     * Flatten the nested admin payload to flat keys, validating each
     * value. Unknown groups/keys are dropped silently.
     */
    private static function flatten(array $input): array
    {
        $flat = [];

        $limits = $input['limits'] ?? [];
        if (is_array($limits)) {
            $ranges = [
                'free_daily_limit' => [1, 1000],
                'max_clips_per_job' => [1, 200],
                'max_bulk_files' => [1, 20],
                // The PHP upload cap is 2048 MB; anything above it
                // could never be reached, so it is not offered.
                'max_upload_mb' => [1, 2048],
            ];
            foreach ($ranges as $name => [$min, $max]) {
                if (array_key_exists($name, $limits) && is_numeric($limits[$name])) {
                    $flat["limit.{$name}"] = (string) max($min, min($max, (int) $limits[$name]));
                }
            }
        }

        foreach (['features' => 'feature', 'pages' => 'page'] as $group => $prefix) {
            $values = $input[$group] ?? [];
            if (! is_array($values)) {
                continue;
            }
            $known = $group === 'features' ? self::FEATURES : self::PAGES;
            foreach ($values as $name => $value) {
                if (in_array($name, $known, true)) {
                    $flat["{$prefix}.{$name}"] = filter_var($value, FILTER_VALIDATE_BOOLEAN) ? '1' : '0';
                }
            }
        }

        $maintenance = $input['maintenance'] ?? [];
        if (is_array($maintenance)) {
            if (array_key_exists('enabled', $maintenance)) {
                $flat['maintenance_enabled'] = filter_var($maintenance['enabled'], FILTER_VALIDATE_BOOLEAN) ? '1' : '0';
            }
            if (array_key_exists('message', $maintenance)) {
                // Laravel converts an empty string to null on the way
                // in — null here means "clear the message", not "skip
                // it", so it is stored as an empty string.
                $flat['maintenance_message'] = mb_substr(trim((string) ($maintenance['message'] ?? '')), 0, 500);
            }
        }

        if (array_key_exists('announcement', $input)) {
            // Same empty-string-to-null rule as above: null clears
            // the announcement.
            $flat['announcement'] = mb_substr(trim((string) ($input['announcement'] ?? '')), 0, 500);
        }

        return $flat;
    }
}
