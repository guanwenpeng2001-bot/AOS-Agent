# Execution Audit / Replay / External Mapping Contract (v1)

This document freezes the v1 boundary for the Execution Audit, read-only
Replay, and external Session/Run mapping work. It is based on the existing
Run, Context, Capability, ModelBroker, Policy, Sandbox, Session, and RPC
contracts reviewed for the supplied audit/replay PR and implementation plan.
The contract and independent fixture `test/fixtures/execution-audit-contract.ts`
were introduced during T0. The current implementation folds existing ledgers
into this contract and adds only the explicitly listed RPC and mapping
behavior; it does not introduce a second audit ledger.

The fixture is the machine-checked list of scalar values and public field
shapes. This document defines their meaning, source mapping, and security
boundary.

## 1. Version, commands, and source mapping

The v1 schema version is `1`. The additive Automation Host commands are:

```text
audit.query
audit.replay
external.map
```

The existing `get_entries`, `get_execution_policy`, `policy.approve`,
`policy.reject`, and Run commands retain their current semantics. Audit query
and replay are read-only. Within the audit commands, `external.map` is the
only operation that may append a Session custom entry; a later additive
`run.start`/`run.resume` integration may append its validated mapping as part
of Run acceptance. Task Gate transitions append their own `task.gate` custom
entries through the Automation Host control plane
(`task.gate.request`/`approve`/`reject`/`cancel`); the audit adapter only
reads them and never mutates Gate state.

The adapter folds existing Session custom entries into audit events. It does
not create a second event ledger.

| Source custom type | Audit event type(s) | Correlation authority |
| --- | --- | --- |
| `automation.run` | `run.accepted`, `run.started`, `run.completed`, `run.failed`, `run.cancelled` | Run record and receipt `runId` |
| `automation.run` without a persisted terminal receipt | derived `run.interrupted` | accepted/started Run record; no synthetic persisted terminal |
| `model.binding` | `model.binding` | `modelBindingId`; ambiguous reuse is not guessed |
| `model.attempt` | `model.attempt` | `bindingId` through a model binding |
| `context.snapshot` | `context.snapshot` | snapshot `runId` when present |
| `capability.binding` | `capability.binding` | `capabilityBindingId` on the Run record |
| `policy.binding` | `policy.binding` | policy binding `runId` |
| `policy.decision` | `policy.decision` | `bindingId` through policy binding |
| `policy.approval` | `policy.approval` | `bindingId` through policy binding |
| `sandbox.lifecycle` | `sandbox.lifecycle` | `bindingId` through policy binding |
| `policy.violation` | `policy.violation` | `bindingId` through policy binding |
| `external.mapping` | `external.mapping` | mapping `aosSessionId` and optional `aosRunId` |
| `remote.operation` | `remote.operation` | receipt `sessionId` and optional `runId` |
| `task.gate` | `task.gate` | `gateId`; optional `runId` for direct Run correlation |

`context.memory` is deliberately not an audit source. It contains explicit
user text and must not be made visible through an audit summary. Unknown
custom types and malformed known entries never expose their raw `data`.

The source files that establish these facts are:

- `src/core/run-lifecycle.ts` for Run and capability ledgers and public Run
  serializers;
- `src/core/context-engine.ts` for metadata-only snapshots;
- `src/core/capability-registry.ts` for opaque capability identifiers;
- `src/core/model-broker-ledger.ts` and `src/core/model-broker.ts` for model
  binding, attempt, and fallback facts;
- `src/core/execution-policy.ts` and `src/core/execution-policy-ledger.ts`
  for policy and Sandbox facts;
- `src/core/sandbox.ts` for the side-effecting provider boundary;
- `src/core/session-manager.ts` for Session entry identity and file scope;
- `src/core/task-gate.ts` for Task Gate record, transition, and fold facts;
- `src/modes/rpc/rpc-types.ts` and `src/modes/rpc/rpc-mode.ts` for existing
  public RPC behavior.

## 2. AuditEvent v1

The exact event-type union is:

```ts
type AuditEventType =
  | "run.accepted"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "model.binding"
  | "model.attempt"
  | "context.snapshot"
  | "capability.binding"
  | "policy.binding"
  | "policy.decision"
  | "policy.approval"
  | "sandbox.lifecycle"
  | "policy.violation"
  | "external.mapping"
  | "remote.operation"
  | "task.gate";
```

