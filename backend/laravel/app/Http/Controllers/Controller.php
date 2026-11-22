<?php

namespace App\Http\Controllers;

use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Foundation\Validation\ValidatesRequests;
use Illuminate\Routing\Controller as BaseController;

abstract class Controller extends BaseController
{
    use AuthorizesRequests, ValidatesRequests;

    /**
     * Honest placeholder for a Phase 2/3 action that is routed but not
     * implemented yet. Never fake success — the frontend must show this
     * as "not implemented", not as a completed operation (spec §1).
     */
    protected function notImplemented(string $message)
    {
        return response()->json([
            'error' => 'not_implemented',
            'message' => $message,
        ], 501);
    }
}
