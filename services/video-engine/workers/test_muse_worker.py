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


class FakeApi:
    """Minimal stand-in for JobApi: records status changes + uploads."""

    def __init__(self, job):
        self.job = job
        self.statuses = []
        self.uploads = []

    def get_job(self, job_id):
        return dict(self.job)

    def set_status(self, job_id, status, error_reason=None, stage=None,
                   progress=None, note=None):
        self.statuses.append({"status": status, "note": note, "stage": stage})
        return {"id": job_id, "status": status}

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


if __name__ == "__main__":
    unittest.main()
