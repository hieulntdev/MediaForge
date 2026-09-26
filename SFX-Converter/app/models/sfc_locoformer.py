from __future__ import annotations

import importlib.util
import logging
import math
import sys
import types
from pathlib import Path
from threading import Event
from typing import Any

from app.models.base import ProgressCallback, SeparationEngine
from app.models.model_manager import ModelManager
from app.services.errors import ModelError, ProcessingCancelled
from app.settings import ModelSettings

LOGGER = logging.getLogger(__name__)


class SFCLocoformerEngine(SeparationEngine):
    """Inference adapter around the official spectral-feature-compression package."""

    def __init__(self, manager: ModelManager, settings: ModelSettings) -> None:
        self.manager = manager
        self.settings = settings
        self._model: Any | None = None
        self._torch: Any | None = None
        self._device = "cpu"

    @property
    def device(self) -> str:
        return self._device

    def _select_device(self, torch: Any) -> str:
        if torch.cuda.is_available():
            LOGGER.info("[Model] CUDA is available")
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            LOGGER.info("[Model] MPS is available; compatibility will be verified during inference")
            return "mps"
        LOGGER.info("[Model] Using CPU")
        return "cpu"

    @staticmethod
    def _prepare_upstream_package() -> None:
        """Load the official package without importing its optional Mamba backend.

        Upstream currently imports `mamba_ssm` unconditionally from its package
        initializer. Cross-Attention inference does not use Mamba, so a namespace
        package is registered before Hydra imports the exact official submodules.
        """
        package_name = "spectral_feature_compression"
        if package_name in sys.modules:
            return
        spec = importlib.util.find_spec(package_name)
        if spec is None or spec.submodule_search_locations is None:
            raise ModelError("The official spectral-feature-compression package was not found.")
        package = types.ModuleType(package_name)
        package.__path__ = list(spec.submodule_search_locations)
        package.__package__ = package_name
        package.__spec__ = spec
        sys.modules[package_name] = package

    @staticmethod
    def _inference_state_dict(state: dict[str, Any]) -> dict[str, Any]:
        if "state_dict" in state and isinstance(state["state_dict"], dict):
            state = state["state_dict"]

        prefixes = ("ema_model.module.", "model.")
        for prefix in prefixes:
            selected = {key[len(prefix) :]: value for key, value in state.items() if key.startswith(prefix)}
            selected.pop("n_averaged", None)
            if selected:
                LOGGER.info("[Model] Loading %s checkpoint weights", "EMA" if prefix.startswith("ema") else "base")
                return selected

        return state

    @staticmethod
    def _force_portable_attention(model: Any, torch: Any, device: str) -> None:
        if device == "cuda":
            return
        backend = torch.nn.attention.SDPBackend.MATH
        changed = 0
        for module in model.modules():
            if hasattr(module, "sdpa_kernel"):
                module.sdpa_kernel = backend
                changed += 1
        if changed:
            LOGGER.info("[Model] Using portable math attention backend on %s", device.upper())

    def load(self, cancel_event: Event | None = None) -> None:
        if self._model is not None:
            LOGGER.info("[Model] Reusing loaded SFC-Locoformer model on %s", self._device.upper())
            return

        model_dir = self.manager.ensure_installed(cancel_event)
        if cancel_event is not None and cancel_event.is_set():
            raise ProcessingCancelled("Model loading was cancelled.")

        try:
            import torch
            from hydra.utils import instantiate
            from omegaconf import OmegaConf
        except ImportError as exc:
            raise ModelError("AI dependencies are missing; run scripts/setup.sh.") from exc

        LOGGER.info("[Model] Loading SFC-Locoformer Medium (DnR, SFC Cross-Attention)...")
        LOGGER.info("[Model] Checkpoint: %s", self.manager.checkpoint_path)
        LOGGER.info("[Model] Artifact revision: %s", self.settings.revision)
        LOGGER.info("[Model] DnR output mapping: speech=0, music=1, sfx=%d", self.settings.sfx_index)
        self._prepare_upstream_package()
        config = OmegaConf.load(model_dir / "merged_config.yaml")
        actual = {
            "sr": int(config.sr),
            "channels": int(config.task.model.model.n_chan),
            "n_src": int(config.n_src),
        }
        expected = {"sr": self.settings.sample_rate, "channels": self.settings.channels, "n_src": 3}
        if actual != expected:
            raise ModelError(f"The checkpoint configuration does not match the verified DnR format: {actual}")

        device = self._select_device(torch)
        LOGGER.info("[Model] Requested backend: %s", device.upper())
        try:
            model = instantiate(config.task.model)
            checkpoint = torch.load(self.manager.checkpoint_path, map_location="cpu", weights_only=False)
            model.load_state_dict(self._inference_state_dict(checkpoint), strict=True)
            model.eval()
            model.requires_grad_(False)
            self._force_portable_attention(model, torch, device)
            model.to(device)
        except Exception as exc:
            raise ModelError(f"Could not load the SFC-Locoformer checkpoint: {exc}") from exc

        self._torch = torch
        self._model = model
        self._device = device
        LOGGER.info("[Model] Loaded successfully on %s", device.upper())

    def _fallback_mps_to_cpu(self) -> None:
        assert self._model is not None and self._torch is not None
        LOGGER.warning("[Model] MPS operation unsupported; falling back to CPU")
        self._device = "cpu"
        self._force_portable_attention(self._model, self._torch, "cpu")
        self._model.to("cpu")
        mps = getattr(self._torch, "mps", None)
        if mps is not None and hasattr(mps, "empty_cache"):
            mps.empty_cache()

    def _infer(self, samples: Any) -> Any:
        assert self._model is not None and self._torch is not None
        torch = self._torch
        tensor = torch.from_numpy(samples.T.copy()).unsqueeze(0).to(self._device)
        try:
            with torch.inference_mode():
                estimate = self._model(tensor)
        except (RuntimeError, NotImplementedError) as exc:
            if self._device != "mps":
                if self._device == "cuda" and "out of memory" in str(exc).lower():
                    raise ModelError("CUDA ran out of memory. Close other GPU applications or use the CPU.") from exc
                raise
            LOGGER.warning("[Model] MPS inference failed: %s", exc)
            self._fallback_mps_to_cpu()
            tensor = tensor.to("cpu")
            with torch.inference_mode():
                estimate = self._model(tensor)

        if estimate.ndim != 4 or estimate.shape[1] != 3:
            raise ModelError(f"Model output has an invalid DnR shape: {tuple(estimate.shape)}")
        return estimate[0, self.settings.sfx_index].T.float().cpu().numpy()

    def extract_sfx(
        self,
        audio_path: Path,
        output_path: Path,
        progress_callback: ProgressCallback | None = None,
        cancel_event: Event | None = None,
    ) -> None:
        self.load(cancel_event)
        try:
            import numpy as np
            import soundfile as sf
        except ImportError as exc:
            raise ModelError("numpy or soundfile is missing; run scripts/setup.sh.") from exc

        segment_frames = self.settings.segment_seconds * self.settings.sample_rate
        shift_frames = self.settings.shift_seconds * self.settings.sample_rate
        overlap_frames = segment_frames - shift_frames

        with sf.SoundFile(audio_path, mode="r") as source:
            if source.samplerate != self.settings.sample_rate or source.channels != self.settings.channels:
                raise ModelError(
                    f"Model audio input must be {self.settings.sample_rate} Hz/{self.settings.channels} channel."
                )
            total_frames = len(source)
            if total_frames <= 0:
                raise ModelError("Audio input is empty.")

            if total_frames <= segment_frames:
                chunk_count = 1
            else:
                chunk_count = math.ceil((total_frames - overlap_frames) / shift_frames)

            output_path.parent.mkdir(parents=True, exist_ok=True)
            with sf.SoundFile(
                output_path,
                mode="w",
                samplerate=self.settings.sample_rate,
                channels=self.settings.channels,
                subtype="PCM_24",
                format="WAV",
            ) as destination:
                if chunk_count == 1:
                    samples = source.read(total_frames, dtype="float32", always_2d=True)
                    destination.write(self._infer(samples)[:total_frames])
                    if progress_callback:
                        progress_callback(1, 1)
                    return

                pending = None
                frames_written = 0
                for index in range(chunk_count):
                    if cancel_event is not None and cancel_event.is_set():
                        raise ProcessingCancelled("Source separation was cancelled.")

                    start = index * shift_frames
                    source.seek(start)
                    valid_frames = min(segment_frames, total_frames - start)
                    samples = source.read(valid_frames, dtype="float32", always_2d=True)
                    if valid_frames < segment_frames:
                        samples = np.pad(samples, ((0, segment_frames - valid_frames), (0, 0)))
                    current = self._infer(samples)

                    if pending is None:
                        pending = current
                    else:
                        destination.write(pending[:shift_frames])
                        frames_written += shift_frames
                        averaged = (pending[shift_frames:] + current[:overlap_frames]) * 0.5
                        pending = np.concatenate((averaged, current[overlap_frames:]), axis=0)

                    if progress_callback:
                        progress_callback(index + 1, chunk_count)

                assert pending is not None
                remaining = total_frames - frames_written
                destination.write(pending[:remaining])

    def unload(self) -> None:
        if self._model is None:
            return
        self._model = None
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()
        self._torch = None
        self._device = "cpu"
