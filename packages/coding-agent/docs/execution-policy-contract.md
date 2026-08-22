# Execution Policy / Sandbox Contract (T0 freeze)

This document freezes the v1 contract for the policy and sandbox work. It is
the integration boundary for T1-T7. The contract is additive: T0 does not
change the current runtime, settings parser, RPC protocol, CLI, or tool
execution behavior.

## 1. Names and ownership

The existing layers keep separate authorities:

| Layer | Authority | Not an authority for |
| --- | --- | --- |
| Capability Registry | Whether a capability is visible and selected for a run | Filesystem, process, network, or credential isolation |
| Execution Policy | Whether a selected operation is allowed, needs approval, or is denied | Making a host process safe by itself |
| Sandbox Provider | Whether an allowed operation is executed inside the reported resource boundary | Capability selection or model routing |
| ModelRuntime | Provider endpoints, model metadata, and model credentials | Tool permissions and sandbox policy |
| ModelBroker | Model binding, route order, fallback eligibility, and model budget | Tool permissions, credentials, and sandbox selection |

`CapabilityProfile` / `capabilityProfile` remain the Capability Registry
contract. The policy contract uses `ExecutionPolicyProfile` /
`policyProfile`; the names must not be merged.

The policy contract version and persisted policy schema version are both `1`.

## 2. Frozen scalar types

The following names and values are stable. Later tasks must use these exact
spellings in public types, settings, errors, fixtures, and protocol fields.

```ts
type PolicyAction = "allow" | "ask" | "deny";
type PolicyEnforcement = "legacy" | "host" | "sandbox";

type PolicyResource =
  | "capability.invoke"
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.find"
  | "filesystem.grep"
  | "process.spawn"
  | "network.connect"
  | "credential.expose"
  | "sandbox.prepare"
  | "credential.task.issue"
  | "credential.task.renew"
  | "credential.task.project"
  | "credential.task.revoke";

type PolicyDecisionOutcome = PolicyAction | "sandbox_required";
type SandboxStatus =
  | "not_required"
  | "unavailable"
  | "preparing"
  | "ready"
  | "failed"
  | "disposed";
```

`ask` means that an approval request is created before the side effect. It does
not mean that the operation has started. `sandbox_required` is a hard failure
outcome, not an approval outcome and not a fourth action.

### Task credential resources

The four `credential.task.*` resources (issue, renew, project, revoke) are the
Task Credential lease surface and are frozen in
`TASK_CREDENTIAL_POLICY_RESOURCES`. They are governed by the profile
`credentials` action and `allowNames` with the same scope boundary as
`credential.expose`: a non-empty `allowNames` requires every requested
credential scope name to be allowlisted, and a non-legacy profile with an empty
allowlist denies every credential-scoped operation. Policy decisions for these
resources record only the safe operation facts (`credentialNames`, `targetId`,
`ttlMs`); a decision for different names, a different target, or a different
TTL can never authorize a request, and a request without matching recorded
facts fails closed.

Task credential leases are time-bounded and fail closed. The frozen lease TTL
bounds are `TASK_CREDENTIAL_MIN_TTL_MS` (10,000 ms) and
`TASK_CREDENTIAL_MAX_TTL_MS` (24 hours); an out-of-bounds requested TTL is
`task_credential_ttl_invalid` and an accepted lease's earliest deadline (lease
expiry, Run deadline, or scope deadline) is the effective bound. Expired,
terminal (revoked / settled / expired), `revocation_unknown`, quarantined-target,
and provider-less leases fail closed on every later operation. Task credential
failures surface the stable `task_credential_*` codes (shared
`AutomationErrorCode` union), never provider text, and are non-retryable by
ModelBroker like every other policy error. The read-only
`resolveTaskCredentialPreflight` check never writes the Session and never calls
the provider; it reports success as `{ allowed: true, boundedTtlMs }`.

The rule ordering is strictness-first when scopes are merged:

```text
deny > ask > allow
```

The last matching rule still determines a profile's local action, but a lower
trust scope or a required sandbox may only make the result stricter. No merge
can turn `deny` into `ask` or `allow`.

## 3. Profile and settings contract

The settings key is `executionPolicy`. Its only caller-selectable value is a
registered profile name; callers cannot submit an inline policy object.

