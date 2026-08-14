# Remote-Neutral Operation Contract (v1)

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
timestamps, binding references, optional binding association, artifact
references, side-effect state, and a stable error record when applicable. It
contains no provider exception,
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
