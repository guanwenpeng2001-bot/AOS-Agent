# External Agent Adapter (v1)

This document freezes the v1 boundary for the External Agent Adapter: how a
trusted Host composition registers an external Agent implementation, how a Run
explicitly selects one, how the target's protocol capabilities are proven
before a Run is accepted, how the frozen AOS Binding is translated into a
minimal safe reference, and how the external execution is mapped, observed,
cancelled, and settled through the existing control plane.

The contract is additive. No model provider, model ID, configuration entry,
URL, package, or prompt selects an Adapter implicitly; a Run that never
selects one keeps the existing AOS Loop / Provider / Runner path unchanged.
The PR introduces no vendor connector (Claude, Codex, ACP, or any other), no
new transport, and no second ledger. Concrete connectors are separate,
individually verified opt-in packages; contract tests use a deterministic
in-memory fake Adapter, never a real target.

The source seam is `src/core/external-agent-adapter.ts` (contract types,
validators, serializers, stable errors, and the in-process host-side driver
`runExternalAgentAdapter`), `src/core/external-agent-registry.ts` (trusted
registry), and the existing fact layers that own the guards and persistence:
`src/core/external-session-mapping.ts` (safe external refs, the append-only
`external.mapping` store, and the adapter identity vocabulary),
`src/core/remote-operation.ts` (operation receipt / lease / artifact /
side-effect guards and the Session ledger sink),
`src/core/execution-audit.ts` / `src/core/execution-audit-query.ts` (Audit
facts), and host wiring in `src/modes/rpc/rpc-host.ts` and
`src/core/run-lifecycle.ts`. There is no separate fact-safety module. An
Adapter is a Worker boundary, not a new Agent Loop, Model Provider, or
scheduler.

## 1. Trusted registration and explicit selection

Adapters are instances, not configurations. The registry accepts only
already-constructed adapter instances supplied by the trusted Host composition
that creates the AgentSession / Automation Host:

```ts
interface ExternalAgentAdapterRegistry {
  register(adapter: ExternalAgentAdapter, options?: {
    displayName?: string;   // safe display name, defaults to adapterId
    version?: string;       // safe descriptor version, defaults to "1"
    targets?: ReadonlyArray<string>; // bounded target ids this adapter can reach
  }): void;
  get(adapterId: string): ExternalAgentAdapter | undefined;
  list(): ReadonlyArray<ExternalAgentAdapterDescriptor>;
  has(adapterId: string): boolean;
  lookupTarget(adapterId: string, targetId: string): ExternalAgentTarget | undefined;
  resolve(selection: ExternalAgentSelection): ExternalAgentResolvedSelection;
}

interface ExternalAgentAdapterDescriptor {
  readonly adapterId: string;
  readonly displayName: string;
  readonly version: string;
}
```

An adapter instance must expose a bounded `id` and the three contract methods
`probe(target, context)`, `prepare(request, snapshot)`, and
`start(request, context)`. Registration never loads from a project file, URL,
command, module path, package name, or target self-report, and it fails closed
with `external_agent_adapter_invalid` on a duplicate `adapterId`, an unsafe
`adapter.id` or descriptor field, an unsafe target id, or an incomplete
adapter instance. `list()` returns only safe descriptors; endpoints,
commands, credentials, and raw probe data are never exposed.

A Run selects a target with two bounded safe identifiers:

```ts
interface ExternalAgentSelection {
  readonly adapterId: string;
  readonly targetId: string;
}
```

`adapterId` and `targetId` carry no endpoint, command, cwd, headers,
credential, or prompt. `resolve(selection)` validates both ids, looks up the
adapter, and confirms the target belongs to that adapter before any probe can
run; an unknown adapter or target fails with `external_agent_target_not_found`.

Selection is separate from the `external` execution reference: selection
chooses which trusted Adapter connects to which target, while the external ref
identifies the external Session / Run the target actually created. A caller
cannot use an external ref as a target selector, and AOS never picks an
Adapter from a model provider name, model ID, or external namespace.

## 2. Probe and capability snapshot

Before any business prompt, tool call, file access, or side effect, the
Adapter probes the target:

