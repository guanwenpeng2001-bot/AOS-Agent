# Context Engine

Context Engine is the coding-agent Runtime layer that decides which instructions, session content, skills index, explicit memory, and extension contributions enter a model call — and records a **metadata-only** receipt for that decision.

It does **not** replace SessionManager message trees, compaction summarization, or the Agent loop. It unifies trust, budget, and audit.

## Concepts

| Term | Meaning |
| --- | --- |
| **Source** | A labeled input (system, instruction, capability index, session summary/message, memory, extension) with scope, trust, and content digest |
| **Plan** | In-memory result of packing sources against the input budget (includes model-facing messages/system prompt) |
| **Snapshot** | Frozen, immutable receipt stored as a Session custom entry `context.snapshot` |
| **Digest** | SHA-256 of source content; used for drift detection without storing bodies |
| **Drift** | Comparison of a historical snapshot to current sources: `unchanged`, `source_changed`, `source_unavailable` |

Snapshots **never** store project rules, session transcript, tool output, memory text, or credentials.

## Trust and project instructions

| Trust | Default behavior |
| --- | --- |
| `builtin` / `user_owned` | Eligible for model injection |
| `trusted_project` | Injectable as instructions |
| `untrusted_project` | Visible in `/context` / `get_context` as `excluded` / `untrusted`; **not** injected into the system prompt |

This is intentional hardening: unknown project files must not become silent system instructions.

## Budget

```text
inputLimit = model.contextWindow - reserveTokens
```

`reserveTokens` defaults from `settings.context.reserveTokens` (fallback: compaction reserve, typically 16384).

- Required sources that do not fit fail **before** the model call with `context_budget_exceeded`.
- Optional sources (memory, capability index) may be excluded with reason `budget_exhausted`.
- Project instruction bodies are never silently truncated.
- The actual provider tool schemas are budgeted as required sources; the capability index remains optional.

## Extensions

`before_agent_start` is the supported way to add dynamic context. An extension returns one labeled contribution:

```ts
{
  contribution: {
    sourceId: "extension:review-mode",
    label: "Review mode instructions",
    visibility: "model_and_snapshot",
    systemPromptAppend: "Review changes before proposing edits.",
    messages: [{ role: "user", content: "Review the current diff.", timestamp: Date.now() }]
  }
}
```

`model_and_snapshot` sends the contribution to the model and records only its receipt. `snapshot_only` records its receipt without sending its body to the model. `sourceId`, `label`, and `visibility` are required; unlabeled `message` and `systemPrompt` returns are rejected while Context Engine is enabled.

Context Engine also rejects `context` mutations and `before_provider_request` payload hooks because their final model input cannot be proven from a plan. Set `context.enabled: false` only for a legacy extension that requires those hooks.

## Memory (explicit only)

| Scope | Default | Storage |
| --- | --- | --- |
| Session | off | Session custom entry `context.memory` |
| Project | off | User-private JSONL under the agent dir, keyed by hashed canonical project root |

Settings:

```json
{
  "memory": {
    "sessionEnabled": false,
    "projectEnabled": false
  }
}
```

Rules:

- No automatic extraction from chat, tools, models, or project files.
- Writes require an explicit user command or SDK call (`/memory add` / `AgentSession.addContextMemory`).
- `/memory revoke <id>` finds the active entry across both scopes, writes a tombstone, and prevents later injection.
- Snapshots record memory id + digest only.

## Interactive commands

```text
/context                 Preview current plan receipt (not persisted)
/context <snapshot-id>   Show historical snapshot + drift vs current sources
/memory list [scope]     List active memory metadata (no full body dump)
/memory add <scope> ...  Explicit write; scope is session or project
/memory revoke <id>
```

## RPC

Read-only command (does **not** require Automation Host `initialize`):

```json
{"id":"c1","type":"get_context"}
{"id":"c2","type":"get_context","snapshotId":"..."}
```

Response data:

```json
{
  "snapshot": { "schemaVersion": 1, "id": "...", "sources": [], "budget": {} },
  "drift": [],
  "preview": true
}
```

`RpcClient.getContext(snapshotId?)` wraps the same command.

Automation Host terminal receipts may include additive `contextSnapshotId` linking a run to its frozen snapshot.

## Compaction / branch summary

Compaction and branch summary create snapshots with `purpose: "compaction"` or `"branch_summary"` and record `contextSnapshotId` (and budget metadata) on entry details. Summary text formats and retained-tail behavior are unchanged.

## Errors

Structured codes include:

- `context_budget_exceeded`
- `context_snapshot_persistence_failed`
- `context_snapshot_not_found`
- `context_memory_disabled`
- `context_memory_not_found`
- `context_memory_write_requires_explicit_action`
- `context_extension_source_missing`

Call-before-model failures do not start the Agent loop. If a run was already accepted by Automation Host, the host ends with `run.failed` and a stable error code where applicable.

## Out of scope (v1)

Vector RAG, automatic long-term memory, cross-project memory, external agent adapters, MCP lifecycle changes, model routing, and OS sandbox changes.
