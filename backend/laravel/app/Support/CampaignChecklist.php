<?php

namespace App\Support;

use App\Models\Clip;
use App\Models\ProcessingJob;

/**
 * Batch 12 (2026-11-25): campaign compliance checklist.
 *
 * The server — never the worker, never the browser — computes the
 * checklist on job completion from the stored per-clip facts the
 * worker reported (post_caption, hashtags, ost_burned_text). A job
 * with required campaign items is never shown fully compliant while
 * any check fails. Jobs with no required items get no checklist at
 * all (null), so the card simply does not render.
 *
 * Honest limit, stated in the UI copy: the system auto-verifies TEXT
 * items only. Visual / subjective rules ("laptop dikhana hai",
 * "Stokes Twins hone chahiye") cannot be detected by the worker —
 * those live as manual checkboxes the user ticks before submitting.
 */
class CampaignChecklist
{
    /**
     * Parse the raw hashtags field into an ordered list: "#a #b, c"
     * -> ["#a", "#b", "#c"]. A '#' is added when missing; the tag's
     * own characters are kept exactly as typed (verbatim); duplicates
     * collapse case-insensitively, keeping the first occurrence.
     */
    public static function parseHashtags(?string $raw): array
    {
        if ($raw === null || trim($raw) === '') {
            return [];
        }

        $tags = [];
        $seen = [];
        foreach (preg_split('/[\s,]+/', trim($raw)) as $piece) {
            $piece = trim($piece);
            if ($piece === '') {
                continue;
            }
            $tag = str_starts_with($piece, '#') ? $piece : '#'.$piece;
            $key = mb_strtolower($tag);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $tags[] = $tag;
        }

        return $tags;
    }

    /**
     * The job's required campaign items, read from its stored
     * settings. A field only counts when it is non-empty AND its
     * Required/Optional selector is on Required.
     *
     * Batch 14: the wizard sends only the brief now — buildSettings
     * derives these fields from the parsed brief (first OST choice,
     * verbatim caption, hashtags), so this method reads the same
     * fields for old and new jobs alike. `ost_choices` carries every
     * parsed OST line: the burn may be any of them (the worker burns
     * the first), so the OST check accepts any choice, not just the
     * first.
     */
    public static function requiredItems(array $settings): array
    {
        $caption = trim((string) ($settings['campaign_caption'] ?? ''));
        $ost = trim((string) ($settings['campaign_ost'] ?? ''));
        $parsed = $settings['campaign_parsed'] ?? null;
        $choices = is_array($parsed) && isset($parsed['ost']['choices'])
            && is_array($parsed['ost']['choices'])
            ? array_values(array_filter($parsed['ost']['choices'], fn ($c) => is_string($c) && trim($c) !== ''))
            : [];

        return [
            'caption' => $caption !== '' && ($settings['campaign_caption_required'] ?? false)
                ? $caption
                : null,
            'hashtags' => ($settings['campaign_hashtags_required'] ?? false)
                ? self::parseHashtags($settings['campaign_hashtags'] ?? null)
                : [],
            'ost' => $ost !== '' && ($settings['campaign_ost_required'] ?? false)
                ? $ost
                : null,
            'ost_choices' => $choices,
        ];
    }

    /**
     * Compute the checklist for a job. Returns null when the job has
     * no required campaign items (non-campaign jobs and campaign jobs
     * with everything Optional). Otherwise one entry per required
     * item with pass/fail + a note naming the exact evidence.
     * Only ready ORIGINAL clips count (re-render variants are
     * alternates, not the deliverables).
     */
    public static function compute(ProcessingJob $job): ?array
    {
        $required = self::requiredItems($job->settings ?? []);

        if ($required['caption'] === null
            && $required['hashtags'] === []
            && $required['ost'] === null) {
            return null;
        }

        $clips = $job->clips()
            ->where('status', Clip::STATUS_READY)
            ->whereNull('variant_of_clip_id')
            ->orderBy('id')
            ->get();
        $count = $clips->count();

        $items = [];
        if ($required['caption'] !== null) {
            $items[] = self::captionItem($required['caption'], $clips, $count);
        }
        if ($required['hashtags'] !== []) {
            $items[] = self::hashtagsItem($required['hashtags'], $clips, $count);
        }
        if ($required['ost'] !== null) {
            $items[] = self::ostItem($required['ost'], $required['ost_choices'] ?? [], $clips, $count);
        }

        $failed = count(array_filter($items, fn ($i) => ! $i['passed']));

        return [
            'items' => $items,
            'all_passed' => $failed === 0,
            'failed_count' => $failed,
            'checked_at' => now()->toIso8601String(),
        ];
    }

    private static function captionItem(string $required, $clips, int $count): array
    {
        $base = [
            'key' => 'caption',
            'label' => 'Required post caption',
            'required' => $required,
        ];
        if ($count === 0) {
            return [...$base, 'passed' => false, 'note' => 'No clips rendered — nothing to check against.'];
        }
        $bad = $clips->filter(fn ($c) => $c->post_caption !== $required);
        if ($bad->isEmpty()) {
            return [...$base, 'passed' => true, 'note' => "Used verbatim in all {$count} clip(s)."];
        }

        return [...$base, 'passed' => false,
            'note' => 'Caption differs on '.$bad->map(fn ($c) => $c->title)->implode(', ').'.'];
    }

