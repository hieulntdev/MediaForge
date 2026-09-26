from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal
from urllib.parse import urlparse
import uuid


@dataclass(frozen=True)
class Checksum:
    algorithm: Literal["sha256"]
    value: str

    def __post_init__(self) -> None:
        if self.algorithm != "sha256" or len(self.value) != 64:
            raise ValueError("checksum must be a SHA-256 digest")


@dataclass(frozen=True)
class ProducerRef:
    task_id: str
    module: str
    action: str


@dataclass(frozen=True)
class ArtifactRef:
    type: str
    uri: str
    mime_type: str
    producer: ProducerRef
    ownership: Literal["user-output", "task-state", "cache", "task-temp"]
    id: str = field(default_factory=lambda: f"artifact-{uuid.uuid4()}")
    size: int | None = None
    checksum: Checksum | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        parsed = urlparse(self.uri)
        if parsed.scheme != "file" or not parsed.path:
            raise ValueError("artifact URI must be an absolute file URI")
        if self.size is not None and self.size < 0:
            raise ValueError("artifact size cannot be negative")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["mimeType"] = value.pop("mime_type")
        value["producer"]["taskId"] = value["producer"].pop("task_id")
        return value

