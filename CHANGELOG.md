# Changelog

All notable changes to MediaForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

