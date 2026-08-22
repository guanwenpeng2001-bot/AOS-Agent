# Native Subagent Runtime Contract (Line 12A)

Line 12A implements native child agents for one Host and one Session. A child
agent is a distinct Task, Dispatch, Attempt, `AgentInstance`, Binding, Context,
and mailbox identity. It is not an Operation Worker, a mode switch, a
scheduler node, or a second Run terminal authority.

## Execution and authority

The trusted Host path is:

```text
parent Attempt
  -> persist child TaskEnvelope
  -> prove child Binding is no broader than the parent Binding
  -> create child Context snapshot
  -> executeAgentSpawnV1 -> ChildAgentProvider
  -> child AgentHarness -> AttemptReceiptV1
  -> SafeChildResultProjectionV1 -> parent Context
  -> Host settleTaskResult -> Host finalizeRunReceipt
```

Spawn creates a new `AgentInstance`; mode switch only creates a new Binding
epoch for the same Attempt and identity. A child can produce an
`AttemptReceiptV1` with `producerKind: "agent_executor"`, but it cannot settle
a `TaskResultV1` or write a `RunReceiptV1`. The Host terminal gate remains the
only Run terminal writer.

## Providers and registration

The immutable registry recognizes five provider kinds:

| Provider kind | Line 12A status |
| --- | --- |
| `in_process` | implemented; independent child lane, Context, Binding, model gateway, and tool gateway in the Host process |
| `fork` | implemented; trusted local child process over a private bounded JSONL protocol |
| `agent_runtime_host` | registration contract and consumer-shaped fake conformance only; unavailable at runtime |
| `acp` | registration contract and consumer-shaped fake conformance only; unavailable at runtime |
| `sdk` | registration contract and consumer-shaped fake conformance only; unavailable at runtime |

Only trusted Host composition registers provider instances. Prompts, project
configuration, RPC payloads, models, and extensions cannot select an
executable, module path, or provider implementation. Registry resolution of a
descriptor with `implementedInThisLine: false` fails closed with
`subagent_provider_unavailable`. The fake conformance drives the frozen
`ChildAgentProvider` contract through the public Foundation spawn entry; it is
not a production implementation.

## Binding and Context isolation

Child resources are projected from the parent and may only remain equal or
become stricter. The proof covers instructions, Skills, MCP, model, Sandbox,
Git, and Budget. Selectors use `selectorsNarrow`; budgets use minimum limits;
managed locks cannot be removed; Policy and Capability revisions require a
Host proof before a revision change is accepted. Any widening fails with
`subagent_binding_projection_invalid` before spawn.

Context forks are new digest-bound snapshots, never shared mutable parent
state:

| Scope | Child input |
| --- | --- |
| `none` | child Role and Task projection only |
| `all` | bounded complete parent snapshot |
| `recent_n` | system layer plus the requested recent turns |
| `task_package` | bounded goal, criteria, artifact references, and safe summaries |

Credentials, MCP material, raw environment data, and unapproved parent
resources never cross the fork boundary. Child memory uses a distinct scope
and provenance record.

## Lifecycle, mailbox, and recovery

The supervised lifecycle is:

```text
spawning -> running -> awaiting_input | background | cancelling
         -> succeeded | failed | cancelled | lost -> closed
```

Depth, concurrency, and maximum-turn limits are enforced before or during
execution with bounded queue-or-fail behavior. Cancellation is idempotent.
An unconfirmed effect, broken fork channel, malformed receipt, or unknown
cleanup state is never reported as safe success and is not automatically
retried.

Mailbox `send`, acknowledgement, `wait_any`, `wait_all`, and query operations
are bounded durable facts within the current Session. A wait timeout does not
cancel a child. Cross-Session messaging, queue ownership, claim, handoff, and
DAG scheduling remain Line 12B work.

Resume rebuilds from the durable child transcript and Context boundary. It
does not revive an old process or provider handle. Optional worktree apply is
fail-closed; an apply conflict or unknown cleanup result cannot overwrite the
parent workspace and leaves the target quarantined.

Worktree isolation is production-reachable only through explicit trusted Host
configuration. Capability negotiation advertises it only for the configured
`in_process` provider; `fork` fails a worktree requirement closed. The Host
creates the owned worktree before child execution and passes its raw path only
as process-local `executionWorkspace` input to the child Harness. Durable Task,
receipt, lifecycle, and worktree records contain no ephemeral path. Apply runs
only after a successful terminal AttemptReceipt; close deletes the owned
worktree or quarantines it when cleanup cannot be proven.

## Single-Host composition

Trusted composition runs real child plans in `parallel` or `chain` mode inside
one Host and Session. Parallel joins use explicit `all_succeed`, `quorum`, or
`partial` policy. A chain starts from a root plan; every later step accepts
only the prior `SafeChildResultProjectionV1` or a plan whose Context scope is
`task_package`. A failed child stops the chain before the next plan is created.

Each child AttemptReceipt stays in its child lane. The Host parent-lane
`LayeredResultSettlementV1` writes the joined TaskResult once from unique
accepted receipts. Per-child `result_ref` messages are consumed at the next
parent turn through the safe result projection boundary. Composition closes
every provider handle, mailbox endpoint, and configured worktree after the
join; it never finalizes a child RunReceipt. An optional fixed trusted product
policy makes parallel or chain composition reachable through Product Prompt
Ingress without reading mode or join policy from prompt, model, RPC, or project
text. Prompt Task Adapter remains the only parent finalizer, and its unique
RunReceipt joins the parent AttemptReceipt with exactly the unique child
AttemptReceipts selected by the Host join.

## Result and public projections

Raw child output never enters the parent Context. The only ingress is a
digest-validated, size-bounded projection with the fixed
`untrusted_child_output` trust marker. Invalid shapes, artifact digests, or
summaries fail with `subagent_result_untrusted`.

Audit and RPC expose allowlisted lifecycle projections only. They omit process
IDs, executable/arguments, cwd, environment, transcript and prompt text,
tokens, secrets, headers, provider stacks, and raw protocol frames. RPC
advertises optional `subagent.get`, `subagent.list`, and `subagent.cancel`
commands only when trusted Host composition supplies the Run-owned subagent
registry; there is no public spawn, resume, mailbox, provider-registration, or
raw-receipt command.

## Capability ownership

The machine-readable ledger is
`packages/agent/src/harness/line12a-subagent-capabilities.ts`.

- Implemented: `90-97`, `99-118` (28 capabilities).
- Consumed by direct reference to sealed Foundation closures:
  `2`, `6`, `8`, `9`, `17-20`, `26`, `29-34`, `98` (16 capabilities).
- Deferred to 12B: `119-126`, `130`, `131`.
- Deferred to 13: `132`, `133`, `138`.
- Deferred to 14: `134`, `137`, `139`, `141-144`, `149`, `150`.
- Deferred to 15: `147`, `148`.
- Capability `140` remains on the Line 11 extension track and is excluded.

The Line 12A ledger does not change the sealed Foundation manifest or Line 11
closure semantics.
