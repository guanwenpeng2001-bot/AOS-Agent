# Changelog

## [Unreleased]

### Breaking Changes

- `@aos-agent/agent-core` no longer exports product orchestration stores, query helpers, or Workflow DSL helpers. Removed exports: `AskCreateInput`, `AskEvent`, `AskEventSchema`, `AskEventType`, `AskMutationOptions`, `AskReplyInput`, `AskStore`, `AskStoreOptions`, `AskTimedMutationInput`, `createAskStore`; `AcceptanceCriterionInput`, `AcceptanceFactInput`, `GoalCreateInput`, `GoalEvent`, `GoalEventSchema`, `GoalEventType`, `GoalMutationOptions`, `GoalRequestSnapshot`, `GoalStore`, `GoalStoreOptions`, `GoalStoreSnapshot`, `PlanCreateInput`, `StageCreateInput`, `TodoCreateInput`, `createGoalStore`; `FOUNDATION_ENTITY_KINDS`, `FoundationEntityId`, `FoundationEntityIdSchema`, `FoundationEntityKind`, `FoundationEntityPublicProjection`, `FoundationEntityPublicProjectionSchema`, `FoundationEntityQuery`, `FoundationEntityQueryProvider`, `FoundationEntityQueryResult`, `FoundationEntityQuerySchema`, `FoundationEntityRecord`, `FoundationEntityValueMap`, `parseFoundationEntityId`, `parseFoundationEntityPublicProjection`, `parseFoundationEntityQuery`, `projectFoundationEntityRecord`, `serializeFoundationEntityId`, `serializeFoundationEntityPublicProjection`, `serializeFoundationEntityQuery`, `validateFoundationEntityId`, `validateFoundationEntityPublicProjection`, `validateFoundationEntityQuery`; `AcceptanceStep`, `AgentStep`, `AwaitUserStep`, `BarrierStep`, `FOUNDATION_WORKFLOW_DSL_VERSION`, `GateStep`, `ParallelIntent`, `ParallelIntentSchema`, `ParallelStep`, `ToolStep`, `WORKFLOW_STEP_STATUSES`, `WORKFLOW_STEP_TYPES`, `Workflow`, `WorkflowContractKind`, `WorkflowDslVersion`, `WorkflowEvaluationCase`, `WorkflowEvaluationCaseResult`, `WorkflowEvaluationDataset`, `WorkflowEvaluationExpectedStep`, `WorkflowEvaluationObservation`, `WorkflowEvaluationSnapshot`, `WorkflowEvaluationSnapshotSchema`, `WorkflowMigration`, `WorkflowMigrationRegistry`, `WorkflowSchema`, `WorkflowStatus`, `WorkflowStep`, `WorkflowStepBase`, `WorkflowStepSchema`, `WorkflowStepStatus`, `WorkflowValueContract`, `WorkflowValueContractSchema`, `foundationWorkflowMigrationRegistry`, `migrateWorkflow`, `parseWorkflow`, `parseWorkflowEvaluationSnapshot`, `runWorkflowEvaluation`, `serializeWorkflow`, `serializeWorkflowEvaluationSnapshot`, `validateWorkflow`, `workflowAwaitingExternalExecutor`; `WorkflowCreateInput`, `WorkflowEvent`, `WorkflowEventSchema`, `WorkflowEventType`, `WorkflowMutationOptions`, `WorkflowStepTransitionInput`, `WorkflowStore`, `WorkflowStoreOptions`, and `createWorkflowStore`.
- Deep imports of `ask-store.ts`, `durable-store.ts`, `goal-store.ts`, `query.ts`, `workflow.ts`, and `workflow-store.ts` moved from `packages/agent/src/harness/foundation/` to `packages/coding-agent/src/core/orchestration/`.
- Public and internal agent business names no longer use the false `V1` suffix. Update source imports and references to the unversioned names.
- `ResultValue` is now the canonical type name for outcomes constructed with the `Result` value helpers.
- Capability manifests are no longer part of the `@aos-agent/agent-core` public exports.
- The session context ledger is now exposed as `ContextLedger` through `harness.ledger`, with domain object tags and the `session/ledger-writer.ts` source path. Existing `t5.*` object tags remain readable.
- Internal controllers and implementation helpers are no longer exported from `@aos-agent/agent-core`. The documented SDK contract is unchanged; repository consumers can import internalized names from their package-internal modules, while external consumers should migrate to the documented SDK symbols.

