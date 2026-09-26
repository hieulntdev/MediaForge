# MediaForge architecture

MediaForge is a modular monolith. One hardened Electron window owns OS access, process lifecycle, dialogs, settings, and task state. Modules are discovered from `backend/mediaforge/modules/*/module.json`; the core does not import concrete module IDs or adapters.

```text
Dashboard renderer
  -> narrow preload IPC
    -> registry / module manager / task manager / process manager
      -> manifest-selected boundary adapter
        -> isolated Python runtime and retained legacy domain implementation
```

## Boundaries

- `apps/desktop/main`: shell and shared orchestration only.
- `apps/desktop/preload`: allowlisted API; Node integration remains disabled and context isolation/sandbox remain enabled.
- `frontend`: registry-generated navigation/dashboard and shared UI tokens.
- `backend/mediaforge/core`: public task, event, artifact, path, and registry contracts.
- `backend/mediaforge/modules`: module manifests, public boundary, and Electron adapters.
- Legacy project directories: source-of-truth domain logic retained by move-first migration.

Legacy renderer assets are bundled at the IPC boundary into a nonce-authorized `srcdoc`. Each manifest selects exactly one compatibility bridge, so Bili and SRT backend event streams cannot cross. This is transitional UI reuse, not a second Electron window.

## Runtime policy

The runtime resolver chooses, in order: explicit environment override, managed `runtimes/envs/<id>`, then the non-destructive legacy virtual environment fallback. `base`, `sfx`, `tts-vieneu`, and `tts-melotts` are never merged. Health checks require Python 3.12 arm64 independently for each runtime.

FFmpeg and FFprobe are shared system dependencies resolved through one locator and passed to legacy code through `MEDIAFORGE_FFMPEG` and `MEDIAFORGE_FFPROBE`.

## Task and data policy

Tasks use canonical lifecycle states and module-owned stages. Logs are bounded and secret-redacted. Output is described through artifact records with provenance and ownership. Only one heavy ML action may run at a time; status, preview, and cancellation actions remain available.

MediaForge owns config, logs, cache, models, temp, tasks, and outputs below Electron `userData`. Existing legacy data is read/copied when required and is never destructively migrated. SRT retry journals persist until the explicit clear action. SFX model downloads use a shared model directory, pinned revision/checksums, partial-download semantics, and explicit status/prefetch actions.
