from pathlib import Path

from app.models.model_manager import ModelManager
from app.settings import ModelSettings


def test_status_reports_missing_without_downloading(tmp_path: Path) -> None:
    manager = ModelManager(tmp_path, ModelSettings())
    status = manager.status()
    assert status["status"] == "missing"
    assert status["installed"] is False


def test_status_detects_corrupted_artifacts(tmp_path: Path) -> None:
    manager = ModelManager(tmp_path, ModelSettings())
    manager.checkpoint_path.parent.mkdir(parents=True)
    manager.checkpoint_path.write_bytes(b"bad")
    manager.config_path.write_bytes(b"bad")
    status = manager.status()
    assert status["status"] == "corrupted"
    assert status["installed"] is True
