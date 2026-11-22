<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Application Name
    |--------------------------------------------------------------------------
    */
    'name' => env('APP_NAME', 'Magician Clipper'),

    /*
    |--------------------------------------------------------------------------
    | Application Environment
    |--------------------------------------------------------------------------
    */
    'env' => env('APP_ENV', 'production'),

    /*
    |--------------------------------------------------------------------------
    | Application Debug Mode
    |--------------------------------------------------------------------------
    */
    'debug' => (bool) env('APP_DEBUG', false),

    /*
    |--------------------------------------------------------------------------
    | Application URL
    |--------------------------------------------------------------------------
    */
    'url' => env('APP_URL', 'http://localhost'),

    'asset_url' => env('ASSET_URL'),

    /*
    |--------------------------------------------------------------------------
    | Application Timezone
    |--------------------------------------------------------------------------
    */
    'timezone' => 'UTC',

    /*
    |--------------------------------------------------------------------------
    | Application Locale Configuration
    |--------------------------------------------------------------------------
    */
    'locale' => env('APP_LOCALE', 'en'),
    'fallback_locale' => env('APP_FALLBACK_LOCALE', 'en'),
    'faker_locale' => env('APP_FAKER_LOCALE', 'en_US'),

    /*
    |--------------------------------------------------------------------------
    | Encryption Key
    |--------------------------------------------------------------------------
    */
    'key' => env('APP_KEY'),
    'cipher' => 'AES-256-CBC',

    'maintenance' => [
        'driver' => env('APP_MAINTENANCE_DRIVER', 'file'),
        'store' => env('APP_MAINTENANCE_STORE', 'database'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Magician Clipper settings
    |--------------------------------------------------------------------------
    | VIDEO_ENGINE_URL: Python FastAPI video-engine base URL. Laravel is the
    | source of truth for users/projects/jobs; the engine only processes.
    */
    'video_engine_url' => env('VIDEO_ENGINE_URL', 'http://127.0.0.1:8001'),

    /*
    |--------------------------------------------------------------------------
    | Muse Job API key
    |--------------------------------------------------------------------------
    | Server-side key for the Muse-connected Job System (Phase 3). The
    | worker sends it as the X-Muse-Api-Key header. Generated with
    | `openssl rand -hex 32` and stored ONLY in backend/laravel/.env as
    | MUSE_JOB_API_KEY (never printed, logged or committed).
    */
    'muse_job_api_key' => env('MUSE_JOB_API_KEY'),
    'video_engine_timeout' => (int) env('VIDEO_ENGINE_TIMEOUT', 10),

    'max_upload_mb' => (int) env('CLIPPER_MAX_UPLOAD_MB', 4096),
    'allowed_extensions' => explode(',', env('CLIPPER_ALLOWED_EXTENSIONS', 'mp4,mov,mkv,webm')),
    'temp_retention_hours' => (int) env('CLIPPER_TEMP_RETENTION_HOURS', 72),
];
