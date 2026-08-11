# Changelog

## [Unreleased]

### Breaking Changes

- Removed `BuildSystemPromptOptions.contextFiles`. Route session context through Context Engine sources; direct prompt construction can use approved `instructionBlocks`.
- With Context Engine enabled (the default), extensions must return a labeled `before_agent_start` `contribution` for model-facing input. Legacy `message`/`systemPrompt` returns, `context` mutations, and `before_provider_request` payload rewrites require `context.enabled: false`.

### Added

- Context Engine v1: governed context sources (trust/scope/digest), input budget packing that includes provider tool schemas and formal extension contributions, metadata-only `context.snapshot` Session entries, optional explicit session/project memory (default off), compaction/branch-summary snapshot provenance, RPC `get_context` / `RpcClient.getContext()`, interactive `/context` and `/memory`, and additive `RunReceipt.contextSnapshotId`.

### Changed

### Fixed

- Made managed `fd` and `rg` downloads safe across concurrent processes by isolating temporary archives and extraction directories.
- Defaulted package changelog links to the AOS Agent repository when no override is configured.
- Context snapshots are persisted immediately before every model call, including retries, tool loops, compaction, and branch summaries; persistence failures prevent provider dispatch.
- Context Engine initial budget validation now uses post-compaction Agent state, allowing eligible compaction before rejecting over-budget prompts.

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
