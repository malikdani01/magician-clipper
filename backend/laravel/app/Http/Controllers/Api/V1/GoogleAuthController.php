<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Google sign-in (Batch 11) — manual OAuth 2.0 with the Google
 * APIs, no Socialite (Composer is not installed on this box and the
 * flow is three HTTP calls). Keys come LATER from the user, so the
 * flow must handle missing keys HONESTLY: the button stays visible
 * on the login/register pages, and clicking it without keys returns
 * a clear "Google login abhi configure nahi hai" message — never a
 * fake login, never a crash.
 *
 * Flow: GET /auth/google/redirect → { redirect_url } (or 422 when
 * not configured) → user signs in at Google → Google calls back to
 * GET /auth/google/callback?code=…&state=… → we exchange the code,
 * fetch the profile, link by email (existing email → link the
 * Google account + log in; new email → create the account, role
 * user, free plan + log in) → redirect to the frontend callback
 * page with a Sanctum token. Email/password login is untouched.
 */
class GoogleAuthController extends Controller
{
    public const NOT_CONFIGURED_MESSAGE = 'Google login abhi configure nahi hai — admin ko Google keys lagani hongi.';

    private const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

    /** True when all three Google env values are set. */
    public static function configured(): bool
    {
        $config = config('services.google');

        return ! empty($config['client_id'])
            && ! empty($config['client_secret'])
            && ! empty($config['redirect']);
    }

    /**
     * GET /api/v1/auth/google/redirect — the URL the frontend sends
     * the user to. 422 google_not_configured when the keys are not
     * set yet. The state token is a one-time CSRF token kept in the
     * cache for 10 minutes.
     */
    public function redirect()
    {
        if (! self::configured()) {
            return response()->json([
                'error' => 'google_not_configured',
                'message' => self::NOT_CONFIGURED_MESSAGE,
            ], 422);
        }

        $config = config('services.google');
        $state = Str::random(32);
        Cache::put('google_oauth_state:'.$state, true, now()->addMinutes(10));

        $url = self::AUTH_URL.'?'.http_build_query([
            'client_id' => $config['client_id'],
            'redirect_uri' => $config['redirect'],
            'response_type' => 'code',
            'scope' => 'openid email profile',
            'access_type' => 'offline',
            'prompt' => 'select_account',
            'state' => $state,
        ]);

        return response()->json(['redirect_url' => $url]);
    }

    /**
     * GET /api/v1/auth/google/callback — Google returns here with
     * ?code=…&state=…. Any failure redirects to the frontend
     * callback page with ?error=<code> (the page shows a plain
     * message; no internals leak into the URL).
     */
    public function callback(Request $request)
    {
        $frontend = $this->frontendBase();

        if (! self::configured()) {
            return redirect($frontend.'/auth/google/callback?error=not_configured');
        }

        $state = $request->query('state');
        if (! is_string($state) || ! Cache::pull('google_oauth_state:'.$state, false)) {
            return redirect($frontend.'/auth/google/callback?error=invalid_state');
        }

        $code = $request->query('code');
        if (! is_string($code) || $code === '') {
            return redirect($frontend.'/auth/google/callback?error=missing_code');
        }

        $config = config('services.google');
        $token = Http::asForm()->post(self::TOKEN_URL, [
            'code' => $code,
            'client_id' => $config['client_id'],
            'client_secret' => $config['client_secret'],
            'redirect_uri' => $config['redirect'],
            'grant_type' => 'authorization_code',
        ]);
        if (! $token->successful() || empty($token->json('access_token'))) {
            return redirect($frontend.'/auth/google/callback?error=token_exchange_failed');
        }

        $profile = Http::withToken($token->json('access_token'))->get(self::USERINFO_URL);
        if (! $profile->successful()) {
            return redirect($frontend.'/auth/google/callback?error=profile_failed');
        }

        $googleId = $profile->json('sub');
        $email = $profile->json('email');
        $name = $profile->json('name') ?: ($email ? Str::before($email, '@') : 'Google user');
        if (! is_string($googleId) || $googleId === '' || ! is_string($email) || $email === '') {
            return redirect($frontend.'/auth/google/callback?error=profile_failed');
        }

        // Link by email: an existing account (by google_id first,
        // then by email) is linked + logged in; a new email creates
        // the account (role user, free plan).
        $user = User::where('google_id', $googleId)->first()
            ?? User::where('email', $email)->first();

        if ($user === null) {
            $user = User::create([
                'name' => $name,
                'email' => $email,
                'password' => Hash::make(Str::random(32)),
                'role' => 'user',
                'plan' => 'free',
                'google_id' => $googleId,
                'email_verified_at' => now(),
            ]);
        } elseif ($user->google_id === null) {
            $user->update([
                'google_id' => $googleId,
                'email_verified_at' => $user->email_verified_at ?? now(),
            ]);
        }

        if ($user->isSuspended()) {
            return redirect($frontend.'/auth/google/callback?error=account_suspended');
        }

        $apiToken = $user->createToken('api-google')->plainTextToken;

        return redirect($frontend.'/auth/google/callback?token='.urlencode($apiToken));
    }

    /**
     * The frontend base URL for the callback redirect. FRONTEND_URL
     * holds a comma-separated list (local dev); the first entry wins.
     * Falls back to the app URL when unset.
     */
    private function frontendBase(): string
    {
        $raw = (string) (env('FRONTEND_URL') ?? '');
        $first = trim(explode(',', $raw)[0] ?? '');

        return $first !== '' ? rtrim($first, '/') : rtrim((string) config('app.url'), '/');
    }
}
