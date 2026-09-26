from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.errors import ValidationError
from app.services.video_service import VideoService
from app.utils.ffmpeg import FFmpegBinaries


def test_video_validation_uses_probe_not_extension(tmp_path: Path) -> None:
    media = tmp_path / "clip.unknown"
    media.touch()
    response = {
        "streams": [{"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000"}],
        "format": {"duration": "4.25"},
    }
    binaries = FFmpegBinaries("ffmpeg", "ffprobe")
    with (
        patch("app.services.video_service.find_binaries", return_value=binaries),
        patch("app.services.video_service.probe_json", return_value=response),
    ):
        found_binaries, info = VideoService().validate(media)

    assert found_binaries == binaries
    assert info.audio_codec == "aac"
    assert info.audio_sample_rate == 48_000
    assert info.duration_seconds == 4.25


def test_video_without_audio_is_rejected(tmp_path: Path) -> None:
    media = tmp_path / "silent.mp4"
    media.touch()
    with (
        patch("app.services.video_service.find_binaries", return_value=FFmpegBinaries("ffmpeg", "ffprobe")),
        patch("app.services.video_service.probe_json", return_value={"streams": [{"codec_type": "video"}]}),
        pytest.raises(ValidationError, match="does not contain an audio"),
    ):
        VideoService().validate(media)
