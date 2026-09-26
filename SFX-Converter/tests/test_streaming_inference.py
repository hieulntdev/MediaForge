from pathlib import Path

import numpy as np
import soundfile as sf

from app.models.sfc_locoformer import SFCLocoformerEngine
from app.settings import SETTINGS


class UnusedManager:
    pass


def test_long_audio_streaming_preserves_exact_frame_count(tmp_path: Path) -> None:
    frame_count = SETTINGS.model.sample_rate * 13 + 123
    samples = np.linspace(-0.25, 0.25, frame_count, dtype=np.float32)[:, None]
    input_path = tmp_path / "input.wav"
    output_path = tmp_path / "output.wav"
    sf.write(input_path, samples, SETTINGS.model.sample_rate, subtype="FLOAT")

    engine = SFCLocoformerEngine(UnusedManager(), SETTINGS.model)  # type: ignore[arg-type]
    engine._model = object()
    engine._infer = lambda chunk: chunk  # type: ignore[method-assign]
    progress: list[tuple[int, int]] = []
    engine.extract_sfx(input_path, output_path, lambda current, total: progress.append((current, total)))

    info = sf.info(output_path)
    assert info.frames == frame_count
    assert info.samplerate == SETTINGS.model.sample_rate
    assert info.channels == 1
    assert progress[-1] == (2, 2)
