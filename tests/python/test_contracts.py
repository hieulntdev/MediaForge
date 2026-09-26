from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from mediaforge.core.contracts.artifacts import ArtifactRef, ProducerRef
from mediaforge.core.contracts.events import EventEnvelope
from mediaforge.core.module_registry import ModuleRegistry
from mediaforge.shared.media.locators import FFmpegLocator, FFprobeLocator


class ContractTests(unittest.TestCase):
    def test_artifact_requires_file_uri(self) -> None:
        producer = ProducerRef("task", "module", "action")
        with self.assertRaises(ValueError):
            ArtifactRef("media.video", "https://example.test/video", "video/mp4", producer, "user-output")

    def test_event_serializes_canonical_field_names(self) -> None:
        value = EventEnvelope("task.progress", "task", "module", "action").to_dict()
        self.assertEqual(value["schemaVersion"], 1)
        self.assertEqual(value["taskId"], "task")

    def test_registry_discovers_three_modules(self) -> None:
        registry = ModuleRegistry(ROOT / "backend" / "mediaforge" / "modules")
        self.assertEqual(len(registry.discover()), 3)

    def test_locators_report_usable_system_binaries(self) -> None:
        self.assertTrue(FFmpegLocator().health().usable)
        self.assertTrue(FFprobeLocator().health().usable)


if __name__ == "__main__":
    unittest.main()

