"""Prepare the TTS runtime used by SRT-to-Speech Studio.

The runtime is the project virtual environment itself, so this module only
verifies it.
"""

from __future__ import annotations

from importlib import util as importlib_util
from pathlib import Path
import platform
import sys

from studio.tts import hardware


# Runtime modules the pipeline imports; checked instead of installed on macOS.
RUNTIME_MODULES = (
    "numpy",
    "onnxruntime",
    "soundfile",
    "soxr",
    "kaldi_native_fbank",
    "sea_g2p",
    "tokenizers",
    "huggingface_hub",
    "vieneu",
)
MELOTTS_RUNTIME_MODULES = (
    "numpy",
    "soundfile",
    "soxr",
    "torch",
    "melo",
)
MINIMUM_PYTHON = (3, 10)


class BootstrapError(RuntimeError):
    pass


def application_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def bundled_app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "app"
    return Path(__file__).resolve().parent.parent


def missing_runtime_modules(modules: tuple[str, ...] = RUNTIME_MODULES) -> list[str]:
    """Return the pipeline modules this interpreter cannot import."""
    missing: list[str] = []
    for name in modules:
        try:
            available = importlib_util.find_spec(name) is not None
        except (ImportError, ValueError):
            available = False
        if not available:
            missing.append(name)
    return missing


def native_runtime(tts_model: str = "vieneu") -> Path:
    """Verify the running interpreter can execute the pipeline and return it."""
    if sys.version_info < MINIMUM_PYTHON:
        raise BootstrapError(
            f"Python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or newer is required, but "
            f"{platform.python_version()} is running ({sys.executable}). "
            "See README.md for the supported setup."
        )
    warning = hardware.architecture_warning()
    if warning:
        print(f"WARNING: {warning}", flush=True)
    selected = str(tts_model or "vieneu").strip().lower()
    modules = MELOTTS_RUNTIME_MODULES if selected in {"melo", "melotts"} else RUNTIME_MODULES
    missing = missing_runtime_modules(modules)
    if missing:
        if modules is MELOTTS_RUNTIME_MODULES:
            raise BootstrapError(
                "the optional MeloTTS runtime is incomplete (missing: "
                + ", ".join(missing)
                + "). Run `./studio.sh setup melotts`. MeloTTS is installed in its "
                "own environment; VieNeu remains available without it."
            )
        raise BootstrapError(
            "the TTS runtime is incomplete (missing: "
            + ", ".join(missing)
            + "). Run `./studio.sh setup vieneu`, or follow the manual setup in README.md."
        )
    print(
        f"Runtime libraries: ready (Python {platform.python_version()} at {sys.executable})",
        flush=True,
    )
    return Path(sys.executable)


def prepare_runtime(tts_model: str = "vieneu") -> Path:
    return native_runtime(tts_model)
