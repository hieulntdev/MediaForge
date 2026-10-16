"""Small, dependency-free SRT parser used by the ZSP builder."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re


class SubtitleParseError(ValueError):
    pass


@dataclass(frozen=True)
class Subtitle:
    index: int
    start: float
    end: float
    content: str

    @property
    def start_ms(self) -> int:
        """SRT time on its native integer-millisecond clock."""
        return int(round(self.start * 1000.0))

    @property
    def end_ms(self) -> int:
        return int(round(self.end * 1000.0))

    @property
    def duration_seconds(self) -> float:
        return (self.end_ms - self.start_ms) / 1000.0


_TIMING_RE = re.compile(
    r"^\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*"
    r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$"
)


def _seconds(parts: tuple[str, str, str, str]) -> float:
    hours, minutes, seconds, millis = (int(value) for value in parts)
    if minutes > 59 or seconds > 59:
        raise SubtitleParseError("minutes and seconds must be between 00 and 59")
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def parse_srt(path: Path) -> list[Subtitle]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise SubtitleParseError(f"cannot read {path.name}: {exc}") from exc

    # Accept CRLF/CR as well as LF and tolerate extra blank lines between cues.
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise SubtitleParseError("subtitle file is empty")

    blocks = re.split(r"\n[ \t]*\n+", text)
    subtitles: list[Subtitle] = []
    for position, block in enumerate(blocks, 1):
        lines = block.split("\n")
        if len(lines) < 3:
            raise SubtitleParseError(f"cue {position} is incomplete")
        try:
            index = int(lines[0].strip())
        except ValueError as exc:
            raise SubtitleParseError(f"cue {position} has an invalid index") from exc

        match = _TIMING_RE.match(lines[1])
        if not match:
            raise SubtitleParseError(f"subtitle {index} has an invalid time range")
        try:
            start = _seconds(match.groups()[:4])
            end = _seconds(match.groups()[4:])
        except SubtitleParseError as exc:
            raise SubtitleParseError(f"subtitle {index}: {exc}") from exc
        if end <= start:
            raise SubtitleParseError(f"subtitle {index} must end after it starts")

        content = "\n".join(lines[2:]).strip()
        if not content:
            raise SubtitleParseError(f"subtitle {index} has no text")
        subtitles.append(Subtitle(index, start, end, content))

    return subtitles
