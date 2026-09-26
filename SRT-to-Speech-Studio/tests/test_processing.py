"""Duration validation, auto retry, fail-stop, manual retry and concurrency."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import wave
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio import pipeline as tool  # noqa: E402

from studio.srt_parser import Subtitle, SubtitleParseError  # noqa: E402
from studio.pipeline import (  # noqa: E402
    DEFAULT_PROCESSOR_COUNT,
    MAX_GENERATION_ATTEMPTS,
    DurationValidationError,
    GenerationFailed,
    _parser as parser,
    generate_segment,
    regenerate_segment,
    run,
    validate_processor_count,
    wav_duration_seconds,
)
from studio.zsp import validate_zsp  # noqa: E402


def wav_bytes(seconds: float, silent: bool = False) -> bytes:
    """PCM WAV of the given duration. Audible by default (a low-amplitude
    tone) so speech-boundary detection treats it as real speech; pass
    ``silent=True`` for tests that specifically want EMPTY_AUDIO behaviour.
    """
    import math
    import struct

    frames = max(1, int(round(seconds * 24_000)))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        if silent:
            wav.writeframes(b"\0\0" * frames)
        else:
            samples = [
                int(0.2 * 32767 * math.sin(2 * math.pi * 220.0 * (i / 24_000)))
                for i in range(frames)
            ]
            wav.writeframes(struct.pack(f"<{frames}h", *samples))
    return output.getvalue()


def write_wav(path: Path, seconds: float) -> Path:
    path.write_bytes(wav_bytes(seconds))
    return path


def write_srt(path: Path, lines: list[tuple[str, int, int]]) -> Path:
    blocks = [
        f"{index}\n00:00:{start:02d},000 --> 00:00:{end:02d},000\n{text}"
        for index, (text, start, end) in enumerate(lines, 1)
    ]
    path.write_text("\n\n".join(blocks), encoding="utf-8")
    return path


class PlannedEngine:
    """Test engine returning a scripted duration for each subtitle text."""

    def __init__(self, plan: dict[str, list[float]] | None = None, default: float = 0.5) -> None:
        self.plan = {text: list(values) for text, values in (plan or {}).items()}
        self.default = default
        self.calls: list[str] = []
        self.lock = threading.Lock()
        self.loaded = False
        self.closed = False
        self.loads = 0
        self.voices = 0

    def load_model(self) -> None:
        self.loads += 1
        self.loaded = True

    def clone_voice(self, reference_audio: Path) -> dict[str, Path]:
        self.voices += 1
        return {"reference": reference_audio}

    def synthesize(self, text: str, voice: object) -> bytes:
        with self.lock:
            self.calls.append(text)
            queue = self.plan.get(text)
            if not queue:
                return wav_bytes(self.default)
            value = queue.pop(0) if len(queue) > 1 else queue[0]
        return wav_bytes(value)

    def close(self) -> None:
        self.closed = True


class FakeASREngine:
    """Content check is deterministic and offline: everything passes.

    Echoes back the exact subtitle text for each line, keyed by the SRT
    index recovered from the ``line_{index}_...`` filename pipeline.py writes,
    so the real content-comparison logic in asr.compare genuinely matches
    instead of relying on content-retry being inert. These tests are not
    about ASR content validation itself -- they cover concurrency, retry
    counts and CLI plumbing -- so the content check must be a reliable
    pass-through, not a coincidental one.
    """

    def __init__(self, content_by_index: dict[int, str] | None = None) -> None:
        self.content_by_index = dict(content_by_index or {})

    def load_model(self) -> None:
        pass

    def transcribe(self, wav_path) -> str:
        name = Path(wav_path).name
        parts = name.split("_")
        if len(parts) >= 2 and parts[1].isdigit():
            index = int(parts[1])
            if index in self.content_by_index:
                return self.content_by_index[index]
        return "PASS"

    def close(self) -> None:
        pass


class ConcurrencyProbe(PlannedEngine):
    """Records the highest number of simultaneous synthesis calls."""

    def __init__(self, duration: float = 0.5, delay: float = 0.03) -> None:
        super().__init__(default=duration)
        self.delay = delay
        self.active = 0
        self.peak = 0

    def synthesize(self, text: str, voice: object) -> bytes:
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(self.delay)
            return wav_bytes(self.default)
        finally:
            with self.lock:
                self.active -= 1


class Project:
    """Temporary project folder with an SRT, a voice file and an output path."""

    def __init__(self, folder: str, lines: list[tuple[str, int, int]]) -> None:
        self.root = Path(folder)
        self.srt = write_srt(self.root / "sample.srt", lines)
        self.voice = self.root / "voice.mp3"
        self.voice.write_bytes(b"fake reference")
        self.output = self.root / "sample.zsp"
        self.state = self.root / "sample.zsp.retry"
        self.content_by_index = {
            index: text for index, (text, _start, _end) in enumerate(lines, 1)
        }

    def run(self, engine: object, **kwargs: object) -> Path:
        kwargs.setdefault("asr_engine", FakeASREngine(self.content_by_index))
        return run(
            self.root, engine,
            subtitle_path=self.srt, reference_path=self.voice,
            destination=self.output, state_dir=kwargs.pop("state_dir", self.state),
            **kwargs,
        )


def events_of(events: list[tuple[str, dict]], kind: str) -> list[dict]:
    return [payload for name, payload in events if name == kind]


class ProcessorCountTests(unittest.TestCase):
    def test_missing_setting_uses_the_default(self) -> None:
        self.assertEqual(validate_processor_count(None), (DEFAULT_PROCESSOR_COUNT, None))
        self.assertEqual(DEFAULT_PROCESSOR_COUNT, 4)

    def test_user_selection_is_honoured(self) -> None:
        for value in (1, 2, 3, 4, 5, 6, 12):
            with self.subTest(value=value):
                self.assertEqual(validate_processor_count(value), (value, None))

    def test_the_cli_form_of_the_selection_is_honoured(self) -> None:
        # main.js forwards the selector value as a command-line string.
        for text, expected in (("2", 2), ("4", 4), ("5", 5), ("6", 6), (" 6 ", 6)):
            with self.subTest(text=text):
                self.assertEqual(validate_processor_count(text), (expected, None))

    def test_invalid_settings_fall_back_with_a_message(self) -> None:
        for value in (0, -1, -8, "abc", "", None if False else float("nan"), float("inf")):
            with self.subTest(value=value):
                count, problem = validate_processor_count(value)
                self.assertEqual(count, DEFAULT_PROCESSOR_COUNT)
                self.assertIsNotNone(problem)


class ConcurrencyTests(unittest.TestCase):
    def test_default_concurrency_is_four(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine)
            self.assertEqual(engine.peak, 4)

    def test_selected_five_runs_five_in_parallel(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine, max_workers=5)
            self.assertEqual(engine.peak, 5)

    def test_selected_six_runs_six_in_parallel(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine, max_workers=6)
            self.assertEqual(engine.peak, 6)

    def test_lower_selection_is_not_raised_to_the_default(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine, max_workers=2)
            self.assertEqual(engine.peak, 2)

    def test_started_event_reports_the_selected_processor_count(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(3)])
            events: list[tuple[str, dict]] = []
            project.run(
                ConcurrencyProbe(),
                max_workers=6,
                event_callback=lambda kind, payload: events.append((kind, payload)),
            )
            started = events_of(events, "started")[0]
            self.assertEqual(started["processors"], 6)
            self.assertEqual(started["workers"], 3)

    def test_cli_style_selection_reaches_the_worker_pool(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine, max_workers="5")
            self.assertEqual(engine.peak, 5)

    def test_the_parser_defers_the_workers_value_to_validation(self) -> None:
        # argparse must not abort on a bad count; the pipeline reports it instead.
        for text in ("abc", "0", "-3", "4.5"):
            with self.subTest(text=text):
                self.assertEqual(parser().parse_args(["--workers", text]).workers, text)
        self.assertEqual(parser().parse_args(["--workers", "6"]).workers, "6")

    def test_invalid_setting_does_not_crash_the_run(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            events: list[tuple[str, dict]] = []
            project.run(
                ConcurrencyProbe(),
                max_workers="not-a-number",
                event_callback=lambda kind, payload: events.append((kind, payload)),
            )
            validate_zsp(tool.package_build(project.state, project.output))
            messages = [payload["message"] for payload in events_of(events, "log")]
            self.assertTrue(any("falling back to 4" in message for message in messages))

    def test_every_worker_shares_one_model_instance(self) -> None:  # PHASE 2.6
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [(f"line {i}", i, i + 1) for i in range(12)])
            engine = ConcurrencyProbe()
            project.run(engine, max_workers=6)
            self.assertEqual(engine.peak, 6)
            self.assertEqual(engine.loads, 1, "one model, not one per processor")
            self.assertEqual(engine.voices, 1, "the voice is cloned once per run")

    def test_retry_stays_inside_the_worker_slot(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            lines = [(f"line {i}", i, i + 1) for i in range(6)]
            project = Project(folder, lines)

            class CrashingConcurrencyProbe(ConcurrencyProbe):
                """Every call fails outright (hard failure); still tracked for concurrency."""

                def synthesize(self, text: str, voice: object) -> bytes:
                    with self.lock:
                        self.active += 1
                        self.peak = max(self.peak, self.active)
                    try:
                        time.sleep(self.delay)
                        raise RuntimeError("model exploded")
                    finally:
                        with self.lock:
                            self.active -= 1

            engine = CrashingConcurrencyProbe()
            with self.assertRaises(GenerationFailed):
                project.run(engine, max_workers=2)
            self.assertLessEqual(engine.peak, 2)
            self.assertGreater(engine.peak, 0)


class AutoRetryTests(unittest.TestCase):
    def test_one_failed_line_does_not_stop_the_others(self) -> None:  # TEST 7
        class AlwaysCorrupt(PlannedEngine):
            def synthesize(self, text: str, voice: object) -> bytes:
                with self.lock:
                    self.calls.append(text)
                if text == "bad":
                    return b"not a wav"
                return wav_bytes(self.default)

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("bad", 0, 1), ("two", 1, 2), ("three", 2, 3)])
            events: list[tuple[str, dict]] = []
            engine = AlwaysCorrupt()
            with self.assertRaises(GenerationFailed):
                project.run(
                    engine, max_workers=1,
                    event_callback=lambda kind, payload: events.append((kind, payload)),
                )
            # "bad" exhausts its own retries; "two" and "three" still run.
            self.assertEqual(engine.calls.count("bad"), MAX_GENERATION_ATTEMPTS)
            results = events_of(events, "segment_result")
            failed = [item for item in results if item["status"] == "fail"]
            succeeded = [item for item in results if item["status"] == "success"]
            self.assertEqual(len(failed), 1)
            self.assertEqual(failed[-1]["attempts"], MAX_GENERATION_ATTEMPTS)
            self.assertEqual(failed[-1]["reason"], "generation")
            self.assertEqual([item["index"] for item in succeeded], [2, 3])
            self.assertEqual(events_of(events, "stopped"), [])
            self.assertEqual(events_of(events, "segment_skipped"), [])
            self.assertFalse(project.output.exists())

    def test_final_failure_with_parallel_workers_is_consistent(self) -> None:  # TEST 19
        class OneBadLine(PlannedEngine):
            def synthesize(self, text: str, voice: object) -> bytes:
                with self.lock:
                    self.calls.append(text)
                if text == "line 3":
                    return b"not a wav"
                return wav_bytes(self.default)

        with tempfile.TemporaryDirectory() as folder:
            lines = [(f"line {i}", i, i + 1) for i in range(8)]
            project = Project(folder, lines)
            events: list[tuple[str, dict]] = []
            engine = OneBadLine()
            with self.assertRaises(GenerationFailed):
                project.run(
                    engine, max_workers=4,
                    event_callback=lambda kind, payload: events.append((kind, payload)),
                )
            results = events_of(events, "segment_result")
            skipped = events_of(events, "segment_skipped")
            failed = [item for item in results if item["status"] == "fail"]
            self.assertEqual(len(failed), 1)
            self.assertEqual(failed[0]["index"], 4)
            self.assertEqual(skipped, [])
            self.assertEqual(len(results), len(lines))


class ManualRetryTests(unittest.TestCase):
    def test_manual_retry_promotes_a_failed_line(self) -> None:  # TEST 8
        class CorruptOnce(PlannedEngine):
            def synthesize(self, text: str, voice: object) -> bytes:
                with self.lock:
                    self.calls.append(text)
                if text == "two":
                    return b"not a wav"
                return wav_bytes(self.default)

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            with self.assertRaises(GenerationFailed):
                project.run(CorruptOnce(), max_workers=1)
            # "one" succeeded and is cached; "two" (position 1) is the failed line.
            events: list[tuple[str, dict]] = []
            result = regenerate_segment(
                project.root, PlannedEngine(default=0.5),
                subtitle_path=project.srt, reference_path=project.voice,
                position=1, state_dir=project.state,
                event_callback=lambda kind, payload: events.append((kind, payload)),
                asr_engine=FakeASREngine(project.content_by_index),
            )
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["attempts"], 1)
            started = events_of(events, "segment_started")[0]
            self.assertTrue(started["manual"])
            reported = events_of(events, "segment_result")[0]
            self.assertTrue(reported["manual"])
            self.assertEqual(reported["index"], 2)
            cached = {path.name for path in (project.state / "audio_cache").glob("*.wav")}
            self.assertIn(str(result["filename"]), cached)
            records = [
                json.loads(line)
                for line in (project.state / "entries.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertIn(1, [record["position"] for record in records])
            follow_up = PlannedEngine(default=0.5)
            project.run(follow_up)
            self.assertEqual(follow_up.calls, [])
            output = tool.package_build(project.state, project.output)
            validate_zsp(output)
            entries = json.loads(zipfile.ZipFile(output).read("project.json").decode("utf-8"))
            self.assertEqual(len(entries), 2)

    def test_manual_retry_of_an_overlong_line_still_succeeds(self) -> None:  # was TEST 9
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            events: list[tuple[str, dict]] = []
            result = regenerate_segment(
                project.root, PlannedEngine(default=8.0),
                subtitle_path=project.srt, reference_path=project.voice,
                position=0, state_dir=project.state,
                event_callback=lambda kind, payload: events.append((kind, payload)),
                asr_engine=FakeASREngine(project.content_by_index),
            )
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["attempts"], 1)
            payload = events_of(events, "segment_result")[0]
            self.assertEqual(payload["status"], "success")
            self.assertEqual(payload["timing_status"], "TIMING_WARNING")
            self.assertGreater(payload["speed"], 1.0)
            self.assertEqual(result["speed"], payload["speed"])
            journal = [
                json.loads(line)
                for line in (project.state / "entries.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(journal[-1]["entry"]["timing"]["speed"], payload["speed"])

    def test_repeated_manual_retry_never_reuses_a_filename(self) -> None:  # TEST 21
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            names = []
            for _ in range(2):
                result = regenerate_segment(
                    project.root, PlannedEngine(default=0.5),
                    subtitle_path=project.srt, reference_path=project.voice,
                    position=0, state_dir=project.state,
                    asr_engine=FakeASREngine(project.content_by_index),
                )
                names.append(result["filename"])
                time.sleep(0.002)
            self.assertEqual(len(set(names)), 2)
            # Only the newest take survives in the cache.
            cached = sorted(path.name for path in (project.state / "audio_cache").glob("*.wav"))
            self.assertEqual(cached, [names[-1]])

    def test_manual_retry_rejects_an_out_of_range_position(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            with self.assertRaises(IndexError):
                regenerate_segment(
                    project.root, PlannedEngine(), subtitle_path=project.srt,
                    reference_path=project.voice, position=9, state_dir=project.state,
                )

    def test_manual_retry_fails_when_content_does_not_match(self) -> None:
        class WrongTranscriptASR:
            def load_model(self) -> None:
                pass

            def transcribe(self, wav_path) -> str:
                return "hoàn toàn khác"

            def close(self) -> None:
                pass

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("một hai ba", 0, 5)])
            result = regenerate_segment(
                project.root, PlannedEngine(default=0.5),
                subtitle_path=project.srt, reference_path=project.voice,
                position=0, state_dir=project.state,
                asr_engine=WrongTranscriptASR(),
            )
            self.assertEqual(result["status"], "fail")
            self.assertEqual(result["content_status"], "CONTENT_WRONG")
            self.assertEqual(list((project.state / "audio_cache").glob("*.wav")), [])
            self.assertFalse((project.state / "entries.jsonl").exists())

    def test_manual_retry_handles_an_asr_exception_gracefully(self) -> None:
        class CrashingASR:
            def load_model(self) -> None:
                pass

            def transcribe(self, wav_path) -> str:
                raise RuntimeError("model crashed mid-transcription")

            def close(self) -> None:
                pass

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("một hai ba", 0, 5)])
            result = regenerate_segment(
                project.root, PlannedEngine(default=0.5),
                subtitle_path=project.srt, reference_path=project.voice,
                position=0, state_dir=project.state,
                asr_engine=CrashingASR(),
            )
            self.assertEqual(result["status"], "fail")
            self.assertEqual(result["content_status"], "CONTENT_WRONG")
            self.assertEqual(list((project.state / "audio_cache").glob("*.wav")), [])
            self.assertFalse((project.state / "entries.jsonl").exists())
            error_dir = project.state / "error_segments"
            self.assertEqual(len(list(error_dir.glob("*.wav"))), 1)


class PoisonASR:
    """Fails loudly if the pipeline ever calls it -- proof that
    ``validate_content=False`` truly skips ASR, not just its result."""

    def load_model(self) -> None:
        raise AssertionError("ASR must not be used when validate_content is False")

    def transcribe(self, wav_path) -> str:
        raise AssertionError("ASR must not be used when validate_content is False")

    def close(self) -> None:
        pass


class ValidateContentToggleTests(unittest.TestCase):
    def test_run_skips_asr_when_validate_content_is_false(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            events: list[tuple[str, dict]] = []
            project.run(
                PlannedEngine(default=0.5),
                asr_engine=PoisonASR(),
                validate_content=False,
                event_callback=lambda kind, payload: events.append((kind, payload)),
            )
            validate_zsp(tool.package_build(project.state, project.output))
            self.assertEqual(events_of(events, "segment_asr_result"), [])
            results = events_of(events, "segment_result")
            self.assertEqual(len(results), 2)
            for payload in results:
                self.assertEqual(payload["status"], "success")

    def test_regenerate_segment_skips_asr_when_validate_content_is_false(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("một hai ba", 0, 5)])
            result = regenerate_segment(
                project.root, PlannedEngine(default=0.5),
                subtitle_path=project.srt, reference_path=project.voice,
                position=0, state_dir=project.state,
                asr_engine=PoisonASR(),
                validate_content=False,
            )
            self.assertEqual(result["status"], "success")
            cached = {path.name for path in (project.state / "audio_cache").glob("*.wav")}
            self.assertIn(str(result["filename"]), cached)


class ResumeTests(unittest.TestCase):
    def test_resumed_audio_reports_the_persisted_applied_speed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            project.run(PlannedEngine(default=2.0), validate_content=False)

            events: list[tuple[str, dict]] = []
            follow_up = PlannedEngine(default=0.5)
            project.run(
                follow_up,
                validate_content=False,
                event_callback=lambda kind, payload: events.append((kind, payload)),
            )

            self.assertEqual(follow_up.calls, [])
            resumed = next(
                payload
                for payload in events_of(events, "segment_result")
                if payload.get("resumed") is True
            )
            self.assertAlmostEqual(resumed["speed"], 2.0, places=2)

    def test_cached_audio_that_is_silent_is_regenerated(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            audio_dir = project.state / "audio_cache"
            audio_dir.mkdir(parents=True)
            # A silent cached file (no audio field in the journal entry) must be
            # recomputed and rejected -- it has no speech at all.
            (audio_dir / "line_1_500.wav").write_bytes(wav_bytes(0.5, silent=True))
            (project.state / "entries.jsonl").write_text(
                json.dumps({
                    "position": 0,
                    "entry": {
                        "index": 1, "start": 0.0, "end": 1.0, "content": "one",
                        "speaker_name": "voice.mp3", "audio_filename": "line_1_500.wav",
                    },
                }) + "\n",
                encoding="utf-8",
            )
            engine = PlannedEngine(default=0.5)
            events: list[tuple[str, dict]] = []
            project.run(
                engine, event_callback=lambda kind, payload: events.append((kind, payload))
            )
            self.assertEqual(sorted(engine.calls), ["one", "two"])
            validate_zsp(tool.package_build(project.state, project.output))

    def test_cached_audio_that_overruns_its_timeline_is_kept_not_regenerated(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            audio_dir = project.state / "audio_cache"
            audio_dir.mkdir(parents=True)
            write_wav(audio_dir / "line_1_500.wav", 9.0)  # far longer than its cue, but real speech
            (project.state / "entries.jsonl").write_text(
                json.dumps({
                    "position": 0,
                    "entry": {
                        "index": 1, "start": 0.0, "end": 1.0, "content": "one",
                        "speaker_name": "voice.mp3", "audio_filename": "line_1_500.wav",
                    },
                }) + "\n",
                encoding="utf-8",
            )
            engine = PlannedEngine(default=0.5)
            events: list[tuple[str, dict]] = []
            project.run(
                engine, event_callback=lambda kind, payload: events.append((kind, payload))
            )
            # Duration alone is never disqualifying any more: "one" is reused.
            self.assertEqual(engine.calls, ["two"])

    def test_cached_audio_that_fits_is_reused_and_reported(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            audio_dir = project.state / "audio_cache"
            audio_dir.mkdir(parents=True)
            write_wav(audio_dir / "line_1_500.wav", 0.5)
            (project.state / "entries.jsonl").write_text(
                json.dumps({
                    "position": 0,
                    "entry": {
                        "index": 1, "start": 0.0, "end": 1.0, "content": "one",
                        "speaker_name": "voice.mp3", "audio_filename": "line_1_500.wav",
                    },
                }) + "\n",
                encoding="utf-8",
            )
            engine = PlannedEngine(default=0.5)
            events: list[tuple[str, dict]] = []
            project.run(engine, event_callback=lambda kind, payload: events.append((kind, payload)))
            self.assertEqual(engine.calls, ["two"])
            resumed = events_of(events, "segment_result")[0]
            self.assertTrue(resumed["resumed"])
            self.assertEqual(resumed["status"], "success")
            self.assertEqual(resumed["audio_filename"], "line_1_500.wav")


class DurationTimelineTests(unittest.TestCase):
    def test_gaps_and_source_overlaps_keep_their_original_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("placeholder", 0, 1)])
            project.srt.write_text(
                "1\n00:00:01,100 --> 00:00:02,100\none\n\n"
                "2\n00:00:02,600 --> 00:00:04,100\ntwo\n\n"
                "3\n00:00:03,900 --> 00:00:04,400\nthree",
                encoding="utf-8",
            )
            project.run(
                PlannedEngine(default=2.0),
                validate_content=False,
                max_workers=3,
            )
            records = [
                json.loads(line)
                for line in (project.state / "entries.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            latest = {int(record["position"]): record["entry"] for record in records}
            self.assertEqual(
                [(latest[i]["start"], latest[i]["end"]) for i in range(3)],
                [(1.1, 2.1), (2.6, 4.1), (3.9, 4.4)],
            )
            expected = [1.0, 1.5, 0.5]
            for position, duration in enumerate(expected):
                wav_path = project.state / "audio_cache" / latest[position]["audio_filename"]
                self.assertEqual(wav_duration_seconds(wav_path), duration)

    def test_zero_duration_srt_cue_is_rejected_before_synthesis(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "invalid.srt"
            path.write_text(
                "1\n00:00:01,000 --> 00:00:01,000\ninvalid", encoding="utf-8"
            )
            with self.assertRaises(SubtitleParseError) as caught:
                tool.parse_srt(path)
            self.assertIn("must end after", str(caught.exception))


class GenerationFailureTests(unittest.TestCase):
    def test_missing_and_corrupt_audio_are_logged_and_failed(self) -> None:
        class BrokenEngine(PlannedEngine):
            def synthesize(self, text: str, voice: object) -> bytes:
                if text == "corrupt":
                    return b"not a wav"
                raise RuntimeError("model exploded")

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("corrupt", 0, 1), ("explode", 1, 2)])
            events: list[tuple[str, dict]] = []
            with self.assertRaises(GenerationFailed):
                project.run(
                    BrokenEngine(),
                    event_callback=lambda kind, payload: events.append((kind, payload)),
                )
            failures = [payload for payload in events_of(events, "item_error")]
            self.assertEqual(len(failures), 2)
            reasons = " ".join(str(item["message"]) for item in failures)
            self.assertIn("WAVE", reasons)
            self.assertIn("model exploded", reasons)
            self.assertEqual(
                [item["reason"] for item in failures],
                ["generation", "generation"],
            )


class GenerateSegmentRetryTests(unittest.TestCase):
    """generate_segment retries on any failure, not just duration overflow."""

    def one_cue(self) -> Subtitle:
        return Subtitle(index=1, start=0.0, end=1.0, content="hello")

    def test_a_crashing_engine_is_retried_before_succeeding(self) -> None:
        calls: list[int] = []

        class FlakyEngine:
            def synthesize(self, text: str, voice: object) -> bytes:
                calls.append(1)
                if len(calls) < 3:
                    raise RuntimeError("model exploded")
                return wav_bytes(0.5)

        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            outcome = generate_segment(
                FlakyEngine(), None, audio_dir, self.one_cue(), "line_1.wav",
            )
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.attempts, 3)
        self.assertEqual(len(calls), 3)

    def test_a_permanently_crashing_engine_fails_after_max_attempts(self) -> None:
        class BrokenEngine:
            def __init__(self) -> None:
                self.calls = 0

            def synthesize(self, text: str, voice: object) -> bytes:
                self.calls += 1
                raise RuntimeError("model exploded")

        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            engine = BrokenEngine()
            outcome = generate_segment(engine, None, audio_dir, self.one_cue(), "line_1.wav")
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.attempts, MAX_GENERATION_ATTEMPTS)
        self.assertEqual(engine.calls, MAX_GENERATION_ATTEMPTS)
        self.assertIn("model exploded", outcome.error)


class ErrorArchiveTests(unittest.TestCase):
    """The last take of a segment that exhausts every retry is preserved."""

    def one_cue(self) -> Subtitle:
        return Subtitle(index=1, start=0.0, end=1.0, content="hello")

    def test_a_corrupt_wav_is_kept_and_logged_after_exhausting_retries(self) -> None:
        class AlwaysCorrupt:
            def synthesize(self, text: str, voice: object) -> bytes:
                return b"not a wav"

        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            error_dir = Path(folder) / "error_segments"
            outcome = generate_segment(
                AlwaysCorrupt(), None, audio_dir, self.one_cue(), "line_1.wav",
                error_dir=error_dir,
            )
            self.assertFalse(outcome.ok)
            self.assertEqual(outcome.attempts, MAX_GENERATION_ATTEMPTS)
            kept = error_dir / "line_1.wav"
            self.assertTrue(kept.is_file(), "the final rejected take must survive on disk")
            self.assertEqual(kept.read_bytes(), b"not a wav")
            log_text = (error_dir / "errors.log").read_text(encoding="utf-8")
            self.assertIn("line_1.wav", log_text)
            self.assertIn(f"attempts={MAX_GENERATION_ATTEMPTS}", log_text)
            # audio_cache itself must not be left holding the rejected take.
            self.assertEqual(list(audio_dir.glob("*.wav")), [])

    def test_an_overlong_wav_is_accepted_not_archived(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            error_dir = Path(folder) / "error_segments"
            engine = PlannedEngine({"hello": [8.0]})
            outcome = generate_segment(
                engine, None, audio_dir, self.one_cue(), "line_1.wav",
                error_dir=error_dir,
            )
            self.assertTrue(outcome.ok)
            self.assertEqual(outcome.timing.status, "TIMING_WARNING")
            self.assertFalse(error_dir.exists())
            self.assertTrue((audio_dir / "line_1.wav").is_file())

    def test_a_crash_before_any_bytes_are_written_leaves_nothing_to_keep(self) -> None:
        class NeverWrites:
            def synthesize(self, text: str, voice: object) -> bytes:
                raise RuntimeError("no model loaded")

        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            error_dir = Path(folder) / "error_segments"
            outcome = generate_segment(
                NeverWrites(), None, audio_dir, self.one_cue(), "line_1.wav",
                error_dir=error_dir,
            )
            self.assertFalse(outcome.ok)
            self.assertEqual(list(error_dir.glob("*.wav")), [])
            log_text = (error_dir / "errors.log").read_text(encoding="utf-8")
            self.assertIn("no model loaded", log_text)

    def test_without_an_error_dir_the_rejected_take_is_simply_deleted(self) -> None:
        class AlwaysCorrupt:
            def synthesize(self, text: str, voice: object) -> bytes:
                return b"not a wav"

        with tempfile.TemporaryDirectory() as folder:
            audio_dir = Path(folder) / "audio_cache"
            audio_dir.mkdir()
            outcome = generate_segment(
                AlwaysCorrupt(), None, audio_dir, self.one_cue(), "line_1.wav",
            )
        self.assertFalse(outcome.ok)
        self.assertEqual(list(Path(folder).rglob("*.wav")), [])

    def test_a_batch_run_collects_failures_into_one_error_folder(self) -> None:
        class AlwaysCorrupt(PlannedEngine):
            def synthesize(self, text: str, voice: object) -> bytes:
                self.calls.append(text)
                return b"not a wav"

        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("bad one", 0, 1), ("bad two", 1, 2)])
            with self.assertRaises(GenerationFailed):
                project.run(AlwaysCorrupt())
            error_dir = project.output.parent / "error_segments"
            kept = sorted(path.name for path in error_dir.glob("*.wav"))
            self.assertEqual(len(kept), 2)
            log_text = (error_dir / "errors.log").read_text(encoding="utf-8")
            self.assertEqual(log_text.count("\n"), 2)

    def test_manual_retry_corrects_severe_overrun_without_archiving(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            result = regenerate_segment(
                project.root, PlannedEngine(default=8.0),
                subtitle_path=project.srt, reference_path=project.voice,
                position=0, state_dir=project.state,
                validate_content=False,
            )
            error_dir = project.state / "error_segments"
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["timing_status"], "TIMING_WARNING")
            self.assertEqual(result["timing_quality"], "severe")
            self.assertEqual(result["final_duration"], 1.0)
            self.assertFalse(error_dir.exists())


class CliTests(unittest.TestCase):
    """The command line the Electron main process actually spawns."""

    def invoke(
        self, args: list[str], engine: object,
        content_by_index: dict[int, str] | None = None,
    ) -> tuple[int, list[dict]]:
        original = tool.TTSEngine
        original_asr = tool.WhisperASREngine
        tool.TTSEngine = lambda: engine  # type: ignore[assignment]
        # The CLI path (unlike Project.run()) never gets an injected
        # asr_engine, so run()/main() falls back to a real WhisperASREngine --
        # patch it the same way TTSEngine is patched, echoing back each
        # line's own subtitle text so the (now genuinely-enforced) content
        # check passes instead of exhausting content retries against a real
        # model transcribing a fake tone/silence wav.
        tool.WhisperASREngine = lambda **_kwargs: FakeASREngine(content_by_index)  # type: ignore[assignment]
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer):
                code = tool.main(args)
        finally:
            tool.TTSEngine = original  # type: ignore[assignment]
            tool.WhisperASREngine = original_asr  # type: ignore[assignment]
        prefix = "SRT_STUDIO_EVENT "
        events = [
            json.loads(line[len(prefix):])
            for line in buffer.getvalue().splitlines()
            if line.startswith(prefix)
        ]
        return code, events

    def test_a_batch_run_reports_the_selected_processor_count(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            code, events = self.invoke([
                "--subtitle", str(project.srt), "--voice", str(project.voice),
                "--output", str(project.output), "--state-dir", str(project.state),
                "--workers", "5", "--json-events",
            ], ConcurrencyProbe(), project.content_by_index)
            self.assertEqual(code, 0)
            started = events_of([(event["type"], event) for event in events], "started")[0]
            self.assertEqual(started["processors"], 5)
            self.assertEqual(started["workers"], 2, "never more workers than subtitles")
            self.assertEqual(started["total"], 2)
            self.assertEqual(events[-1]["type"], "complete")
            self.assertTrue(project.state.exists(), "run keeps audio for Play/Save Project")
            self.assertFalse(project.output.exists(), "packaging is an explicit Save Project action")
            validate_zsp(tool.package_build(project.state, project.output))

    def test_the_manual_retry_command_line_regenerates_one_line(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1), ("two", 1, 2)])
            code, events = self.invoke([
                "--regenerate", "--position", "1",
                "--subtitle", str(project.srt), "--voice", str(project.voice),
                "--state-dir", str(project.state), "--json-events",
            ], PlannedEngine(default=0.5), project.content_by_index)
            self.assertEqual(code, 0)
            result = events_of([(event["type"], event) for event in events], "segment_result")[0]
            self.assertEqual(result["status"], "success")
            self.assertTrue(result["manual"])
            self.assertEqual(result["index"], 2)

    def test_a_rejected_manual_retry_is_not_a_process_error(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            code, events = self.invoke([
                "--regenerate", "--position", "0",
                "--subtitle", str(project.srt), "--voice", str(project.voice),
                "--state-dir", str(project.state), "--json-events", "--validate-content",
            ], PlannedEngine(default=9.0))
            self.assertEqual(code, 0, "a rejected take is a normal outcome")
            result = events_of([(event["type"], event) for event in events], "segment_result")[0]
            self.assertEqual(result["status"], "fail")
            self.assertEqual(result["attempts"], 1)

    def test_validate_content_is_off_by_default_on_the_command_line(self) -> None:
        # Bypasses self.invoke(), which always stubs in a passing FakeASREngine --
        # this test needs an ASR engine that fails loudly if the CLI's default
        # (no --validate-content) ever touches it.
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            original_tts = tool.TTSEngine
            original_asr = tool.WhisperASREngine
            tool.TTSEngine = lambda: PlannedEngine(default=0.5)  # type: ignore[assignment]
            tool.WhisperASREngine = lambda **_kwargs: PoisonASR()  # type: ignore[assignment]
            buffer = io.StringIO()
            try:
                with contextlib.redirect_stdout(buffer):
                    code = tool.main([
                        "--subtitle", str(project.srt), "--voice", str(project.voice),
                        "--output", str(project.output), "--state-dir", str(project.state),
                        "--json-events",
                    ])
            finally:
                tool.TTSEngine = original_tts  # type: ignore[assignment]
                tool.WhisperASREngine = original_asr  # type: ignore[assignment]
            prefix = "SRT_STUDIO_EVENT "
            events = [
                json.loads(line[len(prefix):])
                for line in buffer.getvalue().splitlines()
                if line.startswith(prefix)
            ]
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "complete")

    def test_a_bad_processor_count_is_reported_and_does_not_abort(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder, [("one", 0, 1)])
            code, events = self.invoke([
                "--subtitle", str(project.srt), "--voice", str(project.voice),
                "--output", str(project.output), "--state-dir", str(project.state),
                "--workers", "abc", "--json-events",
            ], ConcurrencyProbe(), project.content_by_index)
            self.assertEqual(code, 0)
            typed = [(event["type"], event) for event in events]
            self.assertEqual(events_of(typed, "started")[0]["processors"], 4)
            messages = [payload["message"] for payload in events_of(typed, "log")]
            self.assertTrue(any("falling back to 4" in message for message in messages))

    def test_a_missing_subtitle_file_exits_with_an_error_event(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            code, events = self.invoke([
                "--subtitle", str(root / "missing.srt"), "--voice", str(root / "missing.mp3"),
                "--output", str(root / "out.zsp"), "--json-events",
            ], ConcurrencyProbe())
            self.assertEqual(code, 1)
            self.assertEqual(events[-1]["type"], "error")


if __name__ == "__main__":
    unittest.main()