Every event has this base shape:

```ts
interface AuditEventBase {
  schemaVersion: 1;
  eventId: string;
  recordedAt: string;
  sessionId: string;
  sourceEntryId: string;
  external?: ExternalExecutionRef;
}
```

The discriminated union is:

```ts
type AuditEvent =
  | (AuditEventBase & { type: "run.accepted"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "run.started"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "run.completed"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "run.failed"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "run.cancelled"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "run.interrupted"; runId: string; summary: AuditRunSummary })
  | (AuditEventBase & { type: "model.binding"; runId?: string; summary: AuditModelBindingSummary })
  | (AuditEventBase & { type: "model.attempt"; runId?: string; summary: AuditModelAttemptSummary })
  | (AuditEventBase & { type: "context.snapshot"; runId?: string; summary: AuditContextSnapshotSummary })
  | (AuditEventBase & { type: "capability.binding"; runId?: string; summary: AuditCapabilityBindingSummary })
  | (AuditEventBase & { type: "policy.binding"; runId?: string; summary: AuditPolicySummary })
  | (AuditEventBase & { type: "policy.decision"; runId?: string; summary: AuditPolicySummary })
  | (AuditEventBase & { type: "policy.approval"; runId?: string; summary: AuditPolicyApprovalSummary })
  | (AuditEventBase & { type: "sandbox.lifecycle"; runId?: string; summary: AuditSandboxLifecycleSummary })
  | (AuditEventBase & { type: "policy.violation"; runId?: string; summary: AuditPolicyViolationSummary })
  | (AuditEventBase & { type: "external.mapping"; runId?: string; summary: ExternalExecutionMapping })
  | (AuditEventBase & { type: "remote.operation"; runId?: string; summary: RemoteOperationReceipt })
  | (AuditEventBase & { type: "task.gate"; runId?: string; summary: AuditTaskGateSummary });
```

`sourceEntryId` is the outer SessionEntry `id`, not an inner ledger sequence
or binding identifier. `recordedAt` is the outer SessionEntry `timestamp` and
must be a canonical ISO timestamp. A direct source event uses its
`sourceEntryId` as `eventId`. A derived interruption uses the deterministic
event id `${sourceEntryId}:interrupted`; it is a read-time fact and is never
appended to the Session.

Events are sorted lexically by this complete key:

```text
(recordedAt, sessionId, sourceEntryId, eventId)
```

The timestamp is not a sufficient cursor key. The complete key is required to
avoid duplicates and omissions when entries share a timestamp. No random ID,
current clock value, or process-local sequence may be used to change event
identity during replay.

## 3. Safe summary allowlists

All summaries are constructed by explicit field copies from the existing
public serializers. Spreading a source object is not allowed. Optional fields
are omitted rather than emitted as raw `undefined` or as a source-specific
extension.

### Run summary

`AuditRunSummary` permits only:

```text
status, attempt, model, sourceRunId, previousBindingId,
capabilityBindingId, modelBindingId, previousModelBindingId,
policyBindingId, previousPolicyBindingId, contextSnapshotId,
startedAt, endedAt, terminalError, finalModel, modelBudget
```

The primary Run model uses `{ provider, id, thinkingLevel }`. The optional
final model uses `{ provider, id?, modelId?, thinkingLevel? }`. A terminal
error is reduced to `{ code, retryable }`; its message is not an audit field.
Run receipt `finalText`, `usage`, and `sessionFile` are intentionally not part
of an audit Run summary, even though the current public receipt serializer
still supports them for existing Run consumers.

`run.interrupted` has `status: "interrupted"` and is derived only when a
persisted accepted/started Run has no persisted `completed`, `failed`, or
`cancelled` receipt. It must not fabricate a terminal status, receipt, error,
or end time.

### ModelBroker summaries

`model.binding` permits:

```text
bindingId, mode, routeId, role, candidates, fallback, budget,
configRevision, createdAt, previousModelBindingId
```

