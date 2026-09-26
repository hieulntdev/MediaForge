from __future__ import annotations

from pathlib import Path
from threading import Event

from app.utils.ffmpeg import extract_audio_command, run_cancellable


class AudioService:
    def extract_for_model(
        self,
        ffmpeg_binary: str,
        input_path: Path,
        output_path: Path,
        sample_rate: int,
        channels: int,
        cancel_event: Event | None = None,
    ) -> None:
        command = extract_audio_command(
            ffmpeg_binary,
            input_path,
            output_path,
            sample_rate=sample_rate,
            channels=channels,
        )
        run_cancellable(command, cancel_event)
