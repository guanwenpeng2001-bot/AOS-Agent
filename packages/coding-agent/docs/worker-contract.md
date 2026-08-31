# Sandbox Operation Worker contract

The Sandbox Operation Worker is a trusted child process that executes one bounded sandbox operation at a time. It is an execution surface, not an Agent: it does not run `ModelRuntime` or the Agent Loop, create an `AgentInstance`, settle a Task, or write the Run terminal state. The Host remains authoritative for Run admission, cancellation, settlement, audit joins, and the unique `RunReceipt`.

## Composition and transport

The Worker is opt-in trusted composition through `trustedWorkerSandboxFactory`. Inline sandbox execution remains the default. Configuration cannot name an executable, module path, environment overlay, or arbitrary worker command.

The Host launches the packaged Worker entry and communicates over private stdio with versioned `WorkerProtocolV1` envelopes. The channel is not a public RPC surface: no listener, socket address, external authentication flow, or remote-worker claim is implied. Protocol input is bounded and validated before use, and stdout is reserved for framed protocol messages.

Preflight validates the profile, sandbox capabilities, credential target, protocol support, and launch inputs without spawning a process or projecting a credential. Activation may create those side effects only after the Host accepts the Run. A failure between preflight and activation therefore cannot leave an accepted Worker outside the Host lifecycle.

## Identity, lifecycle, and authority

`workerId`, `providerId`, `sessionId`, and `laneId` identify the Worker. Optional Run/Binding/Attempt values correlate it with Host-owned execution facts. The Worker progresses through revision-fenced lifecycle and operation records; readiness and heartbeat establish process liveness, while timeout or transport loss moves the Worker to a lost/terminal path that must be reclaimed.

Heartbeat liveness is not a lease. It answers whether the child is responsive. Task Credential leases control credential scope, TTL, renewal, and revocation. Session writer lease/fencing controls which Host may durably mutate Session/Run state. A fresh heartbeat cannot renew either lease or bypass fencing, and lease renewal cannot prove Worker liveness.

The Host alone writes the Run terminal state and `RunReceipt`. Worker cancellation/finalization returns bounded operation evidence to the Host; it never makes a Run terminal. Reclaim is revision-fenced and idempotent, including explicit `reclaim_unknown` handling when side effects cannot be proven absent.

## F2 provenance boundary

Worker durable records, Worker events, and `WorkerReceipt` provenance omit `agentInstanceId`. A request-side `agentInstanceId` may arrive from upstream only as correlation input; it is not copied into Worker durable state or receipt provenance. Host-owned Attempt join or audit records may contain Agent identity while correlating the result, but those records are Host-owned facts and are not Worker durable records.

This distinction is required because Operation Workers are not Agent-class providers. Adding `agentInstanceId` to Worker records would incorrectly make a bounded tool process look like an Agent runtime.

## Operation and receipt settlement

An operation is claimed, started, and settled under a monotonically increasing revision. Terminal output is bounded and redacted before it crosses the protocol. The Worker writes a `WorkerReceipt` for the bounded operation; the Sandbox Operation ToolGateway validates it and copies `WorkerReceipt.workerReceiptId` into `ToolExecutionResult.toolReceiptRef`. That closes a contract omission in receipt propagation and does not redesign either schema.

`WorkerReceipt` remains distinct from `AttemptReceipt`, `TaskResult`, and `RunReceipt`. The Host may join the receipt into later facts, but the Worker cannot promote it into another result layer.

## Credentials and redaction

Worker credential delivery uses a Task Credential target bound to the Worker operation. Projection, renewal, and revocation remain scoped by the credential lease. Secret material, target-private handles, protocol tokens, environment data, process metadata, VM/QEMU launch data, and raw receipt bodies must not enter public Worker records, audit summaries, or RPC results.

Foundation canonical error vocabulary includes `sandbox_capability_insufficient` and `task_credential_target_unavailable`. These two additive errors close a contract omission; they do not change a durable schema. Missing capability or target fails closed before activation.

## Trusted lifecycle-hook ownership

`registeredRunWorkerHooks` is a process singleton keyed by `sessionId`. Trusted session composition registers exactly one hook owner. `createRunLifecycleCoordinator` consumes that registered owner for the same session object; a competing explicit hook value fails closed with `service_conflict`.

Registration returns a disposer. The trusted composition that registered the hooks owns that disposer and must call it during session teardown. Disposal is token-fenced: an old disposer cannot delete a newer owner. This defines current ownership behavior, but the singleton lifecycle and `service_conflict` diagnostics remain a nonblocking review item listed below.

## Audit and RPC surface

Worker lifecycle, operation, and receipt facts are projected into the execution audit ledger as bounded summaries. Replay is read-only and never restarts or reclaims a Worker. Audit projections omit secrets, launch/process details, credential material, raw protocol frames, raw receipt bodies, and Agent identity from Worker provenance.

RPC advertises optional Worker commands only when the registry is composed:

- `worker.get` returns one public Worker record from the current session.
- `worker.list` returns a bounded, cursor-paged current-session list with optional Run/status filters.
- `worker.reclaim` requests idempotent reclaim for a reclaimable terminal Worker.

There is no public start, execute, cancel, credential, or raw-receipt Worker RPC. Public Worker records omit `receiptId`, `workerReceiptId`, receipt references, protocol credentials, process/VM/QEMU details, environment, paths, and secret material. `worker.reclaim` cannot change Run terminal state.

## Optional isolation provider

The Gondolin/QEMU provider is an optional local sandbox adapter. Worker correctness does not depend on it, and its absence does not enable a less-isolated Host fallback. VM identifiers, QEMU arguments, environment values, and sensitive provider keys stay private to the adapter boundary.

## Capability ledger

The retired machine-checkable Worker ledger is preserved in the out-of-repository capability-ledger archive. It records:

- Implemented by the Worker: 74–87, 135, 136 (16 capabilities).
- Uses existing Foundation capabilities: 6, 32, 47, 52, 61 (5 capabilities).
- Capability 132 is implemented by the External Agent Connector.
- Capabilities 88, 89, and 137 remain outside this contract pending remote-worker, fleet, and credential hardening.
- Capability 140 is not part of the Worker contract.

## R4 nonblocking follow-ups

These findings are recorded for later review. The Worker contract does not silently claim they are fixed and does not expand them into production changes:

1. `cancelledWithoutProof` is dead code.
2. `WorkerCredentialTargetRegistry.has()` checks existing membership while `get()` may lazily resolve/create a target; the semantic difference needs explicit review.
3. `revocation_unknown` quarantine behavior is asymmetric.
4. Worker credential project/renew/revoke reason propagation needs preservation and focused coverage.
5. VM identifier and QEMU sensitive-key redaction need additional tests.
6. Receipt audit-summary wording needs alignment with the intentionally omitted public `receiptId`.
7. `createAgentSessionFromServices` should dispose the provider if session creation fails.
8. The `registeredRunWorkerHooks` singleton lifecycle and fail-closed `service_conflict` behavior need continued review.
