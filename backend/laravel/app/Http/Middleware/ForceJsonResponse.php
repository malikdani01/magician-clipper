<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Force JSON responses for /api/* (Phase 3 — FIX 1).
 *
 * Laravel decides between a JSON error and an HTML redirect/error page from
 * the request's Accept header. API clients that omit Accept (curl, the
 * worker, scripts) got an HTML 500 from the auth layer instead of a 401
 * JSON. This middleware runs before route-level auth and forces
 * Accept: application/json for every API request, so unauthenticated
 * calls return 401 JSON. (The exception renderer in bootstrap/app.php is
 * the second line of defence for the same case.)
 */
class ForceJsonResponse
{
    public function handle(Request $request, Closure $next): Response
    {
        $request->headers->set('Accept', 'application/json');

        return $next($request);
    }
}
