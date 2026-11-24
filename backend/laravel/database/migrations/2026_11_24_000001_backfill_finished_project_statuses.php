<?php

use App\Models\Project;
use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    /**
     * Repairs project rows stuck at "processing" from before the live
     * status sync (MuseJobController::updateStatus, 2026-11-23): their
     * jobs finished, but nothing ever flipped the project, so Dashboard
     * / My Projects kept showing finished projects as Processing. Runs
     * once on deploy; safe to re-run (it only touches projects whose
     * jobs are all finished).
     */
    public function up(): void
    {
        Project::backfillFinishedStatuses();
    }

    public function down(): void
    {
        // Data repair — nothing to reverse.
    }
};
