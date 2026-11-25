<?php

namespace App\Support;

use App\Models\ProcessingJob;

/**
 * Queue position + estimated wait (Batch 11).
 *
 * HONEST SCOPE: the estimate is the average processing seconds per
 * clip from recent completed jobs × the clips ahead of you, shown
 * as a RANGE (±50%) and labelled an estimate. It covers only the
 * jobs ahead of you in the queue — the job currently processing is
 * NOT included, because its remaining time is unknown. With fewer
 * than 3 completed jobs to learn from, there is no estimate at all
 * (the UI says so instead of inventing one).
 *
 * CONCURRENCY: one job at a time per worker is today's reality —
 * the queue is first-in, first-out and no parallel processing is
 * pretended anywhere.
 */
class QueueEstimate
{
    /** Minimum completed jobs needed before any estimate is shown. */
    public const MIN_SAMPLE_JOBS = 3;

    /** How many recent completed jobs the average is taken from. */
    public const SAMPLE_LIMIT = 20;

    /** Range factor: the estimate is shown as est × (1 ± this). */
    public const RANGE_FACTOR = 0.5;

    /**
     * One snapshot for a whole request: the ordered queue (queued
     * job ids, oldest first) + the learned average. Controllers
     * call this once and map it over their jobs — never one query
     * per job.
     */
    public static function snapshot(): array
    {
        $queued = ProcessingJob::whereIn('state', [
                ProcessingJob::STATE_UPLOADED,
                ProcessingJob::STATE_QUEUED,
            ])
            ->orderBy('created_at')
            ->orderBy('id')
            ->get(['id', 'settings', 'created_at']);

        $avg = self::averageSecondsPerClip();

        return [
            'queued' => $queued,
            'avg_seconds_per_clip' => $avg['avg'],
            'sample_jobs' => $avg['samples'],
        ];
    }

    /**
     * Queue info for one job, or null when the job is in a terminal
     * / failed state (there is nothing to wait for). Shape:
     * { status: 'queued'|'processing', position, jobs_ahead,
     *   clips_ahead, estimated_wait_seconds_min/max (null when no
     *   sample), avg_seconds_per_clip, sample_jobs, note }.
     */
    public static function forJob(ProcessingJob $job, ?array $snapshot = null): ?array
    {
        if ($job->isTerminal() || $job->state === ProcessingJob::STATE_FAILED) {
            return null;
        }

        $snapshot ??= self::snapshot();

        if ($job->publicStatus() === ProcessingJob::PUBLIC_STATUS_PROCESSING) {
            return [
                'status' => 'processing',
                'position' => 0,
                'jobs_ahead' => 0,
                'clips_ahead' => 0,
                'estimated_wait_seconds_min' => null,
                'estimated_wait_seconds_max' => null,
                'avg_seconds_per_clip' => $snapshot['avg_seconds_per_clip'],
                'sample_jobs' => $snapshot['sample_jobs'],
                'note' => 'Your job is processing now — jobs run one at a time.',
            ];
        }

        $ids = $snapshot['queued']->pluck('id')->all();
        $index = array_search($job->id, $ids, true);
        if ($index === false) {
            // Not in the queue snapshot (raced with the worker
            // claiming it) — treat as processing, never as position 0
            // of a queue it is not in.
            return [
                'status' => 'processing',
                'position' => 0,
                'jobs_ahead' => 0,
                'clips_ahead' => 0,
                'estimated_wait_seconds_min' => null,
                'estimated_wait_seconds_max' => null,
                'avg_seconds_per_clip' => $snapshot['avg_seconds_per_clip'],
                'sample_jobs' => $snapshot['sample_jobs'],
                'note' => 'Your job is processing now — jobs run one at a time.',
            ];
        }

        $ahead = $snapshot['queued']->slice(0, $index);
        $clipsAhead = $ahead->sum(fn ($queuedJob) => self::expectedClipRows($queuedJob->settings ?? []));
        $avg = $snapshot['avg_seconds_per_clip'];

        $estimate = $avg !== null ? $clipsAhead * $avg : null;

        return [
            'status' => 'queued',
            'position' => $index + 1,
            'jobs_ahead' => $index,
            'clips_ahead' => $clipsAhead,
            'estimated_wait_seconds_min' => $estimate !== null
                ? (int) round($estimate * (1 - self::RANGE_FACTOR))
                : null,
            'estimated_wait_seconds_max' => $estimate !== null
                ? (int) round($estimate * (1 + self::RANGE_FACTOR))
                : null,
            'avg_seconds_per_clip' => $avg,
            'sample_jobs' => $snapshot['sample_jobs'],
            // The job currently processing is not in the estimate:
            // its remaining time is unknown, so the wait can be
            // longer than this range when a long job is running.
            'note' => 'Estimate covers the jobs ahead of you only; the job currently processing is not included. Jobs run one at a time.',
        ];
    }

    /**
     * Expected rendered clip rows for a job's settings: requested
     * windows × export ratios, capped at the worker's 50-clip
     * total (services/video-engine MAX_TOTAL_CLIPS).
     */
    public static function expectedClipRows(array $settings): int
    {
        $windows = (int) ($settings['clip_count'] ?? 1);
        $ratios = $settings['export_ratios'] ?? [$settings['aspect_ratio'] ?? '9:16'];
        if (! is_array($ratios) || $ratios === []) {
            $ratios = ['9:16'];
        }

        return max(0, min($windows * count($ratios), 50));
    }

    /**
     * Mean processing seconds per clip from recent completed jobs:
     * (finished_at − started_at) / actual clip rows, averaged over
     * the last SAMPLE_LIMIT completed jobs (last 30 days). Returns
     * ['avg' => ?float, 'samples' => int] — avg is null under
     * MIN_SAMPLE_JOBS, so no estimate is ever invented.
     */
    public static function averageSecondsPerClip(): array
    {
        $jobs = ProcessingJob::where('state', ProcessingJob::STATE_COMPLETED)
            ->whereNotNull('started_at')
            ->whereNotNull('finished_at')
            ->where('finished_at', '>=', now()->subDays(30))
            ->latest('finished_at')
            ->limit(self::SAMPLE_LIMIT)
            ->get(['id', 'started_at', 'finished_at']);

        $perClip = [];
        foreach ($jobs as $job) {
            $clips = $job->clips()->count();
            if ($clips <= 0) {
                continue;
            }
            // Carbon 3's diffInSeconds is signed by default (negative
            // here) — use raw timestamps so the span is always positive.
            $seconds = $job->finished_at->getTimestamp() - $job->started_at->getTimestamp();
            if ($seconds <= 0) {
                continue;
            }
            $perClip[] = $seconds / $clips;
        }

        if (count($perClip) < self::MIN_SAMPLE_JOBS) {
            return ['avg' => null, 'samples' => count($perClip)];
        }

        return ['avg' => round(array_sum($perClip) / count($perClip), 1), 'samples' => count($perClip)];
    }
}
