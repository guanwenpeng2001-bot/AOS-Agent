# Scheduler contract

The Scheduler is a trusted Host composition over the existing Foundation Task,
Binding, Dispatch, Attempt, Result, Workflow, Ask, Session, and Run contracts.
It is disabled unless a Host calls `createAgentSessionWithTrustedScheduler` and
supplies `enabled: true`; settings, prompts, extensions, models, and RPC callers
cannot enable it.

## Composition and authority

`TrustedSchedulerComposition` registers Run lifecycle observers, creates the Run lifecycle coordinator, and then creates the source Task Graph in that order. It then wires the durable queue and executor dispatch to fan-in settlement, cross-Session messages, fenced handoff, Workflow progression, deadlock/backpressure control, and the Scheduler Host.

The composition owns the Session's single Scheduler lifecycle hook and forwards cancellation, deadline, and terminal observations to executor dispatch. Dispatch uses that same Run ledger for claim validation and never registers a competing hook owner.

One coalescing driver calls Workflow, Host, and deadlock ticks in order. Component-local Host drivers remain stopped. Event wakes and the bounded recovery poll only request that driver; concurrent wakes share the in-flight tick.

The Scheduler never writes a Run terminal fact directly. `settleRunAtHost` remains an injected Host authority, and registered Run hooks are read-only wake signals. Queue claims, dispatches, handoffs, messages, joins, wakes, and deadlock decisions remain durable scheduler facts with Foundation correlation and fencing.

## Cross-Host executor discovery and handoff

Remote Host executor registration, heartbeat, and unregister transitions are
`scheduler.executor_registration` facts on the shared Session ledger. Each
record binds one globally unique provider id to a Host id, capability
descriptor, runtime snapshot, load, and heartbeat expiry. The in-process
`SchedulerExecutorRegistry` is a compatibility projection: it resolves only
reachable provider routes, removes expired or explicitly offline executors
before selection, and preserves the existing deterministic score and
provider-id tie break. Discovery does not add automatic load balancing or
tenant isolation.

An explicit cross-Host handoff keeps the source claim while the offer is
pending. Offer, acceptance intent, source cancellation, claim transfer,
accept/reject, and timeout remain durable shared-ledger transitions. The target
Host must have a live projected executor before acceptance; otherwise the
source claim remains authoritative. Cross-Host fencing uses the existing claim
and Session writer tokens.

Executor heartbeat expiry stops new selection and handoff acceptance. It does
not invent a second recovery path: after the abandoned claim lease expires,
the existing `SchedulerQueueStore.recoverExpired()` flow cancels the in-flight
attempt when possible, expires its dispatch, and requeues or cancels according
to the existing attempt policy.

## Audit and RPC

Execution Audit accepts only validated `scheduler.*` durable events. The public summary contains category, event and stream identifiers, sequence, safe correlation, a fixed summary, and a payload digest. Raw payloads and fields such as prompts, messages, content, output, environment, arguments, headers, tokens, errors, and stacks are rejected and never projected.

Automation Host advertises `schedulerCommands: ["scheduler.status"]` only when the trusted composition is active. `scheduler.status` is read-only and returns bounded component/tick metadata. RPC has no scheduler enable, tick, enqueue, claim, dispatch, handoff, or settlement command.

## Capability closure

The Scheduler implements capabilities 119–126, 130, and 131, including the
cross-Host portion of executor discovery and explicit handoff. It consumes
Foundation capabilities 3, 5, 6, 10, 16, 26, 47, 51, 53, 55–58, 61, 98, and
127–129 by direct manifest reference. Native subagent capabilities, external
connectors, platform hardening, and product UI remain separate contract areas.
