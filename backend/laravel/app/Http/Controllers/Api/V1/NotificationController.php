<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Notification;
use Illuminate\Http\Request;

class NotificationController extends Controller
{
    /**
     * GET /api/v1/notifications — my notifications, newest first.
     */
    public function index(Request $request)
    {
        $notifications = Notification::where('user_id', $request->user()->id)
            ->latest()
            ->paginate(20);

        return response()->json($notifications);
    }

    /**
     * PATCH /api/v1/notifications/{id}/read — mark one of my
     * notifications read. Another user's notification is a 404,
     * never a leak or a mark.
     */
    public function markRead(Request $request, Notification $notification)
    {
        if ($notification->user_id !== $request->user()->id) {
            return response()->json([
                'error' => 'not_found',
                'message' => 'No such notification.',
            ], 404);
        }

        $notification->update(['read_at' => now()]);

        return response()->json(['notification' => $notification->fresh()]);
    }

    /**
     * POST /api/v1/notifications/read-all — mark all my unread
     * notifications read. Returns how many were marked.
     */
    public function markAllRead(Request $request)
    {
        $updated = Notification::where('user_id', $request->user()->id)
            ->unread()
            ->update(['read_at' => now()]);

        return response()->json(['updated' => $updated]);
    }
}
