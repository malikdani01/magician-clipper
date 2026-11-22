<?php

namespace App\Providers;

use App\Models\Clip;
use App\Models\Project;
use App\Policies\ClipPolicy;
use App\Policies\ProjectPolicy;
use Illuminate\Support\Facades\Gate;
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
    }
}
