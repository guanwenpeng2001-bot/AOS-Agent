# Capabilities and MCP

AOS Agent keeps capability selection, operation policy, execution boundaries, and model routing separate:

| Layer | Authority | Not an authority for |
| --- | --- | --- |
| Capability Registry | Whether built-in tools, extension tools, SDK tools, skills, extensions, MCP servers, and MCP tools are visible and selected | Filesystem, process, network, or credential isolation |
| Execution Policy | Whether a selected capability or operation is allowed, needs approval, or is denied | Making a host process isolated by itself |
| Sandbox Provider | Where an allowed operation executes and which resource boundary it enforces | Capability selection or model routing |
| ModelRuntime | Model endpoints, metadata, and provider credentials | Tool permissions or sandbox selection |
| ModelBroker | Model binding, route order, fallback eligibility, and model budgets | Tool permissions, credentials, or sandbox selection |

The Capability Registry resolves a binding before a prompt or Automation Host run uses it. The binding freezes the policy-selected capability set and tool registry, not the active subset chosen by an extension. An extension may switch among tools already in the frozen registry for the next provider request; profile, trust, and MCP discovery changes wait until the run settles.

## Capability profiles

Profiles are declared under `capabilities.profiles`. Rules are evaluated in order; the last matching rule wins. A rule can match `id`, `kind`, `sourceId`, `scope`, `mcpServerId`, or `parentId`.

```json
{
  "capabilities": {
    "defaultProfile": "local-tools",
    "profiles": {
      "local-tools": {
        "rules": [
          { "selector": { "kind": "mcp_server", "mcpServerId": "docs" }, "action": "allow" },
          { "selector": { "kind": "mcp_tool", "mcpServerId": "docs" }, "action": "allow" }
        ]
      }
    }
  }
}
```

`allow` exposes an available capability. `ask` requires explicit approval in the current session. `deny` prevents exposure. Built-in tools, extension tools, SDK tools, and skills retain their normal default availability; MCP servers and MCP tools default to `deny`. A tool cannot be more permissive than its parent MCP server.

`tools`, `excludeTools`, `noTools`, and SDK tool allowlists are final narrowing operations. They cannot turn a registry `deny` into `allow`. In headless and RPC modes, an unresolved capability `ask` is an explicit `capability_approval_required` failure. `noTools: "builtin"` leaves built-in tools available for registry inspection but starts with them inactive; `noTools: "all"` removes all model-visible tools.

## Execution Policy

Execution Policy runs after capability selection and before a side effect. It covers `capability.invoke`, filesystem reads and writes, process spawning, network connections, credential exposure, and sandbox preparation. `CapabilityProfile` / `capabilityProfile` selects capabilities; `ExecutionPolicyProfile` / `policyProfile` selects operation policy. These names and settings are independent.

The `executionPolicy` settings key contains named profiles. A run may select a registered profile name only; inline policy objects and an allow-all selector are not accepted. Actions have this meaning:

- `allow` proceeds to the operation wrapper or Sandbox Handle;
- `ask` creates a request before the side effect and waits for session approval;
- `deny` fails without an approval request or side effect.

When rules are merged, `deny > ask > allow`. `sandbox_required` is a hard failure outcome, not a fourth action. The built-in fallback when policy settings or `defaultProfile` are absent is profile `legacy`, with `enforcement: "legacy"` and `defaultAction: "allow"`; it preserves existing host behavior and makes no isolation claim.

`enforcement: "sandbox"` requires a registered Sandbox Provider with every capability required by the operation. Resolution is fail-closed: no provider returns `sandbox_required`, an unavailable provider returns `sandbox_unavailable`, an incomplete capability report returns `sandbox_capability_insufficient`, and preparation failure returns `sandbox_start_failed`. None of these outcomes falls back to host or legacy execution. `host` enforcement provides local policy checks but is not a strong boundary for arbitrary processes or network access.

Project policy can select a registered user profile only when the project is trusted. An untrusted project cannot select a different profile, but it may narrow the effective registered profile; its input is retained only for safe diagnostics. Project policy cannot widen a user `deny`, expand roots or destinations, expose more environment or credentials, or select an unregistered provider. Policy and capability bindings are immutable for a run. Resume recomputes trust, capability, policy, and sandbox state and creates a successor binding; it does not reuse an old approval, Sandbox Handle, process, VM, or MCP connection.

