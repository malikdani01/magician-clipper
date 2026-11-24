"""Unit tests for the Muse worker (stdlib unittest — no pytest needed).

Run from services/video-engine/workers:
    python3 -m unittest test_muse_worker -v

Covers the Stronger Clipper round (2026-11-23):
  * visual-moment fill when speech is scarce (energy-ranked, labelled,
    non-overlapping, duration-honouring);
  * energy-ranked zero-speech fallback, and the uniform fallback only
    for a silent source;
  * per-clip failure isolation in process_job (one bad clip no longer
    fails the whole job; the job ends Ready with a note).
"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import muse_worker


def _words(start: float, end: float, text: str) -> list[dict]:
    """One word per second over [start, end], last word ends the sentence."""
    parts = text.split()
    n = max(1, len(parts))
    step = (end - start) / n
    out = []
    for i, word in enumerate(parts):
        out.append({"word": word, "start": start + i * step,
                    "end": start + (i + 1) * step})
    return out


def _segment(start: float, end: float, text: str) -> dict:
    return {"start": start, "end": end, "text": text,
            "words": _words(start, end, text)}


def _settings(**overrides) -> dict:
    base = {
        "platform": "tiktok",
        "aspect_ratio": "9:16",
        "clip_count": 3,
        "duration_mode": "exact",
        "duration_seconds": 30,
        "captions_enabled": True,
        "captions_language": "english",
        "on_screen_text": False,
        "job_type": "myself",
        "layout": "split",
        "content_type": "general",
    }
    base.update(overrides)
    return base


class VisualMomentTests(unittest.TestCase):
    def test_visual_moments_fill_speech_shortfall(self):
        # One 30s speech stretch in a 200s source; 3 clips requested.
        segments = [_segment(10.0, 40.0, "This is the one good story here.")]
        energy = [0.05] * 200
        for i in range(100, 111):
            energy[i] = 0.9
        for i in range(170, 181):
            energy[i] = 0.8
        clips = muse_worker.select_highlights(
            segments, 200.0, _settings(), energy, [])
        self.assertEqual(len(clips), 3)
        speech = [c for c in clips if "visual_moment" not in c["signals"]]
        visual = [c for c in clips if "visual_moment" in c["signals"]]
        self.assertEqual(len(speech), 1)
        self.assertEqual(len(visual), 2)
        # Every clip honours the exact 30s duration.
        for c in clips:
            self.assertAlmostEqual(c["duration"], 30.0, places=1)
        # Visual windows sit on the loud peaks, not on the speech window.
        centres = sorted((c["start"] + c["end"]) / 2 for c in visual)
        self.assertAlmostEqual(centres[0], 100.5, delta=3.0)
        self.assertAlmostEqual(centres[1], 170.5, delta=3.0)
        # No overlaps anywhere.
        ordered = sorted(clips, key=lambda c: c["start"])
        for a, b in zip(ordered, ordered[1:]):
            self.assertLessEqual(a["end"], b["start"])
        # Visual clips are labelled honestly, never as speech highlights.
        for c in visual:
            self.assertIn("Not a speech highlight", c["reason"])
            self.assertEqual(c["words"], 0)

    def test_zero_speech_uses_energy_peaks_not_uniform_windows(self):
        energy = [0.05] * 200
        for i in range(45, 56):
            energy[i] = 0.9
        for i in range(145, 156):
            energy[i] = 0.85
        clips = muse_worker.select_highlights(
            [], 200.0, _settings(clip_count=2), energy, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertIn("visual_moment", c["signals"])
            self.assertNotIn("no_speech_fallback", c["signals"])
        centres = sorted((c["start"] + c["end"]) / 2 for c in clips)
        # Peaks are plateaus (45–55, 145–155); ties break to the earliest
        # peak second, so windows centre on 45.5 and 145.5.
        self.assertAlmostEqual(centres[0], 45.5, delta=3.0)
        self.assertAlmostEqual(centres[1], 145.5, delta=3.0)

    def test_silent_source_still_falls_back_to_uniform_windows(self):
        clips = muse_worker.select_highlights(
            [], 200.0, _settings(clip_count=2), [0.0] * 200, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertEqual(c["signals"], ["no_speech_fallback"])
        self.assertAlmostEqual(clips[0]["start"], 0.0)
        self.assertAlmostEqual(clips[1]["start"], 30.0)

    def test_ready_note_explains_shortfall_and_failures(self):
        self.assertIsNone(muse_worker._ready_note([{}, {}, {}], 3, []))
        note = muse_worker._ready_note(
            [{"signals": ["speech_density"]},
             {"signals": ["visual_moment"]}], 3, [])
        self.assertIn("Only 2 of 3", note)
        self.assertIn("1 visual moment(s)", note)
        note = muse_worker._ready_note([{}, {}], 2, ["Clip 2 (99.5–129.5s): boom"])
        self.assertIn("1 clip(s) failed to render", note)
        self.assertIn("Clip 2", note)


class ScoreBreakdownTests(unittest.TestCase):
    """Every selected window carries a score_breakdown of the signals
    the selector actually computed for it (viral score feature 3):
    speech windows get all seven, visual-moment / any-part windows
    only energy/gameplay/stability, the uniform fallback only energy —
    never a padded or invented signal. upload_clip sends the breakdown
    as a JSON-encoded multipart field."""

    def test_speech_window_carries_full_breakdown(self):
        # Single 30s speech stretch, flat energy, no face profile: the
        # selector's own normalised values are fully determined.
        segments = [_segment(10.0, 40.0, "This is the one good story here.")]
        clips = muse_worker.select_highlights(
            segments, 200.0, _settings(clip_count=1), [0.05] * 200, [])
        self.assertEqual(len(clips), 1)
        breakdown = clips[0].get("score_breakdown")
        self.assertIsNotNone(breakdown)
        self.assertEqual(
            set(breakdown),
            {"Speech", "Coverage", "Completeness", "Silence",
             "Energy", "Gameplay", "Stability"})
        for value in breakdown.values():
            self.assertIsInstance(value, int)
            self.assertGreaterEqual(value, 0)
            self.assertLessEqual(value, 100)
        # Exact values, straight from the selector: the lone candidate
        # is the densest (Speech 100); the window is trimmed to the
        # exact 30s target mid-thought (Completeness 40); speech
        # covers 29.5 of the 30s (Coverage 98); both silence gaps are
        # long (Silence 100); flat energy is the max (Energy 100);
        # no face profile means neutral gameplay/stability (50 each).
        self.assertEqual(breakdown, {
            "Speech": 100, "Coverage": 98, "Completeness": 40,
            "Silence": 100, "Energy": 100, "Gameplay": 50, "Stability": 50,
        })

    def test_visual_moment_window_carries_only_visual_signals(self):
        segments = [_segment(10.0, 40.0, "This is the one good story here.")]
        energy = [0.05] * 200
        for i in range(100, 111):
            energy[i] = 0.9
        for i in range(170, 181):
            energy[i] = 0.8
        clips = muse_worker.select_highlights(
            segments, 200.0, _settings(), energy, [])
        self.assertEqual(len(clips), 3)
        speech = [c for c in clips if "visual_moment" not in c["signals"]]
        visual = [c for c in clips if "visual_moment" in c["signals"]]
        self.assertEqual(len(speech), 1)
        self.assertEqual(len(visual), 2)
        # The speech window still carries all seven signals.
        self.assertEqual(
            set(speech[0]["score_breakdown"]),
            {"Speech", "Coverage", "Completeness", "Silence",
             "Energy", "Gameplay", "Stability"})
        # Visual moments carry ONLY what was computed for them — no
        # speech signals, never padded with fabricated values.
        for c in visual:
            breakdown = c.get("score_breakdown")
            self.assertIsNotNone(breakdown)
            self.assertEqual(set(breakdown), {"Energy", "Gameplay", "Stability"})
            for key in ("Speech", "Coverage", "Completeness", "Silence"):
                self.assertNotIn(key, breakdown)
            for value in breakdown.values():
                self.assertIsInstance(value, int)
                self.assertGreaterEqual(value, 0)
                self.assertLessEqual(value, 100)

    def test_any_part_and_uniform_windows_carry_only_computed_signals(self):
        # fill_any on a silent source: any-part windows score on
        # energy/gameplay/stability only.
        clips = muse_worker.select_highlights(
            [], 200.0,
            _settings(clip_count=2, selection_mode="fill_any"),
            [0.0] * 200, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertEqual(c["signals"], ["any_part"])
            self.assertEqual(
                set(c["score_breakdown"]), {"Energy", "Gameplay", "Stability"})
        # Silent source, interesting_only: the uniform fallback
        # computed energy only, so its breakdown is Energy alone.
        clips = muse_worker.select_highlights(
            [], 200.0, _settings(clip_count=2), [0.0] * 200, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertEqual(c["signals"], ["no_speech_fallback"])
            self.assertEqual(set(c["score_breakdown"]), {"Energy"})
            self.assertEqual(c["score_breakdown"]["Energy"], 0)

    def test_upload_clip_sends_json_encoded_score_breakdown(self):
        captured = {}

        class FakeResp:
            status_code = 201
            text = "{}"

            def json(self):
                return {"clip": {"id": 7}}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["method"] = method
                captured["url"] = url
                captured["data"] = kwargs.get("data")
                captured["files"] = kwargs.get("files")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        breakdown = {"Speech": 100, "Coverage": 98, "Energy": 50}
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip_01.mp4"
            clip_path.write_bytes(b"fake mp4")
            api.upload_clip(1, clip_path, {
                "title": "Clip 1",
                "score": 0.75,
                "score_breakdown": breakdown,
            })
        self.assertEqual(captured["method"], "POST")
        self.assertTrue(captured["url"].endswith("/muse/jobs/1/clips"))
        data = captured["data"]
        # The field is a JSON-encoded object, not a Python repr.
        self.assertIsInstance(data["score_breakdown"], str)
        self.assertEqual(data["score_breakdown"], json.dumps(breakdown))
        self.assertEqual(json.loads(data["score_breakdown"]), breakdown)
        # Other fields still travel as plain strings.
        self.assertEqual(data["title"], "Clip 1")
        self.assertEqual(data["score"], "0.75")

    def test_upload_clip_omits_score_breakdown_when_absent(self):
        captured = {}

        class FakeResp:
            status_code = 201
            text = "{}"

            def json(self):
                return {"clip": {"id": 7}}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["data"] = kwargs.get("data")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip_01.mp4"
            clip_path.write_bytes(b"fake mp4")
            # No breakdown key at all: no field is sent.
            api.upload_clip(1, clip_path, {"title": "Clip 1"})
            self.assertNotIn("score_breakdown", captured["data"])
            # An empty breakdown is likewise skipped, never "{}".
            api.upload_clip(1, clip_path, {"title": "Clip 1",
                                            "score_breakdown": {}})
            self.assertNotIn("score_breakdown", captured["data"])


class FakeApi:
    """Minimal stand-in for JobApi: records status changes + uploads."""

    def __init__(self, job):
        self.job = job
        self.statuses = []
        self.uploads = []
        # Brand-asset fixtures: download URL -> local file to copy.
        self.brand_files = {}

    def get_job(self, job_id):
        return dict(self.job)

    def set_status(self, job_id, status, error_reason=None, stage=None,
                   progress=None, note=None, **kwargs):
        self.statuses.append({"status": status, "note": note, "stage": stage,
                              **kwargs})
        return {"id": job_id, "status": status}

    def download_brand_asset(self, url, dest):
        Path(dest).write_bytes(Path(self.brand_files[url]).read_bytes())
        return dest

    def upload_clip(self, job_id, clip_path, fields, thumbnail=None):
        self.uploads.append(fields)
        return {"id": len(self.uploads)}

    def delete_clips(self, job_id):
        return 0

    def download_source(self, job_id, dest):
        return dest


class ProcessJobIsolationTests(unittest.TestCase):
    def test_one_failed_clip_does_not_fail_the_job(self):
        job = {"id": 99, "state": "queued", "stale": False,
               "settings": _settings()}
        api = FakeApi(job)
        segments = [
            _segment(10.0, 40.0, "First good story here."),
            _segment(100.0, 130.0, "Second good story here."),
        ]
        energy = [0.05] * 200
        for i in range(170, 181):
            energy[i] = 0.9
        calls = {"rendered": 0}

        def fake_extract_audio(source, wav_path):
            # process_job stats the WAV to check it spans the video:
            # write a 200s 16kHz mono 16-bit file (44-byte header + data).
            Path(wav_path).write_bytes(b"\x00" * (44 + 200 * 32000))

        def fake_render_clip(source, clip, settings, segs, out_path,
                             source_info, job_dir):
            calls["rendered"] += 1
            # The middle clip (the 100s speech window) fails to render.
            if abs(clip["start"] - 99.5) < 1.0:
                raise RuntimeError("ffmpeg crashed on this window")
            Path(out_path).write_bytes(b"fake mp4")

        with mock.patch.object(muse_worker, "acquire_source",
                               return_value=(Path("/tmp/fake-source.mp4"), "stubbed")), \
            mock.patch.object(muse_worker, "probe_summary",
                              return_value={"duration": 200.0, "width": 576,
                                            "height": 1280, "video_codec": "h264",
                                            "has_audio": True}), \
            mock.patch.object(muse_worker, "extract_audio",
                              side_effect=fake_extract_audio), \
            mock.patch.object(muse_worker, "transcribe", return_value=segments), \
            mock.patch.object(muse_worker, "wav_rms_profile", return_value=energy), \
            mock.patch.object(muse_worker, "face_profile", return_value=[]), \
            mock.patch.object(muse_worker, "render_clip", side_effect=fake_render_clip), \
            mock.patch.object(muse_worker, "validate_clip",
                              return_value={"duration": 30.0, "width": 1080,
                                            "height": 1920, "size_bytes": 1234}), \
            mock.patch.object(muse_worker, "extract_thumbnail", return_value=None):
            muse_worker.process_job(api, job)

        # 3 windows selected (2 speech + 1 visual), 1 failed to render.
        self.assertEqual(calls["rendered"], 3)
        self.assertEqual(len(api.uploads), 2)
        # Both uploaded clips carry their window's breakdown as a dict:
        # the speech window has all seven signals, the visual moment
        # only the three visual ones — the call site passes it through.
        self.assertEqual(
            set(api.uploads[0]["score_breakdown"]),
            {"Speech", "Coverage", "Completeness", "Silence",
             "Energy", "Gameplay", "Stability"})
        self.assertEqual(
            set(api.uploads[1]["score_breakdown"]),
            {"Energy", "Gameplay", "Stability"})
        # The job still ends Ready — with the failure in its note.
        ready = [s for s in api.statuses if s["status"] == "Ready"]
        self.assertEqual(len(ready), 1)
        self.assertIn("1 clip(s) failed to render", ready[0]["note"])
        self.assertIn("99.5", ready[0]["note"])


class ListRerendersTests(unittest.TestCase):
    """A 404 on /muse/rerenders means the backend predates the re-render
    routes (live is still on 72694ce) — the worker must treat it as
    'no re-renders', not crash the whole poll run."""

    def _api_with_status(self, status, body=None):
        class FakeResp:
            status_code = status
            text = body if body is not None else "{}"

            def json(self):
                import json
                return json.loads(self.text)

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        return api

    def test_404_returns_empty_list(self):
        api = self._api_with_status(
            404, '{"message": "The route api/v1/muse/rerenders could not be found."}')
        self.assertEqual(api.list_rerenders(), [])

    def test_200_returns_the_list(self):
        api = self._api_with_status(
            200, '{"rerenders": [{"id": 7, "clip_id": 38}]}')
        self.assertEqual(api.list_rerenders(), [{"id": 7, "clip_id": 38}])

    def test_500_still_raises(self):
        api = self._api_with_status(500, '{"message": "boom"}')
        with self.assertRaises(RuntimeError):
            api.list_rerenders()


class LayoutChainsTests(unittest.TestCase):
    """New layouts (2026-11-23): pip_facecam, blur_fill, streamer_full —
    all 9:16-only like split, with honest fallbacks. The face box is
    injected, so no ffmpeg/OpenCV runs here."""

    SRC = Path("no-such-file.mp4")  # never read: face detection is injected
    BOX = (0.20, 0.30, 0.05, 0.08)  # small inset face, left of centre

    def _chains(self, layout, ratio="9:16", face_box=BOX, sw=576, sh=1280):
        return muse_worker.build_layout_chains(
            self.SRC, sw, sh, 1080, 1920, ratio, layout, 10.0, 30.0,
            face_box=face_box)

    def _joined(self, *args, **kwargs):
        return ";".join(self._chains(*args, **kwargs))

    def test_split_unchanged_with_face(self):
        joined = self._joined("split")
        self.assertIn("vstack", joined)
        self.assertIn("scale=1080:864", joined)
        self.assertIn("scale=1080:1056", joined)

    def test_split_without_face_uses_top_45_fallback(self):
        self.assertIn("crop=iw:ih*0.45:0:0",
                      self._joined("split", face_box=None))

    def test_pip_facecam_overlays_inset_top_right(self):
        joined = self._joined("pip_facecam")
        self.assertIn("scale=360:288", joined)
        self.assertIn("drawbox=", joined)
        self.assertIn("overlay=696:24", joined)

    def test_pip_facecam_without_face_falls_back_to_centre_crop(self):
        joined = self._joined("pip_facecam", face_box=None)
        self.assertNotIn("overlay=", joined)
        self.assertIn("crop=iw:iw/0.562500", joined)

    def test_blur_fill_uses_blurred_background(self):
        joined = self._joined("blur_fill")
        self.assertIn("gblur=sigma=40", joined)
        self.assertIn("overlay=(W-w)/2:(H-h)/2", joined)

    def test_streamer_full_cover_scales_the_inset(self):
        joined = self._joined("streamer_full")
        self.assertIn("force_original_aspect_ratio=increase,crop=1080:1920",
                      joined)
        self.assertNotIn("vstack", joined)

    def test_streamer_full_without_face_uses_top_45_fallback(self):
        self.assertIn("crop=iw:ih*0.45:0:0",
                      self._joined("streamer_full", face_box=None))

    def test_unknown_layout_falls_back_to_centre_crop(self):
        joined = self._joined("something_new")
        self.assertNotIn("vstack", joined)
        self.assertNotIn("overlay=", joined)
        self.assertIn("crop=iw:iw/0.562500", joined)

    def test_split_at_16_9_falls_back_to_centre_crop(self):
        joined = self._joined("split", ratio="16:9")
        self.assertNotIn("vstack", joined)


class LayoutRenderTests(unittest.TestCase):
    """One real ffmpeg render proves the new filter graphs actually run
    (a typo in a filter name only fails at render time)."""

    def test_blur_fill_renders_a_real_clip(self):
        demo = (Path(__file__).resolve().parents[3]
                / "demo" / "demo-source-3min.mp4")
        if not demo.exists():
            self.skipTest(f"demo source missing: {demo}")
        info = muse_worker.probe_summary(demo)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out = tmp / "blur.mp4"
            settings = _settings(layout="blur_fill", captions_enabled=False)
            muse_worker.render_clip(demo, {"start": 10.0, "end": 15.0},
                                    settings, [], out, info, tmp)
            self.assertTrue(out.exists())
            self.assertGreater(out.stat().st_size, 0)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.5)


class EngineVersionsTests(unittest.TestCase):
    """The worker reports its own ffmpeg/ffprobe versions with every
    status update (audit 2026-11-24): the hosted site has no engine
    URL to probe, so this is how the dashboards learn the versions."""

    def test_versions_are_first_lines_of_version_output(self):
        versions = muse_worker.engine_versions()
        self.assertTrue(
            (versions["ffmpeg"] or "").startswith("ffmpeg version"),
            f"unexpected ffmpeg version: {versions['ffmpeg']!r}",
        )
        self.assertTrue(
            (versions["ffprobe"] or "").startswith("ffprobe version"),
            f"unexpected ffprobe version: {versions['ffprobe']!r}",
        )

    def test_set_status_carries_engine_versions(self):
        captured = {}

        class FakeResp:
            status_code = 200
            text = "{}"

            def json(self):
                return {}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["payload"] = kwargs.get("json")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        api.set_status(1, "Processing", stage="rendering", progress=60)
        payload = captured["payload"]
        self.assertEqual(payload["status"], "Processing")
        self.assertIn("engine_versions", payload)
        self.assertTrue(
            (payload["engine_versions"]["ffmpeg"] or "").startswith("ffmpeg version")
        )
        self.assertTrue(
            (payload["engine_versions"]["ffprobe"] or "").startswith("ffprobe version")
        )


class SelectionModeTests(unittest.TestCase):
    def test_interesting_only_returns_nothing_when_speech_unusable_and_silent(self):
        # One 5s speech stretch, maximum mode with a 20s floor: no
        # window can meet the bounds, and silent energy gives no
        # visual moments — the honest shortfall is zero clips.
        segments = [_segment(190.0, 195.0, "short line here")]
        clips = muse_worker.select_highlights(
            segments, 200.0,
            _settings(clip_count=2, duration_mode="maximum",
                      duration_seconds=30, duration_min_seconds=20,
                      duration_max_seconds=30),
            [0.0] * 200, [])
        self.assertEqual(len(clips), 0)

    def test_fill_any_fills_when_speech_unusable_and_silent(self):
        # Same fixture, fill_any: the even grid fills the count.
        segments = [_segment(190.0, 195.0, "short line here")]
        clips = muse_worker.select_highlights(
            segments, 200.0,
            _settings(clip_count=2, duration_mode="maximum",
                      duration_seconds=30, duration_min_seconds=20,
                      duration_max_seconds=30, selection_mode="fill_any"),
            [0.0] * 200, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertEqual(c["signals"], ["any_part"])
            self.assertAlmostEqual(c["duration"], 30.0, places=1)
            self.assertTrue(c["reason"].endswith("Any part — not a highlight."))
        ordered = sorted(clips, key=lambda c: c["start"])
        for a, b in zip(ordered, ordered[1:]):
            self.assertLessEqual(a["end"], b["start"])

    def test_fill_any_zero_speech_silent_source_uses_any_part_not_uniform(self):
        clips = muse_worker.select_highlights(
            [], 200.0,
            _settings(clip_count=2, selection_mode="fill_any"),
            [0.0] * 200, [])
        self.assertEqual(len(clips), 2)
        for c in clips:
            self.assertEqual(c["signals"], ["any_part"])
            self.assertNotIn("no_speech_fallback", c["signals"])

    def test_fill_any_delivers_what_fits_when_source_too_short(self):
        # 100s source, 5x30s requested: only 3 full windows fit.
        clips = muse_worker.select_highlights(
            [], 100.0,
            _settings(clip_count=5, selection_mode="fill_any"),
            [0.0] * 100, [])
        self.assertEqual(len(clips), 3)
        for c in clips:
            self.assertAlmostEqual(c["duration"], 30.0, places=1)
            self.assertEqual(c["signals"], ["any_part"])
        ordered = sorted(clips, key=lambda c: c["start"])
        for a, b in zip(ordered, ordered[1:]):
            self.assertLessEqual(a["end"], b["start"])
        note = muse_worker._ready_note(clips, 5, [])
        self.assertIn("Only 3 of 5", note)
        self.assertIn("3 any-part window(s)", note)

    def test_fill_any_honours_minimum_mode_bounds(self):
        clips = muse_worker.select_highlights(
            [], 200.0,
            _settings(clip_count=3, duration_mode="minimum",
                      duration_seconds=20, duration_min_seconds=20,
                      duration_max_seconds=45, selection_mode="fill_any"),
            [0.0] * 200, [])
        self.assertEqual(len(clips), 3)
        for c in clips:
            self.assertGreaterEqual(c["duration"], 20.0 - 0.6)
            self.assertLessEqual(c["duration"], 45.0 + 0.6)

    def test_selection_mode_defaults_to_interesting_only(self):
        # No selection_mode key at all: same behaviour as explicit
        # interesting_only (zero clips on the unusable-speech fixture).
        segments = [_segment(190.0, 195.0, "short line here")]
        settings = _settings(clip_count=2, duration_mode="maximum",
                             duration_seconds=30, duration_min_seconds=20,
                             duration_max_seconds=30)
        self.assertNotIn("selection_mode", settings)
        clips = muse_worker.select_highlights(
            segments, 200.0, settings, [0.0] * 200, [])
        self.assertEqual(len(clips), 0)


class OnScreenTextTests(unittest.TestCase):
    def _clip(self):
        return {"start": 10.0, "end": 40.0}

    def _segs(self):
        return [
            _segment(10.0, 20.0, "we climb to the highest point of the tower"),
            _segment(22.0, 30.0, "the tower view is insane guys"),
        ]

    def test_campaign_text_verbatim_wins(self):
        settings = {"campaign_requirements":
                    "Tone: hype.\nOn-screen text: WIN THE PS5 TODAY\nAvoid: spoilers",
                    "notes": ""}
        self.assertEqual(
            muse_worker.derive_on_screen_text(self._clip(), self._segs(), settings),
            "WIN THE PS5 TODAY")

    def test_ost_marker_in_notes(self):
        settings = {"campaign_requirements": "",
                    "notes": "OST: biggest drop ever\nSome other line."}
        self.assertEqual(
            muse_worker.derive_on_screen_text(self._clip(), self._segs(), settings),
            "biggest drop ever")

    def test_quoted_string_used(self):
        settings = {"campaign_requirements": "",
                    "notes": 'The brief says "climb the tower" for the hook.'}
        self.assertEqual(
            muse_worker.derive_on_screen_text(self._clip(), self._segs(), settings),
            "climb the tower")

    def test_campaign_beats_notes(self):
        settings = {"campaign_requirements": "On-screen text: FROM THE BRIEF",
                    "notes": "On-screen text: FROM THE NOTES"}
        self.assertEqual(
            muse_worker.derive_on_screen_text(self._clip(), self._segs(), settings),
            "FROM THE BRIEF")

    def test_transcript_headline_from_emphatic_word(self):
        headline = muse_worker.derive_on_screen_text(self._clip(), self._segs(), {})
        self.assertEqual(headline, "HIGHEST POINT OF THE TOWER")
        self.assertLessEqual(len(headline.split()), 6)
        self.assertLessEqual(len(headline), 60)

    def test_silent_window_gets_no_headline(self):
        self.assertIsNone(
            muse_worker.derive_on_screen_text(self._clip(), [], {}))

    def test_headline_capped_at_60_chars(self):
        long_text = "On-screen text: " + "W" * 80
        settings = {"campaign_requirements": long_text, "notes": ""}
        headline = muse_worker.derive_on_screen_text(self._clip(), self._segs(), settings)
        self.assertIsNotNone(headline)
        self.assertLessEqual(len(headline), 60)

    def test_write_headline_ass(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "headline.ass"
            self.assertTrue(
                muse_worker.write_headline_ass("WIN THE PS5 TODAY", 30.0, path, 1080, 1920))
            text = path.read_text()
            self.assertIn("Style: Headline,", text)
            self.assertIn("WIN THE PS5 TODAY", text)
            self.assertIn("0:00:00.00,0:00:04.00,Headline,", text)
            # Top-centre (alignment 8), near the top — clear of the
            # split divider captions at y=864.
            self.assertIn(",8,40,40,120,1", text)


class CaptionStyleTests(unittest.TestCase):
    def test_new_styles_in_dict(self):
        self.assertIn("kinetic", muse_worker.CAPTION_STYLES)
        self.assertIn("glow_pop", muse_worker.CAPTION_STYLES)
        self.assertEqual(len(muse_worker.CAPTION_STYLES), 15)

    def test_write_clip_ass_kinetic(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "kinetic.ass"
            segments = [_segment(10.0, 20.0, "we climb to the highest point")]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 10.0, 40.0, "kinetic", path, 864, 1080, 1920, "split"))
            text = path.read_text()
            self.assertIn("Style: Kinetic,", text)
            self.assertIn("\\move(", text)

    def test_write_clip_ass_glow_pop(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "glow.ass"
            segments = [_segment(10.0, 20.0, "we climb to the highest point")]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 10.0, 40.0, "glow_pop", path, 864, 1080, 1920, "split"))
            text = path.read_text()
            self.assertIn("Style: GlowPop,", text)
            self.assertIn("\\fscx0\\fscy0", text)


class ExactDurationTests(unittest.TestCase):
    """Exact mode must land on target (Job #8, 2026-11-24): a 20.59s
    natural span used to pass selection — inside the old 0.6s
    tolerance — and the render's container duration runs a hair past
    -t, so it then failed validation at the 0.6s boundary and the
    clip was skipped (20.60s vs exact 20s)."""

    def test_exact_mode_trims_overshoot_inside_tolerance_to_target(self):
        # One sentence grouping spans 20.595s — inside the old
        # tolerance, so the old code kept it and the render failed.
        segments = [_segment(10.0, 29.595, "This is a long story here now.")]
        clips = muse_worker.select_highlights(
            segments, 200.0, _settings(duration_seconds=20, clip_count=1),
            [0.05] * 200, [])
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["duration"], 20.0)
        self.assertEqual(clips[0]["start"], 9.5)
        self.assertEqual(clips[0]["end"], 29.5)

    def test_exact_mode_extends_short_window_to_target(self):
        segments = [_segment(10.0, 28.0, "Short story here now.")]
        clips = muse_worker.select_highlights(
            segments, 200.0, _settings(duration_seconds=20, clip_count=1),
            [0.05] * 200, [])
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["duration"], 20.0)

    def test_exact_mode_render_validates_on_target(self):
        # Full chain on the Job #8 shape: exact 20s, split layout, a
        # 20.595s natural span. The selected window must render to
        # 20.0s and validate — on the old code the window stayed
        # 20.595s and the render failed validation.
        demo = (Path(__file__).resolve().parents[3]
                / "demo" / "demo-source-3min.mp4")
        if not demo.exists():
            self.skipTest(f"demo source missing: {demo}")
        segments = [_segment(10.0, 29.595, "This is a long story here now.")]
        settings = _settings(duration_seconds=20, clip_count=1,
                             layout="split", captions_enabled=False)
        clips = muse_worker.select_highlights(
            segments, 200.0, settings, [0.05] * 200, [])
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["duration"], 20.0)
        info = muse_worker.probe_summary(demo)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out = tmp / "exact20.mp4"
            muse_worker.render_clip(demo, clips[0], settings, segments,
                                    out, info, tmp)
            validated = muse_worker.validate_clip(
                out, {"settings": settings}, info)
            self.assertAlmostEqual(validated["duration"], 20.0, delta=0.1)

    def test_validate_exact_boundary_float_noise_passes(self):
        # A container duration of exactly target + 0.6s must not fail
        # on float noise (20.6 - 20 == 0.6000000000000014 in binary).
        with mock.patch.object(
                muse_worker, "probe_summary",
                return_value={"duration": 20.6, "width": 1080, "height": 1920,
                              "has_audio": True, "size_bytes": 1000}):
            info = muse_worker.validate_clip(
                Path("clip.mp4"),
                {"settings": _settings(duration_seconds=20)},
                {"has_audio": True})
        self.assertAlmostEqual(info["duration"], 20.6)


class BrandAssetsTests(unittest.TestCase):
    """Intro/outro brand assets (2026-11-25): jobs whose owner set an
    intro/outro get [intro?] + clip + [outro?] via the concat filter,
    normalised to the rendered clip's canvas and 48kHz stereo audio.
    A bad asset, a failed concat, or no assets at all never fails the
    job — the plain clip is used and the segment is marked not applied."""

    def _make_segment(self, path, duration, size, color, audio_freq=None):
        """A short real MP4 via lavfi: colour bars + optional sine audio."""
        cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
               "-f", "lavfi",
               "-i", f"color=c={color}:s={size}:d={duration}:r=30"]
        if audio_freq:
            cmd += ["-f", "lavfi",
                    "-i", f"sine=frequency={audio_freq}:duration={duration}"]
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                    "-shortest"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p"]
        cmd += [str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(Path(path).exists())
        self.assertGreater(Path(path).stat().st_size, 0)

    def _fixtures(self, tmp):
        """clip 2s 360x640 + audio, intro 1s 640x360 + audio (different
        aspect — exercises scale+pad), outro 1.5s 360x640 video-only."""
        clip = tmp / "clip.mp4"
        intro = tmp / "intro.mp4"
        outro = tmp / "outro.mp4"
        self._make_segment(clip, 2.0, "360x640", "red", audio_freq=440)
        self._make_segment(intro, 1.0, "640x360", "blue", audio_freq=880)
        self._make_segment(outro, 1.5, "360x640", "green")
        return clip, intro, outro

    def test_intro_clip_outro_concat(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, intro, outro = self._fixtures(tmp)
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, intro, outro, tmp / "branded.mp4")
            self.assertTrue(intro_ok)
            self.assertTrue(outro_ok)
            self.assertNotEqual(out, clip)
            info = muse_worker.probe_summary(out)
            self.assertEqual((info["width"], info["height"]), (360, 640))
            self.assertTrue(info["has_audio"])
            self.assertAlmostEqual(info["duration"], 4.5, delta=0.5)

    def _center_rgb(self, image_path):
        """Average RGB of an image file, via ffmpeg — pure stdlib, so
        the test runs under any interpreter (no PIL). The fixtures are
        solid-colour frames, so the average is the frame's colour."""
        proc = subprocess.run(
            [muse_worker.FFMPEG, "-v", "error", "-i", str(image_path),
             "-vf", "scale=1:1", "-f", "rawvideo",
             "-pix_fmt", "rgb24", "-"],
            capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout), 3)
        return tuple(proc.stdout)

    def test_thumbnail_skips_past_intro(self):
        # A branded clip's thumbnail must show the clip, not the intro
        # card: the frame is taken at intro duration + 1.0s, and at
        # 1.0s it would still be the intro.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "clip.mp4"
            intro = tmp / "intro.mp4"
            self._make_segment(clip, 5.0, "360x640", "green", audio_freq=440)
            self._make_segment(intro, 2.0, "360x640", "red", audio_freq=880)
            out, intro_ok, _outro_ok = muse_worker.apply_brand_assets(
                clip, intro, None, tmp / "branded.mp4")
            self.assertTrue(intro_ok)
            intro_dur = muse_worker._probe_video_info(intro)["duration"]
            self.assertAlmostEqual(intro_dur, 2.0, delta=0.2)
            thumb_intro = muse_worker.extract_thumbnail(
                out, tmp / "thumb_intro.jpg", at_seconds=1.0)
            self.assertIsNotNone(thumb_intro)
            r, g, _b = self._center_rgb(thumb_intro)
            self.assertGreater(r, g)  # still the red intro card
            thumb_clip = muse_worker.extract_thumbnail(
                out, tmp / "thumb_clip.jpg", at_seconds=intro_dur + 1.0)
            self.assertIsNotNone(thumb_clip)
            r, g, _b = self._center_rgb(thumb_clip)
            self.assertGreater(g, r)  # the green clip itself

    def test_intro_only_and_outro_only(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, intro, outro = self._fixtures(tmp)
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, intro, None, tmp / "branded_i.mp4")
            self.assertEqual((intro_ok, outro_ok), (True, False))
            self.assertAlmostEqual(
                muse_worker.probe_summary(out)["duration"], 3.0, delta=0.5)
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, None, outro, tmp / "branded_o.mp4")
            self.assertEqual((intro_ok, outro_ok), (False, True))
            self.assertAlmostEqual(
                muse_worker.probe_summary(out)["duration"], 3.5, delta=0.5)

    def test_video_only_intro_still_concats(self):
        # The outro fixture has no audio stream: the concat must
        # synthesise a silent track for it, not fail.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, _intro, outro = self._fixtures(tmp)
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, None, outro, tmp / "branded.mp4")
            self.assertTrue(outro_ok)
            info = muse_worker.probe_summary(out)
            self.assertTrue(info["has_audio"])
            self.assertAlmostEqual(info["duration"], 3.5, delta=0.5)

    def test_corrupt_asset_is_skipped_gracefully(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, intro, outro = self._fixtures(tmp)
            corrupt = tmp / "corrupt.mp4"
            corrupt.write_bytes(b"")
            # Zero-byte intro: skipped, outro still applied.
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, corrupt, outro, tmp / "branded.mp4")
            self.assertEqual((intro_ok, outro_ok), (False, True))
            self.assertAlmostEqual(
                muse_worker.probe_summary(out)["duration"], 3.5, delta=0.5)
            # Both assets corrupt/missing: the original clip is returned
            # untouched — no ffmpeg pass, no new file.
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(
                clip, corrupt, tmp / "missing.mp4", tmp / "branded2.mp4")
            self.assertEqual(out, clip)
            self.assertEqual((intro_ok, outro_ok), (False, False))
            self.assertFalse((tmp / "branded2.mp4").exists())

    def test_no_assets_returns_original_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, _intro, _outro = self._fixtures(tmp)
            out, intro_ok, outro_ok = muse_worker.apply_brand_assets(clip)
            self.assertEqual(out, clip)
            self.assertEqual((intro_ok, outro_ok), (False, False))
            self.assertFalse((tmp / "clip_branded.mp4").exists())

    def test_download_brand_asset_streams_with_api_key_auth(self):
        captured = {}

        class FakeResp:
            status_code = 200
            text = ""

            def __init__(self, data):
                self._data = data

            def iter_content(self, chunk_size=1 << 20):
                yield self._data

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["method"] = method
                captured["url"] = url
                captured["headers"] = headers
                captured["stream"] = kwargs.get("stream")
                return FakeResp(b"fake-brand-mp4-bytes")

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "brand_intro.mp4"
            api.download_brand_asset(
                "https://example.invalid/api/v1/brand-assets/1/download", dest)
            self.assertEqual(dest.read_bytes(), b"fake-brand-mp4-bytes")
        self.assertEqual(captured["method"], "GET")
        self.assertEqual(
            captured["url"],
            "https://example.invalid/api/v1/brand-assets/1/download")
        self.assertEqual(captured["headers"]["X-Muse-Api-Key"], "test-key")
        self.assertTrue(captured["stream"])
        # A relative URL is resolved against the backend base.
        api.download_brand_asset("/api/v1/brand-assets/2/download",
                                 Path(d) / "brand2.mp4")
        self.assertEqual(
            captured["url"], "http://127.0.0.1:8000/api/v1/brand-assets/2/download")

    def test_download_brand_assets_skips_unplayable_and_missing(self):
        class StubApi:
            def __init__(self, files):
                self.files = files  # url -> bytes to write

            def download_brand_asset(self, url, dest):
                Path(dest).write_bytes(self.files[url])
                return dest

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            _clip, intro, _outro = self._fixtures(tmp)
            good_bytes = intro.read_bytes()
            api = StubApi({
                "https://x/intro": good_bytes,
                "https://x/outro": b"not a video at all",
            })
            assets = muse_worker.download_brand_assets(api, {
                "intro": {"id": 1, "download_url": "https://x/intro"},
                "outro": {"id": 2, "download_url": "https://x/outro"},
            }, tmp)
            self.assertEqual(set(assets), {"intro"})
            self.assertTrue(assets["intro"].exists())
            # The unplayable outro file is removed, not left behind.
            self.assertFalse((tmp / "brand_outro_2.mp4").exists())
            # Missing key / empty / non-dict: no assets, no crash.
            self.assertEqual(muse_worker.download_brand_assets(api, None, tmp), {})
            self.assertEqual(muse_worker.download_brand_assets(api, {}, tmp), {})
            self.assertEqual(
                muse_worker.download_brand_assets(api, "nonsense", tmp), {})

    def test_download_brand_assets_download_failure_is_not_fatal(self):
        class FailingApi:
            def download_brand_asset(self, url, dest):
                raise RuntimeError("HTTP 404: gone")

        with tempfile.TemporaryDirectory() as d:
            assets = muse_worker.download_brand_assets(FailingApi(), {
                "intro": {"id": 1, "download_url": "https://x/intro"},
            }, Path(d))
            self.assertEqual(assets, {})

    def test_set_status_sends_brand_flags_only_when_given(self):
        captured = {}

        class FakeResp:
            status_code = 200
            text = "{}"

            def json(self):
                return {}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["payload"] = kwargs.get("json")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        api.set_status(1, "Ready", stage="ready", progress=100)
        self.assertNotIn("intro_applied", captured["payload"])
        self.assertNotIn("outro_applied", captured["payload"])
        api.set_status(1, "Ready", stage="ready", progress=100,
                       intro_applied=True, outro_applied=False)
        self.assertEqual(captured["payload"]["intro_applied"], True)
        self.assertEqual(captured["payload"]["outro_applied"], False)

    def _run_process_job(self, job, api, fixture_clip):
        """process_job with every heavy step stubbed except branding:
        the fake render copies a real 2s clip so the concat really runs."""
        segments = [_segment(10.0, 30.0, "One good story here now.")]
        energy = [0.05] * 200
        real_probe = muse_worker.probe_summary

        def fake_probe(path):
            # The fake source gets stubbed info; every real file (the
            # rendered clip, brand assets, branded output) is probed
            # for real so the concat genuinely runs and is validated.
            if str(path) == "/tmp/fake-source.mp4":
                return {"duration": 200.0, "width": 576, "height": 1280,
                        "video_codec": "h264", "fps": 30.0,
                        "has_audio": True}
            return real_probe(path)

        def fake_extract_audio(source, wav_path):
            Path(wav_path).write_bytes(b"\x00" * (44 + 200 * 32000))

        def fake_render_clip(source, clip, settings, segs, out_path,
                             source_info, job_dir):
            Path(out_path).write_bytes(fixture_clip.read_bytes())

        with mock.patch.object(muse_worker, "acquire_source",
                               return_value=(Path("/tmp/fake-source.mp4"), "stubbed")), \
            mock.patch.object(muse_worker, "probe_summary",
                              side_effect=fake_probe), \
            mock.patch.object(muse_worker, "extract_audio",
                              side_effect=fake_extract_audio), \
            mock.patch.object(muse_worker, "transcribe", return_value=segments), \
            mock.patch.object(muse_worker, "wav_rms_profile", return_value=energy), \
            mock.patch.object(muse_worker, "face_profile", return_value=[]), \
            mock.patch.object(muse_worker, "render_clip", side_effect=fake_render_clip), \
            mock.patch.object(muse_worker, "validate_clip",
                              return_value={"duration": 20.0, "width": 1080,
                                            "height": 1920, "size_bytes": 1234}), \
            mock.patch.object(muse_worker, "extract_thumbnail", return_value=None):
            muse_worker.process_job(api, job)

    def test_process_job_reports_brand_flags_on_ready(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, intro, outro = self._fixtures(tmp)
            job = {"id": 98, "state": "queued", "stale": False,
                   "settings": _settings(clip_count=1, duration_seconds=20),
                   "brand_assets": {
                       "intro": {"id": 1, "download_url": "https://x/intro"},
                       "outro": {"id": 2, "download_url": "https://x/outro"},
                   }}
            api = FakeApi(job)
            api.brand_files = {"https://x/intro": intro,
                               "https://x/outro": outro}
            self._run_process_job(job, api, clip)
            self.assertEqual(len(api.uploads), 1)
            # The uploaded clip is the branded one (2 + 1 + 1.5s).
            self.assertAlmostEqual(
                api.uploads[0]["duration_seconds"], 4.5, delta=0.5)
            ready = [s for s in api.statuses if s["status"] == "Ready"]
            self.assertEqual(len(ready), 1)
            self.assertEqual(ready[0]["intro_applied"], True)
            self.assertEqual(ready[0]["outro_applied"], True)

    def test_process_job_without_brand_assets_sends_no_flags(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip, _intro, _outro = self._fixtures(tmp)
            job = {"id": 98, "state": "queued", "stale": False,
                   "settings": _settings(clip_count=1, duration_seconds=20)}
            api = FakeApi(job)
            self._run_process_job(job, api, clip)
            self.assertEqual(len(api.uploads), 1)
            ready = [s for s in api.statuses if s["status"] == "Ready"]
            self.assertEqual(len(ready), 1)
            self.assertNotIn("intro_applied", ready[0])
            self.assertNotIn("outro_applied", ready[0])


if __name__ == "__main__":
    unittest.main()
