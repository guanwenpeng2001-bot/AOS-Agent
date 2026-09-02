# Sessions

AOS Agent saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.aos-agent/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

```bash
aos -c                  # Continue most recent session
aos -r                  # Browse and select from past sessions
aos --no-session        # Ephemeral mode; do not save
aos --name "my task"    # Set session display name at startup
aos --session <path|id> # Use a specific session file or partial session ID
aos --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, message count, tokens, and cost.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

Context Engine freezes **metadata-only** `context.snapshot` custom entries before real model calls. Those entries never enter LLM context via `buildSessionContext`. See [Context Engine](context.md).

## Optional Shared SQLite Ledger

Node integrations can opt into the `aos-agent/sqlite-session` entry point. This
keeps the default CLI on JSONL while allowing a user or small team to put one
Session ledger in a SQLite database on storage that every Host can access.

```ts
import { SqliteSharedSessionLedger } from "aos-agent/sqlite-session";

await using ledger = new SqliteSharedSessionLedger({
  databasePath: "/shared/aos/sessions.sqlite",
  hostId: "build-host-1",
  writerLease: { ttlMs: 30_000, heartbeatIntervalMs: 10_000 },
});

const writer = await ledger.open("session-id");
const follower = await ledger.open("session-id", { access: "follower" });
const replacement = await ledger.open("session-id", { takeOver: true });
const takeovers = await ledger.getWriterTakeoverAudit("session-id");
```

Only a writer may mutate the Session. A follower does not acquire a writer
lease, and every write through it fails. `takeOver: true` is an explicit
ownership transfer: it advances the database fence immediately, so the old
Host's next write fails even if its previous lease has not expired. The local
processing lease remains a separate same-Host guard.

Fence generations remain monotonic across clean Host handoffs and explicit
take-overs. A clean close marks its lease released, so the next writer may open
normally and advances the generation. A crashed Host leaves a positive lease
deadline; after that deadline passes, ordinary `open()` still fails until a new
Host explicitly requests `takeOver: true`. This prevents an availability probe
from becoming automatic failover.

Each explicit take-over commits one immutable database audit row in the same
transaction as the new fence. `getWriterTakeoverAudit()` returns the Session,
old and new non-secret Host ids, old and new fence generations, old deadline,
take-over timestamp, and whether the old lease was active (`forced`) or expired
(`expired`). Configure a stable `hostId` when those records must identify a
deployment Host; otherwise the ledger creates a process-local UUID.

A follower reads the latest state available in its local SQLite view. With one
shared database this normally means committed state. If another system copies
the database to a follower, that projection may lag until the copy is updated;
the copied projection must remain read-only and must never be promoted by
writing both replicas. The filesystem that hosts a shared writable database
must provide coherent SQLite file locks and WAL behavior.

JSONL migration is explicit and refuses to overwrite an existing target:

```ts
await ledger.importJsonl("./session.jsonl");
await ledger.exportJsonl("session-id", "./roundtrip.jsonl");
```

Migration preserves Session ids, tree parent links, lane tips, operation
records, names, labels, and durable Foundation objects. Physical JSONL wrapper
ids, sequence numbers, timestamps, and historical fencing tokens are
backend-local and are reassigned.

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/context [snapshot-id]` | Show Context Engine sources, budget, and drift (metadata only) |
| `/memory ...` | Explicit session/project memory list/add/revoke |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `aos -r` opens the same picker at startup.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, AOS Agent uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
aos --name "Refactor auth module"
aos --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `aos -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, AOS Agent can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
