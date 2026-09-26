from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


_ID = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass(frozen=True)
class ModuleManifest:
    id: str
    version: str
    display_name: str
    frontend_route: str
    runtime: str
    actions: tuple[str, ...]
    capabilities: dict[str, bool]
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ModuleManifest":
        module_id = str(value.get("id", ""))
        if not _ID.fullmatch(module_id):
            raise ValueError("invalid module id")
        actions = tuple(value.get("actions") or ())
        if not actions or len(set(actions)) != len(actions):
            raise ValueError("module actions must be non-empty and unique")
        capabilities = value.get("capabilities") or {}
        if not all(isinstance(capabilities.get(name), bool) for name in ("cancel", "pause")):
            raise ValueError("invalid module capabilities")
        return cls(
            id=module_id,
            version=str(value["version"]),
            display_name=str(value["displayName"]),
            frontend_route=str(value["frontendRoute"]),
            runtime=str(value["runtime"]),
            actions=actions,
            capabilities=dict(capabilities),
            inputs=tuple(value.get("inputs") or ()),
            outputs=tuple(value.get("outputs") or ()),
        )

