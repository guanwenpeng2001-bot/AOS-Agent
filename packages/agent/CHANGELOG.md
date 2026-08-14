# Changelog

## [Unreleased]

### Added

- Remote-ready Agent Loop hardening: bounded convergence, stable error classification, safe retry gating, and cancellation/deadline propagation.

### Fixed

- Agent lifecycle state now remains active through caller-owned asynchronous preflight and prepared prompt execution, so `waitForIdle()` observes the complete run.
- Caller cancellation and deadline expiry are classified before uncertain model-output side effects, preserving the `aborted` terminal state.

## [0.84.3] - 2026-08-10

### Added

### Changed

### Fixed

### Removed

## [0.84.2] - 2026-08-10

### Added

### Changed

### Fixed

### Removed
