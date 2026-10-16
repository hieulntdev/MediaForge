# Changelog

All notable changes to MediaForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added Hongguo Downloader with public series and episode discovery, quality-aware batch queues, concurrent HLS/HTTP/DASH processing, retry, pause, cancellation, and verified stream-copy outputs.
- Added persistent Hongguo download settings, in-session HLS segment checkpoints, output duplicate handling, sortable episode selection, and a redacted Activity Log.

### Changed

- Added a shared, once-per-launch session cleanup lifecycle for every discovered module while preserving settings, credentials, models, sources, and completed output files.
- Added a header Clear action that blocks active work, confirms the reset, and restores only the current module's UI and ordinary settings to defaults.
- Separated Hongguo persistent settings from transient queue, discovery, progress, and Activity Log state.

### Fixed

- Prevented stale queues, progress, logs, and renderer snapshots from reappearing after a normal exit, crash, or forced quit.
- Made the Bili Activity Log responsive and non-resizable while retaining download-column resizing.

### Removed

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

