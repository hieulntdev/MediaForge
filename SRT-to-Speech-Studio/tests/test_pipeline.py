from __future__ import annotations

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
from unittest import mock

from backend_entry import _extract_preview
from studio.srt_parser import SubtitleParseError, parse_srt
from studio.pipeline import GenerationFailed, application_dir, format_elapsed, package_build, run, validate_build
from studio.zsp import validate_zsp


def pcm_wav(duration_frames: int = 240, silent: bool = False) -> bytes:
    import math
    import struct

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        if silent:
            wav.writeframes(b"\0\0" * duration_frames)
        else:
            samples = [
                int(0.2 * 32767 * math.sin(2 * math.pi * 220.0 * (i / 24_000)))
                for i in range(duration_frames)
            ]
            wav.writeframes(struct.pack(f"<{duration_frames}h", *samples))
    return output.getvalue()


class FakeEngine:
    def __init__(self, audio: bytes | None = None) -> None:
        self.audio = audio if audio is not None else pcm_wav()
        self.loaded = False
        self.closed = False

    def load_model(self) -> None:
        self.loaded = True

    def clone_voice(self, reference_audio: Path) -> dict[str, Path]:
        if not self.loaded:
            raise AssertionError("load_model must run first")
        return {"reference": reference_audio}

    def synthesize(self, text: str, voice: object) -> bytes:
        return self.audio

    def close(self) -> None:
        self.closed = True


class ConcurrentFakeEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.threads: set[str] = set()
        self.lock = threading.Lock()

    def synthesize(self, text: str, voice: object) -> bytes:
        with self.lock:
            self.threads.add(threading.current_thread().name)
        time.sleep(0.02)
        return self.audio


