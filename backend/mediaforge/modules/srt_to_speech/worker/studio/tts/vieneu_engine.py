"""Isolated VieNeu-TTS adapter with canonical 24 kHz PCM WAV output."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import sys
import tempfile
from typing import Any

from studio.tts import hardware


class TTSEngineError(RuntimeError):
    pass


INSTALL_HINT = (
    "run `npm run bootstrap:runtimes` from the MediaForge root"
    if sys.platform == "darwin"
    else "install dependencies and download the VieNeu model once"
)

# Substrings that identify a Hugging Face download failure rather than a code bug.
_NETWORK_HINTS = (
    "huggingface.co",
    "connection",
    "connect",
    "timed out",
    "timeout",
    "resolve",
    "ssl",
    "offline",
    "proxy",
)


def _initialization_message(exc: Exception) -> str:
    """Add a download hint when model weights could not be fetched."""
    message = str(exc)
    lowered = message.lower()
    if any(hint in lowered for hint in _NETWORK_HINTS):
        return (
            f"{message}\nThe VieNeu-TTS v3 Turbo weights are downloaded from Hugging Face "
            "on first use. Check the network connection, or pre-populate "
            "~/.cache/huggingface so the run can proceed offline."
        )
    return message


class TTSEngine:
    """Minimal interface used by the application pipeline."""

    sample_rate = 24_000

    def __init__(self) -> None:
        self._model: Any = None
        self._plan: hardware.RuntimePlan | None = None
        self._temporary: tempfile.TemporaryDirectory[str] | None = None

    def load_model(self) -> None:
        plan = hardware.resolve_runtime()
        hardware.log_plan(plan)
        self._plan = self._load(plan)

    def _load(self, plan: hardware.RuntimePlan) -> hardware.RuntimePlan:
        """Create the model for ``plan``; retry on ONNX/CPU if an accelerator fails."""
        try:
            self._model = self._create_model(plan)
            return plan
        except ModuleNotFoundError as exc:
            raise TTSEngineError(f"TTS model not found: {INSTALL_HINT}") from exc
        except Exception as exc:
            if plan.backend == hardware.ONNX_BACKEND:
                raise TTSEngineError(
                    f"TTS initialization failed: {_initialization_message(exc)}"
                ) from exc
            print(
                f"TTS backend {plan.backend}/{plan.device} unavailable ({exc}). "
                "Retrying on the ONNX/CPU backend.",
                flush=True,
            )
            fallback = hardware.cpu_fallback(f"{plan.backend}/{plan.device} failed: {exc}")
            hardware.log_plan(fallback)
            try:
                self._model = self._create_model(fallback)
            except ModuleNotFoundError as exc:
                raise TTSEngineError(f"TTS model not found: {INSTALL_HINT}") from exc
            except Exception as exc:
                raise TTSEngineError(
                    f"TTS initialization failed: {_initialization_message(exc)}"
                ) from exc
            return fallback

    @staticmethod
    def _create_model(plan: hardware.RuntimePlan) -> Any:
        from vieneu import Vieneu

        # v3 Turbo runs through ONNX Runtime on CPU and through PyTorch on GPU; the
        # plan decides which, and only non-default values are forwarded.
        options: dict[str, Any] = {"mode": "v3turbo"}
        if plan.backend != hardware.AUTO:
            options["backend"] = plan.backend
        if plan.device != hardware.AUTO:
            options["device"] = plan.device
        if plan.backend == hardware.ONNX_BACKEND and plan.precision:
            options["precision"] = plan.precision
        if plan.threads:
            options["threads"] = plan.threads
        return Vieneu(**options)

    def clone_voice(self, reference_audio: Path) -> dict[str, Any]:
        """Normalize and enroll the voice once for reuse by every subtitle."""
        if self._model is None:
            raise TTSEngineError("TTS initialization failed: model is not loaded")
        self._temporary = tempfile.TemporaryDirectory(prefix="zsp_voice_")
        normalized = Path(self._temporary.name) / "normalized_reference.wav"
        try:
            samples, source_rate = self._read_audio(reference_audio)
            samples = self._canonical_samples(samples, source_rate)
            self._write_audio(normalized, samples)
            speaker_emb, ref_codes = self._model.encode_reference(normalized)
        except Exception as exc:
            self.close()
            if isinstance(exc, TTSEngineError):
                raise
            raise TTSEngineError(f"cannot normalize reference audio: {exc}") from exc
        return {"speaker_emb": speaker_emb, "codes": ref_codes}

    def synthesize(self, text: str, voice: dict[str, Any]) -> bytes:
        """Return a complete mono/24 kHz/PCM16 WAV as bytes."""
        if self._model is None:
            raise TTSEngineError("TTS initialization failed: model is not loaded")
        try:
            # Passing pre-enrolled data avoids re-running the denoiser, speaker
            # encoder and reference codec hundreds of times for a long SRT.
            result = self._model.infer(text=text, voice=voice, **self._infer_options())
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                raw_path = Path(handle.name)
            try:
                self._model.save(result, str(raw_path))
                samples, source_rate = self._read_audio(raw_path)
                samples = self._canonical_samples(samples, source_rate)
                return self._wav_bytes(samples)
            finally:
                raw_path.unlink(missing_ok=True)
        except Exception as exc:
            if isinstance(exc, TTSEngineError):
                raise
            raise TTSEngineError(str(exc)) from exc

    def _infer_options(self) -> dict[str, Any]:
        """Per-call options; MPS keeps the single-sequence path.

        The upstream static-batching runtime is CUDA-graph based, so batching is
        disabled whenever the PyTorch engine runs on a non-CUDA accelerator.
        """
        if (
            self._plan is not None
            and self._plan.backend == hardware.PYTORCH_BACKEND
            and self._plan.device != hardware.CUDA_DEVICE
        ):
            return {"batch_size": 1}
        return {}

    def close(self) -> None:
        if self._model is not None:
            close = getattr(self._model, "close", None)
            if callable(close):
                close()
            self._model = None
        if self._plan is not None:
            # Release cached accelerator memory once, at teardown only.
            hardware.empty_accelerator_cache(self._plan.device)
        self._plan = None
        if self._temporary is not None:
            self._temporary.cleanup()
            self._temporary = None

    @staticmethod
    def _read_audio(path: Path) -> tuple[Any, int]:
        try:
            import soundfile as sf

            samples, rate = sf.read(str(path), dtype="float32", always_2d=True)
        except Exception as exc:
            raise TTSEngineError(f"audio decode failed for {path.name}: {exc}") from exc
        if samples.size == 0 or rate <= 0:
            raise TTSEngineError(f"audio decode failed for {path.name}: empty audio")
        return samples.mean(axis=1), int(rate)

    def _canonical_samples(self, samples: Any, source_rate: int) -> Any:
        import numpy as np

        samples = np.asarray(samples, dtype=np.float32)
        if not np.all(np.isfinite(samples)):
            raise TTSEngineError("audio contains NaN or infinite samples")
        if source_rate != self.sample_rate:
            import soxr

            samples = soxr.resample(samples, source_rate, self.sample_rate, quality="HQ")
        # Remove DC and peak-normalize without applying destructive compression.
        samples = samples - float(np.mean(samples))
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0:
            samples = samples * (0.95 / peak)
        return np.clip(samples, -1.0, 1.0).astype(np.float32)

    def _write_audio(self, path: Path, samples: Any) -> None:
        import soundfile as sf

        sf.write(str(path), samples, self.sample_rate, format="WAV", subtype="PCM_16")

    def _wav_bytes(self, samples: Any) -> bytes:
        import soundfile as sf

        output = BytesIO()
        sf.write(output, samples, self.sample_rate, format="WAV", subtype="PCM_16")
        return output.getvalue()

    def __enter__(self) -> "TTSEngine":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