### Added

- AgentHarness operations now emit nested operation, turn, step, tool, hook, and AI-request spans through the existing telemetry schema.
- Remote-ready Agent Loop hardening: bounded convergence, stable error classification, safe retry gating, and cancellation/deadline propagation.
- Tool runtime support: profile and plugin management, Tool Gateway and pipeline execution, runtime services, and scoped selector/fencing behavior.
- Tool authority and recovery: durable local plugin activation recovery, consumer-shaped ToolGateway fakes, transformer provenance, read-only hooks, scoped reservations, and fail-closed cancellation/deadline settlement.
- Durable context and data: immutable snapshots, fork and rewind planning, scoped memory, content-addressed artifacts, compaction, prompt caching, and instruction facts.
- Foundation execution controls: immutable ModelProfile routing and AgentBinding epochs, scoped gateway consumers, and provider-owned lifecycle conformance.
- Durable workflow controls: Goal, Plan, Stage, and Todo objects; Ask/Reply settlement; and versioned Workflow DSL lifecycle with compare-and-set recovery and explicit budget accounting.
- AgentHarness compatibility lifecycle: durable user/assistant/tool event ordering, extension tool and compaction hooks, bounded retry cancellation, automatic overflow compaction continuations, and model invocation context-snapshot provenance.
- Recovery and migration safety: atomic v4-to-v5 rollback, torn-tail refolding, single-writer fencing, duplicate-request rejection, semantic corruption detection, and fail-closed handling of unknown schemas.
- Workflow quality and recovery coverage now include local evaluation datasets and versioned quality, cost, and recovery regression snapshots, with implementation evidence for the Foundation capabilities covered by this release.
- Sandbox Operation Worker support is implemented for worker execution over the required Foundation capabilities; remaining worker capabilities stay explicitly owned and are not treated as complete.

### Changed

- Task results now derive summaries, validation results, and file-change artifacts from durable assistant and tool records.
- Task result diffs now reference content-addressed workspace changes derived from durable receipts and artifact-store writes.
- Package author metadata is AOS Agent.
- Session artifacts now use the `.context-artifacts` directory suffix for new blobs, while reads and removals fall back per blob to existing legacy artifact directories.
- The External Agent Connector contract, architecture convergence, and product entry wiring (default CLI/RPC/SDK composition and settings-based connector registration) are implemented. Promotion evidence includes multi-OS packaged smoke, previous-release upgrade/restart, deterministic soak, pinned vendor handshake, and Codex subscription print/SDK/TUI. Vendors are pinned-and-handshake certified, not fully certified.
- Clarified that higher-level connector retry circuits must preserve the terminal `side_effect_unknown` no-replay boundary.
- Tool Gateway results can carry a bounded JSON-safe structured result separately from their canonical receipt reference.
- Restricted current Native Subagent lifecycle events and capability metadata to Native provider kinds; external protocols use the separate External Agent Connector contract.
- Renamed the machine-readable Foundation capability manifest to `foundation-capabilities.ts`; serialized `schemaVersion` fields and protocol revision values remain unchanged.

### Fixed

- Side-effect-free tool failures now remain model-visible error results and no longer force a recovered agent turn to fail.
- Windows process-tree cleanup now waits for `taskkill` to finish so `NodeExecutionEnv.cleanup()` actually terminates active shells.
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
