# Remote-Neutral Operation Contract

This document freezes the smallest operation boundary needed by a future
remote provider. It is transport- and provider-agnostic: the current fixture
uses an in-process transport, and no TCP, WebSocket, worker, container, VM, or
credential implementation is implied.

The source contract is `src/core/remote-operation.ts`. The fixture is
`test/fixtures/fake-remote-provider.ts`, and
`test/remote-operation-contract.test.ts` runs the same cases through a local
adapter and the fake transport.

## Identity and binding

Every operation has a caller-supplied `operationId`. It is an opaque safe
identifier and is unique within the caller's operation scope. A request may
carry existing `runId`, `sessionId`, `capabilityBindingId`, `modelBindingId`,
`policyBindingId`, and a public-safe `bindingAssociation` containing stable
ModelBroker, Capability, Policy, and Sandbox handles. These are correlation
references only; the existing Run, Policy, Capability, ModelBroker, and Audit
contracts remain the authorities for those objects and their ledgers.

The operation contract never creates a Run, changes a binding, or replaces the
existing `RunReceipt`. Without a ledger sink it also does not persist anything.
When the caller supplies `createSessionRemoteOperationLedger(session)`, the
runner appends exactly one validated `remote.operation` custom entry after the
terminal receipt is formed. That entry is an Audit projection of the provider
boundary result, not a second Run ledger or synthetic Run terminal receipt.

## Task lease correlation

A request may carry an optional `taskLease` reference
(`TaskLeaseReference`) that correlates the operation with a Task Credential
lease. The reference carries exactly the three stable identities:

```ts
interface TaskLeaseReference {
  readonly leaseId: string;
  readonly grantId: string;
  readonly bindingId: string;
}
```

It never carries an expiry, a heartbeat sequence, a scope, a target, or a
status, so it cannot drive operation deadline, cancel, or heartbeat behavior.
The terminal receipt repeats the same reference as a correlation fact when the
request carried one.

The host may inject a read-only `taskLeaseVerifier` that checks the referenced
lease before provider execution. The check runs exactly once per operation,
before the provider is invoked, and must not call the credential provider or
append or mutate anything; the host wires a read-only store lookup behind it.
It must confirm the lease is live (`active` or `renewing`, not expired) and
that its binding, scope, and target correlate with the request's binding
references. A missing verifier, a thrown verifier, or a result that is not the
exact safe verified snapshot fails the operation closed as `invalid` before
any provider execution. The verifier never participates in cancellation,
deadlines, or heartbeats: those stay driven by the operation's own identity,
deadline, and lease only. Task Credential lease expiry is a deadline, and a
lease in `revocation_unknown` / quarantined state can never manufacture an
operation terminal: it fails closed and coexists with an operation
`side-effect-unknown` outcome without faking one.

## Cancellation, deadline, and lease

`deadlineAt` is an optional canonical UTC timestamp. An expired deadline is
terminal before provider execution and returns a cancelled receipt with error
category `deadline`. A caller cancellation returns a cancelled receipt with
category `cancelled` when no side effect was observed. The same signal and
error categories are used by local and future remote adapters.

An optional lease has an opaque `leaseId` and `expiresAt`. A lease-aware caller
renews it through `heartbeat()`. Heartbeats carry the operation ID, lease ID,
monotonic sequence, and send timestamp; the provider returns the next lease.
Lease expiry is treated as a deadline. Heartbeats after cancellation or
terminal completion are rejected.

Cancellation is idempotent. Provider adapters must observe the supplied
`AbortSignal` and their `cancel(operationId)` method. If cancellation cannot
prove that no side effect occurred, the result is not reported as cancelled;
it is failed with `side-effect-unknown`.

## Errors and final receipt

The stable error categories are:

- `transient`: retryable only when no side effect is reported;
- `rejected`: the provider rejected an otherwise shaped request;
- `invalid`: the request or lease/artifact reference is invalid;
- `side-effect-unknown`: an effect may have happened, so retry is unsafe;
- `cancelled`: cancellation completed before an effect;
- `deadline`: the deadline or lease expired before an effect.

Unknown provider exceptions fail closed as `side-effect-unknown`. The final
`RemoteOperationReceipt` includes the operation ID, terminal status, bounded
timestamps, binding references, optional binding association, optional task
lease reference, artifact references, side-effect state, and a stable error
record when applicable. It contains no provider exception,
payload, path, URL, credential, or transport detail.

Terminal statuses reuse the existing Run vocabulary: `completed`, `failed`,
and `cancelled`. A successful operation is `completed`; transient, rejected,
invalid, and side-effect-unknown errors are `failed`; cancellation and
deadline are `cancelled`. The operation receipt is not a second ledger or a
synthetic Run terminal receipt.

## Artifact references

`artifactRefs` contain only safe metadata: an opaque ID, one of `input`,
`output`, `log`, or `checkpoint`, and optional bounded digest, byte size, and
media type. References never contain bytes, paths, URLs, callbacks, prompts,
commands, environment values, headers, or credentials. A future transport may
choose how bytes are delivered without changing this contract.

## Provider and transport boundary

`RemoteOperationProvider` and `RemoteOperationTransport` share the same
`execute`, `cancel`, and `heartbeat` shape. The operation runner consumes that
shape and therefore does not know whether execution is local, in-process, or
remote. Policy authorization and sandbox selection remain before this boundary;
this contract cannot bypass them.

## External Agent Adapter boundary

An External Agent Adapter is one consumer of this contract: the Host starts
one remote operation per adapter Run and reuses `operationId`, `deadlineAt`,
the optional lease (`heartbeat()`), idempotent `cancel`, safe artifact
references, and the `side-effect-unknown` fail-closed rule. The adapter
receipt is the provider-boundary receipt; it is never a Run terminal and
never a second Run ledger. A Run selected for an external Agent still settles
through the existing Run Lifecycle terminal gate, and its deadline keeps the
`run.failed` + `run_deadline_exceeded` semantics.

The optional lease is refreshed through the adapter handle's `heartbeat()`;
lease expiry is treated as a deadline, and heartbeats after cancellation or
terminal completion are rejected. Cancellation is idempotent and observes the
same `AbortSignal` as the execution context. An operation receipt is refused
until the external execution has a persisted `external.mapping`
(mapping-before-operation ordering), and no receipt, event, or audit summary
carries raw protocol data, prompts, paths, URLs, or credentials. See
[External Agent Adapter](external-agent-adapter.md).
