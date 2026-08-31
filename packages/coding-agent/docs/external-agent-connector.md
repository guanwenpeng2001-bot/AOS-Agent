# External Agent Connector

## Status

settings entry composition is implemented; final promotion gate (multi-platform smoke, upgrade, soak, vendor certification) is not done; do not claim product readiness.

`ExternalAgentConnector` is the only public execution contract for an external
agent. It implements the shared `TaskExecutorProvider` boundary and therefore
enters the same executor pool as every other provider. An external run uses the
canonical Task, Dispatch, AgentBinding/BindingEpoch, Attempt, AttemptReceipt,
TaskResult, and RunReceipt facts; it never creates an `AgentInstance`.

## Trusted composition

The Host constructs connectors and registers them in one
`ExternalConnectorRegistry`. Registration accepts an exact descriptor and one
trusted connector instance. It never accepts a module path, command, endpoint,
environment, credential, vendor name, or product fallback.

```ts
import {
  createAgentRuntimeCompositionFactory,
  createExternalConnectorRegistry,
} from "aos-agent";

const registry = createExternalConnectorRegistry();
await registry.register({ descriptor, connector });

const runtimeComposition = createAgentRuntimeCompositionFactory({
  externalConnectorRegistry: () => registry,
});
```

Trust is derived from Host composition: the Host creates the registry, constructs
the connector instance, and supplies that registry to the runtime composition.
Registration has no caller-controlled trust flag, so a connector cannot
self-attest as trusted.

Standard CLI, RPC, and SDK Session creation also accepts an `externalConnectors`
settings catalog. This is a narrow fallback authority: when a trusted Host passes
`runtimeComposition`, that composition wins as a whole and no settings field is
merged into it. When the Host omits the composition, settings may populate only
the External Connector target and registry slice. Settings never enable the
Scheduler, Worker, Subagent, Tool Gateway, or credential authorities.

## Settings registration

Define targets in user settings and select one with `targetId`:

```json
{
  "externalConnectors": {
    "schemaVersion": 1,
    "targetId": "example-jsonl",
    "targets": [
      {
        "schemaVersion": 1,
        "targetId": "example-jsonl",
        "providerId": "example.external-connector",
        "executablePath": "/absolute/path/to/node",
        "modulePath": "/absolute/path/to/driver.mjs",
        "cwd": "/absolute/trusted/workspace",
        "version": "1",
        "executableIdentity": "sha256:<hex>",
        "moduleIdentity": "sha256:<hex>",
        "capabilityCeiling": {
          "modelAccess": ["none"],
          "resume": true,
          "toolGateway": false,
          "artifacts": false,
          "images": false
        }
      }
    ]
  }
}
```

Global settings own target definitions. A trusted project may select a global
`targetId` and narrow `capabilityCeiling`; its optional `role` selection may
narrow again. Project and Role values are rejected unless the existing project
trust decision is true. `accountReference`, when present, is an opaque account
identity; credentials, environment values, headers, and tokens are never stored
in this schema.

The selected target may be the packaged fake or a generic JSONL process target.
For a generic target, the Host starts `executablePath` with `modulePath` as its
module argument (when the paths differ), then connects the resulting process to
the private JSONL driver adapter. It does not dynamically import a settings
module or let the target choose a private vendor driver. Every target is still
constructed through production provenance checks, process containment,
supervision, and the durable connector runtime; a target that fails those checks
remains fail-closed. A generic target whose selected capability ceiling resolves
to `modelAccess: "aos_gateway"` is rejected with
`external_connector_config_invalid`; generic settings targets may advertise only
`none` or `agent_owned`, so no generic JSONL driver consumes a Host model
projection or translation.

The descriptor pins `providerId`, `providerClass: "external_connector"`,
`revision`, and the capability snapshot digest. A selection must repeat those
mutable identity fields exactly. Registry selection revalidates the pinned
capability snapshot before execution.

## Driver developer SPI (JSONL)

The public interoperability contract for a generic target is a bounded JSONL
protocol, not a TypeScript interface. The Host starts one configured executable
under its process supervisor and passes the configured module path as the
argument when the executable and module paths differ. The driver reads and
writes
one UTF-8 JSON object per line on that exact process's standard input and
output. It must not start a companion process, create a second channel, or
write Foundation Attempts, mappings, or receipts.

