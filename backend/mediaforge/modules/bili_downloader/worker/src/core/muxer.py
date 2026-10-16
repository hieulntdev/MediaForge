from pathlib import Path

from src.utils.ffmpeg import build_mux_command, find_ffmpeg, run_ffmpeg
from src.utils.logger import get_logger

log = get_logger()


class MuxError(Exception):
    pass


def mux(video: Path, audio: Path | None, output: Path) -> None:
    if find_ffmpeg() is None:
        raise MuxError("FFmpeg is required. Install: brew install ffmpeg")
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = build_mux_command(video, audio, output)
    log.debug("mux: %s", " ".join(cmd))
    code, stderr = run_ffmpeg(cmd)
    if code != 0:
        raise MuxError(f"Mux failed: {stderr.strip()}")
