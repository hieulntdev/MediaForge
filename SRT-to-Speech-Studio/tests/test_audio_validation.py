from __future__ import annotations

import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.audio_validation import (
    DurationValidationError,
    SpeechBoundary,
    detect_speech_boundary,
    trim_silence,
    wav_duration_seconds,
    evaluate_timing,
    match_wav_duration,
    TimeStretchError,
    time_stretch,  # noqa: E402
)

RATE = 24_000


def silent_wav(path: Path, seconds: float) -> Path:
    frames = max(1, int(round(seconds * RATE)))
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(b"\x00\x00" * frames)
    return path


def tone_wav(path: Path, seconds: float, amplitude: float = 0.2, freq: float = 220.0) -> Path:
    """A audible (well above -40 dBFS) sine tone, used as a stand-in for real speech."""
    import math

    frames = max(1, int(round(seconds * RATE)))
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * freq * (i / RATE)))
        for i in range(frames)
    ]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack(f"<{frames}h", *samples))
    return path


def padded_tone_wav(
    path: Path, speech_seconds: float, lead_silence: float = 0.3, trail_silence: float = 0.4,
) -> Path:
    """Silence, then an audible tone, then silence — for boundary-detection tests."""
    import math

    lead_frames = int(round(lead_silence * RATE))
    speech_frames = max(1, int(round(speech_seconds * RATE)))
    trail_frames = int(round(trail_silence * RATE))
    samples = [0] * lead_frames
    samples += [
        int(0.2 * 32767 * math.sin(2 * math.pi * 220.0 * (i / RATE)))
        for i in range(speech_frames)
    ]
    samples += [0] * trail_frames
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


