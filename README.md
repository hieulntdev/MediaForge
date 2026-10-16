# MediaForge

MediaForge is a macOS Apple Silicon desktop application that hosts Bili
Downloader, Hongguo Downloader, SFX Converter, and SRT-to-Speech in one Electron window. Modules
are discovered from manifests instead of being hard-coded into the desktop
shell.

## Prerequisites

- macOS on Apple Silicon
- Node.js 22 LTS (the version in `.nvmrc`)
- Python 3.12 arm64 (the version in `.python-version`)
- `ffmpeg` and `ffprobe` available on `PATH`

## Installation

```bash
nvm install
nvm use
npm ci
npm run bootstrap:runtimes
```

`bootstrap:runtimes` creates four intentionally isolated environments under
`runtimes/envs`: `base`, `sfx`, `tts-vieneu`, and `tts-melotts`. Do not merge
them: their model stacks require incompatible versions of packages such as
PyTorch and NumPy.

## Environment setup

MediaForge does not require an `.env` file or API keys. By default, the setup
script uses `python3.12`, the application resolves `ffmpeg` and `ffprobe` from
`PATH`, and managed Python interpreters live under `runtimes/envs/`.

For a non-default local installation, export only the overrides you need before
running MediaForge:

```bash
export MEDIAFORGE_BOOTSTRAP_PYTHON=/path/to/python3.12
export MEDIAFORGE_BASE_PYTHON=/path/to/base/python
export MEDIAFORGE_SFX_PYTHON=/path/to/sfx/python
export MEDIAFORGE_VIENEU_PYTHON=/path/to/vieneu/python
export MEDIAFORGE_MELOTTS_PYTHON=/path/to/melotts/python
export MEDIAFORGE_FFMPEG=/path/to/ffmpeg
export MEDIAFORGE_FFPROBE=/path/to/ffprobe
```

These are optional shell environment variables, not repository configuration;
do not commit machine-specific paths.

## Run development

```bash
npm run health
npm run check
npm test
npm start
```

`npm start` is the supported launcher. `npm run health`, `npm run check`, and
`npm test` provide pre-commit environment, syntax, and contract verification.

## Project structure

```text
apps/desktop/                 Electron main process, preload, and shared IPC
backend/mediaforge/core/      Dependency-light Python contracts
backend/mediaforge/modules/   Complete module source: manifest, adapter, UI, worker
backend/mediaforge/shared/    Cross-module Python helpers with stable contracts
frontend/                     Unified dashboard and shared visual system
runtimes/                     Reviewed runtime manifests and lock snapshots
scripts/                      Setup, health, launch, and verification commands
tests/                        Unit and integration contract tests
```

Every module has exactly one source-of-truth directory below
`backend/mediaforge/modules/<module_id>/`. Its `module.json`,
`desktop-adapter.js`, `ui/`, and optional `worker/` are deployed and reviewed as
one unit. The former `Bili-Downloader/`, `SFX-Converter/`, and
`SRT-to-Speech-Studio/` source trees have been consolidated into this layout;
the separate Electron shells were removed because the MediaForge shell owns
all OS integration and process lifecycle.

Hongguo Downloader is implemented directly inside its module boundary. It
extracts public `hongguoapp.cn` series/player metadata and uses the shared
process lifecycle for FFmpeg remuxing and FFprobe output verification.

## Architecture

The Electron main process owns filesystem access, dialogs, settings, process
lifecycle, task state, and runtime selection. The sandboxed preload exposes a
narrow API to the dashboard and module views. Each module manifest selects one
module-local adapter, renderer entry point, and isolated Python runtime:

```text
renderer -> preload IPC -> module/task/process managers -> module adapter
         -> isolated Python runtime -> domain implementation
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design decision,
dependency graph, task/data ownership, and runtime policy. New modules must
follow [docs/MODULE_GUIDELINES.md](docs/MODULE_GUIDELINES.md) and
[UI_RULES.md](UI_RULES.md).

## Development and verification

- `npm start` launches the unified Electron 44.4.5 shell.
- `npm run check` syntax-checks all unified JavaScript.
- `npm test` verifies session cleanup boundaries and persistent-data protection.
- `npm run health` validates all module manifests, four runtimes, FFmpeg, and
  FFprobe.
- `npm run bootstrap:runtimes` recreates environments from reviewed lock
  snapshots without merging their dependency graphs.

Module-specific source and verification notes live in each module's README.
The supported application launcher is the root `npm start`; module workers are
not independent desktop applications.

## Changelog policy

Record user-visible additions, changes, fixes, removals, and performance work
under `Unreleased` in [CHANGELOG.md](CHANGELOG.md). Avoid duplicate entries.
For a release, move those entries into a versioned section and add the actual
release date.

## Optional models

Model weights are not committed. SFX Converter can prefetch its verified model
through the in-app model action; speech models are downloaded into the local
model cache when their runtime first needs them. Model downloads and production
network jobs are intentionally outside the initial setup verification.

## Troubleshooting

- If `npm` reports an engine mismatch, activate Node 22 with `nvm use`.
- If a runtime is unavailable, run `npm run bootstrap:runtimes` or set its
  explicit `MEDIAFORGE_*_PYTHON` override.
- If health checks cannot find media tools, install FFmpeg and ensure both
  `ffmpeg` and `ffprobe` are on `PATH`.
- If a model is unavailable, use the in-app SFX prefetch/status action or run
  the corresponding speech workflow once while connected to the network.
