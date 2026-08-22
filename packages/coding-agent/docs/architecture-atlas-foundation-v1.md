# Architecture Atlas: Foundation v1

Foundation v1 closes Atlas rows 01–10 and 10A. Delivery status is a sealed
integration candidate whose promotion requires exact-range external review and
protected-branch CI. The user authorized that promotion workflow. Line 11 and
Line 12A now have separate machine-checked implementation ledgers. Lines 12B,
13, 14, and 15 remain later work.

## Sealed rows

| Row | Foundation boundary | Status |
| --- | --- | --- |
| 01 | Agent loop, turn/step lifecycle, streaming, cancellation, deadlines, and queue behavior | Foundation v1 sealed |
| 02 | Task/Attempt identity, context, model, policy, tools, structured results, and receipts | Foundation v1 sealed |
| 03 | Durable events, observers, cursors, replay, and gap detection | Foundation v1 sealed |
| 04 | Retry, cancellation, deadline, failure, and recovery semantics | Foundation v1 sealed |
| 05 | Tool Gateway and the prepare/pre/guard/execute/post/finalize pipeline | Foundation v1 sealed |
| 06 | Session JSONL, migration, reducer replay, fencing, and single-writer ordering | Foundation v1 sealed |
| 07 | Plugins, MCP selection, runtime services, and extension lifecycle | Foundation v1 sealed |
| 08 | Goal, Plan, Stage, Todo, Ask, Workflow, gates, and task graph contracts | Foundation v1 sealed |
| 09 | Role, model profile, binding, provider, transport, and execution boundaries | Foundation v1 sealed; Line 12A native consumer implemented |
| 10 | SDK/RPC/local-surface parity and contract conformance | Foundation v1 sealed |
| 10A | Capability ledger, control APIs, evaluation, and future-owner accounting | Foundation v1 sealed |

The Foundation seal closes contracts and their local runtime behavior. Line 11
implements the local Operation Worker consumer. Line 12A implements native
`in_process` and `fork` child-agent providers; it does not claim a distributed
scheduler, remote Runtime Host, ACP/SDK connector, or product UI.

## Canonical relations

```text
RoleDefinition -> immutable RoleRevision
Mode -> a product activation of a RoleRevision
Goal -> Task / TaskGraph
Task + RoleRevision + ModelProfile + Policy
  -> Resolver -> immutable AgentBinding -> Dispatch -> TaskExecutorProvider -> Attempt
Agent-class provider -> AgentInstance
Operation Worker -> WorkerReceipt
Attempt -> AttemptReceipt -> TaskResult -> host-only RunReceipt
Mode switch -> a new BindingEpoch on the same Attempt
Spawn -> a distinct Task and execution lineage
```

An Operation Worker never becomes an `AgentInstance`. A `Run`, `Dispatch`, or
`Attempt` is an execution record, not a task-graph node. The four result layers
are distinct authorities and must not be substituted for one another.

## Product ingress and runtime ownership

All local prompt surfaces use the same path:

```text
TUI / print / headless JSON / RPC / SDK / Automation Host
  -> Prompt Task Adapter
  -> persisted TaskEnvelope
  -> Binding -> Dispatch -> Attempt
  -> AgentHarness
  -> AttemptReceipt -> TaskResult -> RunReceipt
```

`AgentHarness` owns execution state. The Session reducer owns durable state.
Surface adapters expose projections over those owners; they do not maintain a
second transcript, queue, model, tool, or lifecycle authority.

## Capability accounting

The machine-readable ledger is
`packages/agent/src/harness/foundation-v1-capabilities.ts`.

- Closure set: 79 unique ids — `1–73`, `98`, `127–129`, `145–146`.
- Future-owner set: 71 unique ids — `74–97`, `99–126`, `130–144`, `147–150`.
- The sets are disjoint and their union is exactly `1–150`.
- Closure states are truthful front-layer claims: `implemented`,
  `regression_locked`, or `contract_sealed`.
