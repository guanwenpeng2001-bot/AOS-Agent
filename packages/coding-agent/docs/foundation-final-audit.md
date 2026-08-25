# Foundation Final Audit

Audit verdict: the Foundation integration candidate satisfies the local
seal and repository-wide validation gates. The user authorized PR, CI, and
`main` integration; external final review and protected-branch CI remain the
promotion gates.

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
import, generated-lock, TypeScript, and browser-smoke checks enabled. The root
non-e2e `./test.sh` gate also passes from an isolated no-key home directory. Its
coding-agent run passes 3,581 tests in 302 files, with the expected 47 skipped
tests and five skipped files; the agent, server, session-backend, evaluation,
and TUI suites also complete with no failures or unhandled rejections.

The final integration fixes made those gates reproducible in a clean checkout:
model catalogs are generated deterministically and committed for offline use;
workspace source aliases and Windows child CLI bootstrapping no longer depend
on prebuilt `dist` output; local transports and home-path handling are portable;
SDK cwd assertions translate shell temporary roots only on Windows and preserve
isolated POSIX `TMPDIR` paths; and asynchronous Session fixtures wait for
capability readiness and disposal. Lockfiles and the coding-agent install lock
remain unchanged.

## Merge gate

The final candidate chain is an isolated, reversible integration slice. It may
be pushed and proposed only after the exact final commit range passes external
read-only review. It may merge into `main` only after the pull request's required
CI and review gates pass. The user has explicitly authorized both operations.
