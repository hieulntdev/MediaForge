"""Silence trimming and sample-accurate SRT duration matching for TTS WAVs."""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
from pathlib import Path
import subprocess
import wave

import numpy as np
import soundfile as sf


def _env_float(name: str, default: float, *, minimum: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if math.isfinite(parsed) and parsed >= minimum else default


# Every value is overridable without changing the GUI/backend API. Defaults are
# conservative: only outer silence is inspected and context stays around speech.
SILENCE_THRESHOLD_DBFS = _env_float("SRT_STUDIO_SILENCE_THRESHOLD_DBFS", -40.0, minimum=-120.0)
SILENCE_FRAME_MS = _env_float("SRT_STUDIO_SILENCE_FRAME_MS", 20.0, minimum=1.0)
SILENCE_PAD_LEAD = _env_float("SRT_STUDIO_SILENCE_PAD_LEAD", 0.05, minimum=0.0)
SILENCE_PAD_TRAIL = _env_float("SRT_STUDIO_SILENCE_PAD_TRAIL", 0.10, minimum=0.0)
DURATION_TOLERANCE_SECONDS = _env_float("SRT_STUDIO_DURATION_TOLERANCE_MS", 20.0, minimum=0.0) / 1000.0
QUALITY_WARNING_SPEED = _env_float("SRT_STUDIO_QUALITY_WARNING_SPEED", 1.25, minimum=1.0)
SEVERE_WARNING_SPEED = max(
    QUALITY_WARNING_SPEED,
    _env_float("SRT_STUDIO_SEVERE_WARNING_SPEED", 1.45, minimum=1.0),
)
# Backwards-compatible export. It is a warning threshold, not a hard limit.
MAX_TIME_STRETCH_SPEED = QUALITY_WARNING_SPEED


class DurationValidationError(RuntimeError):
    """Raised when audio or the requested SRT duration is invalid."""


class TimeStretchError(RuntimeError):
    """Raised when FFmpeg cannot produce a safe duration-matched WAV."""


def wav_duration_seconds(path: Path) -> float:
    """Read exact PCM duration from the WAV frame count."""
    try:
        with wave.open(str(path), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
    except (OSError, EOFError, wave.Error) as exc:
        raise DurationValidationError(f"{path.name}: cannot read WAV duration: {exc}") from exc
    if rate <= 0:
        raise DurationValidationError(f"{path.name}: WAV reports an invalid sample rate")
    if frames <= 0:
        raise DurationValidationError(f"{path.name}: WAV contains no audio frames")
    return frames / float(rate)


@dataclass(frozen=True)
class SpeechBoundary:
    has_speech: bool
    start: float
    end: float


def _dbfs_threshold_amplitude(threshold_dbfs: float) -> float:
    return 10 ** (threshold_dbfs / 20.0)


def detect_speech_boundary(
    path: Path,
    threshold_dbfs: float = SILENCE_THRESHOLD_DBFS,
    frame_ms: float = SILENCE_FRAME_MS,
) -> SpeechBoundary:
    """Find only the first and last audible frame; internal pauses are retained."""
    samples, rate = sf.read(str(path), dtype="float64", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    total_frames = len(samples)
    if total_frames == 0 or rate <= 0:
        return SpeechBoundary(False, 0.0, 0.0)

    frame_size = max(1, int(rate * frame_ms / 1000.0))
    threshold = _dbfs_threshold_amplitude(threshold_dbfs)
    loud: list[bool] = []
    for offset in range(0, total_frames, frame_size):
        chunk = samples[offset:offset + frame_size]
        rms = float(np.sqrt(np.mean(np.square(chunk)))) if len(chunk) else 0.0
        loud.append(rms >= threshold)
    if not any(loud):
        return SpeechBoundary(False, 0.0, 0.0)

    first_loud = next(i for i, value in enumerate(loud) if value)
    last_loud = len(loud) - 1 - next(i for i, value in enumerate(reversed(loud)) if value)
    return SpeechBoundary(
        True,
        (first_loud * frame_size) / rate,
        min(total_frames, (last_loud + 1) * frame_size) / rate,
    )


def trim_silence(
    src: Path,
    dst: Path,
    boundary: SpeechBoundary,
    pad_lead: float = SILENCE_PAD_LEAD,
    pad_trail: float = SILENCE_PAD_TRAIL,
) -> None:
    """Keep the speech span, safety padding, and every pause inside it."""
    if not boundary.has_speech:
        raise DurationValidationError(f"{src.name}: audio is silence end to end")
    samples, rate = sf.read(str(src), dtype="int16", always_2d=False)
    start_sample = max(0, int(round((boundary.start - pad_lead) * rate)))
    end_sample = min(len(samples), int(round((boundary.end + pad_trail) * rate)))
    if end_sample <= start_sample:
        raise DurationValidationError(f"{src.name}: silence trim produced empty audio")
    sf.write(str(dst), samples[start_sample:end_sample], rate, subtype="PCM_16")


@dataclass(frozen=True)
class TimingCheck:
    status: str  # TIMING_OK | SPEED_ADJUST | TIMING_WARNING
    speech_duration: float
    allowed_duration: float  # compatibility alias for target_duration
    required_speed: float
    quality: str = "normal"  # normal | warning | severe

    @property
    def target_duration(self) -> float:
        return self.allowed_duration

    def describe(self) -> str:
        return (
            f"{self.status}: speech {self.speech_duration:.3f}s, "
            f"target {self.target_duration:.3f}s, speed {self.required_speed:.3f}x, "
            f"quality={self.quality}"
        )


def evaluate_timing(
    speech_duration: float,
    slot_start: float,
    slot_end: float,
    tolerance: float = DURATION_TOLERANCE_SECONDS,
    max_speed: float = QUALITY_WARNING_SPEED,
) -> TimingCheck:
    """Classify timing against the real SRT slot, never ``slot + tolerance``."""
    target = float(slot_end) - float(slot_start)
    if not math.isfinite(target) or target <= 0:
        raise DurationValidationError("subtitle duration must be greater than zero")
    if not math.isfinite(speech_duration) or speech_duration <= 0:
        raise DurationValidationError("audio duration must be greater than zero")

    required_speed = speech_duration / target
    if speech_duration <= target + max(0.0, tolerance):
        status, quality = "TIMING_OK", "normal"
    elif required_speed <= max_speed:
        status, quality = "SPEED_ADJUST", "normal"
    elif required_speed <= SEVERE_WARNING_SPEED:
        status, quality = "TIMING_WARNING", "warning"
    else:
        status, quality = "TIMING_WARNING", "severe"
    return TimingCheck(status, speech_duration, target, required_speed, quality)


def _atempo_chain(speed: float) -> str:
    """Build a chain whose individual factors stay in FFmpeg's [0.5, 2.0]."""
    if not math.isfinite(speed) or speed <= 0:
        raise ValueError("time-stretch speed must be a positive finite number")
    factors: list[float] = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    if not math.isclose(remaining, 1.0, rel_tol=0.0, abs_tol=1e-9) or not factors:
        factors.append(remaining)
    return ",".join(f"atempo={factor:.9f}" for factor in factors)


def time_stretch(src: Path, dst: Path, speed: float) -> None:
    """Pitch-preserving time-stretch with safely chained ``atempo`` filters."""
    try:
        info = sf.info(str(src))
    except Exception as exc:
        raise TimeStretchError(f"cannot inspect {src.name}: {exc}") from exc
    if info.frames <= 0 or info.samplerate <= 0:
        raise TimeStretchError(f"{src.name}: source WAV is empty or invalid")
    filter_graph = _atempo_chain(speed)
    try:
        result = subprocess.run(
            [
                os.environ.get("MEDIAFORGE_FFMPEG", "ffmpeg"),
                "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(src), "-filter:a", filter_graph,
                "-ar", str(info.samplerate), "-c:a", "pcm_s16le", str(dst),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise TimeStretchError(
            "ffmpeg was not found on PATH; install it (macOS: `brew install ffmpeg`) "
            "to duration-match over-long VieNeu segments"
        ) from exc
    if result.returncode != 0 or not dst.is_file() or dst.stat().st_size == 0:
        dst.unlink(missing_ok=True)
        tail = result.stderr.decode("utf-8", errors="replace")[-800:]
        raise TimeStretchError(f"ffmpeg atempo failed (exit {result.returncode}): {tail}")


def _align_pcm_frames(src: Path, dst: Path, target_duration: float, tolerance: float) -> float:
    """Pad short output or remove only a tolerance-sized rounding tail."""
    samples, rate = sf.read(str(src), dtype="int16", always_2d=True)
    if rate <= 0 or len(samples) == 0:
        raise DurationValidationError(f"{src.name}: output audio is empty or invalid")
    target_frames = int(round(target_duration * rate))
    if target_frames <= 0:
        raise DurationValidationError("subtitle duration is shorter than one audio sample")
    delta = len(samples) - target_frames
    if delta > int(math.ceil(max(0.0, tolerance) * rate)):
        raise TimeStretchError(
            f"duration correction remained {delta / rate:.3f}s too long; "
            "refusing to cut speech outside tolerance"
        )
    if delta < 0:
        padding = np.zeros((-delta, samples.shape[1]), dtype=samples.dtype)
        samples = np.concatenate((samples, padding), axis=0)
    elif delta > 0:
        samples = samples[:target_frames]
    output = samples[:, 0] if samples.shape[1] == 1 else samples
    sf.write(str(dst), output, rate, subtype="PCM_16")
    return target_frames / float(rate)


@dataclass(frozen=True)
class DurationMatchResult:
    action: str  # unchanged | padded | aligned | stretched
    input_duration: float
    final_duration: float
    speed_ratio: float
    final_error: float


def match_wav_duration(
    src: Path,
    dst: Path,
    target_duration: float,
    *,
    tolerance: float = DURATION_TOLERANCE_SECONDS,
) -> DurationMatchResult:
    """Write a WAV with exactly the target PCM frame count.

    Long clips are pitch-preservingly accelerated. Short clips keep their
    speaking rate and receive trailing silence. A tiny overrun inside tolerance
    is sample-aligned; larger FFmpeg residuals are recalibrated before cutting.
    """
    if not math.isfinite(target_duration) or target_duration <= 0:
        raise DurationValidationError("subtitle duration must be greater than zero")
    input_duration = wav_duration_seconds(src)
    speed = input_duration / target_duration
    applied_speed = 1.0
    working = src
    temporary_outputs: list[Path] = []
    action = "unchanged"
    try:
        if input_duration > target_duration + max(0.0, tolerance):
            action = "stretched"
            calibrated_speed = speed
            for attempt in range(3):
                candidate = dst.with_name(f".{dst.name}.atempo{attempt}.wav")
                candidate.unlink(missing_ok=True)
                temporary_outputs.append(candidate)
                applied_speed = calibrated_speed
                time_stretch(src, candidate, calibrated_speed)
                produced = wav_duration_seconds(candidate)
                working = candidate
                if produced <= target_duration + max(0.0, tolerance):
                    break
                calibrated_speed *= produced / target_duration
        elif input_duration < target_duration:
            action = "padded"
        elif input_duration > target_duration:
            action = "aligned"

        _align_pcm_frames(working, dst, target_duration, tolerance)
        measured = wav_duration_seconds(dst)
        return DurationMatchResult(
            action=action,
            input_duration=input_duration,
            final_duration=measured,
            # Report the last factor actually passed to FFmpeg. This can be
            # slightly higher than the initial duration ratio when atempo's
            # first output needs a residual-duration correction.
            speed_ratio=applied_speed,
            final_error=measured - target_duration,
        )
    finally:
        for path in temporary_outputs:
            if path != dst:
                path.unlink(missing_ok=True)
