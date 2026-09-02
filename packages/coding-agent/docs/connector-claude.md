# Claude connector

This page records the settings registration and private driver contract. The three layers are:

1. Pin and handshake evidence: the machine-readable pin is
   `PRIVATE_CLAUDE_AGENT_SDK_VERSION` (`0.3.246`) in
   `src/core/connector/vendor/claude.ts`; the v0.85.0 handshake check exercises
   that pinned Claude Agent SDK protocol.
2. Product reachability: a trusted global target with `driver: "claude"`
   composes the pinned private connector. `none` and `agent_owned` can register,
   run, and produce durable receipts; real authentication remains a separate
   certification step.
3. Model-access boundary: `aos_gateway` is an internal Host and Scheduler path.
   Generic JSONL settings targets cannot select it; the packaged runtime
   rejects that selection with `capability_widened`.

The capability matrix below is enforced when the settings target is composed.

## Settings registration

```json
{
  "externalConnectors": {
    "schemaVersion": 1,
    "targetId": "claude-local",
    "targets": [{
      "schemaVersion": 1,
      "targetId": "claude-local",
      "providerId": "claude-local",
      "driver": "claude",
      "executablePath": "<ABSOLUTE_EXECUTABLE_PATH>",
      "modulePath": "<ABSOLUTE_PINNED_COMPANION_PATH>",
      "cwd": "<ABSOLUTE_WORKSPACE_PATH>",
      "version": "0.3.246",
      "executableIdentity": "sha256:<64_HEX>",
      "moduleIdentity": "sha256:<64_HEX>",
      "capabilityCeiling": {
        "modelAccess": ["agent_owned"],
        "resume": false,
        "toolGateway": true,
        "artifacts": false,
        "images": false
      }
    }]
  }
}
```

The exact file-hash commands are documented in
[`external-agent-connector.md`](external-agent-connector.md). The executable,
companion, and optional SDK must be installed before use; see the
[Claude Code setup guide](https://code.claude.com/docs/en/getting-started).
The Host passes `Options.spawnClaudeCodeProcess` to the pinned SDK. That hook
validates the SDK command, module, cwd, bounded argv, and secret-free
environment against the selected target, then relays the SDK streams through a
bridge already inside the persisted `ProductionExternalConnectorProcessController`
process group or Windows Job Object. The default SDK spawn path is not used.

| Capability | Status | Pinned protocol evidence and private driver behavior |
| --- | --- | --- |
| Images | supported | `query()` accepts an `AsyncIterable<SDKUserMessage>`. Its user message accepts Anthropic image blocks with base64 JPEG, PNG, GIF, or WebP sources. The connector reads the content-addressed bytes from the injected Artifact Store and verifies size and SHA-256 before encoding. |
| File artifacts | version-limited | The pinned message type accepts document blocks. The connector supports base64 PDF and strict UTF-8 `text/plain` documents. Other canonical file media, including JSON, Markdown, and octet-stream, are explicitly unsupported at this version. |
| Model | supported | `Options.model` accepts an exact model string. The init message reports the applied model and the connector verifies it for `aos_gateway` runs. |
| Effort | supported | `Options.effort` accepts `low`, `medium`, `high`, `xhigh`, or `max`. The init message reports the applied effort and the connector verifies it. |
| Service tier | version-limited | The pinned runtime accepts `ANTHROPIC_BEDROCK_SERVICE_TIER`. Exact service-tier projection is therefore declared only when the projected provider is `bedrock`; other providers fail model-matrix admission. |
| Resume | version-limited | `Options.resume` can load a Claude session, but the current durable connector cannot prove the persisted vendor transcript and fork point after host recovery. The capability remains `resume: false`, and reconnect without a live operation fails with `external_resume_unsupported`. |

## Artifact translation

The Host admits metadata-only canonical Artifact references before driver spawn. The driver then uses its injected Artifact Store authority to load by `artifactId`, verifies `sizeBytes` and SHA-256, and creates one Claude user message containing the text block followed by native image or document blocks. Unsupported media and missing artifact authority fail with `external_protocol_unsupported`; unavailable, corrupt, or non-UTF-8 accepted content fails closed without sending a query.

## `aos_gateway` boundary (private implementation evidence)

The exact support matrix below is not reachable from settings targets. The
`aos_gateway` projection and credential-lease mechanism serves internal Host
and Scheduler paths only and is planned for a later composition change.

The exact support matrix maps provider, model, effort, service tier, fallback decision, and binding digest to distinct private companion fields. Version `0.3.246` can express the full set only for Bedrock: the companion selects Bedrock explicitly, passes the exact model and effort options, and sets the exact Bedrock service tier. Spawn also requires a valid material-free `SafeLeaseProjection`; no provider key is added to the driver protocol.

The driver recomputes the Host translation and compares the complete canonical translation before invoking the companion. Unsupported providers or effort values and any projection/translation drift fail closed. The durable Host reports drift as `binding_required_fact`; a direct package-private driver call returns its stable `external_protocol_unsupported` vendor error.
