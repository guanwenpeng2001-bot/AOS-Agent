# Architecture Atlas: Foundation v1

Foundation v1 closes Atlas rows 01–10 and 10A. Delivery status is a sealed
candidate on the integration branch; merging into `main` still requires user
confirmation. Line 11 is the next implementation line. Lines 12A, 12B, 13, 14,
and 15 remain future work.

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
| 09 | Role, model profile, binding, provider, transport, and execution boundaries | Foundation v1 sealed |
| 10 | SDK/RPC/local-surface parity and contract conformance | Foundation v1 sealed |
| 10A | Capability ledger, control APIs, evaluation, and future-owner accounting | Foundation v1 sealed |

The seal closes Foundation contracts and their local runtime behavior. It does
not claim that a future Operation Worker, child-agent provider, distributed
scheduler, remote integration, or product UI has been implemented.

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

Line 11 may implement the Sandbox Operation Worker by consuming the sealed
worker, credential, fencing, policy, audit, and receipt contracts. Lines
12A–15 may implement only the consumers assigned by the future-owner map. They
must not create new Foundation state authorities or redefine the sealed
relations above.
