from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path
from threading import Event

ProgressCallback = Callable[[int, int], None]


class SeparationEngine(ABC):
    """Backend-neutral interface used by the service layer."""

    @abstractmethod
    def load(self, cancel_event: Event | None = None) -> None:
        """Load model resources, downloading verified weights if necessary."""

    @abstractmethod
    def extract_sfx(
        self,
        audio_path: Path,
        output_path: Path,
        progress_callback: ProgressCallback | None = None,
        cancel_event: Event | None = None,
    ) -> None:
        """Extract only the effects stem to a PCM WAV file."""

    def unload(self) -> None:
        """Release model resources when explicitly requested."""
        return None