ExternalConnectorVendorDriver is a package-private Host adapter under
src/core/connector/vendor. It is not exported from the package root or from
any public subpath, including aos-agent/external-connector. A driver author
implements this JSONL contract; the public application contract remains
ExternalAgentConnector.

### Envelope, correlation, and limits

The protocol and schema versions are both 1. Every frame is one UTF-8 JSON
object terminated by LF. Host-written lines contain no embedded CR or LF. The
frame itself, including its nested payload, is limited to 256 KiB (262,144
bytes). The Host may apply stricter runtime limits; the default supervisor
limits are at most 256 events, 64 events per one-second window, 64 artifact
references, and 4 MiB total observed event and terminal-evidence bytes. Drivers
should bound their own queues to the same or smaller limits.

The following fields are exact and are never optional in the frame kinds that
carry them:

| Field | Meaning |
| --- | --- |
| schemaVersion | Literal 1 on every frame. |
| requestId | Host-generated unique id for a handshake or operation request. A response or error must echo it exactly. It is not present on event frames. |
| streamId | The requestId of an events request. It is required on event and events_end frames and must identify one active stream. |
| operation | The operation named by a request, response, or error: spawn, events, connect, lookup, read, write, heartbeat, cancel, or dispose. An error may also name handshake. |
| supervisorRef | Opaque Host identity for the supervised process. Echo it exactly. |
| operationNonce | Opaque Host nonce for this process Attempt. Echo it exactly on every frame. |

Host-to-driver frames are handshake and request. Driver-to-Host frames are
handshake_result, response, error, event, and events_end. The outer objects
have exact keys: unknown or missing fields are rejected fail-closed; they are
not ignored or forwarded. Payloads must be Foundation JSON. Typed nested values
such as handles, mappings, routes, tool requests, and terminal evidence also
reject unknown fields at their validation boundary. An `artifact` object nested
inside an artifact event or terminal evidence is canonicalized from its known
fields (`schemaVersion`, `artifactId`, `mediaType`, `digest`, and optional
`sizeBytes`); extra fields are discarded. The enclosing event and terminal
evidence objects still enforce their exact outer keys.

The 256 KiB frame limit, UTF-8/LF framing rule, exact-key rule, and stable error
policy above apply to every row in the following frame matrix. The matrix calls
out the row-specific request id or stream id and operation correlation.

| Frame | Direction | Required fields | Optional fields | Correlation and stable rejection |
| --- | --- | --- | --- | --- |
| handshake | Host -> driver | schemaVersion, type: "handshake", requestId, supervisorRef, operationNonce, protocolVersion: 1, providerId, version, capability | None | requestId, supervisorRef, and operationNonce are current Host values. Host validation failures are external_event_invalid; a Host-written oversized frame is external_frame_oversize. A handshake that receives a parsed frame other than handshake_result may be external_protocol_unsupported. |
| handshake_result | Driver -> Host | schemaVersion, type: "handshake_result", requestId, supervisorRef, operationNonce, protocolVersion: 1, providerId, version, capability, implementedOperations | None | Echo all three ids. A protocolVersion other than 1 is an unsupported shape at parse time and the pump folds it to external_event_invalid; identity, capability, or operation drift is external_capability_mismatch; other malformed responses are external_event_invalid. |
| request | Host -> driver | schemaVersion, type: "request", requestId, operation, supervisorRef, operationNonce, payload | None | The response must use the same requestId, operation, ref, and nonce. The driver returns an error frame for a rejected request. |
| response | Driver -> Host | schemaVersion, type: "response", requestId, operation, supervisorRef, operationNonce, result | None | Unknown, duplicate, late, or operation-mismatched responses are external_event_invalid. Result shape is checked after request correlation. |
| error | Driver -> Host | schemaVersion, type: "error", requestId, operation, supervisorRef, operationNonce, code, message | None | Echo the request correlation. code is a lower-case stable identifier (maximum 128 characters); message is bounded to 512 characters and must not contain secrets or raw diagnostics. |
| event | Driver -> Host | schemaVersion, type: "event", streamId, supervisorRef, operationNonce, event | None | streamId must be an active events request id. Unknown, duplicate, late, or wrong-channel events are external_event_invalid. |
| events_end | Driver -> Host | schemaVersion, type: "events_end", streamId, supervisorRef, operationNonce | None | Ends the active stream exactly once. A duplicate or late end is external_event_invalid. |

