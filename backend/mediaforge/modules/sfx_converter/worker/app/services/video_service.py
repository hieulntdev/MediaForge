from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Event

from app.services.errors import ValidationError
from app.utils.ffmpeg import FFmpegBinaries, find_binaries, probe_json


@dataclass(frozen=True)
class MediaInfo:
    duration_seconds: float | None
    audio_codec: str
    audio_channels: int | None
    audio_sample_rate: int | None


class VideoService:
    def validate(self, input_path: Path, cancel_event: Event | None = None) -> tuple[FFmpegBinaries, MediaInfo]:
        if not input_path.is_file():
            raise ValidationError(f"Video file does not exist: {input_path}")

        binaries = find_binaries()
        data = probe_json(binaries.ffprobe, input_path, cancel_event)
        streams = data.get("streams", [])
        audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
        if not audio_streams:
            raise ValidationError("The video does not contain an audio stream.")

        stream = audio_streams[0]
        duration_value = data.get("format", {}).get("duration") or stream.get("duration")
        try:
            duration = float(duration_value) if duration_value is not None else None
        except (TypeError, ValueError):
            duration = None

        def optional_int(value: object) -> int | None:
            try:
                return int(value) if value is not None else None
            except (TypeError, ValueError):
                return None

        return binaries, MediaInfo(
            duration_seconds=duration,
            audio_codec=str(stream.get("codec_name", "unknown")),
            audio_channels=optional_int(stream.get("channels")),
            audio_sample_rate=optional_int(stream.get("sample_rate")),
        )
