#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
python_bin="${MEDIAFORGE_BOOTSTRAP_PYTHON:-python3.12}"

"$python_bin" - <<'PY'
import platform
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"MediaForge requires Python 3.12, found {platform.python_version()}")
if platform.machine() != "arm64":
    raise SystemExit(f"MediaForge requires Apple Silicon arm64, found {platform.machine()}")
PY

for runtime_id in base sfx tts-vieneu tts-melotts; do
  environment="$project_root/runtimes/envs/$runtime_id"
  "$python_bin" -m venv "$environment"
  "$environment/bin/python" -m pip install --upgrade pip
  # The lock snapshots already contain the full reviewed transitive set. Avoid
  # re-resolving optional UI dependencies from packages such as VieNeu.
  "$environment/bin/python" -m pip install --no-deps -r "$project_root/runtimes/$runtime_id/requirements.lock"
done

"$project_root/runtimes/envs/base/bin/python" -m pip install --no-deps -e "$project_root"

melo_python="$project_root/runtimes/envs/tts-melotts/bin/python"
# python-mecab-ko and mecab-python3 share a case-insensitive package path on
# default macOS volumes. Restore Japanese MeCab, then patch g2pkk's imports.
"$melo_python" -m pip install --force-reinstall --no-deps "mecab-python3==1.0.9"
"$melo_python" "$project_root/backend/mediaforge/modules/srt_to_speech/worker/scripts/patch_melotts_mecab.py"

if ! "$melo_python" -c 'from pathlib import Path; import unidic; raise SystemExit(0 if (Path(unidic.DICDIR) / "dicrc").is_file() else 1)'; then
  "$melo_python" -m unidic download
fi
"$melo_python" -c 'import nltk; [nltk.download(name, quiet=True, raise_on_error=True) for name in ("averaged_perceptron_tagger_eng", "cmudict")]'

PYTHONPATH="$project_root/backend/mediaforge/modules/bili_downloader/worker" "$project_root/runtimes/envs/base/bin/python" -c 'import yt_dlp; from src.settings import DEFAULT_SETTINGS'
PYTHONPATH="$project_root/backend/mediaforge/modules/sfx_converter/worker" "$project_root/runtimes/envs/sfx/bin/python" -c 'from app.models.model_manager import ModelManager'
PYTHONPATH="$project_root/backend/mediaforge/modules/srt_to_speech/worker" "$project_root/runtimes/envs/tts-vieneu/bin/python" -c 'from studio import bootstrap; bootstrap.prepare_runtime()'
PYTHONPATH="$project_root/backend/mediaforge/modules/srt_to_speech/worker" "$melo_python" -c 'import MeCab; from g2pkk import G2p; from melo.api import TTS; from studio import bootstrap; bootstrap.prepare_runtime("melotts"); assert hasattr(MeCab, "Tagger")'

echo "MediaForge Python runtimes are ready under runtimes/envs/."