The Host accepts no vendor-specific error taxonomy as a public contract.
Drivers should use the stable codes below and keep the message fixed and
redacted:

| Condition | Stable code |
| --- | --- |
| Malformed JSON, unknown fields, invalid typed payload, wrong ref/nonce, duplicate or late response/event | external_event_invalid |
| Handshake receives a parsed frame other than handshake_result (if that branch exists) | external_protocol_unsupported |
| Mismatched provider/version/capability digest or missing required behavior | external_capability_mismatch or external_connector_not_ready |
| Host outbound JSONL frame exceeds its bound | external_frame_oversize |
| Supervised item exceeds a runtime resource bound | external_resource_limit_exceeded |
| Process channel is absent or unavailable | external_connector_unavailable |
| Host route is outside the frozen Tool Gateway scope or the catalog changed | external_tool_route_denied |
| Required external lease is absent, expired, or revoked | external_credential_unavailable |
| Terminal state or process cleanup cannot be proven | external_terminal_ambiguous or side_effect_unknown |
| Target settings or provenance are invalid | external_connector_config_invalid or external_connector_executable_untrusted |

Error-code direction matters. The Host JSONL `#send` path maps an outbound frame
whose size assertion fails to `external_frame_oversize`. An inbound line that
exceeds the process-channel limit fails that channel with an ordinary `Error`;
if an inbound line is delivered but JSON parsing or frame validation fails, the
JSONL pump folds it into `external_event_invalid`, including a
`handshake_result` whose `protocolVersion` is not 1. `external_protocol_unsupported`
is reserved for a handshake receiving a parsed frame other than
`handshake_result`, if that branch exists. An inbound oversized line is not
stably mapped to `external_frame_oversize`.

These codes describe Host-visible outcomes as well as driver error responses;
the Host may replace an unsafe vendor error with the corresponding fixed
message. It never exposes a raw path, environment value, credential, or vendor
stack trace through this protocol.

### Handshake and capability declaration

The Host sends handshake before the first operation on a channel, after
provenance validation and process activation. The capability object is an exact
immutable snapshot:

| Field | Required shape |
| --- | --- |
| schemaVersion | Literal 1. |
| providerId | Target provider identifier. |
| revision | Positive integer snapshot revision. |
| protocol | { name: string, version: string }. |
| modelAccess | none, agent_owned, or aos_gateway. Settings-selected generic JSONL targets may use only none or agent_owned; the generic factory rejects a selected aos_gateway ceiling. |
| resume, toolGateway, artifacts, images | Boolean capability flags. |
| digest | { algorithm: "sha256", value: string }, matching the fingerprint of the preceding immutable fields. |

The driver must return handshake_result with the exact Host providerId,
version, protocol version, capability snapshot, and ids. Its
implementedOperations list must contain all nine base operations: spawn,
events, connect, lookup, read, write, heartbeat, cancel, and dispose. When
toolGateway is true it must also contain both tool_gateway_request and
tool_gateway_result; entries must be known and unique.

Capability flags are claims, not permissions. Registration and every selection
recheck use the Host adapter behavior manifest as the capability evidence for
each true behavior. In particular, `toolGateway: true` requires a manifest
containing the `tool_gateway_request` event and `tool_gateway_result` write
behavior. The Host binds and checks this manifest before registration and
rechecks it during selection; settings registration does not start the process.

Separately, after the persist-before-activate boundary, the process JSONL
handshake returns `implementedOperations` before the first `spawn`, `connect`,
or `lookup`. This runtime declaration is checked against the trusted
capability; it is not the registration-time behavior evidence. A missing,
stale, or changed declaration fails closed before a provider effect with
`external_connector_not_ready` or `external_capability_mismatch`; the Host
never waits for an event to decide whether a capability was real.

### Operation requests and responses

