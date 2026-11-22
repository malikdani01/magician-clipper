<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Authenticate the Muse-connected Job API (Phase 3).
 *
 * The worker is not a user: it authenticates with a long random server-side
 * key sent as the X-Muse-Api-Key header. The key is compared with
 * hash_equals (timing-safe) against MUSE_JOB_API_KEY from the environment.
 * A missing or mismatched key gets a plain 401 JSON — the key value is
 * never echoed back, and a missing server-side key also fails closed.
 */
class EnsureMuseApiKey
{
    public function handle(Request $request, Closure $next): Response
    {
        $configured = (string) config('app.muse_job_api_key', '');
        $provided = (string) $request->header('X-Muse-Api-Key', '');

        if ($configured === '' || $provided === '' || ! hash_equals($configured, $provided)) {
            return response()->json([
                'message' => 'Unauthenticated.',
                'code' => 'UNAUTHENTICATED',
            ], 401);
        }

        return $next($request);
    }
}
