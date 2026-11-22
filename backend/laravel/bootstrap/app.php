<?php

use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        // API routes are stateless token auth (Sanctum); no CSRF on /api/*.
        // Web routes keep the default Laravel web middleware stack.
        $middleware->alias([
            'admin' => \App\Http\Middleware\EnsureAdmin::class,
            'muse.api' => \App\Http\Middleware\EnsureMuseApiKey::class,
        ]);
        // FIX 1 (Phase 3): force Accept: application/json on every /api/*
        // request so unauthenticated calls without an Accept header return
        // 401 JSON instead of an HTML 500. Runs before route-level auth.
        //
        // NOTE: merely appending to the `api` group is NOT enough. Laravel
        // sorts route middleware by its priority list, and
        // Authenticate (via the AuthenticatesRequests contract) is IN that
        // list while group middleware is not — so the sort promotes
        // auth:sanctum ahead of any api-group middleware and the auth
        // layer redirects to the (nonexistent) `login` route before our
        // middleware ever runs. Registering ForceJsonResponse in the
        // priority list immediately before AuthenticatesRequests is what
        // actually guarantees it runs first.
        $middleware->api(append: [
            \App\Http\Middleware\ForceJsonResponse::class,
        ]);
        $middleware->prependToPriorityList(
            \Illuminate\Contracts\Auth\Middleware\AuthenticatesRequests::class,
            \App\Http\Middleware\ForceJsonResponse::class,
        );
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // FIX 1, second line of defence: an AuthenticationException on an
        // /api/* request is always a 401 JSON, never an HTML redirect/page.
        $exceptions->render(function (AuthenticationException $e, Request $request) {
            if ($request->is('api/*')) {
                return response()->json([
                    'message' => 'Unauthenticated.',
                    'code' => 'UNAUTHENTICATED',
                ], 401);
            }
        });
    })->create();