Every operation below is a request frame with the common envelope and one
required payload; there are no optional envelope keys. The successful result
is returned in a matching response frame. The events operation is the one
streaming exception: it has no response frame, and the driver must signal a
stream failure by ending the process/channel rather than sending an unsolicited
response. Other operations may return a matching error frame instead.

| Operation | Request payload: required fields | Optional fields | Successful response.result |
| --- | --- | --- | --- |
| spawn | attempt, correlation, input, capability, bindingDigest, bindingRevision | modelProjection, modelTranslation, credential, mcpSelection, toolGatewayRoutes | A handle with externalSessionId, supervisorRef, and operationNonce; externalTurnId may be present. |
| events | A handle | None | Streaming operation: emit event frames and one events_end; do not send a response or error frame for this request. |
| connect | A canonical mapping | None | A handle matching the mapping and current channel ref/nonce. |
| lookup | A canonical mapping | None | { status: "running", handle }, { status: "terminal", evidence }, { status: "missing" }, or { status: "ambiguous" }. |
| read | A handle | None | Terminal evidence. |
| write | { handle, request } | None | Any Foundation JSON acknowledgement. |
| heartbeat | A handle | None | Any Foundation JSON acknowledgement. |
| cancel | A handle | None | null when no evidence is returned, or terminal evidence. JSON null is the wire representation of no result. |
| dispose | null | None | Any Foundation JSON acknowledgement. |

Handles are exact records with required externalSessionId, supervisorRef, and
operationNonce; externalTurnId is optional. A mapping contains the canonical
providerId, attemptId, external ids, binding and capability revisions/digests,
supervisor ref/nonce, and createdAt. It never contains a PID or local process
metadata. The Host accepts a returned handle only when its ids and session/turn
identity match the durable Attempt and supervisor.

The spawn payload carries canonical Host facts, not a second business schema.
attempt, correlation, and input are validated Foundation values. bindingDigest
is the selected binding fingerprint value and bindingRevision is its revision.
Model projections, when present, are secret-free and must match the frozen
capability. Settings-selected generic targets never receive an aos_gateway model
projection or translation because that capability is rejected before driver
registration. The driver must not mutate these values or infer a wider binding.

### Event stream

An events request opens one stream whose requestId becomes streamId. Each event
frame carries one of the following exact event shapes. All event timestamps are
canonical UTC timestamps, all event session/turn ids must match the returned
handle, and no event has an optional field outside this table.

| Event type | Required fields inside event | Optional fields | Host rules |
| --- | --- | --- | --- |
| started | schemaVersion: 1, type, externalSessionId, producedAt | externalTurnId | Must be the first event and may occur only once. |
| progress | schemaVersion: 1, type, externalSessionId, sequence, producedAt | externalTurnId, phase | sequence is a positive safe integer strictly greater than the prior progress sequence; phase is bounded text. |
| heartbeat | schemaVersion: 1, type, externalSessionId, sequence, producedAt | externalTurnId | Must follow started; its positive sequence is strictly increasing. This is process liveness, not credential renewal. |
| artifact | schemaVersion: 1, type, externalSessionId, artifact, producedAt | externalTurnId | Allowed only when artifacts is true; the reference is content-addressed metadata, not inline data. Known artifact fields are canonicalized and extra nested fields are discarded; the event envelope remains exact-key. |
| tool_gateway_request | schemaVersion: 1, type, externalSessionId, operationNonce, request, producedAt | externalTurnId | The nested nonce must equal the handle and channel nonce. Host scope and in-flight checks happen before any effect. |

After the event stream, the driver emits exactly one events_end frame. There is
no separate terminal event type: terminal evidence is returned as the result
of a read request (or, where applicable, a cancel response).

### Tool Gateway request and result

For a capability-enabled Attempt, toolGatewayRoutes in spawn is the only route
visibility supplied to the driver. The Host computes and freezes:

immutable route catalog ∩ CapabilityBinding allowlist ∩ PolicyBinding ∩ exact MCP selection

The projection contains route records with required kind, toolName, providerId,
revision, and operation; namespace is optional, and operation.requiresSandbox
is optional and may only be true. The route kind is local, mcp, sandbox, or
external. operation has required resource and effects fields: resource is one
of filesystem.read, filesystem.write, filesystem.find, filesystem.grep,
process.spawn, or network.connect; effects are drawn from read, write, create,
delete, move, command, network, commit, push, and merge.
The full catalog, policy object, MCP credentials, and route-provider
implementation are never sent to the driver.

