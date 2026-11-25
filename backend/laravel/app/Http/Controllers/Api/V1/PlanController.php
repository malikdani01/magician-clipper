<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Plan;
use App\Models\PlanRequest;
use App\Support\PlanService;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Plans (Batch 11) — user-facing.
 *
 * Manual activation only: a user REQUESTS a plan here; an admin
 * approves it in Admin Panel → Plan Requests after confirming the
 * payment, which happened outside the app. There is no payment
 * gateway, no checkout, no card handling anywhere in this batch.
 */
class PlanController extends Controller
{
    /**
     * GET /api/v1/plans — the active plans a user can request.
     * Inactive plans are never listed (they cannot be bought).
     */
    public function index()
    {
        $plans = Plan::where('active', true)
            ->orderBy('id')
            ->get(['id', 'name', 'price_display', 'duration_days',
                'total_clips', 'daily_clips', 'max_export_quality',
                'features', 'active']);

        return response()->json(['plans' => $plans]);
    }

    /**
     * GET /api/v1/me/plan — my current plan + usage + effective
     * limits (PlanService::planSummary). The Free plan is virtual —
     * it is never a plans row.
     */
    public function myPlan(Request $request)
    {
        return response()->json(PlanService::planSummary($request->user()));
    }

    /**
     * GET /api/v1/plan-requests — my requests, newest first, with
     * the plan name and any decline reason.
     */
    public function myRequests(Request $request)
    {
        $requests = $request->user()->planRequests()
            ->with('plan:id,name,price_display')
            ->latest()
            ->get(['id', 'plan_id', 'note', 'status', 'decline_reason', 'created_at', 'updated_at']);

        return response()->json(['requests' => $requests]);
    }

    /**
     * POST /api/v1/plan-requests — request a plan. One pending
     * request per plan per user: a second request for the same plan
     * while one is pending is a 422 (the first one is still waiting
     * on the admin). Requesting the plan you already have active is
     * also a 422 — it is already yours.
     */
    public function requestPlan(Request $request)
    {
        $validated = $request->validate([
            'plan_id' => ['required', 'integer', 'exists:plans,id'],
            'note' => ['sometimes', 'nullable', 'string', 'max:1000'],
        ]);

        $plan = Plan::findOrFail($validated['plan_id']);
        if (! $plan->active) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => 'This plan is not available right now.',
            ], 422);
        }

        $user = $request->user();
        $active = PlanService::activePlan($user);
        if ($active !== null && $active->plan_id === $plan->id) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "You already have the {$plan->name} plan active.",
            ], 422);
        }

        $pending = PlanRequest::where('user_id', $user->id)
            ->where('plan_id', $plan->id)
            ->where('status', PlanRequest::STATUS_PENDING)
            ->exists();
        if ($pending) {
            return response()->json([
                'error' => 'invalid_state',
                'message' => "You already have a pending request for the {$plan->name} plan — the admin will review it.",
            ], 422);
        }

        $planRequest = PlanRequest::create([
            'user_id' => $user->id,
            'plan_id' => $plan->id,
            'note' => $validated['note'] ?? null,
            'status' => PlanRequest::STATUS_PENDING,
        ]);

        return response()->json(['request' => $planRequest->load('plan:id,name,price_display')], 201);
    }
}
