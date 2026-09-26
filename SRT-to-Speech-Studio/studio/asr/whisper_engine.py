# studio/asr/whisper_engine.py
"""Wrap faster-whisper behind the same load-once/keep-resident lifecycle
studio/tts/vieneu_engine.py uses for the TTS model, so the ASR model is never
reloaded per subtitle line.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

# vinai/PhoWhisper is fine-tuned for Vietnamese (tone marks, Han-Viet proper
# nouns) instead of generic multilingual Whisper. The upstream repo ships
# PyTorch/Transformers weights only; this is a community CTranslate2
# conversion faster-whisper can load directly. It publishes all 5 sizes as
# subfolders of one repo rather than one repo per size, so it can't be
# handed to WhisperModel(...) as a plain repo id (faster-whisper's own
# downloader expects the CTranslate2 files at the repo root) -- the
# "repo::subfolder" form below is resolved in _resolve_model_path().
PHOWHISPER_REPO = "quocphu/PhoWhisper-ct2-FasterWhisper"
ASR_MODEL_NAME = f"{PHOWHISPER_REPO}::PhoWhisper-medium-ct2-fasterWhisper"


class ASREngine(Protocol):
    def load_model(self) -> None: ...
    def transcribe(self, wav_path: Path) -> str: ...
    def close(self) -> None: ...


class WhisperASREngine:
    """faster-whisper (CTranslate2) engine, CPU-only, model loaded once.

    ``num_workers``/``cpu_threads`` map straight to CTranslate2's
    ``inter_threads``/``intra_threads``: one model instance, shared by
    however many ASR worker threads call ``transcribe()`` concurrently (see
    ``asr.cpu_plan``).
    """

    def __init__(self, model_name: str = ASR_MODEL_NAME, num_workers: int = 1, cpu_threads: int = 0) -> None:
        self.model_name = model_name
        self.num_workers = num_workers
        self.cpu_threads = cpu_threads
        self._model = None

    def _resolve_model_path(self) -> str:
        """Turn a ``"repo::subfolder"`` model name into a local directory.

        Anything without ``"::"`` (a plain size like ``"medium"``, a local
        path, or an ordinary single-model HF repo id) passes through
        unchanged -- faster-whisper's own ``download_model()`` handles it.
        """
        if "::" not in self.model_name:
            return self.model_name
        repo_id, subfolder = self.model_name.split("::", 1)
        from huggingface_hub import snapshot_download  # faster-whisper dependency

        local_dir = snapshot_download(repo_id, allow_patterns=[f"{subfolder}/*"])
        return str(Path(local_dir) / subfolder)

    def load_model(self) -> None:
        from faster_whisper import WhisperModel  # imported lazily, mirrors TTSEngine

        self._model = WhisperModel(
            self._resolve_model_path(), device="cpu", compute_type="int8",
            num_workers=self.num_workers, cpu_threads=self.cpu_threads,
        )

    def transcribe(self, wav_path: Path) -> str:
        if self._model is None:
            raise RuntimeError("WhisperASREngine.load_model() must run before transcribe()")
        segments, _info = self._model.transcribe(str(wav_path), language="vi", beam_size=5)
        return " ".join(segment.text.strip() for segment in segments).strip()

    def close(self) -> None:
        self._model = None
