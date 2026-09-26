#!/bin/sh
# Set up and launch SRT-to-Speech Studio on macOS.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MAIN_VENV="$SCRIPT_DIR/.venv"
MAIN_PYTHON="$MAIN_VENV/bin/python3"
MELO_VENV="$SCRIPT_DIR/.venv-melotts"
MELO_PYTHON="$MELO_VENV/bin/python3"
PREFERRED_PYTHON="3.12"
MELO_REVISION="209145371cff8fc3bd60d7be902ea69cbdb7965a"

fail() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  ./studio.sh setup [vieneu|melotts|all]
  ./studio.sh run

`setup` defaults to VieNeu. MeloTTS remains in .venv-melotts because its
dependency versions conflict with the VieNeu runtime.
EOF
}

check_platform() {
    [ "$(uname -s)" = "Darwin" ] || fail "this script targets macOS; detected $(uname -s)."
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
        printf 'Platform: macOS on Apple Silicon (%s)\n' "$ARCH"
    else
        printf 'WARNING: %s is not Apple Silicon; some wheels may be unavailable.\n' "$ARCH" >&2
    fi
}

find_python() {
    for candidate in "python$PREFERRED_PYTHON" python3.13 python3.12 python3.11 python3.10 python3; do
        path="$(command -v "$candidate" 2>/dev/null || true)"
        [ -n "$path" ] || continue
        if "$path" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
            printf '%s' "$path"
            return 0
        fi
    done
    return 1
}

verify_native_python() {
    python_path="$1"
    [ "$(uname -m)" = "arm64" ] || return 0
    "$python_path" -c '
import platform, sys
if platform.machine() != "arm64":
    sys.exit("the selected Python is an x86_64 build (Rosetta)")
' || fail "install a native Python with: brew install python@3.12"
}

setup_vieneu() {
    check_platform
    python_path="$(find_python || true)"
    if [ -z "$python_path" ]; then
        fail "Python 3.10 or newer was not found. Install it with: brew install python@$PREFERRED_PYTHON"
    fi
    printf 'Python: %s (%s)\n' "$python_path" "$("$python_path" -c 'import platform; print(platform.python_version())')"
    verify_native_python "$python_path"

    if [ -x "$MAIN_PYTHON" ]; then
        printf 'VieNeu environment: reusing %s\n' "$MAIN_VENV"
    else
        printf 'VieNeu environment: creating %s\n' "$MAIN_VENV"
        "$python_path" -m venv "$MAIN_VENV"
    fi

    "$MAIN_PYTHON" -m pip install --upgrade pip
    printf 'Installing pinned VieNeu runtime libraries...\n'
    "$MAIN_PYTHON" -m pip install --only-binary=:all: -r "$SCRIPT_DIR/requirements.txt"
    "$MAIN_PYTHON" -m pip install --no-deps "vieneu==3.3.0"

    printf 'Checking the VieNeu runtime...\n'
    "$MAIN_PYTHON" -c '
import sys
from studio import bootstrap
try:
    bootstrap.prepare_runtime()
except bootstrap.BootstrapError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    raise SystemExit(1)
'

    if command -v ffmpeg >/dev/null 2>&1; then
        printf 'FFmpeg: found at %s\n' "$(command -v ffmpeg)"
    else
        printf 'FFmpeg: missing; install it with `brew install ffmpeg` for duration matching.\n'
    fi
    printf '\nVieNeu setup complete. The first synthesis downloads model weights.\n'
}

