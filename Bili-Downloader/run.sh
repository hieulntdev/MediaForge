#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  echo "Error: .venv not found. Create it first:" >&2
  echo "  python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

export BILI_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
# The launcher always needs Electron mode, even when called from a shell that
# inherited this development-only Node compatibility flag.
unset ELECTRON_RUN_AS_NODE

command -v npm >/dev/null 2>&1 || {
  echo "Error: Node.js and npm are required. Install with: brew install node" >&2
  exit 1
}

cd "$SCRIPT_DIR/electron-app"
if [ ! -d node_modules ]; then
  echo "Installing Electron dependencies (first run only)..."
  npm install
fi
exec npm start
