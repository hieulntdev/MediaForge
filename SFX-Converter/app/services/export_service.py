from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

from app.services.errors import ValidationError
from app.utils.paths import next_available_output


class ExportService:
    def validate_output_dir(self, output_dir: Path) -> None:
        if not output_dir.is_dir():
            raise ValidationError(f"Output folder does not exist: {output_dir}")
        if not os.access(output_dir, os.W_OK):
            raise ValidationError(f"Output folder is not writable: {output_dir}")

    def choose_output_path(self, video_path: Path, output_dir: Path) -> Path:
        self.validate_output_dir(output_dir)
        return next_available_output(video_path, output_dir)

    def commit(self, source_path: Path, destination: Path) -> None:
        partial_path = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
        try:
            shutil.copyfile(source_path, partial_path)
            os.replace(partial_path, destination)
        finally:
            partial_path.unlink(missing_ok=True)
