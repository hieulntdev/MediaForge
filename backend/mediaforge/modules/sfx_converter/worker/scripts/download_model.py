from __future__ import annotations

import json
import logging
import sys

from app.models.model_manager import ModelManager
from app.settings import SETTINGS


def main(argv: list[str] | None = None) -> int:
    arguments = argv if argv is not None else sys.argv[1:]
    if arguments not in ([], ["status"], ["prefetch"]):
        raise SystemExit("Usage: python -m scripts.download_model [status|prefetch]")

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    manager = ModelManager(SETTINGS.model_dir, SETTINGS.model)
    if not arguments:
        path = manager.ensure_installed()
        print(f"Verified model: {path}")
        return 0

    if arguments == ["prefetch"]:
        manager.ensure_installed()
    status = manager.status()
    print(json.dumps(status, ensure_ascii=False, default=str), flush=True)
    return 0 if status["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
