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


if __name__ == "__main__":
    unittest.main()