The nested request in a tool_gateway_request event has required schemaVersion,
toolCallId, toolName, originalArguments, and context; namespace, idempotencyKey,
and deadlineAt are optional. context has required schemaVersion, bindingId,
bindingEpochId, and taskId, with optional dispatchId, providerId, attemptId,
agentInstanceId, and operationId. Arguments are bounded Foundation JSON and
are not a route authorization.

tool_gateway_result is the Host-to-driver write payload, not an unsolicited
driver frame. The request has operation = "write" and its payload is
{ handle, request }, where the nested request has required schemaVersion: 1,
kind: "tool_gateway_result", operationNonce, and result. The result has
required schemaVersion, toolCallId, toolName, ok, and sideEffectState; result,
artifacts, error, and toolReceiptRef are optional. The nested nonce and both
tool identities must match the in-flight request. The driver acknowledges this
write with a normal matching response frame.

The Host processing order is request validation, exact route/catalog check,
durable intent persistence, one Tool Gateway effect, durable terminal
persistence, then the tool_gateway_result write-back. An unknown or
unauthorized route returns external_tool_route_denied with
sideEffectState: "none" and performs no provider effect. Duplicate,
conflicting, orphan, late, or nonce-mismatched exchanges fail closed with
external_event_invalid, tool_gateway_ambiguous, or tool_gateway_callback_failed;
they cannot wake another Attempt's exchange.

### Heartbeat, cancel, dispose, and terminal evidence

The heartbeat operation is a Host-to-driver liveness request carrying only a
handle. Its response is an acknowledgement. A heartbeat event in the event
stream carries a strictly increasing event sequence. Task Credential lease
renewal is a separate Host-owned operation with its own strictly increasing
heartbeat sequence; it never places credential material in a driver frame.

cancel is cooperative first: the Host sends the handle and the driver should
stop work and return either null or valid terminal evidence. The supervisor
then enforces the bounded cancellation and containment path. dispose carries
null and is sent during terminal cleanup or Host shutdown. It must not start
new work; the Host still disposes the exact supervised process and fails closed
if cleanup cannot be proven.

Terminal evidence has required externalSessionId, operationNonce, status,
sideEffectState, and producedAt; externalTurnId, artifacts, usage, and error
are optional. status is succeeded, failed, cancelled, or suspended;
sideEffectState is none, unknown, or side_effect_unknown. A cancelled result
must use sideEffectState: "none". Artifacts are content-addressed references:
known fields in each nested artifact object are canonicalized and extra fields
are discarded. Usage is the canonical Attempt-receipt usage shape
(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
and costUsd). Errors use the stable public error code/message projection.
Invalid or contradictory evidence is
external_event_invalid or external_terminal_ambiguous; no vendor evidence can
write a canonical receipt directly.

### Safe lease projection

When the selected external target has an approved credential delivery
authority, spawn.credential is the following material-free projection:

| Field | Required shape |
| --- | --- |
| schemaVersion | Literal 1. |
| leaseId, grantId, bindingId, clientRequestId | Opaque non-empty ids. |
| scopeDigest | Opaque scope fingerprint. |
| expiresAt | Lease expiry timestamp. |

The projection contains no secret, raw key, token, environment variable,
header, provider receipt material, or scope names. The Host resolves and issues
the lease only after durable start_intent and before spawn; it persists the
delivery facts before starting the driver. Renew, revoke, and lease heartbeat
remain Host-owned. A missing delivery authority, invalid projection, expired
lease, or revoked lease fails closed with external_credential_unavailable;
there is no Host-environment fallback. accountReference in settings is only an
opaque target/account identity and never authorizes or supplies a credential.

### Provenance and lifecycle

The target definition is trusted configuration. It requires absolute, bounded
executablePath, modulePath, and cwd; a non-empty bounded version; and
sha256: followed by 64 hexadecimal characters for executableIdentity and
moduleIdentity. Project and Role
settings may select and narrow a trusted global/managed target but may not
define a new executable, module, environment, or credential.

Before any driver process is started, the Host:

