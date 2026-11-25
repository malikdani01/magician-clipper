<?php

namespace App\Support;

/**
 * Batch 14 (2026-11-25): deterministic parser for pasted campaign
 * briefs (Genni format). The user pastes the FULL brief copied from
 * the campaign site into ONE box ("Campaign informations") — the
 * system reads it and extracts what it can follow, instead of the
 * user filling separate per-item sections (Batch 12).
 *
 * This is CODE, not understanding: there is no LLM in the worker,
 * so free-form prose is out of scope. The parser only recognises the
 * Genni shape — ALL-CAPS section headers with (REQUIRED)/(OPTIONAL)
 * markers, MUST INCLUDE / YOUR CHOICE sub-sections, ✔/❌ lists and
 * label + URL pairs. Anything it cannot recognise lands in
 * `unparsed` and becomes a manual check on the job page — never
 * silently dropped, never guessed.
 *
 * The parse result is stored on the job (settings.campaign_parsed)
 * at creation. The backend derives the Batch 12 structured fields
 * from it (first OST choice, verbatim caption, hashtags) so the
 * worker and the checklist keep working unchanged; the worker reads
 * the parsed extras (caption examples, music rule, reference URLs)
 * from the same payload.
 */
class CampaignBriefParser
{
    /**
     * ALL-CAPS section headers (with an optional (REQUIRED) /
     * (OPTIONAL) marker). A header is mostly uppercase letters, no
     * trailing period, at most 60 chars — a sentence in caps would
     * not qualify.
     */
    private const HEADER_RE = '/^([A-Z][A-Z0-9\s&\'’\-–\/():]+?)(?:\s*\((REQUIRED|OPTIONAL)\))?\s*$/u';

    /**
     * Header text (marker stripped, uppercased) -> parser category.
     * Sub-headers inside a section (POST SPECS, EXAMPLES, MUST
     * INCLUDE, YOUR CHOICE, NOTE, CONTENT, ...) route to the same
     * bucket as their parent section.
     */
    private const SECTIONS = [
        'WHAT TO DO' => 'todo',
        'THE TWO CLIP TYPES' => 'clip_types',
        'EXAMPLE VIDEOS' => 'reference_videos',
        'WHAT TO COPY FROM THE EXAMPLE' => 'todo',
        'AUDIO' => 'audio',
        'CAPTION' => 'caption',
        'CAPTION GUIDELINES' => 'caption',
        'ON-SCREEN TEXT' => 'ost',
        'EDITING GUIDELINES' => 'editing',
        'REQUIREMENTS' => 'requirements',
        'POST SPECS' => 'requirements',
        'PERFORMANCE' => 'requirements',
        'NOT ALLOWED' => 'not_allowed',
        'CONTENT' => 'not_allowed',
        'ENGAGEMENT FRAUD' => 'not_allowed',
        'POST VIOLATIONS' => 'not_allowed',
        'EXAMPLES' => 'caption_examples',
        'NOTE' => 'note',
        'MUST INCLUDE' => 'ost_must',
        'YOUR CHOICE' => 'ost_choices',
    ];

    private const URL_RE = '/https?:\/\/[^\s<>"\']+/i';

    private const HASHTAG_LINE_RE = '/^(?:#[\w]+[\s,]+)*#[\w]+$/u';

    public static function empty(): array
    {
        return [
            'title' => null,
            'ost' => ['required' => false, 'must_include' => false, 'choices' => []],
            'caption' => ['required' => false, 'verbatim' => null, 'examples' => []],
            'hashtags' => [],
            'hashtags_required' => false,
            'audio' => ['required' => false, 'links' => []],
            'reference_videos' => [],
            'music_allowed' => true,
            'clip_types' => [],
            'requirements' => [],
            'not_allowed' => [],
            'editing_rules' => [],
            'unparsed' => [],
            'manual_lines' => [],
        ];
    }

