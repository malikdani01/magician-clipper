<?php

namespace App\Providers;

use App\Models\Clip;
use App\Models\Project;
use App\Policies\ClipPolicy;
use App\Policies\ProjectPolicy;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Gate::policy(Project::class, ProjectPolicy::class);
        Gate::policy(Clip::class, ClipPolicy::class);

        // Media assets and processing jobs are authorized through their
        // owning project (ProjectPolicy::view / ::update on $job->project).

        // Admins may do everything the policies gate; ownership checks in
        // the policies themselves already allow admins through.
        Gate::before(function ($user, $ability) {
            if ($user->isAdmin()) {
                return true;
            }

            return null;
        });

        // Generated URLs (clip download_url, etc.) must use the same
        // scheme as APP_URL. Render terminates TLS and forwards plain
        // HTTP to the container, so without this the URL generator
        // follows the incoming request and builds http:// URLs — the
        // browser blocks those as mixed content on the https://
        // frontend, the download fetch throws, and the UI reports
        // "Backend is not reachable" even though the backend is up
        // (seen live 2026-11-23). Local dev keeps http because its
        // APP_URL is http://127.0.0.1:8000.
        if (str_starts_with((string) config('app.url'), 'https://')) {
            URL::forceScheme('https');
        } else {
            // Explicit reset so a stale forced scheme can never linger
            // (e.g. in tests that re-boot the provider with an http URL).
            URL::forceScheme(null);
        }
    }
}
