from __future__ import annotations

import io
import json
import threading
from pathlib import Path

from app.backend import BackendRuntime, ProtocolWriter
from app.services.errors import ProcessingCancelled


class SuccessfulService:
    def process(self, input_path, output_dir, state_callback, progress_callback, cancel_event):
        del input_path, cancel_event

        class State:
            value = "separating"

        state_callback(State())
        progress_callback(50)
        return output_dir / "result_sfx.wav"


def messages(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_protocol_writer_outputs_one_json_object_per_line() -> None:
    stream = io.StringIO()
    ProtocolWriter(stream).send("task:progress", jobId="one", value=25)
    assert messages(stream) == [{"type": "task:progress", "jobId": "one", "value": 25}]


def test_backend_runtime_streams_state_progress_and_completion(tmp_path: Path) -> None:
    stream = io.StringIO()
    runtime = BackendRuntime(ProtocolWriter(stream))
    runtime.service = SuccessfulService()

    runtime.start("job-1", str(tmp_path / "video.mp4"), str(tmp_path))
    assert runtime.worker is not None
    runtime.worker.join(timeout=2)

    emitted = messages(stream)
    assert [event["type"] for event in emitted] == ["task:state", "task:progress", "task:completed"]
    assert emitted[-1]["outputPath"] == str(tmp_path / "result_sfx.wav")


class CancellableService:
    def __init__(self) -> None:
        self.cleaned_up = threading.Event()

    def process(self, input_path, output_dir, state_callback, progress_callback, cancel_event):
        del input_path, output_dir, state_callback, progress_callback
        cancel_event.wait(timeout=2)
        self.cleaned_up.set()
        raise ProcessingCancelled("cancelled")


def test_backend_shutdown_waits_for_active_job_cleanup(tmp_path: Path) -> None:
    stream = io.StringIO()
    runtime = BackendRuntime(ProtocolWriter(stream))
    service = CancellableService()
    runtime.service = service

    runtime.start("job-1", str(tmp_path / "video.mp4"), str(tmp_path))
    runtime.shutdown()

    assert service.cleaned_up.is_set()
    assert runtime.worker is None
    assert messages(stream)[-1]["type"] == "task:cancelled"
