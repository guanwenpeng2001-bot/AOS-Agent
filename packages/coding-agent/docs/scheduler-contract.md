# Scheduler contract

The Line 12B Scheduler is a trusted Host composition over the existing Foundation Task, Binding, Dispatch, Attempt, Result, Workflow, Ask, Session, and Run contracts. It is disabled unless a Host calls `createAgentSessionWithTrustedScheduler` and supplies `enabled: true`; settings, prompts, extensions, models, and RPC callers cannot enable it.

## Composition and authority

`TrustedSchedulerCompositionV1` registers Run lifecycle observers, creates the Run lifecycle coordinator, and then creates the source Task Graph in that order. It then wires the durable queue and executor dispatch to fan-in settlement, cross-Session messages, fenced handoff, Workflow progression, deadlock/backpressure control, and the Scheduler Host.

The composition owns the Session's single Scheduler lifecycle hook and forwards cancellation, deadline, and terminal observations to executor dispatch. Dispatch uses that same Run ledger for claim validation and never registers a competing hook owner.

One coalescing driver calls Workflow, Host, and deadlock ticks in order. Component-local Host drivers remain stopped. Event wakes and the bounded recovery poll only request that driver; concurrent wakes share the in-flight tick.

The Scheduler never writes a Run terminal fact directly. `settleRunAtHost` remains an injected Host authority, and registered Run hooks are read-only wake signals. Queue claims, dispatches, handoffs, messages, joins, wakes, and deadlock decisions remain durable scheduler facts with Foundation correlation and fencing.

## Audit and RPC

Execution Audit accepts only validated `scheduler.*` durable events. The public summary contains category, event and stream identifiers, sequence, safe correlation, a fixed summary, and a payload digest. Raw payloads and fields such as prompts, messages, content, output, environment, arguments, headers, tokens, errors, and stacks are rejected and never projected.

Automation Host advertises `schedulerCommands: ["scheduler.status"]` only when the trusted composition is active. `scheduler.status` is read-only and returns bounded component/tick metadata. RPC has no scheduler enable, tick, enqueue, claim, dispatch, handoff, or settlement command.

## Capability closure

Line 12B implements capabilities 119–126, 130, and 131. It consumes sealed Foundation capabilities 3, 5, 6, 10, 16, 26, 47, 51, 53, 55–58, 61, 98, and 127–129 by direct manifest reference. Native Subagent capabilities remain owned by 12A; external connectors by 13; platform hardening by 14; and product UI by 15.
