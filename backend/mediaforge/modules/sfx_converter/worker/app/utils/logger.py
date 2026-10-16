from __future__ import annotations

import logging
from pathlib import Path


def configure_logging(
    log_dir: Path,
    extra_handler: logging.Handler | None = None,
    *,
    console: bool = True,
) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s")
    if console:
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        root.addHandler(console_handler)

    file_handler = logging.FileHandler(log_dir / "sfx-converter.log", encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    if extra_handler is not None:
        root.addHandler(extra_handler)
