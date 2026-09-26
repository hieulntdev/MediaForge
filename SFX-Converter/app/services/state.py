from __future__ import annotations

from enum import Enum


class ProcessingState(str, Enum):
    IDLE = "idle"
    VALIDATING = "validating"
    EXTRACTING_AUDIO = "extracting_audio"
    LOADING_MODEL = "loading_model"
    SEPARATING = "separating"
    EXPORTING = "exporting"
    COMPLETED = "completed"
    ERROR = "error"


ALLOWED_TRANSITIONS: dict[ProcessingState, set[ProcessingState]] = {
    ProcessingState.IDLE: {ProcessingState.VALIDATING},
    ProcessingState.VALIDATING: {ProcessingState.EXTRACTING_AUDIO, ProcessingState.ERROR, ProcessingState.IDLE},
    ProcessingState.EXTRACTING_AUDIO: {ProcessingState.LOADING_MODEL, ProcessingState.ERROR, ProcessingState.IDLE},
    ProcessingState.LOADING_MODEL: {ProcessingState.SEPARATING, ProcessingState.ERROR, ProcessingState.IDLE},
    ProcessingState.SEPARATING: {ProcessingState.EXPORTING, ProcessingState.ERROR, ProcessingState.IDLE},
    ProcessingState.EXPORTING: {ProcessingState.COMPLETED, ProcessingState.ERROR, ProcessingState.IDLE},
    ProcessingState.COMPLETED: {ProcessingState.IDLE, ProcessingState.VALIDATING},
    ProcessingState.ERROR: {ProcessingState.IDLE, ProcessingState.VALIDATING},
}


class ProcessingStateMachine:
    def __init__(self) -> None:
        self._state = ProcessingState.IDLE

    @property
    def state(self) -> ProcessingState:
        return self._state

    def transition(self, next_state: ProcessingState) -> None:
        if next_state not in ALLOWED_TRANSITIONS[self._state]:
            raise ValueError(f"Invalid state transition: {self._state.value} -> {next_state.value}")
        self._state = next_state
