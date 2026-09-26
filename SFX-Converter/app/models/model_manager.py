from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from threading import Event

from app.services.errors import ModelError, ProcessingCancelled
from app.settings import ModelSettings

LOGGER = logging.getLogger(__name__)


class ModelManager:
    """Downloads and verifies the exact upstream DnR model artifacts."""

    def __init__(self, root_dir: Path, settings: ModelSettings) -> None:
        self.settings = settings
        self.model_dir = root_dir / settings.dataset / settings.name
        self.checkpoint_path = self.model_dir / "checkpoints" / "model.pth"
        self.config_path = self.model_dir / "merged_config.yaml"

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def is_installed(self) -> bool:
        return self.checkpoint_path.is_file() and self.config_path.is_file()

    def status(self) -> dict[str, object]:
        """Return a cheap, explicit cache status without importing the model."""
        if not self.is_installed():
            return {
                "status": "missing",
                "installed": False,
                "revision": self.settings.revision,
                "model_dir": self.model_dir,
            }
        try:
            self.verify()
        except ModelError as exc:
            return {
                "status": "corrupted",
                "installed": True,
                "revision": self.settings.revision,
                "model_dir": self.model_dir,
                "error": str(exc),
            }
        return {
            "status": "ready",
            "installed": True,
            "revision": self.settings.revision,
            "model_dir": self.model_dir,
        }

    def verify(self) -> None:
        expected = {
            self.checkpoint_path: self.settings.checkpoint_sha256,
            self.config_path: self.settings.config_sha256,
        }
        for path, expected_hash in expected.items():
            if not path.is_file():
                raise ModelError(f"Missing model artifact: {path}")
            if self._sha256(path) != expected_hash:
                raise ModelError(f"The model artifact is corrupted or has the wrong revision: {path.name}")

    def ensure_installed(self, cancel_event: Event | None = None) -> Path:
        if self.is_installed():
            LOGGER.info("Verifying installed model artifacts...")
            self.verify()
            return self.model_dir

        if cancel_event is not None and cancel_event.is_set():
            raise ProcessingCancelled("Model download was cancelled.")

        try:
            from huggingface_hub import hf_hub_download
        except ImportError as exc:
            raise ModelError("huggingface-hub is missing; run scripts/setup.sh.") from exc

        LOGGER.info("Downloading SFC-Locoformer Medium DnR model (first run only)...")
        files = {
            f"{self.settings.remote_base}/checkpoints/model.pth": self.checkpoint_path,
            f"{self.settings.remote_base}/merged_config.yaml": self.config_path,
        }
        for remote_name, destination in files.items():
            if cancel_event is not None and cancel_event.is_set():
                raise ProcessingCancelled("Model download was cancelled.")
            try:
                cached_path = Path(
                    hf_hub_download(
                        repo_id=self.settings.repository_id,
                        filename=remote_name,
                        revision=self.settings.revision,
                    )
                )
            except Exception as exc:
                raise ModelError(
                    "The verified SFX model is not cached and could not be downloaded. "
                    "Check the network connection, then use Model Prefetch and retry."
                ) from exc
            destination.parent.mkdir(parents=True, exist_ok=True)
            partial = destination.with_suffix(destination.suffix + ".part")
            try:
                shutil.copyfile(cached_path, partial)
                partial.replace(destination)
            finally:
                partial.unlink(missing_ok=True)

        LOGGER.info("Verifying downloaded model artifacts...")
        self.verify()
        return self.model_dir
