# Remote-ready acceptance evidence

This report records the implementation selected for the Core/Skeleton closeout.
It does not introduce a network transport, worker scheduler, container, VM,
credential service, distributed coordinator, or second durable ledger.

## Module selection

- `packages/agent`: the convergence, error-classification, retry, cancellation,
  and deadline implementation from `EXECUTION_AUDIT_REPLAY-1`.
- `packages/coding-agent`: the Audit/Replay, Run lifecycle, RPC recovery,
  binding-handle, Session-write, and remote-operation implementation from
  `EXECUTION_AUDIT_REPLAY-3`.
- Overlapping alternatives were not copied as whole branches. Existing Run,
  Session, Policy, ModelBroker, Capability, Sandbox, and Audit facts remain the
  only authorities.

## Acceptance matrix

| Contract | Production seam | Focused evidence |
| --- | --- | --- |
| F1 request idempotency | `core/run-lifecycle.ts`, RPC run start/resume | `test/run-lifecycle.test.ts`, `test/rpc-automation-run.test.ts` |
| F2 durable ordering | Run ledger and terminal receipt | `test/run-lifecycle-process-boundary.test.ts`, `test/run-lifecycle.test.ts` |
| F3 reconnect alignment | RPC replay recovery and audit cursor | `test/rpc-client-replay-recovery.test.ts`, `test/execution-audit-query.test.ts` |
| F4 binding handles | Model, Capability, Policy, and Sandbox associations | `test/binding-handles.test.ts`, `test/rpc-automation-run.test.ts` |
| F5 Session writer policy | Session append coordination | `test/session-manager/session-write-coordination.test.ts` |
| F6 remote-neutral operation contract | `core/remote-operation.ts` and fake provider | `test/remote-operation-contract.test.ts` |
| Kernel quality | Agent Loop and operation boundaries | `packages/agent/test/agent-loop-convergence.test.ts`, `packages/agent/test/agent-loop-errors.test.ts`, `test/core-quality-boundaries.test.ts` |
| Audit safety | Audit adapter/query and external mapping | `test/execution-audit-adapter.test.ts`, `test/execution-audit-query.test.ts`, `test/external-session-mapping.test.ts` |

Audit query and replay remain read-only folds over existing Session facts. The
remote-operation receipt is an optional safe projection and never replaces the
Run ledger or creates a synthetic terminal Run.

## Safety boundaries

- A known transient provider failure is retryable only before a possible side
  effect; `side_effect_unknown` is never blindly retried.
- Caller cancellation and deadline win over provider text when their signal is
  already aborted.
- Wrapped DNS cancellation text is recognized as transport failure only when it
  is not an explicit caller cancellation.
- Public receipts, RPC events, audit summaries, and operation artifacts contain
  no prompt, command, raw tool argument, credential, header, environment value,
  provider payload, path, URL, or stack.
