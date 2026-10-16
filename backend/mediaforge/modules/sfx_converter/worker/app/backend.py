from __future__ import annotations

import json
import logging
import sys
import threading
import traceback
from pathlib import Path
from threading import Event
from typing import Any, TextIO

from app import __version__
from app.services.errors import ProcessingCancelled
from app.settings import SETTINGS
from app.utils.logger import configure_logging


class ProtocolWriter:
    """Thread-safe JSON-lines writer used exclusively for Electron IPC."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, event_type: str, **payload: Any) -> None:
        message = json.dumps({"type": event_type, **payload}, ensure_ascii=False)
        with self._lock:
            self._stream.write(message + "\n")
            self._stream.flush()


class ProtocolLogHandler(logging.Handler):
    def __init__(self, protocol: ProtocolWriter) -> None:
        super().__init__(logging.INFO)
        self.protocol = protocol
        self.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.protocol.send("task:log", level=record.levelname, message=self.format(record))
        except Exception:
            self.handleError(record)


class BackendRuntime:
    def __init__(self, protocol: ProtocolWriter) -> None:
        self.protocol = protocol
        self.service: Any | None = None
        self.worker: threading.Thread | None = None
        self.cancel_event: Event | None = None
        self.job_id: str | None = None
        self._lock = threading.Lock()

    def _get_service(self) -> Any:
        if self.service is None:
            # Heavy ML imports stay out of backend startup and remain cached after
            # the first job, matching the former desktop application's behavior.
            from app.models.model_manager import ModelManager
            from app.models.sfc_locoformer import SFCLocoformerEngine
            from app.services.separation_service import SeparationService

            manager = ModelManager(SETTINGS.model_dir, SETTINGS.model)
            self.service = SeparationService(SETTINGS, SFCLocoformerEngine(manager, SETTINGS.model))
        return self.service

    def start(self, job_id: str, input_path: str, output_dir: str) -> None:
        with self._lock:
            if self.worker is not None and self.worker.is_alive():
                self.protocol.send("task:error", jobId=job_id, message="Another task is already running.")
                return
            self.job_id = job_id
            self.cancel_event = Event()
            self.worker = threading.Thread(
                target=self._run_job,
                args=(job_id, Path(input_path), Path(output_dir), self.cancel_event),
                name=f"separation-{job_id}",
                daemon=True,
            )
            self.worker.start()

    def _run_job(self, job_id: str, input_path: Path, output_dir: Path, cancel_event: Event) -> None:
        try:
            output = self._get_service().process(
                input_path,
                output_dir,
                state_callback=lambda state: self.protocol.send("task:state", jobId=job_id, state=state.value),
                progress_callback=lambda value: self.protocol.send("task:progress", jobId=job_id, value=value),
                cancel_event=cancel_event,
            )
            self.protocol.send("task:completed", jobId=job_id, outputPath=str(output))
        except ProcessingCancelled:
            self.protocol.send("task:cancelled", jobId=job_id)
        except Exception as exc:
            logging.getLogger(__name__).exception("Separation job failed")
            self.protocol.send("task:error", jobId=job_id, message=str(exc), detail=traceback.format_exc())
        finally:
            with self._lock:
                if self.job_id == job_id:
                    self.job_id = None
                    self.cancel_event = None
                    self.worker = None

    def cancel(self, job_id: str | None = None) -> None:
        with self._lock:
            if self.cancel_event is not None and (job_id is None or job_id == self.job_id):
                self.cancel_event.set()

    def shutdown(self) -> None:
        """Cancel active work and wait for its temporary-file cleanup."""
        self.cancel()
        with self._lock:
            worker = self.worker
        if worker is not None and worker.is_alive():
            worker.join()


def main() -> int:
    protocol = ProtocolWriter(sys.stdout)
    configure_logging(SETTINGS.log_dir, ProtocolLogHandler(protocol), console=False)
    runtime = BackendRuntime(protocol)
    protocol.send("backend:ready", version=__version__)

    for raw_line in sys.stdin:
        try:
            command = json.loads(raw_line)
            command_type = command.get("type")
            if command_type == "task:start":
                runtime.start(str(command["jobId"]), str(command["inputPath"]), str(command["outputDir"]))
            elif command_type == "task:cancel":
                runtime.cancel(command.get("jobId"))
            elif command_type == "backend:shutdown":
                runtime.shutdown()
                protocol.send("backend:shutdown-ack")
                return 0
            else:
                protocol.send("backend:error", message=f"Invalid backend command: {command_type}")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            protocol.send("backend:error", message=f"Invalid backend command: {exc}")
    runtime.cancel()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