```json
{
  "executionPolicy": {
    "defaultProfile": "legacy",
    "profiles": {
      "workspace-safe": {
        "id": "workspace-safe",
        "enforcement": "sandbox",
        "sandboxProvider": "registered-provider-id",
        "defaultAction": "deny",
        "workspace": {
          "read": ["workspace", "declared-read-only"],
          "write": ["workspace"],
          "deny": ["credentials", "agent-internal"]
        },
        "process": {
          "action": "ask",
          "inheritEnvironment": false,
          "allowEnvironment": ["PATH", "LANG", "TEMP"]
        },
        "network": {
          "action": "deny",
          "allowDestinations": []
        },
        "credentials": {
          "action": "deny",
          "allowNames": []
        },
        "approvals": {
          "writeOutsideWorkspace": "deny",
          "network": "ask",
          "process": "ask"
        }
      }
    }
  }
}
```

The declaration shape used by T1/T2 is:

```ts
type WorkspaceScope =
  | "workspace"
  | "declared-read-only"
  | "temporary"
  | "credentials"
  | "agent-internal";

interface WorkspacePolicy {
  read: ReadonlyArray<WorkspaceScope>;
  write: ReadonlyArray<WorkspaceScope>;
  deny: ReadonlyArray<WorkspaceScope>;
}

interface ProcessPolicy {
  action: PolicyAction;
  inheritEnvironment: boolean;
  allowEnvironment: ReadonlyArray<string>;
}

interface NetworkPolicy {
  action: PolicyAction;
  allowDestinations: ReadonlyArray<string>;
}

interface CredentialPolicy {
  action: PolicyAction;
  allowNames: ReadonlyArray<string>;
}

interface ApprovalPolicy {
  writeOutsideWorkspace: PolicyAction;
  network: PolicyAction;
  process: PolicyAction;
}

interface ExecutionPolicyProfile {
  id: string;
  enforcement: PolicyEnforcement;
  sandboxProvider?: string;
  defaultAction: PolicyAction;
  workspace: WorkspacePolicy;
  process: ProcessPolicy;
  network: NetworkPolicy;
  credentials: CredentialPolicy;
  approvals: ApprovalPolicy;
}
```

Profile IDs and provider IDs are restricted registered identifiers. A provider
ID is not an npm package name, URL, command, or project-supplied module path.
Environment and header configuration may contain names only; values are
resolved at execution time and never become policy configuration.

### Legacy default

If `executionPolicy` or `defaultProfile` is absent, the effective profile is
the built-in profile `legacy`:

```text
id: legacy
enforcement: legacy
defaultAction: allow
```

`legacy` preserves the current host execution behavior for compatibility. It
is explicitly not an isolation claim. Its public summary must show
`enforcement: "legacy"`. The default must not silently change to `host` or
`sandbox`.

## 4. Trust and narrowing

The existing `ProjectTrustStore` and `resolveProjectTrusted` result are the
only project-trust authority. T2 must not create a second trust store.

Effective policy resolution is:

1. Parse and validate global/user `executionPolicy`.
2. Resolve project trust using the existing trust flow.
3. If trusted, accept only a project profile selection or a strict narrowing
   of a registered user profile. If untrusted, ignore project policy profiles
   and provider selection; retain them only for a safe diagnostic if needed.
4. Merge scopes with `deny > ask > allow` and validate provider registration.
5. Apply the Run/operation profile selection, which may only select a
   registered profile.
6. Freeze a `PolicyBinding` before the first side effect.

Project policy cannot:

- change a user `deny` to `ask` or `allow`;
- expand read/write roots, network destinations, environment names, or
  credential names;
- register, replace, or select an unregistered Sandbox Provider;
- inject a token, header value, full parent environment, command, URL, or
  package reference;
- make an untrusted Extension or MCP server executable.

An untrusted expansion attempt is a hard `policy_profile_untrusted` failure;
it is not an approval request.

## 5. Binding and decision contract

`ExecutionPolicyProfile` is declarative. `PolicyBinding` is the runtime
authority and is immutable after Run acceptance.

