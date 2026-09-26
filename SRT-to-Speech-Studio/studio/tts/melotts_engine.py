"""Independent MeloTTS adapter producing canonical 24 kHz PCM WAV audio.

MeloTTS is a fixed-speaker multilingual synthesizer.  It does not clone the
voice in the reference MP3 used by the VieNeu workflow; ``clone_voice`` keeps
the application's engine contract while selecting a Melo speaker instead.
"""

from __future__ import annotations

import gc
from io import BytesIO
import os
from pathlib import Path
import threading
from typing import Any
import wave

import numpy as np
import soxr


class MeloTTSEngineError(RuntimeError):
    """A user-actionable MeloTTS configuration or inference failure."""


SUPPORTED_LANGUAGES = ("EN", "ES", "FR", "ZH", "JP", "KR")
DEFAULT_SPEAKERS = {
    "EN": "EN-US",
    "ES": "ES",
    "FR": "FR",
    "ZH": "ZH",
    "JP": "JP",
    "KR": "KR",
}
CANONICAL_SAMPLE_RATE = 24_000
INSTALL_HINT = (
    "MeloTTS is optional. Install its isolated runtime with "
    "`./studio.sh setup melotts`."
)


def _requested_device() -> str:
    requested = os.environ.get("SRT_STUDIO_MELO_DEVICE", "auto").strip().lower()
    if requested not in {"auto", "cpu", "mps", "cuda"} and not requested.startswith("cuda:"):
        raise MeloTTSEngineError(
            "SRT_STUDIO_MELO_DEVICE must be auto, cpu, mps, cuda, or cuda:<index>"
        )
    return requested


