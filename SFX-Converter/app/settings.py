from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path, user_log_path


@dataclass(frozen=True)
class ModelSettings:
    repository_id: str = "kohei0209/spectral_feature_compression"
    revision: str = "0827e70a9e0c6f21b9b46cb9dfe4f7e4ebd307c5"
    dataset: str = "dnr"
    name: str = "locoformer-medium.enc-crossattn96dim.dec-crossattn96dim.musical64.learnable-query"
    checkpoint_sha256: str = "b878ea0ffe29c67401727d51cdaab8db0394178d8e0eafa9d2ca5e241fd472e2"
    config_sha256: str = "4d0d1ffc3ff80f162f288d31477d6a0699578bbf00f11b8fd091580668c12adb"
    sample_rate: int = 44_100
    channels: int = 1
    segment_seconds: int = 12
    shift_seconds: int = 6
    sfx_index: int = 2

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

