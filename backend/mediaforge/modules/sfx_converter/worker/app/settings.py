from __future__ import annotations

import os
import json
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path, user_log_path


MODEL_FILE = Path(__file__).resolve().parents[2] / "model.json"
MODEL_MANIFEST = json.loads(MODEL_FILE.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class ModelSettings:
    repository_id: str = MODEL_MANIFEST["repository_id"]
    revision: str = MODEL_MANIFEST["revision"]
    dataset: str = MODEL_MANIFEST["dataset"]
    name: str = MODEL_MANIFEST["name"]
    checkpoint_sha256: str = MODEL_MANIFEST["checkpoint_sha256"]
    config_sha256: str = MODEL_MANIFEST["config_sha256"]
    sample_rate: int = MODEL_MANIFEST["sample_rate"]
    channels: int = MODEL_MANIFEST["channels"]
    segment_seconds: int = MODEL_MANIFEST["segment_seconds"]
    shift_seconds: int = MODEL_MANIFEST["shift_seconds"]
    sfx_index: int = MODEL_MANIFEST["sfx_index"]

    @property
    def remote_base(self) -> str:
        return f"models/{self.dataset}/{self.name}"


@dataclass(frozen=True)
class AppSettings:
    app_name: str = "SFX Converter"
    organization_name: str = "SFX Converter"
    model: ModelSettings = ModelSettings()

    @property
    def data_dir(self) -> Path:
        override = os.environ.get("SFX_CONVERTER_DATA_DIR")
        return Path(override).expanduser() if override else Path(user_data_path(self.app_name, self.organization_name))

    @property
    def model_dir(self) -> Path:
        override = os.environ.get("SFX_CONVERTER_MODEL_DIR")
        return Path(override).expanduser() if override else self.data_dir / "model_weights"

    @property
    def log_dir(self) -> Path:
        override = os.environ.get("SFX_CONVERTER_LOG_DIR")
        return Path(override).expanduser() if override else Path(user_log_path(self.app_name, self.organization_name))


SETTINGS = AppSettings()

