<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\LoginRequest;
use App\Http\Requests\RegisterRequest;
use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\User;
use App\Support\StorageUsage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function register(RegisterRequest $request)
    {
        $user = User::create([
            'name' => $request->validated('name'),
            'email' => $request->validated('email'),
            // 'hashed' cast on the model hashes this; explicit Hash keeps
            // behaviour identical if the cast ever changes.
            'password' => Hash::make($request->validated('password')),
            'role' => 'user',
            'plan' => 'free',
        ]);

        $token = $user->createToken('api')->plainTextToken;

        return response()->json([
            'user' => $user,
            'token' => $token,
            'token_type' => 'Bearer',
        ], 201);
    }

    public function login(LoginRequest $request)
    {
        $credentials = $request->validated();

        if (! Auth::attempt($credentials)) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are incorrect.'],
            ]);
        }

        /** @var User $user */
        $user = Auth::user();
        $token = $user->createToken('api')->plainTextToken;

        return response()->json([
            'user' => $user,
            'token' => $token,
            'token_type' => 'Bearer',
        ]);
    }

    public function logout(Request $request)
    {
        // Revoke only the token used for this request; other sessions stay valid.
        $request->user()->currentAccessToken()->delete();

        return response()->json(['message' => 'Logged out.']);
    }

    public function me(Request $request)
    {
        return response()->json(['user' => $request->user()]);
    }

    /**
     * GET /api/v1/me/stats — the signed-in user's real counts for the
     * dashboard stat cards (jobs, clips, in-flight jobs, storage).
     * Everything is counted from the database / disk, never estimated.
     */
    public function stats(Request $request)
    {
        $user = $request->user();
        $jobIds = $user->processingJobs()->pluck('id');

        // Canonical storage-used total (rendered clips + source files)
        // — the same number the admin dashboard reports, so both agree.
        $storageBytes = StorageUsage::totalBytes($user->id);

        return response()->json([
            'jobs_total' => $user->processingJobs()->count(),
            'jobs_processing' => $user->processingJobs()
                ->whereNotIn('state', array_merge(
                    ProcessingJob::TERMINAL_STATES,
                    [ProcessingJob::STATE_FAILED, ProcessingJob::STATE_CANCELLED]
                ))->count(),
            'clips_total' => Clip::whereIn('job_id', $jobIds)->count(),
            'clips_ready' => Clip::whereIn('job_id', $jobIds)
                ->where('status', Clip::STATUS_READY)->count(),
            'storage_bytes' => $storageBytes,
            // ffmpeg/ffprobe versions as last reported by the worker
            // (the hosted site has no engine URL to probe). Nulls
            // until the first report — the UI says so honestly.
            'engine' => Cache::get('engine_versions') ?? [
                'ffmpeg' => null, 'ffprobe' => null, 'reported_at' => null,
            ],
        ]);
    }
}
