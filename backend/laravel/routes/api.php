<?php

use App\Http\Controllers\Api\V1\AdminController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\ClipController;
use App\Http\Controllers\Api\V1\ExportController;
use App\Http\Controllers\Api\V1\JobController;
use App\Http\Controllers\Api\V1\MediaController;
use App\Http\Controllers\Api\V1\MuseJobController;
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

    Route::middleware('auth:sanctum')->group(function () {

        Route::post('/auth/logout', [AuthController::class, 'logout']);
        Route::get('/me', [AuthController::class, 'me']);
        Route::get('/me/stats', [AuthController::class, 'stats']);

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

        // --- Clips ---
        Route::get('/projects/{project}/clips', [ClipController::class, 'index']);
        Route::get('/clips/{clip}', [ClipController::class, 'show']);
        Route::get('/clips/{clip}/download', [ClipController::class, 'download']);
        Route::get('/clips/{clip}/thumbnail', [ClipController::class, 'thumbnail']);
        Route::patch('/clips/{clip}', [ClipController::class, 'update']);
        Route::post('/clips/{clip}/render', [ClipController::class, 'render'])
            ->middleware('throttle:6,1');
        Route::get('/clips/{clip}/rerenders', [ClipController::class, 'rerenders']);

        // --- Exports ---
        Route::post('/projects/{project}/export', [ExportController::class, 'store'])
            ->middleware('throttle:6,1');
        Route::get('/exports', [ExportController::class, 'index']);
        Route::get('/exports/{export}', [ExportController::class, 'show']);
        Route::get('/exports/{export}/download', [ExportController::class, 'download']);

        // --- Settings ---
        Route::get('/settings', [SettingsController::class, 'show']);
        Route::patch('/settings', [SettingsController::class, 'update']);

        // --- Admin (role-gated) ---
        Route::prefix('admin')->middleware('admin')->group(function () {
            Route::get('/dashboard', [AdminController::class, 'dashboard']);
            Route::get('/users', [AdminController::class, 'users']);
            Route::get('/projects', [AdminController::class, 'projects']);
            Route::get('/jobs', [AdminController::class, 'jobs']);
            Route::post('/jobs/{job}/retry', [AdminController::class, 'retryJob']);
            Route::post('/jobs/{job}/cancel', [AdminController::class, 'cancelJob']);
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
        Route::patch('/jobs/{job}/status', [MuseJobController::class, 'updateStatus']);
        Route::post('/jobs/{job}/clips', [MuseJobController::class, 'storeClip'])
            ->middleware('throttle:30,1');
        Route::delete('/jobs/{job}/clips', [MuseJobController::class, 'destroyClips']);
        Route::get('/rerenders', [MuseJobController::class, 'listRerenders']);
        Route::patch('/rerenders/{rerender}/status', [MuseJobController::class, 'updateRerenderStatus']);
        Route::post('/clips/{clip}/file', [MuseJobController::class, 'replaceClipFile'])
            ->middleware('throttle:30,1');
    });
});
