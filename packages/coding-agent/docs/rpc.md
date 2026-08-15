# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout by default or a local TCP socket when `--rpc-listen` is used. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `aos-agent` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Starting RPC Mode

```bash
aos --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

### TCP listener (`--rpc-listen`)

RPC mode uses stdin/stdout by default. To serve the same protocol from a local
TCP socket, start it with:

```bash
aos --mode rpc --rpc-listen tcp://127.0.0.1:4123 [options]
```

`--rpc-listen` accepts only `tcp://127.0.0.1:<port>`, where `<port>` is `1` to
`65535`. It requires `--mode rpc`; host names, wildcard addresses, IPv6
addresses, credentials, paths, queries, and fragments are rejected. The
listener binds the IPv4 loopback interface only.

The TCP listener has no authentication or encryption. Any process that can
connect to the local loopback interface can issue RPC commands, so do not
expose or forward this port outside the local machine. Stdio remains the
default when the stronger process-pipe boundary is appropriate.

Only one control connection is active at a time. A second connection receives
one JSON error record with `error.code: "rpc_transport_connection_busy"` and is then closed. A new
connection can take ownership after the active connection closes. The client
must reconnect explicitly: the TCP transport does not automatically retry,
replay, or resend commands.

If the active TCP connection closes while a run is executing, the host requests
cancellation through the existing `requestCancel()` / `session.abort()` path and
lets the normal settlement persist the terminal `run.cancelled` receipt. The
disconnected client cannot receive that terminal event. After reconnecting, send
`initialize`, then use `run.get` to read the durable run record and receipt; use
`audit.replay` when the event stream may have been interrupted or the process
boundary is uncertain.

Live run events are scoped to the connection that owns the session. A
replacement connection receives no buffered or stale `run.started`, `run.event`,
or terminal records from the previous connection, including a terminal record
that was emitted after the previous client disconnected. Reconcile through the
durable `run.get` and `audit.replay` commands instead.

`RpcClient` selects this transport with the public `"tcp"` discriminator:

```ts
const client = new RpcClient({
  transport: { type: "tcp", host: "127.0.0.1", port: 4123 },
});
```

The `host` is optional in this configuration but, when supplied, must be the
IPv4 loopback literal `127.0.0.1`. `port` is required and must be an integer
from `1` through `65535`; `connectTimeoutMs` is optional and defaults to
`10000`. Omit `transport` (or set it to `"stdio"`) to keep the child-process
transport.

Stdio and TCP use the same public command, response, and event records. The
transport-specific differences are the TCP frame limit, connection ownership,
disconnect cancellation, and diagnostics described below.

## Protocol Overview

- **Commands**: JSON objects sent to stdin (stdio) or the TCP socket, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout (stdio) or the TCP socket as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`. `bash_execution_update` events also include the `id` of their originating `bash` command.

**Automation Host**: RPC mode also hosts an opt-in Automation Host protocol layer that gives automation callers a stable, versioned run lifecycle (see [Automation Host](#automation-host-protocolversion-1)). It is disabled until a client sends `initialize` with `protocolVersion: 1`, so existing clients are unaffected until they opt in.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter
on both stdio and TCP.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

TCP input and output records are limited to 1 MiB (1,048,576 UTF-8 bytes,
including the terminating LF). An oversized input record is rejected with a
transport error record (`error.code: "rpc_transport_frame_too_large"`) and the connection is
closed without dispatching that record. Stdio has no RPC-level frame bound.

An output record that exceeds the TCP bound is rejected by the JSONL writer and
invalidates the connection; a client must not treat the affected request as
delivered. The bound is measured in UTF-8 bytes, not JavaScript string length.

Writes are serialized in call order. A write is not considered complete until
the underlying stream accepts the record and drains when backpressure is
reported. The Automation Host waits for transport backpressure at command and
agent-event boundaries, and `RpcClient` queues its TCP writes in the same order;
clients should continue reading the socket while a run is active so streamed
events do not fill the output buffer.

### TCP transport errors

Transport errors are distinct from command responses. When the transport can
report an error before closing, it emits a record without a request id:

```json
{
  "type": "error",
  "error": {"code": "rpc_transport_frame_too_large", "message": "..."}
}
```

The stable transport error vocabulary is `rpc_transport_address_invalid`,
`rpc_transport_not_loopback`, `rpc_transport_bind_failed`,
`rpc_transport_connection_busy`, `rpc_transport_frame_too_large`,
`rpc_transport_closed`, and `rpc_transport_write_failed`. The generic
transport adapter may also report `rpc_transport_invalid_json`,
`rpc_transport_invalid_command`, or `rpc_transport_dispatch_failed` when it
cannot construct a Host response. A busy connection is rejected before
dispatch; an oversized record is rejected without dispatch and then the
connection is closed. Socket, listener, and close failures can terminate the
connection without a final error record and are also reported through stderr
or transport observers.

When `RpcClient` receives a recognized transport error record, it rejects all
pending requests, invalidates the active socket, and does not route the record
to `onEvent()` or `onRunEvent()`. A disconnected or transport-failed request
therefore has unknown delivery state and must be reconciled before retrying a
side effect.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `agent.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model) object or `null`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

