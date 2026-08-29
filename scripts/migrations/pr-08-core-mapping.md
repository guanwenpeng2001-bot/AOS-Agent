# PR-08 core mapping

This table covers all 196 files currently under `packages/coding-agent/src/core/`. The two directory rows are additional execution aids; every file below those directories also has its own row.

## Domain counts

Counts exclude directory rows.

| Domain | Files |
| --- | ---: |
| connector | 25 |
| cross-domain | 14 |
| migrations | 5 |
| policy | 22 |
| runtime | 73 |
| scheduler | 11 |
| session | 26 |
| subagent | 15 |
| worker | 5 |

## Naming decisions and plan deviations

- `external-connector-product.ts` becomes `connector/product-run.ts`: it owns admission, immutable preparation, execution, recovery, and settlement for one Connector run.
- `external-connector-production.ts` becomes `connector/production.ts`: it composes trusted provenance, target validation, process containment, supervision, readiness, and bounded cleanup. Folding it into process-controller or supervisor would combine distinct composition and mechanism duties; the confusing pair is removed because the other file is named `product-run.ts`.
- `scheduler.ts` becomes `scheduler/host.ts`: the file includes Scheduler contracts, but its concrete production owner is `SchedulerHost` and its tick loop.
- `subagent.ts` and `worker.ts` become `subagent/lifecycle.ts` and `worker/lifecycle.ts`: both files explicitly define pure lifecycle contracts and folds, so retaining the domain name as the filename would hide their duty.
- `agent-session.ts` keeps `agent-session.ts` inside `session/`: it defines the concrete `AgentSession` product object; `agent` is not a redundant synonym for the broader Session domain.
- `execution-association.ts` moves into `core/migrations/`: its header declares it a read-only decoder for a historical cross-ledger record, matching the private migrations layer.
- Existing `compaction/`, `export-html/`, `extensions/`, and `tools/` layouts remain unchanged. Moving `extensions/` is explicitly out of scope, and the other established subtrees already express their duties without flat prefixes.

## Core-root leftovers