## MCP configuration

Version 1 supports only stdio and Streamable HTTP transports. Legacy SSE is not supported.

```json
{
  "mcp": {
    "servers": {
      "docs": {
        "transport": "stdio",
        "command": "node",
        "args": ["./tools/docs-mcp.mjs"],
        "env": ["PATH", "DOCS_TOKEN"]
      },
      "search": {
        "transport": "streamable-http",
        "url": "https://mcp.example.invalid/mcp",
        "headersFromEnv": [
          { "name": "Authorization", "valueFromEnv": "SEARCH_MCP_AUTH" }
        ]
      }
    }
  }
}
```

`env` and `headersFromEnv` contain environment-variable names only. Stdio receives no parent-process environment values implicitly; only explicitly allowlisted values are passed through. If the command needs `PATH`, allowlist it or use an absolute executable path. Literal header values, URL userinfo, and credential-like URL query parameters are rejected.

MCP configuration is trust-aware. Project-local servers are surfaced for diagnosis but cannot start a process or establish a remote connection until the project is trusted. A configured server is not connected automatically; only a server selected by the active binding is connected for tool discovery and calls.

## MCP authentication

stdio servers are child processes and never use OAuth; any configured environment variable names are passed through by the execution policy. Streamable HTTP servers can use OAuth 2.0 (Authorization Code + PKCE against the server's RFC 9728 protected resource and RFC 8414 authorization server metadata). Authorization is always an explicit action:

- `/mcp auth <server-id>` runs the interactive OAuth flow for a configured Streamable HTTP server (confirm before redirect, authorization URL shown in the chat, loopback or manual-code callback). Tokens are stored only in the MCP credential namespace (`mcp__<installationId>__<serverIdentity>`) of the session's agent directory and are never displayed, logged, or returned by any public surface.
- `/mcp logout <server-id>` removes the stored credential of one server. Logout is local-first: a best-effort RFC 7009 revocation is attempted when the authorization server advertised a revocation endpoint, then the namespaced credential is always deleted.
- `/mcp` and `/mcp auth` list configured servers with transport, trust, connection state, and masked credential status (digest identity, scope, expiry, refresh-token presence — never URLs or token values).

A session that is not connected to a server yet does not block authorization; the flow runs against the configured endpoint and stores the credential for the next connect. Headless modes never auto-approve an OAuth flow.

## MCP resources and prompts

The client never loads MCP resources or prompts automatically and never injects server instructions into system or developer context. MCP tools are exposed with canonical names of the form `mcp__<serverId>__<toolName>`; resources and prompts are only ever accessed through explicit commands:

| Command | Effect |
| --- | --- |
| `/mcp resources <server-id> [cursor]` | List one page of the resources catalog: digest ids, sanitized names/titles, MIME type, size, revision — never raw URIs |
| `/mcp prompts <server-id> [cursor]` | List one page of the prompts catalog: digest ids, sanitized names, argument counts — never raw names or argument values |
| `/mcp resource <server-id> <resourceId>` | Explicitly read one listed resource by its digest id, show the redacted digest receipt, then ask for confirmation before attaching |
| `/mcp prompt <server-id> <promptId> [key=value ...]` | Explicitly get one listed prompt by its digest id, show the redacted digest receipt, then ask for confirmation before attaching |

Read/get/attach/confirm are separate explicit actions: nothing is auto-approved, no model is started, and local prompt templates are never overridden. Attaching registers the normalized result as a structured external attachment in the session — the only way remote content enters the session — with an untrusted provenance wrapper, digest/size metadata, and an allowlist of text/image blocks only. Attached content is never injected into the system or developer prompt and never treated as trusted instructions. Re-attaching the same content is idempotent (deterministic digest id).

## Inspection, approval, and redaction

Interactive mode provides:

- `/capabilities` — list the redacted catalog;
- `/capabilities inspect <id>` — inspect one descriptor;
- `/capabilities approve <id>` — approve an ask capability for this session;
- `/policy` — inspect the active policy profile, binding, project trust, enforcement, sandbox status and capability summary, last decision, and pending policy approvals; use `/policy approve <request-id>` or `/policy reject <request-id>` for a current-session request;
- `/mcp` — list configured MCP servers, connection state, and masked OAuth credential status;
- `/mcp auth <server-id>` / `/mcp logout <server-id>` — run OAuth for a Streamable HTTP server or remove its stored credential (see [MCP authentication](#mcp-authentication));
- `/mcp resources` / `/mcp resource` / `/mcp prompts` / `/mcp prompt` — explicitly list, read/get, and (after confirmation) attach resources and prompts (see [MCP resources and prompts](#mcp-resources-and-prompts)).

The public `AgentSession` surface provides capability inspection and approval methods plus `getExecutionPolicySummary()`, `getExecutionPolicyBinding()`, `getExecutionPolicyLedger()`, `getExecutionPolicyApprovals()`, `approveExecutionPolicy()`, and `rejectExecutionPolicy()`. SDK options and Automation Host `run.start` / `run.resume` accept `policyProfile?: string`. The CLI accepts `--policy <profile>`.

RPC exposes `get_capabilities` and the read-only `get_execution_policy` command. The latter returns a redacted policy summary and pending approval metadata. `policy.approve` and `policy.reject` take a request id and apply only to the current session request and policy binding; they do not update settings or become global approvals. Print, JSON, and other headless modes never auto-approve an `ask`; they return `policy_approval_required`.

Public capability and policy views are allowlisted. They may include opaque ids, profile and revision metadata, trust and enforcement, sandbox provider status and capability booleans, resource/action/outcome, fixed reason codes, request ids, timestamps, and bounded counts. They never include raw commands or arguments, cwd or full sensitive paths, environment or header values, tokens, credentials, authorization URLs, model credentials, provider process ids, temporary paths, MCP instructions, or agent self-reports. Capability provenance ids are installation-scoped opaque values and cannot be used to reconstruct source paths, URLs, or session paths. The same redaction boundary applies to RPC, SDK inspection, run receipts, Context Engine receipts, session events, and the policy ledger.

MCP content output follows the same boundary and is stricter: resource/prompt list, read/get, and attach receipts carry only deterministic digest ids, byte counts, block counts, MIME types, sanitized catalog names, and untrusted provenance metadata. Raw URIs, prompt names and argument values, tokens, and remote original text are never rendered, never retained on receipts, and never included in errors — errors use fixed safe templates (for example `MCP server "<id>" returned unsupported content` or a stable `CapabilityError` code) that cannot leak remote text. The authorization URL appears only in the interactive `/mcp auth` dialog, which is the user's own authorization step; it never appears in status output, receipts, events, logs, or RPC/SDK surfaces.

## Inspection and audit

`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, `approveCapability()`, `setCapabilityProfile()`, and `whenCapabilitiesReady()` provide the corresponding session operations. `get_capabilities` returns redacted ids, kinds, names, source identity, revisions, availability, decisions, and binding metadata only.

`run.start` and `run.resume` preflight the selected capability, policy, and sandbox bindings before accepting a run. A selected tool cannot bypass the registry, policy checks, or the Sandbox Provider boundary, and ModelBroker fallback cannot bypass policy denial, approval, sandbox, credential, or policy-ledger errors.

Policy errors are stable, machine-readable, and non-retryable by ModelBroker. A route retry can handle a model transport failure, but it cannot change an operation decision or satisfy a missing sandbox capability.

## Non-goals

This feature does not implement legacy SSE, argument-level capability policy, or external agent orchestration. OAuth is Streamable HTTP only; stdio servers never participate in OAuth. Resources and prompts are never auto-injected into system or developer context and never auto-start a Run. Sampling, elicitation, roots, completion, MCP tasks, Task Credential/Lease, and model-provider OAuth are out of scope. The registry is not an operating-system sandbox, and the legacy profile is not isolation. Use a strict policy with a real Sandbox Provider, a container, or another separately governed environment when stronger execution isolation is required.