class MeloTTSEngine:
    """Adapter for the upstream ``melo.api.TTS`` Python API.

    One model is loaded per worker process and reused for every subtitle.  A
    lock protects the shared PyTorch model because the common pipeline may use
    several subtitle worker threads.
    """

    sample_rate = CANONICAL_SAMPLE_RATE

    def __init__(
        self,
        *,
        language: str = "EN",
        speaker: str | None = None,
        synthesis_speed: float = 1.0,
        device: str | None = None,
    ) -> None:
        language = str(language).strip().upper()
        if language not in SUPPORTED_LANGUAGES:
            supported = ", ".join(SUPPORTED_LANGUAGES)
            raise MeloTTSEngineError(
                f"MeloTTS language {language!r} is unsupported; choose one of: {supported}. "
                "Vietnamese is not supported by the upstream MeloTTS models."
            )
        if not isinstance(synthesis_speed, (int, float)) or synthesis_speed <= 0:
            raise MeloTTSEngineError("MeloTTS synthesis speed must be greater than zero")
        self.language = language
        self.speaker_name = str(speaker or DEFAULT_SPEAKERS[language]).strip()
        self.synthesis_speed = float(synthesis_speed)
        self.requested_device = device or _requested_device()
        self.device = self.requested_device
        self._model: Any = None
        self._speaker_id: int | None = None
        self._model_sample_rate: int | None = None
        self._inference_lock = threading.Lock()

    def load_model(self) -> None:
        try:
            from melo.api import TTS
        except (ImportError, ModuleNotFoundError) as exc:
            raise MeloTTSEngineError(f"MeloTTS dependency is unavailable. {INSTALL_HINT}") from exc

        print(
            f"MeloTTS runtime: language={self.language}, speaker={self.speaker_name}, "
            f"device={self.requested_device}",
            flush=True,
        )
        try:
            self._model = TTS(language=self.language, device=self.requested_device)
            self.device = str(getattr(self._model, "device", self.requested_device))
        except Exception as exc:
            if self.requested_device == "cpu":
                raise MeloTTSEngineError(f"MeloTTS initialization failed: {exc}") from exc
            print(
                f"MeloTTS device {self.requested_device} unavailable ({exc}). "
                "Retrying on CPU.",
                flush=True,
            )
            try:
                self._model = TTS(language=self.language, device="cpu")
                self.device = "cpu"
            except Exception as fallback_exc:
                raise MeloTTSEngineError(
                    f"MeloTTS initialization failed on CPU: {fallback_exc}"
                ) from fallback_exc

        try:
            speakers = dict(self._model.hps.data.spk2id)
            sample_rate = int(self._model.hps.data.sampling_rate)
        except (AttributeError, TypeError, ValueError) as exc:
            self.close()
            raise MeloTTSEngineError(f"MeloTTS model metadata is invalid: {exc}") from exc
        if self.speaker_name not in speakers:
            available = ", ".join(str(name) for name in speakers) or "none"
            self.close()
            raise MeloTTSEngineError(
                f"MeloTTS speaker {self.speaker_name!r} is unavailable for {self.language}; "
                f"available speakers: {available}"
            )
        if sample_rate <= 0:
            self.close()
            raise MeloTTSEngineError("MeloTTS model reports an invalid sample rate")
        self._speaker_id = int(speakers[self.speaker_name])
        self._model_sample_rate = sample_rate
        print(
            f"MeloTTS model loaded: device={self.device}, source_rate={sample_rate} Hz",
            flush=True,
        )

    def clone_voice(self, reference_audio: Path) -> dict[str, object]:
        """Select the configured built-in speaker; reference audio is unsupported."""
        del reference_audio
        if self._model is None or self._speaker_id is None:
            raise MeloTTSEngineError("MeloTTS initialization failed: model is not loaded")
        return {"speaker_id": self._speaker_id, "speaker_name": self.speaker_name}

    def synthesize(self, text: str, voice: dict[str, object]) -> bytes:
        if self._model is None or self._model_sample_rate is None:
            raise MeloTTSEngineError("MeloTTS initialization failed: model is not loaded")
        if not str(text).strip():
            raise MeloTTSEngineError("MeloTTS cannot synthesize empty text")
        try:
            speaker_id = int(voice["speaker_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise MeloTTSEngineError("MeloTTS speaker selection is invalid") from exc

        try:
            with self._inference_lock:
                samples = self._model.tts_to_file(
                    str(text),
                    speaker_id,
                    output_path=None,
                    speed=self.synthesis_speed,
                    quiet=True,
                )
            return self._canonical_wav(samples, self._model_sample_rate)
        except MeloTTSEngineError:
            raise
        except Exception as exc:
            raise MeloTTSEngineError(f"MeloTTS inference failed: {exc}") from exc

    @staticmethod
    def _canonical_wav(samples: object, source_rate: int) -> bytes:
        audio = np.asarray(samples)
        if audio.ndim == 2:
            # Melo currently emits mono, but normalize defensively if an
            # alternate checkpoint returns channels-first or channels-last.
            channel_axis = 0 if audio.shape[0] <= 8 else 1
            audio = audio.mean(axis=channel_axis)
        audio = np.ravel(audio).astype(np.float32, copy=False)
        if audio.size == 0:
            raise MeloTTSEngineError("MeloTTS produced empty audio")
        if not np.all(np.isfinite(audio)):
            raise MeloTTSEngineError("MeloTTS produced NaN or infinite samples")
        if source_rate != CANONICAL_SAMPLE_RATE:
            audio = soxr.resample(audio, source_rate, CANONICAL_SAMPLE_RATE, quality="HQ")
        if audio.size == 0:
            raise MeloTTSEngineError("MeloTTS resampling produced empty audio")
        pcm = np.rint(np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
        output = BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(CANONICAL_SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
        return output.getvalue()

    def close(self) -> None:
        self._model = None
        self._speaker_id = None
        self._model_sample_rate = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            mps = getattr(torch, "mps", None)
            empty_mps = getattr(mps, "empty_cache", None)
            if callable(empty_mps):
                empty_mps()
        except (ImportError, RuntimeError):
            pass

    def __enter__(self) -> "MeloTTSEngine":
        self.load_model()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
