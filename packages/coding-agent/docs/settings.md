# Settings

AOS Agent uses JSON settings files with project settings overriding global settings. The default user and project locations are `.aos-agent`.

| Location | Scope |
|----------|-------|
| `~/.aos-agent/agent/settings.json` | Global (all projects) |
| `.aos-agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## Project Trust

On interactive startup, AOS Agent asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.aos-agent/agent/trust.json`. Trusting a project allows AOS Agent to load `.aos-agent/settings.json` and `.aos-agent` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.aos-agent/agent/settings.json`, or change it with `/settings`.

`aos config` and package commands use the same project trust flow, except `aos update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.aos-agent/agent/trust.json` only; the current session is not reloaded, so restart AOS Agent for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`AOS_AGENT_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` or experimental `"fullscreen"`. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the resume hint. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost column and keeps it visible, and `"hidden"` hides it. Has no effect in regular TUI mode |

For VS Code, include `--wait` so AOS Agent resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` only controls optional anonymous install/update telemetry. Install/update telemetry and product version-check services are not used by default in this distribution.

Set `AOS_AGENT_SKIP_VERSION_CHECK=1` to disable version update checks when a checker is configured. Use `--offline` or `AOS_AGENT_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before AOS Agent sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.aos-agent/agent/npm/`; project-scoped npm packages install under `.aos-agent/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".aos-agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `AOS_AGENT_SESSION_DIR` (then the deprecated `AOS_AGENT_CODING_AGENT_SESSION_DIR` alias), then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.aos-agent/agent/settings.json` resolve relative to `~/.aos-agent/agent`. Paths in `.aos-agent/settings.json` resolve relative to `.aos-agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
	"packages": ["aos-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
		"source": "aos-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

### Capabilities

AOS Agent models what it can load and call as capabilities with profile decisions (`allow`, `ask`, or `deny`). Configure named profiles and MCP servers here; inspect the catalog and approve ask capabilities per session with `/capabilities` (see [usage.md](usage.md#capabilities)).

```json
{
  "capabilities": {
    "defaultProfile": "default",
    "profiles": {
      "default": {
        "rules": []
      },
      "strict": {
        "rules": [
          { "selector": { "kind": "mcp_server" }, "action": "ask" },
          { "selector": { "kind": "extension_tool" }, "action": "ask" }
        ]
      }
    }
  }
}
```

`capabilities.profiles` maps profile names to ordered rule lists; the last matching rule wins. Selectors match on `id`, `kind`, `sourceId`, `scope`, `mcpServerId`, or `parentId`. MCP servers and tools default to `deny` unless a profile rule allows or asks them.

#### mcp.servers

```json
{
  "mcp": {
    "servers": {
      "docs": {
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": ["PATH", "DOCS_TOKEN"]
      },
      "issue-tracker": {
        "transport": "streamable-http",
        "url": "https://mcp.example.invalid/mcp",
        "headersFromEnv": [{ "name": "Authorization", "valueFromEnv": "ISSUE_TRACKER_TOKEN" }]
      }
    }
  }
}
```

`mcp.servers` maps server ids to configs. `stdio` servers spawn a local command with `env` (an array of environment variable **names** passed through to the child). The parent-process environment is not inherited implicitly; allowlist `PATH` when a non-absolute command needs it. `streamable-http` servers connect to a `url` and send `headersFromEnv`, each `{ name, valueFromEnv }` referencing an environment variable **name**.

OAuth is not configured by putting tokens or client secrets in settings. Streamable HTTP servers may add a secret-free `oauth` object:

```json
{
  "mcp": {
    "servers": {
      "issue-tracker": {
        "transport": "streamable-http",
        "url": "https://mcp.example.invalid/mcp",
        "oauth": {
          "redirectUrl": "http://127.0.0.1:8754/callback",
          "clientId": "public-client",
          "scope": "mcp"
        }
      }
    }
  }
}
```

`oauth.redirectUrl` is required when `oauth` is present (https or an http loopback address). `canonicalResource`, `clientId`, `scope`, and `clientName` are optional. Dynamic client registration is used when `clientId` is absent. Tokens and client secrets never live in settings. Without `oauth`, `/mcp auth` uses a default loopback callback. `stdio` servers must not set `oauth` and keep using the explicit `env` allowlist. Start or remove a stored credential with `/mcp auth <serverId>` and `/mcp logout <serverId>` (see [usage.md](usage.md) and [capabilities.md](capabilities.md#mcp-authentication)). Public status is `authenticated` / `expired` / `required` only.

Capability profile selectors may match `mcp_resource`, `mcp_resource_template`, and `mcp_prompt` as well as `mcp_server` / `mcp_tool`. Server `deny` cascades to every child; a child may further `ask` or `deny` but cannot widen a parent `deny`. Resources and prompts are never model-visible tools. Content size, MIME, block count, and field limits are Host-side finite defaults; oversize or malformed content fails closed.

Safety:

- MCP config references environment variable values only by name: set the value in the environment and reference the name via `env` (stdio child process) or `headersFromEnv.valueFromEnv` (HTTP header). This keeps the parsed config secret-free and safe to show in redacted views.
- `streamable-http` URLs must be absolute `http(s)` and must not contain userinfo (`user:pass@`) or credential-bearing query parameters.
- Global `mcp.servers` are trusted. Project `mcp.servers` are trusted only when the project is trusted; an untrusted project server is surfaced but denied and never connected. Project `capabilities` (profiles and `defaultProfile`) merge only when the project is trusted.

## External Connectors

`externalConnectors` registers trusted local connector targets for standard CLI,
RPC, and SDK Sessions. The global object contains `schemaVersion: 1`, `targets`,
and an optional selected `targetId`. Each target pins `targetId`, `providerId`,
absolute `executablePath`, absolute `modulePath`, absolute `cwd`, `version`,
`executableIdentity`, `moduleIdentity`, and `capabilityCeiling`. An optional
`accountReference` contains only `{schemaVersion, namespace, accountId}`.

Project settings cannot define targets. A trusted project may provide
`{schemaVersion: 1, targetId?, capabilityCeiling?, role?}` to select a global
target and narrow its ceiling. Project and `role` selections are rejected when
the project is untrusted. A narrowing can disable `resume`, `toolGateway`,
`artifacts`, or `images`, and can reduce `modelAccess`; it cannot widen the
global ceiling.

Settings are used only when the embedding Host omits `runtimeComposition`. A
Host-explicit composition wins as one authority graph; settings fields are not
merged into it. Settings may populate only the External Connector slice and
never enable Scheduler, Worker, or Subagent composition. See
[external-agent-connector.md](external-agent-connector.md#settings-registration)
for the complete example and current packaged-driver boundary.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
	"packages": ["aos-skills"]
}
```

## Project Overrides

Project settings (`.aos-agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.aos-agent/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .aos-agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
