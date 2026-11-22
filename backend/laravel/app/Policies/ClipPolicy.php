<?php

namespace App\Policies;

use App\Models\Clip;
use App\Models\User;

class ClipPolicy
{
    public function viewAny(User $user): bool
    {
        return true;
    }

    public function view(User $user, Clip $clip): bool
    {
        return $user->isAdmin() || $clip->project->user_id === $user->id;
    }

    public function update(User $user, Clip $clip): bool
    {
        return $user->isAdmin() || $clip->project->user_id === $user->id;
    }

    public function render(User $user, Clip $clip): bool
    {
        return $user->isAdmin() || $clip->project->user_id === $user->id;
    }

    public function delete(User $user, Clip $clip): bool
    {
        return $user->isAdmin() || $clip->project->user_id === $user->id;
    }
}
