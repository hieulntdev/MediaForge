import json
import os
import shutil
import subprocess
from pathlib import Path


def find_ffprobe() -> Path | None:
    p = os.environ.get("MEDIAFORGE_FFPROBE") or shutil.which("ffprobe")
    return Path(p) if p else None


def probe(file: Path) -> dict:
    proc = subprocess.run(
        [str(find_ffprobe() or "ffprobe"), "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", str(file)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr}")
    return json.loads(proc.stdout)
