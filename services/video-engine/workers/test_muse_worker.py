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
import re
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
    speech windows get all eight, visual-moment / any-part windows
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
             "Energy", "Gameplay", "Stability", "Hook"})
        for value in breakdown.values():
            self.assertIsInstance(value, int)
            self.assertGreaterEqual(value, 0)
            self.assertLessEqual(value, 100)
        # Exact values, straight from the selector: the lone candidate
        # is the densest (Speech 100); the window is trimmed to the
        # exact 30s target mid-thought (Completeness 40); speech
        # covers 29.5 of the 30s (Coverage 98); both silence gaps are
        # long (Silence 100); flat energy is the max (Energy 100);
        # no face profile means neutral gameplay/stability (50 each);
        # the lone candidate is its own best opening (Hook 100).
        self.assertEqual(breakdown, {
            "Speech": 100, "Coverage": 98, "Completeness": 40,
            "Silence": 100, "Energy": 100, "Gameplay": 50, "Stability": 50,
            "Hook": 100,
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
        # The speech window still carries all eight signals.
        self.assertEqual(
            set(speech[0]["score_breakdown"]),
            {"Speech", "Coverage", "Completeness", "Silence",
             "Energy", "Gameplay", "Stability", "Hook"})
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

    def upload_clip(self, job_id, clip_path, fields, thumbnail=None,
                    candidates=None):
        self.uploads.append(fields)
        self.upload_candidates = getattr(self, "upload_candidates", [])
        self.upload_candidates.append(list(candidates or []))
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
        # the speech window has all eight signals, the visual moment
        # only the three visual ones — the call site passes it through.
        self.assertEqual(
            set(api.uploads[0]["score_breakdown"]),
            {"Speech", "Coverage", "Completeness", "Silence",
             "Energy", "Gameplay", "Stability", "Hook"})
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
        # Batch 6 (2026-11-25): the phrase chunker now breaks at real
        # phrase boundaries instead of a hard 4-word cap, so the
        # scorer sees the natural phrases — "we climb to the highest
        # point" / "of the tower" / "the tower view is insane guys" —
        # and picks the last one (emphasis word "insane", most distinct
        # content words). The old expectation, "HIGHEST POINT OF THE
        # TOWER", was a 4-word-cap artefact: the cap split "highest
        # point of the tower" into "highest point of the" + "tower",
        # and the <3-word extension rule glued them back together.
        # The new headline is a complete real phrase from the
        # transcript, still within the 6-word / 60-char limits.
        headline = muse_worker.derive_on_screen_text(self._clip(), self._segs(), {})
        self.assertEqual(headline, "THE TOWER VIEW IS INSANE GUYS")
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
        # Batch 3 (2026-11-25) adds five more (word_zoom, word_fade,
        # highlight_sweep, bounce_in, glitch_pop); Batch 6 (2026-11-25)
        # adds three platform styles (tiktok_bold, reels_clean,
        # shorts_minimal).
        self.assertEqual(len(muse_worker.CAPTION_STYLES), 23)

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


class ClipEnhancementTests(unittest.TestCase):
    """Batch 1 (2026-11-25): auto-zoom, face tracking, silence trim/cut,
    filler removal — all default ON, all honest about what they did.
    Silence/filler cutting runs BEFORE captions: the segment is cleaned
    first and the transcript is re-mapped onto the cleaned timeline."""

    def _make_silence_clip(self, path, duration, silence_spans, color="green",
                           freq=440):
        """A real MP4 with sine audio gated to silence over the given
        spans (source-time seconds)."""
        audio = f"sine=frequency={freq}:duration={duration}"
        gates = ",".join(
            f"volume=enable='between(t,{s},{e})':volume=0"
            for s, e in silence_spans)
        if gates:
            audio += f",{gates}"
        cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
               "-f", "lavfi", "-i", f"color=c={color}:s=640x360:d={duration}:r=30",
               "-f", "lavfi", "-i", audio,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-shortest", str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(Path(path).exists())

    def _word_segments(self, words):
        """Fake transcript segments from [(start, end, text)] words."""
        return [{"start": words[0][0], "end": words[-1][1],
                 "text": " ".join(w[2] for w in words),
                 "words": [{"start": s, "end": e, "word": t}
                           for s, e, t in words]}]

    def test_feature_on_defaults_on_when_absent(self):
        self.assertTrue(muse_worker._feature_on({}, "auto_zoom"))
        self.assertTrue(muse_worker._feature_on({"auto_zoom": True}, "auto_zoom"))
        self.assertFalse(muse_worker._feature_on({"auto_zoom": False}, "auto_zoom"))
        self.assertFalse(muse_worker._feature_on({"auto_zoom": 0}, "auto_zoom"))
        for key in ("face_tracking", "silence_removal", "filler_removal"):
            self.assertTrue(muse_worker._feature_on({}, key))

    def test_detect_silences_finds_known_silence(self):
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "sil.mp4"
            self._make_silence_clip(clip, 10, [(3, 5)])
            spans = muse_worker.detect_silences(clip, 0, 10)
            self.assertEqual(len(spans), 1)
            self.assertAlmostEqual(spans[0][0], 3.0, delta=0.2)
            self.assertAlmostEqual(spans[0][1], 5.0, delta=0.2)
            # A window offset still reports source times.
            spans = muse_worker.detect_silences(clip, 2, 8)
            self.assertEqual(len(spans), 1)
            self.assertAlmostEqual(spans[0][0], 3.0, delta=0.2)

    def test_detect_silences_ignores_short_silence(self):
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "sil.mp4"
            self._make_silence_clip(clip, 10, [(3, 3.5)])
            self.assertEqual(muse_worker.detect_silences(clip, 0, 10), [])

    def test_filler_spans_finds_fillers(self):
        words = [(0.0, 0.4, "hello"), (0.5, 0.8, "um"), (1.0, 1.4, "world"),
                 (1.6, 1.9, "UH"), (2.0, 2.4, "hmm,"), (2.6, 3.0, "ok")]
        spans, count = muse_worker.filler_spans(
            self._word_segments(words), 0, 3.5)
        self.assertEqual(count, 3)
        self.assertEqual(len(spans), 3)
        self.assertAlmostEqual(spans[0][0], 0.45, delta=0.01)
        self.assertAlmostEqual(spans[0][1], 0.85, delta=0.01)
        self.assertAlmostEqual(spans[2][0], 1.95, delta=0.01)
        # A clean transcript has no filler spans.
        clean = [(0.0, 0.4, "hello"), (0.5, 0.9, "world")]
        spans, count = muse_worker.filler_spans(
            self._word_segments(clean), 0, 1.0)
        self.assertEqual((spans, count), ([], 0))

    def test_merge_cuts_merges_overlaps(self):
        self.assertEqual(
            muse_worker.merge_cuts([(0, 2), (1.5, 3), (5, 6)]),
            [(0, 3), (5, 6)])
        self.assertEqual(muse_worker.merge_cuts([(5, 6), (0, 1)]),
                         [(0, 1), (5, 6)])

    def test_remap_segments_shifts_and_drops_fillers(self):
        words = [(0.0, 1.0, "hello"), (1.0, 1.3, "um"), (1.5, 2.5, "world")]
        remapped = muse_worker.remap_segments(
            self._word_segments(words), 0, [(1.0, 1.3)])
        self.assertEqual(len(remapped), 1)
        self.assertEqual(remapped[0]["text"], "hello world")
        got = [(w["start"], w["end"], w["word"]) for w in remapped[0]["words"]]
        self.assertAlmostEqual(got[0][0], 0.0, delta=0.01)
        self.assertAlmostEqual(got[1][0], 1.2, delta=0.01)
        self.assertAlmostEqual(got[1][1], 2.2, delta=0.01)

    def test_zoom_moments_from_energy_profile(self):
        profile = [0.1, 0.1, 0.9, 0.95, 0.9, 0.1, 0.1, 0.8, 0.85, 0.1]
        self.assertEqual(muse_worker.zoom_moments(profile, 0, 10),
                         [(2.0, 5.0), (7.0, 9.0)])
        self.assertEqual(muse_worker.zoom_moments([0.0] * 10, 0, 10), [])
        self.assertEqual(muse_worker.zoom_moments([], 0, 10), [])
        # A single hot second is still a moment.
        self.assertEqual(
            muse_worker.zoom_moments([0.1, 0.1, 0.9, 0.1, 0.1], 0, 5),
            [(2.0, 3.0)])

    def test_zoompan_filter_none_without_moments(self):
        self.assertIsNone(muse_worker.zoompan_filter([], 1080, 1920))
        chain = muse_worker.zoompan_filter([(2.0, 5.0)], 1080, 1920)
        self.assertIn("zoompan", chain)
        self.assertIn("2.000", chain)
        self.assertIn("5.000", chain)
        self.assertIn("s=1080x1920", chain)
        # Two moments combine with max(), never a sum past 1.08x.
        chain = muse_worker.zoompan_filter([(1.0, 2.0), (4.0, 6.0)], 1080, 1920)
        self.assertIn("max(", chain)
        self.assertEqual(chain.count("1+0.08*"), 1)

    def test_smooth_trajectory_averages(self):
        samples = [(0.0, 0.2, 0.5, 0.1, 0.1), (2.0, 0.4, 0.5, 0.1, 0.1),
                   (4.0, 0.6, 0.5, 0.1, 0.1)]
        smoothed = muse_worker._smooth_trajectory(samples)
        self.assertAlmostEqual(smoothed[0][1], 0.3, delta=0.01)
        self.assertAlmostEqual(smoothed[1][1], 0.4, delta=0.01)
        self.assertAlmostEqual(smoothed[2][1], 0.5, delta=0.01)

    def test_pan_expr_interpolates(self):
        samples = [(0.0, 0.2, 0.5, 0.1, 0.1), (4.0, 0.6, 0.5, 0.1, 0.1)]
        expr = muse_worker._pan_expr(samples, 0)
        self.assertIn("if(lt(t,4.000", expr)
        self.assertIn("0.2000", expr)
        self.assertIn("0.6000", expr)

    def test_face_track_no_face_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "plain.mp4"
            self._make_silence_clip(clip, 6, [])
            self.assertEqual(
                muse_worker.face_track_trajectory(clip, 0, 5, 640, 360), [])

    def test_cleaning_renders_shorter_clip_maximum_mode(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "sil.mp4"
            self._make_silence_clip(clip, 10, [(3, 5)])
            words = [(i * 0.5, i * 0.5 + 0.3, f"w{i}") for i in range(10)]
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=5)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            clip_dict = {"start": 0.0, "end": 5.0}
            muse_worker.render_clip(clip, clip_dict, settings,
                                    self._word_segments(words), out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            # The 3-5s silence (2s) was cut: 5s window -> ~3s clip.
            self.assertAlmostEqual(rendered["duration"], 3.0, delta=0.4)
            stats = clip_dict["_batch1_stats"]
            self.assertAlmostEqual(stats["silence_trimmed"], 2.0, delta=0.3)
            self.assertEqual(stats["fillers_cut"], 0)

    def test_filler_removal_cuts_filler_words(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "fill.mp4"
            self._make_silence_clip(clip, 10, [])
            words = []
            for i in range(16):
                text = "um" if i == 4 else ("uh" if i == 12 else f"w{i}")
                words.append((i * 0.5, i * 0.5 + 0.3, text))
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=8)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            clip_dict = {"start": 0.0, "end": 8.0}
            muse_worker.render_clip(clip, clip_dict, settings,
                                    self._word_segments(words), out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            # Two ~0.4s filler spans cut: 8s -> ~7.2s.
            self.assertAlmostEqual(rendered["duration"], 7.2, delta=0.4)
            self.assertEqual(clip_dict["_batch1_stats"]["fillers_cut"], 2)

    def test_zoom_renders_real_clip(self):
        demo = (Path(__file__).resolve().parents[3]
                / "demo" / "demo-source-3min.mp4")
        if not demo.exists():
            self.skipTest(f"demo source missing: {demo}")
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            out = tmp / "zoom.mp4"
            settings = _settings(layout="center_crop", captions_enabled=False)
            info = muse_worker.probe_summary(demo)
            clip_dict = {"start": 10.0, "end": 15.0,
                         "_zoom_moments": [(11.0, 13.0)]}
            muse_worker.render_clip(demo, clip_dict, settings, [], out,
                                    info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.5)
            self.assertEqual(clip_dict["_batch1_stats"]["zoom_moments"], 1)

    def test_face_tracking_falls_back_without_face(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "plain.mp4"
            self._make_silence_clip(clip, 10, [])
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=5)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            clip_dict = {"start": 0.0, "end": 5.0}
            muse_worker.render_clip(clip, clip_dict, settings, [], out,
                                    info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            stats = clip_dict["_batch1_stats"]
            self.assertFalse(stats["face_tracked"])
            self.assertIsNotNone(stats["face_fallback"])

    def test_all_off_renders_plain_clip(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "sil.mp4"
            self._make_silence_clip(clip, 10, [(3, 5)])
            words = [(i * 0.5, i * 0.5 + 0.3, f"w{i}") for i in range(10)]
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=5,
                                 auto_zoom=False, face_tracking=False,
                                 silence_removal=False, filler_removal=False)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            clip_dict = {"start": 0.0, "end": 5.0}
            muse_worker.render_clip(clip, clip_dict, settings,
                                    self._word_segments(words), out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            # Nothing cleaned, nothing zoomed: the full 5s window.
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)
            stats = clip_dict["_batch1_stats"]
            self.assertEqual(stats["silence_trimmed"], 0.0)
            self.assertEqual(stats["fillers_cut"], 0)
            self.assertEqual(stats["zoom_moments"], 0)
            self.assertFalse(stats["face_tracked"])
            self.assertIsNone(stats["face_fallback"])
            self.assertIsNone(stats["cleaning_skipped"])

    def test_extend_window_for_cleaning(self):
        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "sil.mp4"
            self._make_silence_clip(clip, 10, [(3, 5)])
            words = [(i * 0.5, i * 0.5 + 0.3, f"w{i}") for i in range(20)]
            settings = _settings(duration_mode="exact", duration_seconds=5)
            # Window [0,5] cleans to ~3s; extending the end to ~7 restores 5s
            # (silencedetect reports 3.019-5.015, so the exact end wobbles
            # by a few hundredths — assert approximately).
            ns, ne, cuts, _stats = muse_worker._extend_window_for_cleaning(
                clip, self._word_segments(words), 0.0, 5.0, settings, 10.0)
            self.assertAlmostEqual(ns, 0.0, delta=0.01)
            self.assertAlmostEqual(ne, 7.0, delta=0.05)
            self.assertEqual(len(cuts), 1)
            # A window that cannot be extended far enough keeps its
            # original bounds with no cuts (renders uncleaned).
            small = Path(d) / "small.mp4"
            self._make_silence_clip(small, 6, [(3, 5)])
            ns, ne, cuts, _stats = muse_worker._extend_window_for_cleaning(
                small, self._word_segments(words), 0.0, 5.0, settings, 6.0)
            self.assertEqual((ns, ne), (0.0, 5.0))
            self.assertEqual(cuts, [])

    def test_ready_note_reports_enhancements(self):
        rendered = [
            {"_batch1_stats": {"silence_trimmed": 2.0, "fillers_cut": 3,
                               "zoom_moments": 1, "face_tracked": True,
                               "face_fallback": None, "cleaning_skipped": None}},
            {"_batch1_stats": {"silence_trimmed": 0.0, "fillers_cut": 0,
                               "zoom_moments": 0, "face_tracked": False,
                               "face_fallback": "no face found in this clip — centre crop used",
                               "cleaning_skipped": None}},
        ]
        note = muse_worker._ready_note(
            [{"signals": []}, {"signals": []}], 2, [], rendered=rendered)
        self.assertIn("trimmed 2.0s of silence", note)
        self.assertIn("cut 3 filler word(s)", note)
        self.assertIn("Auto-zoom punch-in applied to 1 clip(s)", note)
        self.assertIn("Face tracking followed the speaker in 1 clip(s)", note)
        self.assertIn("Face tracking fallback: no face found", note)
        # No enhancements and a full count: no note at all.
        self.assertIsNone(muse_worker._ready_note(
            [{"signals": []}], 1, [], rendered=[{"_batch1_stats": {}}]))


class Batch2Tests(unittest.TestCase):
    """Batch 2 (2026-11-25): quality boost (CRF 18, unsharp, loudnorm
    -14 LUFS, AAC 192k), hook bonus in highlight selection, headline
    styles + smarter headline picking, caption auto-fit, caption
    position selector."""

    def _words_at(self, pairs):
        return [{"start": s, "end": e, "word": w} for s, e, w in pairs]

    def _manual_segment(self, start, end, pairs):
        words = self._words_at(pairs)
        return {"start": start, "end": end,
                "text": " ".join(w[2] for w in pairs), "words": words}

    # --- Hook bonus ---

    def test_hook_bonus_prefers_strong_opening(self):
        # Two 20s speech windows, equal overall density/coverage, but
        # A opens on dense loud speech while B opens on a pause and
        # gets dense later. A must out-score B and be chosen first.
        a_words = [(5.0 + i * 0.25, 5.25 + i * 0.25, f"a{i}")
                   for i in range(12)]
        a_words += [(8.0 + i, 8.8 + i, f"a{i + 12}") for i in range(17)]
        b_words = [(35.0, 35.5, "b0"), (36.5, 37.0, "b1")]
        b_words += [(38.0 + i * 0.63, 38.5 + i * 0.63, f"b{i + 2}")
                    for i in range(27)]
        segments = [self._manual_segment(5.0, 25.0, a_words),
                    self._manual_segment(35.0, 55.0, b_words)]
        energy = [0.1] * 60
        for i in (5, 6, 7):
            energy[i] = 0.9
        for i in range(8, 25):
            energy[i] = 0.3
        for i in range(38, 55):
            energy[i] = 0.41
        clips = muse_worker.select_highlights(
            segments, 60.0,
            _settings(clip_count=2, duration_seconds=20), energy, [])
        self.assertEqual(len(clips), 2)
        a, b = clips[0], clips[1]
        self.assertAlmostEqual(a["start"], 4.5, delta=0.01)
        self.assertAlmostEqual(b["start"], 34.5, delta=0.01)
        self.assertGreater(a["score"], b["score"])
        self.assertGreaterEqual(a["hook"], 0.9)
        self.assertLess(b["hook"], 0.3)
        self.assertIn("strong_opening", a["signals"])
        self.assertNotIn("strong_opening", b["signals"])
        self.assertEqual(a["score_breakdown"]["Hook"], 100)
        self.assertIn("opening hook", a["reason"])

    # --- Caption auto-fit ---

    def test_auto_fit_scales_a_long_word(self):
        # One 28-letter word at punchy size 96 measures 1643px with
        # real DejaVu Sans Bold widths (Batch 6) — the old per-glyph
        # estimator said 1398px and fitted fs 65, which would STILL
        # overflow the 960px margin (65/96 * 1643 = 1091px). Real
        # measurement fits it to 56 (96 * 960 / 1643). Safe zone OFF
        # here so the test pins the fit itself, not the safe-zone width.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "fit.ass"
            segments = [_segment(10.0, 20.0, "antidisestablishmentarianism")]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 10.0, 40.0, "punchy", path, 864, 1080, 1920, "split",
                caption_safe_zone=False))
            text = path.read_text()
            self.assertIn("{\\fs56}", text)

    def test_auto_fit_leaves_normal_phrases_alone(self):
        # "climb the tower" measures 868px at fs 96 (real DejaVu Sans
        # Bold widths, Batch 6) — inside the 960px margin, so no
        # {\\fs} override. ("we climb the tower" is 1059px and now
        # correctly shrinks — the old estimator said 829px and let it
        # through at full size, 21px from the frame edge.)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "nofit.ass"
            segments = [_segment(10.0, 20.0, "climb the tower")]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 10.0, 40.0, "punchy", path, 864, 1080, 1920, "split",
                caption_safe_zone=False))
            self.assertNotIn("{\\fs", path.read_text())

    # --- Headline picking ---

    def test_headline_picker_prefers_content_over_filler(self):
        segments = [
            _segment(10.0, 20.0, "um uh hmm yeah so"),
            _segment(22.0, 32.0, "climb the tower now"),
        ]
        headline = muse_worker.derive_on_screen_text(
            {"start": 10.0, "end": 40.0}, segments, {})
        self.assertEqual(headline, "CLIMB THE TOWER NOW")

    def test_headline_picker_rejects_repeated_word(self):
        # "tower" x4 spoken fast (dense) vs "we climb the tower"
        # spoken slow: without the repeat penalty the dense repeat
        # would win; with it, the real phrase wins.
        words = [(10.0 + i * 0.4, 10.4 + i * 0.4, "tower") for i in range(4)]
        words += [(14.0, 15.5, "we"), (15.5, 17.0, "climb"),
                  (17.0, 18.5, "the"), (18.5, 20.0, "tower")]
        segments = [self._manual_segment(10.0, 20.0, words)]
        headline = muse_worker.derive_on_screen_text(
            {"start": 10.0, "end": 20.0}, segments, {})
        self.assertEqual(headline, "WE CLIMB THE TOWER")

    # --- Headline styles ---

    def test_headline_styles_render_differently(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            for style, needle in (
                    ("bold_bar", ",8,40,40,120,1"),
                    ("lower_third", ",2,40,40,40,1"),
                    ("big_centre", ",5,40,40,0,1")):
                path = tmp / f"{style}.ass"
                self.assertTrue(muse_worker.write_headline_ass(
                    "WIN THE PS5 TODAY", 30.0, path, 1080, 1920, style))
                self.assertIn(needle, path.read_text())
            # lower_third uses an opaque box (BorderStyle 3).
            self.assertIn(",3,2,0,2,40,40,40,1",
                          (tmp / "lower_third.ass").read_text())
            # Unknown style falls back to the bold bar.
            path = tmp / "unknown.ass"
            muse_worker.write_headline_ass(
                "WIN THE PS5 TODAY", 30.0, path, 1080, 1920, "nope")
            self.assertIn(",8,40,40,120,1", path.read_text())

    # --- Caption position ---

    def test_caption_positions_move_captions(self):
        # Safe zone OFF here so the test pins position (MarginV), not
        # the Batch 6 safe-zone margins.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            segments = [_segment(10.0, 20.0, "we climb the tower")]
            # bottom (default): on the split divider (864 - 96/2 = 816).
            path = tmp / "bottom.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,816,1", path.read_text())
            # top: below the headline band.
            path = tmp / "top.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split", "top",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,300,1", path.read_text())
            # middle: vertically centred (1920/2 - 96/2 = 912).
            path = tmp / "middle.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split", "middle",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,912,1", path.read_text())
            # middle + big_centre headline: dropped to 62% (1190) so
            # the captions never overlap the centred headline.
            path = tmp / "middle_big.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split",
                                       "middle", "big_centre",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,1190,1", path.read_text())
            # Unknown position falls back to bottom.
            path = tmp / "unknown.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split", "sideways",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,816,1", path.read_text())

    def test_caption_position_bottom_keeps_clean_subs_spot(self):
        # clean_subs keeps its established bottom-centre spot (2, 40)
        # at the default position — it does not move to the divider.
        # Safe zone OFF so the test pins the spot, not the margins.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "clean.ass"
            segments = [_segment(10.0, 20.0, "we climb the tower")]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 10.0, 40.0, "clean_subs", path,
                864, 1080, 1920, "split", caption_safe_zone=False))
            self.assertIn(",2,40,40,40,1", path.read_text())

    # --- Quality boost ---

    def test_tracked_crop_quotes_its_time_expression(self):
        # Regression (found by proof Job #39, 2026-11-25): the
        # face-tracking crop offset is a nested if()/min()/max()
        # expression full of commas. Unquoted, ffmpeg's filtergraph
        # parser split it into separate filters and the render died
        # with "No such filter: '0.000)'" — but only when a face was
        # actually found, which is why Batch 1's proofs (no face in
        # frame) never saw it. The offsets must be single-quoted.
        track = [(0.0, 0.5, 0.5, 0.1, 0.1), (2.0, 0.6, 0.5, 0.1, 0.1),
                 (4.0, 0.55, 0.5, 0.1, 0.1)]
        wide = muse_worker._tracked_crop(1280, 720, 1080, 1920, track)
        self.assertIn(":'", wide)
        self.assertIn("':0,scale=1080:1920", wide)
        tall = muse_worker._tracked_crop(720, 1280, 1080, 1920, track)
        self.assertIn(":0:'", tall)
        self.assertIn("',scale=1080:1920", tall)
        inset = muse_worker._tracked_inset_crop(
            (0.5, 0.5, 0.1, 0.1), 1280, 720, track)
        self.assertIsNotNone(inset)
        self.assertEqual(inset.count("'"), 4)

    def test_render_with_face_tracking_trajectory(self):
        # The tracked crop must render through real ffmpeg — this is
        # the end-to-end half of the quoting regression test above.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "src.mp4"
            cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
                   "-f", "lavfi", "-i", "color=c=green:s=640x360:d=5:r=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                   "-shortest", str(clip)]
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=5,
                                 auto_zoom=False, face_tracking=True,
                                 silence_removal=False, filler_removal=False)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            track = [(0.0, 0.5, 0.5, 0.1, 0.1), (2.0, 0.6, 0.5, 0.1, 0.1),
                     (4.0, 0.55, 0.5, 0.1, 0.1)]
            with mock.patch.object(muse_worker, "face_track_trajectory",
                                   return_value=track):
                muse_worker.render_clip(clip, {"start": 0.0, "end": 5.0},
                                        settings, [], out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)

    def test_render_loudness_near_minus_14_lufs(self):
        # A real render with default settings: 5s sine-audio clip.
        # The output must measure about -14 LUFS integrated (±2),
        # be 1080x1920 h264 + aac, and last the promised 5s.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "src.mp4"
            cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
                   "-f", "lavfi", "-i", "color=c=green:s=640x360:d=5:r=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                   "-shortest", str(clip)]
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            settings = _settings(layout="center_crop", captions_enabled=False,
                                 duration_mode="maximum", duration_seconds=5,
                                 auto_zoom=False, face_tracking=False,
                                 silence_removal=False, filler_removal=False)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(clip)
            muse_worker.render_clip(clip, {"start": 0.0, "end": 5.0},
                                    settings, [], out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertEqual(rendered["video_codec"], "h264")
            self.assertEqual(rendered["audio_codec"], "aac")
            self.assertTrue(rendered["has_audio"])
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)
            loud = self._measure_loudness(out)
            self.assertIsNotNone(loud, "loudnorm measurement produced no JSON")
            self.assertGreaterEqual(loud, -16.0)
            self.assertLessEqual(loud, -12.0)

    @staticmethod
    def _measure_loudness(path: Path) -> float | None:
        """Integrated loudness (LUFS) of a file, via ffmpeg loudnorm
        in measure mode (its input_i is the file's own loudness)."""
        proc = subprocess.run(
            [muse_worker.FFMPEG, "-i", str(path), "-af",
             "loudnorm=print_format=json", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
        m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", proc.stderr or "", re.S)
        if not m:
            return None
        try:
            return float(json.loads(m.group(0))["input_i"])
        except (ValueError, KeyError, TypeError):
            return None


class Batch3Tests(unittest.TestCase):
    """Batch 3 (2026-11-25): five new animated caption styles, beat-synced
    cuts/zoom, captions auto-translate (MyMemory), multi-ratio export."""

    NEW_STYLES = ["word_zoom", "word_fade", "highlight_sweep",
                  "bounce_in", "glitch_pop"]

    def _words_at(self, pairs):
        return [{"start": s, "end": e, "word": w} for s, e, w in pairs]

    def _manual_segment(self, start, end, pairs):
        words = self._words_at(pairs)
        return {"start": start, "end": end,
                "text": " ".join(w[2] for w in pairs), "words": words}

    def _make_clip(self, path, duration=10, freq=440):
        """A real MP4: green frames + a sine tone (no silence gaps)."""
        cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
               "-f", "lavfi", "-i",
               f"color=c=green:s=640x360:d={duration}:r=30",
               "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={duration}",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-shortest", str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(Path(path).exists())

    def _ass_for(self, style, tmp):
        segments = [self._manual_segment(
            0.0, 5.0, [(0.5, 0.9, "hello"), (1.0, 1.4, "brave"),
                       (1.5, 1.9, "new"), (2.0, 2.4, "world")])]
        path = tmp / f"{style}.ass"
        self.assertTrue(muse_worker.write_clip_ass(
            segments, 0.0, 5.0, style, path, 864, 1080, 1920, "split"))
        return path.read_text()

    # --- Five new caption styles ---

    def test_new_styles_in_dict(self):
        for style in self.NEW_STYLES:
            self.assertIn(style, muse_worker.CAPTION_STYLES)
        # Batch 6 (2026-11-25) adds three platform styles (tiktok_bold,
        # reels_clean, shorts_minimal): 20 + 3 = 23.
        self.assertEqual(len(muse_worker.CAPTION_STYLES), 23)

    def test_new_styles_render_distinct_ass(self):
        # Every new style must burn real, distinct libass transforms —
        # not the same file under five names.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            texts = {s: self._ass_for(s, tmp) for s in self.NEW_STYLES}
            # Each style's file is different from every other style's.
            self.assertEqual(len(set(texts.values())), 5)
            # word_zoom: lands at 120% and settles to 100%.
            self.assertIn("\\fscx120\\fscy120\\t(0,300,\\fscx100\\fscy100)",
                          texts["word_zoom"])
            # word_fade: alpha ramp from fully transparent.
            self.assertIn("\\alpha&HFF&\\t(0,250,\\alpha&H00&)",
                          texts["word_fade"])
            # highlight_sweep: opaque yellow box (BorderStyle 3) behind
            # black text, one word per event.
            self.assertIn(",3,0,0,", texts["highlight_sweep"])
            self.assertIn("&H0000FFFF", texts["highlight_sweep"])
            self.assertIn("Dialogue: 0,0:00:00.50,0:00:00.90,HighlightSweep",
                          texts["highlight_sweep"])
            # bounce_in: overshoot AND undershoot settle (118 -> 95 ->
            # 100) — `bounce` has the overshoot but no 95 undershoot.
            self.assertIn("\\fscx118\\fscy118", texts["bounce_in"])
            self.assertIn("\\fscx95\\fscy95", texts["bounce_in"])
            bounce = self._ass_for("bounce", tmp)
            self.assertNotIn("\\fscx95\\fscy95", bounce)
            # glitch_pop: rapid magenta -> cyan colour flicker on each
            # word change (libass has no true RGB split — documented
            # in the worker).
            self.assertIn("\\1c&HFF00FF&", texts["glitch_pop"])
            self.assertIn("\\1c&H00FFFF&", texts["glitch_pop"])

    def test_new_style_burns_through_real_ffmpeg(self):
        # The riskiest transforms (a \1c colour change inside a \t)
        # must survive a real subtitles burn, not just ASS text.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            src = tmp / "src.mp4"
            self._make_clip(src, 5)
            words = [(0.5 + i * 0.5, 0.9 + i * 0.5, w)
                     for i, w in enumerate(["glitch", "it", "up", "now"])]
            segments = [self._manual_segment(0.0, 5.0, words)]
            settings = _settings(layout="center_crop", captions_enabled=True,
                                 caption_style="glitch_pop",
                                 duration_mode="maximum", duration_seconds=5)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(src)
            muse_worker.render_clip(src, {"start": 0.0, "end": 5.0},
                                    settings, segments, out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)

    # --- Beat sync ---

    def test_detect_beats_finds_onsets(self):
        # Flat 0.2 with sharp jumps at seconds 5 and 12 (0.2 -> 0.9).
        # Beats sit at the centre of the onset second.
        profile = [0.2] * 20
        profile[5] = 0.9
        profile[6] = 0.85
        profile[12] = 0.95
        profile[13] = 0.9
        self.assertEqual(muse_worker.detect_beats(profile), [5.5, 12.5])
        # Flat audio: no rise anywhere, no beats.
        self.assertEqual(muse_worker.detect_beats([0.2] * 20), [])
        self.assertEqual(muse_worker.detect_beats([]), [])
        self.assertEqual(muse_worker.detect_beats([0.0] * 10), [])

    def test_snap_zoom_moments_moves_start_to_beat(self):
        moments, n = muse_worker.snap_zoom_moments_to_beats(
            [(10.2, 12.0), (20.0, 22.0)], [10.5, 30.0], 0.0, 60.0)
        # First moment snaps +0.3 (start 10.5, end keeps its length);
        # second is nowhere near a beat and stays put.
        self.assertEqual(n, 1)
        self.assertAlmostEqual(moments[0][0], 10.5, places=3)
        self.assertAlmostEqual(moments[0][1], 12.3, places=3)
        self.assertEqual(moments[1], (20.0, 22.0))
        # A moment the clamp would crush below 0.5s stays put: the
        # 0.4s moment (0.3, 0.7) in a [0.2, 0.6] clip cannot snap to
        # beat 0.0 without losing its length.
        moments, n = muse_worker.snap_zoom_moments_to_beats(
            [(0.3, 0.7)], [0.0], 0.2, 0.6)
        self.assertEqual((moments, n), ([(0.3, 0.7)], 0))

    def test_snap_windows_preserves_duration_and_avoids_overlap(self):
        windows = [
            {"start": 10.0, "end": 30.0, "duration": 20.0, "words": 10,
             "signals": [], "reason": "Score 0.80 (viral 80/100): test."},
            {"start": 40.0, "end": 60.0, "duration": 20.0, "words": 10,
             "signals": [], "reason": "Score 0.70 (viral 70/100): test."},
        ]
        n = muse_worker.snap_windows_to_beats(windows, [10.4, 40.4], 120.0)
        self.assertEqual(n, 2)
        for w in windows:
            # Duration preserved EXACTLY — the promise is never broken
            # to chase a beat.
            self.assertAlmostEqual(w["duration"], 20.0, places=3)
        self.assertAlmostEqual(windows[0]["start"], 10.4, places=3)
        self.assertAlmostEqual(windows[0]["end"], 30.4, places=3)
        self.assertIn("beat_aligned", windows[0]["signals"])
        self.assertIn("Beat-aligned start.", windows[0]["reason"])
        # A shift that would overlap the neighbour is refused.
        windows = [
            {"start": 10.0, "end": 30.0, "duration": 20.0, "words": 10,
             "signals": [], "reason": "x"},
            {"start": 30.2, "end": 50.2, "duration": 20.0, "words": 10,
             "signals": [], "reason": "y"},
        ]
        n = muse_worker.snap_windows_to_beats(windows, [10.4], 120.0)
        self.assertEqual(n, 0)
        self.assertEqual((windows[0]["start"], windows[0]["end"]),
                         (10.0, 30.0))
        # A shift past the end of the source is refused.
        windows = [{"start": 100.0, "end": 120.0, "duration": 20.0, "words": 10,
                    "signals": [], "reason": "x"}]
        n = muse_worker.snap_windows_to_beats(windows, [100.4], 120.0)
        self.assertEqual(n, 0)
        self.assertEqual((windows[0]["start"], windows[0]["end"]),
                         (100.0, 120.0))

    def test_beat_snap_never_breaks_exact_duration(self):
        # Full selection + snap on a fixture: every window still
        # measures exactly the promised duration afterwards. The
        # windows start 0.3s off a beat (4.8 vs beat 4.5, 34.8 vs
        # 34.5), so both actually snap — and still measure 20.0s.
        segments = [_segment(5.3, 25.3, "we climb the tower now fast"),
                    _segment(35.3, 55.3, "look at the highest point here")]
        energy = [0.2] * 60
        for i in (4, 5, 6):
            energy[i] = 0.9
        for i in (34, 35):
            energy[i] = 0.9
        clips = muse_worker.select_highlights(
            segments, 60.0, _settings(clip_count=2, duration_seconds=20),
            energy, [])
        self.assertEqual(len(clips), 2)
        beats = muse_worker.detect_beats(energy)
        self.assertEqual(beats, [4.5, 34.5])
        n = muse_worker.snap_windows_to_beats(clips, beats, 60.0)
        self.assertEqual(n, 2)
        for c in clips:
            self.assertAlmostEqual(c["duration"], 20.0, places=3)
            self.assertAlmostEqual(c["end"] - c["start"], 20.0, places=3)
        self.assertAlmostEqual(clips[0]["start"], 4.5, places=3)
        self.assertAlmostEqual(clips[1]["start"], 34.5, places=3)

    # --- Captions auto-translate ---

    def test_translation_fallback_on_failed_api_call(self):
        # The API itself fails (network error): every segment keeps its
        # original text and the status says so.
        segments = [_segment(0.0, 5.0, "hello brave new world")]
        import urllib.error
        with mock.patch.object(
                muse_worker.urllib.request, "urlopen",
                side_effect=urllib.error.URLError("no network")):
            out, info = muse_worker.translate_segments(
                segments, "ur", source_language="english")
        self.assertEqual(info["status"], "unavailable")
        self.assertEqual(info["failed"], 1)
        self.assertEqual(out[0]["text"], "hello brave new world")
        # The input segments are untouched.
        self.assertEqual(segments[0]["text"], "hello brave new world")

    def test_translation_quota_warning_is_not_a_translation(self):
        # MyMemory answers 429 with the quota warning AS the
        # translatedText — it must never be used as a caption.
        body = json.dumps({
            "responseData": {"translatedText":
                             "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE "
                             "TRANSLATIONS FOR TODAY"},
            "responseStatus": 429}).encode()
        resp = mock.MagicMock()
        resp.read.return_value = body
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        segments = [_segment(0.0, 5.0, "hello brave new world")]
        with mock.patch.object(muse_worker.urllib.request, "urlopen",
                               return_value=resp):
            out, info = muse_worker.translate_segments(
                segments, "ur", source_language="english")
        self.assertEqual(info["status"], "unavailable")
        self.assertNotIn("MYMEMORY WARNING", out[0]["text"])

    def test_translation_success_and_cache(self):
        segments = [_segment(0.0, 5.0, "hello world"),
                    _segment(6.0, 11.0, "hello world")]
        calls: list[str] = []

        def fake_translate(text, source, target):
            calls.append(text)
            return "ہیلو دنیا"

        with mock.patch.object(muse_worker, "_mymemory_translate",
                               side_effect=fake_translate):
            out, info = muse_worker.translate_segments(
                segments, "ur", source_language="english")
        self.assertEqual(info["status"], "ok")
        self.assertEqual(info["translated"], 2)
        # The repeated line is translated ONCE (in-memory cache).
        self.assertEqual(calls, ["hello world"])
        for seg in out:
            self.assertEqual(seg["text"], "ہیلو دنیا")
            # Translated words spread evenly across the segment span.
            self.assertEqual(len(seg["words"]), 2)
            self.assertAlmostEqual(seg["words"][0]["start"], seg["start"])
            self.assertAlmostEqual(seg["words"][-1]["end"], seg["end"])

    def test_translation_partial_keeps_failed_segments(self):
        segments = [_segment(0.0, 5.0, "hello world"),
                    _segment(6.0, 11.0, "goodbye world")]

        def fake_translate(text, source, target):
            return "ہیلو دنیا" if text == "hello world" else None

        with mock.patch.object(muse_worker, "_mymemory_translate",
                               side_effect=fake_translate):
            out, info = muse_worker.translate_segments(
                segments, "ur", source_language="english")
        self.assertEqual(info["status"], "partial")
        self.assertEqual(info["translated"], 1)
        self.assertEqual(info["failed"], 1)
        self.assertEqual(out[0]["text"], "ہیلو دنیا")
        self.assertEqual(out[1]["text"], "goodbye world")

    def test_translation_skips_same_language(self):
        segments = [_segment(0.0, 5.0, "hello world")]
        with mock.patch.object(muse_worker, "_mymemory_translate",
                               side_effect=AssertionError("must not call")):
            out, info = muse_worker.translate_segments(
                segments, "en", source_language="english")
        self.assertEqual(info["status"], "same")
        self.assertIs(out, segments)

    # --- Multi-ratio export ---

    def test_export_ratios_defaults_and_forces_primary(self):
        self.assertEqual(muse_worker.export_ratios({}), ["9:16"])
        self.assertEqual(
            muse_worker.export_ratios(
                {"aspect_ratio": "1:1", "export_ratios": ["16:9"]}),
            ["1:1", "9:16", "16:9"])
        # Unknown ratios are dropped; duplicates collapse.
        self.assertEqual(
            muse_worker.export_ratios(
                {"aspect_ratio": "9:16",
                 "export_ratios": ["1:1", "1:1", "4:3"]}),
            ["9:16", "1:1"])
        # A bare string (a sloppy client) still works.
        self.assertEqual(
            muse_worker.export_ratios(
                {"aspect_ratio": "9:16", "export_ratios": "1:1"}),
            ["9:16", "1:1"])

    def test_windows_per_ratio_cap(self):
        # 50-clip total cap: 3 ratios -> 16 windows (48 clips).
        self.assertEqual(
            muse_worker.windows_per_ratio(
                30, ["9:16", "1:1", "16:9"]), 16)
        self.assertEqual(
            muse_worker.windows_per_ratio(3, ["9:16", "1:1"]), 3)
        self.assertEqual(muse_worker.windows_per_ratio(30, ["9:16"]), 30)

    def test_multi_ratio_renders_two_ratios(self):
        # The same window renders in 9:16 AND 1:1 with the new word_zoom
        # style and face tracking ON: each ratio gets the right
        # resolution, the promised duration, and its own thumbnail.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            src = tmp / "src.mp4"
            self._make_clip(src, 10)
            words = [(0.5 + i * 0.5, 0.9 + i * 0.5, w)
                     for i, w in enumerate(
                         ["zoom", "in", "on", "the", "tower", "now"])]
            segments = [self._manual_segment(0.0, 5.0, words)]
            info = muse_worker.probe_summary(src)
            for ratio, expected in (("9:16", (1080, 1920)),
                                    ("1:1", (1080, 1080))):
                settings = _settings(
                    aspect_ratio=ratio, layout="center_crop",
                    captions_enabled=True, caption_style="word_zoom",
                    duration_mode="maximum", duration_seconds=5,
                    face_tracking=True)
                clip_dict = {"start": 0.0, "end": 5.0}
                out = tmp / f"out_{ratio.replace(':', 'x')}.mp4"
                muse_worker.render_clip(src, clip_dict, settings, segments,
                                        out, info, tmp)
                rendered = muse_worker.probe_summary(out)
                self.assertEqual((rendered["width"], rendered["height"]),
                                 expected, f"ratio {ratio}")
                self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)
                thumb = muse_worker.extract_thumbnail(
                    out, tmp / f"thumb_{ratio.replace(':', 'x')}.jpg",
                    at_seconds=1.0)
                self.assertTrue(thumb.exists())
                self.assertGreater(thumb.stat().st_size, 0)

    # --- Ready note (Batch 3 lines) ---

    def test_ready_note_reports_batch3_extras(self):
        note = muse_worker._ready_note(
            [{"signals": []}], 1, [], rendered=[{"_batch1_stats": {}}],
            extra=["Beat sync: 2 of 3 zoom moment(s) snapped to beats; "
                   "1 of 1 clip start(s) aligned to beats.",
                   "Captions translated to Urdu.",
                   "Exported in 2 ratios — 9:16, 1:1 (2 clips total)."])
        self.assertIn("Beat sync: 2 of 3 zoom moment(s) snapped", note)
        self.assertIn("Captions translated to Urdu.", note)
        self.assertIn("Exported in 2 ratios", note)
        # A full-count job with no extras still gets no note.
        self.assertIsNone(muse_worker._ready_note(
            [{"signals": []}], 1, [], rendered=[{"_batch1_stats": {}}]))


class Batch4Tests(unittest.TestCase):
    """Batch 4 (2026-11-25): title + hashtag suggestions, logo overlay,
    thumbnail-picker candidates, and the API plumbing for them."""

    def _fixture_segments(self):
        # Real words from a gardening talk — the derivation must use
        # THESE words, never canned output.
        return [
            _segment(0.0, 8.0,
                     "Growing tomatoes at home is easier than you think."),
            _segment(8.0, 16.0,
                     "Tomatoes need six hours of sunlight and regular watering "
                     "every single day."),
            _segment(16.0, 24.0,
                     "Water your tomatoes in the morning so the leaves stay dry."),
            _segment(24.0, 32.0,
                     "My garden tomatoes taste better than anything from the shop."),
        ]

    # --- Title + hashtags ---

    def test_derive_title_hashtags_from_fixture_transcript(self):
        title, tags = muse_worker.derive_title_hashtags(
            self._fixture_segments(), 120.0)
        self.assertIsNotNone(title)
        # The title is a phrase from the fixture itself.
        self.assertIn("tomato", title.lower())
        self.assertLessEqual(len(title), 60)
        # Hashtags: lowercase, #prefixed, deduped, real content words.
        self.assertGreaterEqual(len(tags), 1)
        self.assertLessEqual(len(tags), 8)
        self.assertEqual(len(tags), len(set(tags)))
        for tag in tags:
            self.assertTrue(tag.startswith("#"), tag)
            self.assertEqual(tag, tag.lower())
            self.assertLessEqual(len(tag), 21)
        self.assertIn("#tomatoes", tags)
        # Stopwords never become hashtags.
        for tag in tags:
            self.assertNotIn(tag, {"#the", "#and", "#your", "#than", "#you"})

    def test_derive_title_hashtags_empty_transcript(self):
        title, tags = muse_worker.derive_title_hashtags([], 120.0)
        self.assertIsNone(title)
        self.assertEqual(tags, [])

    def test_derive_title_hashtags_whisper_style_words(self):
        # Regression (Job #44): real Whisper words carry a leading
        # space (" Come") and the raw words must still yield hashtags
        # — the first build read them raw and returned 0 tags.
        segments = [
            {"start": 0.0, "end": 8.0,
             "text": "Growing tomatoes at home is easier than you think.",
             "words": [
                 {"word": " Growing", "start": 0.0, "end": 0.5},
                 {"word": " tomatoes", "start": 0.5, "end": 1.0},
                 {"word": " at", "start": 1.0, "end": 1.2},
                 {"word": " home", "start": 1.2, "end": 1.6},
                 {"word": " is", "start": 1.6, "end": 1.8},
                 {"word": " easier", "start": 1.8, "end": 2.2},
                 {"word": " than", "start": 2.2, "end": 2.4},
                 {"word": " you", "start": 2.4, "end": 2.6},
                 {"word": " think.", "start": 2.6, "end": 3.0},
                 {"word": " Tomatoes", "start": 3.0, "end": 3.5},
                 {"word": " tomatoes", "start": 3.5, "end": 4.0},
                 {"word": " tomatoes.", "start": 4.0, "end": 4.5},
             ]},
        ]
        title, tags = muse_worker.derive_title_hashtags(segments, 120.0)
        self.assertIsNotNone(title)
        # A title is not a sentence — no trailing period.
        self.assertFalse(title.endswith("."))
        self.assertIn("#tomatoes", tags)
        self.assertGreaterEqual(len(tags), 2)
        for tag in tags:
            self.assertTrue(tag.startswith("#"))
            self.assertNotIn(" ", tag)

    def test_derive_title_hashtags_silent_segments(self):
        # Segments with no words at all (a silent source that still
        # produced empty segments) — no suggestions, honestly.
        title, tags = muse_worker.derive_title_hashtags(
            [{"start": 0.0, "end": 5.0, "text": "", "words": []}], 60.0)
        self.assertIsNone(title)
        self.assertEqual(tags, [])

    # --- Logo overlay ---

    def _make_clip(self, path, duration=4, color="green", size="360x640"):
        cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
               "-f", "lavfi", "-i",
               f"color=c={color}:s={size}:d={duration}:r=30",
               "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-shortest", str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def _make_logo(self, path, color="red", size="120x60"):
        # A real PNG logo made with ffmpeg — not copied from anywhere.
        cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
               "-f", "lavfi", "-i", f"color=c={color}:s={size}:d=1:r=1",
               "-frames:v", "1", str(path)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def _corner_rgb(self, image_path, corner):
        """Average RGB of one corner of an image, via ffmpeg (no PIL).
        The logo is 12% of the 360px clip width (~43px) with a 12px
        margin, so it occupies x 305–348, y 606–628 — the bottom-right
        crop sits fully inside it; the top-left crop is plain clip."""
        crop = "crop=30:15:310:610" if corner == "bottom_right" else "crop=40:40:10:10"
        proc = subprocess.run(
            [muse_worker.FFMPEG, "-v", "error", "-i", str(image_path),
             "-vf", f"{crop},scale=1:1", "-f", "rawvideo",
             "-pix_fmt", "rgb24", "-"],
            capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout), 3)
        return tuple(proc.stdout)

    def test_logo_overlay_places_red_pixels_bottom_right(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "clip.mp4"
            logo = tmp / "logo.png"
            self._make_clip(clip)
            self._make_logo(logo)
            out, applied = muse_worker.apply_logo_overlay(
                clip, logo, tmp / "logoed.mp4")
            self.assertTrue(applied)
            self.assertNotEqual(out, clip)
            info = muse_worker.probe_summary(out)
            self.assertAlmostEqual(info["duration"], 4.0, delta=0.5)
            self.assertTrue(info["has_audio"])
            frame = muse_worker.extract_thumbnail(out, tmp / "frame.jpg",
                                                  at_seconds=2.0)
            self.assertIsNotNone(frame)
            r, g, _b = self._corner_rgb(frame, "bottom_right")
            # The red logo sits bottom-right; the green clip is elsewhere.
            self.assertGreater(r, 150)
            self.assertLess(g, 100)
            r2, g2, _b2 = self._corner_rgb(frame, "top_left")
            self.assertGreater(g2, r2)  # untouched green clip corner

    def test_logo_overlay_missing_logo_returns_original(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "clip.mp4"
            self._make_clip(clip)
            out, applied = muse_worker.apply_logo_overlay(
                clip, tmp / "nope.png", tmp / "logoed.mp4")
            self.assertFalse(applied)
            self.assertEqual(out, clip)

    def test_logo_overlay_garbage_image_returns_original(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "clip.mp4"
            self._make_clip(clip)
            bad = tmp / "bad.png"
            bad.write_bytes(b"this is not an image at all")
            out, applied = muse_worker.apply_logo_overlay(
                clip, bad, tmp / "logoed.mp4")
            self.assertFalse(applied)
            self.assertEqual(out, clip)

    # --- Thumbnail candidates ---

    def test_thumbnail_candidates_three_distinct_frames(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            clip = tmp / "clip.mp4"
            # testsrc frames change over time, so three frames taken at
            # 10/50/90% of the duration must differ from each other.
            cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
                   "-f", "lavfi", "-i",
                   "testsrc=duration=10:size=360x640:rate=30",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                   "-pix_fmt", "yuv420p", str(clip)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            cands = muse_worker.extract_thumbnail_candidates(
                clip, tmp, "cand", 10.0)
            self.assertEqual(len(cands), 3)
            for cand in cands:
                self.assertTrue(Path(cand).exists())
                self.assertGreater(Path(cand).stat().st_size, 0)
            # Three different moments in the clip — three different frames.
            hashes = {Path(c).read_bytes() for c in cands}
            self.assertEqual(len(hashes), 3)

    def test_thumbnail_candidates_missing_clip_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            cands = muse_worker.extract_thumbnail_candidates(
                tmp / "nope.mp4", tmp, "cand", 10.0)
            self.assertEqual(cands, [])

    # --- API plumbing: suggestions + candidates ---

    def test_set_status_sends_suggestions(self):
        captured = {}

        class FakeResp:
            status_code = 200
            text = "{}"

            def json(self):
                return {"id": 1}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["json"] = kwargs.get("json")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        api.set_status(1, "Ready", title_suggestion="Tomatoes At Home",
                       hashtags=["#tomatoes", "#garden"])
        self.assertEqual(captured["json"]["title_suggestion"], "Tomatoes At Home")
        self.assertEqual(captured["json"]["hashtags"],
                         ["#tomatoes", "#garden"])
        # Absent suggestions send nothing — older behaviour unchanged.
        api.set_status(1, "Processing", stage="rendering")
        self.assertNotIn("title_suggestion", captured["json"])
        self.assertNotIn("hashtags", captured["json"])

    def test_upload_clip_sends_candidates(self):
        captured = {}

        class FakeResp:
            status_code = 201
            text = "{}"

            def json(self):
                return {"clip": {"id": 7}}

        class FakeRequests:
            def request(self, method, url, headers=None, **kwargs):
                captured["files"] = kwargs.get("files")
                return FakeResp()

        api = muse_worker.JobApi("test-key")
        api._requests = FakeRequests()
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip_01.mp4"
            clip_path.write_bytes(b"fake mp4")
            cands = []
            for i in range(3):
                p = Path(tmp) / f"cand_{i}.jpg"
                p.write_bytes(b"fake jpg")
                cands.append(p)
            api.upload_clip(1, clip_path, {"title": "Clip 1"},
                            candidates=cands)
        files = captured["files"]
        self.assertIn("candidate_1", files)
        self.assertIn("candidate_2", files)
        self.assertIn("candidate_3", files)
        # Missing files are skipped, never sent as empty fields.
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip_01.mp4"
            clip_path.write_bytes(b"fake mp4")
            api.upload_clip(1, clip_path, {"title": "Clip 1"},
                            candidates=[Path(tmp) / "gone.jpg"])
        self.assertNotIn("candidate_1", captured["files"])


class Batch5Tests(unittest.TestCase):
    """Batch 5 (2026-11-25): strip TMX/HTML tags from MyMemory
    translations (Job #16's transcript showed `<bpt i="0" x="0"/>`
    verbatim)."""

    def _fake_response(self, translated_text: str):
        body = json.dumps({
            "responseData": {"translatedText": translated_text},
            "responseStatus": 200}).encode()
        resp = mock.MagicMock()
        resp.read.return_value = body
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        return resp

    def test_tmx_tags_stripped_from_translation(self):
        # The exact shape Job #16 showed: TMX tags around real words.
        tagged = ('<bpt i="0" x="0"/> آپ ایک بار بنا سکتے ہیں '
                  '<ept i="0" x="0"/> <bpt i="1" x="1"/> موسیقی سن سکتے ہیں')
        with mock.patch.object(muse_worker.urllib.request, "urlopen",
                               return_value=self._fake_response(tagged)):
            got = muse_worker._mymemory_translate(
                "you can make it once", "en", "ur")
        self.assertIsNotNone(got)
        assert got is not None
        self.assertNotIn("<", got)
        self.assertNotIn("bpt", got)
        self.assertIn("آپ ایک بار بنا سکتے ہیں", got)
        self.assertIn("موسیقی سن سکتے ہیں", got)
        # No leftover double spaces where tags were removed.
        self.assertNotIn("  ", got)

    def test_translation_of_only_tags_is_a_failure(self):
        with mock.patch.object(muse_worker.urllib.request, "urlopen",
                               return_value=self._fake_response(
                                   '<bpt i="0" x="0"/><ept i="0" x="0"/>')):
            got = muse_worker._mymemory_translate(
                "hello world", "en", "ur")
        self.assertIsNone(got)

    def test_clean_translation_passes_through_unchanged(self):
        with mock.patch.object(muse_worker.urllib.request, "urlopen",
                               return_value=self._fake_response("ہیلو دنیا")):
            got = muse_worker._mymemory_translate(
                "hello world", "en", "ur")
        self.assertEqual(got, "ہیلو دنیا")

    def test_translate_segments_strips_tags_end_to_end(self):
        segments = [_segment(0.0, 5.0, "hello world")]
        tagged = '<bpt i="0" x="0"/> ہیلو دنیا'
        with mock.patch.object(muse_worker.urllib.request, "urlopen",
                               return_value=self._fake_response(tagged)):
            out, info = muse_worker.translate_segments(
                segments, "ur", source_language="english")
        self.assertEqual(info["status"], "ok")
        self.assertEqual(out[0]["text"], "ہیلو دنیا")
        self.assertNotIn("<", out[0]["text"])


class Batch6Tests(unittest.TestCase):
    """Batch 6 (2026-11-25): caption quality — real font measurement,
    caption safe zone, word-perfect timing, phrase-boundary wrapping,
    three platform caption styles."""

    NEW_STYLES = ["tiktok_bold", "reels_clean", "shorts_minimal"]

    def _words_at(self, pairs):
        return [{"start": s, "end": e, "word": w} for s, e, w in pairs]

    def _manual_segment(self, start, end, pairs):
        words = self._words_at(pairs)
        return {"start": start, "end": end,
                "text": " ".join(w[2] for w in pairs), "words": words}

    @staticmethod
    def _ass_seconds(stamp: str) -> float:
        h, m, rest = stamp.split(":")
        s, cs = rest.split(".")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100

    def _dialogue_events(self, text: str):
        events = []
        for line in text.splitlines():
            m = re.match(
                r"Dialogue: 0,(\d+:\d\d:\d\d\.\d\d),"
                r"(\d+:\d\d:\d\d\.\d\d),(\w+),,0,0,0,,(.*)$", line)
            if m:
                events.append((self._ass_seconds(m.group(1)),
                               self._ass_seconds(m.group(2)),
                               m.group(3), m.group(4)))
        return events

    # --- Real font measurement ---

    def test_measured_width_is_real_and_fallback_works(self):
        # The 28-letter word: the old estimator said 1398px at fs 96;
        # DejaVu Sans Bold really measures 1643px (2% safety included).
        # The estimator UNDER-measured it — which is why the old fit
        # (fs 65) still overflowed the margin.
        self.assertAlmostEqual(
            muse_worker._estimate_text_width_px(
                "antidisestablishmentarianism", 96), 1397.76, places=1)
        self.assertAlmostEqual(
            muse_worker._measure_text_width_px(
                "antidisestablishmentarianism", 96), 1643.4, delta=2.0)
        self.assertIsNotNone(muse_worker._load_measure_font())
        # No Pillow / no font: the estimator is the fallback, so a
        # machine without either still renders (just less precisely).
        with mock.patch.object(muse_worker, "_load_measure_font",
                               return_value=None):
            self.assertAlmostEqual(
                muse_worker._measure_text_width_px(
                    "antidisestablishmentarianism", 96), 1397.76, places=1)

    # --- Caption safe zone ---

    def test_safe_zone_caps_width_and_shifts_margins(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            segments = [_segment(10.0, 20.0, "climb the tower")]
            # ON (default): 9:16 — right margin reserves 22% of the
            # width (197 = int(1080*0.22) - 40), so the caption block
            # is the left ~78% of the frame, centred at ~43%.
            path = tmp / "on.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split")
            self.assertIn(",8,40,197,816,1", path.read_text())
            # OFF: the old 40px margins on both sides.
            path = tmp / "off.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split",
                                       caption_safe_zone=False)
            self.assertIn(",8,40,40,816,1", path.read_text())
            # 16:9 — right margin 382 (= int(1920*0.22) - 40).
            path = tmp / "wide.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       None, 1920, 1080, "center_crop")
            self.assertIn(",2,40,382,140,1", path.read_text())
            # 1:1 — same margins as 9:16 (both are 1080 wide).
            path = tmp / "square.ass"
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       None, 1080, 1080, "center_crop")
            self.assertIn(",2,40,197,140,1", path.read_text())

    def test_safe_zone_fit_uses_the_safe_width(self):
        # The 28-letter word under the safe zone (max 822px at 9:16)
        # fits to fs 48 (96 * 822 / 1643) — not 56 (the full-frame
        # fit), because the fit width is the safe area.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "safe-fit.ass"
            segments = [_segment(10.0, 20.0, "antidisestablishmentarianism")]
            muse_worker.write_clip_ass(segments, 10.0, 40.0, "punchy", path,
                                       864, 1080, 1920, "split")
            self.assertIn("{\\fs48}", path.read_text())

    # --- Word-perfect timing ---

    def test_karaoke_durations_match_word_durations(self):
        # Varied durations, including a 50ms word: the old max(10, ...)
        # floor forced every short word's fill to last 100ms. \k is
        # centisecond precision by format, so the values must match
        # round(duration * 100) exactly.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "karaoke.ass"
            segments = [self._manual_segment(0.0, 5.0, [
                (0.50, 0.55, "go"), (0.60, 1.00, "now"),
                (1.10, 1.34, "fast")])]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 0.0, 5.0, "karaoke", path, 864, 1080, 1920, "split"))
            text = path.read_text()
            self.assertIn("{\\k5}go", text)
            self.assertIn("{\\k40}now", text)
            self.assertIn("{\\k24}fast", text)
            # The event starts exactly at the first word's start.
            events = self._dialogue_events(text)
            self.assertEqual(len(events), 1)
            self.assertAlmostEqual(events[0][0], 0.50, delta=0.01)

    def test_word_events_start_at_word_starts(self):
        # Word-at-a-time styles: each event must start at its word's
        # Whisper start within ±10ms (ASS centisecond rounding is the
        # only error allowed — no 100ms rounding anywhere).
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "wordpop.ass"
            segments = [self._manual_segment(0.0, 5.0, [
                (0.512, 0.712, "go"), (1.007, 1.207, "now"),
                (1.500, 1.700, "fast")])]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 0.0, 5.0, "word_pop", path, 864, 1080, 1920, "split"))
            events = self._dialogue_events(path.read_text())
            self.assertEqual(len(events), 3)
            for event, want in zip(events, (0.512, 1.007, 1.500)):
                self.assertAlmostEqual(event[0], want, delta=0.011)

    # --- Phrase-boundary wrapping ---

    def test_phrase_chunking_breaks_only_at_boundaries(self):
        # Punctuated speech: breaks after the comma, before "and",
        # before "so" — never mid-phrase. The old chunker cut at 4
        # words wherever the count ran out ("we went to the | club").
        words = self._words_at([
            (0.0, 0.35, "we"), (0.4, 0.75, "went"), (0.8, 1.15, "to"),
            (1.2, 1.55, "the"), (1.6, 1.95, "club,"),
            (2.0, 2.35, "and"), (2.4, 2.75, "we"), (2.8, 3.15, "danced"),
            (3.2, 3.55, "all"), (3.6, 3.95, "night"),
            (4.0, 4.35, "so"), (4.4, 4.75, "it"), (4.8, 5.15, "was"),
            (5.2, 5.55, "amazing."),
        ])
        phrases = muse_worker._group_phrases(words)
        self.assertEqual(
            [[" ".join(w["word"] for w in p)] for p in phrases],
            [["we went to the club,"], ["and we danced all night"],
             ["so it was amazing."]])
        # Same boundaries for plain text (the no-timings fallback).
        self.assertEqual(
            muse_worker._split_text_phrases(
                "we went to the club, and we danced all night so it was amazing."),
            [["we", "went", "to", "the", "club,"],
             ["and", "we", "danced", "all", "night"],
             ["so", "it", "was", "amazing."]])
        # Run-on speech with no punctuation at all still chunks — the
        # 6-word cap is the last resort, and no chunk exceeds it.
        run_on = self._words_at([
            (i * 0.4, i * 0.4 + 0.35, w) for i, w in enumerate(
                "one two three four five six seven eight nine ten".split())])
        chunks = muse_worker._group_phrases(run_on)
        self.assertEqual([len(c) for c in chunks], [6, 4])

    def test_phrase_lines_split_at_boundary_and_balance(self):
        # "and we danced all night" (1323px at fs 96) does not fit the
        # 822px safe width: it splits into two lines at the middle
        # (no comma/conjunction inside to split on), and the font is
        # fitted on the longest line (892px -> fs 88), not the whole
        # phrase (which would shrink to 59).
        words = self._words_at([
            (0.0, 0.35, "and"), (0.4, 0.75, "we"), (0.8, 1.15, "danced"),
            (1.2, 1.55, "all"), (1.6, 1.95, "night")])
        lines = muse_worker._phrase_lines(
            [{"word": w["word"], "start": w["start"], "end": w["end"]}
             for w in words], 96, 822)
        self.assertEqual(
            [[w["word"] for w in line] for line in lines],
            [["and", "we"], ["danced", "all", "night"]])
        # A phrase WITH a comma splits at the comma, not the middle.
        comma_words = self._words_at([
            (0.0, 0.35, "we"), (0.4, 0.75, "went"), (0.8, 1.15, "to"),
            (1.2, 1.55, "the"), (1.6, 1.95, "club,"),
            (2.0, 2.35, "and"), (2.4, 2.75, "we"), (2.8, 3.15, "danced")])
        lines = muse_worker._phrase_lines(comma_words, 96, 500)
        self.assertEqual(
            [[w["word"] for w in line] for line in lines],
            [["we", "went", "to", "the", "club,"],
             ["and", "we", "danced"]])
        # End to end: the punchy event for the 5-word phrase carries
        # ONE line break (two lines, never more) and the fs 88 fit.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "lines.ass"
            segments = [self._manual_segment(0.0, 5.0, [
                (0.0, 0.35, "and"), (0.4, 0.75, "we"),
                (0.8, 1.15, "danced"), (1.2, 1.55, "all"),
                (1.6, 1.95, "night")])]
            self.assertTrue(muse_worker.write_clip_ass(
                segments, 0.0, 5.0, "punchy", path, 864, 1080, 1920, "split"))
            events = self._dialogue_events(path.read_text())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0][3].count("\\N"), 1)
            self.assertIn("{\\fs88}", events[0][3])

    # --- Three platform styles ---

    def test_new_platform_styles_in_dict(self):
        for style in self.NEW_STYLES:
            self.assertIn(style, muse_worker.CAPTION_STYLES)
        self.assertEqual(len(muse_worker.CAPTION_STYLES), 23)

    def test_new_platform_styles_render_distinct_ass(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            texts = {}
            for style in self.NEW_STYLES:
                segments = [self._manual_segment(
                    0.0, 5.0, [(0.5, 0.9, "hello"), (1.0, 1.4, "brave"),
                               (1.5, 1.9, "new"), (2.0, 2.4, "world")])]
                path = tmp / f"{style}.ass"
                self.assertTrue(muse_worker.write_clip_ass(
                    segments, 0.0, 5.0, style, path, 864, 1080, 1920, "split"))
                texts[style] = path.read_text()
            # Each style's file differs from the others.
            self.assertEqual(len(set(texts.values())), 3)
            # tiktok_bold: phrase-based, bigger (fs 104), pops the
            # whole phrase in, keyword in yellow.
            self.assertIn("Style: TikTokBold,DejaVu Sans,104,", texts["tiktok_bold"])
            self.assertIn("\\fscx108\\fscy108\\t(0,120,\\fscx100\\fscy100)",
                          texts["tiktok_bold"])
            self.assertIn("\\1c&H00FFFF&", texts["tiktok_bold"])
            # reels_clean: smaller (fs 84), outline 2, soft shadow 1.
            self.assertIn("Style: ReelsClean,DejaVu Sans,84,", texts["reels_clean"])
            self.assertIn(",1,2,1,8,", texts["reels_clean"])
            # shorts_minimal: smallest (fs 72), outline 1, no shadow.
            self.assertIn("Style: ShortsMinimal,DejaVu Sans,72,", texts["shorts_minimal"])
            self.assertIn(",1,1,0,8,", texts["shorts_minimal"])

    def test_tiktok_bold_two_line_phrase_burns_through_real_ffmpeg(self):
        # The riskiest Batch 6 burn: a 2-line phrase event (with \N)
        # plus the pop transform must survive a real subtitles burn.
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            src = tmp / "src.mp4"
            cmd = [muse_worker.FFMPEG, "-y", "-v", "error",
                   "-f", "lavfi", "-i", "color=c=green:s=640x360:d=5:r=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                   "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                   "-shortest", str(src)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            words = [(0.5 + i * 0.4, 0.85 + i * 0.4, w) for i, w in
                     enumerate(["and", "we", "danced", "all", "night"])]
            segments = [self._manual_segment(0.0, 5.0, words)]
            settings = _settings(layout="center_crop", captions_enabled=True,
                                 caption_style="tiktok_bold",
                                 duration_mode="maximum", duration_seconds=5)
            out = tmp / "out.mp4"
            info = muse_worker.probe_summary(src)
            muse_worker.render_clip(src, {"start": 0.0, "end": 5.0},
                                    settings, segments, out, info, tmp)
            rendered = muse_worker.probe_summary(out)
            self.assertEqual((rendered["width"], rendered["height"]),
                             (1080, 1920))
            self.assertAlmostEqual(rendered["duration"], 5.0, delta=0.4)


class Batch7Tests(unittest.TestCase):
    """Batch 7 (2026-11-25): on-screen text for the whole clip —
    persistent headline, entrance animation, Follow end card, keyword
    pop-ups, lower-third tag, animated progress bar."""

    def _words_at(self, pairs):
        return [{"start": s, "end": e, "word": w} for s, e, w in pairs]

    def _manual_segment(self, start, end, pairs):
        words = self._words_at(pairs)
        return {"start": start, "end": end,
                "text": " ".join(w[2] for w in pairs), "words": words}

    @staticmethod
    def _ass_seconds(stamp: str) -> float:
        h, m, rest = stamp.split(":")
        s, cs = rest.split(".")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100

    def _dialogue_events(self, text: str):
        events = []
        for line in text.splitlines():
            m = re.match(
                r"Dialogue: 0,(\d+:\d\d:\d\d\.\d\d),"
                r"(\d+:\d\d:\d\d\.\d\d),(\w+),,0,0,0,,(.*)$", line)
            if m:
                events.append((self._ass_seconds(m.group(1)),
                               self._ass_seconds(m.group(2)),
                               m.group(3), m.group(4)))
        return events

    def _headline_ass(self, path, **kwargs):
        kwargs.setdefault("text", "WIN THE PS5 TODAY")
        kwargs.setdefault("duration", 20.0)
        self.assertTrue(muse_worker.write_headline_ass(
            kwargs.pop("text"), kwargs.pop("duration"), path,
            1080, 1920, **kwargs))
        return self._dialogue_events(path.read_text())

    # --- Persistent headline ---

    def test_persistent_headline_spans_full_clip(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "persistent.ass"
            events = self._headline_ass(path, persistent=True)
            headline = [e for e in events if e[2] == "Headline"]
            self.assertEqual(len(headline), 1)
            self.assertEqual((headline[0][0], headline[0][1]), (0.0, 20.0))

    def test_headline_still_4s_when_not_persistent(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "short.ass"
            events = self._headline_ass(path)
            headline = [e for e in events if e[2] == "Headline"]
            self.assertEqual((headline[0][0], headline[0][1]), (0.0, 4.0))

    # --- Entrance animation ---

    def test_animation_tags_present_only_when_set(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            path = tmp / "slide.ass"
            self._headline_ass(path, animation="slide")
            self.assertIn("\\move(540,30,540,120,0,300)",
                          path.read_text())
            path = tmp / "fade.ass"
            self._headline_ass(path, animation="fade")
            self.assertIn("\\fad(300,0)", path.read_text())
            path = tmp / "pop.ass"
            self._headline_ass(path, animation="pop")
            self.assertIn("\\fscx60\\fscy60\\t(0,150,\\fscx100\\fscy100)",
                          path.read_text())
            path = tmp / "none.ass"
            self._headline_ass(path, animation="none")
            text = path.read_text()
            self.assertNotIn("\\move(", text)
            self.assertNotIn("\\fad(", text)
            self.assertNotIn("\\fscx60", text)
            # Unknown animation falls back to none.
            path = tmp / "bad.ass"
            self._headline_ass(path, animation="spin")
            self.assertNotIn("\\move(", path.read_text())

    # --- End card ---

    def test_end_card_last_two_seconds_replaces_headline(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "endcard.ass"
            events = self._headline_ass(
                path, persistent=True, end_card_text="Follow for more")
            headline = [e for e in events if e[2] == "Headline"]
            card = [e for e in events if e[2] == "EndCard"]
            self.assertEqual((headline[0][0], headline[0][1]), (0.0, 18.0))
            self.assertEqual((card[0][0], card[0][1]), (18.0, 20.0))
            self.assertIn("Follow for more", card[0][3])
            # Non-persistent headline still ends before the card.
            path = Path(d) / "endcard2.ass"
            events = self._headline_ass(path, end_card_text="Follow for more")
            headline = [e for e in events if e[2] == "Headline"]
            card = [e for e in events if e[2] == "EndCard"]
            self.assertEqual((headline[0][0], headline[0][1]), (0.0, 4.0))
            self.assertEqual((card[0][0], card[0][1]), (18.0, 20.0))

    def test_end_card_without_headline(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cardonly.ass"
            self.assertTrue(muse_worker.write_headline_ass(
                None, 20.0, path, 1080, 1920,
                end_card_text="Follow for more"))
            events = self._dialogue_events(path.read_text())
            self.assertEqual([e[2] for e in events], ["EndCard"])
            self.assertEqual((events[0][0], events[0][1]), (18.0, 20.0))

    def test_no_ost_returns_false(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "empty.ass"
            self.assertFalse(muse_worker.write_headline_ass(
                None, 20.0, path, 1080, 1920))
            self.assertFalse(muse_worker.write_headline_ass(
                "", 20.0, path, 1080, 1920))

    # --- Keyword pop-ups ---

    def _popup_segments(self):
        # tower x3, climb x2, insane/guys/view x1 — spaced so none
        # overlap after the 1s rule.
        return [self._manual_segment(0.0, 20.0, [
            (1.0, 1.5, "tower"), (2.0, 2.5, "climb"),
            (5.0, 5.5, "tower"), (6.0, 6.5, "insane"),
            (9.0, 9.5, "tower"), (12.0, 12.5, "climb"),
            (15.0, 15.5, "guys"), (16.0, 16.5, "view")])]

    def test_keyword_popups_at_spoken_timestamps(self):
        popups = muse_worker.derive_keyword_popups(
            self._popup_segments(), 0.0, 20.0)
        self.assertEqual([p["word"] for p in popups],
                         ["TOWER", "CLIMB", "INSANE", "GUYS"])
        self.assertEqual([p["start"] for p in popups],
                         [1.0, 2.0, 6.0, 15.0])
        for p in popups:
            self.assertAlmostEqual(p["end"] - p["start"], 1.0)

    def test_keyword_popups_never_overlap(self):
        # climb's first mention is 0.5s after tower's — keep tower only.
        segs = [self._manual_segment(0.0, 20.0, [
            (1.0, 1.5, "tower"), (1.5, 2.0, "climb"),
            (5.0, 5.5, "tower"), (9.0, 9.5, "tower"),
            (12.0, 12.5, "climb")])]
        popups = muse_worker.derive_keyword_popups(segs, 0.0, 20.0)
        self.assertEqual([p["word"] for p in popups], ["TOWER"])

    def test_keyword_popups_max_four(self):
        pairs = []
        for i, word in enumerate(
                ["tower", "climb", "insane", "guys", "view", "mission"]):
            pairs.append((float(i * 2), float(i * 2 + 0.5), word))
            pairs.append((float(i * 2 + 10), float(i * 2 + 10.5), word))
        segs = [self._manual_segment(0.0, 20.0, pairs)]
        self.assertLessEqual(
            len(muse_worker.derive_keyword_popups(segs, 0.0, 20.0)), 4)

    def test_keyword_popups_silent_clip(self):
        self.assertEqual(muse_worker.derive_keyword_popups([], 0.0, 20.0), [])
        self.assertEqual(
            muse_worker.derive_keyword_popups(
                [_segment(0.0, 20.0, "um uh hmm")], 0.0, 20.0), [])

    def test_keyword_popups_burned_into_ass(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "popups.ass"
            popups = muse_worker.derive_keyword_popups(
                self._popup_segments(), 0.0, 20.0)
            self.assertTrue(muse_worker.write_headline_ass(
                "WIN THE PS5 TODAY", 20.0, path, 1080, 1920,
                keyword_popups=popups))
            events = self._dialogue_events(path.read_text())
            pops = [e for e in events if e[2] == "KeywordPop"]
            self.assertEqual(len(pops), 4)
            self.assertEqual((pops[0][0], pops[0][1]), (1.0, 2.0))
            self.assertIn("TOWER", pops[0][3])
            # Pop entrance on every pop-up.
            self.assertIn("\\fscx60\\fscy60", pops[0][3])

    # --- Lower-third tag ---

    def test_lower_third_only_when_text_set(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "tag.ass"
            self.assertTrue(muse_worker.write_headline_ass(
                None, 20.0, path, 1080, 1920,
                lower_third_text="@magicianclips"))
            events = self._dialogue_events(path.read_text())
            tags = [e for e in events if e[2] == "LowerThirdTag"]
            self.assertEqual(len(tags), 1)
            self.assertEqual((tags[0][0], tags[0][1]), (0.0, 20.0))
            self.assertIn("@magicianclips", tags[0][3])
            # No text, no tag — and no headline either means False.
            path = Path(d) / "notag.ass"
            self.assertFalse(muse_worker.write_headline_ass(
                None, 20.0, path, 1080, 1920, lower_third_text=""))
            # The tag style sits above the bottom captions (MarginV 260).
            self.assertIn(",2,40,40,260,1", (Path(d) / "tag.ass").read_text())

    # --- Progress bar ---

    def test_progress_bar_source(self):
        src = muse_worker._progress_bar_source(1080, 20.0)
        self.assertIn("color=c=0x8b5cf6:s=1080x8", src)
        self.assertIn("geq=r=139:g=92:b=246", src)
        self.assertIn("a='if(lt(X,1080*T/20.000),255,0)'", src)
        self.assertTrue(src.endswith("[bar]"))
        # Other widths/durations are honoured.
        src = muse_worker._progress_bar_source(720, 30.0)
        self.assertIn("s=720x8", src)
        self.assertIn("720*T/30.000", src)

    # --- Card backgrounds (drawbox, not ASS BorderStyle 3) ---

    def test_text_box_filter_geometry(self):
        # "Follow for more" at fs 96, centred vertically on a 1920
        # frame: a filled 80%-black box, centred horizontally, with
        # the enable timeline only when asked.
        s = muse_worker._text_box_filter(
            1080, "Follow for more", 96, 960,
            enable="between(t,18.000,20.000)")
        self.assertIn("color=black@0.8:t=fill", s)
        self.assertIn("enable='between(t,18.000,20.000)'", s)
        m = re.match(
            r"drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+):", s)
        self.assertIsNotNone(m)
        x, y, w, h = (int(v) for v in m.groups())
        # Centred within 1px (integer division on an odd box width).
        self.assertAlmostEqual(x + w / 2, 540, delta=1)
        self.assertAlmostEqual(y + h / 2, 960, delta=1)
        self.assertLess(w, 1080)
        # No enable asked: no enable clause at all.
        s2 = muse_worker._text_box_filter(1080, "@magicianclips", 40, 1636,
                                          pad_x=30, pad_y=16)
        self.assertNotIn("enable=", s2)
        self.assertIn("color=black@0.8:t=fill", s2)

    def test_end_card_and_tag_styles_use_outline_not_opaque_box(self):
        # This libass build does not render BorderStyle 3 opaque
        # boxes (verified 2026-11-25: text rendered, box did not), so
        # the card/band background is a drawbox and the ASS styles
        # carry an outline only (BorderStyle 1, Outline 2).
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "card.ass"
            self.assertTrue(muse_worker.write_headline_ass(
                None, 20.0, path, 1080, 1920,
                end_card_text="Follow for more",
                lower_third_text="@magicianclips"))
            text = path.read_text()
            self.assertIn("Style: EndCard,DejaVu Sans,96,", text)
            self.assertIn(",1,2,0,5,40,40,0,1", text)
            self.assertNotIn(",3,0,0,5,40,40,0,1", text)
            self.assertIn("Style: LowerThirdTag,DejaVu Sans,40,", text)
            self.assertIn(",1,2,0,2,40,40,260,1", text)

    # --- Job note ---

    def test_ready_note_batch7_lines(self):
        stats = {"ost_persistent": True, "end_card": True,
                 "keyword_popups": 3, "keyword_popups_on": True,
                 "lower_third": True, "progress_bar": True}
        note = muse_worker._ready_note(
            [{"signals": []}], 1, [],
            rendered=[{"_batch1_stats": stats}])
        self.assertIn("On-screen headline shown for the full clip.", note)
        self.assertIn("Follow end card shown in the last 2 seconds.", note)
        self.assertIn("3 keyword pop-up(s) shown.", note)
        self.assertIn("Lower-third tag shown for the full clip.", note)
        self.assertIn("Progress bar shown.", note)
        # Pop-ups on but silent: the honest line, not a count.
        stats = {"ost_persistent": False, "end_card": False,
                 "keyword_popups": 0, "keyword_popups_on": True,
                 "lower_third": False, "progress_bar": False}
        note = muse_worker._ready_note(
            [{"signals": []}], 1, [],
            rendered=[{"_batch1_stats": stats}])
        self.assertIn("Keyword pop-ups on, but no words to pop up", note)
        self.assertNotIn("keyword pop-up(s) shown", note)
        # Everything off: no Batch 7 lines at all.
        note = muse_worker._ready_note(
            [{"signals": []}], 1, [],
            rendered=[{"_batch1_stats": {}}])
        self.assertIsNone(note)


if __name__ == "__main__":
    unittest.main()
