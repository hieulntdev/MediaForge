"""Size the ASR worker pool from physical CPU cores.

ASR runs its content-validation pass after each TTS pass finishes (see
``pipeline.py``'s ``drain_asr_queue``), so at that point the whole machine is
free for it. The workload is many short WAV files, so throughput comes from
running several independent ``transcribe()`` calls at once (CTranslate2's
``inter_threads``/``num_workers``) rather than from giving one call a large
intra-op thread count (``cpu_threads``) -- hence the fixed, small
per-worker thread floor below instead of splitting the whole budget into one
wide worker.
"""

from __future__ import annotations

from dataclasses import dataclass
import os

# A per-worker intra-op thread count high enough for reasonable CTranslate2
# efficiency, low enough to leave most of the CPU budget for spreading across
# independent workers instead of one wide one.
DEFAULT_CPU_THREADS_PER_WORKER = 2

# Sanity ceiling for a hand-crafted ``asr_workers`` override, mirroring
# MAX_PROCESSOR_COUNT in pipeline.py: stops an absurd value from starting
# thousands of threads against one shared WhisperModel.
MAX_ASR_WORKERS = 32


@dataclass(frozen=True)
class AsrCpuPlan:
    physical_cores: int
    logical_cores: int
    budget_cores: int
    num_workers: int
    cpu_threads: int

    @property
    def total_threads(self) -> int:
        return self.num_workers * self.cpu_threads


def detect_cpu_counts() -> tuple[int, int]:
    """Return ``(physical, logical)`` core counts.

    Physical cores are preferred for the CPU budget -- logical (hyperthread)
    cores overstate how much independent work the CPU can actually do.
    Falls back to logical cores, then ``os.cpu_count()``, when psutil is
    unavailable or cannot report a physical count (e.g. some containers).
    """
    physical: int | None = None
    logical: int | None = None
    try:
        import psutil

        physical = psutil.cpu_count(logical=False)
        logical = psutil.cpu_count(logical=True)
    except Exception:
        pass
    if not logical:
        logical = os.cpu_count() or 1
    if not physical:
        physical = logical
    return physical, logical


def _budget(physical: int) -> int:
    # Reserve 1 physical core for the OS/UI; never drop to a zero budget.
    return max(1, physical - 1)


def _auto_plan(physical: int, logical: int) -> AsrCpuPlan:
    budget = _budget(physical)
    threads_per_worker = (
        DEFAULT_CPU_THREADS_PER_WORKER if budget >= DEFAULT_CPU_THREADS_PER_WORKER else 1
    )
    num_workers = max(1, budget // threads_per_worker)
    return AsrCpuPlan(physical, logical, budget, num_workers, threads_per_worker)


def resolve_asr_cpu_plan(override: object = None) -> tuple[AsrCpuPlan, str | None]:
    """Resolve ASR worker-pool sizing, plus an explanation when input is rejected.

    ``override`` of ``None`` or ``"auto"`` (case-insensitive) derives worker
    and thread counts from physical CPU cores. Any other value is parsed as
    an explicit worker count; an invalid, non-positive, or boolean value
    falls back to Auto with an explanatory message -- the same pattern
    ``validate_processor_count`` uses for the TTS worker count. A count above
    ``MAX_ASR_WORKERS`` is clamped rather than rejected.
    """
    physical, logical = detect_cpu_counts()
    if override is None or (isinstance(override, str) and override.strip().lower() in ("", "auto")):
        return _auto_plan(physical, logical), None

    try:
        if isinstance(override, bool):
            raise ValueError("boolean is not an ASR worker count")
        requested = int(override) if isinstance(override, (int, float)) else int(str(override).strip())
    except (TypeError, ValueError, OverflowError):
        return _auto_plan(physical, logical), (
            f"Invalid ASR worker count {override!r}: falling back to Auto."
        )
    if requested < 1:
        return _auto_plan(physical, logical), (
            f"Invalid ASR worker count {requested}: falling back to Auto."
        )

    warning: str | None = None
    if requested > MAX_ASR_WORKERS:
        warning = (
            f"ASR worker count {requested} is above the supported maximum "
            f"{MAX_ASR_WORKERS}: using {MAX_ASR_WORKERS}."
        )
        requested = MAX_ASR_WORKERS

    budget = _budget(physical)
    cpu_threads = max(1, budget // requested)
    return AsrCpuPlan(physical, logical, budget, requested, cpu_threads), warning


def plan_log_lines(plan: AsrCpuPlan) -> list[str]:
    return [
        f"CPU: {plan.physical_cores} physical / {plan.logical_cores} logical",
        f"ASR CPU budget: {plan.budget_cores} cores",
        f"ASR workers: {plan.num_workers}",
        f"Threads per worker: {plan.cpu_threads}",
        f"Total ASR threads: {plan.total_threads}",
        "WhisperModel instances: 1",
    ]
