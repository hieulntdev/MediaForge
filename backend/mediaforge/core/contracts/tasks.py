from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any
import uuid

from .artifacts import ArtifactRef


class TaskState(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    CANCELLING = "CANCELLING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Progress:
    current: float = 0
    total: float = 0
    percent: float = 0
    indeterminate: bool = True

    def __post_init__(self) -> None:
        if not 0 <= self.percent <= 100:
            raise ValueError("progress percent must be in the range 0..100")


@dataclass(frozen=True)
class ErrorInfo:
    code: str
    message: str
    detail: str = ""
    retryable: bool = False


@dataclass
class Task:
    module: str
    action: str
    input: dict[str, Any]
    workspace: Path
    capabilities: dict[str, bool]
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    state: TaskState = TaskState.PENDING
    stage: str = "pending"
    progress: Progress = field(default_factory=Progress)
    outputs: list[ArtifactRef] = field(default_factory=list)
    logs: list[dict[str, str]] = field(default_factory=list)
    error: ErrorInfo | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_at: str | None = None
    finished_at: str | None = None