- `packages/coding-agent/src/core/binding-handles.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/bounded-protocol.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/control-plane-atomic-storage.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/defaults.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/diagnostics.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/event-bus.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/execution-error.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/experimental.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/index.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/messages.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/operation-boundary.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/radius.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/resolve-config-value.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.
- `packages/coding-agent/src/core/source-info.ts`: Keep this shared primitive at core root because multiple domains consume it without one owning it.

There are 14 direct files left at `core/` root.

## Codemod

Run after moving one domain:

```bash
node scripts/migrations/rewrite-pr08-imports.mjs --domain connector --dry-run
node scripts/migrations/rewrite-pr08-imports.mjs --domain connector
```

Run after moving every mapped domain:

```bash
node scripts/migrations/rewrite-pr08-imports.mjs --all --dry-run
node scripts/migrations/rewrite-pr08-imports.mjs --all
```

The codemod detects which selected source paths have actually moved, rebases imports inside moved files, and leaves future-domain targets at their current paths. Repeating the same command is idempotent.

## Complete mapping

| Old path | New path | Domain | Reason |
| --- | --- | --- | --- |
| `packages/coding-agent/src/core/agent-runtime-composition.ts` | `packages/coding-agent/src/core/runtime/composition.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/agent-session-facade.ts` | `packages/coding-agent/src/core/session/facade.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | `packages/coding-agent/src/core/session/runtime.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/agent-session-services.ts` | `packages/coding-agent/src/core/session/services.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/agent-session.ts` | `packages/coding-agent/src/core/session/agent-session.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/aos-agent-manifest.ts` | `packages/coding-agent/src/core/runtime/aos-agent-manifest.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/auth-guidance.ts` | `packages/coding-agent/src/core/runtime/auth-guidance.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/auth-storage.ts` | `packages/coding-agent/src/core/policy/auth-storage.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/automation-run-projection.ts` | `packages/coding-agent/src/core/session/automation-run-projection.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/bash-executor.ts` | `packages/coding-agent/src/core/runtime/bash-executor.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/binding-handles.ts` | `packages/coding-agent/src/core/binding-handles.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/bounded-protocol.ts` | `packages/coding-agent/src/core/bounded-protocol.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/cache-stats.ts` | `packages/coding-agent/src/core/session/cache-stats.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/capability-public-identity.ts` | `packages/coding-agent/src/core/policy/capability-public-identity.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/capability-registry.ts` | `packages/coding-agent/src/core/policy/capability-registry.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/capability-settings.ts` | `packages/coding-agent/src/core/policy/capability-settings.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/compaction/branch-summarization.ts` | `packages/coding-agent/src/core/compaction/branch-summarization.ts` | session | Preserve the established compaction layout; compaction operates on Session context. |
| `packages/coding-agent/src/core/compaction/compaction.ts` | `packages/coding-agent/src/core/compaction/compaction.ts` | session | Preserve the established compaction layout; compaction operates on Session context. |
| `packages/coding-agent/src/core/compaction/index.ts` | `packages/coding-agent/src/core/compaction/index.ts` | session | Preserve the established compaction layout; compaction operates on Session context. |
| `packages/coding-agent/src/core/compaction/utils.ts` | `packages/coding-agent/src/core/compaction/utils.ts` | session | Preserve the established compaction layout; compaction operates on Session context. |
| `packages/coding-agent/src/core/connector-retry-circuit.ts` | `packages/coding-agent/src/core/connector/retry-circuit.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/connector-runtime-status.ts` | `packages/coding-agent/src/core/connector/runtime-status.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/context-engine.ts` | `packages/coding-agent/src/core/session/context-engine.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/context-memory-store.ts` | `packages/coding-agent/src/core/session/context-memory-store.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/control-plane-atomic-storage.ts` | `packages/coding-agent/src/core/control-plane-atomic-storage.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/current-session-scope.ts` | `packages/coding-agent/src/core/session/current-scope.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/defaults.ts` | `packages/coding-agent/src/core/defaults.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/diagnostics.ts` | `packages/coding-agent/src/core/diagnostics.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/event-bus.ts` | `packages/coding-agent/src/core/event-bus.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/exec.ts` | `packages/coding-agent/src/core/runtime/exec.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/execution-association.ts` | `packages/coding-agent/src/core/migrations/execution-association.ts` | migrations | The file is explicitly a read-only decoder for a historical cross-ledger association. |
| `packages/coding-agent/src/core/execution-audit-query.ts` | `packages/coding-agent/src/core/session/execution-audit-query.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/execution-audit.ts` | `packages/coding-agent/src/core/session/execution-audit.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/execution-error.ts` | `packages/coding-agent/src/core/execution-error.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/execution-policy-ledger.ts` | `packages/coding-agent/src/core/policy/execution-ledger.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/execution-policy-settings.ts` | `packages/coding-agent/src/core/policy/execution-settings.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/execution-policy.ts` | `packages/coding-agent/src/core/policy/execution.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/experimental.ts` | `packages/coding-agent/src/core/experimental.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/export-html/ansi-to-html.ts` | `packages/coding-agent/src/core/export-html/ansi-to-html.ts` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/index.ts` | `packages/coding-agent/src/core/export-html/index.ts` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/template.css` | `packages/coding-agent/src/core/export-html/template.css` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/template.html` | `packages/coding-agent/src/core/export-html/template.html` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/template.js` | `packages/coding-agent/src/core/export-html/template.js` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/tool-renderer.ts` | `packages/coding-agent/src/core/export-html/tool-renderer.ts` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/vendor/highlight.min.js` | `packages/coding-agent/src/core/export-html/vendor/highlight.min.js` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/export-html/vendor/marked.min.js` | `packages/coding-agent/src/core/export-html/vendor/marked.min.js` | runtime | Preserve the established export-html implementation and bundled asset layout. |
| `packages/coding-agent/src/core/extensions/index.ts` | `packages/coding-agent/src/core/extensions/index.ts` | runtime | Preserve the extensions layout as required by the PR boundary. |
| `packages/coding-agent/src/core/extensions/loader.ts` | `packages/coding-agent/src/core/extensions/loader.ts` | runtime | Preserve the extensions layout as required by the PR boundary. |
| `packages/coding-agent/src/core/extensions/runner.ts` | `packages/coding-agent/src/core/extensions/runner.ts` | runtime | Preserve the extensions layout as required by the PR boundary. |
| `packages/coding-agent/src/core/extensions/types.ts` | `packages/coding-agent/src/core/extensions/types.ts` | runtime | Preserve the extensions layout as required by the PR boundary. |
| `packages/coding-agent/src/core/extensions/wrapper.ts` | `packages/coding-agent/src/core/extensions/wrapper.ts` | runtime | Preserve the extensions layout as required by the PR boundary. |
| `packages/coding-agent/src/core/external-agent-connector.ts` | `packages/coding-agent/src/core/connector/durable-connector.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-agent-input.ts` | `packages/coding-agent/src/core/connector/input.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-agent-operation.ts` | `packages/coding-agent/src/core/connector/operation.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-agent-registry.ts` | `packages/coding-agent/src/core/connector/registry.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-assets/` | `packages/coding-agent/src/core/connector/assets/` | connector | Place packaged Connector assets beside the Connector runtime that resolves them. |
| `packages/coding-agent/src/core/external-connector-assets/fake-connector-process.mjs` | `packages/coding-agent/src/core/connector/assets/fake-connector-process.mjs` | connector | Move this packaged Connector asset with its owning runtime. |
| `packages/coding-agent/src/core/external-connector-assets/fake-connector.json` | `packages/coding-agent/src/core/connector/assets/fake-connector.json` | connector | Move this packaged Connector asset with its owning runtime. |
| `packages/coding-agent/src/core/external-connector-process-controller.ts` | `packages/coding-agent/src/core/connector/process-controller.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-product.ts` | `packages/coding-agent/src/core/connector/product-run.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-production.ts` | `packages/coding-agent/src/core/connector/production.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-readiness.ts` | `packages/coding-agent/src/core/connector/readiness.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-settings.ts` | `packages/coding-agent/src/core/connector/settings.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-supervisor.ts` | `packages/coding-agent/src/core/connector/supervisor.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-connector-target-config.ts` | `packages/coding-agent/src/core/connector/target-config.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-model-projection.ts` | `packages/coding-agent/src/core/connector/model-projection.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-session-mapping.ts` | `packages/coding-agent/src/core/connector/session-mapping.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-tool-gateway-authority.ts` | `packages/coding-agent/src/core/connector/tool-gateway.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/external-tool-policy-operation.ts` | `packages/coding-agent/src/core/connector/tool-policy.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/footer-data-provider.ts` | `packages/coding-agent/src/core/session/footer-data-provider.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/foundation-control-plane.ts` | `packages/coding-agent/src/core/runtime/control-plane.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/http-dispatcher.ts` | `packages/coding-agent/src/core/runtime/http-dispatcher.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/index.ts` | `packages/coding-agent/src/core/index.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/keybindings.ts` | `packages/coding-agent/src/core/runtime/keybindings.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-attachment.ts` | `packages/coding-agent/src/core/runtime/mcp-attachment.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-auth-manager.ts` | `packages/coding-agent/src/core/policy/mcp-auth-manager.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/mcp-auth-storage.ts` | `packages/coding-agent/src/core/policy/mcp-auth-storage.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/mcp-auth.ts` | `packages/coding-agent/src/core/policy/mcp-auth.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/mcp-content.ts` | `packages/coding-agent/src/core/runtime/mcp-content.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-error-codes.ts` | `packages/coding-agent/src/core/runtime/mcp-error-codes.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-lifecycle.ts` | `packages/coding-agent/src/core/runtime/mcp-lifecycle.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-tool-adapter.ts` | `packages/coding-agent/src/core/runtime/mcp-tool-adapter.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/mcp-types.ts` | `packages/coding-agent/src/core/runtime/mcp-types.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/messages.ts` | `packages/coding-agent/src/core/messages.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/migrations/automation-run-ledger.ts` | `packages/coding-agent/src/core/migrations/automation-run-ledger.ts` | migrations | Keep the private storage decoder in the cross-domain migrations layer. |
| `packages/coding-agent/src/core/migrations/external-agent-ledger.ts` | `packages/coding-agent/src/core/migrations/external-agent-ledger.ts` | migrations | Keep the private storage decoder in the cross-domain migrations layer. |
| `packages/coding-agent/src/core/migrations/session-contracts.ts` | `packages/coding-agent/src/core/migrations/session-contracts.ts` | migrations | Keep the private storage decoder in the cross-domain migrations layer. |
| `packages/coding-agent/src/core/migrations/session-entry.ts` | `packages/coding-agent/src/core/migrations/session-entry.ts` | migrations | Keep the private storage decoder in the cross-domain migrations layer. |
| `packages/coding-agent/src/core/model-broker-ledger.ts` | `packages/coding-agent/src/core/runtime/model-broker-ledger.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-broker-settings.ts` | `packages/coding-agent/src/core/runtime/model-broker-settings.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-broker.ts` | `packages/coding-agent/src/core/runtime/model-broker.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-config.ts` | `packages/coding-agent/src/core/runtime/model-config.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-registry.ts` | `packages/coding-agent/src/core/runtime/model-registry.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-resolver.ts` | `packages/coding-agent/src/core/runtime/model-resolver.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/model-runtime.ts` | `packages/coding-agent/src/core/runtime/model-runtime.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/models-store.ts` | `packages/coding-agent/src/core/session/models-store.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/operation-boundary.ts` | `packages/coding-agent/src/core/operation-boundary.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/output-guard.ts` | `packages/coding-agent/src/core/runtime/output-guard.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/package-manager.ts` | `packages/coding-agent/src/core/runtime/package-manager.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/packaged-external-agent-driver.ts` | `packages/coding-agent/src/core/connector/packaged-driver.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/packaged-external-connector-runtime.ts` | `packages/coding-agent/src/core/connector/packaged-runtime.ts` | connector | Move the External Connector implementation under its domain and remove the redundant legacy prefix. |
| `packages/coding-agent/src/core/policy-filesystem.ts` | `packages/coding-agent/src/core/policy/filesystem.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/policy-process.ts` | `packages/coding-agent/src/core/policy/process.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/product-prompt-binding-authority.ts` | `packages/coding-agent/src/core/runtime/prompt-binding-authority.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/product-prompt-ingress.ts` | `packages/coding-agent/src/core/runtime/prompt-ingress.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/project-trust.ts` | `packages/coding-agent/src/core/policy/project-trust.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/prompt-task-adapter.ts` | `packages/coding-agent/src/core/runtime/prompt-task-adapter.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/prompt-templates.ts` | `packages/coding-agent/src/core/runtime/prompt-templates.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/protected-path-policy.ts` | `packages/coding-agent/src/core/policy/protected-path.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/provider-attribution.ts` | `packages/coding-agent/src/core/runtime/provider-attribution.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/provider-composer.ts` | `packages/coding-agent/src/core/runtime/provider-composer.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/radius.ts` | `packages/coding-agent/src/core/radius.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/remote-catalog-provider.ts` | `packages/coding-agent/src/core/runtime/remote-catalog-provider.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/remote-operation.ts` | `packages/coding-agent/src/core/runtime/remote-operation.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/resolve-config-value.ts` | `packages/coding-agent/src/core/resolve-config-value.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/resource-loader.ts` | `packages/coding-agent/src/core/runtime/resource-loader.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/run-lifecycle.ts` | `packages/coding-agent/src/core/session/run-lifecycle.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/runtime-clock.ts` | `packages/coding-agent/src/core/runtime/clock.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/runtime-credentials.ts` | `packages/coding-agent/src/core/runtime/credentials.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/runtime-limits.ts` | `packages/coding-agent/src/core/runtime/limits.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/runtime-session-surface.ts` | `packages/coding-agent/src/core/runtime/session-surface.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/sandbox-host.ts` | `packages/coding-agent/src/core/policy/sandbox-host.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/sandbox.ts` | `packages/coding-agent/src/core/policy/sandbox.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/scheduler-deadlock.ts` | `packages/coding-agent/src/core/scheduler/deadlock.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-dispatch.ts` | `packages/coding-agent/src/core/scheduler/dispatch.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-executors.ts` | `packages/coding-agent/src/core/scheduler/executors.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-fan-in.ts` | `packages/coding-agent/src/core/scheduler/fan-in.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-handoff.ts` | `packages/coding-agent/src/core/scheduler/handoff.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-messages.ts` | `packages/coding-agent/src/core/scheduler/messages.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-queue.ts` | `packages/coding-agent/src/core/scheduler/queue.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-selection-reservations.ts` | `packages/coding-agent/src/core/scheduler/selection-reservations.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler-workflow.ts` | `packages/coding-agent/src/core/scheduler/workflow.ts` | scheduler | Move Scheduler behavior under its domain and remove the redundant scheduler prefix. |
| `packages/coding-agent/src/core/scheduler.ts` | `packages/coding-agent/src/core/scheduler/host.ts` | scheduler | Name the module for SchedulerHost, which owns the production tick and state-machine facade. |
| `packages/coding-agent/src/core/sdk.ts` | `packages/coding-agent/src/core/runtime/sdk.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/session-boundary.ts` | `packages/coding-agent/src/core/session/boundary.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-creation.ts` | `packages/coding-agent/src/core/session/creation.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-cwd.ts` | `packages/coding-agent/src/core/session/cwd.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-manager-storage.ts` | `packages/coding-agent/src/core/session/manager-storage.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-manager.ts` | `packages/coding-agent/src/core/session/manager.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-read-projection.ts` | `packages/coding-agent/src/core/session/read-projection.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/session-write-coordinator.ts` | `packages/coding-agent/src/core/session/write-coordinator.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/settings-manager.ts` | `packages/coding-agent/src/core/runtime/settings-manager.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/shutdown-coordinator.ts` | `packages/coding-agent/src/core/runtime/shutdown-coordinator.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/skills.ts` | `packages/coding-agent/src/core/runtime/skills.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/slash-commands.ts` | `packages/coding-agent/src/core/runtime/slash-commands.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/source-info.ts` | `packages/coding-agent/src/core/source-info.ts` | cross-domain | Keep this shared primitive at core root because multiple domains consume it without one owning it. |
| `packages/coding-agent/src/core/subagent-binding.ts` | `packages/coding-agent/src/core/subagent/binding.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-composition.ts` | `packages/coding-agent/src/core/subagent/composition.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-context-fork.ts` | `packages/coding-agent/src/core/subagent/context-fork.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-context-ingress.ts` | `packages/coding-agent/src/core/subagent/context-ingress.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-fork-protocol.ts` | `packages/coding-agent/src/core/subagent/fork-protocol.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-fork-provider.ts` | `packages/coding-agent/src/core/subagent/fork-provider.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-inprocess-provider.ts` | `packages/coding-agent/src/core/subagent/inprocess-provider.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-mailbox.ts` | `packages/coding-agent/src/core/subagent/mailbox.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-memory.ts` | `packages/coding-agent/src/core/subagent/memory.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-provider-context.ts` | `packages/coding-agent/src/core/subagent/provider-context.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-registry.ts` | `packages/coding-agent/src/core/subagent/registry.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-result.ts` | `packages/coding-agent/src/core/subagent/result.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-supervisor.ts` | `packages/coding-agent/src/core/subagent/supervisor.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent-worktree.ts` | `packages/coding-agent/src/core/subagent/worktree.ts` | subagent | Move Child Agent behavior under its domain and remove the redundant subagent prefix. |
| `packages/coding-agent/src/core/subagent.ts` | `packages/coding-agent/src/core/subagent/lifecycle.ts` | subagent | The module defines the pure Child Agent lifecycle contract and fold. |
| `packages/coding-agent/src/core/system-prompt.ts` | `packages/coding-agent/src/core/runtime/system-prompt.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/task-credential-lease.ts` | `packages/coding-agent/src/core/policy/task-credential-lease.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/task-credential-provider.ts` | `packages/coding-agent/src/core/policy/task-credential-provider.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/task-credential-service.ts` | `packages/coding-agent/src/core/policy/task-credential-service.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/task-credential-store.ts` | `packages/coding-agent/src/core/policy/task-credential-store.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/task-gate.ts` | `packages/coding-agent/src/core/policy/task-gate.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/task-graph.ts` | `packages/coding-agent/src/core/scheduler/task-graph.ts` | scheduler | Keep the task graph beside the Scheduler that scans and advances it. |
| `packages/coding-agent/src/core/telemetry.ts` | `packages/coding-agent/src/core/runtime/telemetry.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/timings.ts` | `packages/coding-agent/src/core/runtime/timings.ts` | runtime | Group product composition and shared execution services under the runtime composition domain. |
| `packages/coding-agent/src/core/tools/bash.ts` | `packages/coding-agent/src/core/tools/bash.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/edit-diff.ts` | `packages/coding-agent/src/core/tools/edit-diff.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/edit.ts` | `packages/coding-agent/src/core/tools/edit.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/find.ts` | `packages/coding-agent/src/core/tools/find.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/grep.ts` | `packages/coding-agent/src/core/tools/grep.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/index.ts` | `packages/coding-agent/src/core/tools/index.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/ls.ts` | `packages/coding-agent/src/core/tools/ls.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/output-accumulator.ts` | `packages/coding-agent/src/core/tools/output-accumulator.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/path-utils.ts` | `packages/coding-agent/src/core/tools/path-utils.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/read.ts` | `packages/coding-agent/src/core/tools/read.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/render-utils.ts` | `packages/coding-agent/src/core/tools/render-utils.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/sandbox-filesystem.ts` | `packages/coding-agent/src/core/tools/sandbox-filesystem.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` | `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/truncate.ts` | `packages/coding-agent/src/core/tools/truncate.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/tools/write.ts` | `packages/coding-agent/src/core/tools/write.ts` | runtime | Preserve the established built-in tools layout used by the runtime. |
| `packages/coding-agent/src/core/trust-manager.ts` | `packages/coding-agent/src/core/policy/trust-manager.ts` | policy | Group authorization, trust, sandbox, capability, and credential enforcement under Policy. |
| `packages/coding-agent/src/core/usage-totals.ts` | `packages/coding-agent/src/core/session/usage-totals.ts` | session | Group Session state, projections, lifecycle, and user-facing session data under the Session domain. |
| `packages/coding-agent/src/core/vendor-drivers/` | `packages/coding-agent/src/core/connector/vendor/` | connector | Place vendor-specific Connector drivers under the Connector domain. |
| `packages/coding-agent/src/core/vendor-drivers/acp.ts` | `packages/coding-agent/src/core/connector/vendor/acp.ts` | connector | Move this vendor driver with the Connector domain. |
| `packages/coding-agent/src/core/vendor-drivers/claude.ts` | `packages/coding-agent/src/core/connector/vendor/claude.ts` | connector | Move this vendor driver with the Connector domain. |
| `packages/coding-agent/src/core/vendor-drivers/codex.ts` | `packages/coding-agent/src/core/connector/vendor/codex.ts` | connector | Move this vendor driver with the Connector domain. |
| `packages/coding-agent/src/core/vendor-drivers/types.ts` | `packages/coding-agent/src/core/connector/vendor/types.ts` | connector | Move this vendor driver with the Connector domain. |
| `packages/coding-agent/src/core/worker-protocol.ts` | `packages/coding-agent/src/core/worker/protocol.ts` | worker | Move Worker behavior under its domain and remove the redundant worker prefix. |
| `packages/coding-agent/src/core/worker-runtime.ts` | `packages/coding-agent/src/core/worker/runtime.ts` | worker | Move Worker behavior under its domain and remove the redundant worker prefix. |
| `packages/coding-agent/src/core/worker-sandbox-provider.ts` | `packages/coding-agent/src/core/worker/sandbox-provider.ts` | worker | Move Worker behavior under its domain and remove the redundant worker prefix. |
| `packages/coding-agent/src/core/worker-supervisor.ts` | `packages/coding-agent/src/core/worker/supervisor.ts` | worker | Move Worker behavior under its domain and remove the redundant worker prefix. |
| `packages/coding-agent/src/core/worker.ts` | `packages/coding-agent/src/core/worker/lifecycle.ts` | worker | The module defines the pure Worker identity and lifecycle contract. |