```ts
interface ExternalAgentTarget {
  readonly targetId: string;
}

interface ExternalAgentProbeContext {
  readonly signal: AbortSignal;
  readonly deadlineAt?: string; // canonical UTC timestamp
}

interface ExternalAgentCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly targetId: string;
  readonly protocol: { readonly name: string; readonly version: string };
  readonly status: "ready" | "unavailable" | "incompatible";
  readonly capabilities: {
    readonly start: boolean;
    readonly events: "none" | "metadata" | "stream";
    readonly cancel: "cooperative" | "strong" | "none";
    readonly receipt: "terminal" | "none";
    readonly resume: boolean;
    readonly artifacts: boolean;
    readonly toolGateway: boolean;
  };
  readonly reasonCode?: string;
  readonly observedAt: string; // canonical UTC timestamp
}
```

Probe rules:

- Probe performs only protocol handshake, version negotiation, and capability
  query. It never sends a business prompt, file content, model output, or tool
  payload, and it never produces a Run accepted fact, `external.mapping`, or
  Run event. A probe timeout or abort means `unavailable`, never readiness.
- The snapshot contains only the allowlisted protocol / version and capability
  flags. Raw handshake data, headers, URLs, command lines, process IDs,
  tokens, stacks, and target self-reports stay inside the Adapter's
  diagnostics; unknown keys and unverifiable self-reports are rejected, never
  preserved in a public snapshot.
- A snapshot is used for one `prepare` only. v1 does not persist probe
  snapshots as long-term Session capability facts; recovery across restarts
  re-probes.

Minimum capability for a controlled Run (the `ready` gate):

| Capability | Requirement |
| --- | --- |
| `status` | must be `"ready"` |
| `start` | must be `true` |
| `receipt` | must be `"terminal"` |
| `cancel` | must be `"cooperative"` or `"strong"`; `"none"` is unusable for v1 controlled Runs |
| `protocol` | name/version must have a verified translator in the Adapter |
| Binding translation | the current AOS Binding must map to a defined envelope |
| `events` | optional; without events the Run still settles through the receipt |
| `resume` | optional; `false` means `run.resume` must not map to a new external execution |
| `artifacts` | optional; `false` means no `artifactRefs` may be claimed |
| `toolGateway` | optional; `true` requires a separate verified Tool Gateway contract |

A snapshot below the minimum is rejected at Binding translation with
`external_agent_capability_missing`; the Run is not accepted.

## 3. Safe Binding translation

The Adapter receives the Run's public-safe Binding association, not internal
ledger data:

```ts
interface ExternalAgentBindingInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly modelBindingId?: string;
  readonly capabilityBindingId?: string;
  readonly policyBindingId?: string;
  readonly bindingAssociation?: RunBindingAssociation;
  readonly capabilitySummary: ReadonlyArray<string>; // bounded, sorted-safe
  readonly policyProfile?: string;
  readonly sandboxProfile?: string;
}

interface ExternalAgentPrepareRequest extends ExternalAgentBindingInput {
  readonly selection: ExternalAgentSelection;
  readonly deadlineAt?: string;
}
```

`prepare(request, snapshot)` returns the immutable per-execution translation:

```ts
interface ExternalAgentPreparedBinding {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly targetId: string;
  readonly protocol: { readonly name: string; readonly version: string };
  readonly bindingMode: "reference-only" | "tool-gateway";
  readonly bindingFingerprint: string; // sha-256 hex, one-way
  readonly capabilities: {
    readonly start: true;
    readonly cancel: "cooperative" | "strong";
    readonly receipt: "terminal";
    readonly events: "none" | "metadata" | "stream";
    readonly resume: boolean;
    readonly artifacts: boolean;
    readonly toolGateway: boolean;
  };
}
```

Translation rules:

1. Normal AOS Model / Capability / Policy / Sandbox preflight runs before the
   Adapter is called.
2. The prepared binding is immutable, is bound to `runId`, `sessionId`,
   `adapterId`, `targetId`, and protocol version, and cannot be upgraded in
   place. Capability or Policy changes require a new Run attempt / prepared
   binding.
3. The output contains only target-verifiable opaque handles, profiles, and
   capability flags. It never contains a prompt, credential, full environment,
   raw Policy, Sandbox secret, or external headers, and it can never grant a
   capability that is absent from `capabilitySummary`.
