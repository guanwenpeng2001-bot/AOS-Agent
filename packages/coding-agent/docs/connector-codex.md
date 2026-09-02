# Codex connector

Capability matrix and pinned version for the private Codex app-server connector. The machine-readable pin is `PRIVATE_CODEX_APP_SERVER_IDENTITY`:

- `cliVersion`: `0.149.0`
- `schemaSha256`: `6f76cce25156d405f1da54f205751e38f7b9eb42246ac0742b9958dd60275350`
- Schema source: `codex-cli 0.149.0 app-server generate-json-schema --experimental`
- Hashed bundle: `codex_app_server_protocol.v2.schemas.json`

## Evidence status

1. Pin and handshake evidence: the machine-readable identity above pins Codex
   CLI `0.149.0` and its schema digest; the v0.85.0 handshake check exercises
   that pinned app-server protocol.
2. Product reachability: a trusted global target with `driver: "codex"`
   composes the pinned private connector and fixed `app-server` launch mode.
   `none` and `agent_owned` can register, run, and produce durable receipts;
   real authentication remains a separate certification step.
3. Model-access boundary: settings-selected Codex targets may use
   `aos_gateway`; generic JSONL and ACP targets remain rejected.

## Settings registration

```json
{
  "externalConnectors": {
    "schemaVersion": 1,
    "targetId": "codex-local",
    "targets": [{
      "schemaVersion": 1,
      "targetId": "codex-local",
      "providerId": "codex-local",
      "driver": "codex",
      "executablePath": "<ABSOLUTE_CODEX_PATH>",
      "modulePath": "<ABSOLUTE_CODEX_PATH>",
      "cwd": "<ABSOLUTE_WORKSPACE_PATH>",
      "version": "0.149.0",
      "executableIdentity": "sha256:<64_HEX>",
      "moduleIdentity": "sha256:<64_HEX>",
      "capabilityCeiling": {
        "modelAccess": ["agent_owned"],
        "resume": true,
        "toolGateway": true,
        "artifacts": false,
        "images": false
      }
    }]
  }
}
```

For `aos_gateway`, declare provider/model/effort/service tier and fallback in a
ModelBroker route, set the target's model access to only `aos_gateway`, and add
an opaque `accountReference`. Select that route with `run.start.modelRoute` or
as the default route. The model route is not copied into the connector target.

The exact file-hash commands are documented in
[`external-agent-connector.md`](external-agent-connector.md). Install the pinned
CLI before use; see the [Codex CLI guide](https://developers.openai.com/codex/cli).

The driver uses `initialize`, `thread/start`, `turn/start`, `turn/interrupt`, and `thread/resume`. It also handles the pinned private server-request routes for command approval, file-change approval, permissions approval, MCP elicitation, user input, and selected dynamic tools.

| Capability | Status | Pinned protocol evidence and driver behavior |
| --- | --- | --- |
| Images | version-limited | `TurnStartParams.input` accepts `localImage` with a path and `image` with a URL. Canonical trusted `workspace_relative` GIF, JPEG, PNG, and WebP references map to `localImage`. Opaque `artifact_store` handles cannot supply a path or URL and fail closed. |
| File artifacts | version-limited | `TurnStartParams.input` accepts `mention` with a name and path. Canonical trusted `workspace_relative` JSON, octet-stream, PDF, Markdown, and plain-text references map to `mention`. Opaque `artifact_store` handles and other media types fail closed. |
| Model | supported | `ThreadStartParams` accepts `modelProvider`, `model`, and `allowProviderModelFallback`; `TurnStartParams` accepts `model`. The driver sets `allowProviderModelFallback: false`, checks the thread response echo, and never silently substitutes a model. |
| Effort | supported | `TurnStartParams.effort` accepts the model-advertised non-empty reasoning-effort string. The exact translated value is sent on `turn/start`; an RPC rejection fails the start. |
| Service tier | supported | `ThreadStartParams.serviceTier` and `TurnStartParams.serviceTier` accept the exact string. The driver checks the thread response echo and sends the same value on the turn. |
| Resume | supported | `thread/resume` accepts the durable thread id and returns the pinned thread response shape. The driver requires exact thread identity and otherwise fails closed. |

For `aos_gateway`, the private driver rechecks the exact translation, requires a material-free lease plus a Host-owned loopback gateway capability, and points the app-server's OpenAI-compatible transport at that loopback endpoint with only the short-lived capability. The original AOS provider credential is resolved inside ModelRuntime for each gateway request and never enters app-server JSONL, process arguments, or durable records. A verified `thread/start` echo produces the receipt's `effectiveModel`; the consumed quota belongs to the projected AOS provider, not the Codex subscription.

The source restriction on artifact input is necessary because the canonical contract deliberately exposes opaque Artifact Store handles rather than local paths or URLs. Supporting those handles would require a new Host materialization contract; this driver does not guess a location or widen the existing wire shape.
