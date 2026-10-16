# Changelog

All notable changes to MediaForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2] - 2026-10-16

### Added

- Added Hongguo Downloader with public series and episode discovery, quality-aware batch queues, concurrent HLS/HTTP/DASH processing, retry, pause, cancellation, and verified stream-copy outputs.
- Added persistent Hongguo download settings, in-session HLS segment checkpoints, output duplicate handling, sortable episode selection, and a redacted Activity Log.

### Changed

- Bumped all module manifests to 1.1.0 and the MediaForge application and core
  package to 1.2.0.
- Consolidated Bili Downloader, SFX Converter, and SRT-to-Speech source under
  `backend/mediaforge/modules/<module_id>/`; manifests now resolve module-local
  UI entries and adapters launch module-local workers without root-folder paths.
- Standardized every module around a manifest, desktop adapter, `ui/`, and an
  optional isolated `worker/`, while retaining the four separate Python
  runtimes and all existing frontend/backend protocols.
- Replaced the transitional architecture notes with a complete architecture
  decision and mandatory module-development guide.
- Added a shared, once-per-launch session cleanup lifecycle for every discovered module while preserving settings, credentials, models, sources, and completed output files.
- Added a header Clear action that blocks active work, confirms the reset, and restores only the current module's UI and ordinary settings to defaults.
- Separated Hongguo persistent settings from transient queue, discovery, progress, and Activity Log state.

### Fixed

- Prevented stale queues, progress, logs, and renderer snapshots from reappearing after a normal exit, crash, or forced quit.
- Made the Bili Activity Log responsive and non-resizable while retaining download-column resizing.

### Removed

- Removed the three redundant standalone Electron shells and their per-module
  Node package metadata after the unified shell and migrated module sources
  passed syntax, registry, import, and contract tests.
- Removed the redundant Hongguo input Clear button beside Add to Queue.

## [1.1] - 2026-10-13

### Added

- Added live download speed, ETA, persistent activity logs, and resizable columns to Bili Downloader.
- Added module-specific dashboard icons and retained module views during in-app navigation.

### Changed

- Unified dashboard and module styling, spacing, and theme behavior.
- Reset transient renderer storage and application-owned scratch data at startup while preserving user files and recovery artifacts.
- Sourced the displayed application version and macOS About version from the root package metadata.

### Fixed

- Preserved and restored active Bili download state when its module view is revisited.
- Prevented navigation away from Bili Downloader while downloads are active.
- Improved Bilibili cookie parsing and account checks for HttpOnly cookies, session cookies, expiration, rate limits, timeouts, and server failures.
- Redacted cookie, authorization, and token values from Bili Downloader logs.

### Removed

- Removed automated test suites, test-only scripts and configuration, and test-only Python dependencies.
- Removed obsolete Electron smoke-capture hooks from the production desktop process.

## [1.0]

- Initial release.

