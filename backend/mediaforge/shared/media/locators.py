from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import shutil
import subprocess


@dataclass(frozen=True)
class ExecutableHealth:
    name: str
    executable: Path | None
    usable: bool
    version: str = ""
    error: str = ""


class ExecutableLocator:
    name = ""
    environment_variable = ""

    def resolve(self) -> Path:
        override = os.environ.get(self.environment_variable)
        candidate = override or shutil.which(self.name)
        if not candidate:
            raise FileNotFoundError(f"{self.name} was not found on PATH")
        return Path(candidate).expanduser().resolve()

    def health(self) -> ExecutableHealth:
        try:
            executable = self.resolve()
            result = subprocess.run(
                [str(executable), "-version"], capture_output=True, text=True,
                timeout=5, check=False,
            )
            output = (result.stdout or result.stderr).splitlines()
            return ExecutableHealth(
                self.name, executable, result.returncode == 0,
                output[0] if output else "",
                "" if result.returncode == 0 else (result.stderr or "unusable executable"),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return ExecutableHealth(self.name, None, False, error=str(exc))


class FFmpegLocator(ExecutableLocator):
    name = "ffmpeg"
    environment_variable = "MEDIAFORGE_FFMPEG"


class FFprobeLocator(ExecutableLocator):
    name = "ffprobe"
    environment_variable = "MEDIAFORGE_FFPROBE"

