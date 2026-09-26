from pathlib import Path

import pytest

from app.models.base import SeparationEngine
from app.services.errors import ValidationError
from app.services.separation_service import SeparationService
from app.services.state import ProcessingState
from app.services.video_service import MediaInfo
from app.settings import SETTINGS
from app.utils.ffmpeg import FFmpegBinaries


class FakeEngine(SeparationEngine):
    def __init__(self) -> None:
        self.loaded = False

    def load(self, cancel_event=None) -> None:
        self.loaded = True

    def extract_sfx(self, audio_path, output_path, progress_callback=None, cancel_event=None) -> None:
        assert self.loaded
        output_path.write_bytes(b"sfx")
        if progress_callback:
            progress_callback(1, 1)


class FakeVideoService:
    def validate(self, input_path, cancel_event=None):
        return FFmpegBinaries("ffmpeg", "ffprobe"), MediaInfo(1.0, "aac", 2, 48_000)


class FakeAudioService:
    def extract_for_model(self, _ffmpeg, _input, output, _sample_rate, _channels, cancel_event=None) -> None:
        output.write_bytes(b"audio")


def test_service_orchestrates_pipeline_and_only_commits_sfx(tmp_path: Path) -> None:
    video = tmp_path / "movie.mp4"
    video.touch()
    states: list[ProcessingState] = []
    service = SeparationService(
        SETTINGS,
        FakeEngine(),
        video_service=FakeVideoService(),
        audio_service=FakeAudioService(),
    )
    output = service.process(video, tmp_path, state_callback=states.append)
    assert output.name == "movie_sfx.wav"
    assert output.read_bytes() == b"sfx"
    assert states[-1] is ProcessingState.COMPLETED
    assert not list(tmp_path.glob("*.part"))


class FailingVideoService:
    def validate(self, input_path, cancel_event=None):
        raise ValidationError("bad media")


def test_failure_moves_service_to_error_state(tmp_path: Path) -> None:
    video = tmp_path / "bad.mp4"
    video.touch()
    service = SeparationService(SETTINGS, FakeEngine(), video_service=FailingVideoService())
    with pytest.raises(ValidationError, match="bad media"):
        service.process(video, tmp_path)
    assert service.state_machine.state is ProcessingState.ERROR
