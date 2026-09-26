# MediaForge

MediaForge is a macOS Apple Silicon desktop application that hosts Bili
Downloader, SFX Converter, and SRT-to-Speech in one Electron window. Modules
are discovered from manifests instead of being hard-coded into the desktop
shell.

## Requirements

- macOS on Apple Silicon
- Node.js 22 LTS (the version in `.nvmrc`)
- Python 3.12 arm64 (the version in `.python-version`)
- `ffmpeg` and `ffprobe` available on `PATH`

## Setup and run

```bash
nvm use
npm ci
npm run bootstrap:runtimes
npm run health
npm test
npm start
```

`bootstrap:runtimes` creates four intentionally isolated environments under
`runtimes/envs`: `base`, `sfx`, `tts-vieneu`, and `tts-melotts`. Do not merge
them: their model stacks require incompatible versions of packages such as
PyTorch and NumPy.

During the migration period, the runtime resolver falls back to the matching
legacy virtual environment when a managed environment is absent. The
`MEDIAFORGE_BASE_PYTHON`, `MEDIAFORGE_SFX_PYTHON`,
`MEDIAFORGE_VIENEU_PYTHON`, and `MEDIAFORGE_MELOTTS_PYTHON` environment
variables override both locations.

## Project structure

```text
apps/desktop/                 Electron main process, preload, and shared IPC
backend/mediaforge/core/      Dependency-light Python contracts
backend/mediaforge/modules/   Module manifests and desktop boundary adapters
frontend/                     Unified dashboard and shared visual system
runtimes/                     Reviewed runtime manifests and lock snapshots
scripts/                      Setup, health, launch, and verification commands
tests/                        Unified desktop and Python contract tests
Bili-Downloader/              Bili domain worker and transitional renderer
SFX-Converter/                SFX domain worker and transitional renderer
SRT-to-Speech-Studio/         Speech domain worker and transitional renderer
```

The three legacy-named directories are still production dependencies, not
backups: module adapters launch their Python entry points and bundle their
renderer assets. Their standalone launchers are also retained as documented
compatibility entry points until real-media parity validation and release
cutover are complete.

## Architecture

The Electron main process owns filesystem access, dialogs, settings, process
lifecycle, task state, and runtime selection. The sandboxed preload exposes a
narrow API to the dashboard and module views. Each module manifest selects one
adapter, renderer entry point, and isolated Python runtime:

```text
renderer -> preload IPC -> module/task/process managers -> module adapter
         -> isolated Python runtime -> domain implementation
```

See [docs/architecture.md](docs/architecture.md) for contracts, task/data
ownership, and runtime policy.

## Development and verification

- `npm start` launches the unified Electron 44.4.5 shell.
- `npm run check` syntax-checks all unified JavaScript.
- `npm run test:node` runs desktop orchestration tests.
- `npm run test:python` runs Python contract tests in the base runtime.
- `npm test` runs the complete unified static and contract test gate.
- `npm run health` validates all module manifests, four runtimes, FFmpeg, and
  FFprobe.
- `npm run bootstrap:runtimes` recreates environments from reviewed lock
  snapshots without merging their dependency graphs.

Each production domain also has its own tests and standalone instructions in
its local README. Run those suites when changing the corresponding domain or
adapter boundary.

## Troubleshooting

- If `npm` reports an engine mismatch, activate Node 22 with `nvm use`.
- If a runtime is unavailable, run `npm run bootstrap:runtimes` or set its
  explicit `MEDIAFORGE_*_PYTHON` override.
- If health checks cannot find media tools, install FFmpeg and ensure both
  `ffmpeg` and `ffprobe` are on `PATH`.
- Model downloads and production network jobs are deliberately not part of
  setup or unit tests. Use the in-app model prefetch/status actions before an
  SFX production run.
