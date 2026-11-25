<?php

use App\Http\Controllers\Api\V1\AdminController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\BrandAssetController;
use App\Http\Controllers\Api\V1\ClipController;
use App\Http\Controllers\Api\V1\CloudStorageController;
use App\Http\Controllers\Api\V1\ExportController;
use App\Http\Controllers\Api\V1\GoogleAuthController;
use App\Http\Controllers\Api\V1\InsightsController;
use App\Http\Controllers\Api\V1\JobController;
use App\Http\Controllers\Api\V1\JobPresetController;
use App\Http\Controllers\Api\V1\MediaController;
use App\Http\Controllers\Api\V1\MuseJobController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\PlanController;
use App\Http\Controllers\Api\V1\PlatformSettingsController;
use App\Http\Controllers\Api\V1\ProjectController;
use App\Http\Controllers\Api\V1\SettingsController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes — Magician Clipper, versioned /api/v1 (spec §11)
|--------------------------------------------------------------------------
| Public: auth register/login. Everything else requires a Sanctum token
| (auth:sanctum). Admin routes additionally require the 'admin'
| middleware (EnsureAdmin) — normal users get 403.
| Rate limits: auth endpoints are throttled (spec §13); uploads and
| expensive job endpoints get tighter limits in Phase 3.
*/

