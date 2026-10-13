"""Lightweight MediaForge backend contracts.

Model-specific dependencies intentionally live outside this package and are
loaded only by their owning worker runtime.
"""

import json
from pathlib import Path


def _application_version() -> str:
    package_file = Path(__file__).resolve().parents[2] / "package.json"
    return str(json.loads(package_file.read_text(encoding="utf-8"))["version"])


__version__ = _application_version()

