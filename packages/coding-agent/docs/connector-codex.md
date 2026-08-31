# Codex connector

Capability matrix and pinned version for the private Codex app-server connector. The machine-readable pin is `PRIVATE_CODEX_APP_SERVER_IDENTITY`:

- `cliVersion`: `0.149.0`
- `schemaSha256`: `6f76cce25156d405f1da54f205751e38f7b9eb42246ac0742b9958dd60275350`
- Schema source: `codex-cli 0.149.0 app-server generate-json-schema --experimental`
- Hashed bundle: `codex_app_server_protocol.v2.schemas.json`

The driver uses `initialize`, `thread/start`, `turn/start`, `turn/interrupt`, and `thread/resume`. It also handles the pinned private server-request routes for command approval, file-change approval, permissions approval, MCP elicitation, user input, and selected dynamic tools.

| Capability | Status | Pinned protocol evidence and driver behavior |
| --- | --- | --- |
| Images | version-limited | `TurnStartParams.input` accepts `localImage` with a path and `image` with a URL. Canonical trusted `workspace_relative` GIF, JPEG, PNG, and WebP references map to `localImage`. Opaque `artifact_store` handles cannot supply a path or URL and fail closed. |
| File artifacts | version-limited | `TurnStartParams.input` accepts `mention` with a name and path. Canonical trusted `workspace_relative` JSON, octet-stream, PDF, Markdown, and plain-text references map to `mention`. Opaque `artifact_store` handles and other media types fail closed. |
| Model | supported | `ThreadStartParams` accepts `modelProvider`, `model`, and `allowProviderModelFallback`; `TurnStartParams` accepts `model`. The driver sets `allowProviderModelFallback: false`, checks the thread response echo, and never silently substitutes a model. |
| Effort | supported | `TurnStartParams.effort` accepts the model-advertised non-empty reasoning-effort string. The exact translated value is sent on `turn/start`; an RPC rejection fails the start. |
| Service tier | supported | `ThreadStartParams.serviceTier` and `TurnStartParams.serviceTier` accept the exact string. The driver checks the thread response echo and sends the same value on the turn. |
| Resume | supported | `thread/resume` accepts the durable thread id and returns the pinned thread response shape. The driver requires exact thread identity and otherwise fails closed. |

For `aos_gateway`, the driver declares an exact `modelSupportMatrix` for provider, model, effort, service tier, fallback decision, and binding digest. It rechecks the Host translation against the source projection, requires a valid material-free `SafeLeaseProjection`, passes only that projection to transport activation, and never places lease identity or provider credential material on the app-server JSONL wire.

The source restriction on artifact input is necessary because the canonical contract deliberately exposes opaque Artifact Store handles rather than local paths or URLs. Supporting those handles would require a new Host materialization contract; this driver does not guess a location or widen the existing wire shape.
