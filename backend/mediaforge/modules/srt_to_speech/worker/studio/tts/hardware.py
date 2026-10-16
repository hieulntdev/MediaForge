"""Platform and accelerator detection for the VieNeu-TTS v3 Turbo backend.

VieNeu-TTS v3 Turbo ships two engines: a torch-free ONNX Runtime engine that runs
on CPU, and a PyTorch engine used for GPU. The upstream project documents the
ONNX/CPU path as the fastest option on Apple Silicon -- measured faster than its
own MPS/PyTorch build -- so on macOS the ONNX/CPU path is treated as the
accelerator of record rather than MPS.

Nothing here is hard-coded to one platform: the plan is resolved from what the
machine actually reports, and every request that cannot be honoured degrades to
the ONNX/CPU path instead of failing the run.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
import platform
import sys
from typing import Any

BACKEND_ENV = "SRT_STUDIO_TTS_BACKEND"
DEVICE_ENV = "SRT_STUDIO_TTS_DEVICE"
PRECISION_ENV = "SRT_STUDIO_TTS_PRECISION"
THREADS_ENV = "SRT_STUDIO_TTS_THREADS"

AUTO = "auto"
ONNX_BACKEND = "onnx"
PYTORCH_BACKEND = "pytorch"
CPU_DEVICE = "cpu"
MPS_DEVICE = "mps"
CUDA_DEVICE = "cuda"

# ONNX graph variants published in the model repository: int8 (smaller/faster,
# upstream default) and fp32 (maximum quality, slower).
DEFAULT_PRECISION = "int8"
PRECISIONS = ("int8", "fp32")

APPLE_SILICON_REASON = (
    "macOS: the torch-free ONNX/CPU path is the upstream-recommended fastest "
    "backend on Apple Silicon"
)


@dataclass(frozen=True)
class RuntimePlan:
    """Resolved engine configuration handed to ``Vieneu(mode="v3turbo", ...)``."""

    backend: str
    device: str
    precision: str | None
    threads: int
    reason: str


def _text(value: object) -> str:
    return str(value).strip().lower() if value is not None else ""


def _torch() -> Any | None:
    """Return the imported ``torch`` module, or ``None`` when it is not installed."""
    try:
        import torch
    except Exception:
        return None
    return torch


def torch_version() -> str | None:
    torch = _torch()
    return getattr(torch, "__version__", None) if torch is not None else None


def mps_available() -> bool:
    """True only when MPS is both compiled in and usable on this machine."""
    torch = _torch()
    if torch is None:
        return False
    try:
        return bool(torch.backends.mps.is_built() and torch.backends.mps.is_available())
    except Exception:
        return False


def cuda_available() -> bool:
    torch = _torch()
    if torch is None:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def onnxruntime_version() -> str | None:
    try:
        import onnxruntime
    except Exception:
        return None
    return getattr(onnxruntime, "__version__", None)


def machine_architecture() -> str:
    return platform.machine() or "unknown"


def is_apple_silicon() -> bool:
    return sys.platform == "darwin" and machine_architecture().lower() == "arm64"


def running_under_rosetta() -> bool:
    """True when this interpreter is an x86_64 build translated by Rosetta."""
    if sys.platform != "darwin":
        return False
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        value = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(value))
        result = libc.sysctlbyname(
            b"sysctl.proc_translated",
            ctypes.byref(value),
            ctypes.byref(size),
            None,
            0,
        )
        return result == 0 and value.value == 1
    except Exception:
        return False


def architecture_warning() -> str | None:
    """Explain how to fix a non-native interpreter, or ``None`` when it is native."""
    if sys.platform != "darwin":
        return None
    architecture = machine_architecture().lower()
    if architecture == "arm64":
        return None
    detail = "running under Rosetta 2" if running_under_rosetta() else "an Intel build"
    return (
        f"Python interpreter is {detail} ({architecture}); install a native arm64 "
        "Python 3.12 (for example `brew install python@3.12`) so TTS runs natively "
        "and MPS/Neon code paths are available."
    )


def _threads(value: object) -> int:
    try:
        resolved = int(str(value).strip())
    except (TypeError, ValueError):
        return 0
    return resolved if resolved > 0 else 0


def _accelerated_device(requested: str) -> str | None:
    if requested == MPS_DEVICE:
        return MPS_DEVICE if mps_available() else None
    if requested == CUDA_DEVICE:
        return CUDA_DEVICE if cuda_available() else None
    return None


def _cpu_plan(threads: int, reason: str, precision: str) -> RuntimePlan:
    return RuntimePlan(ONNX_BACKEND, CPU_DEVICE, precision, threads, reason)


def resolve_runtime(
    backend: str | None = None,
    device: str | None = None,
    precision: str | None = None,
    threads: int | None = None,
) -> RuntimePlan:
    """Resolve the engine backend/device, honouring env overrides when present.

    Defaults are deliberately conservative: MPS and CUDA are used only when the
    operator asks for them explicitly *and* the machine reports them available.
    """
    backend = _text(backend) or _text(os.environ.get(BACKEND_ENV)) or AUTO
    device = _text(device) or _text(os.environ.get(DEVICE_ENV)) or AUTO
    precision = _text(precision) or _text(os.environ.get(PRECISION_ENV)) or DEFAULT_PRECISION
    resolved_threads = _threads(threads if threads is not None else os.environ.get(THREADS_ENV, ""))
    if precision not in PRECISIONS:
        precision = DEFAULT_PRECISION
    if device == "gpu":
        device = CUDA_DEVICE

    if backend == ONNX_BACKEND:
        return _cpu_plan(resolved_threads, "backend=onnx requested (the ONNX path is CPU-only)", precision)

    if backend == PYTORCH_BACKEND:
        accelerated = _accelerated_device(device)
        if accelerated is None:
            requested = device if device != AUTO else "an accelerator"
            return _cpu_plan(
                resolved_threads,
                f"backend=pytorch requested but {requested} is unavailable",
                precision,
            )
        return RuntimePlan(PYTORCH_BACKEND, accelerated, None, resolved_threads, f"backend=pytorch on {accelerated}")

    if backend != AUTO:
        return _cpu_plan(resolved_threads, f"unknown backend {backend!r}", precision)

    if device == CPU_DEVICE:
        return _cpu_plan(resolved_threads, "device=cpu requested", precision)

    if device in (MPS_DEVICE, CUDA_DEVICE):
        accelerated = _accelerated_device(device)
        if accelerated is None:
            return _cpu_plan(resolved_threads, f"device={device} requested but unavailable", precision)
        return RuntimePlan(PYTORCH_BACKEND, accelerated, None, resolved_threads, f"device={device} requested")

    # device == auto: pin macOS to the ONNX/CPU path, otherwise keep the upstream
    # decision (CUDA -> PyTorch, anything else -> ONNX/CPU) untouched.
    if sys.platform == "darwin":
        return _cpu_plan(resolved_threads, APPLE_SILICON_REASON, precision)
    if cuda_available():
        return RuntimePlan(AUTO, AUTO, precision, resolved_threads, "CUDA accelerator available")
    return _cpu_plan(resolved_threads, "no GPU accelerator available", precision)


def cpu_fallback(reason: str, precision: str | None = None) -> RuntimePlan:
    """The plan to retry with when an accelerated backend could not initialise."""
    return RuntimePlan(
        ONNX_BACKEND,
        CPU_DEVICE,
        precision if precision in PRECISIONS else DEFAULT_PRECISION,
        0,
        reason,
    )


def environment_lines() -> list[str]:
    """Short hardware/software summary for the terminal log and diagnostics."""
    lines = [
        f"Platform: {platform.system()} {platform.release()} ({machine_architecture()})",
        f"Python: {platform.python_version()} at {sys.executable}",
    ]
    warning = architecture_warning()
    if warning:
        lines.append(f"Architecture warning: {warning}")
    torch = torch_version()
    lines.append(f"PyTorch: {torch if torch else 'not installed (not required for the ONNX path)'}")
    mps = mps_available()
    lines.append(f"MPS available: {mps}")
    if not mps and sys.platform == "darwin":
        lines.append("MPS note: v3 Turbo has no Metal path upstream; ONNX/CPU is used instead")
    lines.append(f"CUDA available: {cuda_available()}")
    onnx = onnxruntime_version()
    if onnx:
        lines.append(f"ONNX Runtime: {onnx}")
    return lines


def plan_lines(plan: RuntimePlan) -> list[str]:
    precision = plan.precision or "n/a (PyTorch path)"
    threads = plan.threads or "engine default"
    return [
        f"TTS backend: {plan.backend}",
        f"TTS device: {plan.device}",
        f"TTS precision: {precision}",
        f"TTS threads: {threads}",
        f"TTS selection: {plan.reason}",
    ]


def log_environment(stream: Any = None) -> None:
    """Print the hardware/software summary as plain log lines."""
    output = stream if stream is not None else sys.stdout
    for line in environment_lines():
        print(line, file=output, flush=True)


def log_plan(plan: RuntimePlan, stream: Any = None) -> None:
    """Print the resolved engine plan as plain log lines."""
    output = stream if stream is not None else sys.stdout
    for line in plan_lines(plan):
        print(line, file=output, flush=True)


def empty_accelerator_cache(device: str) -> None:
    """Release cached GPU memory for ``device``; a no-op when it does not apply."""
    if device != MPS_DEVICE:
        return
    torch = _torch()
    empty_cache = getattr(getattr(torch, "mps", None), "empty_cache", None)
    if callable(empty_cache):
        try:
            empty_cache()
        except Exception:
            pass


def verify_mps_tensor() -> tuple[bool, str]:
    """Run one real Metal op so 'available' is proven, not just reported."""
    torch = _torch()
    if torch is None:
        return False, "PyTorch is not installed"
    if not mps_available():
        return False, "MPS is not available on this machine"
    try:
        probe = (torch.ones(8, device=MPS_DEVICE) * 2).sum().item()
    except Exception as exc:
        return False, f"MPS tensor probe failed: {exc}"
    return probe == 16.0, f"MPS tensor probe returned {probe}"


def _main(argv: list[str] | None = None) -> int:
    """Hardware diagnostic: `python3 -m tts.hardware`."""
    print("SRT-to-Speech Studio — hardware diagnostic\n")
    log_environment()
    for line in plan_lines(resolve_runtime()):
        print(line)
    ok, detail = verify_mps_tensor()
    print(f"MPS usable: {ok} ({detail})")
    warning = architecture_warning()
    if warning:
        print(f"\nACTION REQUIRED: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
