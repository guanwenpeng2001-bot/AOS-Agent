# Capabilities and MCP

The capability registry is the single policy path for built-in tools, extension tools, SDK tools, skills, extensions, and MCP servers. Each descriptor has a stable id, revision, source metadata, availability, trust result, and profile decision. A binding is resolved and frozen before a prompt or Automation Host run uses it.

The registry controls whether a capability enters the agent runtime. It is not an operating-system sandbox and does not constrain arguments, filesystem access, or network access after a selected tool executes.

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

`allow` exposes an available capability. `ask` requires an explicit approval in the current session. `deny` prevents exposure. Built-in tools, extension tools, SDK tools, and skills retain their normal default availability; MCP servers and MCP tools default to `deny`. A tool cannot be more permissive than its parent MCP server.

`tools`, `excludeTools`, `noTools`, and SDK tool allowlists are final narrowing operations. They cannot turn a registry `deny` into `allow`. In headless and RPC modes, an unresolved `ask` is an explicit `capability_approval_required` failure.

Interactive mode provides:

- `/capabilities` — list the redacted catalog;
- `/capabilities inspect <id>` — inspect one descriptor;
- `/capabilities approve <id>` — approve an ask capability for this session.

Approval is session-local, never written to settings, and never overrides a deny, project trust boundary, unavailable capability, or final tool narrowing.

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

The client does not load MCP resources or prompts and does not inject server instructions into system context. MCP tools are exposed with canonical names of the form `mcp__<serverId>__<toolName>`.

## Inspection and audit

The public `AgentSession` surface provides `inspectCapabilityCatalog()`, `getActiveCapabilityBinding()`, `getActiveCapabilityProfile()`, and `approveCapability()`. `setCapabilityProfile()` materializes a named profile, and `whenCapabilitiesReady()` waits for selected MCP discovery to complete.

RPC exposes the ordinary `get_capabilities` method and `RpcClient.getCapabilities()`. The result contains redacted ids, kinds, names, source identity, revisions, availability, decisions, and binding metadata. It never returns command arguments, cwd values, environment/header values, tokens, unredacted URLs, tool-call arguments, or raw local paths.

`run.start` and `run.resume` preflight the selected binding before accepting a run. Run receipts and Context Engine source receipts carry the capability binding id. Resume performs a new discovery and binding attempt; it does not reuse an old MCP connection or silently accept capability drift.

## Non-goals

This feature does not implement MCP OAuth browser flows or credential storage, legacy SSE, MCP resource/prompt ingestion, argument-level policy, the Sandbox, ModelBroker, or external agent orchestration. Use a container or another separately governed environment when stronger execution isolation is required.