Each candidate is `{ order, model }`, where `model` is
`{ provider, modelId, thinkingLevel? }`. `fallback` is
`{ maxAttempts, on }`; `budget` permits only
`maxModelCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, and
`maxCostUsd`.

`model.attempt` permits:

```text
attemptId, bindingId, candidate, order, status, startedAt, endedAt,
failureCategory, usage, visibleOutput, contextSnapshotId, summary
```

`usage` permits only `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`
and the existing compatibility aliases `input`, `output`, `total`, `cost`.
`summary` is short already-safe text. It must be omitted if it still resembles
a URL or a filesystem path. Model binding and attempt entries have no Run ID;
the adapter may attach `runId` only through an unambiguous binding relation.

### Context snapshot summary

`context.snapshot` permits:

```text
schemaVersion, id, purpose, sessionId, runId, createdAt,
parentSnapshotId, sources, budget
```

Each source permits only:

```text
kind, scope, trust, visibility, contentDigest, estimatedTokens,
disposition, reason
```

The budget permits only `contextWindow`, `reserveTokens`, `inputLimit`, and
`estimatedInputTokens`. Source IDs, labels, paths, reference IDs, raw bodies,
messages, system prompts, and capability source identity are excluded. The
existing Context public serializer may retain opaque capability provenance for
other public consumers; the Audit summary omits it to keep source identity
out of this contract.

### Capability summary

`capability.binding` permits:

```text
id, profile, createdAt, descriptors, decisionSummary, toolAllowlist
```

Each descriptor permits `{ id, revision, exposedToolName? }` only when the ID
and revision pass the existing opaque-identifier checks. `decisionSummary`
permits `{ allowed, awaitingApproval, denied }`. Raw descriptor IDs,
extension paths, MCP configuration, server instructions, environment values,
headers, credentials, and tool call data are never copied.

### Policy and Sandbox summaries

`policy.binding` and `policy.decision` use the exact existing
`PublicPolicySummary` allowlist:

```text
bindingId, profileId, profileRevision, projectTrust, enforcement,
sandboxProviderId, sandboxStatus, sandboxCapabilities, resource, action,
outcome, reasonCode, requestId, timestamp
```

`sandboxCapabilities` permits only the booleans `filesystem`, `process`,
`network`, and `credentialIsolation`.

`policy.approval` permits:

```text
id, requestId, bindingId, resource, reasonCode, createdAt, outcome, source, scope
```

`scope` permits only `resource`, `workspaceScopes`, `environmentCount`,
`destinationCount`, and `credentialCount`. Approval reason text is not
returned. `sandbox.lifecycle` permits `bindingId`, `status`, `timestamp`,
`providerId`, `capabilities`, and `reasonCode`. `policy.violation` permits
`bindingId`, `timestamp`, `reasonCode`, `resource`, and `requestId`.

Internal policy `workspaceIdentity`, `constraints`, and `bindingHash` are not
public audit fields. A policy event is correlated to a Run through the policy
binding's `runId`; raw operation requests are never included.

### External mapping summary

`external.mapping` contains only the mapping keys in section 4. It never
contains an external payload, prompt, callback data, URL, token, request
headers, or provider diagnostic.

### Remote operation summary

`remote.operation` contains the validated terminal `RemoteOperationReceipt`
and no raw request, provider exception, transport detail, payload, path, URL,
credential, or secret. A receipt may carry a public-safe binding association so
an orchestrator can join the operation to the Run's ModelBroker, Capability,
Policy, and Sandbox facts. The optional Session ledger sink writes this fact
through the existing append-only Session custom-entry API; it does not create
a second execution ledger.

### Task Gate summary

`task.gate` events are produced from `task.gate` Session custom entries. Each
legal transition — `requested`, `approved`, `rejected`, or `cancelled` —
produces exactly one event; the `eventId` is the outer Session entry
identity, never a random ID or an in-memory sequence.

`AuditTaskGateSummary` permits only:

```text
gateId, taskId, stageId, stageRevision, action, status, revision,
requestedAt, decidedAt, runId, actorId, reasonCode
```

`action` is `requested`/`approved`/`rejected`/`cancelled` and `status` is
`pending`/`approved`/`rejected`/`cancelled`. `decidedAt` and `reasonCode` are
present only when defined by the transition. `runId` is the optional direct
correlation to the stage's Run. `clientRequestId` participates in the
internal idempotency fold but never enters the public summary.

Task Gate events never contain the task body, stage description, prompt,
diff, command, arguments, working directory or path, file content,
stdout/stderr, environment or header values, credentials, model output,
provider errors, approval free text, or raw custom-entry `data`. `actorId` is
an operator label, not an authentication claim.

The fold applies the same malformed-entry rules as every other source: an
entry whose `sessionId` does not match the Session, an unsupported schema, an
unsafe identifier, a non-contiguous `revision`, an illegal status jump, or a
second terminal for the same `gateId` is rejected with the existing warnings
(`malformed_source`, `unsupported_schema`, `duplicate_source`, or
`orphan_source`) and never enters public Gate state or audit events. Replay
and query never backfill a missing transition and never fabricate a decision.

### Forbidden keys

The following keys are forbidden at every summary nesting level:

```text
data, raw, prompt, message, messages, finalText, command, args, cwd,
path, targetPath, content, output, url, payload, callback, stdout, stderr,
env, environment, headers,
token, authorization, credentials, authorizationUrl, providerPid, tempPath,
sessionFile, workspaceIdentity, constraints, bindingHash, providerError, stack,
instructions, serverInstructions, agentSelfReport, details
```

An unknown key is not preserved merely because it appears in a current source
entry. Unknown source data produces a warning, not a generic summary field.

## 4. ExternalExecutionRef and mapping

The exact reference shape is:

```ts
interface ExternalExecutionRef {
  namespace: string;
  externalSessionId: string;
  externalRunId?: string;
}
```

The exact mapping shape is:

```ts
interface ExternalExecutionMapping {
  namespace: string;
  externalSessionId: string;
  externalRunId?: string;
  aosSessionId: string;
  aosRunId?: string;
  createdAt: string;
  source?: string;
  correlationId?: string;
}
```

The persisted custom entry is `customType: "external.mapping"` with a
schema-versioned payload containing exactly the mapping object above:

```ts
{
  schemaVersion: 1,
  mapping: ExternalExecutionMapping,
}
```

`createdAt` is server-generated. `source` and `correlationId` are optional,
bounded, safe identifiers only; they are not a place for an external payload.
All IDs must be non-empty when required, have no control characters, and be
validated as identifiers rather than URLs, paths, commands, or serialized
objects. The absence of `externalRunId` or `aosRunId` is distinct from an
empty value; empty optional values are invalid.

The external uniqueness key is:

```text
(namespace, externalSessionId, externalRunId or ABSENT)
```

The AOS uniqueness key is:

```text
(namespace, aosSessionId, aosRunId or ABSENT)
```

The same key mapping to the same target is idempotent success. A key mapping
to a different target returns `external_mapping_conflict`. The same AOS Run
cannot map to two different external Run IDs in one namespace. Append-only
replay that finds contradictory mappings emits `mapping_conflict` and does
not choose a winner or overwrite an existing mapping.

`run.start` and `run.resume` may accept an optional `external` reference. The
reference is scoped to the current AOS Session, and the conflict check happens
before Run acceptance, using the proposed AOS Run ID when an AOS Run ID is
required. `external.map` may bind an existing Run after creation; a successful
post-creation mapping is immediately visible from the live Run and survives
coordinator restart. If the mapping entry cannot be durably persisted, the
operation returns `audit_persistence_failed` and must not acknowledge an
unpersisted mapping. It must not delete or rewrite an earlier append-only
entry.

Mappings do not enter LLM context and do not affect ModelBroker fallback,
Capability selection, Policy approval, or Sandbox execution.

## 5. Query scope, filtering, and pagination

`audit.query` accepts:

```ts
interface AuditQuery {
  scope: "current-session" | "session-directory";
  sessionId?: string;
  runId?: string;
  external?: ExternalExecutionRef;
  types?: AuditEventType[];
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
```

The result is:

```ts
interface AuditQueryResult {
  schemaVersion: 1;
  scope: "current-session" | "session-directory";
  events: AuditEvent[];
  nextCursor?: string;
  warnings: AuditWarning[];
}
```

Scope rules are fixed:

- `current-session` reads only the Session already bound to the RPC host. A
  supplied `sessionId`, when present, must equal that Session ID.
- `session-directory` reads only candidate Session files below the current
  configured Session root. The caller cannot provide an absolute path,
  relative path, workspace path, or alternate root.
- Candidate paths must resolve under the configured root and be regular files;
  symlink traversal outside the root is rejected. A single unreadable Session
  produces `source_unavailable` rather than a path or stack trace.
- The adapter must not use the unscoped `SessionManager.listAll()` discovery
  path because it enumerates all global Session directories.

Filters are exact matches. Wildcards and arbitrary custom types are invalid.
`types` is canonicalized as a deduplicated list in the query fingerprint.
`from` is inclusive and `to` is exclusive; both must be canonical ISO
timestamps and `from` must not be later than `to`. `external` matches the
complete namespace/session/run reference, with absence of `externalRunId`
matching only a mapping whose external Run ID is absent.

The default `limit` is `50`. A supplied limit must be an integer in the range
`1..200`; `200` is the server maximum. Filtering happens before safe summary
conversion and pagination. Events are deduplicated by source identity and
then sorted by `(recordedAt, sessionId, sourceEntryId, eventId)`.

The cursor is opaque, versioned, and integrity-protected by the server. It
binds the complete canonical query fingerprint, including scope, every filter,
time bounds, and limit, and carries the complete last sort key. A malformed or
query-mismatched cursor returns `audit_cursor_invalid`; it must never silently
restart from the first page. `nextCursor` is omitted when no event remains.

The query response's warnings contain only a stable code and safe source/event
identifiers. They never contain a raw `customType`, raw `data`, local path,
exception message, or stack.

## 6. Replay status, warnings, and errors

`audit.replay` requires `runId` and accepts the same opaque `cursor` and
`limit` rules as query. It returns one Run's safe summary, event page,
optional `nextCursor`, `status`, and warnings:

```ts
type AuditReplayStatus = "complete" | "interrupted" | "incomplete";

interface AuditReplayResult {
  schemaVersion: 1;
  run: AuditRunSummary;
  events: AuditEvent[];
  nextCursor?: string;
  status: AuditReplayStatus;
  warnings: AuditWarning[];
}
```

The status rules are:

| Status | Required meaning |
| --- | --- |
| `complete` | A persisted `completed`, `failed`, or `cancelled` terminal fact exists and every relevant source fact included in the replay is safely parseable and unambiguously associated. |
| `interrupted` | An accepted/started Run fact exists, no persisted terminal fact exists, and the available Run events can be safely read. No terminal status is fabricated. |
| `incomplete` | A relevant source is malformed, unsupported, unavailable, contradictory, or cannot be associated unambiguously; safe events and warnings are returned when possible. |

Unknown custom entries are never returned. A query reports an unknown source as
a warning. Replay reports `incomplete` when an unknown, malformed, unsupported,
unavailable, contradictory, or ambiguous source could affect the requested
Run; an unrelated source remains a warning-only condition. The adapter must
conservatively choose `incomplete` when it cannot prove that a source is
unrelated.

The stable warning union is:

```ts
type AuditWarningCode =
  | "unknown_source"
  | "malformed_source"
  | "unsupported_schema"
  | "orphan_source"
  | "duplicate_source"
  | "source_unavailable"
  | "ambiguous_run_association"
  | "mapping_conflict";
```

Warning semantics are:

- `unknown_source`: an unrecognized custom type was encountered; raw type and
  data are not echoed;
- `malformed_source`: a recognized entry has invalid shape or required fields;
- `unsupported_schema`: a recognized entry has a schema version not supported
  by this adapter;
- `orphan_source`: a recognized source cannot be associated with any known Run
  or binding;
- `duplicate_source`: the same source identity occurs more than once;
- `source_unavailable`: a permitted Session source could not be read;
- `ambiguous_run_association`: a binding or source could map to multiple Runs;
- `mapping_conflict`: append-only mapping facts contradict each other.

Task Gate replay association is by direct `runId` only:

- A `task.gate` event whose summary `runId` equals the replayed Run's `runId`
  is included as a control-plane correlation event.
- A `task.gate` event without `runId` is never associated to a Run by
  `taskId` or by any other guess.
- Gate events are correlation facts only. They do not participate in Run
  terminal status selection and cannot change a replay's `complete`,
  `interrupted`, or `incomplete` determination, which remains based on the
  Run and other existing sources.
- Replaying or querying a Gate never approves, rejects, or cancels it, and
  never appends a transition.

Warnings are safe records with only `code` and optional safe
`sessionId`/`sourceEntryId`/`eventType`/`schemaVersion` fields. They contain no
free-form detail.

The exact command error-code union is:

```ts
type AuditErrorCode =
  | "audit_query_invalid"
  | "audit_cursor_invalid"
  | "audit_scope_unavailable"
  | "audit_run_not_found"
  | "audit_replay_incomplete"
  | "external_mapping_invalid"
  | "external_mapping_conflict"
  | "audit_persistence_failed";
```

All eight errors are stable, non-retryable control-plane errors. Their public
messages, if an RPC envelope requires one, are generic and contain no source
error, path, stack, prompt, command, or raw payload.

`audit_run_not_found` means no accepted Run fact exists for the requested
`runId`. A readable Run with damaged or missing auxiliary facts is a successful
replay response with `status: "incomplete"` and warnings. The
`audit_replay_incomplete` error is reserved for an implementation boundary
where a Run was identified but no safe `AuditReplayResult` can be constructed
at all; it must not replace a safe partial result. This resolves the supplied
plan's error-code table with its explicit `incomplete` status.

Audit errors never trigger ModelBroker fallback, a model call, a tool call,
MCP or Extension execution, Policy approval/rejection, Sandbox lifecycle, or
Session/Run mutation.

## 7. Side-effect prohibitions

`audit.query` and `audit.replay` may only read in-memory Session entries,
permitted Session files, and the existing pure/public serializers. They must
not call:

- `Run.start`, `run.resume`, `run.cancel`, AgentSession prompt/steer/follow-up,
  or any model/provider API;
- ModelBroker provider resolution as an execution operation or ModelBroker
  fallback;
- tool, Bash, MCP, Extension, or Skill execution;
- Policy authorization, approval, rejection, or profile mutation;
- `SandboxProvider.prepare`, `execute`, or `dispose`;
- `SessionManager.appendCustomEntry`, Session switching, Session forking, or
  context-memory writes;
- TaskGateStore mutations (`task.gate.request`, `task.gate.approve`,
  `task.gate.reject`, `task.gate.cancel`).

Replay of a historical `policy.approval` is an observation only. It never
reopens or resolves the request. Reading a Sandbox lifecycle fact never
prepares, executes, or disposes a Sandbox. Replay of a historical `task.gate`
transition is an observation only; it never resolves, reopens, or rewrites
the Gate.

`external.map` is limited to validation, conflict checking, and appending the
exact schema-versioned mapping entry. It does not execute a Run, model,
tool, MCP server, Extension, Policy operation, or Sandbox. If the existing
Session append path cannot prove durable persistence for the mapping, the
operation must fail with `audit_persistence_failed` rather than acknowledge a
possibly deferred write.

## 8. T0 acceptance cases and ownership

The reusable fixture freezes these cases:

| Case | Expected result |
| --- | --- |
| Persisted terminal Run | replay `complete` |
| Accepted/started Run with no terminal | replay `interrupted`; no fabricated terminal |
| Malformed relevant source | replay `incomplete` plus `malformed_source` |
| Unknown source during query | warning-only; raw data absent |
| Missing Run | `audit_run_not_found` |
| Invalid or mismatched cursor | `audit_cursor_invalid` |
| Conflicting external mapping request | `external_mapping_conflict` |
| Contradictory append-only mappings | `mapping_conflict` warning; no winner selected |
| `task.gate` entries | safe `task.gate` events with allowlisted summaries |
| Gate with matching `runId` in Run replay | included as non-terminal correlation event |
| Gate without `runId` | never guessed into any Run |
| Malformed `task.gate` entry | warning only; never in public state or audit events |
| Mapping persistence failure | `audit_persistence_failed`; no success acknowledgement |
| Query or replay | no model, tool, MCP, Extension, Policy, Sandbox, Session, or Run side effect |

The contract fixture and test remain the machine-checked boundary. The current
integration also covers the adapter, controlled directory query/replay,
append-only mapping persistence, Run lifecycle, RPC/client additions, and
cross-layer regression cases. Existing Run lifecycle, Context snapshot,
Capability binding, ModelBroker fallback, Policy/Sandbox, Session
custom-entry, and RPC behavior remain unchanged outside the additive v1
surface.
