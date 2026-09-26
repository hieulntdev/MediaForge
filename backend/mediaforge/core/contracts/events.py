from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class EventEnvelope:
    event: str
    task_id: str
    module: str
    action: str
    payload: dict[str, Any] = field(default_factory=dict)
    schema_version: int = 1
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["schemaVersion"] = value.pop("schema_version")
        value["taskId"] = value.pop("task_id")
        return value