```ts
interface SandboxCapabilities {
  /** Enforces the binding's filesystem roots, links, and write boundary. */
  filesystem: boolean;
  /** Controls cwd, process tree, timeout, and cancellation. */
  process: boolean;
  /** Enforces egress after DNS, redirects, IPv4/IPv6, and proxy handling. */
  network: boolean;
  /** Keeps ModelRuntime credentials out of tool environments. */
  credentialIsolation: boolean;
  /**
   * Declares per-binding short-lived credential project / renew / revoke.
   * Absent or false fails closed for `credential.task.project` / `renew` /
   * `revoke`. `gondolin-local` never declares this and never falls back to
   * Host env, command line, or temporary files.
   */
  credentialDelivery?: boolean;
}

interface PolicyBinding {
  id: string;
  profileId: string;
  profileRevision: string;
  projectTrust: "trusted" | "untrusted";
  capabilityBindingId?: string;
  enforcement: PolicyEnforcement;
  sandboxProviderId?: string;
  sandboxCapabilities: SandboxCapabilities;
  sandboxStatus: SandboxStatus;
  runId: string;
  createdAt: string;
  previousPolicyBindingId?: string;
  bindingHash: string;
}

interface PolicyDecision {
  bindingId: string;
  resource: PolicyResource;
  action: PolicyAction;
  outcome: PolicyDecisionOutcome;
  reasonCode?: PolicyErrorCode;
  requestId?: string;
  timestamp: string;
}
```

The binding may carry opaque IDs and safe capability booleans, but must not
carry a real absolute path, raw command/arguments, environment values, header
values, tokens, authorization URLs, ModelRuntime credentials, or Agent output.
`profileRevision`, `bindingHash`, and `id` are metadata identities, not secrets.

Every side-effecting operation uses the current binding and follows:

```text
operation description
  -> policy.authorize(binding, operation)
  -> allow | ask | deny | sandbox_required
  -> host operation wrapper or SandboxHandle
  -> result / violation
  -> policy ledger event
```

`ask` is valid only before the side effect. Approval is scoped to the current
request, Run, and binding; it cannot broaden the binding or persist a global
profile change. `deny`, `sandbox_required`, and credential hard-deny never
create an approvable request.

### Run and resume fields

The additive Run fields are:

```ts
policyBindingId?: string;
previousPolicyBindingId?: string;
policySummary?: PublicPolicySummary;
```

`run.start`, SDK start options, and CLI selection use `policyProfile?: string`.
`run.resume` recomputes trust, capability, policy, and sandbox preflight, then
creates a new binding with `previousPolicyBindingId`. It never reuses an old
approval, provider handle, process, VM, or connection. Settings changes apply
to the next Run only.

## 6. Sandbox Provider contract

The core contract is intentionally minimal and does not select a VM, container,
or remote product:

```ts
interface SandboxProvider {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;
  prepare(binding: PolicyBinding, signal?: AbortSignal): Promise<SandboxHandle>;
  dispose(handle: SandboxHandle): Promise<void>;
}

interface SandboxHandle {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;
  execute(request: SandboxOperationRequest): Promise<SandboxOperationResult>;
}
```

The capability booleans mean a complete enforceable boundary, not a best-effort
check. A provider that cannot report a required capability is insufficient.
`legacy-host` is a compatibility marker, `host-policy` is limited local
checking, and `fake-sandbox` is test-only. Neither host mode can claim the
strong boundary required by `sandbox` enforcement for arbitrary Bash, network,
or untrusted child processes.

For `enforcement: "sandbox"`:

- no registered provider produces `sandbox_required`;
- a registered but unavailable provider produces `sandbox_unavailable`;
- a provider missing a required capability produces
  `sandbox_capability_insufficient`;
- prepare failure produces `sandbox_start_failed`;
- none of these outcomes may fall back to `host` or `legacy` execution.

The handle is bound to one PolicyBinding. After dispose, it is invalid and
cannot be reused by a later Run.

### Sandbox Operation Worker composition

The optional Sandbox Operation Worker moves a bounded operation into a trusted
child process. It is composed only through `trustedWorkerSandboxFactory`; no
project or user setting may select an executable, module path, command,
arguments, environment, or protocol endpoint. The packaged Worker uses private
stdio and never exposes a listener or public transport.

Worker preflight is side-effect-free: it validates the selected profile,
required sandbox capabilities, protocol support, and Task Credential target.
The Host activates the child and projects credentials only after the Run is
accepted. A missing capability fails closed with
`sandbox_capability_insufficient`; a missing Worker credential target fails
with `task_credential_target_unavailable`. These canonical errors were added
to close sealed-contract omissions; they are additive vocabulary, not a schema
redesign. Neither failure falls back to Host execution.

