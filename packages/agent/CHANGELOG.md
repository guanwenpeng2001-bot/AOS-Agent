# Changelog

## [Unreleased]

### Breaking Changes

- Renamed current public business models, schemas, providers, events, classes, and functions to their unversioned names and removed the transitional version-suffixed and alias exports. Use `scripts/migrate-versioned-names.mjs` to migrate source references.
- Capability manifests are no longer part of the `@aos-agent/agent-core` public exports.

### Added

- Remote-ready Agent Loop hardening: bounded convergence, stable error classification, safe retry gating, and cancellation/deadline propagation.
- Tool runtime support: profile and plugin management, Tool Gateway and pipeline execution, runtime services, and scoped selector/fencing behavior.
- Tool authority and recovery: durable local plugin activation recovery, consumer-shaped ToolGateway fakes, transformer provenance, read-only hooks, scoped reservations, and fail-closed cancellation/deadline settlement.
- Durable context and data: immutable snapshots, fork and rewind planning, scoped memory, content-addressed artifacts, compaction, prompt caching, and instruction facts.
- Foundation execution controls: immutable ModelProfile routing and AgentBinding epochs, scoped gateway consumers, and provider-owned lifecycle conformance.
- Durable workflow controls: Goal, Plan, Stage, and Todo objects; Ask/Reply settlement; and versioned Workflow DSL lifecycle with compare-and-set recovery and explicit budget accounting.
- AgentHarness compatibility lifecycle: durable user/assistant/tool event ordering, extension tool and compaction hooks, bounded retry cancellation, automatic overflow compaction continuations, and model invocation context-snapshot provenance.
- Recovery and migration safety: atomic v4-to-v5 rollback, torn-tail refolding, single-writer fencing, duplicate-request rejection, semantic corruption detection, and fail-closed handling of unknown schemas.
- Workflow quality and recovery coverage now include local evaluation datasets and versioned quality, cost, and recovery regression snapshots, with implementation evidence for the Foundation capabilities covered by this release.
- Sandbox Operation Worker support: capabilities 74–87, 135, and 136 are implemented, worker execution consumes the required Foundation capabilities, and capabilities still outside this release remain explicitly owned without being treated as complete.

### Changed

- The External Agent Connector contract and the architecture convergence are implemented. Product entry wiring (default CLI/RPC/SDK composition and settings-based connector registration) and the final promotion gate (multi-OS packaged smoke, upgrade/restart, soak, pinned vendor certification) are not complete. This checkout does not claim product readiness.
- Clarified that higher-level connector retry circuits must preserve the terminal `side_effect_unknown` no-replay boundary.
- Tool Gateway results can carry a bounded JSON-safe structured result separately from their canonical receipt reference.
- Restricted current Native Subagent lifecycle events and capability metadata to Native provider kinds; external protocols use the separate External Agent Connector contract.
- Renamed the machine-readable Foundation capability manifest to `foundation-capabilities.ts`; serialized `schemaVersion` fields and protocol revision values remain unchanged.

### Fixed

- Made local plugin activation truly durable across process restarts, including recovery cleanup and rollback-point preservation after cleanup failure.
- Removed the compatibility-only Foundation contract barrel and legacy `FoundationContractError` tag; Foundation errors now expose only the canonical `FoundationError` shape.
- Agent lifecycle state now remains active through caller-owned asynchronous preflight and prepared prompt execution, so `waitForIdle()` observes the complete run.
- Caller cancellation and deadline expiry are classified before uncertain model-output side effects, preserving the `aborted` terminal state.
- Kept retry and terminal diagnostics on stable redacted categories, while recognizing wrapped DNS transport failures as retryable only when the caller has not cancelled the operation.
- Tool receipts now preserve AgentTool failures, usage, and side-effect state through AttemptReceipt, TaskResult, and RunReceipt settlement.
- Tool receipt deduplication now validates every durable receipt, aggregates the worst side-effect state, and replays only bounded safe results with verified image artifacts.
- Foundation model calls now durably record route-bound intent/fact pairs and fail closed on unsupported service tiers or pending/unknown restart state without replaying provider side effects.
- Durable assistant and tool projections now omit undefined transport fields and validate historical tool bindings against their own immutable record correlation.
- AgentHarness compatibility retry and external-message state now reflects active retry attempts and pending writes instead of fixed false values.
- Added the canonical `sandbox_capability_insufficient` and `task_credential_target_unavailable` Foundation errors, and preserved validated Worker receipt provenance through `ToolExecutionResult.toolReceiptRef`, closing two contract omissions without a schema redesign.
- Made the Foundation Host terminal gate the replay-stable `RunReceipt` authority, with canonical status/error/usage, fail-closed conflicts, deterministic result lookup, and one `run_receipt.written` projection per durable receipt.

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
