from abc import ABC, abstractmethod
from dataclasses import dataclass

from src.models.video_info import VideoInfo


@dataclass
class ExtractOptions:
    cookies_file: str | None = None
    cookies_from_browser: str | None = None


class ExtractorError(Exception):
    """Base error for any extractor failure."""


class ExtractorUnavailable(ExtractorError):
    """Raised when an extractor cannot be used (missing dependency, etc.)."""


class BilibiliExtractor(ABC):
    @abstractmethod
    def extract(self, url: str, opts: ExtractOptions) -> list[VideoInfo]:
        """Return one VideoInfo per video (single/multi-P/playlist)."""

    @abstractmethod
    def is_available(self) -> bool:
        """Whether this engine can run right now (e.g. yt-dlp importable)."""