Heartbeat is process liveness only. Task Credential lease/heartbeat governs
credential TTL and revocation, while the Session writer lease/fencing contract
governs durable Host writes. None renews or substitutes for another. The
Worker cannot create an `AgentInstance`, write a Run terminal, or produce the
Host-owned `RunReceipt`.

Gondolin/QEMU is an optional local Sandbox Provider adapter. The Worker
contract does not require it, and an unavailable adapter does not authorize a
less-isolated fallback. See [Sandbox Operation Worker contract](worker-contract.md).

### Native child-agent projection

Line 12A child agents receive a distinct immutable Binding. Before spawn, the
Host projects instructions, Skills, MCP selection, model, Sandbox, Git, and
Budget from the parent Binding and persists a digest-bound proof that every
field is equal or narrower. Resource selectors use the sealed
`selectorsNarrow` relation, Budget fields use minimum limits, managed locks
cannot be removed, and Policy or Capability revision changes require an
explicit Host tightening proof. A widening fails with
`subagent_binding_projection_invalid` before provider execution.

The projection does not copy credentials, environment/header values, MCP
material, provider handles, or a Sandbox authority into the child. Child tool
operations still pass through the existing Tool Gateway and Execution Policy;
an optional Operation Worker remains a separate non-Agent execution boundary.
`in_process` and `fork` are the Line 12A implementations. The
`agent_runtime_host`, `acp`, and `sdk` descriptors freeze registration and
capability-negotiation contracts only and remain fail-closed unavailable. See
[Native Subagent Runtime Contract](subagent-contract.md).

### Provider registration and optional capabilities

Provider registration is trusted host composition, not project configuration.
The SDK accepts a provider instance through `sandboxProviders`; a caller then
selects a named profile with `policyProfile`:

```ts
import { createGondolinSandboxProvider } from "../examples/extensions/gondolin/register.ts";

const gondolinLocal = createGondolinSandboxProvider({ workspaceRoot: cwd });
await createAgentSession({
  cwd,
  policyProfile: "workspace-safe",
  sandboxProviders: [gondolinLocal],
});
```

The reference local provider ID is `gondolin-local`. A profile may select that
ID only after the trusted host has registered the matching provider instance.
Installing an extension or placing a provider package name, URL, command, or
module path in project settings does not register a provider. A strict profile
with no matching registration produces `sandbox_required`; a registered
provider that cannot start produces `sandbox_unavailable` or
`sandbox_start_failed`. Neither outcome uses host execution as fallback.

Capability booleans are claims about enforceable boundaries. In particular,
`network: false` means a strict network operation fails with
`sandbox_capability_insufficient`; it is not permission to use the host
network. If a strict Sandbox Handle does not implement `createMcpTransport`,
selected MCP stdio or HTTP operations likewise fail with
`sandbox_capability_insufficient` and never use the host MCP transport.

### Cancellation, deadlines, and unknown side effects

Provider operations observe the caller's `AbortSignal` and timeout/deadline
inputs, then release guest processes before the bound Handle is disposed. The
Provider does not write Run terminal records:

- an explicit `run.cancel` remains `run.cancelled`;
- an accepted Run deadline remains `run.failed` with
  `run_deadline_exceeded`;
- cancellation or deadline before a side effect is classified at the
  operation boundary as `cancelled` or `deadline`;
- if process termination, VM close, or a write cannot prove whether a side
  effect occurred, the operation is `side-effect-unknown`, failed closed, and
  not automatically retried.

These operation classifications do not add a Run terminal or a Policy error
code. They follow the [remote-neutral operation contract](remote-operation-contract.md)
and must remain distinguishable from policy denial and sandbox unavailability.

## 7. Stable errors and ModelBroker boundary

The complete v1 error-code set is:

```ts
type PolicyErrorCode =
  | "policy_settings_invalid"
  | "policy_profile_not_found"
  | "policy_profile_untrusted"
  | "policy_binding_failed"
  | "policy_approval_required"
  | "policy_denied"
  | "policy_violation"
  | "workspace_boundary_violation"
  | "network_policy_violation"
  | "credential_policy_violation"
  | "sandbox_required"
  | "sandbox_unavailable"
  | "sandbox_start_failed"
  | "sandbox_capability_insufficient"
  | "policy_ledger_persistence_failed";
```

Every policy error is stable, machine-readable, and non-retryable by
ModelBroker. Model fallback must never be used to bypass a policy denial,
approval, sandbox requirement, provider capability gap, credential boundary,
or policy persistence failure.

## 8. Public summary allowlist

