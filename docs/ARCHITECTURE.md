# MediaForge architecture

## Decision

MediaForge is a manifest-driven modular monolith. The canonical source for
every product module lives in exactly one directory:

```text
backend/mediaforge/modules/<module_id>/
```

This is the selected form of the centralized-source option. The previous
root-level Bili Downloader, SFX Converter, and SRT-to-Speech projects contained
the production Python workers and renderer assets, while their directories
under `backend/mediaforge/modules/` contained only manifests and adapters.
They were complementary halves, not equivalent copies. That split made a
single module span two ownership boundaries, forced adapters and runtime setup
to hardcode legacy project names, and duplicated Electron shells. The sources
were therefore moved, without changing their domain behavior, into each
module's `worker/` and `ui/` directories. Hongguo already followed the target
boundary and required only a module-relative UI manifest path.

The alternative—retaining a standalone root project for every module—would
make independent extraction slightly easier and could preserve standalone
launch commands. It would also create a second desktop/process layer per
module, multiply Node manifests, make path resolution depend on root naming,
and increase the chance of two sources of truth. If a module must later become
an independent product, extract its self-contained module directory and add a
thin host around its public contract; do not maintain a live mirror in advance.

| Criterion | Separate root projects | Centralized module source |
| --- | --- | --- |
| Maintenance | Changes cross two project boundaries | One ownership boundary per module |
| Adding modules | Requires root layout and shell conventions | Copy the documented module contract |
| Code reuse | Easy to run a whole legacy project elsewhere | Shared contracts plus extractable module directory |
| Duplicate source risk | High, especially shell/IPC code | Low; one renderer and worker |
| Dependencies | Naturally isolated but inconsistently declared | Isolated by runtime manifests and lock files |
| Organization | Mixed product and module concerns at root | Consistent discovery directory |
| Build/run complexity | Multiple package files and launchers | One Electron launcher and registry |
| Migration risk | Low immediate change, ongoing drift | Moderate one-time path risk, covered by checks |
| Long-term scale | Root grows for every module | Module count does not change the root layout |

## Repository boundaries

```text
MediaForge/
├── apps/desktop/
│   ├── main/                 Electron lifecycle, IPC and orchestration
│   ├── preload/              allowlisted browser bridges
│   └── shared/               IPC channel and protocol definitions
├── backend/mediaforge/
│   ├── core/                 dependency-light contracts and registry helpers
│   ├── modules/              complete source of every product module
│   └── shared/               stable cross-module Python helpers
├── frontend/                 dashboard, navigation and shared styles
├── resources/                schemas and application-level static resources
├── runtimes/                 runtime manifests and reviewed lock snapshots
├── scripts/                  launch, bootstrap and repository checks
└── tests/                    shell, lifecycle, UI and module contract tests
```

`apps/desktop` may depend on module manifests and adapters through discovery.
A module may depend on `backend/mediaforge/core` and
`backend/mediaforge/shared`. Core and shared code must not import a concrete
module. Modules must not import each other. The dashboard knows module metadata
returned by the registry, not concrete module directories.

## Runtime flow and entry points

The supported application entry point is `npm start`:

```text
package.json
  -> scripts/run-desktop.js
    -> Electron apps/desktop/main/index.js
      -> ModuleRegistry discovers modules/*/module.json
      -> GlobalSessionCleanup clears application-owned session scratch
      -> RuntimeResolver discovers runtimes/*/runtime.json
      -> BrowserWindow loads frontend/index.html
```

The request/event flow is:

```text
module renderer
  -> sandboxed preload bridge
    -> IPC router
      -> ModuleManager
        -> manifest-selected desktop-adapter.js
          -> TaskManager / ProcessManager
            -> module-local worker or in-process Node service
              -> streamed events and artifact records
                -> renderer Activity Log and task UI
```

The main process owns native dialogs, filesystem/shell actions, application
settings, worker lifecycle, task state, and runtime selection. The renderer has
no Node.js access. `contextIsolation` and the renderer sandbox remain enabled.
An adapter translates the stable shell contract into its domain worker's
existing protocol; business logic does not live in preload or IPC handlers.

The current worker entry points are:

- Bili: `bili_downloader/worker/backend_entry.py`, a persistent JSON-lines
  process using the `base` runtime.
- SFX: `sfx_converter/worker/app/backend.py`, a persistent JSON-lines process
  using the `sfx` runtime. Model prefetch uses
  `worker/scripts/download_model.py` as a one-shot process.
- SRT: `srt_to_speech/worker/backend_entry.py`, a one-shot CLI/event process
  using either `tts-vieneu` or `tts-melotts`.
- Hongguo: Node services inside its module directory; FFmpeg/FFprobe work is
  launched through the shared process manager.

## Module discovery and UI loading

`ModuleRegistry` scans immediate children of
`backend/mediaforge/modules/`. A directory is a module only when it contains a
valid `module.json`. Both `adapter` and `ui.entry` are resolved inside that
module directory and rejected if they escape it. This makes the manifest
portable and prevents dependencies on root-level module names.