    private static function hashtagsItem(array $required, $clips, int $count): array
    {
        $base = [
            'key' => 'hashtags',
            'label' => 'Required hashtags',
            'required' => $required,
        ];
        if ($count === 0) {
            return [...$base, 'passed' => false, 'note' => 'No clips rendered — nothing to check against.'];
        }
        $wanted = array_map(fn ($t) => mb_strtolower($t), $required);
        $bad = $clips
            ->filter(function ($clip) use ($wanted) {
                // Normalise both sides: lowercase, one leading '#'.
                $have = array_map(
                    fn ($t) => '#'.ltrim(mb_strtolower((string) $t), '#'),
                    $clip->hashtags ?? []
                );
                foreach ($wanted as $tag) {
                    if (! in_array($tag, $have, true)) {
                        return true;
                    }
                }

                return false;
            })
            ->map(function ($clip) use ($wanted) {
                $have = array_map(
                    fn ($t) => '#'.ltrim(mb_strtolower((string) $t), '#'),
                    $clip->hashtags ?? []
                );

                return [
                    'title' => $clip->title,
                    'missing' => array_values(array_filter(
                        $wanted,
                        fn ($tag) => ! in_array($tag, $have, true)
                    )),
                ];
            });
        if ($bad->isEmpty()) {
            return [...$base, 'passed' => true,
                'note' => 'Every required hashtag is in all '.$count.' clip(s): '.implode(' ', $required).'.'];
        }

        return [...$base, 'passed' => false,
            'note' => 'Missing '.$bad->map(fn ($b) => implode(' ', $b['missing']).' on '.$b['title'])->implode('; ').'.'];
    }

    private static function ostItem(string $required, array $choices, $clips, int $count): array
    {
        // Batch 14: the required text is the FIRST parsed choice, but
        // any parsed choice line is an acceptable burn — show all of
        // them as the requirement so the user sees what was allowed.
        $shown = $choices !== [] ? $choices : $required;
        $base = [
            'key' => 'ost',
            'label' => 'Required on-screen text',
            'required' => $shown,
        ];
        if ($count === 0) {
            return [...$base, 'passed' => false, 'note' => 'No clips rendered — nothing to check against.'];
        }
        // Pass when every clip burned the required text — or, when
        // the brief offered choices, any one of the parsed lines.
        $bad = $clips->filter(function ($c) use ($required, $choices) {
            $burned = $c->ost_burned_text;
            if ($burned === $required) {
                return false;
            }
            return ! ($choices !== [] && in_array($burned, $choices, true));
        });
        if ($bad->isEmpty()) {
            return [...$base, 'passed' => true, 'note' => "Burned verbatim in all {$count} clip(s)."];
        }
        $details = $bad->map(function ($c) {
            $burned = $c->ost_burned_text;
            $shown = $burned === null || $burned === '' ? 'no on-screen text' : "'{$burned}'";

            return "{$c->title} burned {$shown}";
        })->implode('; ');

        return [...$base, 'passed' => false, 'note' => $details.'.'];
    }

    /**
     * Manual checks from the campaign brief: one per non-empty line.
     * The id is a stable hash of the line text, so a re-compute keeps
     * the ticked state of lines that are still there.
     */
    public static function manualChecksFromBrief(?string $brief): array
    {
        if ($brief === null || trim($brief) === '') {
            return [];
        }
        $checks = [];
        foreach (preg_split('/\r\n|\r|\n/', $brief) as $line) {
            $text = trim($line);
            if ($text === '') {
                continue;
            }
            $checks[] = [
                'id' => md5($text),
                'text' => $text,
                'checked' => false,
            ];
        }

        return $checks;
    }

    /**
     * Manual checks from the parsed brief (Batch 14): one per
     * `manual_lines` entry — the lines the parser could not follow
     * itself (instructions, hook windows, visual/subjective rules,
     * posting facts). The id is the same stable md5 of the line text
     * as manualChecksFromBrief, so a job created before Batch 14
     * keeps its ticked state when its checks are re-derived.
     */
    public static function manualChecksFromParsed(array $parsed): array
    {
        $checks = [];
        foreach ($parsed['manual_lines'] ?? [] as $text) {
            $text = trim((string) $text);
            if ($text === '') {
                continue;
            }
            $checks[] = [
                'id' => md5($text),
                'text' => $text,
                'checked' => false,
            ];
        }

        return $checks;
    }

    /**
     * The manual checks for a job's settings: the parsed brief wins
     * when the job has one (Batch 14 — parsed lines only, so the
     * auto-enforced items are not listed as manual work); otherwise
     * every non-empty brief line, as Batch 12 did. All three call
     * sites (creation x2, ready transition, PATCH) go through here
     * so the fresh list — and therefore the accepted ids — can never
     * drift apart.
     */
    public static function manualChecksForJob(array $settings): array
    {
        $parsed = $settings['campaign_parsed'] ?? null;
        if (is_array($parsed) && ! empty($parsed['manual_lines'])) {
            return self::manualChecksFromParsed($parsed);
        }

        return self::manualChecksFromBrief(
            $settings['campaign_brief']
                ?? $settings['campaign_requirements']
                ?? null
        );
    }

    /**
     * Merge stored manual checks with the current brief lines: keep
     * the ticked state for lines that still exist, drop removed
     * lines, add new lines unchecked.
     */
    public static function mergeManualChecks(?array $stored, ?string $brief): array
    {
        $fresh = self::manualChecksFromBrief($brief);
        $byId = [];
        foreach ($stored ?? [] as $check) {
            if (isset($check['id'])) {
                $byId[$check['id']] = $check;
            }
        }
        foreach ($fresh as &$check) {
            if (isset($byId[$check['id']])) {
                $check['checked'] = (bool) ($byId[$check['id']]['checked'] ?? false);
            }
        }

        return $fresh;
    }
}
