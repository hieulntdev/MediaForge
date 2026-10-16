from __future__ import annotations

import logging
import tempfile
from collections.abc import Callable
from pathlib import Path
from threading import Event

from app.models.base import SeparationEngine
from app.services.audio_service import AudioService
from app.services.errors import ProcessingCancelled, SFXConverterError
from app.services.export_service import ExportService
from app.services.state import ProcessingState, ProcessingStateMachine
from app.services.video_service import VideoService
from app.settings import AppSettings

LOGGER = logging.getLogger(__name__)
StateCallback = Callable[[ProcessingState], None]
ProgressCallback = Callable[[int], None]


class SeparationService:
    def __init__(
        self,
        settings: AppSettings,
        engine: SeparationEngine,
        video_service: VideoService | None = None,
        audio_service: AudioService | None = None,
        export_service: ExportService | None = None,
    ) -> None:
        self.settings = settings
        self.engine = engine
        self.video_service = video_service or VideoService()
        self.audio_service = audio_service or AudioService()
        self.export_service = export_service or ExportService()
        self.state_machine = ProcessingStateMachine()

    def _set_state(self, state: ProcessingState, callback: StateCallback | None) -> None:
        self.state_machine.transition(state)
        if callback:
            callback(state)

    def process(
        self,
        video_path: Path,
        output_dir: Path,
        state_callback: StateCallback | None = None,
        progress_callback: ProgressCallback | None = None,
        cancel_event: Event | None = None,
    ) -> Path:
        cancel_event = cancel_event or Event()
        try:
            self._set_state(ProcessingState.VALIDATING, state_callback)
            LOGGER.info("Checking FFmpeg and probing input...")
            binaries, media = self.video_service.validate(video_path, cancel_event)
            self.export_service.validate_output_dir(output_dir)
            LOGGER.info(
                "Input audio: codec=%s, sample_rate=%s, channels=%s, duration=%s",
                media.audio_codec,
                media.audio_sample_rate or "unknown",
                media.audio_channels or "unknown",
                f"{media.duration_seconds:.1f}s" if media.duration_seconds is not None else "unknown",
            )

            final_output = self.export_service.choose_output_path(video_path, output_dir)
            with tempfile.TemporaryDirectory(prefix="sfx-converter-") as temp_dir_value:
                temp_dir = Path(temp_dir_value)
                extracted_audio = temp_dir / "model_input.wav"
                separated_sfx = temp_dir / "sfx.wav"

                self._set_state(ProcessingState.EXTRACTING_AUDIO, state_callback)
                LOGGER.info(
                    "Extracting audio for model: %d Hz, %d channel(s)...",
                    self.settings.model.sample_rate,
                    self.settings.model.channels,
                )
                self.audio_service.extract_for_model(
                    binaries.ffmpeg,
                    video_path,
                    extracted_audio,
                    self.settings.model.sample_rate,
                    self.settings.model.channels,
                    cancel_event,
                )

                self._set_state(ProcessingState.LOADING_MODEL, state_callback)
                self.engine.load(cancel_event)

                self._set_state(ProcessingState.SEPARATING, state_callback)
                LOGGER.info("Starting DnR separation; keeping only the SFX stem...")

                def on_segment(current: int, total: int) -> None:
                    percent = round(current * 100 / total)
                    if progress_callback:
                        progress_callback(percent)
                    LOGGER.info("Processing segment %d/%d (%d%%)", current, total, percent)

                self.engine.extract_sfx(extracted_audio, separated_sfx, on_segment, cancel_event)

                if cancel_event.is_set():
                    raise ProcessingCancelled("Processing was cancelled.")
                self._set_state(ProcessingState.EXPORTING, state_callback)
                LOGGER.info("Writing 24-bit PCM SFX output...")
                self.export_service.commit(separated_sfx, final_output)

            self._set_state(ProcessingState.COMPLETED, state_callback)
            LOGGER.info("Completed")
            LOGGER.info("Output: %s", final_output)
            return final_output
        except ProcessingCancelled:
            LOGGER.warning("Processing cancelled; temporary files were cleaned up")
            self._set_state(ProcessingState.IDLE, state_callback)
            raise
        except Exception as exc:
            self._set_state(ProcessingState.ERROR, state_callback)
            if isinstance(exc, SFXConverterError):
                raise
            if isinstance(exc, OSError):
                raise SFXConverterError(f"File system error: {exc}") from exc
            raise SFXConverterError(f"Processing failed: {exc}") from exc
