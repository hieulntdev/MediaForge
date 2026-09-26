# tests/test_asr_whisper_engine.py
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.asr.whisper_engine import WhisperASREngine


class WhisperEngineLifecycleTests(unittest.TestCase):
    def test_transcribe_before_load_raises(self) -> None:
        engine = WhisperASREngine()
        with self.assertRaises(RuntimeError):
            engine.transcribe(Path("does-not-matter.wav"))


if __name__ == "__main__":
    unittest.main()
