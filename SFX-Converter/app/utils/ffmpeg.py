from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from threading import Event

from app.services.errors import DependencyError, ProcessingCancelled, SFXConverterError

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class FFmpegBinaries:
    ffmpeg: str
    ffprobe: str


def find_binaries() -> FFmpegBinaries:
    ffmpeg = os.environ.get("MEDIAFORGE_FFMPEG") or shutil.which("ffmpeg")
    ffprobe = os.environ.get("MEDIAFORGE_FFPROBE") or shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        missing = ", ".join(name for name, path in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if not path)
        raise DependencyError(f"Could not find {missing}. Install FFmpeg and ensure the executable is on PATH.")
    return FFmpegBinaries(ffmpeg=ffmpeg, ffprobe=ffprobe)


def ffprobe_command(binary: str, input_path: Path) -> list[str]:
    return [
        binary,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(input_path),
    ]


def extract_audio_command(
    binary: str,
    input_path: Path,
    output_path: Path,
    sample_rate: int,
    channels: int,
) -> list[str]:
    return [
        binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        str(channels),
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_f32le",
        str(output_path),
    ]


def run_cancellable(command: list[str], cancel_event: Event | None = None) -> subprocess.CompletedProcess[str]:
    LOGGER.debug("Running command: %s", command)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    while True:
        if cancel_event is not None and cancel_event.is_set():
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise ProcessingCancelled("Processing was cancelled.")
        try:
            stdout, stderr = process.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            continue

    result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown FFmpeg error").strip()
        raise SFXConverterError(f"FFmpeg failed: {detail}")
    return result


def probe_json(binary: str, input_path: Path, cancel_event: Event | None = None) -> dict:
    result = run_cancellable(ffprobe_command(binary, input_path), cancel_event)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SFXConverterError("ffprobe returned invalid data.") from exc
