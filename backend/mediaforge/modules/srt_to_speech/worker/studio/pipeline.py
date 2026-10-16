"""Vietnamese SRT to ZSP voice-cloning pipeline and worker entry point."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from typing import Any, Callable, Protocol
import uuid

from studio.asr.compare import ContentCheck, compare as asr_compare
from studio.asr.cpu_plan import plan_log_lines, resolve_asr_cpu_plan
from studio.asr.whisper_engine import ASREngine, WhisperASREngine
import queue
from studio.srt_parser import Subtitle, SubtitleParseError, parse_srt
from studio.tts import hardware
from studio.tts import (
    DEFAULT_TTS_MODEL,
    MELOTTS_MODEL,
    TTSSelectionError,
    create_engine,
    needs_reference_audio,
    normalize_model_name,
)
from studio.tts.melotts_engine import MeloTTSEngineError
from studio.tts.vieneu_engine import TTSEngine, TTSEngineError
from studio.zsp import PROJECT_FIELDS, ZSPValidationError, create_zsp, validate_wav
from studio.audio_validation import (
    DurationValidationError,
    TimingCheck,
    detect_speech_boundary,
    evaluate_timing,
    match_wav_duration,
    trim_silence,
    wav_duration_seconds,
)

EventCallback = Callable[[str, dict[str, object]], None]

# Concurrency limit. The GUI "Processing Threads" selector is the source of
# truth; 4 is only the value used when nothing valid reaches the pipeline.
DEFAULT_PROCESSOR_COUNT = 4
# Sanity ceiling for a hand-crafted ``--workers`` value. The selector offers
# 2-6, so this never overrides a user selection -- it only stops an absurd
# number from starting thousands of threads that share a single model.
MAX_PROCESSOR_COUNT = 32

# Timing warnings never trigger TTS regeneration: valid speech is corrected to
# its SRT slot. A correction failure (missing FFmpeg/invalid output) is a normal
# generation failure and follows the existing bounded retry/error path.
MAX_GENERATION_RETRIES = 3
# 1 initial generation + retries for invalid/empty TTS output or processing errors.
MAX_GENERATION_ATTEMPTS = MAX_GENERATION_RETRIES + 1

STATUS_SUCCESS = "success"
STATUS_FAIL = "fail"
STATUS_SKIPPED = "skipped"

FAILURE_REASON_GENERATION = "generation"

# Where a segment's last, still-rejected take is preserved once every retry
# is spent, alongside a text log of every such failure.
ERROR_SEGMENTS_DIRNAME = "error_segments"
ERROR_LOG_FILENAME = "errors.log"

# Worker threads write whole lines; the GUI bridge parses one event per line.
_PRINT_LOCK = threading.Lock()
# Serialises appends to errors.log the same way _PRINT_LOCK serialises stdout.
_ERROR_LOG_LOCK = threading.Lock()


def configure_utf8_streams() -> None:
    """Use UTF-8 for redirected streams, even outside the GUI launcher."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def format_elapsed(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def format_timestamp(seconds: float) -> str:
    """Render a SRT timestamp (``HH:MM:SS,mmm``) for the activity log."""
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


class Engine(Protocol):
    def load_model(self) -> None: ...
    def clone_voice(self, reference_audio: Path) -> Any: ...
    def synthesize(self, text: str, voice: Any) -> bytes: ...
    def close(self) -> None: ...


def _job_engine(
    engine: Engine | None,
    tts_model: object,
    melo_language: str,
    melo_speaker: str | None,
) -> tuple[Engine, str]:
    """Resolve a job-local engine while preserving VieNeu's original default."""
    selected = normalize_model_name(tts_model)
    if engine is not None:
        return engine, selected
    if selected == DEFAULT_TTS_MODEL:
        # Keep the existing construction path exactly as it was.  In addition
        # to backwards compatibility, tests and embedders patch this symbol.
        return TTSEngine(), selected
    return create_engine(
        selected, melo_language=melo_language, melo_speaker=melo_speaker
    ), selected


def _speaker_name(engine: Engine, reference_path: Path) -> str:
    value = getattr(engine, "speaker_name", None)
    return str(value) if value else reference_path.name


def _voice_status(selected_model: str) -> str:
    return (
        "Selecting MeloTTS speaker..."
        if selected_model == MELOTTS_MODEL
        else "Analyzing voice sample..."
    )


class GenerationFailed(RuntimeError):
    """Raised after a run finishes with one or more failed subtitle cues."""

    def __init__(self, failures: list[dict[str, object]]) -> None:
        self.failures = failures
        super().__init__(f"{len(failures)} subtitle line(s) failed")


@dataclass(frozen=True)
class SegmentOutcome:
    """Terminal state of one subtitle after generation (and any retries)."""

    ok: bool
    filename: str
    attempts: int
    timing: TimingCheck | None = None
    raw_duration: float | None = None
    trimmed_duration: float | None = None
    final_duration: float | None = None
    final_error: float | None = None
    duration_action: str | None = None
    speed: float | None = None
    content_status: str = "PENDING_ASR"
    error: str | None = None