class WavDurationTests(unittest.TestCase):
    def test_duration_matches_frame_count(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = tone_wav(Path(folder) / "a.wav", 2.0)
            self.assertAlmostEqual(wav_duration_seconds(path), 2.0, places=2)

    def test_unreadable_file_raises(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "broken.wav"
            path.write_bytes(b"not a wav")
            with self.assertRaises(DurationValidationError):
                wav_duration_seconds(path)

    def test_zero_frame_file_raises(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "empty.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(RATE)
                wav.writeframes(b"")
            with self.assertRaises(DurationValidationError):
                wav_duration_seconds(path)


class SpeechBoundaryTests(unittest.TestCase):
    def test_entirely_silent_audio_has_no_speech(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = silent_wav(Path(folder) / "silence.wav", 1.0)
            boundary = detect_speech_boundary(path)
            self.assertFalse(boundary.has_speech)

    def test_pure_tone_is_speech_from_start_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = tone_wav(Path(folder) / "tone.wav", 1.0)
            boundary = detect_speech_boundary(path)
            self.assertTrue(boundary.has_speech)
            self.assertAlmostEqual(boundary.start, 0.0, delta=0.03)
            self.assertAlmostEqual(boundary.end, 1.0, delta=0.03)

    def test_padded_tone_finds_the_inner_speech_span(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = padded_tone_wav(Path(folder) / "padded.wav", speech_seconds=1.0,
                                    lead_silence=0.3, trail_silence=0.4)
            boundary = detect_speech_boundary(path)
            self.assertTrue(boundary.has_speech)
            self.assertAlmostEqual(boundary.start, 0.3, delta=0.03)
            self.assertAlmostEqual(boundary.end, 1.3, delta=0.03)


class TrimSilenceTests(unittest.TestCase):
    def test_trim_keeps_padding_around_speech(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = padded_tone_wav(Path(folder) / "padded.wav", speech_seconds=1.0,
                                   lead_silence=0.3, trail_silence=0.4)
            boundary = detect_speech_boundary(src)
            dst = Path(folder) / "trimmed.wav"
            trim_silence(src, dst, boundary, pad_lead=0.05, pad_trail=0.10)
            trimmed_duration = wav_duration_seconds(dst)
            # speech span (1.0s) + 0.05s lead pad + 0.10s trail pad
            self.assertAlmostEqual(trimmed_duration, 1.15, delta=0.03)


class EvaluateTimingTests(unittest.TestCase):
    def test_audio_shorter_than_slot_is_timing_ok(self) -> None:
        check = evaluate_timing(speech_duration=2.5, slot_start=0.0, slot_end=3.0)
        self.assertEqual(check.status, "TIMING_OK")
        self.assertAlmostEqual(check.target_duration, 3.0, places=6)

    def test_ten_ms_overrun_is_inside_tolerance(self) -> None:
        check = evaluate_timing(speech_duration=3.01, slot_start=0.0, slot_end=3.0)
        self.assertEqual(check.status, "TIMING_OK")

    def test_moderate_overflow_is_speed_adjust(self) -> None:
        check = evaluate_timing(speech_duration=3.6, slot_start=0.0, slot_end=3.0)
        self.assertEqual(check.status, "SPEED_ADJUST")
        self.assertAlmostEqual(check.required_speed, 1.2, places=2)

    def test_ratio_uses_target_not_target_plus_tolerance(self) -> None:
        check = evaluate_timing(speech_duration=4.2, slot_start=10.0, slot_end=13.0)
        self.assertEqual(check.status, "TIMING_WARNING")
        self.assertAlmostEqual(check.required_speed, 1.4, places=6)

    def test_extreme_overflow_is_timing_warning(self) -> None:
        check = evaluate_timing(speech_duration=10.0, slot_start=0.0, slot_end=1.0)
        self.assertEqual(check.status, "TIMING_WARNING")
        self.assertGreater(check.required_speed, 1.25)

    def test_zero_length_subtitle_is_rejected(self) -> None:
        with self.assertRaises(DurationValidationError):
            evaluate_timing(speech_duration=1.0, slot_start=2.0, slot_end=2.0)

    def test_duration_match_reports_the_final_factor_passed_to_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder) / "src.wav"
            dst = Path(folder) / "dst.wav"
            durations = iter((4.2, 3.1, 3.0, 3.0))
            applied: list[float] = []

            with (
                mock.patch("studio.audio_validation.wav_duration_seconds", side_effect=lambda _path: next(durations)),
                mock.patch("studio.audio_validation.time_stretch", side_effect=lambda _src, _dst, speed: applied.append(speed)),
                mock.patch("studio.audio_validation._align_pcm_frames", return_value=3.0),
            ):
                result = match_wav_duration(src, dst, 3.0)

            self.assertEqual(len(applied), 2)
            self.assertAlmostEqual(result.speed_ratio, applied[-1])
            self.assertGreater(result.speed_ratio, 1.4)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for time_stretch")
class TimeStretchTests(unittest.TestCase):
    def test_stretch_shortens_the_clip_by_the_requested_speed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 2.0)
            dst = Path(folder) / "dst.wav"
            time_stretch(src, dst, speed=1.25)
            self.assertAlmostEqual(wav_duration_seconds(dst), 2.0 / 1.25, delta=0.05)

    def test_large_speed_is_chained_instead_of_clamped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 4.0)
            dst = Path(folder) / "dst.wav"
            time_stretch(src, dst, speed=4.0)
            self.assertAlmostEqual(wav_duration_seconds(dst), 1.0, delta=0.08)

    def test_missing_source_raises_time_stretch_error(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder) / "missing.wav"
            dst = Path(folder) / "dst.wav"
            with self.assertRaises(TimeStretchError):
                time_stretch(src, dst, speed=1.1)

    def test_missing_ffmpeg_has_an_actionable_error(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 1.0)
            dst = Path(folder) / "dst.wav"
            with mock.patch("studio.audio_validation.subprocess.run", side_effect=FileNotFoundError):
                with self.assertRaisesRegex(TimeStretchError, "brew install ffmpeg"):
                    time_stretch(src, dst, speed=1.1)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for duration matching")
class DurationMatchingTests(unittest.TestCase):
    def test_4_2_seconds_is_stretched_to_3_seconds(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 4.2)
            dst = Path(folder) / "dst.wav"
            result = match_wav_duration(src, dst, 3.0)
            self.assertEqual(result.action, "stretched")
            self.assertAlmostEqual(result.speed_ratio, 1.4, places=5)
            self.assertEqual(wav_duration_seconds(dst), 3.0)
            samples, rate = __import__("soundfile").read(str(dst))
            spectrum = __import__("numpy").abs(__import__("numpy").fft.rfft(samples))
            peak_hz = int(spectrum.argmax() * rate / len(samples))
            self.assertAlmostEqual(peak_hz, 220, delta=3, msg="atempo must preserve pitch")

    def test_short_audio_is_padded_without_slowing_speech(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 2.5)
            dst = Path(folder) / "dst.wav"
            result = match_wav_duration(src, dst, 3.0)
            self.assertEqual(result.action, "padded")
            self.assertEqual(result.speed_ratio, 1.0)
            self.assertEqual(wav_duration_seconds(dst), 3.0)
            samples, _rate = __import__("soundfile").read(str(dst))
            self.assertTrue((samples[-1000:] == 0).all())

    def test_ten_ms_overrun_is_sample_aligned_without_atempo(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 3.01)
            dst = Path(folder) / "dst.wav"
            result = match_wav_duration(src, dst, 3.0)
            self.assertEqual(result.action, "aligned")
            self.assertEqual(wav_duration_seconds(dst), 3.0)

    def test_1_6x_emits_warning_but_is_still_corrected(self) -> None:
        check = evaluate_timing(4.8, 0.0, 3.0)
        self.assertEqual(check.status, "TIMING_WARNING")
        self.assertEqual(check.quality, "severe")
        with tempfile.TemporaryDirectory() as folder:
            src = tone_wav(Path(folder) / "src.wav", 4.8)
            dst = Path(folder) / "dst.wav"
            match_wav_duration(src, dst, 3.0)
            self.assertEqual(wav_duration_seconds(dst), 3.0)


if __name__ == "__main__":
    unittest.main()
