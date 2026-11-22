<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Admin-only gate for /api/v1/admin/* (spec §8).
 * Normal users must never access admin pages or APIs.
 * Returns 401 when unauthenticated, 403 when authenticated but not admin.
 */
class EnsureAdmin
{
    /**
     * Handle an incoming request.
     *
     * @param  \Closure(\Illuminate\Http\Request): (\Symfony\Component\HttpFoundation\Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user === null) {
            return response()->json([
                'error' => 'unauthenticated',
                'message' => 'Authentication required.',
            ], 401);
        }

        if (! $user->isAdmin()) {
            return response()->json([
                'error' => 'forbidden',
                'message' => 'Admin access required.',
            ], 403);
        }

        return $next($request);
    }
}
