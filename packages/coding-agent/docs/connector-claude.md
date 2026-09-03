# Claude connector

This page records the settings registration and private driver contract. The three layers are:

1. Pin and handshake evidence: the machine-readable pin is
   `PRIVATE_CLAUDE_AGENT_SDK_VERSION` (`0.3.246`) in
   `src/core/connector/vendor/claude.ts`; the v0.85.0 handshake check exercises
   that pinned Claude Agent SDK protocol.
2. Product reachability: a trusted global target with `driver: "claude"`
   composes the pinned private connector. `none` and `agent_owned` can register,
   run, and produce durable receipts.
3. Model-access boundary: settings-selected Claude targets may use
   `aos_gateway` with an exact ModelBroker route whose canonical provider is
   `amazon-bedrock`. The private driver translates only Claude's provider
   selector to `bedrock`. Generic JSONL and ACP targets remain rejected.

None of these modes is currently task-certified for real vendor authentication
and task completion. Pin/handshake and product-reachability evidence do not
establish task certification. `aos_gateway` additionally requires the exact
ModelBroker translation, a matching `amazon-bedrock` credential path, the
Host-owned loopback gateway capability, verified effective-model observation,
and canonical terminal evidence; missing or drifted evidence fails closed.

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
      "modulePath": "<ABSOLUTE_CLAUDE_CODE_CLI_ENTRY_MODULE_PATH>",
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

For `aos_gateway`, keep the model in `modelBroker`, not in the connector target:

```json
{
  "modelBroker": {
    "routes": {
      "claude-bedrock": {
        "candidates": [{
          "provider": "amazon-bedrock",
          "modelId": "<AOS_BEDROCK_MODEL_ID>",
          "thinkingLevel": "high",
          "serviceTier": "none"
        }]
      }
    }
  },
  "externalConnectors": {
    "schemaVersion": 1,
    "targetId": "claude-gateway",
    "targets": [{
      "schemaVersion": 1,
      "targetId": "claude-gateway",
      "providerId": "claude-gateway",
      "driver": "claude",
      "executablePath": "<ABSOLUTE_EXECUTABLE_PATH>",
      "modulePath": "<ABSOLUTE_CLAUDE_CODE_CLI_ENTRY_MODULE_PATH>",
      "cwd": "<ABSOLUTE_WORKSPACE_PATH>",
      "version": "0.3.246",
      "executableIdentity": "sha256:<64_HEX>",
      "moduleIdentity": "sha256:<64_HEX>",
      "accountReference": { "schemaVersion": 1, "namespace": "aos", "accountId": "model-runtime" },
      "capabilityCeiling": {
        "modelAccess": ["aos_gateway"],
        "resume": false,
        "toolGateway": true,
        "artifacts": false,
        "images": false
      }
    }]
  }
}
```

Select `claude-bedrock` with `run.start.modelRoute` or as the ModelBroker default.
The consumed quota belongs to the AOS `amazon-bedrock` credential, not a Claude login.

The exact file-hash commands are documented in
[`external-agent-connector.md`](external-agent-connector.md). `modulePath`
identifies the Claude Code CLI entry module that the pinned Agent SDK asks the
Host spawn hook to execute; it is not the SDK companion module. The executable,
Claude Code CLI, and optional SDK must be installed before use; see the
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
| Service tier | unsupported | The stock AOS Bedrock adapter does not apply a service-tier option. Claude gateway routes must use the explicit `none` sentinel, which is omitted from the ModelRuntime request; values such as `priority` fail before vendor spawn. |
| Resume | version-limited | `Options.resume` can load a Claude session, but the current durable connector cannot prove the persisted vendor transcript and fork point after host recovery. The capability remains `resume: false`, and reconnect without a live operation fails with `external_resume_unsupported`. |

## Artifact translation

The Host admits metadata-only canonical Artifact references before driver spawn. The driver then uses its injected Artifact Store authority to load by `artifactId`, verifies `sizeBytes` and SHA-256, and creates one Claude user message containing the text block followed by native image or document blocks. Unsupported media and missing artifact authority fail with `external_protocol_unsupported`; unavailable, corrupt, or non-UTF-8 accepted content fails closed without sending a query.

## `aos_gateway` boundary

The exact support matrix maps provider, model, effort, service tier, fallback decision, and ModelBinding digest to distinct private companion fields. Version `0.3.246` accepts the canonical AOS provider `amazon-bedrock` and translates only the Claude-facing selector to `bedrock`. Spawn requires both a material-free lease and a Host-created loopback gateway capability. The companion receives only the loopback endpoint and short-lived capability; the original Bedrock credential remains inside the Credential/ModelRuntime boundary.

The driver recomputes the Host translation and compares the complete canonical translation before invoking the companion. It verifies init model/effort and requires one matching final model-usage observation before emitting `effectiveModel`. Unsupported values, a remote configured endpoint, missing/expired capability, translation drift, or observation drift fail closed.
