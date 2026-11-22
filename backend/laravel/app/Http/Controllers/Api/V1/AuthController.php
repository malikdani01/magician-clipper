<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\LoginRequest;
use App\Http\Requests\RegisterRequest;
use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
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

        $storageBytes = (int) Clip::whereIn('job_id', $jobIds)->sum('file_size_bytes');
        foreach ($user->processingJobs()->whereNotNull('source_path')->pluck('source_path') as $path) {
            try {
                if (Storage::disk('local')->exists($path)) {
                    $storageBytes += (int) Storage::disk('local')->size($path);
                }
            } catch (\Throwable) {
                // A missing source file contributes 0, never an error.
            }
        }

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
        ]);
    }
}
