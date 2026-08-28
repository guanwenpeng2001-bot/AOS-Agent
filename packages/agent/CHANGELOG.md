# Changelog

## [Unreleased]

### Breaking Changes

- Renamed current public business models, schemas, providers, events, classes, and functions to their unversioned names and removed the transitional version-suffixed and alias exports. Use `scripts/migrate-versioned-names.mjs` to migrate source references.

### Added

- Remote-ready Agent Loop hardening: bounded convergence, stable error classification, safe retry gating, and cancellation/deadline propagation.
- T4 tool runtime foundations: profile and plugin management, tool gateway/pipeline execution, runtime services, and scoped selector/fencing behavior.
- T4 authority gates: durable local plugin activation recovery, consumer-shaped ToolGateway fakes, transformer provenance, read-only hooks, scoped reservations, and fail-closed cancellation/deadline settlement.
- T5 durable context and data foundations: immutable snapshots, fork and rewind planning, scoped memory, content-addressed artifacts, compaction, prompt-cache, and instruction facts.
- T6 Foundation execution gates: immutable ModelProfile routing and AgentBinding epochs, scoped gateway consumers, and provider-owned lifecycle conformance.
- T7 durable control objects: Goal/Plan/Stage/Todo, Ask/Reply settlement, and versioned Workflow DSL lifecycle with CAS recovery and explicit budget accounting.
- AgentHarness compatibility lifecycle: durable user/assistant/tool event ordering, extension tool and compaction hooks, bounded retry cancellation, automatic overflow compaction continuations, and model invocation context-snapshot provenance.
- T11 recovery and migration conformance: atomic v4-to-v5 rollback, torn-tail refolding, single-writer fencing, duplicate-request rejection, semantic corruption detection, and unknown-schema fail-closed behavior.
- T12 Foundation seal: local Workflow evaluation datasets and strict versioned quality, cost, and recovery regression snapshots, with all 79 Foundation closure capabilities backed by implementation evidence.
- Line 11 Sandbox Operation Worker capability ledger: closes capabilities 74–87, 135, and 136, consumes sealed Foundation capabilities 6, 32, 47, 52, and 61, and preserves explicit later ownership for 88, 89, 132, and 137 without closing capability 140.

### Changed

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
- Added the canonical `sandbox_capability_insufficient` and `task_credential_target_unavailable` Foundation errors, and preserved validated Worker receipt provenance through `ToolExecutionResult.toolReceiptRef`, closing two sealed-contract omissions without a schema redesign.
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
