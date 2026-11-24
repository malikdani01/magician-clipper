<?php

namespace App\Support;

/**
 * Small ffprobe/ffmpeg helpers shared by the API-host features that
 * need media inspection locally (brand-asset validation, per-clip
 * audio export). The heavy rendering still runs on the separate
 * Muse worker — these calls only probe or extract, never render.
 *
 * probe() returns null when ffprobe is missing OR the file is not a
 * playable video (no video stream, or a non-positive duration), so
 * callers must distinguish "binary missing" (ffprobePath() === null)
 * from "file invalid" (probe() === null with a binary present).
 */
class VideoProbe
{
    public static function ffprobePath(): ?string
    {
        $path = trim((string) shell_exec('command -v ffprobe'));

        return $path === '' ? null : $path;
    }

    public static function ffmpegPath(): ?string
    {
        $path = trim((string) shell_exec('command -v ffmpeg'));

        return $path === '' ? null : $path;
    }

    /**
     * Probe a local video file with ffprobe. Returns
     * [duration, width, height, has_video, has_audio] or null when
     * ffprobe is unavailable / the file is not a playable video.
     */
    public static function probe(string $absolutePath): ?array
    {
        $ffprobe = self::ffprobePath();
        if ($ffprobe === null) {
            return null;
        }

        $command = escapeshellcmd($ffprobe)
            .' -v error -show_format -show_streams -of json '
            .escapeshellarg($absolutePath);
        $output = shell_exec($command);
        if ($output === null || $output === '') {
            return null;
        }
        $data = json_decode($output, true);
        if (! is_array($data) || empty($data['streams'])) {
            return null;
        }

        $video = null;
        $audio = null;
        foreach ($data['streams'] as $stream) {
            if ($stream['codec_type'] === 'video' && $video === null) {
                $video = $stream;
            }
            if ($stream['codec_type'] === 'audio' && $audio === null) {
                $audio = $stream;
            }
        }
        if ($video === null) {
            return null;
        }

        $duration = (float) ($data['format']['duration'] ?? $video['duration'] ?? 0);
        if ($duration <= 0) {
            return null;
        }

        return [
            'duration' => $duration,
            'width' => (int) ($video['width'] ?? 0),
            'height' => (int) ($video['height'] ?? 0),
            'has_video' => true,
            'has_audio' => $audio !== null,
        ];
    }
}
