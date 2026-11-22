<?php

/*
|--------------------------------------------------------------------------
| Cross-Origin Resource Sharing (CORS) — Phase 3 (Worker B blocker fix)
|--------------------------------------------------------------------------
| HandleCors is in Laravel's default global middleware stack, but without
| this config file `cors.paths` was empty, so no Access-Control-Allow-Origin
| headers were ever added and preflight OPTIONS to /api/* had no route —
| a hosted frontend (one origin) calling the hosted API (another origin)
| would be blocked by the browser on every request, login included.
|
| Allowed origins come from FRONTEND_URL (comma-separated list supported):
| set it to the hosted frontend origin in production. It defaults to the
| local dev origins (Vite on localhost:5173 / 127.0.0.1:5173) plus the
| local preview origins (Vite preview on localhost:4173 / 127.0.0.1:4173)
| — the preview is a different origin from the dev server, so leaving it
| out blocks register/login from the preview in the browser.
| `supports_credentials` is true because Sanctum authenticates with
| cookies for the SPA in addition to bearer tokens.
*/

$frontendOrigins = array_values(array_filter(array_map(
    'trim',
    explode(',', (string) env(
        'FRONTEND_URL',
        'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
    ))
)));

return [

    /*
    |--------------------------------------------------------------------------
    | Cross-Origin Resource Sharing Paths
    |--------------------------------------------------------------------------
    */

    'paths' => ['api/*', 'sanctum/csrf-cookie'],

    'allowed_methods' => ['*'],

    'allowed_origins' => $frontendOrigins,

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [],

    'max_age' => 0,

    'supports_credentials' => true,

];
