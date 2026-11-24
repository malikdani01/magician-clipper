<?php

namespace App\Support;

use App\Models\Clip;
use App\Models\ProcessingJob;
use Illuminate\Support\Facades\Storage;

/**
 * The ONE canonical storage-used definition for the whole panel:
 * rendered clip files (from the clips table) + project source files
 * that still exist on disk. The user dashboard, the Usage page and
 * the admin dashboard all report this number, so all three agree.
 * A missing source file contributes 0, never an error.
 *
 * Pass null for $userId for the global (admin) total.
 */
class StorageUsage
{
    public static function totalBytes(?int $userId = null): int
    {
        $jobs = ProcessingJob::query()
            ->when($userId !== null, fn ($query) => $query->where('user_id', $userId));

        $jobIds = (clone $jobs)->pluck('id');
        $bytes = (int) Clip::whereIn('job_id', $jobIds)->sum('file_size_bytes');

        foreach ((clone $jobs)->whereNotNull('source_path')->pluck('source_path') as $path) {
            try {
                if (Storage::disk('local')->exists($path)) {
                    $bytes += (int) Storage::disk('local')->size($path);
                }
            } catch (\Throwable) {
                // A missing source file contributes 0, never an error.
            }
        }

        return $bytes;
    }
}
