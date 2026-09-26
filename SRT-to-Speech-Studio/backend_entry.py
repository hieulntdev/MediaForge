"""Console worker spawned by the Electron main process."""

from __future__ import annotations

import argparse
import importlib
import os
from pathlib import Path
import sys
import zipfile

from studio import bootstrap


def _extract_preview(archive_path: Path, filename: str, output_dir: Path) -> int:
    """Extract one generated WAV without trusting paths from the renderer."""
    if Path(filename).name != filename or not filename.lower().endswith(".wav"):
        raise ValueError("invalid preview filename")
    archive_path = archive_path.resolve(strict=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir.resolve() / filename
    member = f"audio_cache/{filename}"
    with zipfile.ZipFile(archive_path) as archive:
        data = archive.read(member)
    destination.write_bytes(data)
    print(destination, flush=True)
    return 0


def _configure_environment() -> None:
    os.environ["SRT_STUDIO_APP_DIR"] = str(bootstrap.application_dir())
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


def _run_in_process(source: Path, module_name: str, arguments: list[str]) -> int:
    """Run the pipeline on this interpreter (macOS has no private runtime)."""
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))
    module = importlib.import_module(module_name)
    return int(module.main(list(arguments)))


def _run_worker(arguments: list[str]) -> int:
    selected_model = "vieneu"
    try:
        model_index = arguments.index("--tts-model")
        selected_model = arguments[model_index + 1]
    except (ValueError, IndexError):
        pass
    bootstrap.prepare_runtime(selected_model)
    source = bootstrap.bundled_app_dir()
    pipeline = source / "studio" / "pipeline.py"
    if not pipeline.is_file():
        raise bootstrap.BootstrapError("bundled synthesis source is missing")

    _configure_environment()
    # The prepared runtime *is* this interpreter, so the model is owned by a
    # single process that Electron can terminate directly.
    return _run_in_process(source, "studio.pipeline", arguments)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--extract-preview", action="store_true")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--filename")
    parser.add_argument("--preview-dir", type=Path)
    known, remaining = parser.parse_known_args(argv)
    try:
        if known.extract_preview:
            if not known.archive or not known.filename or not known.preview_dir:
                raise ValueError("preview extraction arguments are incomplete")
            return _extract_preview(
                known.archive, known.filename, known.preview_dir
            )
        return _run_worker(remaining)
    except Exception as exc:
        print(f"BACKEND ERROR: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
