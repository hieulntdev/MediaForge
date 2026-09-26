import os
import shutil
import subprocess
from pathlib import Path


def find_ffmpeg() -> Path | None:
    p = os.environ.get("MEDIAFORGE_FFMPEG") or shutil.which("ffmpeg")
    return Path(p) if p else None


def build_mux_command(video: Path, audio: Path | None, output: Path, map_metadata: bool = True) -> list[str]:
    cmd = [str(find_ffmpeg() or "ffmpeg"), "-hide_banner", "-y", "-i", str(video)]
    if audio is not None:
        cmd += ["-i", str(audio)]
    cmd += ["-map", "0:v:0"]
    if audio is not None:
        cmd += ["-map", "1:a:0"]
    cmd += ["-c", "copy"]
    if map_metadata:
        cmd += ["-map_metadata", "0"]
    cmd += [str(output)]
    return cmd


def run_ffmpeg(args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stderr