- A `contract_sealed` item freezes a versioned public boundary without claiming
  that its later consumer exists.

The next-owner distribution is line 11: 17 capabilities, 12A: 28, 12B: 10,
13: 3, 14: 11, and 15: 2.

Implemented consumer ledgers do not rewrite the sealed Foundation manifest:

- Line 11 closes `74-87`, `135`, and `136` in
  `packages/agent/src/harness/line11-worker-capabilities.ts`.
- Line 12A closes `90-97` and `99-118` in
  `packages/agent/src/harness/line12a-subagent-capabilities.ts`, and directly
  references the sealed Foundation closures `2`, `6`, `8`, `9`, `17-20`,
  `26`, `29-34`, and `98`.

## Section 09: Line 12A implementation status

Line 12A is implemented for a single Host and Session. Spawn creates a
distinct child Task, Dispatch, Attempt, `AgentInstance`, Binding, Context, and
mailbox identity. Child resources are machine-proven equal or narrower than
the parent; raw child output can enter the parent Context only through the
digest-bound untrusted result projection. A child writes an AttemptReceipt;
Host settlement remains the only TaskResult and RunReceipt authority.

The provider registry freezes five kinds. `in_process` and `fork` are real
Line 12A implementations. `agent_runtime_host`, `acp`, and `sdk` freeze the
registration/capability-negotiation contract and have consumer-shaped fake
conformance only; `implementedInThisLine` remains false and selection fails
closed. Their real implementations remain with Lines 13 and 14.

Trusted Host composition now supplies the production closure for Atlas C108
and C118. An explicitly configured `in_process` child can execute in an owned
ephemeral worktree whose raw path is passed only to its Harness; successful
terminal receipts apply before close, while conflict and unknown state fail
closed into cleanup or quarantine. The exact provider descriptor advertises
worktree support only when this Host adapter exists, and `fork` does not.

The same public composition path runs real parallel and chain plans. Parallel
joins use all-succeed, explicit quorum, or partial policy; chains accept only a
safe prior child projection or `task_package` input and stop on the first
failure. Child AttemptReceipts remain on child lanes, the joined TaskResult is
written once on the parent lane, and per-child result references re-enter the
parent only through next-turn safe projection. A fixed trusted product policy
can route the Prompt Task Adapter through this composition independently of
prompt text. The Adapter remains the sole parent terminal owner: its unique
RunReceipt contains the parent AttemptReceipt plus exactly the child receipts
accepted by the configured join.

### Mainline map

| Line | Status | Capability ownership |
| --- | --- | --- |
| 11 Sandbox Operation Worker | Implemented | `74-87`, `135`, `136`; capability `140` remains on its extension track |
| 12A Native Subagent Runtime / Agent Team | Implemented for `in_process` and `fork`; Runtime Host/ACP/SDK contract-only | `90-97`, `99-118` |
| 12B Task Scheduler / Handoff | Deferred | `119-126`, `130`, `131` |
| 13 External Agent Connector / Tool Gateway | Deferred | `132`, `133`, `138` |
| 14 Integration / Hardening | Deferred | `134`, `137`, `139`, `141-144`, `149`, `150` |
| 15 Product Delivery | Deferred | `147`, `148` |

## Recovery and evaluation evidence

Recovery fails closed for unknown durable schemas and types, preserves
identities and lineage through migration, repairs only a truncated JSONL tail,
and does not repeat an unknown side effect. Context snapshots used for
compaction and branch summaries are persisted by explicit operation identity.

The local workflow evaluation contract accepts a versioned dataset and exact
observations, measures workflow/step quality, cost, and recovery expectations,
and emits a strict versioned result snapshot. Missing, duplicate, malformed, or
extra data is rejected rather than counted as success.

## Future lines

Lines 12B-15 may implement only the consumers assigned by the future-owner
map. Line 12B remains an independent scheduling/handoff line that reads shared
contracts without redefining Line 12A. Later lines must not create new
Foundation state authorities or redefine the sealed relations above.
