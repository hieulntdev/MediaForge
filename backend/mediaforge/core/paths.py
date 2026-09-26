from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppPaths:
    root: Path

    @property
    def config(self) -> Path: return self.root / "config"
    @property
    def logs(self) -> Path: return self.root / "logs"
    @property
    def cache(self) -> Path: return self.root / "cache"
    @property
    def models(self) -> Path: return self.root / "models"
    @property
    def temp(self) -> Path: return self.root / "temp"
    @property
    def tasks(self) -> Path: return self.root / "tasks"
    @property
    def outputs(self) -> Path: return self.root / "outputs"

    def ensure(self) -> None:
        for directory in (self.config, self.logs, self.cache, self.models, self.temp, self.tasks, self.outputs):
            directory.mkdir(parents=True, exist_ok=True)

