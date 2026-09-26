from __future__ import annotations

import json
from pathlib import Path

from .contracts.modules import ModuleManifest


class ModuleRegistry:
    def __init__(self, modules_root: Path) -> None:
        self.modules_root = modules_root.resolve()
        self._modules: dict[str, ModuleManifest] = {}

    def discover(self) -> tuple[ModuleManifest, ...]:
        discovered: dict[str, ModuleManifest] = {}
        for manifest_path in sorted(self.modules_root.glob("*/module.json")):
            manifest = ModuleManifest.from_dict(json.loads(manifest_path.read_text(encoding="utf-8")))
            if manifest.id in discovered:
                raise ValueError(f"duplicate module id: {manifest.id}")
            discovered[manifest.id] = manifest
        self._modules = discovered
        return tuple(discovered.values())

    def get(self, module_id: str) -> ModuleManifest:
        try:
            return self._modules[module_id]
        except KeyError as exc:
            raise KeyError(f"unknown module: {module_id}") from exc

