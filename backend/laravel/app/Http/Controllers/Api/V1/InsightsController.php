<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\ProcessingJob;
use Illuminate\Http\Request;

class InsightsController extends Controller
{
    /**
     * GET /api/v1/insights/settings — "What works best" from the
     * user's OWN Ready jobs, never fabricated.
     *
     * For caption style, layout and duration mode, the average viral
     * score (0–100, from the stored clip scores ×100) and the job
     * count per value — but only for values with at least 3 Ready
     * jobs. A value with fewer jobs is omitted entirely; when
     * nothing qualifies, every list is empty and the frontend says
     * plainly that more finished jobs are needed.
     *
     * A job counts once per dimension, using its best clip's score
     * (the same number the job page shows as the clip's viral
     * score); a job with no scored clip is skipped.
     */
    public function settings(Request $request)
    {
        $userId = $request->user()->id;

        // Ready means state=completed — the public "status" is derived
        // from the state machine (publicStatus()), not a column.
        $jobs = ProcessingJob::query()
            ->where('user_id', $userId)
            ->where('state', ProcessingJob::STATE_COMPLETED)
            ->with(['clips' => function ($query) {
                $query->whereNotNull('score')->orderByDesc('score');
            }])
            ->get();

        $buckets = [
            'caption_style' => [],
            'layout' => [],
            'duration_mode' => [],
        ];

        foreach ($jobs as $job) {
            $bestClip = $job->clips->first();
            if ($bestClip === null || $bestClip->score === null) {
                continue;
            }
            $score100 = (float) $bestClip->score * 100;
            $settings = is_array($job->settings) ? $job->settings : [];

            $values = [
                'caption_style' => $settings['caption_style'] ?? null,
                'layout' => $settings['layout'] ?? null,
                'duration_mode' => $settings['duration_mode'] ?? null,
            ];

            foreach ($values as $dimension => $value) {
                if (! is_string($value) || $value === '') {
                    continue;
                }
                $buckets[$dimension][$value]['total'] = ($buckets[$dimension][$value]['total'] ?? 0) + $score100;
                $buckets[$dimension][$value]['count'] = ($buckets[$dimension][$value]['count'] ?? 0) + 1;
            }
        }

        $result = [];
        foreach ($buckets as $dimension => $values) {
            $rows = [];
            foreach ($values as $value => $agg) {
                // Fewer than 3 jobs is noise, not an insight.
                if ($agg['count'] < 3) {
                    continue;
                }
                $rows[] = [
                    'value' => $value,
                    'average_score' => round($agg['total'] / $agg['count'], 1),
                    'job_count' => $agg['count'],
                ];
            }
            usort($rows, fn ($a, $b) => $b['average_score'] <=> $a['average_score']);
            $result[$dimension] = $rows;
        }

        return response()->json($result);
    }

    /**
     * GET /api/v1/insights/performance — "Real results" from the
     * user's OWN posted results (Batch 15), never fabricated.
     *
     * Only clips with a user-entered performance row count, and only
     * the LATEST row per clip (a corrected save supersedes the old
     * one). Aggregated by caption style and by duration band, each
     * showing the average VIEWS (the number the user typed in) and
     * the clip count — but only for values with at least 3 clips
     * with posted results. A value with fewer clips is omitted
     * entirely; when nothing qualifies, every list is empty and
     * total_clips is 0, and the frontend says plainly that no
     * posted results exist yet.
     */
    public function performance(Request $request)
    {
        $userId = $request->user()->id;

        $clips = Clip::query()
            ->whereHas('job', fn ($q) => $q->where('user_id', $userId))
            ->with(['latestPerformance', 'job'])
            ->get()
            ->filter(fn ($clip) => $clip->latestPerformance !== null);

        $buckets = [
            'caption_style' => [],
            'duration_band' => [],
        ];

        foreach ($clips as $clip) {
            $performance = $clip->latestPerformance;
            $settings = is_array($clip->job?->settings) ? $clip->job->settings : [];
            $style = $settings['caption_style'] ?? null;
            $duration = (float) ($clip->duration_seconds ?? 0);
            $band = $duration < 20 ? '<20s'
                : ($duration < 30 ? '20–30s'
                : ($duration < 45 ? '30–45s' : '45s+'));

            $values = [
                'caption_style' => is_string($style) && $style !== '' ? $style : null,
                'duration_band' => $band,
            ];

            foreach ($values as $dimension => $value) {
                if ($value === null) {
                    continue;
                }
                $buckets[$dimension][$value]['total'] = ($buckets[$dimension][$value]['total'] ?? 0) + (int) $performance->views;
                $buckets[$dimension][$value]['count'] = ($buckets[$dimension][$value]['count'] ?? 0) + 1;
            }
        }

        $result = ['total_clips' => $clips->count()];
        foreach ($buckets as $dimension => $values) {
            $rows = [];
            foreach ($values as $value => $agg) {
                // Fewer than 3 clips is noise, not an insight.
                if ($agg['count'] < 3) {
                    continue;
                }
                $rows[] = [
                    'value' => $value,
                    'average_views' => (int) round($agg['total'] / $agg['count']),
                    'clip_count' => $agg['count'],
                ];
            }
            usort($rows, fn ($a, $b) => $b['average_views'] <=> $a['average_views']);
            $result[$dimension] = $rows;
        }

        return response()->json($result);
    }
}