#### get_model_routes

Return the redacted ModelBroker catalog. The response contains model identity,
route candidate order/availability, role names, and safe binding summaries; it
never contains credentials, headers, base URLs, or provider error objects.

```json
{"id": "routes-1", "type": "get_model_routes"}
```

```json
{
  "type": "response",
  "command": "get_model_routes",
  "success": true,
  "data": {
    "schemaVersion": 1,
    "models": [{"provider": "anthropic", "id": "claude-sonnet-4-5"}],
    "routes": [{"id": "balanced", "candidates": [{"reference": {"provider": "anthropic", "id": "claude-sonnet-4-5"}, "priority": 0, "enabled": true, "available": true}]}],
    "roles": ["worker"],
    "roleRoutes": [{"id": "worker", "routeId": "balanced"}],
    "bindings": []
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose both.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Include an `id` to associate streamed `bash_execution_update` events with this command.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/aos-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_context

Read-only Context Engine inspection. Does **not** require Automation Host `initialize`. Returns a metadata-only snapshot receipt and optional drift; never includes project rule bodies, session text, memory text, tool output, or credentials.

```json
{"id": "c1", "type": "get_context"}
{"id": "c2", "type": "get_context", "snapshotId": "…"}
```

Response:
```json
{
  "id": "c1",
  "type": "response",
  "command": "get_context",
  "success": true,
  "data": {
    "snapshot": { "schemaVersion": 1, "id": "preview", "sources": [], "budget": {} },
    "drift": [],
    "preview": true
  }
}
```

`RpcClient.getContext(snapshotId?)` wraps this command. See [Context Engine](context.md).

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
```json
{"type": "get_entries", "since": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `aos --mode rpc` process.

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.aos-agent/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.aos-agent/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.aos-agent/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `agent.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.aos-agent/agent/`)
  - `"project"`: Project-level (`./.aos-agent/agent/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do not generally include an `id` field; `bash_execution_update` includes the `id` of its originating `bash` command when one was provided.

While an Automation Host run is active, session events are wrapped as run events (`run.event`, `run.started`, and the terminal events); see [Automation Host](#automation-host-protocolversion-1).

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | One low-level agent run completes (may still be followed by retry, compaction, or queued continuations) |
| `agent_settled` | Agent run is fully settled; no automatic retry, compaction retry, or queued continuation remains |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

Emitted after the full session-level run settles. At this point AOS Agent will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains a delta event without a cumulative message snapshot.

```json
{
  "type": "message_update",
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

`message_update` intentionally omits the former cumulative `message` field and
`assistantMessageEvent.partial`. Clients that need a live partial message must assemble it
from `message_start` and subsequent events using `contentIndex`. Treat `message_end.message`
as authoritative. For tool calls, buffer `toolcall_delta.delta`; `toolcall_end.toolCall`
contains the completed call.

### bash_execution_update

Emitted once for each output chunk from a direct `bash` command. `id` matches the command's `id`, allowing clients to associate output with the correct command.

Events stream all output while the command runs, even if the final `bash` response's `output` is truncated.

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when compaction or branch-summary summarization retries after a transient provider error. These events use the same retry settings as automatic assistant-turn retries.

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

For branch summaries, `source` is `"branchSummary"` and no `reason` is present.

```json
{
  "type": "summarization_retry_finished"
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "aos - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Automation Host (protocolVersion 1)

Automation Host v1 is an opt-in protocol layer on top of RPC mode for automation callers (IDEs, CI, custom UIs) that need a stable contract for launching and observing agent runs. It adds a durable Run identity, a unique terminal event per run, a terminal receipt, and a persistent run ledger stored inside the session itself.

The Automation Host reuses the existing agent loop, `AgentSession`, session
persistence, and the strict JSONL transport. It is available over either the
default stdio transport or the local TCP listener described above; it is not a
second agent loop and v1 introduces no HTTP, WebSocket, database, or
remote-agent layer. The TCP listener remains deliberately unauthenticated and
loopback-only, so it is not a remotely exposed service.

### Opt-in handshake

Automation Host is strictly opt-in. A client that never sends `initialize` sees exactly the legacy RPC behavior described above: `prompt`, bare session events, the string `error` field, the extension UI sub-protocol, and so on. No existing client has to migrate.

All `run.*` commands require a successful `initialize` first. If a client sends a `run.*` command before initializing, the host replies with the structured error `host_not_initialized`.

`initialize` accepts exactly `protocolVersion: 1`. Any other version is rejected with `unsupported_protocol_version`; there is no silent downgrade and no fallback to an older contract.

Request:
```json
{"id": "init-1", "type": "initialize", "protocolVersion": 1}
```

Response:
```json
{
  "id": "init-1",
  "type": "response",
  "command": "initialize",
  "success": true,
  "data": {
    "host": "automation-host",
    "protocolVersion": 1,
    "sessionId": "abc123",
    "sessionFile": "/path/to/session.jsonl",
    "runCommands": ["run.start", "run.get", "run.cancel", "run.resume"],
    "auditCommands": ["audit.query", "audit.replay", "external.map"]
  }
}
```

The response advertises the host version, the current `sessionId`, and the run and audit commands available on this host. `sessionFile` is present only when the current session is persistent (see [Persistence and recovery](#persistence-and-recovery)).

Unsupported version:
```json
{
  "id": "init-1",
  "type": "response",
  "command": "initialize",
  "success": false,
  "error": {
    "code": "unsupported_protocol_version",
    "message": "Unsupported protocol version: 2. This host supports protocolVersion 1 only.",
    "retryable": false
  }
}
```

### Run lifecycle commands

| Command | Purpose |
|---------|---------|
| `run.start` | Start a new run in the current session |
| `run.get` | Query the current record of a run in the current session |
| `run.cancel` | Request cancellation of a run |
| `run.resume` | Restore a persisted session and start the next attempt of a source run |

#### run.start

Start a new run in the current session using the currently configured model, tools, permissions, and session context.

Request:
```json
{"id": "run-1", "type": "run.start", "message": "Refactor the auth module"}
```

With images and an optional declared route or role:
```json
{"type": "run.start", "message": "What's wrong in this screenshot?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}], "modelRoute": "balanced"}
```

The `images` field is optional and uses the same `ImageContent` format as `prompt`. `modelRoute` and `modelRole` are optional and mutually exclusive; they select only routes declared in trusted settings. `external` is an optional validated `{namespace, externalSessionId, externalRunId?}` reference. `deadlineAt` is an optional canonical UTC timestamp; it is included in the request fingerprint and propagates to model, tool, MCP, and Sandbox execution. `run.start` does not accept a working directory, a shell command, or permission overrides. Direct/manual model selection remains explicit and does not automatically fall back.

Accepted response (emitted before any run event):
```json
{
  "id": "run-1",
  "type": "response",
  "command": "run.start",
  "success": true,
  "data": {
    "runId": "run_abc123",
    "sessionId": "abc123",
    "attempt": 1,
    "status": "accepted",
    "external": {"namespace": "ci", "externalSessionId": "job-123", "externalRunId": "attempt-1"},
    "modelBindingId": "model-binding:...",
    "finalModel": {"provider": "anthropic", "modelId": "claude-sonnet-4-5"}
  }
}
```

When `external` was supplied, the accepted response includes the validated
external reference. Accepted and terminal run records may also include `previousModelBindingId`,
`modelAttempts`, and `modelBudget`. These are metadata-only summaries. The
same fields are available from `run.get` and terminal receipts; attempt
records contain candidate identity, status, timestamps, and safe usage only.
Accepted and terminal records may also include `deadlineAt` and a
`bindingAssociation` of public-safe stable handles for the ModelBroker,
Capability, Policy, and Sandbox bindings used by the Run.

Failures:
- `session_busy` when another run is already active in this session (see [One active run per session](#one-active-run-per-session))
- `start_rejected` when the host preflight rejects the input. In v1, inputs beginning with `/` are rejected because they could short-circuit the agent loop with a registered extension command and produce an undefined run terminal state.
- `ledger_persistence_failed` when the accepted or started run fact cannot be appended. The host does not publish a successful accepted response or enter the Agent loop in that case.
- `audit_persistence_failed` when an optional external mapping cannot be durably appended. The host does not publish a successful accepted response or acknowledge the mapping.

```json
{
  "id": "run-1",
  "type": "response",
  "command": "run.start",
  "success": false,
  "error": {
    "code": "session_busy",
    "message": "A run is already active in this session. Wait for its terminal event before starting another.",
    "retryable": true
  }
}
```

If preflight rejects the run, no Run ID is created, no `run.started` is emitted, and nothing is written to the ledger. A run that returns `status: "accepted"` is guaranteed to eventually emit exactly one `run.started` and exactly one terminal event.

#### run.get

Query the current record of a run in the current session. The host serves the record from its in-memory index or from the ledger rebuilt from the session's custom entries, so a terminal run remains queryable after a process restart.

Request:
```json
{"type": "run.get", "runId": "run_abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "run.get",
  "success": true,
  "data": {
    "run": {
      "id": "run_abc123",
      "sessionId": "abc123",
      "attempt": 1,
      "status": "completed",
      "model": {"provider": "anthropic", "id": "claude-sonnet-4-20250514", "thinkingLevel": "medium"},
      "startedAt": "2026-08-10T12:00:00.000Z",
      "endedAt": "2026-08-10T12:01:30.000Z"
    },
    "receipt": {
      "runId": "run_abc123",
      "sessionId": "abc123",
      "status": "completed",
      "finalText": "Refactored the auth module...",
      "usage": {"input": 1200, "output": 350, "total": 1550},
      "sessionFile": "/path/to/session.jsonl"
    }
  }
}
```

- `run`: the current `RunRecord` (see [Run record](#run-record)).
- `receipt`: present once the run is terminal.
- `recovery`: present only when the run was left open by a hard process exit; the value is `"interrupted"` (see [Persistence and recovery](#persistence-and-recovery)).

If `runId` does not exist in the current session's ledger, the response fails with `run_not_found`.

#### run.cancel

Request cancellation of a run. `run.cancel` sets cancellation intent and routes through the existing abort path (`session.abort()`); it does not itself terminate the run. The run becomes `cancelled` only after the agent has fully settled and the session has finished persisting; the `run.cancelled` terminal event is the authoritative signal that the caller may release resources.

Request:
```json
{"type": "run.cancel", "runId": "run_abc123"}
```

Response (returns the current status at the time of the request):
```json
{
  "type": "response",
  "command": "run.cancel",
  "success": true,
  "data": {
    "runId": "run_abc123",
    "status": "running"
  }
}
```

- If the run is already terminal, `run.cancel` is idempotent and returns the current (terminal) status; it never produces a second terminal event.
- Failures: `run_not_found`, and `run_not_cancellable` when the run is not in a cancellable state.

#### run.resume

Restore a persisted session, validate a source run, and start the next attempt of that run with new input. `run.resume` uses the existing session-switch path. It restores the *session*, not the *run*: model network requests, streams, and tool processes cannot be reliably resumed across processes.

Request:
```json
{
  "type": "run.resume",
  "sessionPath": "/path/to/session.jsonl",
  "sourceRunId": "run_abc123",
  "message": "Continue, this time fixing the failing tests",
  "modelRole": "worker"
}
```

Success response mirrors `run.start` — a new accepted run whose `attempt` is the source run's `attempt + 1`:
```json
{
  "type": "response",
  "command": "run.resume",
  "success": true,
  "data": {
    "runId": "run_def456",
    "sessionId": "abc123",
    "attempt": 2,
    "status": "accepted"
  }
}
```

`run.resume` accepts the same optional `external` reference and `deadlineAt`.
The deadline participates in idempotency and is persisted on the successor
attempt. The external reference is persisted as the successor attempt's
mapping; omitting it does not create a new mapping.

Failures:
- `session_busy` when the current session already has an active run
- `session_not_persistent` when the session has no `sessionFile` (in-memory only); the host does not fabricate a resumability promise
- `source_run_not_found` when `sourceRunId` is not in the restored session's ledger
- `source_run_not_resumable` when the source run cannot be the basis for a new attempt
- `session_switch_cancelled` when a session-switch extension cancelled the switch
- `start_rejected` when the new run input is rejected (including the v1 slash-command rule)
- `ledger_persistence_failed` when the new attempt's accepted or started fact cannot be appended
- `audit_persistence_failed` when the successor's optional external mapping cannot be durably appended
- `run_deadline_invalid` or `run_deadline_exceeded` when the requested deadline is malformed or already expired

### Audit query, replay, and external mapping

These commands require a successful `initialize`. `audit.query` and
`audit.replay` are read-only: they only fold safe audit summaries from the
current Session or the current configured Session directory. They do not run a
model, tool, Bash command, MCP or Extension operation, policy approval, or
Sandbox action, and they never append a Session entry.

#### audit.query

The request uses the flattened `AuditQuery` shape:

```json
{
  "type": "audit.query",
  "scope": "session-directory",
  "runId": "run_abc123",
  "types": ["run.accepted", "run.completed"],
  "from": "2026-08-10T12:00:00.000Z",
  "to": "2026-08-10T13:00:00.000Z",
  "limit": 50
}
```

`scope` is `current-session` or `session-directory`. The latter is restricted
to regular files below the server-configured Session root; callers cannot
provide a path or alternate root. Filters are exact matches. `from` is
inclusive and `to` is exclusive. `limit` defaults to `50` and is restricted to
`1..200`. `types` is deduplicated and canonicalized before cursor binding.

The response contains `schemaVersion: 1`, safe `events`, optional `nextCursor`,
and safe `warnings`. A cursor is opaque, integrity-protected, and bound to the
complete query (scope, filters, time bounds, and limit); changing any filter or
using a malformed cursor returns `audit_cursor_invalid`.

#### audit.replay

`audit.replay` uses `runId` plus the same scope, filters, cursor, and limit
rules. It returns one safe Run summary, an event page, warnings, and one of:

- `complete`: a terminal fact exists and relevant sources are safely and
  unambiguously readable;
- `interrupted`: an accepted/started Run has no terminal fact;
- `incomplete`: a relevant source is malformed, unavailable, contradictory, or
  ambiguous.

Missing runs return `audit_run_not_found`. A safe partial replay returns
`status: "incomplete"` rather than exposing source errors or failing closed
with a raw exception. Warning codes are stable (`unknown_source`,
`malformed_source`, `unsupported_schema`, `orphan_source`, `duplicate_source`,
`source_unavailable`, `ambiguous_run_association`, and `mapping_conflict`);
warnings contain only safe identifiers and never raw custom-entry data.

#### external.map

`external.map` appends a validated mapping for the current Session:

```json
{
  "type": "external.map",
  "external": {
    "namespace": "ci",
    "externalSessionId": "job-123",
    "externalRunId": "attempt-1"
  },
  "aosSessionId": "abc123",
  "aosRunId": "run_abc123",
  "source": "ci",
  "correlationId": "trace-1"
}
```

Identifiers are bounded safe identifiers, not URLs, paths, commands, or
payload containers. Repeating the same mapping is idempotent. Mapping either
the same external execution or the same AOS execution to a different target
returns `external_mapping_conflict`; the append-only history is never rewritten
and contradictory historical entries produce a `mapping_conflict` warning.
If persistence cannot be confirmed, the command returns
`audit_persistence_failed` and no success acknowledgement.

All audit and mapping responses are redacted public types. They omit prompts,
messages, final text, custom-entry `data`, raw source bodies, paths, URLs,
commands, environment/header values, credentials, provider errors, stacks, and
other free-form diagnostics. Public error messages are generic; clients should
branch on stable `error.code`, not message text.

### Structured errors

Automation Host commands replace the legacy string `error` field with a structured error object. Every new-command failure carries:

```json
{
  "code": "...",
  "message": "...",
  "retryable": false
}
```

Error codes:

| Code | Meaning | Retryable |
|------|---------|-----------|
| `unsupported_protocol_version` | `initialize` received a `protocolVersion` other than 1 | no |
| `host_not_initialized` | A `run.*` command was sent before a successful `initialize` | no |
| `session_busy` | A run is already active in the session; only one run per session at a time | yes |
| `start_rejected` | Host preflight rejected the run input (v1 rejects inputs beginning with `/`) | no |
| `run_not_found` | The given `runId` does not exist in the current session's ledger | no |
| `run_not_cancellable` | The run is not in a cancellable state | no |
| `session_not_persistent` | The session has no `sessionFile`; it cannot be resumed | no |
| `source_run_not_found` | The `sourceRunId` is not in the restored session's ledger | no |
| `source_run_not_resumable` | The source run cannot be the basis for a new attempt | no |
| `session_switch_cancelled` | A session-switch extension cancelled the switch during `run.resume` | no |
| `ledger_persistence_failed` | The run ledger could not be appended to the session | no |
| `audit_query_invalid` | The audit query or filter shape is invalid | no |
| `audit_cursor_invalid` | The cursor is malformed or bound to a different query | no |
| `audit_scope_unavailable` | The requested Session audit scope cannot be read safely | no |
| `audit_run_not_found` | The requested Run has no accepted audit fact in scope | no |
| `audit_replay_incomplete` | No safe replay result could be constructed | no |
| `external_mapping_invalid` | External mapping identifiers or metadata are invalid | no |
| `external_mapping_conflict` | Mapping history already binds a key to another target | no |
| `audit_persistence_failed` | The external mapping could not be durably appended | no |
| `model_error` | Terminal-only: a `run.failed` receipt reports a model or Agent execution failure | no |

`retryable` tells the caller whether re-issuing the same command later may succeed. `model_error` is carried by a terminal `run.failed` receipt, not returned as a command failure. Legacy RPC commands keep the existing string `error` field, so old clients' error handling is unchanged.

### Run events and ordering

While a run is active, the host wraps session events into run events. Run events carry `runId`, `sessionId`, a per-run monotonic `sequence` that starts at 1, and an ISO `timestamp`.

| Type | Description |
|------|-------------|
| `run.started` | The accepted run has begun executing |
| `run.event` | A wrapped session event, preserving the original event type and value |
| `run.completed` | Terminal: the run completed successfully |
| `run.failed` | Terminal: the run failed |
| `run.cancelled` | Terminal: the run was cancelled |

```json
{
  "type": "run.event",
  "runId": "run_abc123",
  "sessionId": "abc123",
  "sequence": 3,
  "timestamp": "2026-08-10T12:00:05.000Z",
  "event": {
    "type": "message_update",
    "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "Refactored"}
  }
}
```

Ordering contract. For every accepted `run.start` or `run.resume`, records are emitted in this exact order:

1. The `run.start` / `run.resume` success response (`status: "accepted"`)
2. `run.started`
3. `run.event`* — zero or more wrapped session events
4. Exactly one terminal event: `run.completed`, `run.failed`, or `run.cancelled`

Session events that occur between acceptance and the `run.started` emission (for example during asynchronous preflight) are buffered and replayed after `run.started`, so no run event can precede the `run.start` success response or `run.started`. A preflight rejection emits none of the above: only the `run.start` failure response.

Complete successful exchange:

```json
{"id": "init-1", "type": "initialize", "protocolVersion": 1}
{"id": "init-1", "type": "response", "command": "initialize", "success": true, "data": {"host": "automation-host", "protocolVersion": 1, "sessionId": "abc123", "sessionFile": "/path/to/session.jsonl", "runCommands": ["run.start", "run.get", "run.cancel", "run.resume"]}}
{"id": "run-1", "type": "run.start", "message": "Hello!"}
{"id": "run-1", "type": "response", "command": "run.start", "success": true, "data": {"runId": "run_abc123", "sessionId": "abc123", "attempt": 1, "status": "accepted"}}
{"type": "run.started", "runId": "run_abc123", "sessionId": "abc123", "sequence": 1, "timestamp": "2026-08-10T12:00:00.000Z"}
{"type": "run.event", "runId": "run_abc123", "sessionId": "abc123", "sequence": 2, "timestamp": "2026-08-10T12:00:01.000Z", "event": {"type": "message_start", "message": {"role": "assistant", "content": []}}}
{"type": "run.event", "runId": "run_abc123", "sessionId": "abc123", "sequence": 3, "timestamp": "2026-08-10T12:00:02.000Z", "event": {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "Hello"}}}
{"type": "run.event", "runId": "run_abc123", "sessionId": "abc123", "sequence": 4, "timestamp": "2026-08-10T12:00:03.000Z", "event": {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "Hello! How can I help?"}]}}}
{"type": "run.completed", "runId": "run_abc123", "sessionId": "abc123", "sequence": 5, "timestamp": "2026-08-10T12:00:04.000Z", "receipt": {"runId": "run_abc123", "sessionId": "abc123", "status": "completed", "finalText": "Hello! How can I help?", "usage": {"input": 100, "output": 50, "total": 150}, "sessionFile": "/path/to/session.jsonl"}}
```

### Unique terminal events and receipts

Each run produces exactly one terminal event and exactly one receipt. The terminal event is the live delivery of the receipt: the host persists the receipt in the run's ledger record and emits the terminal event carrying it. There is no separate `run.receipt` record. A repeated `run.cancel`, a late tool update, or a second settled signal cannot produce a second terminal event or a second receipt.

Terminal status is determined in a fixed order:

1. If cancellation was requested, the run is `cancelled`;
2. otherwise, if the final agent result was an error or produced no usable completion, the run is `failed`;
3. otherwise, the run is `completed`.

The receipt's `finalText` is the final assistant text observed during *this run*; it is never reused from the whole session's last message, which could belong to a previous run.

Receipt shape (`RunReceipt`):
- `runId`, `sessionId`: run identity
- `status`: `"completed"`, `"failed"`, or `"cancelled"`
- `finalText`: final assistant text of the run (optional)
- `usage`: the run's token usage, computed as the non-negative difference in session token statistics between run start and terminal; it includes retries and compaction consumed by the run
- `sessionFile`: the persisted session path (optional, present when the session is persistent)
- `terminalError`: present when the run failed; a stable `code` plus human-readable `message`

`run.failed` terminal:
```json
{
  "type": "run.failed",
  "runId": "run_abc123",
  "sessionId": "abc123",
  "sequence": 4,
  "timestamp": "2026-08-10T12:00:04.000Z",
  "receipt": {
    "runId": "run_abc123",
    "sessionId": "abc123",
    "status": "failed",
    "usage": {"input": 800, "output": 200, "total": 1000},
    "terminalError": {"code": "model_error", "message": "529 overloaded_error: Overloaded", "retryable": false}
  }
}
```

### Cancellation semantics

- `run.cancel` is a cancellation *request*. It sets cancellation intent and invokes the existing abort path; it does not end the run itself.
- The run becomes `cancelled` only after the agent settles and the session finishes persisting. The `run.cancelled` terminal event is the signal that resources can be released.
- Repeated `run.cancel` calls are idempotent: they return the current state and never produce a second terminal event.

```json
{"type": "run.cancel", "runId": "run_abc123"}
```

```json
{
  "type": "run.cancelled",
  "runId": "run_abc123",
  "sessionId": "abc123",
  "sequence": 6,
  "timestamp": "2026-08-10T12:00:06.000Z",
  "receipt": {
    "runId": "run_abc123",
    "sessionId": "abc123",
    "status": "cancelled",
    "usage": {"input": 500, "output": 120, "total": 620},
    "sessionFile": "/path/to/session.jsonl"
  }
}
```

### One active run per session

A session runs at most one active run at a time. A second `run.start` or `run.resume` while a run is active fails with `session_busy`, which is marked `retryable`: the caller should wait for the active run's terminal event and then retry. v1 does not queue or preempt; there is no implicit scheduling.

### Persistence and recovery

Run records are persisted as custom entries in the session's append-only JSONL with `customType: "automation.run"`, using the existing custom-entry API. Custom entries participate in the session tree but never enter the model context.

Ledger entry kinds (`schemaVersion: 1`):

| Kind | Payload |
|------|---------|
| `accepted` | The accepted `RunRecord` |
| `started` | The run began executing (`runId` and `startedAt`) |
| `terminal` | The terminal `RunReceipt` and `endedAt` |

On session load (including after a process restart), the host scans `getEntries()` for `automation.run` custom entries and folds them, in file order, into a per-session run index. A malformed or unknown-version ledger entry does not prevent host startup: the entry is skipped and a diagnostic is written to stderr. `run.get` serves from this index, so a terminal run remains queryable in a fresh host process.

If a process is killed before a terminal receipt is written, the ledger may hold only `accepted`/`running` records. The host never fabricates a `cancelled` or `completed` state. On the next open, `run.get` returns the original record with `recovery: "interrupted"`. `interrupted` is a read-time recovery marker, not a new persisted terminal state.

`run.resume` may use either a terminal run or a run marked `interrupted` as its source, and creates a new attempt (`attempt + 1`) referencing the source run id. A session without a `sessionFile` (in-memory only) can still run, but `run.resume` fails with `session_not_persistent`.

On a handled termination signal, the host stops accepting new runs, attempts the existing abort path, and waits for the session to settle. If the process is force-killed or exceeds the graceful exit window, the last successfully written ledger state is authoritative; clients must not expect live terminal events during process termination.

Transport clients must treat a disconnected request as having an unknown
delivery state. The TCP `RpcClient` rejects pending requests and does not
automatically reconnect or resend them. After an explicit reconnect, the new
connection receives no stale live run events from the old connection; use
`run.get` and `audit.replay` to reconcile a run before issuing a new side
effect. `RpcClient.reconnectRun()` performs that read-only durable recovery
sequence, maintaining independent live-event sequence and audit-cursor
checkpoints; it never resends `run.start` or `run.resume`.

### Legacy RPC compatibility

- Before `initialize`, behavior is unchanged: `prompt`, bare session events, string errors, and the extension UI sub-protocol all work exactly as documented above.
- After `initialize`, the read-only commands `get_state`, `get_session_stats`, `get_context`, `get_entries`, `get_tree`, and `get_messages` remain available.
- Terminal run receipts may include additive `contextSnapshotId` linking the run to a Context Engine snapshot (see [Context Engine](context.md)).
- After `initialize`, legacy commands that would change the current session, model, or run state (for example `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `switch_session`, `set_model`, `bash`, `fork`, `clone`) are rejected with an explicit error, so a run and a legacy command cannot compete for session ownership. The only state-changing commands still accepted are `run.cancel` and `run.resume`.
- While a run is active, session events claimed by that run are emitted only as `run.event`; they are never duplicated as bare session events.
- Clients that never `initialize` always see the bare session events, as before.
- Extension UI requests/responses continue to use the existing sub-protocol and are not disguised as run events.

