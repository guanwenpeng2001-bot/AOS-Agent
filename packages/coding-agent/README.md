# AOS Agent

AOS Agent is a terminal coding agent with an interactive TUI, non-interactive print mode, built-in file and shell tools, model selection, and resumable sessions.

This package is the installable standalone product in the AOS Agent baseline. Upstream source provenance and legal notices are maintained separately in [`../../UPSTREAM.md`](../../UPSTREAM.md) and [`../../LICENSE`](../../LICENSE).

## Install from this repository

Build the workspace once, then install this package into an npm prefix:

```sh
npm install --ignore-scripts
npm run build
npm install --global --ignore-scripts ./packages/coding-agent
```

The build hydrates ignored model wrappers from the tracked AI test fixtures, then generates the local AOS-owned model registry under `.artifacts/aos-model-registry/`; its source policy and reproducibility contract are documented in [`../ai/aos-model-registry.md`](../ai/aos-model-registry.md).

Start the agent with:

```sh
aos
```

Verify a non-interactive installation with:

```sh
aos --help
```

The default user data directory is `~/.aos-agent/agent`. The project-local configuration directory is `.aos-agent/`. Use `aos --offline` to disable startup update, package, and install-telemetry network operations.

## Basic usage

```sh
aos "Explain this repository"
aos --continue "Continue the previous task"
aos --print "Summarize the current directory"
aos --model openai/gpt-4o "Review this change"
aos --no-extensions --offline --help
```

Authentication can be supplied through provider-specific environment variables or the built-in auth commands:

```sh
aos auth check --provider openai
aos auth print-api-key --provider openai
```

Run `aos --help` for the complete option and provider list.

## Configuration and extensions

Global settings live under `~/.aos-agent/agent/`; project settings and resources live under `.aos-agent/`. The agent supports user-provided extensions, skills, prompt templates, and themes. Review any third-party package before installing it, and use `--no-extensions`/`--no-skills` for a source-only startup check.

Extension API and package manifest details are documented in the accompanying `docs/` directory.

### Capabilities

AOS Agent models what it can load and call — built-in tools, extension tools, SDK tools, skills, extensions, and MCP servers — as capabilities, each with a stable id, a kind, a redacted source, availability, a trust flag, and a profile decision (`allow`, `ask`, or `deny`).

In interactive mode, `/capabilities` lists the redacted capability catalog, `/capabilities inspect <id>` shows one descriptor (kind, profile rule, availability, trust, binding/selected status, redacted source, and revision), and `/capabilities approve <id>` approves an ask capability for the current session only. These commands are backed by the public Session surface (`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, and `approveCapability()`), so they never surface command arguments, environment/header values, tokens, unredacted URLs, or raw local paths.

Approvals are session-local: they are never written to settings and never override a deny from the active profile. Project-scoped sources default to untrusted and are force-denied. MCP servers connect over stdio or Streamable HTTP; a server that cannot connect is reported as unavailable rather than exposing connection internals.

Capability layer covers built-in tools, extension tools, SDK tools, skills, extensions, and MCP server tools over stdio or Streamable HTTP. It does not include OAuth for MCP servers, MCP resources or prompts, the Sandbox, external Agent orchestration, or legacy SSE transports.

### ModelBroker

ModelBroker routes select among models already known to the runtime without
moving credentials or provider endpoints into route configuration. Declare
global routes in `~/.aos-agent/agent/settings.json`; trusted projects may select
one of those routes in `.aos-agent/settings.json`. Use `/model-routes` to view
the redacted catalog and `/model-route <route>` or `/model-route role:<name>` to
select a route. `/model` remains the explicit manual selector and disables
automatic fallback for that selection. RPC clients can query the same safe
catalog with `get_model_routes` and pass `modelRoute` or `modelRole` to
`run.start`/`run.resume`. Routes may also declare call, token, and cost limits;
an over-limit response is retained, while later calls in that operation or Run
are rejected.

### External Agent Connector

The supported package surface is `aos-agent/external-connector`. It exposes the
connector registry, target configuration, input admission, model projection,
and packaged driver loader contracts. The model projection contract is
Host-side; it does not make `aos_gateway` reachable from generic settings
targets.

Settings-based product composition supports generic JSONL targets and explicit
pinned `claude`, `codex`, and `acp` drivers with `none` or `agent_owned` model
access. Vendor selection is declared by `driver`, never inferred from
`providerId`; identity, version, and capability drift fail closed before
launch. The packaged fake and injected vendor adapters cover registration ->
run -> receipt. Real vendor authentication remains a later certification step,
while Claude/Codex may use exclusive `aos_gateway`; ACP and generic targets reject it.

`aos-agent/external-connector/testing` is test-support only. It exports
`runPackagedExternalAgentDriverFixture` and `PackagedExternalAgentDriverTrace`
for the package smoke test; application code should not depend on that fixture
surface. The smoke test packs a staged package, installs it outside the
repository, resolves the testing subpath, and checks the shipped asset and safe
missing-asset error.

Engineering verification exercises the standard product composition across
run/switch/fork/import/reload/cancel/restart, immutable RuntimeLimits with
no-widen rules, passive connector runtime-status projection, and terminal
`side_effect_unknown` retry handling. Packaged smoke and pinned vendor
handshakes establish package and protocol reachability only. They do not certify
real vendor authentication or end-to-end task completion; no external connector
mode is currently task-certified.

## Package contents

- `dist/` — generated build output; it is created by `npm run build` and is not source-controlled in this baseline.
- `src/` — CLI and agent implementation.
- `docs/` and `examples/` — usage and integration references.
- `package.json` — package identity `aos-agent` and executable `aos`.

## License

This package is MIT-licensed as part of the independent AOS Agent product. Preserve the repository-level license, package attribution, and all third-party notices when copying or redistributing it.