setup_melotts() {
    check_platform
    [ -x "$MAIN_PYTHON" ] || fail "the main .venv is missing. Run ./studio.sh setup vieneu first."
    verify_native_python "$MAIN_PYTHON"
    "$MAIN_PYTHON" -c '
import sys
if sys.version_info < (3, 10):
    sys.exit("MeloTTS requires Python 3.10 or newer")
'

    if [ -x "$MELO_PYTHON" ]; then
        printf 'MeloTTS environment: reusing %s\n' "$MELO_VENV"
    else
        printf 'MeloTTS environment: creating %s\n' "$MELO_VENV"
        "$MAIN_PYTHON" -m venv "$MELO_VENV"
    fi

    "$MELO_PYTHON" -m pip install --upgrade pip
    printf 'Installing the Python 3.12-compatible MeloTTS runtime...\n'
    "$MELO_PYTHON" -m pip install -r "$SCRIPT_DIR/requirements-melotts.txt"

    # These packages differ only by case on the default macOS filesystem.
    # Restore the Japanese module after Korean, then patch g2pkk imports.
    "$MELO_PYTHON" -m pip install \
        "python-mecab-ko==1.3.7" "python-mecab-ko-dic==2.1.1.post2"
    "$MELO_PYTHON" -m pip install --force-reinstall --no-deps "mecab-python3==1.0.9"
    "$MELO_PYTHON" "$SCRIPT_DIR/scripts/patch_melotts_mecab.py"
    "$MELO_PYTHON" -m pip install --no-deps \
        "melotts @ git+https://github.com/myshell-ai/MeloTTS.git@$MELO_REVISION"

    if "$MELO_PYTHON" -c '
from pathlib import Path
import unidic
raise SystemExit(0 if (Path(unidic.DICDIR) / "dicrc").is_file() else 1)
'; then
        printf 'UniDic: existing dictionary found; skipping download.\n'
    else
        "$MELO_PYTHON" -m unidic download
    fi

    "$MELO_PYTHON" -c '
import nltk
for resource in ("averaged_perceptron_tagger_eng", "cmudict"):
    nltk.download(resource, quiet=True, raise_on_error=True)
'

    printf 'Checking the MeloTTS runtime...\n'
    "$MELO_PYTHON" -c '
import sys
from importlib.metadata import version
import torch
import torchaudio
import MeCab
from g2pkk import G2p
from melo.api import TTS
from studio import bootstrap

bootstrap.prepare_runtime("melotts")
if not hasattr(MeCab, "Tagger"):
    raise RuntimeError("mecab-python3 was overwritten by an incompatible MeCab package")
MeCab.Tagger().parse("テスト")
G2p()("테스트")
print(f"MeloTTS import: ready (Python {sys.version.split()[0]})")
print(f"PyTorch: {torch.__version__}; torchaudio: {torchaudio.__version__}")
print(f"fugashi: {version('fugashi')}")
'
    printf '\nMeloTTS setup complete in .venv-melotts.\n'
}

run_app() {
    python_path="${SRT_STUDIO_PYTHON:-}"
    if [ -z "$python_path" ] && [ -x "$MAIN_PYTHON" ]; then
        python_path="$MAIN_PYTHON"
    fi
    if [ -z "$python_path" ]; then
        python_path="$(command -v python3 2>/dev/null || true)"
    fi
    [ -n "$python_path" ] || fail "no Python interpreter found. Run ./studio.sh setup vieneu first."
    export SRT_STUDIO_PYTHON="$python_path"

    "$python_path" -c '
import sys
from studio import bootstrap
try:
    bootstrap.prepare_runtime()
except bootstrap.BootstrapError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    raise SystemExit(1)
' || fail "the TTS runtime is not ready. Run ./studio.sh setup vieneu."

    command -v npm >/dev/null 2>&1 || fail "Node.js/npm is required. Install it with: brew install node"
    cd "$SCRIPT_DIR/electron-app"
    if [ ! -d node_modules ]; then
        printf 'Installing Electron dependencies (first run only)...\n'
        npm install
    fi
    unset ELECTRON_RUN_AS_NODE
    exec npm start
}

case "${1:-}" in
    setup)
        case "${2:-vieneu}" in
            vieneu) setup_vieneu ;;
            melotts) setup_melotts ;;
            all) setup_vieneu; setup_melotts ;;
            *) usage; exit 2 ;;
        esac
        printf 'Start the application with: ./studio.sh run\n'
        ;;
    run) run_app ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
esac
