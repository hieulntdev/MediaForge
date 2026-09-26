from __future__ import annotations

import logging
from argparse import ArgumentParser
from pathlib import Path

from app.models.model_manager import ModelManager
from app.models.sfc_locoformer import SFCLocoformerEngine
from app.services.separation_service import SeparationService
from app.settings import SETTINGS


def main() -> None:
    parser = ArgumentParser(description="SFC-Locoformer VIDEO-to-SFX smoke test")
    parser.add_argument("input_video", type=Path)
    parser.add_argument("output", type=Path, help="Output WAV path or destination directory")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
    manager = ModelManager(SETTINGS.model_dir, SETTINGS.model)
    service = SeparationService(SETTINGS, SFCLocoformerEngine(manager, SETTINGS.model))
    output_dir = args.output if args.output.suffix.lower() != ".wav" else args.output.parent
    result = service.process(args.input_video.resolve(), output_dir.resolve())

    if args.output.suffix.lower() == ".wav" and result != args.output.resolve():
        requested = args.output.resolve()
        if requested.exists():
            raise FileExistsError(f"Refusing to overwrite: {requested}")
        result.replace(requested)
        result = requested
    print(result)


if __name__ == "__main__":
    main()
