<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use App\Support\StorageUsage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class AdminController extends Controller
{
    /**
     * GET /api/v1/admin/dashboard — real metrics only (spec §8).
     * No revenue/payment data: billing does not exist yet, so it is
     * reported as not enabled rather than fabricated.
     *
     * Also returns the last-30-days daily series (for the Analytics
     * chart), 30-day growth vs the previous 30 days (for the stat-card
     * sparklines), real feature usage from job settings, and recent
     * jobs/clips for the activity feed. Server CPU/RAM percentages
     * are deliberately NOT reported: on the hosted container the
     * host's /proc numbers do not describe this app, so any
     * percentage would be misleading.
     */
    public function dashboard(Request $request)
    {
        $now = now();
        $windowStart = $now->copy()->subDays(30);
        $prevStart = $now->copy()->subDays(60);

        $growth = function (string $model, string $column = 'created_at') use ($now, $windowStart, $prevStart): ?float {
            $current = $model::where($column, '>=', $windowStart)->count();
            $previous = $model::where($column, '>=', $prevStart)
                ->where($column, '<', $windowStart)->count();
            if ($previous === 0) {
                return $current > 0 ? null : 0.0; // null = new, no prior baseline
            }

            return round((($current - $previous) / $previous) * 100, 1);
        };

        return response()->json([
            'users' => [
                'total' => User::count(),
                'admins' => User::where('role', 'admin')->count(),
                'new_last_30_days' => User::where('created_at', '>=', now()->subDays(30))->count(),
                'growth_pct' => $growth(User::class),
            ],
            'projects' => [
                'total' => Project::count(),
                'by_status' => Project::select('status', DB::raw('count(*) as count'))
                    ->groupBy('status')->pluck('count', 'status'),
                'growth_pct' => $growth(Project::class),
            ],
            'clips' => [
                'total' => Clip::count(),
                'ready' => Clip::where('status', Clip::STATUS_READY)->count(),
                'growth_pct' => $growth(Clip::class),
            ],
            'jobs' => [
                'total' => ProcessingJob::count(),
                'by_state' => ProcessingJob::select('state', DB::raw('count(*) as count'))
                    ->groupBy('state')->pluck('count', 'state'),
                'failed' => ProcessingJob::where('state', ProcessingJob::STATE_FAILED)->count(),
                'running' => ProcessingJob::whereNotIn('state', ProcessingJob::TERMINAL_STATES)
                    ->whereNotIn('state', [ProcessingJob::STATE_FAILED])
                    ->count(),
                'growth_pct' => $growth(ProcessingJob::class),
            ],
            'storage' => [
                // Canonical storage-used total (rendered clips + source
                // files) — the same number the user dashboard and the
                // Usage page report, so all three agree.
                'app_bytes' => StorageUsage::totalBytes(),
            ],
            // ffmpeg/ffprobe versions as last reported by the worker
            // (the hosted site has no engine URL to probe). Nulls
            // until the first report — the UI says so honestly.
            'engine' => Cache::get('engine_versions') ?? [
                'ffmpeg' => null, 'ffprobe' => null, 'reported_at' => null,
            ],
            'billing' => [
                'enabled' => false,
                'message' => 'Payments & billing are not enabled yet.',
            ],
            // Daily counts for the last 30 days (Analytics chart + sparklines).
            'daily' => $this->dailySeries(),
            // Real feature usage, from job settings (share of all jobs).
            'usage' => $this->jobUsage(),
            // Real sidebar badge counts.
            'nav_counts' => [
                'processing_jobs' => ProcessingJob::whereNotIn('state', array_merge(
                    ProcessingJob::TERMINAL_STATES,
                    [ProcessingJob::STATE_FAILED, ProcessingJob::STATE_CANCELLED]
                ))->count(),
                'failed_jobs' => ProcessingJob::where('state', ProcessingJob::STATE_FAILED)->count(),
            ],
            'recent_users' => User::latest()->limit(5)->get(['id', 'name', 'email', 'role', 'plan', 'created_at']),
            'recent_projects' => Project::with('user:id,name')
                ->withCount([
                    'processingJobs as jobs_total',
                    'processingJobs as jobs_completed' => fn ($q) => $q->where('state', ProcessingJob::STATE_COMPLETED),
                ])
                ->latest()->limit(5)->get(),
            'recent_jobs' => ProcessingJob::with('user:id,name')->latest()->limit(5)
                ->get(['id', 'user_id', 'state', 'created_at']),
            'recent_clips' => Clip::latest()->limit(5)->get(['id', 'job_id', 'title', 'created_at']),
        ]);
    }

    /** Daily created-counts for users/projects/clips/jobs, last 30 days. */
    private function dailySeries(): array
    {
        $start = now()->subDays(29)->startOfDay();
        $pluck = fn (string $model) => $model::selectRaw('DATE(created_at) as d, count(*) as c')
            ->where('created_at', '>=', $start)
            ->groupBy('d')->pluck('c', 'd');
        $users = $pluck(User::class);
        $projects = $pluck(Project::class);
        $clips = $pluck(Clip::class);
        $jobs = $pluck(ProcessingJob::class);

        $days = [];
        for ($i = 0; $i < 30; $i++) {
            $date = $start->copy()->addDays($i)->toDateString();
            $days[] = [
                'date' => $date,
                'users' => (int) ($users[$date] ?? 0),
                'projects' => (int) ($projects[$date] ?? 0),
                'clips' => (int) ($clips[$date] ?? 0),
                'jobs' => (int) ($jobs[$date] ?? 0),
            ];
        }

        return $days;
    }

    /** Top values from job settings (platform, caption style), by job count. */
    private function jobUsage(): array
    {
        // Counted in PHP, not SQL: the settings JSON extraction
        // (json_extract) is SQLite-only and 500'd the dashboard on
        // the production Postgres database (2026-11-23). The jobs
        // table is small, so plucking settings and counting here
        // behaves identically on SQLite and Postgres.
        $top = function (string $key): array {
            return ProcessingJob::pluck('settings')
                ->map(fn ($settings) => is_array($settings) ? ($settings[$key] ?? null) : null)
                ->filter()
                ->countBy()
                ->sortDesc()
                ->take(5)
                ->map(fn ($count, $value) => ['label' => (string) $value, 'value' => (int) $count])
                ->values()->all();
        };

        return [
            'platforms' => $top('platform'),
            'caption_styles' => $top('caption_style'),
        ];
    }

    public function users(Request $request)
    {
        $users = User::withCount(['projects', 'processingJobs'])
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                $query->where('name', 'like', "%{$search}%")
                    ->orWhere('email', 'like', "%{$search}%");
            })
            ->latest()
            ->paginate(20);

        // Passwords/hashes are never serialized (User::$hidden).
        return response()->json($users);
    }

    public function projects(Request $request)
    {
        $projects = Project::with(['user:id,name,email'])
            ->withCount(['mediaAssets', 'clips', 'processingJobs'])
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->input('status')))
            ->latest()
            ->paginate(20);

        return response()->json($projects);
    }

    public function jobs(Request $request)
    {
        $jobs = ProcessingJob::with(['user:id,name,email', 'project:id,title'])
            ->when($request->filled('state'), fn ($q) => $q->where('state', $request->input('state')))
            ->latest()
            ->paginate(20);

        return response()->json($jobs);
    }

    public function clips(Request $request)
    {
        $clips = Clip::with([
            'job:id,project_id,user_id',
            'job.user:id,name',
            'job.project:id,title',
        ])->latest()->paginate(20);

        return response()->json($clips);
    }

    public function retryJob(Request $request, ProcessingJob $job)
    {
        try {
            $job->transitionTo(ProcessingJob::STATE_QUEUED);
        } catch (\InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        return response()->json(['job' => $job->fresh()]);
    }

    public function cancelJob(Request $request, ProcessingJob $job)
    {
        if ($job->isTerminal()) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "Job is already {$job->state} and cannot be cancelled.",
            ], 422);
        }

        try {
            $job->transitionTo(ProcessingJob::STATE_CANCELLING);
        } catch (\InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        return response()->json(['job' => $job->fresh()]);
    }

    /**
     * GET /api/v1/admin/system/health — measurable system facts only.
     * Video-engine reachability is probed live (timeout 3s); a down
     * engine is reported as down, never as healthy.
     */
    public function health(Request $request)
    {
        $engineUrl = config('app.video_engine_url');
        $engineOk = false;
        $engineError = null;

        try {
            $response = Http::timeout(3)->get(rtrim($engineUrl, '/').'/health');
            $engineOk = $response->successful();
            if (! $engineOk) {
                $engineError = 'HTTP '.$response->status();
            }
        } catch (\Throwable $e) {
            $engineError = $e->getMessage();
        }

        $diskTotal = @disk_total_space(storage_path('app'));
        $diskFree = @disk_free_space(storage_path('app'));

        return response()->json([
            'app' => [
                'name' => config('app.name'),
                'env' => config('app.env'),
                'debug' => config('app.debug'),
                'php' => PHP_VERSION,
                'laravel' => app()->version(),
            ],
            'database' => [
                'connection' => config('database.default'),
                'ok' => $this->databaseOk(),
            ],
            'video_engine' => [
                'url' => $engineUrl,
                'ok' => $engineOk,
                'error' => $engineError,
            ],
            'disk' => [
                'path' => storage_path('app'),
                'total_bytes' => $diskTotal === false ? null : $diskTotal,
                'free_bytes' => $diskFree === false ? null : $diskFree,
            ],
            'queue' => [
                'connection' => config('queue.default'),
                'note' => 'Redis is optional; default local queue requires no Redis.',
            ],
        ]);
    }

    /**
     * GET /api/v1/admin/system/logs — implemented 2026-11-22 (final QA).
     * Serves the tail of storage/logs/laravel.log (admin-only). Secret
     * values are redacted before anything leaves the server; the raw log
     * file is never streamed. `?lines=N` (1–500, default 200).
     */
    public function logs(Request $request)
    {
        $limit = (int) $request->query('lines', 200);
        $limit = max(1, min($limit, 500));
        $path = storage_path('logs/laravel.log');

        if (! is_file($path)) {
            return response()->json([
                'lines' => [],
                'total_lines' => 0,
                'file' => 'laravel.log',
                'message' => 'No log file yet — nothing has been logged.',
            ]);
        }

        $lines = $this->tailLines($path, $limit);
        $lines = array_map([$this, 'sanitizeLogLine'], $lines);

        return response()->json([
            'lines' => $lines,
            'total_lines' => count($lines),
            'file' => 'laravel.log',
            'truncated' => count($lines) === $limit,
        ]);
    }

    /** Read the last $limit lines of a file without loading it whole. */
    private function tailLines(string $path, int $limit): array
    {
        $size = filesize($path);
        if ($size === false || $size === 0) {
            return [];
        }

        $handle = fopen($path, 'rb');
        if ($handle === false) {
            return [];
        }

        // Read at most the last 256 KB — enough for hundreds of lines.
        $readSize = min($size, 256 * 1024);
        fseek($handle, $size - $readSize);
        $chunk = stream_get_contents($handle);
        fclose($handle);

        if ($chunk === false || $chunk === '') {
            return [];
        }

        $lines = preg_split("/\r\n|\n|\r/", $chunk) ?: [];
        // Drop the first (possibly partial) line when we did not read
        // from the start of the file.
        if ($readSize < $size && count($lines) > 0) {
            array_shift($lines);
        }
        // Drop a trailing empty line from the final newline.
        if (count($lines) > 0 && end($lines) === '') {
            array_pop($lines);
        }

        return array_values(array_slice($lines, -$limit));
    }

    /** Redact secret values from one log line before it is served. */
    private function sanitizeLogLine(string $line): string
    {
        $patterns = [
            '/(MUSE_JOB_API_KEY\s*=\s*)[^\s"\']+/i' => '$1[redacted]',
            '/(password\s*[:=]\s*)[^\s,"\']+/i' => '$1[redacted]',
            '/(api[_-]?key\s*[:=]\s*)[^\s,"\']+/i' => '$1[redacted]',
            '/(Bearer\s+)[^\s"\']+/i' => '$1[redacted]',
            '/(token\s*[:=]\s*)[^\s,"\']+/i' => '$1[redacted]',
            '/(Authorization:\s*)[^\s]+/i' => '$1[redacted]',
        ];

        return (string) preg_replace(
            array_keys($patterns),
            array_values($patterns),
            $line
        );
    }

    private function databaseOk(): bool
    {
        try {
            DB::connection()->getPdo();

            return true;
        } catch (\Throwable) {
            return false;
        }
    }
}