The IPC router reads the module UI entry, inlines local CSS and JavaScript with
a Content Security Policy nonce, and supplies the selected allowlisted preload
bridge. Module navigation is built from registry metadata. Switching modules
does not create another Electron window, and active-task protection remains a
shell concern.

## Task, process and cancellation lifecycle

`TaskManager` owns canonical task states:

```text
PENDING -> RUNNING <-> PAUSED -> CANCELLING -> CANCELLED
                    \-----------------------> COMPLETED
                    \-----------------------> FAILED
```

Adapters create tasks and map worker-specific progress, log, output, failure,
pause, resume, and cancellation messages to the canonical state. The process
manager owns persistent and one-shot child processes and terminates them during
application shutdown. Only one `heavy` resource task may run at once. An
adapter may report additional busy state for non-task operations such as an
account check.

Outputs are represented as artifact records with type, URI, metadata,
producer, and ownership. Task scratch is disposable; user-selected outputs are
never cleanup targets.

## Runtime and dependency policy

The four runtimes remain deliberately isolated:

| Runtime | Consumers | Reason |
| --- | --- | --- |
| `base` | Bili and lightweight Python contracts | downloader/network stack |
| `sfx` | SFX worker and model prefetch | PyTorch/SFC-Locoformer stack |
| `tts-vieneu` | VieNeu synthesis and SRT non-Melo operations | ONNX/VieNeu stack |
| `tts-melotts` | MeloTTS synthesis | conflicting PyTorch/NumPy/tokenizer stack |

`scripts/bootstrap-runtimes.sh` builds managed environments in
`runtimes/envs/` from reviewed lock snapshots. Resolution order is explicit
`MEDIAFORGE_*_PYTHON`, managed environment, then a module-local development
environment. Model weights do not belong in Git: SFX uses the application model
directory and verifies pinned checksums; TTS libraries use their configured
model caches.

FFmpeg and FFprobe are shared system dependencies. The shell resolves them once
and passes explicit paths to workers through environment variables.

## Paths and data ownership

Source paths originate from `manifest.moduleDirectory`; modules must not infer
the repository root or depend on the process launch directory. User inputs and
outputs are normalized to absolute paths at the adapter boundary. The Python
process working directory is its module's `worker/` solely so existing package
imports remain deterministic.

Electron's `userData` directory is the root for application-owned mutable data:

```text
userData/
├── config/       persistent preferences and credentials
├── logs/         bounded/redacted operational logs
├── models/       downloaded model artifacts
├── outputs/      default user output destination
├── cache/        session-rebuildable state
├── temp/         disposable process scratch
└── tasks/        per-task workspaces
```

Startup cleanup resets only `cache`, `temp`, and `tasks`, then invokes every
module's optional cleanup hook. It preserves config, logs, models, user inputs,
and completed outputs. SRT retry data is intentionally session-scoped.

## Import graph

The dependency direction is intentionally acyclic:

```text
frontend -> preload API -> Electron main services -> module adapter
                                                   -> module worker/domain
module worker/domain -> Python stdlib/its runtime dependencies
module (optional)    -> mediaforge.core / mediaforge.shared
mediaforge.core      -> Python stdlib only
mediaforge.shared    -> stable shared libraries only
```

Cross-module imports and core-to-module imports are prohibited. A helper moves
to `shared` only after at least two modules require the same stable behavior;
module-specific utilities stay in the module.

## Migration record

The consolidation moved the following canonical sources without changing
their logic:

- Bili `backend_entry.py`, `src/`, requirements, and renderer assets into
  `bili_downloader/worker/` and `bili_downloader/ui/`.
- SFX `app/`, model download script, requirements, and renderer assets into
  `sfx_converter/worker/` and `sfx_converter/ui/`.
- SRT `backend_entry.py`, `studio/`, compatibility patch, requirements, and
  renderer assets into `srt_to_speech/worker/` and `srt_to_speech/ui/`.

Values consumed on both sides of a JavaScript/Python boundary were also reduced
to one source: Bili defaults live in `bili_downloader/defaults.json`, and the
SFX model revision/checksums/contract live in `sfx_converter/model.json`.

After the unified manifests, imports, renderer contracts, and registry passed,
the unused per-module Electron main/preload files, package manifests, and old
launch scripts were removed. They remain recoverable through version control.
No model, virtual environment, user output, log, cache, or local configuration
was deleted.

## Verification boundary

Repository checks cover manifest discovery, UI asset paths, JavaScript syntax,
Python compilation/imports, task/session cleanup, module reset, and renderer
contracts. Network downloads and full AI inference are intentionally excluded
from automatic verification. Release validation must still exercise real
cookies/network access, model download/inference, FFmpeg output, playback, and
application restart on a supported Apple Silicon macOS machine.
