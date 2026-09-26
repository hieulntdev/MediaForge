# Bilibili ORIGINAL MASTER Downloader

Desktop downloader for macOS. The Electron interface drives a Python backend to
resolve the best Bilibili streams available to the selected account, mux them
with FFmpeg stream copy, and verify the result with ffprobe.

## Features

- Downloads individual videos, multi-part videos, and playlists from a `.txt`
  or `.csv` link list.
- Selects the highest accessible video and audio streams without re-encoding.
- Supports optional Netscape-format cookies and account-status checks.
- Supports pause, resume, cancel, per-row retry, progress, ETA, and pagination.
- Downloads subtitles when available and verifies completed media with ffprobe.
- Keeps runtime settings, logs, temporary files, and the default download
  directory inside the project.

## Requirements

- macOS
- Python 3.12 or newer
- Node.js 22.12 or newer, with npm
- FFmpeg and ffprobe (`brew install ffmpeg`)

## Installation

From the project root:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd electron-app
npm ci
cd ..
```

## Usage

Start the Electron application from the project root:

```bash
./run.sh
```

Choose a link-list file, an output directory, and optionally a cookies file,
then select **Start Download**. The link reader extracts unique HTTP(S) URLs
from `.txt` and `.csv` files; a plain file with one Bilibili URL per line is the
simplest format.

`run.sh` uses `.venv/bin/python3` for the backend and installs the Electron
packages automatically with `npm install` if `electron-app/node_modules/` is
missing.

## Configuration

Runtime settings are stored in `config/settings.json` after they are saved.
Defaults and persistence are defined in `src/settings.py` and include codec and
container preference, subtitles, concurrent fragments, retry count, temporary
file cleanup, and rate limiting.

Generated runtime data is kept in these ignored directories:

- `downloads/` — default output directory
- `logs/` — rotating application log
- `temp/` — temporary download streams
- `config/settings.json` — saved settings

## Project Structure

```text
.
├── backend_entry.py       # Electron-to-Python command worker
├── electron-app/          # Electron main, preload, renderer, HTML, and CSS
├── src/
│   ├── auth/              # Cookie parsing and account checks
│   ├── core/              # Analysis, selection, download, mux, and verify flow
│   ├── extractors/        # yt-dlp and Bilibili fallback extractors
│   ├── models/            # Video and format data models
│   ├── utils/             # FFmpeg, paths, filenames, links, and logging
│   └── settings.py        # Settings defaults and JSON persistence
├── tests/                 # Python test suite
├── requirements.txt
├── requirements-dev.txt
└── run.sh                 # Official launcher
```

The Electron application is the only user interface. `run.sh` starts Electron,
which launches `backend_entry.py` as a long-lived Python worker. Commands are
sent to the worker as newline-delimited JSON; status, progress, logs, and errors
are returned to Electron as structured events. The backend reuses the download
pipeline and settings module in `src/` without importing any desktop UI code.

## Validation

Run the Python tests:

```bash
.venv/bin/python -m pytest
```

Check the Electron JavaScript syntax:

```bash
cd electron-app
npm run check
```

## Notes

- The application runs from Terminal; there is no packaged `.app` build.
- Download quality is limited by Bilibili account access and the streams that
  Bilibili exposes.
- Electron dependencies in `electron-app/node_modules/` and all runtime-data
  directories are generated locally and are not committed.
