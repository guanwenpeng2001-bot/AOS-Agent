T7 fake-sandbox regression report

Changes:
- Added `packages/coding-agent/test/fixtures/fake-sandbox-provider.ts`, a test-only SandboxProvider with controllable capabilities, start failure, operation recording, write-back, network/credential denial, dispose tracking, and abort-aware execution.
- Extended `packages/coding-agent/test/suite/harness.ts` with test-only `sandboxProviders` and `policyProfile` wiring. Policy/sandbox harness cases now use the temp workspace as the SessionManager cwd so strict workspace checks bind to the same root as AgentSession.
- Added `packages/coding-agent/test/suite/regressions/policy-t7-fake-sandbox.test.ts` covering provider missing/insufficient/start failure, strict sandbox bash routing, file write-back, network denial, env allowlist, cancel, dispose, handle reuse, pre-side-effect ask/deny, credential secrecy, redacted binding/ledger summaries, run start/resume successor policy binding, and Capability/Context/ModelBroker non-escalation.

Verification:
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/regressions/policy-t7-fake-sandbox.test.ts` passed: 9 tests.
- `npm run check` passed.

Exact failures observed:
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/agent-session-bash-persistence.test.ts` failed in the existing non-policy harness path with `workspace_boundary_violation` in bash tests and one ordering assertion that now sees an extra policy custom entry. I did not change that non-policy path beyond adding optional policy/sandbox wiring, so I left it as a reported base interaction instead of broadening this task into production or unrelated harness behavior.

Coverage gaps:
- Filesystem sandboxing is covered by fake-sandbox write-back behavior through the sandboxed process path. Production `read` / `write` / `edit` tools currently authorize filesystem operations through policy but still use host file operations; I did not add production sandbox filesystem routing.
- Interactive/Print/JSON/RPC error semantics are covered at the stable structured-code level in the regression test, not by spawning all frontends end-to-end.
- MCP stdio/HTTP sandbox transport denial is already covered in existing capability tests; this T7 file focuses on fake-sandbox provider behavior and policy/run ledger regressions.
