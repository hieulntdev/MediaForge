"""MeloTTS adapter, routing, normalization, and shared-pipeline tests."""

from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import wave
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.pipeline import run  # noqa: E402
from studio.tts import (  # noqa: E402
    DEFAULT_TTS_MODEL,
    MELOTTS_MODEL,
    TTSSelectionError,
    create_engine,
    normalize_model_name,
)
from studio.tts.melotts_engine import MeloTTSEngine, MeloTTSEngineError  # noqa: E402
from studio.tts.vieneu_engine import TTSEngine  # noqa: E402


def tone(seconds: float = 0.1, rate: int = 44_100) -> np.ndarray:
    positions = np.arange(max(1, round(seconds * rate)), dtype=np.float32) / rate
    return (0.2 * np.sin(2 * np.pi * 220 * positions)).astype(np.float32)


class FakeMeloModel:
    def __init__(self, language: str, device: str) -> None:
        self.language = language
        self.device = device
        self.hps = types.SimpleNamespace(
            data=types.SimpleNamespace(spk2id={"EN-US": 7}, sampling_rate=44_100)
        )
        self.calls: list[tuple[str, int, float, bool]] = []

    def tts_to_file(
        self, text: str, speaker_id: int, *, output_path: object,
        speed: float, quiet: bool,
    ) -> np.ndarray:
        self.calls.append((text, speaker_id, speed, quiet))
        return tone()


class MeloAdapterTests(unittest.TestCase):
    def fake_modules(self):
        api = types.ModuleType("melo.api")
        api.TTS = FakeMeloModel
        package = types.ModuleType("melo")
        package.api = api
        return mock.patch.dict(sys.modules, {"melo": package, "melo.api": api})

    def test_load_and_inference_produce_canonical_wav(self) -> None:
        engine = MeloTTSEngine(language="EN", speaker="EN-US", device="cpu")
        with self.fake_modules():
            engine.load_model()
            voice = engine.clone_voice(Path("unused.mp3"))
            result = engine.synthesize("Hello", voice)
        with wave.open(io.BytesIO(result), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), 24_000)
            self.assertGreater(wav.getnframes(), 0)
        self.assertEqual(engine.speaker_name, "EN-US")

    def test_unsupported_language_is_explicit(self) -> None:
        with self.assertRaisesRegex(MeloTTSEngineError, "Vietnamese is not supported"):
            MeloTTSEngine(language="VI")

    def test_unknown_speaker_lists_actual_model_speakers(self) -> None:
        engine = MeloTTSEngine(language="EN", speaker="missing", device="cpu")
        with self.fake_modules(), self.assertRaisesRegex(
            MeloTTSEngineError, "available speakers: EN-US"
        ):
            engine.load_model()

    def test_empty_or_non_finite_audio_is_rejected(self) -> None:
        with self.assertRaisesRegex(MeloTTSEngineError, "empty audio"):
            MeloTTSEngine._canonical_wav([], 44_100)
        with self.assertRaisesRegex(MeloTTSEngineError, "NaN"):
            MeloTTSEngine._canonical_wav([0.0, float("nan")], 44_100)


class RouterTests(unittest.TestCase):
    def test_default_and_display_name_route_to_vieneu(self) -> None:
        self.assertEqual(normalize_model_name(None), DEFAULT_TTS_MODEL)
        self.assertEqual(normalize_model_name("VieNeu-TTS v3 Turbo"), DEFAULT_TTS_MODEL)
        self.assertIsInstance(create_engine(), TTSEngine)

    def test_melo_is_lazy_and_configured_without_loading_weights(self) -> None:
        engine = create_engine(MELOTTS_MODEL, melo_language="FR", melo_speaker="FR")
        self.assertIsInstance(engine, MeloTTSEngine)
        self.assertEqual(engine.language, "FR")
        self.assertEqual(engine.speaker_name, "FR")
        self.assertIsNone(engine._model)

    def test_unknown_model_never_falls_back(self) -> None:
        with self.assertRaises(TTSSelectionError):
            create_engine("unknown")


class SharedPipelineTests(unittest.TestCase):
    class Engine:
        speaker_name = "EN-US"

        def load_model(self) -> None:
            pass

        def clone_voice(self, reference_audio: Path) -> dict[str, int]:
            self.reference = reference_audio
            return {"speaker_id": 0}

        def synthesize(self, text: str, voice: object) -> bytes:
            samples = tone(seconds=0.2, rate=24_000)
            pcm = np.rint(samples * 32767).astype("<i2")
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24_000)
                wav.writeframes(pcm.tobytes())
            return output.getvalue()

        def close(self) -> None:
            pass

    def test_melo_job_uses_pipeline_without_reference_audio(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subtitle = root / "english.srt"
            subtitle.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\nHello world\n",
                encoding="utf-8",
            )
            state_dir = root / "english.zsp.melotts.EN.EN-US.retry"
            run(
                root,
                self.Engine(),
                subtitle_path=subtitle,
                reference_path=root / "does-not-exist.mp3",
                destination=root / "english.zsp",
                state_dir=state_dir,
                validate_content=False,
                tts_model=MELOTTS_MODEL,
                melo_language="EN",
                melo_speaker="EN-US",
            )
            record = json.loads(
                (state_dir / "entries.jsonl").read_text(encoding="utf-8").splitlines()[-1]
            )
            self.assertEqual(record["entry"]["speaker_name"], "EN-US")
            wav_path = state_dir / "audio_cache" / record["entry"]["audio_filename"]
            with wave.open(str(wav_path), "rb") as wav:
                self.assertEqual(wav.getframerate(), 24_000)
                self.assertEqual(wav.getnframes(), 24_000)


if __name__ == "__main__":
    unittest.main()
