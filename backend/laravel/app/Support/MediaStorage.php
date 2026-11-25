<?php

namespace App\Support;

use App\Models\CloudStorageSetting;
use App\Models\ProcessingJob;
use App\Models\User;
use Aws\S3\S3Client;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Storage;
use League\Flysystem\AwsS3V3\AwsS3V3Adapter;
use League\Flysystem\Filesystem as LeagueFilesystem;

/**
 * Batch 5 (2026-11-25): one place that knows WHERE a user's media
 * lives — the local disk (as before) or their configured S3-compatible
 * cloud bucket (Cloudflare R2 / AWS S3 / custom endpoint).
 *
 * Rules:
 * - Cloud is used ONLY when the user has a cloud_storage_settings row
 *   AND enabled is true. Anything else (no row, disabled, incomplete)
 *   falls back to 'local' — the app works exactly as before.
 * - Files remember their disk: clips carry `disk`, jobs carry `disk`.
 *   Reads always use the record's own disk, never the current setting
 *   (so toggling cloud off does not orphan files already stored there).
 * - The secret never leaves the model: it is read from the encrypted
 *   cast and handed straight to the S3 client, never logged.
 */
class MediaStorage
{
    public const DISK_LOCAL = 'local';
    public const DISK_CLOUD = 'cloud';

    /** Which disk NEW media for this user goes to. */
    public static function diskNameFor(?User $user): string
    {
        if ($user === null) {
            return self::DISK_LOCAL;
        }
        $settings = CloudStorageSetting::where('user_id', $user->id)->first();
        if ($settings === null || ! $settings->enabled) {
            return self::DISK_LOCAL;
        }
        if ($settings->bucket === '' || $settings->access_key_id === '') {
            return self::DISK_LOCAL;
        }

        return self::DISK_CLOUD;
    }

    /**
     * Filesystem for a stored disk name + the file's owner. 'cloud'
     * builds an S3 disk from the owner's stored settings; anything
     * unbuildable falls back to the local disk (never a crash).
     */
    public static function disk(string $disk, ?User $user = null): Filesystem
    {
        if ($disk === self::DISK_CLOUD && $user !== null) {
            $built = self::buildCloudDisk($user);
            if ($built !== null) {
                return $built;
            }
        }

        return Storage::disk(self::DISK_LOCAL);
    }

    /** Disk for a job (its source lives on the job's disk). */
    public static function diskForJob(ProcessingJob $job): Filesystem
    {
        return self::disk($job->disk ?? self::DISK_LOCAL, $job->user);
    }

    /**
     * Build the S3 disk from the user's stored cloud settings, or null
     * when cloud is not configured/enabled. $s3Client is injectable so
     * tests can stand in for the network (a mocked client) — the
     * put/delete logic is then proven without a real bucket.
     */
    public static function buildCloudDisk(User $user, $s3Client = null, bool $requireEnabled = true): ?FilesystemAdapter
    {
        $settings = CloudStorageSetting::where('user_id', $user->id)->first();
        if ($settings === null || ($requireEnabled && ! $settings->enabled)) {
            return null;
        }
        if ($settings->bucket === '' || $settings->access_key_id === '') {
            return null;
        }

        // Test seam: when the container holds a 'clipper.s3-client'
        // binding, use it instead of building a real client. Tests bind
        // a fake there; production never binds it, so real code always
        // builds a real S3Client from the stored settings.
        $client = $s3Client ?? (app()->bound('clipper.s3-client')
            ? app('clipper.s3-client')
            : new S3Client(self::clientConfig($settings)));
        $adapter = new AwsS3V3Adapter($client, $settings->bucket);
        $filesystem = new LeagueFilesystem($adapter);

        return new FilesystemAdapter($filesystem, $adapter);
    }

    /** S3 client config for a provider preset. */
    public static function clientConfig(CloudStorageSetting $settings): array
    {
        $config = [
            'version' => 'latest',
            'region' => $settings->region !== '' ? $settings->region : 'auto',
            'credentials' => [
                'key' => $settings->access_key_id,
                'secret' => $settings->secret_access_key,
            ],
        ];
        // R2 and custom endpoints need an explicit endpoint; plain AWS
        // S3 uses the SDK default (region-derived). Path-style URLs
        // are the norm for S3-compatible endpoints (MinIO, R2 with a
        // custom domain); AWS S3 keeps virtual-host style.
        if ($settings->provider === 's3') {
            $config['use_path_style_endpoint'] = false;
        } else {
            $config['use_path_style_endpoint'] = true;
            if ($settings->endpoint !== null && $settings->endpoint !== '') {
                $config['endpoint'] = $settings->endpoint;
            }
        }

        return $config;
    }

    /**
     * A real local path for a stored file — for ffprobe/ffmpeg, which
     * only read local files. Local disk: the storage path itself.
     * Cloud disk: downloads to a temp file first.
     * Returns [path, isTemp] — the caller must unlink the path when
     * isTemp is true.
     */
    public static function localPathFor(string $disk, string $path, ?User $user = null): array
    {
        if ($disk !== self::DISK_CLOUD) {
            return [Storage::disk(self::DISK_LOCAL)->path($path), false];
        }
        $tmp = tempnam(sys_get_temp_dir(), 'clipper-cloud-');
        if ($tmp === false) {
            throw new \RuntimeException('Could not create a temp file for the cloud download.');
        }
        $contents = self::disk($disk, $user)->get($path);
        if ($contents === null) {
            @unlink($tmp);
            throw new \RuntimeException("Cloud file not found: {$path}");
        }
        file_put_contents($tmp, $contents);

        return [$tmp, true];
    }
}