1. Resolves the executable, module, and working directory through realpath. It
   verifies the resolved executable and module digests against the pinned
   SHA-256 identities, verifies that the module is the configured process target,
   and requires the working directory to be a directory.
2. Freezes the exact provenance: resolved absolute paths, version, executable
   and module SHA-256 plus file identities, cwd, shell: false, and the platform
   minimal environment. Linux receives no inherited environment keys; macOS
   may receive TMPDIR; Windows may receive SystemRoot, TEMP, TMP, and WINDIR
   when present. No other inherited values are allowed.
3. Creates the process controller and launches the child inactive inside a
   non-detached process group on POSIX or a Windows Job Object. The supervisor
   persists the exact supervisorRef, operationNonce, PID/start token, and full
   process identity atomically before activation. Only after that persistence
   succeeds does activation release the guard and attach the JSONL channel.
   This is the required persist-before-activate boundary.
4. Performs the JSONL handshake on the activated channel before the first
   spawn, connect, or recovery operation. Provenance is never checked after a
   process has already been allowed to perform driver work.

For a new Attempt, the durable order is:

Task/Dispatch/Binding/Attempt persisted -> operation prepared -> start_intent
persisted -> credential issue and delivery facts persisted -> supervised launch
-> private identity persisted -> activate -> handshake -> spawn ->
handle/mapping persisted -> running -> events/read -> canonical AttemptReceipt
-> lease release -> process dispose

runAttempt is the only path that sends spawn. Within the same Host lifecycle, a
resumed Attempt reattaches the persisted process identity and sends `connect`
through the active stdio channel; reconciliation sends `lookup`. Resume and
reconciliation never start a new driver process. After a Host restart, the
stdio JSONL channel is not restored with the persisted process handle, so the
same channel cannot be rebuilt to continue `connect`. A missing, reused, or
ambiguous process identity is quarantined and cannot fabricate a mapping or
receipt. After the Host persists the mapping, it validates every event,
terminal result, and write-back against the same supervisorRef + operationNonce
pair.

The Host owns canonical Task, Dispatch, Attempt, AttemptReceipt, TaskResult, and
RunReceipt persistence and terminal settlement. Drivers supply bounded evidence
only; they do not become a second receipt authority.

## Execution and persistence

The connector receives the shared Foundation execution input. Canonical text
and trusted artifact or image references are gated before Run acceptance.
Execution persists one canonical connector mapping and the standard Foundation
receipt chain. Connector capability, model-access, observation, cancellation,
deadline, and disposal behavior fail closed when evidence is absent or drifts.

The Host owns Run acceptance and terminal settlement. Connector output is
evidence for the canonical `AttemptReceipt`; it is not a second receipt or an
independent terminal authority. Current external traces contain no
`AgentInstance` records.

## Private vendor boundary

Vendor protocol drivers, process handles, probing, startup, cancellation, and
supervision types are implementation details under `src/core/connector/vendor`.
They are not package-root exports and their package subpaths are not importable.
A vendor driver can translate a protocol, but it cannot introduce a second
registry, mapping, receipt, provider taxonomy, or execution contract.

Historical automation-ledger external references are decoded only by the
private migration parser. Migration never generates current `AgentInstance` or
external execution records.

## Packaged public subpath

Package consumers import the connector surface from
`aos-agent/external-connector`. The Node packaging regression stages the
generated entrypoint and fixture asset, creates an npm tarball, installs it in a
directory outside the repository, and resolves that public subpath from the
installed package. The packaged fake driver is deterministic and disabled by
default; a missing allowlisted asset fails with
`external_agent_driver_asset_missing`.

## Local closure and promotion boundary

The ordinary local regressions cover the packaged Node owner above, the standard
product composition across run/switch/fork/import/reload/cancel/restart,
immutable RuntimeLimits and no-widen validation, passive runtime-status
projection, and a durable terminal retry decision for `side_effect_unknown`.
They do not substitute a scheduler-shaped fixture or inspect private Host
fields.

The following promotion evidence was not run in this closure: Bun package and
compiled artifacts, Windows/Linux/macOS CI, upgrade and restart from a
previously published package, pinned vendor certification, and exact-head remote
artifacts. These checks are part of the final promotion gate and are not complete
in this checkout.
