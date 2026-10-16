# MediaForge module development standard

This document is mandatory for every new or changed MediaForge module. UI work
must also comply with [UI_RULES.md](../UI_RULES.md).

## 1. Architectural contract

A module is one self-contained directory under
`backend/mediaforge/modules/`. Its directory is the only source of truth for
its manifest, shell adapter, UI, worker/domain code, and module-only scripts.
Do not create a same-named project at repository root.

Required dependency direction:

```text
MediaForge shell -> module manifest -> desktop adapter -> worker/domain
module -> mediaforge.core and mediaforge.shared (optional)
```

Never import another concrete module. Never make `core` or `shared` import a
module. Business logic belongs in the worker/domain layer, not in Electron IPC,
preload, or renderer code.

## 2. Naming

- Directory and Python package names: `snake_case`, identical to module `id`.
- Frontend route: `kebab-case`.
- JavaScript source names: `kebab-case.js`.
- Python source names: `snake_case.py`.
- Manifest action names: `snake_case`, verb first (`analyze`, `extract_sfx`).
- IPC channels owned by the shell start with `mediaforge:`. A module must not
  register global IPC channels directly.
- IDs, action names, task stages, settings keys, artifact types, and event
  names are stable contracts. Rename them only with an explicit migration.

## 3. Directory layout

Use only the directories required by the module:

```text
backend/mediaforge/modules/example_module/
├── __init__.py
├── module.json                 required discovery manifest
├── desktop-adapter.js          required shell boundary
├── public.py                   optional dependency-light Python API/metadata
├── README.md                   module-specific behavior and verification
├── ui/                         required when the module has a renderer
│   ├── index.html
│   ├── renderer.js
│   └── styles.css
└── worker/                     required for a Python/subprocess worker
    ├── backend_entry.py        or a documented `python -m` entry point
    ├── <domain_package>/
    ├── scripts/                module-only maintenance commands
    └── requirements.txt        human-readable direct requirements
```

`module.json` and `desktop-adapter.js` must remain at module root. The UI entry
is relative to module root and must stay inside it. Worker imports must resolve
from `worker/`, not from the repository root. Large models, generated media,
virtual environments, logs, cache, and secrets do not belong in this tree.

Not every module needs Python or every optional folder. Hongguo is a valid Node
module with module-local services and no `worker/`.

## 4. Manifest and registration

Start from this shape and validate it against `resources/module.schema.json`:

```json
{
  "$schema": "../../../../resources/module.schema.json",
  "id": "example_module",
  "version": "1.1.0",
  "displayName": "Example Module",
  "description": "A user-facing description.",
  "frontendRoute": "example-module",
  "runtime": "base",
  "resourceClass": "light",
  "actions": ["run", "cancel"],
  "capabilities": { "cancel": true, "pause": false },
  "inputs": ["media.video"],
  "outputs": ["media.audio"],
  "adapter": "desktop-adapter.js",
  "ui": { "entry": "ui/index.html", "accent": "blue", "bridge": "exampleAPI" }
}
```

Discovery is automatic. Do not add the module ID to the dashboard or module
manager. Add a module icon mapping only when a distinct icon is required; the
navigation itself must continue to use registry metadata.

The preload bridge is an allowlisted public API. Adding a new bridge requires:

1. a narrowly scoped `contextBridge` API in `apps/desktop/preload/index.js`;
2. any new shared IPC channel in `apps/desktop/shared/channels.js`;
3. main-process validation and routing;
4. the bridge value in the manifest schema and registry validation;
5. tests for request validation and event isolation.

Prefer extending the generic `mediaForge.execute(module, action, payload)`
contract over adding module-specific filesystem or process powers.

## 5. Desktop adapter

Export `createAdapter(context)`. The resulting adapter must support
`execute(action, payload)` and may implement `pause(taskId)`, `resume(taskId)`,
`cancel(taskId)`, `shutdown()`, `resetToDefaults()`, `isBusy()`,
`resourceClassFor(action)`, and the module-level `cleanupSession` export.

The provided context owns:

- `manifest`, including absolute `moduleDirectory`;
- `runtimeResolver`;
- `processManager`;
- `taskManager`;
- `pathService`;
- FFmpeg and FFprobe locators.

Resolve source only from `manifest.moduleDirectory`:

```js
const workerRoot = path.join(this.manifest.moduleDirectory, 'worker');
```

Do not reconstruct the repository root, rely on `process.cwd()`, or encode a
former project folder name. Validate untrusted payload types and paths at this
boundary before starting work.

Adapters translate domain events into canonical task operations. They must
create a task before work begins, transition it through legal states, bound and
redact logs, register user-visible artifacts, and make cancellation idempotent.
Use `resourceClassFor` when only some actions are heavy.

## 6. Worker and subprocess rules

- Launch processes exclusively through `ProcessManager`.
- Use `RuntimeResolver`; never call a guessed `python` path.
- Set `cwd` explicitly to the module worker root.
- Use unbuffered UTF-8 output for line protocols.
- Use structured JSON-lines events. stdout is protocol output; ordinary logs
  must be encoded as log events or written to stderr.