    public static function parse(?string $brief): array
    {
        $out = self::empty();
        if ($brief === null || trim($brief) === '') {
            return $out;
        }

        $lines = preg_split('/\r\n|\r|\n/', $brief);
        $category = null;
        $categoryRequired = null;
        $pendingLabel = null;
        // (line index, text) for every line that should become a
        // manual check, so the checks keep brief order.
        $manual = [];
        $seenManual = [];

        $addManual = function (int $idx, string $text) use (&$manual, &$seenManual): void {
            if ($text === '' || isset($seenManual[$text])) {
                return;
            }
            $seenManual[$text] = true;
            $manual[] = [$idx, $text];
        };

        foreach ($lines as $idx => $raw) {
            $line = self::cleanLine((string) $raw);
            if ($line === '') {
                continue;
            }

            // A section header changes the category (the header line
            // itself is consumed — it is structure, not a rule).
            if (self::isHeader($line, $header, $marker)) {
                $key = mb_strtoupper(trim($header));
                $category = self::SECTIONS[$key] ?? 'unknown';
                $categoryRequired = $marker === 'REQUIRED'
                    ? true
                    : ($marker === 'OPTIONAL' ? false : null);
                if ($category === 'audio' && $categoryRequired === true) {
                    $out['audio']['required'] = true;
                }
                if ($category === 'caption' && $categoryRequired === true) {
                    $out['caption']['required'] = true;
                }
                if ($category === 'ost' && $categoryRequired === true) {
                    $out['ost']['required'] = true;
                }
                $pendingLabel = null;
                continue;
            }

            // The first content line (before any header) is the
            // campaign title — but ONLY when it looks like one: no
            // trailing period, and a " - " separator or a
            // parenthesised id ("Artist - Song (8525)"). A plain
            // instruction sentence ("Show the laptop in every
            // clip.") is a rule, not a title — it must stay a
            // manual check, never be swallowed as a display name.
            if ($out['title'] === null && $category === null
                && ! str_ends_with($line, '.')
                && mb_strlen($line) <= 80
                && (str_contains($line, ' - ') || preg_match('/\(\d{2,}\)/', $line))
                && ! str_starts_with($line, 'http')) {
                $out['title'] = $line;
                continue;
            }

            // Global detectors, whatever the section: a music ban and
            // the official-sound rejection both carry across sections
            // (EDITING GUIDELINES and NOT ALLOWED state the same rule
            // twice in the Genni format).
            if (preg_match('/background music\s*:?\s*NOT ALLOWED/i', $line)
                || preg_match('/any music other than the official sound/i', $line)) {
                $out['music_allowed'] = false;
            }
            if (preg_match('/without the official sound/i', $line)) {
                $out['audio']['required'] = true;
            }

            // A line of nothing but #tags is a hashtag list.
            if (preg_match(self::HASHTAG_LINE_RE, $line)) {
                $seenTags = array_map('mb_strtolower', $out['hashtags']);
                foreach (preg_split('/[\s,]+/', $line) as $piece) {
                    $piece = trim($piece);
                    if ($piece === '') {
                        continue;
                    }
                    $tag = str_starts_with($piece, '#') ? $piece : '#'.$piece;
                    if (! in_array(mb_strtolower($tag), $seenTags, true)) {
                        $out['hashtags'][] = $tag;
                        $seenTags[] = mb_strtolower($tag);
                    }
                }
                $out['hashtags_required'] = $categoryRequired ?? true;
                continue;
            }

            // URLs: an audio link in the AUDIO section (labelled by
            // the preceding "TikTok sound:" / "Instagram sound:"
            // line), a reference video in EXAMPLE VIDEOS, a stray
            // URL anywhere else (unparsed — the user sees the link
            // in the manual check text).
            if (preg_match(self::URL_RE, $line, $m)) {
                $url = rtrim($m[0], '.,)');
                if ($category === 'audio') {
                    $label = $pendingLabel
                        ?? (str_contains($url, 'tiktok.com') ? 'TikTok sound'
                            : (str_contains($url, 'instagram.com') ? 'Instagram sound' : 'Audio link'));
                    $out['audio']['links'][] = ['label' => $label, 'url' => $url];
                    $pendingLabel = null;
                    continue;
                }
                if ($category === 'reference_videos') {
                    if (! in_array($url, $out['reference_videos'], true)) {
                        $out['reference_videos'][] = $url;
                    }
                    $pendingLabel = null;
                    continue;
                }
                $pendingLabel = null;
                $out['unparsed'][] = $line;
                $addManual($idx, $line);
                continue;
            }

            // A label line ("TikTok sound:") is consumed only when
            // the next content line is a URL — otherwise it is prose
            // and falls through to the section routing below.
            if (str_ends_with($line, ':') && mb_strlen($line) <= 40) {
                $next = null;
                for ($j = $idx + 1; $j < count($lines); $j++) {
                    $peek = self::cleanLine((string) $lines[$j]);
                    if ($peek !== '') {
                        $next = $peek;
                        break;
                    }
                }
                if ($next !== null && preg_match(self::URL_RE, $next)) {
                    $pendingLabel = rtrim($line, ':');
                    continue;
                }
            }
            $pendingLabel = null;

            switch ($category) {
                case 'audio':
                    // Any other AUDIO line is guidance, not a rule.
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'caption':
                    // A required caption section can state its exact
                    // text ("Caption: ...") or quote it — that text
                    // is applied verbatim. Everything else here is
                    // guidance for the auto caption.
                    if ($categoryRequired === true
                        && preg_match('/^(?:caption|post caption|text)\s*[:\-]\s*(.+)$/i', $line, $m)
                        && trim($m[1]) !== '') {
                        $out['caption']['verbatim'] = trim($m[1]);
                        break;
                    }
                    if ($categoryRequired === true
                        && preg_match('/"([^"]{3,2200})"/', $line, $m)) {
                        $out['caption']['verbatim'] = trim($m[1]);
                        break;
                    }
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'caption_examples':
                    // Example captions are bare lines (no trailing
                    // period) — an instruction sentence ends with one.
                    if (! str_ends_with($line, '.') && mb_strlen($line) <= 120) {
                        $out['caption']['examples'][] = $line;
                        break;
                    }
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'ost':
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'ost_must':
                    // "MUST INCLUDE" states the rule; the rule itself
                    // is captured by must_include, so the line is
                    // consumed (the worker enforces it + the checklist
                    // verifies it — no manual check needed).
                    $out['ost']['must_include'] = true;
                    $out['ost']['required'] = true;
                    break;

                case 'ost_choices':
                    // Choice lines are bare lines (no trailing
                    // period); instruction sentences ("Use one of the
                    // lines below…", "Text must be clear…") end with
                    // one and become manual checks instead.
                    if (! str_ends_with($line, '.')
                        && mb_strlen($line) <= 60
                        && ! preg_match('/^(use one of|text must be|same rule)/i', $line)) {
                        $out['ost']['choices'][] = $line;
                        break;
                    }
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'editing':
                    // The music ban was already recorded by the
                    // global detector; other editing lines are rules
                    // the worker cannot verify (no AI voices) — they
                    // become manual checks.
                    if (preg_match('/background music/i', $line)) {
                        break;
                    }
                    $out['editing_rules'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'clip_types':
                    $out['clip_types'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'requirements':
                    $out['requirements'][] = $line;
                    $addManual($idx, $line);
                    break;

                case 'not_allowed':
                    $out['not_allowed'][] = $line;
                    $addManual($idx, $line);
                    break;

                default:
                    // todo / note / unknown / no section yet: an
                    // instruction or a rule the parser cannot follow
                    // (the hook window, "cut on the beat", payment
                    // lines) — a manual check, in brief order.
                    $out['unparsed'][] = $line;
                    $addManual($idx, $line);
                    break;
            }
        }

        // Manual checks keep brief order across all buckets.
        usort($manual, fn ($a, $b) => $a[0] <=> $b[0]);
        $out['manual_lines'] = array_values(array_map(fn ($m) => $m[1], $manual));

        return $out;
    }

    /**
     * Strip a line's leading marker (✔ / ❌ / ⚠️ / - / •) and
     * collapse whitespace. The marker is decoration — the text is
     * what the user checks.
     */
    private static function cleanLine(string $line): string
    {
        $line = trim($line);
        $line = preg_replace('/^(?:✔|❌|⚠️|✅|[-•*])\s*/u', '', $line);
        return trim(preg_replace('/\s+/', ' ', $line ?? ''));
    }

    /**
     * True when the line is an ALL-CAPS section header. Sets $header
     * (marker stripped) and $marker ('REQUIRED' / 'OPTIONAL' / null).
     */
    private static function isHeader(string $line, ?string &$header, ?string &$marker): bool
    {
        $header = null;
        $marker = null;
        if (mb_strlen($line) > 60 || str_ends_with($line, '.')) {
            return false;
        }
        if (! preg_match(self::HEADER_RE, $line, $m)) {
            return false;
        }
        // Mostly uppercase letters — a Title Case line ("Payments")
        // is prose, not a header.
        $letters = preg_replace('/[^A-Za-z]/', '', $line);
        if ($letters === '') {
            return false;
        }
        $upper = preg_replace('/[^A-Z]/', '', $line);
        if (mb_strlen($upper) < mb_strlen($letters) * 0.8) {
            return false;
        }
        $header = $m[1];
        $marker = $m[2] ?? null;

        return true;
    }
}