4. `bindingFingerprint` is a deterministic SHA-256 digest over the canonical
   selection, protocol, binding identities, profiles, mode, and the sorted
   capability summary. It is a correlation / conflict key, never a reversible
   encoding of Binding content; conflicts and replays can be correlated
   without exposing Binding contents.
5. `bindingMode` is `reference-only` by default. `reference-only` authorizes
   the Adapter as an external execution boundary only; it does not claim that
   target-owned tools, network, filesystem, or processes are covered by an AOS
   Sandbox. `tool-gateway` is produced only when the snapshot proves a
   verified `toolGateway` capability and a separate Tool Gateway contract,
   Policy wiring, and tests exist; v1 ships without one. The v1 host path
   never derives `tool-gateway` from a target self-report: it invokes the
   trusted `adapter.prepare` and rejects any gateway-mode prepared binding
   until the separate contract exists.
6. Malformed contract input maps to `external_agent_adapter_invalid`; a
   snapshot below the controlled-Run minimum maps to
   `external_agent_capability_missing`; a selection that does not match the
   snapshot, or a translation that cannot be produced safely, maps to
   `external_agent_binding_unsupported`. The host calls the trusted
   `adapter.prepare` (never a default translator) before acceptance and
   shape-verifies the returned prepared binding against the prepare request
   and the probed snapshot, so an unknown or untranslatable
   protocol/version fails closed before any Run acceptance.
7. Target-owned model credentials stay with the Adapter composition or the
   target; AOS ModelRuntime credentials are never copied across the boundary.

The Run message is one-shot in-memory input for `start` (bounded, with
metadata-only image references). It never enters the prepared binding,
`external.mapping`, `remote.operation`, Session entries, or Audit summary.

## 4. External mapping and fact safety

Adapter Runs reuse the existing fact sources, never a second ledger:

| Fact | Where it lives | Meaning |
| --- | --- | --- |
| External Session / Run ↔ AOS Session / Run | `external.mapping` | append-only, bijective, restart-recoverable identity relationship |
| Deadline / lease / heartbeat / cancel / artifact / side-effect state | `remote.operation` | one operation receipt per external execution |
| Accepted / started / terminal Run facts | Run ledger + existing Audit | the AOS execution authority |

Start order:

```text
probe ready
  → AOS Binding preflight
  → prepare binding
  → existing Run accepted fact
  → adapter.start with in-memory input
  → validate external ref
  → persist external.mapping
  → publish run.started
  → remote.operation settles (receipt recorded durably)
  → bounded adapter events as run.event records
  → existing Run terminal gate settles
```

Rules:

- Probe or prepare failure means the Run is not accepted and no external
  execution is created. Accepted-persistence failure means the external Agent
  is never started.
- `external.mapping` records identity only; it proves nothing about protocol
  compatibility or execution success. Repeated mappings are idempotent;
  mapping one key to a different target is a conflict; contradictory
  append-only history produces a warning and never rewrites history.
- The mapping must be durably appended before `started` is published. If
  mapping persistence fails, the Host attempts `adapter.cancel` and the Run
  fails closed with `external_agent_persistence_failed` — no success
  acknowledgement and no fallback to local Host execution. A `remote.operation`
  ledger append failure at settlement fails the Run the same way, so an
  unrecorded external outcome is never reported completed or cancelled.
- The external ref returned by `start` is validated against the selection,
  the operation, and the Run before it is persisted; an identity drift or an
  invalid ref fails closed.

