# ACP stable-v1 capability matrix

This inventory is pinned to the dependency and stable schema imported by the private ACP driver. The evidence is `packages/coding-agent/package.json`, `@agentclientprotocol/sdk/package.json`, and the SDK's stable `schema/schema.json` and generated stable TypeScript declarations. Experimental v2 exports are out of scope.

```json
{
  "package": "@agentclientprotocol/sdk",
  "packageVersion": "1.4.0",
  "importPath": "@agentclientprotocol/sdk",
  "protocolVersion": 1,
  "schema": "schema/schema.json",
  "stability": "stable"
}
```

| Capability | Status | Stable-v1 evidence | Driver decision |
| --- | --- | --- | --- |
| Text prompt blocks | supported | `ContentBlock::Text` is baseline prompt functionality. | The canonical prompt text is always sent as the first `text` block. |
| Resource links | supported | `ContentBlock::ResourceLink` is baseline prompt functionality and carries a URI plus optional MIME type and size. | The canonical input read handle is not an ACP-readable URI, so the driver does not invent a link translation. Artifact Store files use embedded resources instead; workspace-relative handles fail closed. |
| Embedded resources | version-limited | `ContentBlock::Resource` is allowed only when the agent advertises `promptCapabilities.embeddedContext`. It carries text or base64 blob contents and a URI. | Artifact Store file references are loaded, digest/size checked, and sent as `resource` blocks only after the agent advertises `embeddedContext: true`. |
| Images | version-limited | `ContentBlock::Image` carries base64 data and a MIME type, but requires `promptCapabilities.image: true`. | Artifact Store image references are loaded, digest/size checked, and sent as `image` blocks only after the agent advertises `image: true`. |
| Audio | version-limited | `ContentBlock::Audio` requires `promptCapabilities.audio: true`. | Unsupported because canonical external input has no audio kind. Audio-like or unknown media remains a stable reject at canonical input admission. |
| Exact provider and model selection | unsupported | `session/new`, `session/load`, and `session/resume` have no provider or model fields. A returned config option may use category `model`, but the schema states categories are UX-only and must not be required for correctness. | `aos_gateway` remains fail-closed. The driver exposes no `modelSupportMatrix` and rejects an `aos_gateway` capability instead of translating model defaults or display-oriented option IDs. |
| Exact effort and service tier | unsupported | Session config categories include `thought_level` and open-ended values, but no stable field binds canonical effort or service tier semantics. | No downgrade translation is attempted; `aos_gateway` remains fail-closed. |
| Load session with history | version-limited | `session/load` is available only when top-level `loadSession: true` is advertised and requires session ID, cwd, and MCP servers. | Required by the driver and used for durable Host resume. |
| Resume session without history replay | version-limited | `session/resume` is available only when `sessionCapabilities.resume` is advertised. | Recognized by the pinned protocol but not needed by the current driver because Host recovery uses the stronger required `session/load` path. |
| Continue an active session | supported | Baseline agents must support `session/prompt`; repeated prompts use the active session ID. | Stable protocol support exists. The current one-Attempt-per-turn Host mapping sends one prompt per spawned operation. |

## Artifact translation

Canonical Artifact Store references do not cross the wire as local paths or opaque store handles. The driver reads them through the Host-provided Artifact Store, verifies the declared byte length and SHA-256 digest, and emits only ACP-native content blocks:

- image artifacts become `image` blocks;
- UTF-8 `text/plain`, `text/markdown`, and `application/json` files become embedded text `resource` blocks;
- other admitted file media become embedded base64 blob `resource` blocks.

The embedded resource identity is the content-addressed `urn:sha256:<digest>` URI. Workspace-relative read handles remain unsupported because their contract explicitly leaves path resolution with the Host and ACP stable-v1 provides no opaque Host read-handle field.

## `aos_gateway` stance

Problem: the Host projection requires exact provider, model, effort, service tier, fallback decision, and binding digest consumption. For example, selecting a returned config option whose category is `model` cannot prove which provider owns the model or preserve an exact service tier.

Solution: the ACP stable-v1 driver accepts only `agent_owned` or `none`. This is necessary because the pinned schema has no exact fields for all canonical projection facts; adding a guessed mapping would silently change execution authority.
