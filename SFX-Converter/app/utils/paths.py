from __future__ import annotations

from pathlib import Path


def output_filename(video_path: Path) -> str:
    return f"{video_path.stem}_sfx.wav"


def next_available_output(video_path: Path, output_dir: Path) -> Path:
    candidate = output_dir / output_filename(video_path)
    if not candidate.exists():
        return candidate

    index = 1
    while True:
        candidate = output_dir / f"{video_path.stem}_sfx_{index}.wav"
        if not candidate.exists():
            return candidate
        index += 1