class SRTParserTests(unittest.TestCase):
    def test_unicode_multiline_and_bom(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.srt"
            path.write_bytes(
                (
                    "\ufeff7\r\n00:00:00,133 --> 00:00:01,000\r\n"
                    "Mỗi đêm đúng 12 giờ,\r\ndòng hai\r\n"
                ).encode("utf-8")
            )
            result = parse_srt(path)
        self.assertEqual(result[0].index, 7)
        self.assertEqual(result[0].start, 0.133)
        self.assertEqual(result[0].end, 1.0)
        self.assertEqual(result[0].content, "Mỗi đêm đúng 12 giờ,\ndòng hai")

    def test_invalid_time_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.srt"
            path.write_text("1\ninvalid\nText", encoding="utf-8")
            with self.assertRaises(SubtitleParseError):
                parse_srt(path)


class ElectronBackendTests(unittest.TestCase):
    def test_extract_preview_allows_only_a_wav_basename(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "sample.zsp"
            audio = pcm_wav()
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("audio_cache/line_1.wav", audio)
            output = root / "preview"
            self.assertEqual(_extract_preview(archive, "line_1.wav", output), 0)
            self.assertEqual((output / "line_1.wav").read_bytes(), audio)
            with self.assertRaises(ValueError):
                _extract_preview(archive, "../line_1.wav", output)


class PipelineTests(unittest.TestCase):
    def test_format_elapsed(self) -> None:
        self.assertEqual(format_elapsed(0), "00:00:00")
        self.assertEqual(format_elapsed(65.4), "00:01:05")
        self.assertEqual(format_elapsed(3661.2), "01:01:01")

    def test_bootstrap_application_directory_override(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with mock.patch.dict("os.environ", {"SRT_STUDIO_APP_DIR": folder}):
                self.assertEqual(application_dir(), Path(folder).resolve())

    def test_application_directory_defaults_to_project_root(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(application_dir(), Path(__file__).resolve().parent.parent)

    def test_complete_archive(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,133 --> 00:00:01,000\nXin chào!\n\n"
                "2\n00:00:01,000 --> 00:00:02,500\nTiếng Việt.",
                encoding="utf-8",
            )
            (root / "voice_sample.mp3").write_bytes(b"fake reference")
            engine = FakeEngine()
            log = io.StringIO()
            asr_engine = ExactTranscriptASREngine({1: "Xin chào!", 2: "Tiếng Việt."})
            state = root / "sample.zsp.retry"
            destination = root / "sample.zsp"
            with mock.patch("sys.stdout", log):
                run(root, engine, destination=destination, state_dir=state, asr_engine=asr_engine)
            self.assertTrue(engine.closed)
            self.assertIn("Total processing time:", log.getvalue())
            self.assertFalse(destination.exists(), "run() no longer packages automatically")
            output = package_build(state, destination)
            validate_zsp(output)
            with zipfile.ZipFile(output) as archive:
                project = json.loads(archive.read("project.json"))
                self.assertEqual(len(project), 2)
                self.assertEqual(project[0]["content"], "Xin chào!")
                self.assertEqual(project[0]["speaker_name"], "voice_sample.mp3")
                self.assertEqual(project[1]["start"], 1.0)
                self.assertIn("audio_cache/", archive.namelist())

    def test_invalid_audio_does_not_replace_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:01,000\nXin chào", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")
            old = b"previous valid user output"
            (root / "output.zsp").write_bytes(old)
            with self.assertRaises(RuntimeError):
                run(root, FakeEngine(b"not a wav"), asr_engine=FakeASREngine())
            self.assertEqual((root / "output.zsp").read_bytes(), old)

    def test_parallel_generation_preserves_subtitle_order(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cues = []
            for index in range(1, 9):
                cues.append(
                    f"{index}\n00:00:{index - 1:02d},000 --> 00:00:{index:02d},000\nDòng {index}"
                )
            (root / "text_sample.srt").write_text("\n\n".join(cues), encoding="utf-8")
            (root / "voice_sample.mp3").write_bytes(b"fake")
            engine = ConcurrentFakeEngine()
            asr_engine = ExactTranscriptASREngine({index: f"Dòng {index}" for index in range(1, 9)})
            state = root / "sample.zsp.retry"
            destination = root / "sample.zsp"
            run(root, engine, max_workers=4, destination=destination, state_dir=state, asr_engine=asr_engine)
            output = package_build(state, destination)
            with zipfile.ZipFile(output) as archive:
                project = json.loads(archive.read("project.json"))
            self.assertEqual([item["index"] for item in project], list(range(1, 9)))
            self.assertGreater(len(engine.threads), 1)

    def test_retry_state_reuses_successful_lines(self) -> None:
        class SelectiveEngine(FakeEngine):
            def __init__(self, fail_bad: bool) -> None:
                super().__init__()
                self.fail_bad = fail_bad
                self.calls: list[str] = []

            def synthesize(self, text: str, voice: object) -> bytes:
                self.calls.append(text)
                if self.fail_bad and text == "bad":
                    raise RuntimeError("simulated line failure")
                return self.audio

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:01,000\ngood\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\nbad", encoding="utf-8"
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "sample.zsp.retry"
            output = root / "sample.zsp"
            # Content check must pass for "good" (an exact-transcript engine),
            # otherwise the content-retry queue would treat it as a failure
            # unrelated to the generation failure this test is actually about.
            first = SelectiveEngine(True)
            with self.assertRaises(GenerationFailed):
                run(root, first, subtitle_path=root / "sample.srt",
                    reference_path=root / "voice.mp3", destination=output,
                    state_dir=state, asr_engine=ExactTranscriptASREngine({1: "good", 2: "bad"}))
            second = SelectiveEngine(False)
            events: list[tuple[str, dict[str, object]]] = []
            run(root, second, subtitle_path=root / "sample.srt",
                reference_path=root / "voice.mp3", destination=output,
                state_dir=state, asr_engine=ExactTranscriptASREngine({1: "good", 2: "bad"}),
                event_callback=lambda kind, payload: events.append((kind, payload)))
            self.assertEqual(second.calls, ["bad"])
            progress = [payload for kind, payload in events if kind == "progress"]
            self.assertEqual(progress[-1]["completed"], 2)
            validate_zsp(package_build(state, output))

    def test_state_journal_skips_corrupt_and_invalid_lines(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text.srt").write_text(
                "1\n00:00:00,000 --> 00:00:01,000\none\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\ntwo",
                encoding="utf-8",
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "out.zsp.retry"
            audio_cache = state / "audio_cache"
            audio_cache.mkdir(parents=True)
            (audio_cache / "line_1_123.wav").write_bytes(pcm_wav())
            state.joinpath("entries.jsonl").write_text(
                '{"position": 0, "entry": {"index": 1, "start": 0.0, "end": 1.0, '
                '"content": "one", "speaker_name": "voice.mp3", "audio_filename": "line_1_123.wav"}}\n'
                "not-json\n"
                '{"position": "bad", "entry": {}}\n',
                encoding="utf-8",
            )

            class Engine(FakeEngine):
                def __init__(self) -> None:
                    super().__init__()
                    self.calls: list[str] = []

                def synthesize(self, text: str, voice: object) -> bytes:
                    self.calls.append(text)
                    return self.audio

            engine = Engine()
            # "one" is resumed from the journal (never goes through content
            # check); "two" is freshly generated and must pass content check
            # to avoid being caught by the content-retry queue.
            run(root, engine, subtitle_path=root / "text.srt",
                reference_path=root / "voice.mp3", destination=root / "out.zsp",
                state_dir=state, asr_engine=ExactTranscriptASREngine({1: "one", 2: "two"}))
            self.assertEqual(engine.calls, ["two"])


from studio.asr.compare import ContentCheck  # noqa: E402


class FakeASREngine:
    """Content check is scripted per subtitle text, like PlannedEngine for TTS."""

    def __init__(self, plan: dict[str, str] | None = None) -> None:
        self.plan = dict(plan or {})
        self.loaded = False
        self.closed = False
        self.calls: list[str] = []

    def load_model(self) -> None:
        self.loaded = True

    def transcribe(self, wav_path) -> str:
        self.calls.append(str(wav_path))
        return self.plan.get(str(wav_path), "")

    def close(self) -> None:
        self.closed = True


class ExactTranscriptASREngine(FakeASREngine):
    """Transcribes back the exact subtitle text for each line, keyed by its SRT
    index (recovered from the ``line_{index}_...`` filename), so the content
    check trivially passes -- for pipeline-level tests that aren't about the
    content-retry queue itself and shouldn't be tripped up by it."""

    def __init__(self, content_by_index: dict[int, str]) -> None:
        super().__init__()
        self.content_by_index = content_by_index

    def transcribe(self, wav_path) -> str:
        self.calls.append(str(wav_path))
        index = int(Path(wav_path).name.split("_")[1])
        return self.content_by_index.get(index, "")


class ASRIntegrationTests(unittest.TestCase):
    def test_asr_worker_loads_once_and_reports_content_status(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")
            asr = FakeASREngine()
            events: list[tuple[str, dict]] = []
            # A transcript that never matches exhausts every content-retry pass
            # (MAX_CONTENT_ATTEMPTS attempts total), so the run ultimately fails.
            with self.assertRaises(GenerationFailed):
                run(root, FakeEngine(), asr_engine=asr,
                    event_callback=lambda kind, payload: events.append((kind, payload)))
            self.assertTrue(asr.loaded)
            self.assertTrue(asr.closed)
            asr_results = [payload for kind, payload in events if kind == "segment_asr_result"]
            self.assertEqual(len(asr_results), 3)
            for item in asr_results:
                self.assertEqual(item["content_status"], "CONTENT_MISSING")

    def test_content_retry_queue_runs_after_the_main_pass_and_keeps_the_best_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn\n\n"
                "2\n00:00:02,000 --> 00:00:04,000\nTạm biệt nhé",
                encoding="utf-8",
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")

            class ByPositionASR(FakeASREngine):
                """Line 1 needs 2 attempts to pass; line 2 passes immediately."""

                def __init__(self) -> None:
                    super().__init__()
                    self.attempt_counts: dict[str, int] = {}

                def transcribe(self, wav_path) -> str:
                    self.calls.append(str(wav_path))
                    name = Path(wav_path).name
                    if name.startswith("line_2_"):
                        return "Tạm biệt nhé"
                    prefix = "line_1_"
                    self.attempt_counts[prefix] = self.attempt_counts.get(prefix, 0) + 1
                    if self.attempt_counts[prefix] >= 2:
                        return "Xin chào các bạn"
                    return "hoàn toàn sai"

            events: list[tuple[str, dict]] = []
            run(root, FakeEngine(), asr_engine=ByPositionASR(),
                event_callback=lambda kind, payload: events.append((kind, payload)))
            results = [payload for kind, payload in events if kind == "segment_result"
                       and payload.get("status") == "success"]
            # Every attempt (including a losing content-retry attempt) reports its
            # own segment_result row, so line 1's 2 attempts count twice here --
            # assert on distinct positions to check both lines ultimately succeeded.
            self.assertEqual({payload["position"] for payload in results}, {0, 1})
            asr_results = [payload for kind, payload in events if kind == "segment_asr_result"]
            self.assertTrue(any(item["content_status"] == "CONTENT_OK" for item in asr_results))
            # Line 1 must have been re-transcribed at least once (its first pass
            # is always wrong) and the retry must have ultimately succeeded --
            # this is what actually distinguishes the retry queue from no retry
            # queue at all (line 2 alone always reports CONTENT_OK on its own).
            line1_checks = [item for item in asr_results if item["position"] == 0]
            self.assertGreaterEqual(
                len(line1_checks), 2, "line 1 must have gone through a content retry"
            )
            self.assertEqual(line1_checks[-1]["content_status"], "CONTENT_OK")

    def test_content_retry_still_works_when_state_dir_is_set(self) -> None:
        """Regression test: content_fail_positions must exclude only positions
        resumed from a *prior* run's journal, not this run's own PASS 1
        successes. Before the fix, `state_dir` being set caused
        `content_fail_positions` to be computed against the live
        `state_entries` dict -- which PASS 1 itself already writes every
        success into -- so every PASS-1 success (including content-mismatched
        ones) was wrongly excluded from retry, and the run silently completed
        as a success instead of retrying/failing on bad content."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")
            with tempfile.TemporaryDirectory() as state_folder:
                state_dir = Path(state_folder)
                asr = FakeASREngine()
                events: list[tuple[str, dict]] = []
                # A transcript that never matches should exhaust every
                # content-retry pass (MAX_CONTENT_ATTEMPTS attempts total) and
                # ultimately fail -- exactly like the no-state_dir case above.
                # Before the fix, this instead completed with a single
                # PASS-1 "success" and zero retries/errors.
                with self.assertRaises(GenerationFailed):
                    run(root, FakeEngine(), state_dir=state_dir, asr_engine=asr,
                        event_callback=lambda kind, payload: events.append((kind, payload)))
                asr_results = [payload for kind, payload in events if kind == "segment_asr_result"]
                self.assertEqual(len(asr_results), 3)
                for item in asr_results:
                    self.assertEqual(item["content_status"], "CONTENT_MISSING")
                item_errors = [payload for kind, payload in events if kind == "item_error"]
                self.assertEqual(len(item_errors), 1)
                self.assertEqual(item_errors[0]["reason"], "CONTENT_MISSING")

    def test_exhausted_content_retry_emits_a_segment_result_fail_event(self) -> None:
        """Regression test: when a line exhausts every content-retry attempt
        and lands in content_fail_positions at the end of run(), the pipeline
        must emit a segment_result event with status="fail" for that
        position/index -- not merely an item_error. The Electron UI's per-row
        status column is driven entirely by segment_result events, so a
        content-exhausted line that never gets one stays stuck showing its
        last transient status in the UI instead of flipping to "Fail"."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")
            asr = FakeASREngine()
            events: list[tuple[str, dict]] = []
            # A transcript that never matches should exhaust every
            # content-retry pass (MAX_CONTENT_ATTEMPTS attempts total) and
            # ultimately fail.
            with self.assertRaises(GenerationFailed):
                run(root, FakeEngine(), asr_engine=asr,
                    event_callback=lambda kind, payload: events.append((kind, payload)))
            item_errors = [payload for kind, payload in events if kind == "item_error"]
            self.assertEqual(len(item_errors), 1)
            self.assertEqual(item_errors[0]["reason"], "CONTENT_MISSING")
            fail_results = [
                payload for kind, payload in events if kind == "segment_result"
                and payload.get("status") == "fail"
            ]
            self.assertEqual(len(fail_results), 1)
            self.assertEqual(fail_results[0]["position"], 0)
            self.assertEqual(fail_results[0]["index"], 1)
            self.assertTrue(str(fail_results[0]["reason"]).startswith("CONTENT_"))

    def test_status_event_announces_content_validation_before_it_blocks(self) -> None:
        """Regression test: once TTS synthesis finishes, the pipeline still
        has to drain the ASR queue (and possibly run content-retry passes)
        before it reaches "complete" -- work that used to be invisible to
        the UI (no status/log event, progress bar frozen at 100%), making a
        perfectly healthy run look hung. A "status" event must announce this
        stage starts, before the run can reach "complete"."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")
            asr = ExactTranscriptASREngine({1: "Xin chào các bạn"})
            events: list[tuple[str, dict]] = []
            run(root, FakeEngine(), asr_engine=asr,
                event_callback=lambda kind, payload: events.append((kind, payload)))
            kinds_in_order = [kind for kind, _payload in events]
            status_messages = [
                payload["message"] for kind, payload in events if kind == "status"
            ]

            def announces_content_validation(message: str) -> bool:
                lowered = message.lower()
                return "content" in lowered and "valid" in lowered

            self.assertTrue(
                any(announces_content_validation(message) for message in status_messages),
                f"no status event announced content validation: {status_messages}",
            )
            status_index = next(
                i for i, (kind, payload) in enumerate(events)
                if kind == "status" and announces_content_validation(payload["message"])
            )
            self.assertLess(status_index, kinds_in_order.index("complete"))

    def test_status_event_announces_each_content_retry_attempt(self) -> None:
        """Companion to the test above: a content-retry pass runs silently
        too (count_progress=False, no segment progress events) -- it needs
        its own status announcement so a multi-minute retry pass doesn't
        look hung either."""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text_sample.srt").write_text(
                "1\n00:00:00,000 --> 00:00:02,000\nXin chào các bạn", encoding="utf-8"
            )
            (root / "voice_sample.mp3").write_bytes(b"fake")

            class OnceWrongASR(FakeASREngine):
                def __init__(self) -> None:
                    super().__init__()
                    self.attempts = 0

                def transcribe(self, wav_path) -> str:
                    self.calls.append(str(wav_path))
                    self.attempts += 1
                    return "Xin chào các bạn" if self.attempts >= 2 else "sai hoàn toàn"

            events: list[tuple[str, dict]] = []
            run(root, FakeEngine(), asr_engine=OnceWrongASR(),
                event_callback=lambda kind, payload: events.append((kind, payload)))
            status_messages = [
                payload["message"] for kind, payload in events if kind == "status"
            ]
            self.assertTrue(
                any("retry" in message.lower() and "content" in message.lower()
                    for message in status_messages),
                f"no status event announced the content-retry attempt: {status_messages}",
            )

    def test_exhausted_content_retry_never_ships_via_a_later_resumed_run(self) -> None:
        """Regression test for the cross-cutting bug the FINAL whole-branch
        review caught: a position that exhausts every content-retry attempt
        must never be journaled into entries.jsonl as a success. Before the
        fix, the "keep the best attempt" loop unconditionally wrote every
        content-retried position's best (still-wrong) attempt into the
        journal, even when that position was also, moments later, reported
        as a content-validation failure. A later run against the same
        state_dir (exactly what the Electron UI's "Retry Failed" button
        does) then trusted that stale journal line and silently resumed the
        content-mismatched audio instead of re-synthesizing and
        re-validating it."""

        class TrackingEngine(FakeEngine):
            def __init__(self) -> None:
                super().__init__()
                self.calls: list[str] = []

            def synthesize(self, text: str, voice: object) -> bytes:
                self.calls.append(text)
                return self.audio

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text.srt").write_text(
                "1\n00:00:00,000 --> 00:00:01,000\ngood\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\nbad", encoding="utf-8"
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "out.zsp.retry"
            output = root / "out.zsp"
            # "good" (index 1) passes content check every time. "bad" (index 2)
            # is missing from content_by_index, so transcribe() always returns
            # "" for it -- it never matches and exhausts every content-retry
            # attempt (MAX_CONTENT_ATTEMPTS total).
            first_engine = TrackingEngine()
            with self.assertRaises(GenerationFailed):
                run(root, first_engine, subtitle_path=root / "text.srt",
                    reference_path=root / "voice.mp3", destination=output,
                    state_dir=state, asr_engine=ExactTranscriptASREngine({1: "good"}))

            # The journal must have no entry for position 1 ("bad") -- only
            # the passing "good" line (position 0) may be persisted.
            journal_text = (state / "entries.jsonl").read_text(encoding="utf-8")
            journaled_positions = {
                json.loads(line)["position"] for line in journal_text.splitlines() if line.strip()
            }
            self.assertNotIn(1, journaled_positions)
            self.assertIn(0, journaled_positions)

            # A later run against the exact same state_dir (as the Electron
            # UI's "Retry Failed" button would issue) must actually
            # re-synthesize and re-validate "bad" -- not silently resume a
            # stale, content-mismatched take.
            second_engine = TrackingEngine()
            with self.assertRaises(GenerationFailed):
                run(root, second_engine, subtitle_path=root / "text.srt",
                    reference_path=root / "voice.mp3", destination=output,
                    state_dir=state, asr_engine=ExactTranscriptASREngine({1: "good"}))
            self.assertIn("bad", second_engine.calls)
            self.assertNotIn("good", second_engine.calls)

    def test_package_build_packages_successes_even_after_a_failed_line(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "text.srt").write_text(
                "1\n00:00:00,000 --> 00:00:01,000\ngood\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\nbad", encoding="utf-8"
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "out.zsp.retry"
            destination = root / "out.zsp"
            with self.assertRaises(GenerationFailed):
                run(root, FakeEngine(), subtitle_path=root / "text.srt",
                    reference_path=root / "voice.mp3", destination=destination,
                    state_dir=state, asr_engine=ExactTranscriptASREngine({1: "good"}))
            output = package_build(state, destination)
            validate_zsp(output)
            with zipfile.ZipFile(output) as archive:
                project = json.loads(archive.read("project.json"))
            self.assertEqual([item["index"] for item in project], [1])

    def test_package_build_raises_when_nothing_has_been_generated_yet(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / "empty.zsp.retry"
            with self.assertRaises(ValueError):
                package_build(state, root / "empty.zsp")

    def test_package_build_reads_the_last_journal_line_for_a_regenerated_position(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / "out.zsp.retry"
            audio_cache = state / "audio_cache"
            audio_cache.mkdir(parents=True)
            (audio_cache / "line_1_old.wav").write_bytes(pcm_wav())
            (audio_cache / "line_1_new.wav").write_bytes(pcm_wav())
            state.joinpath("entries.jsonl").write_text(
                '{"position": 0, "entry": {"index": 1, "start": 0.0, "end": 1.0, '
                '"content": "old take", "speaker_name": "voice.mp3", "audio_filename": "line_1_old.wav"}}\n'
                '{"position": 0, "entry": {"index": 1, "start": 0.0, "end": 1.0, '
                '"content": "new take", "speaker_name": "voice.mp3", "audio_filename": "line_1_new.wav"}}\n',
                encoding="utf-8",
            )
            output = package_build(state, root / "out.zsp")
            validate_zsp(output)
            with zipfile.ZipFile(output) as archive:
                project = json.loads(archive.read("project.json"))
            self.assertEqual(len(project), 1)
            self.assertEqual(project[0]["content"], "new take")
            self.assertEqual(project[0]["audio_filename"], "line_1_new.wav")

    def test_validate_build_reports_content_status_for_each_generated_line(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subtitle_path = root / "text.srt"
            subtitle_path.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\ngood\n\n"
                "2\n00:00:01,000 --> 00:00:02,000\nbad", encoding="utf-8"
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "sample.zsp.retry"
            run(root, FakeEngine(), subtitle_path=subtitle_path,
                reference_path=root / "voice.mp3", destination=root / "sample.zsp",
                state_dir=state, validate_content=False)
            events: list[tuple[str, dict]] = []
            validate_build(
                subtitle_path, state,
                asr_engine=ExactTranscriptASREngine({1: "good", 2: "wrong"}),
                event_callback=lambda kind, payload: events.append((kind, payload)),
            )
            started = [payload for kind, payload in events if kind == "validation_started"]
            self.assertEqual(started[0]["total"], 2)
            results = {
                payload["position"]: payload["content_status"]
                for kind, payload in events if kind == "segment_asr_result"
            }
            self.assertEqual(results[0], "CONTENT_OK")
            self.assertEqual(results[1], "CONTENT_WRONG")
            completed = [payload for kind, payload in events if kind == "validation_complete"]
            self.assertEqual(completed[0]["total"], 2)

    def test_validate_build_never_touches_the_journal_or_regenerates_audio(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subtitle_path = root / "text.srt"
            subtitle_path.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\ngood", encoding="utf-8"
            )
            (root / "voice.mp3").write_bytes(b"fake")
            state = root / "sample.zsp.retry"
            run(root, FakeEngine(), subtitle_path=subtitle_path,
                reference_path=root / "voice.mp3", destination=root / "sample.zsp",
                state_dir=state, validate_content=False)
            journal_before = (state / "entries.jsonl").read_text(encoding="utf-8")
            validate_build(
                subtitle_path, state,
                asr_engine=ExactTranscriptASREngine({1: "totally different"}),
            )
            journal_after = (state / "entries.jsonl").read_text(encoding="utf-8")
            self.assertEqual(journal_before, journal_after)


if __name__ == "__main__":
    unittest.main()