The guards live in the existing fact layers, not a separate bridge.
`src/core/external-agent-adapter.ts` owns the exact-shape validators and
serializers for snapshots, prepared bindings, events, and receipts, plus the
host-side driver `runExternalAgentAdapter`, which bounds every emitted event
(one `started` at most, strictly increasing positive `sequence`, consistent
external identity, bounded count), enforces idempotent cancel, and rewrites
unverifiable outcomes into stable failed receipts.
`src/core/external-session-mapping.ts` owns the safe external refs and the
append-only `external.mapping` store (conflict detection, idempotent
repeats, recovery warnings); `src/core/remote-operation.ts` owns the
`remote.operation` receipt guards and the Session ledger sink;
`src/core/execution-audit.ts` / `src/core/execution-audit-query.ts` fold
those facts into Audit events; and the host wiring in `src/modes/rpc/rpc-host.ts`
and `src/core/run-lifecycle.ts` enforces the ordering. Every guard is
exact-shape and allowlisted: unknown keys, raw protocol data, prompt text,
credentials, paths, URLs, and unbounded free text are rejected before they
can reach a Session custom entry, an audit summary, or a Run observation.
Persistence is fail-closed: the mapping is appended durably before
`started` is published and before the Remote Operation starts
(mapping-before-operation ordering), a `remote.operation` receipt is
recorded only after its terminal is formed and the append is acknowledged,
and no append-only mapping is ever overwritten. Rejected mapping entries
produce bounded recovery warnings (`mapping_conflict`, `malformed_mapping`)
through `external-session-mapping.ts` and `run-lifecycle.ts` diagnostics;
malformed, identity-drifted, or out-of-sequence events are dropped by the
driver and counted on the bounded `droppedEvents` handle, never exposed as
raw data.

## 5. Events

External events map to a bounded AOS Run observation surface:

```ts
type ExternalAgentEvent =
  | { readonly type: "started"; readonly external: ExternalExecutionRef; readonly timestamp: string }
  | { readonly type: "progress"; readonly external: ExternalExecutionRef; readonly sequence: number;
      readonly phase?: string; readonly timestamp: string }
  | { readonly type: "artifact"; readonly external: ExternalExecutionRef;
      readonly artifact: RemoteArtifactReference; readonly timestamp: string };
```

- `started` is published only after the Run is accepted and the
  `external.mapping` is verified.
- `progress` keeps only a bounded `phase`, a strictly increasing positive
  `sequence`, and a canonical timestamp. Reverse or duplicate sequences,
  identity drift, unknown event shapes, and unverified timestamps are dropped
  by the driver's bounded collector and counted on the handle's
  `droppedEvents`; they never become Run events and never carry raw data.
- `artifact` carries only a safe `RemoteArtifactReference` (id, kind, digest,
  size, media type) — never bytes, paths, URLs, or callbacks.
- Transcripts, tool calls, stdout/stderr, and diagnostics never enter Session
  context, Audit, or public RPC.
- A progress event is never a terminal and cannot change Run status. Only a
  validated receipt or the existing recovery rules settle a Run.

## 6. Remote Operation boundary

Each external execution is one Remote Operation. The Adapter boundary reuses
`operationId`, `deadlineAt`, the optional lease (`heartbeat()`), idempotent
`cancel`, safe artifact references, and the `side-effect-unknown` fail-closed
rule from the [Remote-Neutral Operation Contract](remote-operation-contract.md):

- The optional lease `{ leaseId, expiresAt }` is refreshed through
  `handle.heartbeat()`; heartbeats after cancellation or terminal completion
  are rejected, and lease expiry is treated as a deadline.
- Cancel is idempotent and observes the same `AbortSignal` as the execution
  context. If cancellation cannot prove that no side effect occurred, the
  result is never reported as cancelled; it fails closed as
  `side-effect-unknown`.
- Unknown provider exceptions are mapped to stable adapter errors; raw
  exceptions, payloads, paths, URLs, credentials, and transport detail never
  cross the boundary.
- The validated terminal receipt is stored as exactly one `remote.operation`
  custom entry through the existing Session ledger sink — an Audit projection
  of the provider boundary result, not a second Run ledger.

## 7. Receipt, cancel, deadline, and resume

### Receipt and the Run terminal gate

```ts
interface ExternalAgentReceipt {
  readonly schemaVersion: 1;
  readonly external: ExternalExecutionRef;
  readonly status: "completed" | "failed" | "cancelled";
  readonly endedAt: string;
  readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
  readonly sideEffects: "none" | "associated" | "unknown";
  readonly error?: { readonly code: string; readonly retryable: boolean;
    readonly sideEffects: "none" | "associated" | "unknown" };
}
```

A receipt is only evidence for the existing Run terminal gate; it never
writes the Run terminal directly. The Host validates that the external ref
matches the persisted mapping, the operation / Run / binding association is
consistent, the terminal is written exactly once, `artifactRefs` pass safe
reference checks, and the error code is a bounded stable code. Receipt
classification:

