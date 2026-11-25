<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\AdminActivityLog;
use App\Models\Clip;
use App\Models\Notification;
use App\Models\Plan;
use App\Models\PlanRequest;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use App\Models\UserPlan;
use App\Models\UserSetting;
use App\Support\DatabaseBackup;
use App\Support\MediaStorage;
use App\Support\PlanService;
use App\Support\StorageUsage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

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
        // Batch 10: sortable (name/email/created_at/jobs) + searchable.
        $sort = $request->input('sort', 'created_at');
        $dir = strtolower($request->input('dir', 'desc')) === 'asc' ? 'asc' : 'desc';
        $sortColumn = match ($sort) {
            'name' => 'name',
            'email' => 'email',
            'jobs' => 'processing_jobs_count',
            default => 'created_at',
        };

        $users = User::withCount(['projects', 'processingJobs'])
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                $query->where('name', 'like', "%{$search}%")
                    ->orWhere('email', 'like', "%{$search}%");
            })
            ->orderBy($sortColumn, $dir)
            ->paginate(20);

        // Passwords/hashes are never serialized (User::$hidden).
        return response()->json($users);
    }

    /**
     * GET /api/v1/admin/users/{user} — one user's full detail:
     * counts, their latest jobs, clips, storage used, saved
     * settings, suspension state and per-user overrides.
     */
    public function showUser(Request $request, User $user)
    {
        $user->loadCount(['projects', 'processingJobs']);
        $clipsCount = Clip::whereIn(
            'job_id',
            $user->processingJobs()->pluck('id')
        )->count();

        return response()->json([
            'user' => $user,
            'counts' => [
                'projects' => $user->projects_count,
                'jobs' => $user->processing_jobs_count,
                'clips' => $clipsCount,
                'storage_bytes' => StorageUsage::totalBytes($user->id),
            ],
            'settings' => UserSetting::where('user_id', $user->id)->first(),
            // Batch 11: the user's current plan + usage (Free when
            // no active plan) and their plan history.
            'plan' => PlanService::planSummary($user),
            'user_plans' => $user->userPlans()->with('plan:id,name')
                ->latest()->limit(10)->get(),
            'jobs' => $user->processingJobs()->with('clips:id,job_id')
                ->latest()->limit(10)->get(['id', 'state', 'created_at']),
        ]);
    }

    /**
     * PATCH /api/v1/admin/users/{user}/role — change a user's role.
     * Guards: an admin cannot change their OWN role, and the LAST
     * admin cannot be demoted (the panel would have no admin left).
     */
    public function updateUserRole(Request $request, User $user)
    {
        $admin = $request->user();
        $validated = $request->validate([
            'role' => ['required', 'string', Rule::in(['user', 'admin'])],
        ]);

        if ($user->id === $admin->id) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'You cannot change your own role.',
            ], 422);
        }
        if ($user->role === 'admin' && $validated['role'] !== 'admin'
            && User::where('role', 'admin')->count() <= 1) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'This is the last admin — demote another admin first.',
            ], 422);
        }

        $oldRole = $user->role;
        $user->role = $validated['role'];
        $user->save();

        AdminActivityLog::record($admin, 'user.role_changed', 'user', $user->id, [
            'email' => $user->email, 'from' => $oldRole, 'to' => $user->role,
        ]);

        return response()->json(['user' => $user->fresh()]);
    }

    /**
     * POST /api/v1/admin/users/{user}/suspend — suspend an account.
     * A suspended user cannot log in and cannot create jobs (the
     * login + job-creation gates enforce it). Guards: never self,
     * never the last admin.
     */
    public function suspendUser(Request $request, User $user)
    {
        $admin = $request->user();

        if ($user->id === $admin->id) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'You cannot suspend your own account.',
            ], 422);
        }
        if ($user->role === 'admin' && User::where('role', 'admin')->count() <= 1) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'This is the last admin — suspending them would lock out the panel.',
            ], 422);
        }
        if ($user->isSuspended()) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This user is already suspended.',
            ], 422);
        }

        $user->suspended_at = now();
        $user->save();

        AdminActivityLog::record($admin, 'user.suspended', 'user', $user->id, [
            'email' => $user->email,
        ]);

        return response()->json(['user' => $user->fresh()]);
    }

    /** POST /api/v1/admin/users/{user}/activate — lift a suspension. */
    public function activateUser(Request $request, User $user)
    {
        if (! $user->isSuspended()) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This user is not suspended.',
            ], 422);
        }

        $user->suspended_at = null;
        $user->save();

        AdminActivityLog::record($request->user(), 'user.activated', 'user', $user->id, [
            'email' => $user->email,
        ]);

        return response()->json(['user' => $user->fresh()]);
    }

    /**
     * DELETE /api/v1/admin/users/{user} — delete an account and
     * everything it owns (foreign keys cascade: projects, jobs,
     * clips, presets, notifications, brand assets, settings).
     * Guards: never self, never the last admin. The response
     * carries the exact counts that were deleted.
     */
    public function deleteUser(Request $request, User $user)
    {
        $admin = $request->user();

        if ($user->id === $admin->id) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'You cannot delete your own account.',
            ], 422);
        }
        if ($user->role === 'admin' && User::where('role', 'admin')->count() <= 1) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'This is the last admin — delete another admin first.',
            ], 422);
        }

        $counts = [
            'projects' => $user->projects()->count(),
            'jobs' => $user->processingJobs()->count(),
            'clips' => Clip::whereIn('job_id', $user->processingJobs()->pluck('id'))->count(),
        ];
        $email = $user->email;
        $user->delete();

        AdminActivityLog::record($admin, 'user.deleted', 'user', $user->id, [
            'email' => $email, 'counts' => $counts,
        ]);

        return response()->json([
            'message' => "User {$email} deleted.",
            'deleted' => $counts,
        ]);
    }

    /**
     * POST /api/v1/admin/users/{user}/reset-password — set a fresh
     * random password and show it to the admin ONCE, in this
     * response only. The plaintext is never stored or logged.
     */
    public function resetUserPassword(Request $request, User $user)
    {
        $temporaryPassword = Str::password(12);
        $user->password = Hash::make($temporaryPassword);
        $user->save();

        AdminActivityLog::record($request->user(), 'user.password_reset', 'user', $user->id, [
            'email' => $user->email,
        ]);

        return response()->json([
            'message' => 'Password reset — show this password to the user once; it will not be shown again.',
            'temporary_password' => $temporaryPassword,
            'user' => ['id' => $user->id, 'email' => $user->email],
        ]);
    }

    /**
     * PATCH /api/v1/admin/users/{user}/overrides — per-user limits
     * (null = use the platform default). Daily limit 1–1000, max
     * clips 1–200.
     */
    public function updateUserOverrides(Request $request, User $user)
    {
        $validated = $request->validate([
            'daily_limit_override' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1000'],
            'max_clips_override' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:200'],
        ]);

        $user->fill($validated);
        $user->save();

        AdminActivityLog::record($request->user(), 'user.overrides_updated', 'user', $user->id, [
            'email' => $user->email,
            'daily_limit_override' => $user->daily_limit_override,
            'max_clips_override' => $user->max_clips_override,
        ]);

        return response()->json(['user' => $user->fresh()]);
    }

    public function projects(Request $request)
    {
        $projects = Project::with(['user:id,name,email'])
            ->withCount(['mediaAssets', 'clips', 'processingJobs'])
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->input('status')))
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                $query->where('title', 'like', "%{$search}%");
            })
            ->latest()
            ->paginate(20);

        return response()->json($projects);
    }

    /**
     * DELETE /api/v1/admin/projects/{project} — delete any project.
     * Jobs, clips, media and exports cascade (foreign keys); stored
     * files are left on disk, like the user-side delete. Returns the
     * exact counts that were deleted.
     */
    public function deleteProject(Request $request, Project $project)
    {
        $counts = [
            'jobs' => $project->processingJobs()->count(),
            'clips' => $project->clips()->count(),
            'media_assets' => $project->mediaAssets()->count(),
        ];
        $title = $project->title;
        $project->delete();

        AdminActivityLog::record($request->user(), 'project.deleted', 'project', $project->id, [
            'title' => $title, 'counts' => $counts,
        ]);

        return response()->json([
            'message' => "Project '{$title}' deleted.",
            'deleted' => $counts,
        ]);
    }

    public function jobs(Request $request)
    {
        $jobs = ProcessingJob::with(['user:id,name,email', 'project:id,title'])
            ->withCount('clips')
            ->when($request->filled('state'), fn ($q) => $q->where('state', $request->input('state')))
            ->when($request->filled('user_id'), fn ($q) => $q->where('user_id', (int) $request->input('user_id')))
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                // Search by job id, or by project title.
                if (ctype_digit($search)) {
                    $query->where('id', (int) $search);
                } else {
                    $query->whereHas('project', fn ($q) => $q->where('title', 'like', "%{$search}%"));
                }
            })
            ->latest()
            ->paginate(20);

        return response()->json($jobs);
    }

    /**
     * GET /api/v1/admin/jobs/failed — failed jobs with their exact
     * error code + message, newest first. Search by job id.
     */
    public function failedJobs(Request $request)
    {
        $jobs = ProcessingJob::with(['user:id,name,email', 'project:id,title'])
            ->withCount('clips')
            ->where('state', ProcessingJob::STATE_FAILED)
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                if (ctype_digit($search)) {
                    $query->where('id', (int) $search);
                }
            })
            ->latest()
            ->paginate(20);

        return response()->json($jobs);
    }

    /**
     * DELETE /api/v1/admin/jobs/{job} — delete a job AND its clips
     * (clips do not cascade on job delete — their job_id is
     * nullOnDelete — so they are deleted explicitly). Clip files
     * and the music bed are removed best-effort; a missing file
     * never fails the delete. Returns the exact clip count deleted.
     */
    public function deleteJob(Request $request, ProcessingJob $job)
    {
        $clips = $job->clips()->get();
        $clipCount = $clips->count();

        foreach ($clips as $clip) {
            $this->deleteClipFiles($clip);
            $clip->delete();
        }

        if ($job->music_bed_path !== null) {
            try {
                Storage::disk('local')->delete($job->music_bed_path);
            } catch (\Throwable) {
                // A missing music bed never fails the delete.
            }
        }

        $job->delete();

        AdminActivityLog::record($request->user(), 'job.deleted', 'job', $job->id, [
            'clips_deleted' => $clipCount,
        ]);

        return response()->json([
            'message' => "Job #{$job->id} and its {$clipCount} clip(s) deleted.",
            'deleted' => ['clips' => $clipCount],
        ]);
    }

    public function clips(Request $request)
    {
        $clips = Clip::with([
            'job:id,project_id,user_id',
            'job.user:id,name',
            'job.project:id,title',
        ])
            ->when($request->filled('search'), function ($query) use ($request) {
                $search = $request->input('search');
                if (ctype_digit($search)) {
                    $query->where('id', (int) $search);
                } else {
                    $query->where('title', 'like', "%{$search}%");
                }
            })
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->input('status')))
            ->latest()->paginate(20);

        return response()->json($clips);
    }

    /**
     * DELETE /api/v1/admin/clips/{clip} — delete a clip and its
     * files (rendered file, thumbnails) best-effort. Re-renders
     * cascade on the clip row.
     */
    public function deleteClip(Request $request, Clip $clip)
    {
        $this->deleteClipFiles($clip);
        $clipId = $clip->id;
        $clip->delete();

        AdminActivityLog::record($request->user(), 'clip.deleted', 'clip', $clipId, []);

        return response()->json(['message' => "Clip #{$clipId} deleted."]);
    }

    /** Remove a clip's files from its disk; never throws. */
    private function deleteClipFiles(Clip $clip): void
    {
        try {
            $disk = MediaStorage::disk($clip->disk ?? MediaStorage::DISK_LOCAL, $clip->job?->user);
            foreach ([$clip->output_path, $clip->thumbnail_path, ...(array) ($clip->thumbnail_candidates ?? [])] as $path) {
                if (is_string($path) && $path !== '') {
                    $disk->delete($path);
                }
            }
        } catch (\Throwable) {
            // A missing or unreachable file never fails the delete.
        }
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

        AdminActivityLog::record($request->user(), 'job.retried', 'job', $job->id, []);

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

        $previousState = $job->state;

        try {
            $job->transitionTo(ProcessingJob::STATE_CANCELLING);
        } catch (\InvalidArgumentException $e) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => $e->getMessage(),
            ], 422);
        }

        AdminActivityLog::record($request->user(), 'job.cancelled', 'job', $job->id, [
            'previous_state' => $previousState,
        ]);

        return response()->json(['job' => $job->fresh()]);
    }

    /**
     * PATCH /api/v1/admin/settings/credentials — the signed-in admin
     * changes their OWN email + password (Batch 9, 2026-11-25).
     *
     * The Admin Panel → Settings form is the source of truth for admin
     * credentials: each Save replaces the previous ones and the old
     * ones stop working. The seeder never touches credentials after
     * the first admin exists, so a panel change survives deploys.
     *
     * current_password is verified against the signed-in admin first
     * (wrong → 422, nothing changes). new_email must be a valid email
     * unused by any OTHER user; new_password is min 8 with a matching
     * confirmation. Only the signed-in admin's row is updated (email
     * + password hash); name, plan and everything else are untouched.
     * The current session is NOT revoked — the admin just proved the
     * current password. No credential value is ever returned or logged.
     */
    public function updateCredentials(Request $request)
    {
        $admin = $request->user();

        $validated = $request->validate([
            'current_password' => ['required', 'string'],
            'new_email' => ['required', 'email', 'max:255', Rule::unique('users', 'email')->ignore($admin->id)],
            'new_password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        if (! Hash::check($validated['current_password'], $admin->password)) {
            return response()->json([
                'message' => 'The current password is incorrect.',
                'errors' => ['current_password' => ['The current password is incorrect.']],
            ], 422);
        }

        $admin->email = $validated['new_email'];
        $admin->password = Hash::make($validated['new_password']);
        $admin->save();

        // Batch 10: credential changes are admin actions too — logged
        // without any credential value.
        AdminActivityLog::record($admin, 'admin.credentials_changed', 'user', $admin->id, []);

        return response()->json([
            'message' => 'Credentials updated — use the new email and password next time you sign in.',
            'admin' => ['id' => $admin->id, 'email' => $admin->email],
        ]);
    }

    /**
     * GET /api/v1/admin/backup — latest backup info for the Admin
     * Panel → Settings "Backup & Restore" section (Batch 9, 2026-11-25).
     *
     * Returns the newest local backup (or null), whether the signed-in
     * admin has cloud storage configured (backups upload there too),
     * and the EXACT restore command — restore stays an artisan
     * command on purpose (a web-request restore can time out
     * mid-restore and corrupt data), so the panel shows the command
     * instead of a restore button.
     */
    public function backupInfo(Request $request)
    {
        $latest = DatabaseBackup::latest();
        $admin = $request->user();

        return response()->json([
            'backup' => $latest === null ? null : $this->backupArray($latest),
            'cloud_configured' => MediaStorage::buildCloudDisk($admin) !== null,
            'restore_command' => $latest === null
                ? 'php artisan db:restore storage/app/backups/<backup-file>.sql.gz --force'
                : DatabaseBackup::restoreCommand($latest['filename']),
        ]);
    }

    /**
     * POST /api/v1/admin/backup — create a backup now (admin-only,
     * throttled: a dump is real server work). Runs synchronously and
     * returns the new backup's metadata. A failed cloud upload never
     * fails the backup — the local file exists either way and the
     * failure is reported in cloud_error, never hidden.
     */
    public function createBackup(Request $request)
    {
        try {
            $meta = DatabaseBackup::create($request->user());
        } catch (\Throwable $e) {
            return response()->json([
                'message' => 'Backup failed: '.$e->getMessage(),
            ], 500);
        }

        AdminActivityLog::record($request->user(), 'admin.backup_created', null, null, [
            'filename' => $meta['filename'],
        ]);

        return response()->json([
            'message' => 'Backup created.',
            'backup' => $this->backupArray($meta),
            'cloud_configured' => MediaStorage::buildCloudDisk($request->user()) !== null,
            'restore_command' => DatabaseBackup::restoreCommand($meta['filename']),
        ]);
    }

    /**
     * GET /api/v1/admin/backup/download — stream the latest backup
     * file (.sql.gz). 404 with an honest message when no backup
     * exists yet. Admin gate + Sanctum auth come from the route.
     */
    public function downloadBackup(Request $request)
    {
        $latest = DatabaseBackup::latest();
        if ($latest === null) {
            return response()->json([
                'message' => 'No backup exists yet — create one first.',
            ], 404);
        }

        return response()->download(
            $latest['path'],
            $latest['filename'],
            ['Content-Type' => 'application/gzip']
        );
    }

    /** Public shape of a backup for the panel (paths stay server-side). */
    private function backupArray(array $meta): array
    {
        return [
            'filename' => $meta['filename'],
            'size_bytes' => $meta['size_bytes'],
            'created_at' => $meta['created_at'],
            'driver' => $meta['driver'],
            'method' => $meta['method'],
            'cloud_key' => $meta['cloud_key'],
            'cloud_error' => $meta['cloud_error'],
            // Where the file lives: local disk, or local + cloud bucket.
            'location' => $meta['cloud_key'] !== null ? 'local+cloud' : 'local',
        ];
    }

    /**
     * GET /api/v1/admin/activity-log — the admin activity trail,
     * newest first. Every admin mutation writes a row here.
     */
    public function activityLog(Request $request)
    {
        $entries = AdminActivityLog::with('admin:id,name,email')
            ->when($request->filled('action'), fn ($q) => $q->where('action', 'like', '%'.$request->input('action').'%'))
            ->latest()
            ->paginate(30);

        return response()->json($entries);
    }

    /**
     * GET /api/v1/admin/reports — real aggregates only: jobs/day
     * and clips/day for the last 30 days, plus the top 10 users by
     * clips rendered. No revenue anywhere — billing does not exist.
     */
    public function reports(Request $request)
    {
        $topUsers = DB::table('users')
            ->join('processing_jobs', 'processing_jobs.user_id', '=', 'users.id')
            ->join('clips', 'clips.job_id', '=', 'processing_jobs.id')
            ->select(
                'users.id', 'users.name', 'users.email',
                DB::raw('count(distinct processing_jobs.id) as jobs_count'),
                DB::raw('count(clips.id) as clips_count')
            )
            ->groupBy('users.id', 'users.name', 'users.email')
            ->orderByDesc('clips_count')
            ->limit(10)
            ->get();

        return response()->json([
            'daily' => $this->dailySeries(),
            'top_users' => $topUsers,
            'totals' => [
                'users' => User::count(),
                'jobs' => ProcessingJob::count(),
                'clips' => Clip::count(),
                'clips_ready' => Clip::where('status', Clip::STATUS_READY)->count(),
            ],
        ]);
    }

    /**
     * GET /api/v1/admin/monitor — measurable system facts only.
     * Worker last-report + queue depth, ffmpeg/ffprobe versions as
     * last reported by the worker, database size, file disk usage
     * and totals. Nothing is estimated: a missing report is null.
     */
    public function monitor(Request $request)
    {
        $engine = Cache::get('engine_versions') ?? [
            'ffmpeg' => null, 'ffprobe' => null, 'reported_at' => null,
        ];

        $databaseSize = null;
        try {
            if (config('database.default') === 'pgsql') {
                $databaseSize = (int) DB::selectOne(
                    'SELECT pg_database_size(current_database()) as size'
                )->size;
            } else {
                $path = config('database.connections.sqlite.database');
                $databaseSize = is_string($path) && is_file($path) ? filesize($path) : null;
            }
        } catch (\Throwable) {
            $databaseSize = null;
        }

        $diskTotal = @disk_total_space(storage_path('app'));
        $diskFree = @disk_free_space(storage_path('app'));

        return response()->json([
            'worker' => [
                'last_report_at' => $engine['reported_at'],
                'ffmpeg' => $engine['ffmpeg'],
                'ffprobe' => $engine['ffprobe'],
            ],
            'queue' => [
                'queued_jobs' => ProcessingJob::whereIn('state', [
                    ProcessingJob::STATE_UPLOADED, ProcessingJob::STATE_QUEUED,
                ])->count(),
                'processing_jobs' => ProcessingJob::whereNotIn('state', array_merge(
                    ProcessingJob::TERMINAL_STATES,
                    [ProcessingJob::STATE_FAILED, ProcessingJob::STATE_CANCELLED,
                     ProcessingJob::STATE_UPLOADED, ProcessingJob::STATE_QUEUED]
                ))->count(),
                'failed_jobs' => ProcessingJob::where('state', ProcessingJob::STATE_FAILED)->count(),
            ],
            'database' => [
                'connection' => config('database.default'),
                'ok' => $this->databaseOk(),
                'size_bytes' => $databaseSize,
            ],
            'disk' => [
                'path' => storage_path('app'),
                'total_bytes' => $diskTotal === false ? null : $diskTotal,
                'free_bytes' => $diskFree === false ? null : $diskFree,
                'app_files_bytes' => StorageUsage::totalBytes(),
            ],
            'totals' => [
                'users' => User::count(),
                'projects' => Project::count(),
                'jobs' => ProcessingJob::count(),
                'clips' => Clip::count(),
            ],
        ]);
    }

    /**
     * POST /api/v1/admin/notifications/broadcast — send a
     * notification to ALL users or ONE selected user. It uses the
     * existing notifications system, so it appears in the user's
     * bell exactly like a job notification. Throttled: a broadcast
     * is real fan-out work.
     */
    public function broadcast(Request $request)
    {
        $validated = $request->validate([
            'title' => ['required', 'string', 'max:200'],
            'message' => ['required', 'string', 'max:2000'],
            'target' => ['required', 'string', Rule::in(['all', 'user'])],
            'user_id' => ['required_if:target,user', 'nullable', 'integer', 'exists:users,id'],
        ]);

        $userIds = $validated['target'] === 'all'
            ? User::pluck('id')
            : collect([(int) $validated['user_id']]);

        $now = now();
        $created = 0;
        foreach ($userIds->chunk(500) as $chunk) {
            $rows = $chunk->map(fn ($id) => [
                'user_id' => $id,
                'job_id' => null,
                'type' => Notification::TYPE_BROADCAST,
                'title' => $validated['title'],
                'body' => $validated['message'],
                'link' => null,
                'read_at' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ])->all();
            Notification::insert($rows);
            $created += count($rows);
        }

        AdminActivityLog::record($request->user(), 'notification.broadcast', null, null, [
            'target' => $validated['target'],
            'user_id' => $validated['target'] === 'user' ? (int) $validated['user_id'] : null,
            'recipients' => $created,
            'title' => $validated['title'],
        ]);

        return response()->json([
            'message' => "Broadcast sent to {$created} user(s).",
            'recipients' => $created,
        ]);
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

    // --- Plans (Batch 11: manual activation, no payment gateway) ---

    /**
     * GET /api/v1/admin/plans — every plan (active + inactive) with
     * live counts: users currently on it and pending requests.
     */
    public function plans(Request $request)
    {
        $plans = Plan::withCount([
            'userPlans as active_users' => fn ($q) => $q->where('status', UserPlan::STATUS_ACTIVE),
            'planRequests as pending_requests' => fn ($q) => $q->where('status', PlanRequest::STATUS_PENDING),
        ])->orderBy('id')->get();

        return response()->json(['plans' => $plans]);
    }

    /** Shared plan create/update validation (admin only). On create the
     * three core fields are required; on update they are `sometimes`
     * so a partial PATCH (e.g. only {"active": false}) is valid. */
    private function validatePlanPayload(Request $request, bool $forUpdate = false): array
    {
        $required = $forUpdate ? 'sometimes' : 'required';

        return $request->validate([
            'name' => [$required, 'string', 'max:100'],
            'price_display' => [$required, 'string', 'max:100'],
            'duration_days' => [$required, 'integer', 'min:1', 'max:3650'],
            'total_clips' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1000000'],
            'daily_clips' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1000'],
            'max_export_quality' => ['sometimes', 'string', Rule::in(Plan::EXPORT_QUALITIES)],
            'features' => ['sometimes', 'nullable', 'array'],
            'features.*' => ['string', 'max:200'],
            'active' => ['sometimes', 'boolean'],
        ]);
    }

    /** POST /api/v1/admin/plans — create a plan. */
    public function storePlan(Request $request)
    {
        $plan = Plan::create($this->validatePlanPayload($request));

        AdminActivityLog::record($request->user(), 'plan.created', 'plan', $plan->id, [
            'name' => $plan->name,
        ]);

        return response()->json(['plan' => $plan->fresh()], 201);
    }

    /** PATCH /api/v1/admin/plans/{plan} — edit a plan. New limits
     * apply to the NEXT gated call immediately (enforcement reads
     * the plan row live); already-granted user_plans keep their own
     * ends_at and clips_used. */
    public function updatePlan(Request $request, Plan $plan)
    {
        $plan->update($this->validatePlanPayload($request, true));

        AdminActivityLog::record($request->user(), 'plan.updated', 'plan', $plan->id, [
            'name' => $plan->name,
        ]);

        return response()->json(['plan' => $plan->fresh()]);
    }

    /**
     * DELETE /api/v1/admin/plans/{plan} — delete a plan that was
     * never bought. A plan with ANY user_plans history is blocked
     * (deactivate it instead) — deleting it would orphan the
     * purchase history; the FK restrictOnDelete is the backstop.
     */
    public function deletePlan(Request $request, Plan $plan)
    {
        if ($plan->userPlans()->exists()) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This plan has been bought before — deactivate it instead of deleting it, so the purchase history stays intact.',
            ], 422);
        }

        $plan->delete();

        AdminActivityLog::record($request->user(), 'plan.deleted', 'plan', $plan->id, [
            'name' => $plan->name,
        ]);

        return response()->json(['deleted' => true]);
    }

    /**
     * GET /api/v1/admin/plan-requests — user requests, newest first.
     * ?status=pending|approved|declined filters; default is all.
     */
    public function planRequests(Request $request)
    {
        $requests = PlanRequest::with(['user:id,name,email', 'plan:id,name,price_display,duration_days'])
            ->when($request->filled('status'), fn ($q) => $q->where('status', $request->input('status')))
            ->latest()
            ->paginate(20);

        return response()->json($requests);
    }

    /**
     * POST /api/v1/admin/plan-requests/{planRequest}/approve — the
     * admin confirmed the (off-app) payment: create the user_plan
     * (starts now, ends now + plan duration) and mark the request
     * approved. Any plan the user already has active ends early
     * (PlanService::grantPlan supersedes it).
     */
    public function approvePlanRequest(Request $request, PlanRequest $planRequest)
    {
        if ($planRequest->status !== PlanRequest::STATUS_PENDING) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "This request is already {$planRequest->status}.",
            ], 422);
        }

        $userPlan = PlanService::grantPlan($planRequest->user, $planRequest->plan);
        $planRequest->update(['status' => PlanRequest::STATUS_APPROVED]);

        AdminActivityLog::record($request->user(), 'plan_request.approved', 'plan_request', $planRequest->id, [
            'user_id' => $planRequest->user_id,
            'plan' => $planRequest->plan->name,
            'ends_at' => $userPlan->ends_at->toIso8601String(),
        ]);

        return response()->json([
            'request' => $planRequest->fresh(),
            'user_plan' => $userPlan->load('plan:id,name'),
        ]);
    }

    /**
     * POST /api/v1/admin/plan-requests/{planRequest}/decline — a
     * reason is REQUIRED (the user sees it on their Plans page).
     */
    public function declinePlanRequest(Request $request, PlanRequest $planRequest)
    {
        if ($planRequest->status !== PlanRequest::STATUS_PENDING) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "This request is already {$planRequest->status}.",
            ], 422);
        }

        $validated = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $planRequest->update([
            'status' => PlanRequest::STATUS_DECLINED,
            'decline_reason' => $validated['reason'],
        ]);

        AdminActivityLog::record($request->user(), 'plan_request.declined', 'plan_request', $planRequest->id, [
            'user_id' => $planRequest->user_id,
            'plan' => $planRequest->plan->name,
        ]);

        return response()->json(['request' => $planRequest->fresh()]);
    }

    /**
     * POST /api/v1/admin/users/{user}/plans — assign any plan to any
     * user directly (no request needed). ends_at is optional: omit
     * it for now + plan duration, or pass a custom end date.
     */
    public function assignPlan(Request $request, User $user)
    {
        $validated = $request->validate([
            'plan_id' => ['required', 'integer', 'exists:plans,id'],
            'ends_at' => ['sometimes', 'nullable', 'date', 'after:now'],
        ]);

        $plan = Plan::findOrFail($validated['plan_id']);
        $endsAt = ! empty($validated['ends_at'])
            ? new \DateTimeImmutable($validated['ends_at'])
            : null;

        $userPlan = PlanService::grantPlan($user, $plan, $endsAt);

        AdminActivityLog::record($request->user(), 'plan.assigned', 'user_plan', $userPlan->id, [
            'user_id' => $user->id,
            'plan' => $plan->name,
            'ends_at' => $userPlan->ends_at->toIso8601String(),
        ]);

        return response()->json(['user_plan' => $userPlan->load('plan:id,name')], 201);
    }

    /**
     * POST /api/v1/admin/user-plans/{userPlan}/revoke — end a
     * user's plan early. The user drops to Free immediately.
     */
    public function revokeUserPlan(Request $request, UserPlan $userPlan)
    {
        if ($userPlan->status !== UserPlan::STATUS_ACTIVE) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "This plan is already {$userPlan->status}.",
            ], 422);
        }

        PlanService::revokePlan($userPlan);

        AdminActivityLog::record($request->user(), 'plan.revoked', 'user_plan', $userPlan->id, [
            'user_id' => $userPlan->user_id,
            'plan_id' => $userPlan->plan_id,
        ]);

        return response()->json(['user_plan' => $userPlan->fresh()->load('plan:id,name')]);
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
