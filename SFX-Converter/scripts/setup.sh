#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="${project_dir}/.venv"
cd "${project_dir}"

if command -v python3.12 >/dev/null 2>&1; then
  python_bin="python3.12"
elif command -v python3.11 >/dev/null 2>&1; then
  python_bin="python3.11"
elif command -v python3.10 >/dev/null 2>&1; then
  python_bin="python3.10"
else
  echo "Python 3.10-3.12 is required." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "FFmpeg and ffprobe are required. Install FFmpeg, then run this script again." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20+ and npm are required." >&2
  exit 1
fi

"${python_bin}" -m venv "${venv_dir}"
"${venv_dir}/bin/python" -m pip install --upgrade pip setuptools wheel
"${venv_dir}/bin/python" -m pip install --timeout 120 --retries 10 -r "${project_dir}/requirements.txt"
npm install

if [[ "${1:-}" == "--download-model" ]]; then
  "${venv_dir}/bin/python" -m scripts.download_model
fi

echo "Setup complete. Run: npm start"