### stdout and stderr

In stdio mode, stdout contains only JSONL protocol records. In TCP mode, JSONL
records are written to the accepted loopback socket; stdout is not a protocol
channel. In both modes, diagnostics — startup and connection ownership
messages, listener errors, frame-limit failures, corrupted-ledger warnings,
disconnect-cancellation failures, and debug output — go to stderr only. Never
merge stderr into the protocol stream.

TCP startup and connection diagnostics are intentionally human-readable, for
example `RPC TCP listening on tcp://127.0.0.1:4123`,
`[rpc] connection 1 accepted`, and
`[rpc] rpc_transport_frame_too_large: ...`; they are not JSONL records and are
not part of the public RPC contract. A TCP client must read protocol records
from its socket, not from the host process's stdout or stderr.

### Run record

```json
{
  "id": "run_abc123",
  "sessionId": "abc123",
  "sourceRunId": "run_xyz789",
  "attempt": 2,
  "status": "running",
  "model": {"provider": "anthropic", "id": "claude-sonnet-4-20250514", "thinkingLevel": "medium"},
  "startedAt": "2026-08-10T12:00:00.000Z"
}
```

- `id`: durable Run ID, unique within the session ledger
- `sessionId`: the session the run executes in
- `sourceRunId`: present for runs created by `run.resume`; references the source run
- `attempt`: 1 for a fresh run, incremented by `run.resume`
- `status`: `"accepted"`, `"running"`, `"completed"`, `"failed"`, or `"cancelled"`. Only `completed`, `failed`, and `cancelled` are terminal; terminal statuses cannot transition
- `model`: snapshot of the model used, as `{ provider, id, thinkingLevel }`
- `deadlineAt`: optional canonical UTC deadline shared by the Run and its downstream operations
- `bindingAssociation`: optional public-safe stable handles that associate the Run with ModelBroker, Capability, Policy, and Sandbox facts
- `startedAt` / `endedAt`: ISO timestamps, set as the run starts and terminates
- `terminalError`: structured error retained when the terminal receipt records a failure

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types
- [`src/core/run-lifecycle.ts`](../src/core/run-lifecycle.ts) - Automation Host run types, run record/receipt/stream event types, structured error type

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` is optional and reports nested LLM work performed by the tool. When present, it contributes to session token and cost totals.

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["aos", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: RpcClient TCP Client (TypeScript)

Start the loopback listener in one terminal:

```bash
aos --mode rpc --rpc-listen tcp://127.0.0.1:4123
```

Run this client from a project that depends on `aos-agent` (for example with
`npx tsx rpc-client-tcp.ts`):

```ts
import { RpcClient } from "aos-agent";

async function main(): Promise<void> {
  const client = new RpcClient({
    transport: {
      type: "tcp",
      host: "127.0.0.1",
      port: 4123,
    },
  });

  let finishRun!: () => void;
  const terminal = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const unsubscribe = client.onRunEvent((event) => {
    if (event.type === "run.event" && event.event.type === "message_update") {
      const delta = event.event.assistantMessageEvent;
      if (delta.type === "text_delta") process.stdout.write(delta.delta);
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      finishRun();
    }
  });

  try {
    await client.start();
    await client.initializeAutomationHost();
    const accepted = await client.startRun("Say exactly: hello");
    console.error(`Run ${accepted.runId} accepted`);
    await terminal;
  } finally {
    unsubscribe();
    await client.close();
  }
}

await main();
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("aos", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