- Keep large imports lazy so status/startup actions do not load an AI model.
- Forward cancellation into the actual worker and its children, then clean
  partial scratch. Do not mark a task cancelled while processing continues.
- Implement `shutdown()` for persistent workers.
- Treat malformed worker output as a log or a bounded error, never as code.

The shell owns process lifetime. A module must not create another Electron
window or its own Electron main/preload application.

## 7. Dependencies and runtimes

Choose an existing runtime only when its dependency set is compatible. If a
new incompatible ML stack is required, add `runtimes/<runtime_id>/runtime.json`
and a reviewed `requirements.lock`, then include it in bootstrap and health
checks. Never merge runtimes merely to reduce environment count.

Pin model repository revisions and verify checksums when the upstream supports
stable artifacts. Keep model files under `pathService.models`; downloads must
use a partial file/directory and atomically publish only verified content.
Python virtual environments belong under `runtimes/envs/` (or a module-local
development `.venv`, which stays ignored), never in Git.

## 8. Paths, configuration and mutable data

All user-selected input/output paths crossing IPC must be absolute and
validated again before use. Use `path.resolve`, `path.join`, and `Path`; do not
concatenate separators or assume the launch working directory.

Use these ownership locations:

| Data | Location | Startup cleanup |
| --- | --- | --- |
| Settings/credentials | `pathService.config/<module>/` | preserve |
| Operational logs | `pathService.logs/<module>/` | preserve/rotate |
| Model artifacts | `pathService.models/<module>/` | preserve |
| Default exports | `pathService.outputs/` | preserve |
| Rebuildable cache | `pathService.cache/<module>/` | remove |
| Process scratch | `pathService.temp/<module>/` | remove |
| Task workspace | `pathService.taskWorkspace(taskId)` | remove with task |

Write settings and indexes atomically with a temporary `.part` file followed
by rename. Never store auth tokens or cookies in logs, task payload snapshots,
renderer storage, or repository files. Redact URLs when query parameters may
contain credentials.

`cleanupSession` may remove only documented session data. `resetToDefaults`
must be module-scoped and must reject active work. Neither may remove models,
credentials, source inputs, or completed user output unless the user explicitly
selected that destructive action.

## 9. Core and shared code

- `core/`: dependency-light application contracts, lifecycle types, registry
  abstractions, and path semantics. It cannot know concrete modules.
- `shared/`: stable implementations genuinely reused by multiple modules.
- module directory: all behavior specific to one domain or provider.

Do not move a helper to `shared` speculatively. First keep it local; promote it
when two implementations need the same semantics and tests can define a stable
contract. Prefer dependency injection from the adapter over global imports.
When JavaScript and Python need identical immutable metadata, keep it in one
module-root JSON file and test both consumers against it; do not copy constants
between languages.

## 10. UI and navigation

Put all renderer assets below `ui/`; relative `<script>` and stylesheet links
must stay within that directory because the shell rejects escaping assets. The
renderer uses only its assigned preload bridge and must not access Node.js.
Events must be filtered by module so one module cannot consume another's state.

Dashboard cards and navigation are generated from manifests. Follow
`UI_RULES.md` for layout, controls, tables, themes, progress, accessibility,
Activity Log, and responsive behavior. Module switching and reset protection
remain shared shell behavior.

## 11. Testing requirements

Every module change must run:

```bash
npm run check
npm test
npm run health
python3 -m compileall -q backend/mediaforge
```

Add unit tests for deterministic domain logic, adapter tests with mocked
process/network boundaries, registry tests for manifest and local paths, and UI
contract tests for changed controls. Do not download real media or run large AI
inference in ordinary automated tests.

Before release, perform the relevant manual smoke test on supported hardware:

- launch from `npm start`;
- open the dashboard and every module;
- exercise input dialogs and settings;
- start, pause/resume where supported, cancel, retry, and restart;
- verify progress and Activity Log events;
- verify produced media with FFprobe and play/open it;
- confirm persistent data survives and session scratch does not;
- verify navigation is blocked when the active-task policy requires it.

Record which tests actually ran, which were mocked, and which were skipped due
to network, credentials, model size, or hardware.

## 12. New-module checklist

1. Create `backend/mediaforge/modules/<snake_case_id>/`.
2. Add `module.json`, `desktop-adapter.js`, `__init__.py`, and `ui/`.
3. Put domain code in `worker/` or module-local Node services.
4. Select or define an isolated runtime and lock its dependencies.
5. Implement task lifecycle, structured events, cancellation, shutdown, reset,
   cleanup, redaction, settings, and artifact ownership as applicable.
6. Add only the minimum preload API required by the UI.
7. Add unit, adapter, registry, and UI contract tests.
8. Update the module README, root README when capabilities change, architecture
   only for boundary changes, and `CHANGELOG.md`.
9. Run automated checks and complete the real-media/manual smoke checklist.
10. Search for hardcoded absolute paths, repository-root assumptions,
    cross-module imports, secrets, generated files, and duplicate source before
    review.
