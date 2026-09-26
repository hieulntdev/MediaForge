import pytest

from app.services.state import ProcessingState, ProcessingStateMachine


def test_happy_path_state_transitions() -> None:
    machine = ProcessingStateMachine()
    for state in (
        ProcessingState.VALIDATING,
        ProcessingState.EXTRACTING_AUDIO,
        ProcessingState.LOADING_MODEL,
        ProcessingState.SEPARATING,
        ProcessingState.EXPORTING,
        ProcessingState.COMPLETED,
    ):
        machine.transition(state)
    assert machine.state is ProcessingState.COMPLETED


def test_invalid_transition_is_rejected() -> None:
    machine = ProcessingStateMachine()
    with pytest.raises(ValueError, match="Invalid state transition"):
        machine.transition(ProcessingState.SEPARATING)
