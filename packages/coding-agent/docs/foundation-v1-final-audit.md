# Foundation v1 Final Audit

Audit verdict: the Foundation v1 candidate satisfies the local seal gates. It
is ready for external review and an explicit user merge decision, but it has
not been merged into the integration branch or `main`.

## Scope

The audit covers Architecture Atlas rows 01–10 and 10A, the canonical local
execution path, recovery and migration behavior, and the machine-readable
capability ledger. It does not claim delivery of the future consumers assigned
to lines 11–15.

## Capability accounting

| Set | Count | Exact ids or owners |
| --- | ---: | --- |
| Foundation closures | 79 | `1–73`, `98`, `127–129`, `145–146` |
| `implemented` | 32 | Recorded in the capability ledger |
| `regression_locked` | 27 | Recorded in the capability ledger |
| `contract_sealed` | 20 | Recorded in the capability ledger |
| Future owners | 71 | Line 11: 17; 12A: 28; 12B: 10; 13: 3; 14: 11; 15: 2 |

The closure and future-owner sets are disjoint and their union is exactly
`1–150`. No closure remains in a draft state. Each closure names a concrete
owner module, persistence boundary, public contract, and test evidence.

## Runtime findings closed by T12

- All prompt surfaces enter the canonical Prompt Task Adapter, Session, and
  AgentHarness path.
- Session reopen, fork, navigation, queue projection, model identity, active
  tools, and async disposal use one durable authority.
- ModelBroker bindings and attempts are recorded around actual provider calls;
  budget enforcement and safe fallback use a fresh immutable Context snapshot.
- Provider failures with no visible output are safe failures. Failures after
  visible output remain unknown and are not replayed.
- Foundation tool-result images use the Session artifact authority and retain
  content-addressed identity.
- Workflow evaluation rejects malformed or incomplete datasets and emits a
  strict versioned quality, cost, and recovery snapshot.
- Recovery rejects unknown schemas and semantic corruption, preserves lineage,
  and repairs only a truncated JSONL tail.
- Compatibility retry state and pending external-message writes expose their
  live state and drain before close; they are no longer fixed-value stubs or
  untracked tasks.

## Verification evidence

The seal includes targeted regression coverage for:

- Foundation capability accounting and T12 workflow evaluation.
- AgentHarness runtime and Foundation model-call behavior.
- Canonical AgentSession runtime, queue, ModelBroker, model extension, tool
  image, compaction, retry-state, pending external-message, and parity behavior.
- Task Gate, Task Graph, task credential, recovery, migration, and session
  projection behavior.

The repository-wide `npm run check` gate passes with formatting, dependency,
import, generated-lock, TypeScript, and browser-smoke checks enabled. The full
`@aos-agent/agent-core` suite passes with 658 tests and one skip. The final T12
targeted runs pass 25 session/ModelBroker tests, 12 compaction/retry tests, and
73 Context/RPC tests.

An isolated root `./test.sh` run on the final T12 source was also attempted. It
recorded 62 AI test failures and 27 coding-agent test failures, plus one
coding-agent suite import failure. One coding-agent failure exposed a T12-owned
test-fixture bug: the offline model fallback had a context window smaller than
the default compaction reserve, so the fixture generated negative token usage.
The fixture now selects a valid reserve explicitly, and its complete file passes
with 6 tests. The remaining failures are outside the T12 diff: the pre-existing
offline AI catalog baseline, child-process imports that require workspace
`dist` output, and WSL platform/permission assumptions. This audit does not
report the root gate as passing.

## Merge gate

The final candidate chain is ready for review as an isolated, reversible
slice. Fast-forwarding it into the local integration branch or merging it into
`main` requires explicit user confirmation and a decision on the
repository-wide baseline failures recorded above.