| External result | AOS result |
| --- | --- |
| `completed`, valid receipt, explainable side effects | `run.completed` through the existing gate |
| `failed`, valid receipt | `run.failed` with the stable external error code |
| `cancelled`, provably no side effect | `run.cancelled` through the existing cancel path |
| cancel / deadline with associated or unknown side effects | `run.failed` + `side-effect-unknown`, never reported as cancelled |
| missing, malformed, identity-mismatched, or out-of-order receipt | `run.failed` + `external_agent_receipt_invalid` or `side-effect-unknown` |
| Adapter disconnected, terminal unprovable | existing `interrupted` recovery; never a fabricated terminal |

### Cancel

`run.cancel` keeps its existing semantics. The Run Lifecycle records the
cancellation intent and drives the AbortSignal; `adapter.cancel` is only a
request to the target and never decides the AOS terminal by itself.
`cancel` is idempotent, observes the same operation's AbortSignal, and stops
once a terminal receipt exists. Cooperative cancel acknowledges the boundary
but must still report associated/unknown effects when the target may have
acted; strong cancel requires tested proof that the target session or process
stopped — an HTTP 200 or a single ack field is not proof.

### Deadline

The Run Deadline contract is unchanged: an accepted Run that reaches
`deadlineAt` settles exactly once as `run.failed` with
`terminalError.code: "run_deadline_exceeded"`. The Adapter receives the
deadline / AbortSignal and requests target cancellation, but the AOS deadline
intent wins even when the target later reports cancelled.

### Resume

The v1 host contract has `start()` only — there is no same-ref resume API —
so every `run.resume` that carries an `externalAgent` selection is rejected
with `external_agent_resume_unsupported` before any probe or preflight, and
a selection never silently degrades into a new `start` or an implicit
external successor. A future verified resume connector must meet all of the
following before `run.resume` may map to an external resume: the snapshot or
a fresh probe reports `resume: true`; the `external.mapping` is unique and
complete; the target external Session / Run can be located safely; the
prepared Binding is compatible; and the Adapter can prove the resume will
not duplicate the prior execution. Otherwise the Host returns
`external_agent_resume_unsupported` or enters the existing `interrupted`
recovery. Resume never overwrites an old mapping and never rewrites an
unknown result as `cancelled`.

## 8. Stable errors

Adapter raw exceptions are converted to stable codes. Public messages are
generic and code-derived: no command, path, URL, process ID, header, token,
stack, or raw exception. A payload that borrows a known host code (for
example `start_rejected` or `session_busy`) never forwards its raw message:
only the host's own fixed lifecycle `start_rejected` texts pass through, and
every other known or unknown code maps to the phase fallback with the
code-derived allowlisted text.

| Code | Stage | Retryable | Meaning |
| --- | --- | --- | --- |
| `external_agent_adapter_invalid` | registration / selection | no | `adapterId`, `targetId`, or descriptor invalid |
| `external_agent_target_not_found` | target lookup | no | the trusted registry has no such target |
| `external_agent_probe_failed` | probe | yes | handshake failed or timed out; probe has no business side effects by contract |
| `external_agent_protocol_unsupported` | probe / prepare | no | protocol or version has no verified translator |
| `external_agent_capability_missing` | prepare | no | `start`, terminal `receipt`, `cancel`, or another required capability missing |
| `external_agent_binding_unsupported` | Binding translation | no | current Model / Capability / Policy / Sandbox cannot be mapped safely |
| `external_agent_start_failed` | start | no | target rejected start or the result is unconfirmed; reconcile first |
| `external_agent_mapping_invalid` | mapping | no | external identity unsafe or inconsistent with the request |
| `external_agent_mapping_conflict` | mapping | no | append-only mapping already binds a key to another target |
| `external_agent_cancel_unsupported` | cancel | no | target has no verifiable cancel capability |
| `external_agent_cancel_failed` | cancel | yes | cancel request failed; do not claim the target stopped |
| `external_agent_receipt_invalid` | settle | no | receipt missing, invalid, or identity-mismatched |
| `external_agent_side_effect_unknown` | settle / cancel / disconnect | no | an effect may have occurred; automatic retry is forbidden |
| `external_agent_resume_unsupported` | resume | no | target cannot resume and no safe successor can be established |
| `external_agent_persistence_failed` | mapping / remote operation | no | facts not durably persisted; no success acknowledgement |

