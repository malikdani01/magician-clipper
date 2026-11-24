<?php

namespace Tests\Feature;

use App\Models\Clip;
use App\Models\ProcessingJob;
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Per-clip audio export: GET /api/v1/clips/{clip}/audio extracts the
 * audio track to a cached .m4a (AAC 128k) and streams it. A clip with
 * no audio track, a missing file, or another owner's clip never gets
 * a fabricated or leaked download.
 */
class ClipsAudioTest extends TestCase
{
    use RefreshDatabase;

    private string $tmpDir;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');

        $this->tmpDir = sys_get_temp_dir().'/clipper-audio-'.uniqid();
        mkdir($this->tmpDir, 0777, true);
        $this->makeVideo("{$this->tmpDir}/with-audio.mp4", true);
        $this->makeVideo("{$this->tmpDir}/silent.mp4", false);
    }

    protected function tearDown(): void
    {
        foreach (glob("{$this->tmpDir}/*") ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->tmpDir);
        parent::tearDown();
    }

    private function makeVideo(string $path, bool $withAudio): void
    {
        $audio = $withAudio
            ? ' -f lavfi -i sine=frequency=440:duration=2 -c:a aac -shortest'
            : ' -an';
        $command = 'ffmpeg -y -v error -f lavfi -i testsrc=duration=2:size=320x240:rate=30'
            .$audio.' -c:v libx264 -pix_fmt yuv420p '.escapeshellarg($path);
        shell_exec($command);
        $this->assertFileExists($path, 'Test video generation failed — is ffmpeg installed?');
    }

    private function makeClip(User $user, ?string $outputPath, string $sourceFile = 'with-audio.mp4'): Clip
    {
        $project = Project::create([
            'user_id' => $user->id,
            'title' => 'audio test',
            'status' => Project::STATUS_PROCESSING,
        ]);
        $job = ProcessingJob::create([
            'project_id' => $project->id,
            'user_id' => $user->id,
            'state' => ProcessingJob::STATE_COMPLETED,
        ]);

        if ($outputPath !== null) {
            Storage::disk('local')->put(
                $outputPath,
                file_get_contents("{$this->tmpDir}/{$sourceFile}")
            );
        }

        return Clip::create([
            'project_id' => $project->id,
            'job_id' => $job->id,
            'title' => 'Clip 1',
            'start_seconds' => 0,
            'end_seconds' => 2,
            'duration_seconds' => 2,
            'status' => 'ready',
            'output_path' => $outputPath,
        ]);
    }

    /** ffprobe a raw audio payload: true when it carries an AAC stream. */
    private function hasAacAudio(string $bytes): bool
    {
        $tmp = tempnam(sys_get_temp_dir(), 'clipper-m4a-').'.m4a';
        file_put_contents($tmp, $bytes);
        $output = shell_exec('ffprobe -v error -show_entries stream=codec_type,codec_name -of csv '.escapeshellarg($tmp));
        @unlink($tmp);

        return $output !== null
            && str_contains($output, 'audio')
            && str_contains($output, 'aac');
    }

    public function test_happy_path_returns_a_real_m4a_with_an_audio_stream(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');

        $response = $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/audio");

        $response->assertStatus(200);
        $this->assertStringContainsString('audio', $response->headers->get('Content-Type'));
        $this->assertStringContainsString('.m4a', $response->headers->get('Content-Disposition'));

        $bytes = $response->streamedContent();
        $this->assertGreaterThan(0, strlen($bytes));
        $this->assertTrue($this->hasAacAudio($bytes), 'Extracted file has no AAC audio stream');

        // The extraction is cached on disk for the next call.
        $this->assertTrue(Storage::disk('local')->exists("audio/{$clip->id}.m4a"));
    }

    public function test_cached_second_call_still_200_and_does_not_re_extract(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');

        $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/audio")
            ->assertStatus(200);
        $cachedAt = Storage::disk('local')->lastModified("audio/{$clip->id}.m4a");

        sleep(1);

        $response = $this->actingAs($user, 'sanctum')
            ->get("/api/v1/clips/{$clip->id}/audio");
        $response->assertStatus(200);
        $this->assertTrue($this->hasAacAudio($response->streamedContent()));
        $this->assertSame(
            $cachedAt,
            Storage::disk('local')->lastModified("audio/{$clip->id}.m4a"),
            'Second call re-extracted instead of reusing the cached file'
        );
    }

    public function test_clip_without_an_audio_track_is_404(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4', 'silent.mp4');

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/audio")
            ->assertStatus(404)
            ->assertJson([
                'error' => 'not_found',
                'message' => 'This clip has no audio track.',
            ]);
        $this->assertFalse(Storage::disk('local')->exists("audio/{$clip->id}.m4a"));
    }

    public function test_clip_without_a_rendered_file_is_404(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user, null);

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/audio")
            ->assertStatus(404)
            ->assertJson([
                'error' => 'not_found',
                'message' => 'This clip has no rendered file to extract audio from yet.',
            ]);
    }

    public function test_wiped_file_is_404_file_removed(): void
    {
        $user = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');
        Storage::disk('local')->delete('clips/1/clip_01.mp4');

        $this->actingAs($user, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/audio")
            ->assertStatus(404)
            ->assertJsonPath('error', 'file_removed');
    }

    public function test_other_user_cannot_extract_audio(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $clip = $this->makeClip($user, 'clips/1/clip_01.mp4');

        // Same authorization as download (ClipPolicy::view): another
        // user is refused, never served the file.
        $this->actingAs($other, 'sanctum')
            ->getJson("/api/v1/clips/{$clip->id}/audio")
            ->assertStatus(403);
    }
}
