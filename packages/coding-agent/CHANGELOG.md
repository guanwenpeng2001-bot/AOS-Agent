# Changelog

## [Unreleased]

### Breaking Changes

- Removed `BuildSystemPromptOptions.contextFiles`. Route session context through Context Engine sources; direct prompt construction can use approved `instructionBlocks`.
- With Context Engine enabled (the default), extensions must return a labeled `before_agent_start` `contribution` for model-facing input. Legacy `message`/`systemPrompt` returns, `context` mutations, and `before_provider_request` payload rewrites require `context.enabled: false`.
- Capability registry ids, revisions, binding ids, and public capability provenance are now installation-scoped opaque references. Public RPC, SDK, Context Engine, run receipt, and session-event surfaces no longer return raw capability source paths, URLs, session file paths, or legacy raw capability identifiers.

### Added

- Context Engine v1: governed context sources (trust/scope/digest), input budget packing that includes provider tool schemas and formal extension contributions, metadata-only `context.snapshot` Session entries, optional explicit session/project memory (default off), compaction/branch-summary snapshot provenance, RPC `get_context` / `RpcClient.getContext()`, interactive `/context` and `/memory`, and additive `RunReceipt.contextSnapshotId`.
- Capability Registry/MCP v1: stable capability descriptors and frozen bindings for built-in, extension, SDK, skill, and MCP capabilities; trust-aware `allow`/`ask`/`deny` profiles; stdio and Streamable HTTP MCP lifecycle with explicit environment/header references; namespaced MCP tools; redacted inspection and run/Context Engine binding audit metadata; interactive approval and RPC `get_capabilities` support.
- Interactive `/capabilities` command: list the redacted capability catalog, inspect a descriptor, and approve an ask capability for the current session (`/capabilities`, `/capabilities inspect <id>`, `/capabilities approve <id>`). Backed by the public Session capability surface (`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, and `approveCapability()`); approvals are session-local, output is redacted (no command arguments, env/header values, tokens, unredacted URLs, or raw local paths), and only `CapabilityError` codes and redacted messages are surfaced. Adds type-only exports `CapabilityCatalogView`, `CapabilityDescriptorView`, and `CapabilityBindingView`.
- RPC `get_capabilities` now also returns the redacted capability catalog (descriptor id/kind/name, redacted source, revision, availability, decision, trust, and public tool/parent/server identity) alongside the current binding and binding history; `RpcClient.getCapabilities()` surfaces the catalog and the optional per-binding query.
- ModelBroker v1: trusted route/role settings, immutable bindings, guarded transient-failure fallback, call/token/cost budgets, safe attempt/run metadata, RPC `get_model_routes` plus optional `modelRoute`/`modelRole`, SDK selection options, and interactive `/model-routes`/`/model-route` controls.

### Changed

- Hardened capability revisions and binding identity, fail-closed static tool-name conflicts, extension parent governance, and MCP deselection cleanup; MCP discovery now starts only at explicit readiness or prompt/run preflight.
- Preserved schema structure during secret-safe revision sanitization, re-enabled explicit MCP reconnect after terminal close, made failed profile transitions tear down prior MCP selection, exposed all extension-source tools for conflict detection, and added binding ledger/replay coverage.
- Serialized overlapping capability-profile transitions so MCP close/reselect races settle with the latest invocation and a fresh ready transport.
- Trusted project extensions, their tools, and project skills now enter the capability profile as trusted candidates when the project is trusted; untrusted projects remain force-denied with no bypass, while user/temporary sources keep their existing trust behavior and parent extension governance is unchanged.

### Fixed

- Made managed `fd` and `rg` downloads safe across concurrent processes by isolating temporary archives and extraction directories.
- Defaulted package changelog links to the AOS Agent repository when no override is configured.
- Context snapshots are persisted immediately before every model call, including retries, tool loops, compaction, and branch summaries; persistence failures prevent provider dispatch.
- Context Engine initial budget validation now uses post-compaction Agent state, allowing eligible compaction before rejecting over-budget prompts.
- Kept native Node ESM startup compatible with MCP SDK 1.30.0, preserved built-in tool registration for `noTools: "builtin"`, and retained extension active-tool switching within a frozen capability binding.
- `run.resume` now recovers the original capability binding for interrupted (accepted, never-terminal) source runs by persisting `capabilityBindingId` on the accepted run record through validation, clone, and ledger replay; drift between the recorded and settled binding rejects with `capability_binding_unavailable` before any successor run/ledger write, and historical ledgers without a binding remain resumable and backward compatible.
- ModelBroker RPC failures now retain stable route, budget, and fallback error codes, while Run receipts expose only safe model binding, attempt, and budget metadata.
- ModelBroker CLI route and role selectors now report missing values explicitly instead of treating the following option as an unrelated flag.

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
