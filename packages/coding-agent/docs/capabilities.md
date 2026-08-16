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

Streamable HTTP servers can additionally declare OAuth (Authorization Code + PKCE):

```json
{
  "mcp": {
    "servers": {
      "search": {
        "transport": "streamable-http",
        "url": "https://mcp.example.invalid/mcp",
        "oauth": {
          "redirectUrl": "http://127.0.0.1:3000/callback",
          "canonicalResource": "https://mcp.example.invalid/mcp",
          "clientId": "my-public-client"
        }
      }
    }
  }
}
```

`oauth.redirectUrl` is required and must be https or an http loopback address. `canonicalResource` overrides the RFC 8707 resource discovered from the server; `clientId` pins a static public client (dynamic client registration is used when absent); `scope` and `clientName` are optional. All OAuth settings are secret-free: tokens and client secrets never appear in settings. Only Streamable HTTP servers authenticate; stdio servers keep using explicit environment variables and never trigger OAuth discovery.

MCP configuration is trust-aware. Project-local servers are surfaced for diagnosis but cannot start a process or establish a remote connection until the project is trusted. A configured server is not connected automatically; only a server selected by the active binding is connected for tool discovery and calls.

MCP tools are exposed with canonical names of the form `mcp__<serverId>__<toolName>`. The client never loads MCP resources or prompts and does not inject server instructions into system context; resources and prompts are only read and attached through the explicit `/mcp` commands below.

## Inspection, approval, and redaction

Interactive mode provides:

- `/capabilities` — list the redacted catalog;
- `/capabilities inspect <id>` — inspect one descriptor;
- `/capabilities approve <id>` — approve an ask capability for this session;
- `/policy` — inspect the active policy profile, binding, project trust, enforcement, sandbox status and capability summary, last decision, and pending policy approvals; use `/policy approve <request-id>` or `/policy reject <request-id>` for a current-session request.

The public `AgentSession` surface provides capability inspection and approval methods plus `getExecutionPolicySummary()`, `getExecutionPolicyBinding()`, `getExecutionPolicyLedger()`, `getExecutionPolicyApprovals()`, `approveExecutionPolicy()`, and `rejectExecutionPolicy()`. SDK options and Automation Host `run.start` / `run.resume` accept `policyProfile?: string`. The CLI accepts `--policy <profile>`.

RPC exposes `get_capabilities` and the read-only `get_execution_policy` command. The latter returns a redacted policy summary and pending approval metadata. `policy.approve` and `policy.reject` take a request id and apply only to the current session request and policy binding; they do not update settings or become global approvals. Print, JSON, and other headless modes never auto-approve an `ask`; they return `policy_approval_required`.

Public capability and policy views are allowlisted. They may include opaque ids, profile and revision metadata, trust and enforcement, sandbox provider status and capability booleans, resource/action/outcome, fixed reason codes, request ids, timestamps, and bounded counts. They never include raw commands or arguments, cwd or full sensitive paths, environment or header values, tokens, credentials, authorization URLs, model credentials, provider process ids, temporary paths, MCP instructions, or agent self-reports. Capability provenance ids are installation-scoped opaque values and cannot be used to reconstruct source paths, URLs, or session paths. The same redaction boundary applies to RPC, SDK inspection, run receipts, Context Engine receipts, session events, and the policy ledger.

## Inspection and audit

`inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, `approveCapability()`, `setCapabilityProfile()`, and `whenCapabilitiesReady()` provide the corresponding session operations. `get_capabilities` returns redacted ids, kinds, names, source identity, revisions, availability, decisions, and binding metadata only.

`run.start` and `run.resume` preflight the selected capability, policy, and sandbox bindings before accepting a run. A selected tool cannot bypass the registry, policy checks, or the Sandbox Provider boundary, and ModelBroker fallback cannot bypass policy denial, approval, sandbox, credential, or policy-ledger errors.

Policy errors are stable, machine-readable, and non-retryable by ModelBroker. A route retry can handle a model transport failure, but it cannot change an operation decision or satisfy a missing sandbox capability.

## MCP OAuth, resources, and prompts

MCP server OAuth, resources, and prompts are governed like every other MCP capability: the server must be selected by the active capability binding, and every operation (`mcp.auth`, `mcp.content.list`, `mcp.content.read`, `mcp.content.attach`) runs through the Execution Policy. MCP servers, tools, resources, and prompts all default to `deny`; a profile rule must expose them, and an `ask` still requires current-session approval in interactive mode. Headless modes never auto-approve.

Interactive mode provides:

- `/mcp auth <serverId>` — show the redacted OAuth/credential status and, after confirmation, run the interactive Authorization Code + PKCE flow. The one-time authorization URL is displayed only inside the transient auth dialog (Esc cancels) and never written to the transcript, status, receipts, or logs.
- `/mcp logout <serverId>` — delete the stored OAuth credential for the server after confirmation. Revocation is best effort; local cleanup always completes.
- `/mcp resources [serverId]` — list the redacted resource and resource-template catalog of one server (the sole configured server is used when the id is omitted).
- `/mcp resource [serverId] <resourceId>` — read a listed resource (by its stable opaque id; raw URIs never appear in listings or output), show a capped preview, and attach it as untrusted context for the next turn only after explicit confirmation.
- `/mcp prompts [serverId]` — list the prompt catalog of one server.
- `/mcp prompt [serverId] <promptId> [key=value ...]` — fetch a listed prompt (missing required arguments are prompted for), preview its messages, and attach them as untrusted context only after explicit confirmation. Prompts are referenced by their stable opaque id; the server-facing name is display-only.

Every command calls the public `AgentSession` MCP surface directly (`getMcpAuthStatus`, `startMcpAuth`, `logoutMcpAuth`, `listMcpResources`, `listMcpResourceTemplates`, `listMcpPrompts`, `readMcpResource`, `getMcpPrompt`, `attachMcpResource`, `attachMcpPrompt`). List/read/get never start a model run, never inject into system or developer prompts, and never auto-approve anything; attach is the only path that stages remote content, and it requires the explicit preview confirmation above.

Remote content is always displayed behind a fixed **UNTRUSTED EXTERNAL MCP CONTENT** banner and is capped in size. It is staged as user-controlled context for the next turn; it cannot change policy, capability, or system/developer directives. Embedded resource links in prompt results do not bypass resource capability or policy. Prompt messages keep their server roles (`user`/`assistant`) but are never elevated to instructions.

All MCP command output is redacted: tokens, authorization URLs (outside the transient dialog), OAuth metadata, raw remote errors, raw URIs in errors, and unnecessary parameters never appear. Failures show only the stable error code plus the fixed redacted text (`mcp_auth_*`, MCP lifecycle kinds, `capability_*` codes, or a generic failure line). Cancellation, timeouts, and rejected confirmations are surfaced as fixed messages and never leave a flow, connection, or waiter behind.

## Non-goals

This feature does not implement legacy SSE, argument-level capability policy, automatic resource/prompt ingestion, or external agent orchestration. MCP OAuth covers Streamable HTTP servers only; stdio credentials come from explicit environment variables. The registry is not an operating-system sandbox, and the legacy profile is not isolation. Use a strict policy with a real Sandbox Provider, a container, or another separately governed environment when stronger execution isolation is required.
