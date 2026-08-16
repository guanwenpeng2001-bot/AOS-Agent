# Changelog

## [Unreleased]

### Breaking Changes

- Removed `BuildSystemPromptOptions.contextFiles`. Route session context through Context Engine sources; direct prompt construction can use approved `instructionBlocks`.
- With Context Engine enabled (the default), extensions must return a labeled `before_agent_start` `contribution` for model-facing input. Legacy `message`/`systemPrompt` returns, `context` mutations, and `before_provider_request` payload rewrites require `context.enabled: false`.
- Capability registry ids, revisions, binding ids, and public capability provenance are now installation-scoped opaque references. Public RPC, SDK, Context Engine, run receipt, and session-event surfaces no longer return raw capability source paths, URLs, session file paths, or legacy raw capability identifiers.

### Added

- Optional `gondolin-local` Isolated Runner: an explicitly registered Gondolin micro-VM `SandboxProvider` that consumes the existing Policy Binding / `prepare` / `execute` / `dispose` contract. Built-in filesystem and process tools stay on the guest `/workspace` mount, capabilities report `network: false` with no MCP transport, and cancel/deadline unknown side effects stay fail-closed. The adapter is an example package; default `legacy` installs do not gain a Gondolin or QEMU dependency.
- Loopback TCP JSONL transport for Automation Host: `aos --mode rpc --rpc-listen tcp://127.0.0.1:<port>` binds `127.0.0.1` only, accepts one control connection, and reuses the existing RPC command, event, and receipt contract. `RpcClient` can connect with `{ transport: { type: "tcp", host: "127.0.0.1", port } }` without spawning a child process.
- Remote-ready execution contracts: session-scoped idempotent run requests, durable lifecycle observations, reconnect-safe run event recovery, stable binding handles, serialized Session writes, and an in-process fake remote provider contract.
- Context Engine v1: governed context sources (trust/scope/digest), input budget packing that includes provider tool schemas and formal extension contributions, metadata-only `context.snapshot` Session entries, optional explicit session/project memory (default off), compaction/branch-summary snapshot provenance, RPC `get_context` / `RpcClient.getContext()`, interactive `/context` and `/memory`, and additive `RunReceipt.contextSnapshotId`.
- Capability Registry/MCP v1: stable capability descriptors and frozen bindings for built-in, extension, SDK, skill, and MCP capabilities; trust-aware `allow`/`ask`/`deny` profiles; stdio and Streamable HTTP MCP lifecycle with explicit environment/header references; namespaced MCP tools; redacted inspection and run/Context Engine binding audit metadata; interactive approval and RPC `get_capabilities` support.
- Execution Policy/Sandbox v1: named trust-aware `allow`/`ask`/`deny` profiles, immutable per-run policy bindings, fail-closed Sandbox Provider enforcement, approval/decision ledger entries, and redacted policy inspection across RPC, SDK, CLI, and TUI surfaces.
- Interactive `/capabilities` command: list the redacted capability catalog, inspect a descriptor, and approve an ask capability for the current session (`/capabilities`, `/capabilities inspect <id>`, `/capabilities approve <id>`). Backed by the public Session capability surface (`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, and `approveCapability()`); approvals are session-local, output is redacted (no command arguments, env/header values, tokens, unredacted URLs, or raw local paths), and only `CapabilityError` codes and redacted messages are surfaced. Adds type-only exports `CapabilityCatalogView`, `CapabilityDescriptorView`, and `CapabilityBindingView`.
- RPC `get_capabilities` now also returns the redacted capability catalog (descriptor id/kind/name, redacted source, revision, availability, decision, trust, and public tool/parent/server identity) alongside the current binding and binding history; `RpcClient.getCapabilities()` surfaces the catalog and the optional per-binding query.
- Execution Audit v1 now provides safe `audit.query` and `audit.replay` views over existing Run, ModelBroker, Context, Capability, Policy, Sandbox, and external mapping facts, plus idempotent `external.map` persistence and optional external references on Automation Host runs.
- Task-level Human Gate v1: additive Automation Host `task.gate.request` / `task.gate.get` / `task.gate.list` / `task.gate.approve` / `task.gate.reject` / `task.gate.cancel` control-plane commands with a `pending` -> `approved` / `rejected` / `cancelled` state machine, `clientRequestId` idempotency, first-terminal-writer-wins conflict handling, per-Session persistence via `task.gate` custom entries, safe `task.gate` audit summaries with direct `runId` correlation, and the optional `taskGateCommands` `initialize` advertisement. Gates are independent of Run lifecycle and Policy approval: approving a Gate never starts a Run, rejecting/cancelling never terminates one or rewrites a Run receipt, and no Gate satisfies or changes a pending Policy `ask`.
- Task Graph v1: additive Automation Host `task.graph.create` / `task.graph.get` / `task.graph.list` / `task.graph.node.attach` / `task.graph.node.settle` control-plane commands for immutable, session-scoped DAG definitions (`sessionId + taskId + graphRevision`), persistent node status (`pending` / `running` / `succeeded` / `failed` / `cancelled`) with derived read-only availability (`ready` / `waiting_dependencies` / `waiting_gate` / `blocked`), read-only Task Gate consumption, `clientRequestId` idempotency and first-valid-transition-wins conflicts, per-Session persistence via `task.graph` custom entries, safe `task.graph` audit summaries with direct `runId` correlation, and the optional `taskGraphCommands` `initialize` advertisement. Graph commands never start, cancel, or rewrite Runs — attach only associates an already accepted Run and settle only maps the attached Run's current terminal receipt (`completed` -> `succeeded`, `failed` -> `failed`, `cancelled` -> `cancelled`); a terminal record without a receipt, or a receipt that disagrees with the record, fails with `task_graph_run_state_mismatch`. Writes are acknowledged only after the appended transition folds back, the 12 `task_graph_*` codes are part of the shared `AutomationErrorCode` contract, and v1 keeps the single active Run per Session (`session_busy`) with no scheduler, queue, or parallel Run semantics.
- External Agent Adapter v1 contract: a trusted instance-only adapter registry (`createExternalAgentAdapterRegistry`) with explicit `adapterId` + `targetId` selection, safe descriptors, and per-adapter target lookup; bounded safe identifier validation for adapter/target ids, protocol name/version, reason codes, and phases; allowlisted protocol/capability probe snapshots (`start` / `events` / `cancel` / `receipt` / `resume` / `artifacts` / `toolGateway`) with a ready-state minimum (start + terminal receipt + cooperative/strong cancel); public-safe Binding input and deterministic one-way binding fingerprints producing immutable prepared bindings (`reference-only` by default, `tool-gateway` only when the snapshot proves a verified gateway); bounded one-shot input; validated `started` / `progress` / `artifact` events and terminal receipts with stable `external_agent_*` error codes and code-derived messages; a redaction boundary (`toExternalAgentError`, exact-shape serializers) that never exposes credentials, prompts, transcripts, paths, URLs, or raw protocol data; fail-closed exact-shape guards and persistence across the adapter contract, `external-session-mapping`, and `remote-operation` layers for external identity (`external.mapping`), bounded events, and the `remote.operation` receipt with mapping-before-operation ordering; and optional additive `externalAgent` selection on `run.start` / `run.resume` plus an `externalAgentAdapters` `initialize` summary (identifiers only). External receipts settle only through the existing Run terminal gate (`run.failed` + `run_deadline_exceeded` unchanged), `run.resume` with an `externalAgent` selection never silently restarts and is rejected with `external_agent_resume_unsupported` until a verified resume connector exists, and contract tests use a deterministic in-memory fake adapter — the PR wires external runs through the existing Run lifecycle (no new Run lifecycle) and adds no vendor connectors (Claude, Codex, ACP, or any other), no implicit provider-based selection, no Host fallback, and no second ledger.

### Changed

- Strict sandbox reads no longer resolve host-only filename variants before `SandboxHandle.execute`. Policy error `Error.message` now uses the stable code-derived text so provider diagnostics cannot escape through legacy RPC or tool-result channels. AgentSession serializes policy-boundary teardown against sandbox prepare and records `sandbox.lifecycle: disposed`.
- Hardened capability revisions and binding identity, fail-closed static tool-name conflicts, extension parent governance, and MCP deselection cleanup; MCP discovery now starts only at explicit readiness or prompt/run preflight.
- Preserved schema structure during secret-safe revision sanitization, re-enabled explicit MCP reconnect after terminal close, made failed profile transitions tear down prior MCP selection, exposed all extension-source tools for conflict detection, and added binding ledger/replay coverage.
- Serialized overlapping capability-profile transitions so MCP close/reselect races settle with the latest invocation and a fresh ready transport.
- Trusted project extensions, their tools, and project skills now enter the capability profile as trusted candidates when the project is trusted; untrusted projects remain force-denied with no bypass, while user/temporary sources keep their existing trust behavior and parent extension governance is unchanged.
- MCP discovery and reconnect now establish the Run ID and policy binding before side effects, preserve binding lineage across capability discovery, and pass only explicitly authorized host-policy environment and header values.

### Fixed

- External Agent Adapter start failures never forward a raw `Error.message`, even when the payload carries a known automation code: only the host's fixed lifecycle `start_rejected` texts pass through, and every other known or unknown code maps to the phase fallback with the code-derived allowlisted message. Registry registration options also fail closed on malformed runtime shapes (non-object options, unknown keys, or non-array `targets`) instead of being coerced or silently accepted.
- Gondolin path mapping no longer treats POSIX `/tmp/...` workspace paths as Windows roots, so Linux guest reads are not rejected as `workspace_boundary_violation`.
- Accepted Automation Host runs that reach `deadlineAt` now settle as a single `run.failed` with `terminalError.code: "run_deadline_exceeded"` instead of `run.cancelled`. Explicit `run.cancel` is unchanged, and the first recorded termination intent wins a deadline/cancel race.
- Made managed `fd` and `rg` downloads safe across concurrent processes by isolating temporary archives and extraction directories.
- Defaulted package changelog links to the AOS Agent repository when no override is configured.
- Context snapshots are persisted immediately before every model call, including retries, tool loops, compaction, and branch summaries; persistence failures prevent provider dispatch.
- Context Engine initial budget validation now uses post-compaction Agent state, allowing eligible compaction before rejecting over-budget prompts.
- Kept native Node ESM startup compatible with MCP SDK 1.30.0, preserved built-in tool registration for `noTools: "builtin"`, and retained extension active-tool switching within a frozen capability binding.
- `run.resume` now recovers the original capability binding for interrupted (accepted, never-terminal) source runs by persisting `capabilityBindingId` on the accepted run record through validation, clone, and ledger replay; drift between the recorded and settled binding rejects with `capability_binding_unavailable` before any successor run/ledger write, and historical ledgers without a binding remain resumable and backward compatible.
- Public RPC/session run events now redact command arguments, execution output, full paths, environment/header values, and tool-result details while retaining safe event structure for automation clients.
- Agent lifecycle state now remains active through asynchronous capability and execution-policy preflight, so extension-triggered prompts are observable by `waitForIdle()` while RPC acceptance still follows fail-closed preflight.
- Preserved model retry compatibility for known transient transport failures and excluded execution-association audit facts from user-facing session message ordering.
- Kept recognized transient model failures retryable only before a possible provider side effect, while treating wrapped DNS cancellation errors as retryable transport failures and preserving safe terminal summaries.

### Removed

## [0.84.3] - 2026-08-10

### Added

- Public Automation Host API in RPC mode: opt-in `initialize` handshake with `protocolVersion: 1`, plus `run.start`, `run.get`, `run.cancel`, and `run.resume` commands with durable Run IDs, per-run `run.started`/`run.event`/terminal events, terminal receipts, structured errors, and a persistent per-session run ledger stored as session custom entries.

### Changed

### Fixed

### Removed

## [0.84.2] - 2026-08-10

### Added

- Cursor as a first-class model provider in interactive and CLI flows. After `/login` with Cursor OAuth or API key, models come from the live `cursor-agent` catalog and can be selected like any other provider (for example `cursor/auto`).

### Changed

- After login, if a provider has no fixed default model id (dynamic catalogs such as Cursor), AOS selects the first available live model for that provider instead of failing with a missing default.

### Fixed

### Removed
