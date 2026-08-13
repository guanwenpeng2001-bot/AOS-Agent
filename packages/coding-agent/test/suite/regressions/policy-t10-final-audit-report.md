# POLICY-3 Final Audit Report

## Source Documents Read

- `packages/coding-agent/docs/execution-policy-contract.md` in full.
- `packages/coding-agent/docs/capabilities.md` in full.
- `packages/coding-agent/docs/containerization.md` in full.

The supplied PR checklist was used together with the in-repository contract acceptance cases.

## Executive Finding

Found one in-scope gap: interactive and RPC `user_bash` extension handlers could return a completed bash result before the Execution Policy process authorizer ran. This could bypass `deny` and could act as a host fallback under strict sandbox policy.

Fix:

- Added `AgentSession.authorizeUserBashExtension()` to authorize the command before extension `user_bash` handlers run.
- Updated interactive and RPC bash paths to call that preflight first.
- If the active policy requires sandbox execution, extension interception is skipped and `AgentSession.executeBash()` routes the command through the sandbox handle.
- Added regressions for deny-before-extension and strict no-host-fallback.

## Requirement Matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| Capability visibility is separate from execution policy and sandbox boundary. | Pass | `execution-policy-contract.md` and `capabilities.md` separate the authorities; the tool registry freezes capability binding and policy authorizes invocation in `agent-session.ts`. |
| Execution policy exposes fixed v1 scalar names and errors. | Pass | Constants in `execution-policy.ts`; fixture assertions in `execution-policy-contract.test.ts`. |
| Legacy default remains legacy host compatibility, not isolation. | Pass | `LEGACY_PROFILE` in `execution-policy.ts`; strict sandbox requirements documented in `containerization.md`. |
| Settings accept named profiles only, not inline caller policy objects. | Pass | CLI, SDK, and RPC expose `policyProfile` names; contract rejects inline policy objects. |
| Trust narrowing cannot widen user policy or select unregistered providers. | Pass | `execution-policy-settings.ts` validates providers and trust narrowing; settings tests cover untrusted/narrowing behavior. |
| Binding freezes per run and resume creates a successor binding with no approval or handle reuse. | Pass | `run-lifecycle.ts` validates predecessor/successor; profile changes reset approvals and handles; regression covers successor mismatch. |
| `allow` / `ask` / `deny` semantics, with `ask` before side effect. | Pass | `authorizePolicyOperation()` creates approval before execution; host authorizer rejects until approved. |
| Non-UI approval never auto-approves. | Pass | RPC start rejects pending asks; approvals are explicit `policy.approve` / `policy.reject` operations. |
| Strict sandbox with no provider or insufficient provider fails closed. | Pass | Resolver and sandbox preparation return `sandbox_unavailable` or capability errors; focused tests cover both. |
| No host or legacy fallback for strict sandbox operations. | Pass after fix | Built-in policy requires a sandbox for strict process/filesystem operations; bash goes through `bash-executor.ts`; the new extension-bash regression covers the bypass. |
| All six filesystem tools route through policy and strict sandbox boundary. | Pass | `read`, `write`, `edit`, `grep`, `find`, and `ls` authorize and execute through the sandbox operation path in strict mode; `sandbox-tools.test.ts` covers the routes. |
| Bash tool and user `!` bash route through policy. | Pass after fix | Built-in bash and `AgentSession` authorize process operations; interactive/RPC extension preflight now uses `authorizeUserBashExtension()`. |
| MCP stdio startup is policy-gated and receives only allowlisted env names/values. | Pass | Settings validate stdio fields; startup authorizes process before transport; transport builds env from allowlisted names. |
| MCP Streamable HTTP is policy-gated and headers are from env references only. | Pass | Settings reject URL userinfo and invalid headers; network authorization occurs before connect; header values resolve from env references. |
| MCP strict sandbox does not fall back to host. | Pass with documented limitation | Strict sandbox stdio/HTTP currently fail closed with `sandbox_capability_insufficient` rather than using host transport. |
| Extension tool invocation is policy-gated before extension code runs. | Pass | Invocation source classification and wrapper authorization precede the extension handler. |
| Extension `user_bash` interception cannot bypass policy. | Fixed | Interactive and RPC call `authorizeUserBashExtension()` before interception; deny and strict sandbox regressions cover both cases. |
| SDK, CLI, RPC, and TUI expose policy surfaces without inline policy objects. | Pass | SDK `policyProfile`, CLI `--policy`, RPC policy operations, and TUI `/policy` are implemented. |
| Run lifecycle public records and receipts contain policy binding ids and summaries only. | Pass | Public run records/receipts serialize binding ids and summaries through the allowlisted serializers. |
| Policy ledger and public summaries are allowlisted and redacted. | Pass | Summary construction and ledger cloning use safe metadata; regression checks exclude raw command data. |
| Credentials, environment, and network details are metadata only. | Pass | Process env filtering, network/credential decisions, MCP URL redaction, and run error redaction are covered by tests. |
| Context Engine receipts do not carry raw source content and carry only safe binding ids. | Pass | Context snapshots are metadata-only and public serialization strips raw identifiers. |
| ModelBroker cannot override policy, sandbox, or credential boundaries. | Pass | Authority separation is documented; policy errors are non-retryable; regression covers no escalation. |
| Public redaction covers terminal errors, MCP errors, and session events. | Pass | Run lifecycle redaction helpers and MCP/session event serializers are covered by focused tests. |

## Validation

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-session-capabilities.test.ts`: passed, 33 tests.
- `npm run check`: passed.

## Remaining Documented Limitations

- Legacy host mode remains compatibility behavior and not an isolation boundary.
- Strict sandbox MCP stdio/HTTP does not currently execute through a sandbox transport; it fails closed with `sandbox_capability_insufficient` rather than falling back to host.
- Extension code still runs wherever the `aos` process runs unless the extension delegates its own operations; extension tool invocation and `user_bash` interception are policy-gated, but extension internals are not an OS sandbox.
- MCP OAuth browser flows, credential storage, legacy SSE, MCP resource/prompt ingestion, ModelBroker route-selection work, and external agent orchestration remain documented non-goals.