Public policy data is constructed by allowlist, never by spreading an internal
binding, provider report, error, or operation request. The only permitted
`PublicPolicySummary` keys are:

```ts
interface PublicPolicySummary {
  bindingId: string;
  profileId: string;
  profileRevision: string;
  projectTrust: "trusted" | "untrusted";
  enforcement: PolicyEnforcement;
  sandboxProviderId?: string;
  sandboxStatus: SandboxStatus;
  sandboxCapabilities: SandboxCapabilities;
  resource: PolicyResource;
  action: PolicyAction;
  outcome: PolicyDecisionOutcome;
  reasonCode?: PolicyErrorCode;
  requestId?: string;
  timestamp: string;
}
```

The following are never public, even when a provider or Agent claims they are
safe: raw command or arguments, full or sensitive paths, cwd, environment
values, header values, tokens, ModelRuntime credentials, authorization URLs,
provider process IDs, provider temp paths, MCP server instructions, and Agent
self-reported access statements. Provider IDs and opaque binding IDs are safe
only as identifiers; they do not prove isolation by themselves.

Policy ledger custom entry names are fixed to:

```text
policy.binding
policy.decision
policy.approval
sandbox.lifecycle
policy.violation
```

Ledger payloads contain only the allowlisted metadata and fixed reason/error
codes. A ledger persistence failure is a hard failure for strict operations.

## 9. RPC, SDK, CLI, and TUI mapping

- SDK and Run options: `policyProfile?: string`; no arbitrary policy object.
- RPC `run.start` and `run.resume`: optional `policyProfile` field.
- RPC read-only command: `get_execution_policy`.
- RPC approval commands: `policy.approve` and `policy.reject`, scoped to the
  current interaction Session and binding.
- RPC `task.credential.issue`, `task.credential.heartbeat` (renew),
  `task.credential.revoke`, and `task.credential.settle` Automation Host
  commands enforce these resources through the Session's policy preflight;
  `task.credential.get` / `task.credential.list` are read-only. See
  [Remote-Neutral Operation Contract](remote-operation-contract.md) and
  [Execution Audit Contract](execution-audit-contract.md).
- CLI selector: `--policy <profile>`; there is no `--allow-all`.
- TUI `/policy`: read-only profile, enforcement, sandbox status, provider
  capability summary, and pending approval metadata; explicit
  `/policy approve <request-id>` and `/policy reject <request-id>` actions
  resolve one pending request through the current Session binding.
- Print, JSON, RPC, and other no-UI modes return
  `policy_approval_required` for `ask`; they never auto-approve.
- JSONL protocol version remains `1`; these are additive fields/commands.

## 10. Authoritative security evidence

Policy decisions may use only:

1. the locally resolved Project Trust, Capability Binding, Profile, and
   operation description;
2. checks performed by the controlled Host Operations wrapper; and
3. the registered Sandbox Provider's reported capabilities, lifecycle state,
   and execution result.

Text from the model, an external Agent, Extension, MCP server, tool result, or
user-provided description is not evidence of isolation or access. A statement
such as “I did not read outside the workspace” cannot turn a denied operation
into `allow`, satisfy a missing provider capability, or suppress a ledger
violation. The no-self-report rule applies equally to success summaries and
failure recovery.

## 11. Required T0 acceptance cases

The T0 fixture and later implementation tests must preserve these cases:

| Case | Expected result |
| --- | --- |
| No policy settings | Built-in `legacy`; existing host behavior; summary shows `legacy`. |
| Sandbox profile with no provider | `sandbox_required`; no host process, network, or file operation starts. |
| Registered provider unavailable | `sandbox_unavailable`; no fallback to host/legacy. |
| Provider lacks a required capability | `sandbox_capability_insufficient`; no side effect. |
| Project asks to widen a user deny or provider | `policy_profile_untrusted` or `policy_denied`; never approval. |
| Operation returns `ask` in headless mode | `policy_approval_required`; no side effect and no auto-approval. |
| Agent/Extension/MCP self-report says access was safe | Self-report ignored; local policy/provider evidence remains authoritative. |
| Settings change during a Run | Existing immutable binding remains unchanged; next Run resolves again. |
| Resume | New binding and handle; old approval and handle are not reused. |

T0 owns this contract document and the fixture test only. Production types,
settings integration, lifecycle wiring, sandbox execution, RPC/CLI behavior,
and provider adapters belong to T1-T7.
