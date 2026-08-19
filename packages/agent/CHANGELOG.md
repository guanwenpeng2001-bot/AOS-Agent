# Changelog

## [Unreleased]

### Added

- Remote-ready Agent Loop hardening: bounded convergence, stable error classification, safe retry gating, and cancellation/deadline propagation.
- T4 tool runtime foundations: profile and plugin management, tool gateway/pipeline execution, runtime services, and scoped selector/fencing behavior.
- T4 authority gates: durable local plugin activation recovery, consumer-shaped ToolGateway fakes, transformer provenance, read-only hooks, scoped reservations, and fail-closed cancellation/deadline settlement.
- T5 durable context and data foundations: immutable snapshots, fork and rewind planning, scoped memory, content-addressed artifacts, compaction, prompt-cache, and instruction facts.
- T6 Foundation execution gates: immutable ModelProfile routing and AgentBinding epochs, scoped gateway consumers, and provider-owned lifecycle conformance.
- T7 durable control objects: Goal/Plan/Stage/Todo, Ask/Reply settlement, and versioned Workflow DSL lifecycle with CAS recovery and explicit budget accounting.

### Fixed

- Made local plugin activation truly durable across process restarts, including recovery cleanup and rollback-point preservation after cleanup failure.
- Removed the compatibility-only Foundation contract barrel and legacy `FoundationContractError` tag; Foundation errors now expose only the canonical `FoundationError` shape.
- Agent lifecycle state now remains active through caller-owned asynchronous preflight and prepared prompt execution, so `waitForIdle()` observes the complete run.
- Caller cancellation and deadline expiry are classified before uncertain model-output side effects, preserving the `aborted` terminal state.
- Kept retry and terminal diagnostics on stable redacted categories, while recognizing wrapped DNS transport failures as retryable only when the caller has not cancelled the operation.
- Tool receipts now preserve AgentTool failures, usage, and side-effect state through AttemptReceipt, TaskResult, and RunReceipt settlement.
- Tool receipt deduplication now validates every durable receipt, aggregates the worst side-effect state, and replays only bounded safe results with verified image artifacts.
- Foundation model calls now durably record route-bound intent/fact pairs and fail closed on unsupported service tiers or pending/unknown restart state without replaying provider side effects.

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