`external_agent_side_effect_unknown` never triggers ModelBroker fallback,
Provider fallback, or a second external start, and it is never retryable. The
redaction boundary converts any unknown exception into a stable adapter error
(`toExternalAgentError`); already-stable errors pass through unchanged.

## 9. Security boundary and non-goals

All identifiers are bounded safe identifiers (no paths, URLs, userinfo, query
text, commands, headers, or credentials; secret shapes such as `sk-`, `ghp_`,
`xox*`, `AKIA`, `-----BEGIN`, or `bearer` are rejected). All timestamps are
canonical UTC ISO strings with millisecond precision. Every public value is
validated with an allowlist of object keys; unknown fields and unknown
capabilities are rejected before they can enter a snapshot, receipt, event,
or Audit summary.

Public Adapter / Audit / RPC summaries allow only:

```text
adapterId, targetId, protocol, protocolVersion,
runId, sessionId, operationId,
namespace, externalSessionId, externalRunId,
bindingFingerprint,
capability flags, phase, sequence,
artifact id / kind / digest / size / mediaType,
status, error code, retryable, sideEffects, timestamps
```

The following never cross the public boundary:

```text
data, raw, prompt, message, messages, transcript, finalText,
command, args, cwd, path, targetPath, content, stdout, stderr,
url, endpoint, payload, callback, env, headers, token,
authorization, credentials, providerError, stack, processId,
executable, tempPath, sessionFile, targetSelfReport
```

The Adapter cannot append a Run terminal, Run ledger entry, Task Graph
transition, or Policy decision; cannot use the mapping entry as a protocol
snapshot; cannot turn target-owned tools, network, filesystem, or credentials
into AOS capabilities; and cannot implement a queue, scheduler, preemption,
or cross-Session parallelism. Task Graph consumes Adapter Runs only as
ordinary attached Runs.

Non-goals for v1:

- No automatic recognition of model providers, model IDs, config entries,
  URLs, or packages as external Agents.
- No Claude, Codex, ACP, or other vendor connector inside this contract.
  Contract and integration tests use a deterministic in-process
  `FakeExternalAgentAdapter` (test/external-agent-adapter.test.ts and
  test/external-agent-integration.test.ts) that performs no network or
  process I/O and exercises the same public validators as the contract; it
  proves fail-closed behavior of the Adapter boundary without a real target.
  The fake is explicitly opt-in: each suite constructs it and registers it
  through `createExternalAgentAdapterRegistry`, and the Host only reaches it
  for a Run whose `externalAgent` selection names the registered adapter. A
  real vendor connector is a separate opt-in package that must pass the same
  contract tests.
- No loading of adapters from project files, prompts, or remote
  configuration.
- No transfer of target credentials into AOS or AOS credentials into the
  target; no copying of Binding / Policy / Sandbox ledgers to the target.
- No claim that target-owned capabilities are AOS-sandboxed; no Host tool
  fallback without a verified Tool Gateway.
- No second Agent Loop, Run ledger, Receipt, Audit ledger, or result store;
  no Worker queue, scheduler, leader election, or parallel Run scheduling;
  the one-active-Run-per-Session boundary is unchanged.
- No automatic retry of a `side-effect-unknown` external execution, no
  implicit external successor, and no silent downgrade of `resume` to `start`.
- No Task Credential, Task Lease, or worker identity authentication in v1;
  the optional Remote Operation lease is the only lease contract reused.
- No new Host Transport, WebSocket, TLS, database, message queue, or
  mandatory network dependency; stdio and loopback TCP framing are unchanged.

## 10. Compatibility

- Callers that never select an Adapter need no migration; `run.start` /
  `run.resume` without `externalAgent` behave exactly as before.
- `externalAgent` is an optional additive selection field; `external` remains
  the identity reference and never replaces it.
- Existing `external.mapping`, `remote.operation`, Run receipt, Task Gate,
  Task Graph, and Audit entries need no migration.
- When a target cannot cancel, return a receipt, or resume, the caller gets a
  stable error; there is no silent local fallback.
- Rollback stops new registrations and selections; already accepted external
  Runs are reconciled through the Run ledger, `external.mapping`, and Audit
  recovery, and append-only entries are never deleted or rewritten.