def application_dir() -> Path:
    bootstrap_dir = os.environ.get("SRT_STUDIO_APP_DIR")
    if bootstrap_dir:
        return Path(bootstrap_dir).resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def validate_processor_count(value: object) -> tuple[int, str | None]:
    """Return a usable processor count plus an explanation when input is rejected.

    Only a positive integer is honoured. ``0``, negative numbers, ``None``,
    non-numeric strings, ``NaN`` and infinity fall back to
    ``DEFAULT_PROCESSOR_COUNT`` so a bad setting can never crash a run.
    ``DEFAULT_PROCESSOR_COUNT`` is a default only -- every other valid selection
    the user makes is passed through unchanged.
    """
    if value is None:
        return DEFAULT_PROCESSOR_COUNT, None
    try:
        if isinstance(value, bool):
            raise ValueError("boolean is not a processor count")
        count = int(value) if isinstance(value, (int, float)) else int(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_PROCESSOR_COUNT, (
            f"Invalid processor count {value!r}: falling back to "
            f"{DEFAULT_PROCESSOR_COUNT}."
        )
    if count < 1:
        return DEFAULT_PROCESSOR_COUNT, (
            f"Invalid processor count {count}: falling back to "
            f"{DEFAULT_PROCESSOR_COUNT}."
        )
    if count > MAX_PROCESSOR_COUNT:
        return MAX_PROCESSOR_COUNT, (
            f"Processor count {count} is above the supported maximum "
            f"{MAX_PROCESSOR_COUNT}: using {MAX_PROCESSOR_COUNT}."
        )
    return count, None


def _archive_failed_segment(
    temporary: Path,
    error_dir: Path | None,
    filename: str,
    attempts: int,
    reason: str,
    message: str,
) -> None:
    """Preserve the last rejected take of an exhausted segment for inspection.

    Moves ``temporary`` (when it exists) into ``error_dir`` under its real
    ``filename`` instead of deleting it, and appends one line describing the
    failure to ``error_dir/errors.log``. With no ``error_dir`` this falls back
    to the old behaviour of simply discarding the temp file.
    """
    if error_dir is None:
        temporary.unlink(missing_ok=True)
        return
    error_dir.mkdir(parents=True, exist_ok=True)
    kept = temporary.exists()
    if kept:
        os.replace(temporary, error_dir / filename)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = (
        f"{timestamp} {filename} attempts={attempts} reason={reason} "
        f"kept={'yes' if kept else 'no'} message={message}\n"
    )
    with _ERROR_LOG_LOCK:
        with (error_dir / ERROR_LOG_FILENAME).open("a", encoding="utf-8") as stream:
            stream.write(line)


def generate_segment(
    engine: Engine,
    voice: Any,
    audio_dir: Path,
    subtitle: Subtitle,
    filename: str,
    *,
    max_attempts: int = MAX_GENERATION_ATTEMPTS,
    notify: Callable[[str, int, TimingCheck | None], None] | None = None,
    error_dir: Path | None = None,
) -> SegmentOutcome:
    """Generate one subtitle WAV, retrying only on hard failures.

    A hard failure is corrupt/empty audio, a TTS exception, or a duration
    processing error; these retry inline up to ``max_attempts`` times. Once a
    real, non-silent WAV exists, outer silence is trimmed and its duration is
    matched to the exact SRT slot. Long lines are always pitch-preservingly
    accelerated (quality thresholds only control warnings); short lines keep
    their speaking rate and receive trailing silence. Content validation happens
    outside this function, asynchronously (see ``run()``); this function marks the
    outcome ``content_status="PENDING_ASR"``.
    """
    target = audio_dir / filename
    for attempt in range(1, max(1, max_attempts) + 1):
        temporary = audio_dir / f".{filename}.{uuid.uuid4().hex}.part"
        trimmed: Path | None = None
        matched: Path | None = None
        raw_duration: float | None = None
        trimmed_duration: float | None = None
        try:
            wav_bytes_out = engine.synthesize(subtitle.content, voice)
            temporary.write_bytes(wav_bytes_out)
            validate_wav(temporary)
            raw_duration = wav_duration_seconds(temporary)
            boundary = detect_speech_boundary(temporary)
            if not boundary.has_speech:
                raise DurationValidationError(f"{filename}: audio is silence end to end")
            trimmed = audio_dir / f".{filename}.{uuid.uuid4().hex}.trim.wav"
            trim_silence(temporary, trimmed, boundary)
            trimmed_duration = wav_duration_seconds(trimmed)
            timing = evaluate_timing(
                trimmed_duration, subtitle.start_ms / 1000.0, subtitle.end_ms / 1000.0
            )
            matched = audio_dir / f".{filename}.{uuid.uuid4().hex}.matched.wav"
            duration_result = match_wav_duration(
                trimmed, matched, subtitle.duration_seconds
            )
            validate_wav(matched)
        except Exception as exc:
            message = str(exc) if isinstance(exc, DurationValidationError) else f"{type(exc).__name__}: {exc}"
            if trimmed is not None:
                trimmed.unlink(missing_ok=True)
            if matched is not None:
                matched.unlink(missing_ok=True)
            if attempt < max_attempts:
                temporary.unlink(missing_ok=True)
                if notify is not None:
                    notify("retry", attempt, None)
                continue
            _archive_failed_segment(
                temporary, error_dir, filename, attempt, FAILURE_REASON_GENERATION, message
            )
            return SegmentOutcome(ok=False, filename=filename, attempts=attempt, error=message)

        temporary.unlink(missing_ok=True)
        assert trimmed is not None and matched is not None
        trimmed.unlink(missing_ok=True)
        os.replace(matched, target)
        if attempt > 1 and notify is not None:
            notify("recovered", attempt, timing)
        return SegmentOutcome(
            ok=True,
            filename=filename,
            attempts=attempt,
            timing=timing,
            raw_duration=raw_duration,
            trimmed_duration=trimmed_duration,
            final_duration=duration_result.final_duration,
            final_error=duration_result.final_error,
            duration_action=duration_result.action,
            speed=duration_result.speed_ratio,
        )
    raise AssertionError("generate_segment exhausted its attempt loop")


def _preview(subtitle: Subtitle) -> str:
    value = subtitle.content.replace("\n", " ")
    return value if len(value) <= 70 else value[:67] + "..."


def _duration_report(subtitle: Subtitle, outcome: SegmentOutcome) -> str:
    """Compact, grep-friendly timing diagnostics for CLI and Activity Log."""
    timing = outcome.timing
    if timing is None:
        return f"[Subtitle {subtitle.index:03d}] Duration correction unavailable"
    return (
        f"[Subtitle {subtitle.index:03d}] "
        f"{format_timestamp(subtitle.start)} -> {format_timestamp(subtitle.end)} | "
        f"target={subtitle.duration_seconds:.3f}s "
        f"raw={float(outcome.raw_duration or 0.0):.3f}s "
        f"trimmed={float(outcome.trimmed_duration or 0.0):.3f}s "
        f"ratio={timing.required_speed:.3f}x "
        f"speed={float(outcome.speed or 0.0):.3f}x "
        f"final={float(outcome.final_duration or 0.0):.3f}s "
        f"error={float(outcome.final_error or 0.0) * 1000:+.1f}ms "
        f"action={outcome.duration_action} status={timing.status} quality={timing.quality}"
    )


def _state_audio_dir(state_dir: Path | None) -> Path | None:
    if state_dir is None:
        return None
    directory = state_dir / "audio_cache"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _duration_match_existing(path: Path, subtitle: Subtitle) -> SegmentOutcome:
    """Upgrade a legacy/resumed WAV to the same invariant as fresh output."""
    token = uuid.uuid4().hex
    trimmed = path.with_name(f".{path.name}.{token}.resume-trim.wav")
    matched = path.with_name(f".{path.name}.{token}.resume-matched.wav")
    try:
        validate_wav(path)
        raw_duration = wav_duration_seconds(path)
        boundary = detect_speech_boundary(path)
        if not boundary.has_speech:
            raise DurationValidationError(f"{path.name}: audio is silence end to end")
        trim_silence(path, trimmed, boundary)
        trimmed_duration = wav_duration_seconds(trimmed)
        timing = evaluate_timing(
            trimmed_duration, subtitle.start_ms / 1000.0, subtitle.end_ms / 1000.0
        )
        result = match_wav_duration(trimmed, matched, subtitle.duration_seconds)
        validate_wav(matched)
        os.replace(matched, path)
        return SegmentOutcome(
            ok=True,
            filename=path.name,
            attempts=0,
            timing=timing,
            raw_duration=raw_duration,
            trimmed_duration=trimmed_duration,
            final_duration=result.final_duration,
            final_error=result.final_error,
            duration_action=result.action,
            speed=result.speed_ratio,
        )
    finally:
        trimmed.unlink(missing_ok=True)
        matched.unlink(missing_ok=True)


def _journal_record(position: int, entry: dict[str, object]) -> str:
    return json.dumps({"position": position, "entry": entry}, ensure_ascii=False) + "\n"


def _safe_journal_filename(value: object) -> str | None:
    filename = str(value or "")
    if filename.lower().endswith(".wav") and Path(filename).name == filename:
        return filename
    return None


def _journal_filename(state_dir: Path, position: int) -> str | None:
    """Return the audio file the journal last recorded for ``position``."""
    try:
        journal = (state_dir / "entries.jsonl").read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    found: str | None = None
    for line in journal.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("position") != position:
            continue
        entry = record.get("entry")
        if isinstance(entry, dict):
            found = _safe_journal_filename(entry.get("audio_filename")) or found
    return found


def regenerate_segment(
    app_dir: Path | None = None,
    engine: Engine | None = None,
    *,
    subtitle_path: Path | None = None,
    reference_path: Path | None = None,
    position: int | None = None,
    state_dir: Path | None = None,
    event_callback: EventCallback | None = None,
    asr_engine: ASREngine | None = None,
    validate_content: bool = True,
    tts_model: str = DEFAULT_TTS_MODEL,
    melo_language: str = "EN",
    melo_speaker: str | None = None,
) -> dict[str, object]:
    """Regenerate one subtitle on demand and publish it to the retry cache.

    Manual retry is a single generation attempt followed by duration
    validation: it never runs the automatic retry chain, and the user can press
    Retry again if the line still fails. A passing result is written into the
    same resume cache batch processing uses, so the next "Retry Failed" run
    reuses it instead of regenerating the line a second time.
    """
    root = (app_dir or application_dir()).resolve()
    subtitle_path = (subtitle_path or root / "text_sample.srt").resolve()
    selected_model = normalize_model_name(tts_model)
    reference_path = (reference_path or root / "voice_sample.mp3").resolve()
    if not subtitle_path.is_file():
        raise FileNotFoundError(f"subtitle file not found: {subtitle_path}")
    if needs_reference_audio(selected_model) and not reference_path.is_file():
        raise FileNotFoundError(f"voice file not found: {reference_path}")
    if not isinstance(position, int) or isinstance(position, bool) or position < 0:
        raise ValueError("manual retry needs the subtitle position in the SRT file")
    if state_dir is None:
        raise ValueError("manual retry needs the state directory of the run")

    def emit(kind: str, **payload: object) -> None:
        if event_callback is not None:
            event_callback(kind, payload)

    def report(message: str, kind: str = "log") -> None:
        if event_callback is None:
            print(message, flush=True)
        else:
            emit(kind, message=message)

    state_dir = state_dir.resolve()
    audio_dir = _state_audio_dir(state_dir)
    assert audio_dir is not None
    error_dir = state_dir / ERROR_SEGMENTS_DIRNAME
    subtitles = parse_srt(subtitle_path)
    if position >= len(subtitles):
        raise IndexError(
            f"subtitle {position + 1} is out of range: the file has {len(subtitles)} cues"
        )
    subtitle = subtitles[position]

    active_engine, selected_model = _job_engine(
        engine, selected_model, melo_language, melo_speaker
    )
    active_asr_engine = (asr_engine or WhisperASREngine()) if validate_content else None
    try:
        emit("status", message="Loading TTS model...")
        active_engine.load_model()
        emit("status", message=_voice_status(selected_model))
        voice = active_engine.clone_voice(reference_path)
        filename = f"line_{subtitle.index}_{int(time.time() * 1000) + position}.wav"
        emit("segment_started", position=position, index=subtitle.index, manual=True)
        outcome = generate_segment(
            active_engine, voice, audio_dir, subtitle, filename,
            max_attempts=1, error_dir=error_dir,
        )
        result: dict[str, object] = {
            "position": position,
            "index": subtitle.index,
            "start": subtitle.start,
            "end": subtitle.end,
            "filename": filename,
            "attempts": outcome.attempts,
            "manual": True,
        }
        if outcome.timing is not None:
            result.update(
                timing_status=outcome.timing.status,
                speech_duration=outcome.timing.speech_duration,
                required_speed=outcome.timing.required_speed,
                target_duration=outcome.timing.target_duration,
                raw_duration=outcome.raw_duration,
                trimmed_duration=outcome.trimmed_duration,
                final_duration=outcome.final_duration,
                final_error=outcome.final_error,
                duration_action=outcome.duration_action,
                timing_quality=outcome.timing.quality,
                speed=outcome.speed,
            )
        if not outcome.ok:
            result.update(status=STATUS_FAIL, message=outcome.error)
            emit("segment_result", audio_filename="", **result)
            return result

        report(_duration_report(subtitle, outcome))

        if validate_content:
            assert active_asr_engine is not None
            asr_error: str | None = None
            transcript = ""
            try:
                active_asr_engine.load_model()
                transcript = active_asr_engine.transcribe(audio_dir / filename)
            except Exception as exc:
                asr_error = str(exc)
            finally:
                active_asr_engine.close()

            if asr_error is not None:
                content_check = ContentCheck(status="CONTENT_WRONG", similarity=0.0, wer=1.0)
            else:
                content_check = asr_compare(subtitle.content, transcript)
        else:
            content_check = ContentCheck(status="CONTENT_OK", similarity=1.0, wer=0.0)
        result.update(content_status=content_check.status, similarity=content_check.similarity)

        if content_check.status != "CONTENT_OK":
            message = f"content validation failed: {content_check.status}"
            _archive_failed_segment(
                audio_dir / filename, error_dir, filename, 1, content_check.status, message
            )
            result.update(status=STATUS_FAIL, message=message)
            emit("segment_result", audio_filename="", **result)
            return result

        previous = _journal_filename(state_dir, position)
        entry: dict[str, object] = {
            "index": subtitle.index,
            "start": subtitle.start,
            "end": subtitle.end,
            "content": subtitle.content,
            "speaker_name": _speaker_name(active_engine, reference_path),
            "audio_filename": filename,
            "audio": {
                "raw_duration": outcome.raw_duration,
                "speech_duration": outcome.trimmed_duration,
                "final_duration": outcome.final_duration,
                "duration_matched": True,
            },
            "timing": {
                "status": outcome.timing.status,
                "required_speed": outcome.timing.required_speed,
                "speed": outcome.speed,
                "quality": outcome.timing.quality,
                "action": outcome.duration_action,
            },
        }
        with (state_dir / "entries.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(_journal_record(position, entry))
        if previous is not None and previous != filename:
            # The regenerated take replaces the superseded one.
            (audio_dir / previous).unlink(missing_ok=True)
        result.update(status=STATUS_SUCCESS, audio_filename=filename)
        emit("segment_result", **result)
        return result
    finally:
        active_engine.close()


def run(
    app_dir: Path | None = None,
    engine: Engine | None = None,
    *,
    subtitle_path: Path | None = None,
    reference_path: Path | None = None,
    destination: Path | None = None,
    max_workers: int | str | None = None,
    asr_workers: int | str | None = None,
    event_callback: EventCallback | None = None,
    state_dir: Path | None = None,
    asr_engine: ASREngine | None = None,
    validate_content: bool = True,
    tts_model: str = DEFAULT_TTS_MODEL,
    melo_language: str = "EN",
    melo_speaker: str | None = None,
) -> Path:
    """Synthesize every subtitle line and report progress via ``event_callback``.

    ``state_dir`` is where generated audio actually persists (``state_dir/
    audio_cache`` plus the ``entries.jsonl`` resume journal) -- packaging into
    a ``.zsp`` is a separate, on-demand step (see ``package_build()``). Pass
    ``state_dir=None`` only for a throwaway run: every line is still
    generated, but nothing survives past this call returning.
    """
    started_at = time.perf_counter()
    root = (app_dir or application_dir()).resolve()
    subtitle_path = (subtitle_path or root / "text_sample.srt").resolve()
    selected_model = normalize_model_name(tts_model)
    reference_path = (reference_path or root / "voice_sample.mp3").resolve()
    destination = (destination or root / "output.zsp").resolve()
    state_dir = state_dir.resolve() if state_dir is not None else None

    if not subtitle_path.is_file():
        raise FileNotFoundError(f"subtitle file not found: {subtitle_path}")
    if needs_reference_audio(selected_model) and not reference_path.is_file():
        raise FileNotFoundError(f"voice file not found: {reference_path}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    state_audio_dir = _state_audio_dir(state_dir)

    def emit(kind: str, **payload: object) -> None:
        if event_callback is not None:
            event_callback(kind, payload)

    def report(message: str, kind: str = "log") -> None:
        """Send a human line to the activity log, or to the terminal in CLI mode."""
        if event_callback is None:
            print(message, flush=True)
        else:
            emit(kind, message=message)

    def narrate(message: str) -> None:
        """Terminal-only progress text; the GUI renders the matching event."""
        if event_callback is None:
            print(message, flush=True)

    print("Vietnamese SRT Voice Generator\n")
    print(f"Reference: {reference_path}")
    print(f"Subtitle:  {subtitle_path}\n")
    hardware.log_environment()
    active_engine, selected_model = _job_engine(
        engine, selected_model, melo_language, melo_speaker
    )
    asr_plan, asr_plan_warning = resolve_asr_cpu_plan(asr_workers)
    asr_queue: "queue.Queue[tuple[int, int, Path, str] | None]" = queue.Queue()
    asr_results: dict[int, dict[str, object]] = {}
    asr_results_lock = threading.Lock()
    asr_model_ready = False
    active_asr_engine: ASREngine | None = None

    if validate_content:
        if asr_plan_warning:
            report(asr_plan_warning)
        for line in plan_log_lines(asr_plan):
            report(line)
        active_asr_engine = asr_engine or WhisperASREngine(
            num_workers=asr_plan.num_workers, cpu_threads=asr_plan.cpu_threads
        )
        # Loaded once, up front, and shared by every ASR worker thread
        # drain_asr_queue() spawns -- never reloaded per pool or per thread.
        try:
            active_asr_engine.load_model()
            asr_model_ready = True
        except Exception:
            asr_model_ready = False

    def asr_worker_loop() -> None:
        while True:
            job = asr_queue.get()
            if job is None:
                asr_queue.task_done()
                break
            position, index, wav_path, srt_text = job
            try:
                if not asr_model_ready:
                    raise RuntimeError("ASR model failed to load")
                transcript = active_asr_engine.transcribe(wav_path)
                check = asr_compare(srt_text, transcript)
                with asr_results_lock:
                    asr_results[position] = {
                        "content_status": check.status,
                        "similarity": check.similarity,
                        "wer": check.wer,
                    }
                emit(
                    "segment_asr_result",
                    position=position, index=index,
                    content_status=check.status, similarity=check.similarity, wer=check.wer,
                )
            except Exception as exc:  # ASR itself failing is a content fail, not a crash
                with asr_results_lock:
                    asr_results[position] = {
                        "content_status": "CONTENT_WRONG",
                        "similarity": 0.0, "wer": 1.0,
                    }
                emit(
                    "segment_asr_result",
                    position=position, index=index,
                    content_status="CONTENT_WRONG", similarity=0.0, wer=1.0,
                    message=str(exc),
                )
            finally:
                asr_queue.task_done()

    def drain_asr_queue() -> None:
        """Run a fresh ASR worker pool over whatever is queued right now.

        Workers are spawned only here, after the TTS pass that filled the
        queue has already finished (every ``asr_queue.put`` call in this
        module happens inside a completed ``submit_pass``), so ASR never
        competes with TTS threads for CPU. The pool exits once the backlog
        is drained, leaving no thread idling on the queue in between passes.
        """
        pool = [
            threading.Thread(target=asr_worker_loop, name=f"asr-worker-{i}", daemon=True)
            for i in range(asr_plan.num_workers)
        ]
        for thread in pool:
            thread.start()
        asr_queue.join()
        for _ in pool:
            asr_queue.put(None)
        for thread in pool:
            thread.join(timeout=30)

    build_parent = Path(tempfile.mkdtemp(prefix="zsp_build_"))
    build_dir = build_parent / "build"
    audio_dir = build_dir / "audio_cache"
    audio_dir.mkdir(parents=True)
    error_dir = destination.parent / ERROR_SEGMENTS_DIRNAME
    if selected_model == MELOTTS_MODEL:
        # Keep failed takes from the optional engine separate from VieNeu's
        # historical error directory; the retry caches are likewise isolated
        # by the Electron main process.
        error_dir = error_dir / f"melotts_{melo_language}_{melo_speaker or 'default'}"
    try:
        emit("status", message="Loading TTS model...")
        active_engine.load_model()
        emit("status", message=_voice_status(selected_model))
        voice = active_engine.clone_voice(reference_path)
        subtitles = parse_srt(subtitle_path)
        total = len(subtitles)
        # Snapshot the user's selection for this session; a later change to the
        # selector applies to the next run instead of resizing this pool.
        processors, problem = validate_processor_count(max_workers)
        if problem:
            report(problem)
        workers = max(1, min(processors, total))
        narrate(f"{total} subtitles found. Using {workers} worker(s).\n")
        emit("started", total=total, workers=workers, processors=processors)

        state_lock = threading.Lock()
        state_entries: dict[int, dict[str, object]] = {}
        cached_checks: dict[int, TimingCheck] = {}
        cached_speeds: dict[int, float | None] = {}
        if state_dir is not None and state_audio_dir is not None:
            state_file = state_dir / "entries.jsonl"
            try:
                journal = state_file.read_text(encoding="utf-8")
            except (OSError, ValueError):
                journal = ""
            for line in journal.splitlines():
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        continue
                    position = record.get("position")
                    value = record.get("entry")
                    if (
                        not isinstance(position, int)
                        or isinstance(position, bool)
                        or not isinstance(value, dict)
                    ):
                        continue
                except ValueError:
                    continue
                filename = _safe_journal_filename(value.get("audio_filename"))
                if (
                    filename is None
                    or not 0 <= position < total
                    or not (state_audio_dir / filename).is_file()
                ):
                    continue
                cached = state_audio_dir / filename
                audio_meta = value.get("audio")
                already_matched = (
                    isinstance(audio_meta, dict)
                    and audio_meta.get("duration_matched") is True
                    and isinstance(audio_meta.get("speech_duration"), (int, float))
                )
                try:
                    measured = wav_duration_seconds(cached)
                    target_duration = subtitles[position].duration_seconds
                    # A marker alone is insufficient: also verify the actual PCM
                    # frame duration so interrupted/manual cache edits are caught.
                    if already_matched and abs(measured - target_duration) <= (1.0 / 24_000):
                        speech_duration = float(audio_meta["speech_duration"])
                        timing = evaluate_timing(
                            speech_duration,
                            subtitles[position].start_ms / 1000.0,
                            subtitles[position].end_ms / 1000.0,
                        )
                        timing_meta = value.get("timing")
                        stored_speed = timing_meta.get("speed") if isinstance(timing_meta, dict) else None
                        speed = (
                            float(stored_speed)
                            if isinstance(stored_speed, (int, float))
                            and not isinstance(stored_speed, bool)
                            and math.isfinite(float(stored_speed))
                            and float(stored_speed) > 0
                            else None
                        )
                    else:
                        outcome = _duration_match_existing(cached, subtitles[position])
                        assert outcome.timing is not None
                        timing = outcome.timing
                        value = dict(value)
                        value["audio"] = {
                            "raw_duration": outcome.raw_duration,
                            "speech_duration": outcome.trimmed_duration,
                            "final_duration": outcome.final_duration,
                            "duration_matched": True,
                        }
                        value["timing"] = {
                            "status": timing.status,
                            "required_speed": timing.required_speed,
                            "speed": outcome.speed,
                            "quality": timing.quality,
                            "action": outcome.duration_action,
                        }
                        with state_file.open("a", encoding="utf-8") as stream:
                            stream.write(_journal_record(position, value))
                        report(f"Upgraded cached audio: {_duration_report(subtitles[position], outcome)}")
                        speed = outcome.speed
                except Exception as exc:
                    report(f"Discarding cached audio {filename}: {exc}")
                    continue
                state_entries[position] = value
                cached_checks[position] = timing
                cached_speeds[position] = speed

        pending = [
            (position, subtitle)
            for position, subtitle in enumerate(subtitles)
            if position not in state_entries
        ]
        # Snapshot which positions were resumed from a *previous* run's journal
        # before this run's own PASS 1 has a chance to write anything into
        # state_entries. content_fail_positions (below) must only exclude
        # these truly-previously-validated positions, never this run's own
        # fresh PASS 1 successes -- state_entries is the same live dict PASS 1
        # writes into, so checking against it directly there would wrongly
        # exclude every success this run just produced.
        resumed_positions = frozenset(state_entries)
        if state_entries:
            emit("resumed", completed=total - len(pending), total=total)
            for position in sorted(state_entries):
                entry = state_entries[position]
                timing = cached_checks[position]
                emit(
                    "segment_result",
                    position=position,
                    index=entry.get("index"),
                    status=STATUS_SUCCESS,
                    attempts=1,
                    start=subtitles[position].start,
                    end=subtitles[position].end,
                    timing_status=timing.status,
                    speech_duration=timing.speech_duration,
                    speed=cached_speeds[position],
                    audio_filename=entry.get("audio_filename"),
                    resumed=True,
                )

        timestamp_seed = int(time.time() * 1000)
        completed = len(state_entries)
        completed_lock = threading.Lock()
        failures: list[dict[str, object]] = []
        failures_lock = threading.Lock()
        # Currently never set: a subtitle exhausting its duration retries is
        # recorded as a per-line failure and no longer halts the rest of the
        # queue. Kept so a future stop-request feature has a hook to use.
        stop_event = threading.Event()

        def save_entry(position: int, entry: dict[str, object]) -> None:
            if state_dir is None:
                return
            state_file = state_dir / "entries.jsonl"
            with state_file.open("a", encoding="utf-8") as stream:
                stream.write(_journal_record(position, entry))

        def discard_entry(position: int) -> None:
            """Retract any journal line already on disk for ``position``.

            PASS 1 journals every successful generation immediately, before
            content (ASR) validation has had a chance to run (see the NOTE
            above) -- so a position that goes on to exhaust every
            content-retry attempt already has a provisional "success" line
            written for it by the time that is known. The append-only
            journal has no other way to retract a stale line, so this
            rewrites the file with any line for ``position`` removed,
            ensuring a later run against the same state_dir never resumes
            content-mismatched audio as if it were already validated.
            """
            if state_dir is None:
                return
            with state_lock:
                state_entries.pop(position, None)
                state_file = state_dir / "entries.jsonl"
                try:
                    lines = state_file.read_text(encoding="utf-8").splitlines()
                except (OSError, ValueError):
                    return
                kept: list[str] = []
                changed = False
                for line in lines:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        kept.append(line)
                        continue
                    if isinstance(record, dict) and record.get("position") == position:
                        changed = True
                        continue
                    kept.append(line)
                if changed:
                    state_file.write_text(
                        "".join(f"{line}\n" for line in kept), encoding="utf-8"
                    )

        # NOTE: content_status/similarity here can read "PENDING_ASR" if the ASR
        # worker has not finished this position yet -- the journal's `content`
        # block is best-effort metadata, not the source of truth for retry
        # decisions (that's asr_results, read after drain_asr_queue()).
        def build_entry(
            subtitle: Subtitle,
            filename: str,
            outcome: SegmentOutcome,
            content_status: str,
            similarity: float,
        ) -> dict[str, object]:
            assert outcome.timing is not None
            timing = outcome.timing
            return {
                "index": subtitle.index,
                "start": subtitle.start,
                "end": subtitle.end,
                "content": subtitle.content,
                "speaker_name": _speaker_name(active_engine, reference_path),
                "audio_filename": filename,
                "audio": {
                    "raw_duration": outcome.raw_duration,
                    "speech_duration": outcome.trimmed_duration,
                    "final_duration": outcome.final_duration,
                    "duration_matched": True,
                },
                "timing": {
                    "status": timing.status,
                    "required_speed": timing.required_speed,
                    "speed": outcome.speed,
                    "quality": timing.quality,
                    "action": outcome.duration_action,
                },
                "content_check": {"status": content_status, "similarity": similarity},
            }

        def record_failure(
            position: int, subtitle: Subtitle, outcome: SegmentOutcome, reason: str,
        ) -> dict[str, object]:
            failure: dict[str, object] = {
                "position": position + 1,
                "index": subtitle.index,
                "content": subtitle.content,
                "message": outcome.error,
                "reason": reason,
                "attempts": outcome.attempts,
                "filename": outcome.filename,
            }
            with failures_lock:
                failures.append(failure)
            emit("item_error", **failure)
            return failure

        def synthesize_one(
            position: int, subtitle: Subtitle, count_progress: bool = True
        ) -> dict[str, object]:
            nonlocal completed
            if stop_event.is_set():
                emit("segment_skipped", position=position, index=subtitle.index)
                return {
                    "position": position,
                    "index": subtitle.index,
                    "status": STATUS_SKIPPED,
                }
            preview = _preview(subtitle)
            filename = f"line_{subtitle.index}_{timestamp_seed + position}_{uuid.uuid4().hex[:8]}.wav"
            emit("segment_started", position=position, index=subtitle.index)

            def notify(event: str, attempt: int, timing: TimingCheck | None) -> None:
                if event == "retry":
                    emit(
                        "segment_retry", position=position, index=subtitle.index,
                        attempt=attempt, max_attempts=MAX_GENERATION_ATTEMPTS,
                    )
                    narrate(
                        f"Subtitle #{subtitle.index} generation failed once. "
                        f"Auto retry {attempt}/{MAX_GENERATION_ATTEMPTS - 1}."
                    )
                else:
                    narrate(
                        f"Subtitle #{subtitle.index} succeeded on retry "
                        f"{attempt - 1}/{MAX_GENERATION_ATTEMPTS - 1}."
                    )

            outcome = generate_segment(
                active_engine, voice, audio_dir, subtitle, filename,
                notify=notify, error_dir=error_dir,
            )
            common: dict[str, object] = {
                "position": position, "index": subtitle.index, "attempts": outcome.attempts,
                "start": subtitle.start, "end": subtitle.end,
            }
            if outcome.timing is not None:
                common.update(
                    timing_status=outcome.timing.status,
                    speech_duration=outcome.timing.speech_duration,
                    required_speed=outcome.timing.required_speed,
                    target_duration=outcome.timing.target_duration,
                    raw_duration=outcome.raw_duration,
                    trimmed_duration=outcome.trimmed_duration,
                    final_duration=outcome.final_duration,
                    final_error=outcome.final_error,
                    duration_action=outcome.duration_action,
                    timing_quality=outcome.timing.quality,
                    speed=outcome.speed,
                )

            if outcome.ok:
                report(_duration_report(subtitle, outcome))
                content_status = asr_results.get(position, {}).get("content_status", "PENDING_ASR")
                similarity = float(asr_results.get(position, {}).get("similarity", 0.0))
                entry = build_entry(subtitle, filename, outcome, content_status, similarity)
                wav_path = audio_dir / filename
                if state_dir is not None and state_audio_dir is not None:
                    shutil.copy2(wav_path, state_audio_dir / filename)
                if count_progress:
                    with completed_lock:
                        completed += 1
                        current = completed
                    if state_dir is not None and state_audio_dir is not None:
                        with state_lock:
                            state_entries[position] = entry
                            save_entry(position, entry)
                    if event_callback is None:
                        with _PRINT_LOCK:
                            print(f"[{current:03d}/{total}] {preview}", flush=True)
                    emit("progress", completed=current, total=total, entry=entry)
                emit(
                    "segment_result", status=STATUS_SUCCESS, audio_filename=filename, **common
                )
                if validate_content:
                    asr_queue.put((position, subtitle.index, audio_dir / filename, subtitle.content))
                return {
                    "position": position, "index": subtitle.index,
                    "status": STATUS_SUCCESS, "entry": entry,
                }

            failure = record_failure(position, subtitle, outcome, FAILURE_REASON_GENERATION)
            emit(
                "segment_result", status=STATUS_FAIL, reason=FAILURE_REASON_GENERATION,
                message=outcome.error, audio_filename="", **common,
            )
            return {
                "position": position, "index": subtitle.index,
                "status": STATUS_FAIL, "failure": failure,
            }

        MAX_CONTENT_ATTEMPTS = 3

        def submit_pass(
            position_subtitles: list[tuple[int, Subtitle]], count_progress: bool = True,
        ) -> list[dict[str, object]]:
            pass_results: list[dict[str, object]] = []
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tts") as inner_pool:
                inner_futures = {
                    inner_pool.submit(synthesize_one, position, subtitle, count_progress): position
                    for position, subtitle in position_subtitles
                }
                for future in as_completed(inner_futures):
                    pass_results.append(future.result())
            return pass_results

        ordered: list[dict[str, object] | None] = [state_entries.get(i) for i in range(total)]
        results = submit_pass(pending)
        for result in results:
            if result["status"] == STATUS_SUCCESS:
                ordered[int(result["position"])] = result["entry"]

        # Synthesis reaching 100% does not mean the run is done: the ASR
        # queue still has to drain (and, below, possibly run content-retry
        # passes) before "complete" fires. Neither step emits a progress
        # event, so without this status line a perfectly healthy run looks
        # stuck at 100% for however long that takes.
        if validate_content:
            emit("status", message="Validating audio content...")
            drain_asr_queue()

        # Positions whose content check failed (or is still pending, meaning the
        # ASR worker had no chance to run because generation itself failed) go
        # through up to MAX_CONTENT_ATTEMPTS-1 more passes, isolated from the
        # rest of the batch -- never interleaved line-by-line.
        attempt_no = 1
        content_fail_positions = [
            position for position in range(total)
            if position not in resumed_positions
            and asr_results.get(position, {}).get("content_status") not in (None, "CONTENT_OK")
        ]
        attempt_similarity: dict[int, list[tuple[int, float, dict[str, object]]]] = {}
        for position in content_fail_positions:
            attempt_similarity[position] = [
                (1, float(asr_results.get(position, {}).get("similarity", 0.0)), ordered[position])
            ]

        while content_fail_positions and attempt_no < MAX_CONTENT_ATTEMPTS:
            attempt_no += 1
            emit(
                "status",
                message=(
                    f"Retrying {len(content_fail_positions)} content-failed line(s) "
                    f"(attempt {attempt_no}/{MAX_CONTENT_ATTEMPTS})..."
                ),
            )
            retry_subtitles = [(position, subtitles[position]) for position in content_fail_positions]
            retry_results = submit_pass(retry_subtitles, count_progress=False)
            drain_asr_queue()
            still_failing: list[int] = []
            for result in retry_results:
                position = int(result["position"])
                if result["status"] == STATUS_SUCCESS:
                    entry = result["entry"]
                    similarity = float(asr_results.get(position, {}).get("similarity", 0.0))
                    attempt_similarity[position].append((attempt_no, similarity, entry))
                    content_status = asr_results.get(position, {}).get("content_status")
                    if content_status != "CONTENT_OK":
                        still_failing.append(position)
            content_fail_positions = still_failing

        # For every position that went through a retry, keep the attempt with
        # the highest similarity and delete the rest. A position still failing
        # after every attempt must NEVER be journaled as a success -- archive
        # its best (still-wrong) attempt instead and report it as a failure;
        # only a position that ultimately passed content validation gets
        # persisted into the resume journal. (Fixes a bug where an exhausted
        # position's stale "success" journal line let a later "Retry Failed"
        # run silently resume content-mismatched audio without re-validating.)
        final_content_fail_positions = set(content_fail_positions)
        for position, attempts in attempt_similarity.items():
            best_attempt_no, _best_similarity, best_entry = max(attempts, key=lambda item: item[1])
            for attempt_no_seen, _similarity, entry in attempts:
                filename = str(entry["audio_filename"])
                if attempt_no_seen != best_attempt_no and (audio_dir / filename).exists():
                    (audio_dir / filename).unlink()
                    if state_audio_dir is not None:
                        (state_audio_dir / filename).unlink(missing_ok=True)

            if position not in final_content_fail_positions:
                ordered[position] = best_entry
                if state_dir is not None:
                    with state_lock:
                        state_entries[position] = best_entry
                        save_entry(position, best_entry)
                continue

            subtitle = subtitles[position]
            best_filename = str(best_entry["audio_filename"])
            content_status = asr_results.get(position, {}).get("content_status", "CONTENT_WRONG")
            message = f"content validation failed: {content_status}"
            _archive_failed_segment(
                audio_dir / best_filename, error_dir, best_filename, attempt_no, content_status, message
            )
            if state_dir is not None:
                discard_entry(position)
                if state_audio_dir is not None:
                    (state_audio_dir / best_filename).unlink(missing_ok=True)
            failure = {
                "position": position + 1,
                "index": subtitle.index,
                "content": subtitle.content,
                "message": message,
                "reason": content_status,
                "attempts": attempt_no,
                "filename": best_filename,
            }
            with failures_lock:
                failures.append(failure)
            emit("item_error", **failure)
            emit(
                "segment_result",
                status=STATUS_FAIL,
                reason=failure["reason"],
                message=failure["message"],
                audio_filename="",
                position=position,
                index=subtitle.index,
                attempts=attempt_no,
                start=subtitle.start,
                end=subtitle.end,
            )
            ordered[position] = None

        if stop_event.is_set():
            skipped = sorted(
                (item for item in results if item["status"] == STATUS_SKIPPED),
                key=lambda item: int(item["position"]),
            )
            stopped_by = next(
                (item for item in results if item["status"] == STATUS_FAIL),
                None,
            )
            emit(
                "stopped",
                index=stopped_by["index"] if stopped_by else None,
                processed=sum(item["status"] != STATUS_SKIPPED for item in results),
                completed=sum(item is not None for item in ordered),
                total=total,
                skipped=[
                    {
                        "position": item["position"],
                        "index": item["index"],
                        "start": subtitles[int(item["position"])].start,
                        "end": subtitles[int(item["position"])].end,
                    }
                    for item in skipped
                ],
            )

        if failures:
            emit(
                "failed",
                failures=failures,
                completed=sum(item is not None for item in ordered),
                total=total,
            )
            raise GenerationFailed(failures)

        entries = [entry for entry in ordered if entry is not None]
        elapsed = time.perf_counter() - started_at
        print(f"Total processing time: {format_elapsed(elapsed)}")
        print(f"Finished:\n{destination}")
        # Packaging into the .zsp is no longer automatic: the GUI's "Save
        # Project" action (package_build(), below) does it on demand, so a
        # build that still has failed/warning lines can be saved too, and a
        # run that raises GenerationFailed still leaves state_dir intact for
        # it. state_dir is only ever cleared by a fresh (non-retry) run
        # starting, or by the app quitting -- never by run() itself.
        emit("complete", destination=str(destination), elapsed=format_elapsed(elapsed), entries=entries)
        return destination
    finally:
        active_engine.close()
        if active_asr_engine is not None:
            active_asr_engine.close()
        shutil.rmtree(build_parent, ignore_errors=True)


def package_build(state_dir: Path, destination: Path) -> Path:
    """Zip whatever the resume journal currently has into ``destination``.

    Decoupled from ``run()``: reads ``state_dir/entries.jsonl`` (the same
    journal ``run()`` and ``regenerate_segment()`` maintain) and the WAVs it
    points to in ``state_dir/audio_cache``, so a build that still has
    failed or warning lines can still be saved -- this is what the GUI's
    manual "Save Project" button calls. A position with no on-disk audio
    (never generated, or discarded after exhausting content-retry) is
    skipped; a position journaled more than once (a line regenerated more
    than once) uses its last journal entry, same as ``run()``'s own resume
    loader.
    """
    state_dir = state_dir.resolve()
    destination = destination.resolve()
    state_audio_dir = _state_audio_dir(state_dir)
    assert state_audio_dir is not None
    try:
        lines = (state_dir / "entries.jsonl").read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        lines = []
    latest: dict[int, dict[str, object]] = {}
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        position = record.get("position")
        value = record.get("entry")
        if not isinstance(position, int) or isinstance(position, bool) or not isinstance(value, dict):
            continue
        filename = _safe_journal_filename(value.get("audio_filename"))
        if filename is None or not (state_audio_dir / filename).is_file():
            continue
        latest[position] = value
    entries = [latest[position] for position in sorted(latest)]
    if not entries:
        raise ValueError("nothing to save yet: no subtitle line has finished generating audio")

    build_parent = Path(tempfile.mkdtemp(prefix="zsp_save_"))
    build_dir = build_parent / "build"
    audio_dir = build_dir / "audio_cache"
    audio_dir.mkdir(parents=True)
    try:
        for entry in entries:
            filename = str(entry["audio_filename"])
            shutil.copy2(state_audio_dir / filename, audio_dir / filename)
        project_entries = [
            {field: entry[field] for field in PROJECT_FIELDS} for entry in entries
        ]
        (build_dir / "project.json").write_text(
            json.dumps(project_entries, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        try:
            create_zsp(build_dir, destination)
        except ZSPValidationError:
            raise
        except Exception as exc:
            raise RuntimeError(f"ZSP packaging failed: {exc}") from exc
    finally:
        shutil.rmtree(build_parent, ignore_errors=True)
    return destination


def validate_build(
    subtitle_path: Path,
    state_dir: Path,
    *,
    asr_workers: int | str | None = None,
    asr_engine: ASREngine | None = None,
    event_callback: EventCallback | None = None,
) -> None:
    """Run ASR content validation once over whatever audio the build already has.

    Single pass, no regeneration and no journal changes -- this is what the
    GUI's manual "Validate Now" button calls when a run finished with the
    Validate checkbox left unticked. A line whose content check fails is
    reported through ``segment_asr_result`` exactly like a normal run; the
    caller (the renderer) decides how to flag it, and the user retries it
    manually if they want a different take.
    """

    def emit(kind: str, **payload: object) -> None:
        if event_callback is not None:
            event_callback(kind, payload)

    subtitle_path = subtitle_path.resolve()
    state_dir = state_dir.resolve()
    if not subtitle_path.is_file():
        raise FileNotFoundError(f"subtitle file not found: {subtitle_path}")
    parse_srt(subtitle_path)  # validates the file; the journal already carries each line's content
    state_audio_dir = _state_audio_dir(state_dir)
    assert state_audio_dir is not None

    try:
        lines = (state_dir / "entries.jsonl").read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        lines = []
    latest: dict[int, dict[str, object]] = {}
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        position = record.get("position")
        value = record.get("entry")
        if not isinstance(position, int) or isinstance(position, bool) or not isinstance(value, dict):
            continue
        filename = _safe_journal_filename(value.get("audio_filename"))
        if filename is None or not (state_audio_dir / filename).is_file():
            continue
        latest[position] = value

    targets = sorted(latest.items())
    emit("validation_started", total=len(targets))
    if not targets:
        emit("validation_complete", total=0)
        return

    asr_plan, asr_plan_warning = resolve_asr_cpu_plan(asr_workers)
    if asr_plan_warning:
        emit("log", message=asr_plan_warning)
    active_asr_engine = asr_engine or WhisperASREngine(
        num_workers=asr_plan.num_workers, cpu_threads=asr_plan.cpu_threads
    )
    active_asr_engine.load_model()
    try:
        for position, entry in targets:
            wav_path = state_audio_dir / str(entry["audio_filename"])
            index = entry.get("index")
            try:
                transcript = active_asr_engine.transcribe(wav_path)
                check = asr_compare(str(entry.get("content", "")), transcript)
                emit(
                    "segment_asr_result",
                    position=position, index=index,
                    content_status=check.status, similarity=check.similarity, wer=check.wer,
                )
            except Exception as exc:  # ASR itself failing is a content fail, not a crash
                emit(
                    "segment_asr_result",
                    position=position, index=index,
                    content_status="CONTENT_WRONG", similarity=0.0, wer=1.0,
                    message=str(exc),
                )
    finally:
        active_asr_engine.close()
    emit("validation_complete", total=len(targets))


def _json_event(kind: str, payload: dict[str, object]) -> None:
    line = "SRT_STUDIO_EVENT " + json.dumps({"type": kind, **payload}, ensure_ascii=False)
    with _PRINT_LOCK:
        print(line, flush=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SRT to ZSP synthesis worker")
    parser.add_argument("--subtitle", type=Path)
    parser.add_argument("--voice", type=Path)
    parser.add_argument("--output", type=Path)
    # Kept as text so validate_processor_count(), not argparse, decides what a
    # usable count is: a bad value falls back to the default with a message
    # instead of aborting the run before it starts.
    parser.add_argument("--workers", type=str)
    # Kept as text for the same reason as --workers: resolve_asr_cpu_plan()
    # decides Auto-vs-explicit and validates, not argparse.
    parser.add_argument("--asr-workers", type=str)
    parser.add_argument("--json-events", action="store_true")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument(
        "--tts-model",
        default=DEFAULT_TTS_MODEL,
        help="TTS engine: vieneu (default) or melotts",
    )
    parser.add_argument(
        "--melo-language",
        default="EN",
        help="MeloTTS language: EN, ES, FR, ZH, JP, or KR",
    )
    parser.add_argument(
        "--melo-speaker",
        help="MeloTTS built-in speaker name (defaults to the language's first speaker)",
    )
    parser.add_argument(
        "--regenerate",
        action="store_true",
        help="regenerate a single subtitle into the retry cache and exit",
    )
    parser.add_argument("--position", type=int, help="0-based subtitle position to regenerate")
    parser.add_argument(
        "--validate-content",
        action="store_true",
        help="run ASR content validation after synthesis (off by default: TTS only)",
    )
    parser.add_argument(
        "--package-only",
        action="store_true",
        help="package state_dir's current journal into --output and exit",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="run ASR content validation over state_dir's current audio and exit",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_streams()
    args = _parser().parse_args(argv)
    callback = _json_event if args.json_events else None
    try:
        if args.regenerate:
            regenerate_segment(
                subtitle_path=args.subtitle,
                reference_path=args.voice,
                position=args.position,
                state_dir=args.state_dir,
                event_callback=callback,
                validate_content=args.validate_content,
                tts_model=args.tts_model,
                melo_language=args.melo_language,
                melo_speaker=args.melo_speaker,
            )
            # A rejected take is a normal outcome, reported through
            # ``segment_result``; only a hard error returns a failure code.
            return 0
        if args.package_only:
            if args.state_dir is None or args.output is None:
                raise ValueError("--package-only needs --state-dir and --output")
            destination = package_build(args.state_dir, args.output)
            if callback:
                callback("packaged", {"destination": str(destination)})
            return 0
        if args.validate_only:
            if args.state_dir is None or args.subtitle is None:
                raise ValueError("--validate-only needs --state-dir and --subtitle")
            validate_build(
                args.subtitle, args.state_dir,
                asr_workers=args.asr_workers, event_callback=callback,
            )
            return 0
        if args.state_dir is None:
            raise ValueError(
                "--state-dir is required: run() only persists generated audio "
                "into state_dir/audio_cache -- without it, every line is "
                "generated and then discarded when the process exits."
            )
        run(subtitle_path=args.subtitle, reference_path=args.voice, destination=args.output,
            max_workers=args.workers, asr_workers=args.asr_workers,
            event_callback=callback, state_dir=args.state_dir,
            validate_content=args.validate_content, tts_model=args.tts_model,
            melo_language=args.melo_language, melo_speaker=args.melo_speaker)
        return 0
    except FileNotFoundError as exc:
        message = str(exc)
    except SubtitleParseError as exc:
        message = f"subtitle parsing failed: {exc}"
    except TTSEngineError as exc:
        message = str(exc)
    except (MeloTTSEngineError, TTSSelectionError) as exc:
        message = str(exc)
    except ZSPValidationError as exc:
        message = f"ZSP validation failed: {exc}"
    except GenerationFailed as exc:
        message = str(exc)
    except Exception as exc:
        message = str(exc)
    if callback:
        callback("error", {"message": message})
    print(f"\nERROR: {message}", file=sys.stderr, flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