Route::prefix('v1')->group(function () {

    // --- Public health check (CORS-covered; the frontend's availability
    // probe uses this, not /up, which has no CORS headers) ---
    Route::get('/health', function () {
        return response()->json(['status' => 'ok', 'service' => 'magician-clipper-api']);
    });

    // --- Authentication (public, throttled) ---
    Route::post('/auth/register', [AuthController::class, 'register'])
        ->middleware('throttle:10,1');
    Route::post('/auth/login', [AuthController::class, 'login'])
        ->middleware('throttle:10,1');
    // Batch 11: Google sign-in (public). The redirect endpoint
    // returns { redirect_url } or 422 google_not_configured when
    // the keys are not set yet; the callback is where Google
    // returns the user (it redirects on to the frontend).
    Route::get('/auth/google/redirect', [GoogleAuthController::class, 'redirect'])
        ->middleware('throttle:10,1');
    Route::get('/auth/google/callback', [GoogleAuthController::class, 'callback'])
        ->middleware('throttle:10,1');

    Route::middleware('auth:sanctum')->group(function () {

        Route::post('/auth/logout', [AuthController::class, 'logout']);
        Route::get('/me', [AuthController::class, 'me']);
        Route::get('/me/stats', [AuthController::class, 'stats']);

        // Batch 11: plans — the active plans, my current plan +
        // usage, and my plan requests.
        Route::get('/plans', [PlanController::class, 'index']);
        Route::get('/me/plan', [PlanController::class, 'myPlan']);
        Route::get('/plan-requests', [PlanController::class, 'myRequests']);
        Route::post('/plan-requests', [PlanController::class, 'requestPlan'])
            ->middleware('throttle:6,1');

        // Batch 10: the platform view — limits, feature toggles, page
        // visibility, maintenance mode, announcement + this user's
        // daily usage. The user panel reads this once per session.
        Route::get('/platform', [PlatformSettingsController::class, 'publicView']);

        // --- Projects ---
        Route::get('/projects', [ProjectController::class, 'index']);
        Route::post('/projects', [ProjectController::class, 'store']);
        Route::get('/projects/{project}', [ProjectController::class, 'show']);
        Route::patch('/projects/{project}', [ProjectController::class, 'update']);
        Route::delete('/projects/{project}', [ProjectController::class, 'destroy']);

        // --- Media (upload + listing) ---
        Route::post('/projects/{project}/upload', [MediaController::class, 'upload'])
            ->middleware('throttle:6,1');
        Route::get('/projects/{project}/media', [MediaController::class, 'index']);

        // --- Analysis (starts a processing job) ---
        Route::post('/projects/{project}/analyze', [ProjectController::class, 'analyze'])
            ->middleware('throttle:6,1');

        // --- Processing jobs (user-facing, Phase 3 Job System) ---
        Route::get('/jobs', [JobController::class, 'index']);
        Route::post('/jobs', [JobController::class, 'store'])
            ->middleware('throttle:6,1');
        Route::get('/jobs/{job}', [JobController::class, 'show']);
        Route::post('/jobs/{job}/cancel', [JobController::class, 'cancel']);
        Route::post('/jobs/{job}/retry', [JobController::class, 'retry']);
        // Batch 12: tick the manual campaign brief checks.
        Route::patch('/jobs/{job}/campaign-checks', [JobController::class, 'updateCampaignChecks']);

        // --- Job presets (saved job settings) ---
        Route::get('/presets', [JobPresetController::class, 'index']);
        Route::post('/presets', [JobPresetController::class, 'store']);
        Route::delete('/presets/{preset}', [JobPresetController::class, 'destroy']);

        // --- Notifications ---
        Route::get('/notifications', [NotificationController::class, 'index']);
        Route::patch('/notifications/{notification}/read', [NotificationController::class, 'markRead']);
        Route::post('/notifications/read-all', [NotificationController::class, 'markAllRead']);

        // --- Clips ---
        // POST /clips/zip is registered before /clips/{clip} so the
        // literal 'zip' can never be captured as a clip id.
        Route::post('/clips/zip', [ClipController::class, 'zip']);
        Route::get('/projects/{project}/clips', [ClipController::class, 'index']);
        Route::get('/clips/{clip}', [ClipController::class, 'show']);
        Route::get('/clips/{clip}/download', [ClipController::class, 'download']);
        Route::get('/clips/{clip}/audio', [ClipController::class, 'audio']);
        Route::get('/clips/{clip}/thumbnail', [ClipController::class, 'thumbnail']);
        Route::patch('/clips/{clip}', [ClipController::class, 'update']);
        Route::post('/clips/{clip}/render', [ClipController::class, 'render'])
            ->middleware('throttle:6,1');
        // Batch 9: bulk re-render (before /clips/{clip} captures) +
        // A/B variants of one clip.
        Route::post('/clips/bulk-rerender', [ClipController::class, 'bulkRerender'])
            ->middleware('throttle:6,1');
        Route::post('/clips/{clip}/variants', [ClipController::class, 'createVariant'])
            ->middleware('throttle:6,1');
        Route::get('/clips/{clip}/rerenders', [ClipController::class, 'rerenders']);
        // Batch 4: favourite toggle, thumbnail picker, candidate frames.
        Route::patch('/clips/{clip}/favourite', [ClipController::class, 'toggleFavourite']);
        Route::patch('/clips/{clip}/thumbnail', [ClipController::class, 'setThumbnail']);
        Route::get('/clips/{clip}/candidates/{index}', [ClipController::class, 'candidate']);

        // Batch 4: "What works best" — real aggregation of the user's
        // own Ready jobs (never fabricated; <3 jobs → omitted).
        Route::get('/insights/settings', [InsightsController::class, 'settings']);

        // --- Exports ---
        Route::post('/projects/{project}/export', [ExportController::class, 'store'])
            ->middleware('throttle:6,1');
        Route::get('/exports', [ExportController::class, 'index']);
        Route::get('/exports/{export}', [ExportController::class, 'show']);
        Route::get('/exports/{export}/download', [ExportController::class, 'download']);

        // --- Brand kit (intro/outro/logo assets) ---
        Route::get('/brand-kit/assets', [BrandAssetController::class, 'index']);
        Route::post('/brand-kit/assets', [BrandAssetController::class, 'store'])
            ->middleware('throttle:6,1');
        Route::get('/brand-kit/assets/{asset}/download', [BrandAssetController::class, 'download']);
        Route::delete('/brand-kit/assets/{asset}', [BrandAssetController::class, 'destroy']);

        // --- Settings ---
        Route::get('/settings', [SettingsController::class, 'show']);
        Route::patch('/settings', [SettingsController::class, 'update']);

        // --- Cloud storage (Batch 5: S3-compatible bucket settings) ---
        Route::get('/cloud-storage', [CloudStorageController::class, 'show']);
        Route::patch('/cloud-storage', [CloudStorageController::class, 'update']);
        Route::post('/cloud-storage/test', [CloudStorageController::class, 'test'])
            ->middleware('throttle:6,1');

        // --- Admin (role-gated) ---
        Route::prefix('admin')->middleware('admin')->group(function () {
            Route::get('/dashboard', [AdminController::class, 'dashboard']);
            Route::get('/users', [AdminController::class, 'users']);
            // Batch 10: user management — detail, role, suspend /
            // activate, delete, password reset, per-user overrides.
            Route::get('/users/{user}', [AdminController::class, 'showUser']);
            Route::patch('/users/{user}/role', [AdminController::class, 'updateUserRole']);
            Route::post('/users/{user}/suspend', [AdminController::class, 'suspendUser']);
            Route::post('/users/{user}/activate', [AdminController::class, 'activateUser']);
            Route::delete('/users/{user}', [AdminController::class, 'deleteUser']);
            Route::post('/users/{user}/reset-password', [AdminController::class, 'resetUserPassword']);
            Route::patch('/users/{user}/overrides', [AdminController::class, 'updateUserOverrides']);
            // Batch 11: plans — CRUD, requests (approve/decline),
            // assign to a user, revoke early. Manual activation
            // only; there is no payment gateway.
            Route::get('/plans', [AdminController::class, 'plans']);
            Route::post('/plans', [AdminController::class, 'storePlan']);
            Route::patch('/plans/{plan}', [AdminController::class, 'updatePlan']);
            Route::delete('/plans/{plan}', [AdminController::class, 'deletePlan']);
            Route::get('/plan-requests', [AdminController::class, 'planRequests']);
            Route::post('/plan-requests/{planRequest}/approve', [AdminController::class, 'approvePlanRequest']);
            Route::post('/plan-requests/{planRequest}/decline', [AdminController::class, 'declinePlanRequest']);
            Route::post('/users/{user}/plans', [AdminController::class, 'assignPlan']);
            Route::post('/user-plans/{userPlan}/revoke', [AdminController::class, 'revokeUserPlan']);
            Route::get('/projects', [AdminController::class, 'projects']);
            Route::delete('/projects/{project}', [AdminController::class, 'deleteProject']);
            Route::get('/jobs', [AdminController::class, 'jobs']);
            Route::get('/jobs/failed', [AdminController::class, 'failedJobs']);
            Route::delete('/jobs/{job}', [AdminController::class, 'deleteJob']);
            Route::get('/clips', [AdminController::class, 'clips']);
            Route::delete('/clips/{clip}', [AdminController::class, 'deleteClip']);
            Route::post('/jobs/{job}/retry', [AdminController::class, 'retryJob']);
            Route::post('/jobs/{job}/cancel', [AdminController::class, 'cancelJob']);
            // Batch 10: platform controls (limits, feature + page
            // toggles, maintenance mode, announcement).
            Route::get('/platform-settings', [PlatformSettingsController::class, 'show']);
            Route::patch('/platform-settings', [PlatformSettingsController::class, 'update']);
            // Batch 10: activity log, reports, monitor, broadcast.
            Route::get('/activity-log', [AdminController::class, 'activityLog']);
            Route::get('/reports', [AdminController::class, 'reports']);
            Route::get('/monitor', [AdminController::class, 'monitor']);
            Route::post('/notifications/broadcast', [AdminController::class, 'broadcast'])
                ->middleware('throttle:5,1');
            // Batch 9: the admin changes their own email + password
            // in Admin Panel → Settings. Throttled: it verifies a
            // password, so brute-forcing it must be expensive.
            Route::patch('/settings/credentials', [AdminController::class, 'updateCredentials'])
                ->middleware('throttle:5,1');
            // Batch 9: database backup & restore (deploy-safety).
            // Create is throttled: a dump is real server work.
            // Restore stays an artisan command — no panel endpoint.
            Route::get('/backup', [AdminController::class, 'backupInfo']);
            Route::post('/backup', [AdminController::class, 'createBackup'])
                ->middleware('throttle:5,1');
            Route::get('/backup/download', [AdminController::class, 'downloadBackup']);
            Route::get('/system/health', [AdminController::class, 'health']);
            Route::get('/system/logs', [AdminController::class, 'logs']);
        });
    });

    // --- Muse-connected Job API (Phase 3) ---
    // Authenticated ONLY by the X-Muse-Api-Key header (muse.api
    // middleware), never by a user session. This is the channel the
    // worker uses to pick up Queued jobs, read their full settings and
    // source, report status, and upload rendered clips back.
    Route::prefix('muse')->middleware('muse.api')->group(function () {
        Route::get('/jobs', [MuseJobController::class, 'index']);
        Route::get('/jobs/{job}', [MuseJobController::class, 'show']);
        Route::get('/jobs/{job}/source', [MuseJobController::class, 'source']);
        // Batch 9: the worker downloads the job's music bed here
        // (404 when no bed was uploaded).
        Route::get('/jobs/{job}/music-bed', [MuseJobController::class, 'musicBed']);
        Route::get('/brand-assets/{asset}/download', [MuseJobController::class, 'downloadBrandAsset']);
        Route::patch('/jobs/{job}/status', [MuseJobController::class, 'updateStatus']);
        Route::post('/jobs/{job}/clips', [MuseJobController::class, 'storeClip'])
            ->middleware('throttle:30,1');
        Route::delete('/jobs/{job}/clips', [MuseJobController::class, 'destroyClips']);
        Route::get('/rerenders', [MuseJobController::class, 'listRerenders']);
        Route::patch('/rerenders/{rerender}/status', [MuseJobController::class, 'updateRerenderStatus']);
        Route::post('/clips/{clip}/file', [MuseJobController::class, 'replaceClipFile'])
            ->middleware('throttle:30,1');
        // Batch 9: an A/B variant render uploads as a NEW clip row
        // (Variant B) instead of replacing the original in place.
        Route::post('/clips/{clip}/variant-file', [MuseJobController::class, 'uploadVariantClip'])
            ->middleware('throttle:30,1');
    });
});
