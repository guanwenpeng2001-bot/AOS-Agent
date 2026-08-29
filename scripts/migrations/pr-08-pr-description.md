# PR-08 directory-domain mapping



This file is the complete PR description artifact for the PR-08 directory and import-path migration. It records every old-to-new core path, the agent-core foundation disposition, and every coding-agent test path; `same` rows are retained to make the inventory exhaustive.



## Closure notes



- Core domains are `connector`, `scheduler`, `subagent`, `worker`, `session`, `policy`, and `runtime`; cross-domain and migration files remain under `src/core/` where their ownership is shared.

- Product orchestration stores and Workflow helpers moved from `@aos-agent/agent-core` to `packages/coding-agent/src/orchestration/`; retained foundation files remain loop contracts.

- Tests are grouped by their primary domain; shared and surface tests remain at the test root, and issue-number regressions remain under `test/suite/regressions/`.

- Documentation and scripts were audited for stale `src/core/external-*`, `src/core/scheduler-*`, `src/core/subagent-*`, `src/core/worker-*`, `src/core/session-*`, and `src/core/connector-*` paths. No stale references remain outside the intentional old-path columns in the mapping artifacts.



## Core source and destination paths

### PR-08 core mapping

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

## Agent-core disposition

### PR-08 agent-core foundation disposition

Proposed coding-agent destination: `packages/coding-agent/src/orchestration/`. This keeps Goal/Ask/Workflow persistence and workflow contracts together without placing orchestration stores at `core/` root or reviving the `product`/`production` naming pair.

Consumer summaries cover direct module imports and named imports through `packages/agent/src/harness/foundation/index.ts` or `@aos-agent/agent-core`. Counts include source files only unless the summary explicitly says tests.

| From | To | Action | Reason | Consumers |
| --- | --- | --- | --- | --- |
| `packages/agent/src/harness/foundation/ask-store.ts` | `packages/coding-agent/src/orchestration/ask-store.ts` | move | Durable user-question orchestration; no agent-core runtime consumer. | `coding-agent/src/core/scheduler/messages.ts`; 1 agent test |
| `packages/agent/src/harness/foundation/binding.ts` | same | stay | Immutable binding and epoch validation are execution-loop contracts. | `foundation/{execution,settlement}.ts`; `agent-harness.ts`; 11 coding-agent source modules; 1 test |
| `packages/agent/src/harness/foundation/budget.ts` | same | stay | Budget limits, usage, and ledger interfaces constrain loop/provider execution. | 8 foundation modules; `tool-pipeline.ts`; 8 coding-agent source modules; 7 tests |
| `packages/agent/src/harness/foundation/conformance.ts` | same | stay | Provider/receipt producer checks are part of the execution and settlement gates. | `foundation/{execution,settlement}.ts`; 12 coding-agent source modules; 10 tests |
| `packages/agent/src/harness/foundation/contracts.ts` | same | stay | Generic provider, gateway, observer, transport, and quota contracts are reusable host/loop API. | Public barrel only |
| `packages/agent/src/harness/foundation/durable-store.ts` | `packages/coding-agent/src/orchestration/durable-store.ts` | move | Shared persistence helper is consumed only by the Ask, Goal, and Workflow product stores that move with it. | `foundation/{ask-store,goal-store,workflow-store}.ts` |
| `packages/agent/src/harness/foundation/errors.ts` | same | stay | Foundation and durable error ABI is used throughout the loop and provider boundaries. | 32 foundation modules; 8 other agent source modules; 52 coding-agent source modules; 56 tests |
| `packages/agent/src/harness/foundation/event-catalog.ts` | same | stay | Canonical durable/live/derived event envelope layer is an explicit loop-contract responsibility. | 10 foundation modules; 14 other agent source modules; 32 coding-agent source modules; 22 tests |
| `packages/agent/src/harness/foundation/execution.ts` | same | stay | Dispatch/operation execution and mode switching are the core loop execution path. | `foundation/settlement.ts`; `coding-agent/src/core/scheduler/dispatch.ts`; 1 test |
| `packages/agent/src/harness/foundation/gateway.ts` | same | stay | Scoped model/tool execution gateway enforces binding and budget at the loop boundary. | `coding-agent/src/core/subagent/inprocess-provider.ts`; 1 test |
| `packages/agent/src/harness/foundation/goal-store.ts` | `packages/coding-agent/src/orchestration/goal-store.ts` | move | Goal/Plan/Stage/Todo persistence and mutations are product orchestration, not loop mechanics. | `coding-agent/src/core/connector/product-run.ts`, `coding-agent/src/core/runtime/prompt-ingress.ts`; 1 agent test |
| `packages/agent/src/harness/foundation/goal.ts` | same | stay | The file supplies `AcceptanceCriterion` and `AcceptanceFact` directly to `TaskEnvelope`, settlement results, and `AgentHarness`; moving it would make agent-core depend on coding-agent. It contains contracts, not the Goal store/controller. | 5 foundation modules; `agent-harness.ts`; 3 coding-agent source modules; 3 tests |
| `packages/agent/src/harness/foundation/identity.ts` | same | stay | IDs, correlation, canonical JSON, fingerprints, and lineage are shared loop/event primitives. | 24 foundation modules; 21 other agent source modules; 54 coding-agent source modules; 52 tests |
| `packages/agent/src/harness/foundation/immutability.ts` | same | stay | Deep-frozen contract values enforce loop boundary immutability. | 9 foundation modules; `agent-harness.ts`; 17 coding-agent source modules |
| `packages/agent/src/harness/foundation/index.ts` | same | stay | Barrel remains the retained loop-contract entry point; later move implementation removes only moved re-exports. | `packages/agent/src/index.ts`; 8 agent source modules; agent tests |
| `packages/agent/src/harness/foundation/mcp-selection.ts` | same | stay | MCP selection and narrowing are immutable binding/task execution contracts. | `foundation/{role,role-registry}.ts`; 9 coding-agent source modules; 9 tests |
| `packages/agent/src/harness/foundation/migrations/legacy-foundation-schema.ts` | same | stay | Decoder owns historical agent-core ledger records and is consumed by the session migration adapter. | `coding-agent/src/core/migrations/session-contracts.ts`; 1 agent test |
| `packages/agent/src/harness/foundation/model-call.ts` | same | stay | Host model-call adapter is the loop-to-model boundary. | `agent-harness.ts` |
| `packages/agent/src/harness/foundation/model-profile.ts` | same | stay | Secret-free model profile validation supports binding and settlement. | `foundation/{role-registry-store,settlement}.ts`; 3 coding-agent source modules; 3 tests |
| `packages/agent/src/harness/foundation/observer.ts` | same | stay | Observer cursor/snapshot contracts expose loop events without product orchestration. | `foundation/contracts.ts`; 2 coding-agent provider modules; 1 test |
| `packages/agent/src/harness/foundation/plugin.ts` | same | stay | Plugin lifecycle and hook contracts are reusable host extension contracts. | `foundation/query.ts`; `agent/src/harness/plugins.ts` |
| `packages/agent/src/harness/foundation/profile.ts` | same | stay | Runtime extension/profile contracts are consumed by the reusable harness. | `foundation/query.ts`; 3 agent harness modules; 1 test |
| `packages/agent/src/harness/foundation/protocol.ts` | same | stay | Protocol negotiation and envelope validation are loop/host contracts. | Public barrel; 2 agent tests |
| `packages/agent/src/harness/foundation/providers.ts` | same | stay | Provider interfaces and request/result validation define the execution-loop boundary. | 5 foundation modules; 4 other agent source modules; 36 coding-agent source modules; 46 tests |
| `packages/agent/src/harness/foundation/query.ts` | `packages/coding-agent/src/orchestration/query.ts` | move | Product-wide entity query surface enumerates Goal/Plan/Stage/Todo/Ask/Workflow and has no runtime source consumer; it is not required by the loop. | 1 agent contract test |
| `packages/agent/src/harness/foundation/reference.ts` | same | stay | Versioned/artifact references and resource selectors are shared task/provider contracts. | 10 foundation modules; 5 other agent source modules; 15 coding-agent source modules; 28 tests |
| `packages/agent/src/harness/foundation/results.ts` | same | stay | Worker, attempt, task, and run receipts are explicit loop/settlement contracts. | 5 foundation modules; 2 other agent source modules; 32 coding-agent source modules; 30 tests |
| `packages/agent/src/harness/foundation/role-registry-store.ts` | same | stay | Durable role/model-profile registry persists execution binding inputs, not product workflow state. | 1 agent contract test |
| `packages/agent/src/harness/foundation/role-registry.ts` | same | stay | Role/model selection and binding resolution feed settlement and dispatch. | `foundation/{role-registry-store,settlement}.ts`; 2 coding-agent source modules; 6 tests |
| `packages/agent/src/harness/foundation/role.ts` | same | stay | Role, model route, binding, epoch, and agent-instance types are loop execution contracts. | 11 foundation modules; 2 other agent source modules; 21 coding-agent source modules; 32 tests |
| `packages/agent/src/harness/foundation/schema.ts` | same | stay | Exact-shape parsing/serialization underpins the retained public contracts. | 22 foundation modules; 4 other agent source modules; 11 coding-agent source modules; 1 test |
| `packages/agent/src/harness/foundation/service.ts` | same | stay | Generic service dependency contract is reusable host infrastructure, not workflow orchestration. | `foundation/query.ts`; public barrel |
| `packages/agent/src/harness/foundation/session-ledger.ts` | same | stay | Settlement and durable role state consume the canonical session event ledger; it is loop persistence. | `foundation/{role-registry-store,settlement}.ts`; 20 coding-agent source modules; 36 tests |
| `packages/agent/src/harness/foundation/settlement.ts` | same | stay | Layered task/run settlement and the single terminal-write authority are explicit loop responsibilities. | `agent-harness.ts`; 11 coding-agent source modules; 13 tests |
| `packages/agent/src/harness/foundation/side-effect.ts` | same | stay | Side-effect and idempotency states control safe loop retries and settlement. | `foundation/{providers,results}.ts`; 2 other agent source modules; 8 coding-agent source modules; 7 tests |
| `packages/agent/src/harness/foundation/task.ts` | same | stay | Task, dispatch, and attempt contracts are the central reusable loop contract. | 9 foundation modules; `agent-harness.ts`; 24 coding-agent source modules; 42 tests |
| `packages/agent/src/harness/foundation/workflow-store.ts` | `packages/coding-agent/src/orchestration/workflow-store.ts` | move | Workflow persistence is owned by the product scheduler controller. | `coding-agent/src/core/scheduler/workflow.ts`; 2 tests |
| `packages/agent/src/harness/foundation/workflow.ts` | `packages/coding-agent/src/orchestration/workflow.ts` | move | Workflow DSL, evaluation, migration, and controller-facing helpers are product orchestration and have no agent-loop consumer. | `foundation/{query,workflow-store}.ts`; `coding-agent/src/core/scheduler/workflow.ts`; 4 tests |

## Public exports removed from `packages/agent/src/index.ts` after the move

`durable-store.ts` is not re-exported by the foundation barrel, so it contributes no disappearing public symbol.

- `ask-store.ts`: `AskCreateInput`, `AskEvent`, `AskEventSchema`, `AskEventType`, `AskMutationOptions`, `AskReplyInput`, `AskStore`, `AskStoreOptions`, `AskTimedMutationInput`, `createAskStore`
- `goal-store.ts`: `AcceptanceCriterionInput`, `AcceptanceFactInput`, `GoalCreateInput`, `GoalEvent`, `GoalEventSchema`, `GoalEventType`, `GoalMutationOptions`, `GoalRequestSnapshot`, `GoalStore`, `GoalStoreOptions`, `GoalStoreSnapshot`, `PlanCreateInput`, `StageCreateInput`, `TodoCreateInput`, `createGoalStore`
- `query.ts`: `FOUNDATION_ENTITY_KINDS`, `FoundationEntityId`, `FoundationEntityIdSchema`, `FoundationEntityKind`, `FoundationEntityPublicProjection`, `FoundationEntityPublicProjectionSchema`, `FoundationEntityQuery`, `FoundationEntityQueryProvider`, `FoundationEntityQueryResult`, `FoundationEntityQuerySchema`, `FoundationEntityRecord`, `FoundationEntityValueMap`, `parseFoundationEntityId`, `parseFoundationEntityPublicProjection`, `parseFoundationEntityQuery`, `projectFoundationEntityRecord`, `serializeFoundationEntityId`, `serializeFoundationEntityPublicProjection`, `serializeFoundationEntityQuery`, `validateFoundationEntityId`, `validateFoundationEntityPublicProjection`, `validateFoundationEntityQuery`
- `workflow.ts`: `AcceptanceStep`, `AgentStep`, `AwaitUserStep`, `BarrierStep`, `FOUNDATION_WORKFLOW_DSL_VERSION`, `GateStep`, `ParallelIntent`, `ParallelIntentSchema`, `ParallelStep`, `ToolStep`, `WORKFLOW_STEP_STATUSES`, `WORKFLOW_STEP_TYPES`, `Workflow`, `WorkflowContractKind`, `WorkflowDslVersion`, `WorkflowEvaluationCase`, `WorkflowEvaluationCaseResult`, `WorkflowEvaluationDataset`, `WorkflowEvaluationExpectedStep`, `WorkflowEvaluationObservation`, `WorkflowEvaluationSnapshot`, `WorkflowEvaluationSnapshotSchema`, `WorkflowMigration`, `WorkflowMigrationRegistry`, `WorkflowSchema`, `WorkflowStatus`, `WorkflowStep`, `WorkflowStepBase`, `WorkflowStepSchema`, `WorkflowStepStatus`, `WorkflowValueContract`, `WorkflowValueContractSchema`, `foundationWorkflowMigrationRegistry`, `migrateWorkflow`, `parseWorkflow`, `parseWorkflowEvaluationSnapshot`, `runWorkflowEvaluation`, `serializeWorkflow`, `serializeWorkflowEvaluationSnapshot`, `validateWorkflow`, `workflowAwaitingExternalExecutor`
- `workflow-store.ts`: `WorkflowCreateInput`, `WorkflowEvent`, `WorkflowEventSchema`, `WorkflowEventType`, `WorkflowMutationOptions`, `WorkflowStepTransitionInput`, `WorkflowStore`, `WorkflowStoreOptions`, `createWorkflowStore`

## Test domain and filename paths

### PR-08 test domain and ticket-filename mapping

Baseline: `5043e358c90d49092074a17293e048729eac8566`.

## Scope and rules

- Inventoried all 307 files directly under `packages/coding-agent/test/` (297 Vitest files and 10 helpers).
- Move a top-level file only when its primary exercised source belongs to one of the seven PR-08 domains. CLI, TUI, utility, configuration, and shared helper tests without a primary domain source stay at the test root as `other`.
- `test/suite/regressions/` stays in place. Issue-number regressions retain `<issue>-<slug>`; `policy-t7-fake-sandbox.test.ts` is a ticket name, not an issue-number regression, so it is renamed in place.
- Product tests remain Vitest `.test.ts`. No non-script `.test.mjs` files exist.

## Proposed top-level counts

| Domain | Count | Action |
| --- | ---: | --- |
| connector | 23 | move to `test/connector/` |
| scheduler | 13 | move to `test/scheduler/` |
| subagent | 16 | move to `test/subagent/` |
| worker | 21 | move to `test/worker/` |
| session | 47 | move to `test/session/` |
| policy | 8 | move to `test/policy/` |
| runtime | 73 | move to `test/runtime/` |
| other | 106 | stay at `test/` |
| **Total** | **307** | **201 move; 106 stay** |

## Agent C8-C26 ticket inventory

The original issue inventory contains 19 agent filenames. On this baseline, 13 still need a rename, two were already behavior-renamed, and four capability-manifest tests were deleted before PR-08. Absent files are documentation only and are intentionally omitted from the JSON action list.

| ID | Old ticket path | Behavior path | Baseline status |
| --- | --- | --- | --- |
| C8 | `packages/agent/test/harness/line11-worker-capability-manifest.test.ts` | `packages/agent/test/harness/worker-capability-manifest.test.ts` | absent: deleted in PR-07 |
| C9 | `packages/agent/test/harness/line12a-subagent-capability-manifest.test.ts` | `packages/agent/test/harness/subagent-capability-manifest.test.ts` | absent: deleted in PR-07 |
| C10 | `packages/agent/test/harness/line12b-scheduler-capability-manifest.test.ts` | `packages/agent/test/harness/scheduler-capability-manifest.test.ts` | absent: deleted in PR-07 |
| C11 | `packages/agent/test/harness/line13-connector-capability-manifest.test.ts` | `packages/agent/test/harness/connector-capability-manifest.test.ts` | absent: deleted in PR-07 |
| C12 | `packages/agent/test/harness/foundation-t2-run-authority.test.ts` | `packages/agent/test/harness/run-authority.test.ts` | rename |
| C13 | `packages/agent/test/harness/foundation-t6-role-binding-results.test.ts` | `packages/agent/test/harness/role-binding-results.test.ts` | rename |
| C14 | `packages/agent/test/harness/foundation-t7-ask-store.test.ts` | `packages/agent/test/harness/ask-store.test.ts` | rename |
| C15 | `packages/agent/test/harness/foundation-t7-goal-store.test.ts` | `packages/agent/test/harness/goal-store.test.ts` | rename |
| C16 | `packages/agent/test/harness/foundation-t7-workflow-store.test.ts` | `packages/agent/test/harness/workflow-store.test.ts` | rename |
| C17 | `packages/agent/test/harness/foundation-t12-workflow-evaluation.test.ts` | `packages/agent/test/harness/workflow-evaluation.test.ts` | rename |
| C18 | `packages/agent/test/harness/t4-agent-harness-pipeline.test.ts` | `packages/agent/test/harness/agent-harness-pipeline.test.ts` | rename |
| C19 | `packages/agent/test/harness/t4-runtime-lifecycle.test.ts` | `packages/agent/test/harness/runtime-lifecycle.test.ts` | rename |
| C20 | `packages/agent/test/harness/t4-tool-gateway.test.ts` | `packages/agent/test/harness/tool-gateway.test.ts` | rename |
| C21 | `packages/agent/test/harness/t4-tool-runtime.test.ts` | `packages/agent/test/harness/tool-runtime.test.ts` | rename |
| C22 | `packages/agent/test/harness/t5-tool-gateway.test.ts` | `packages/agent/test/harness/tool-gateway-catalog.test.ts` | rename |
| C23 | `packages/agent/test/harness/t6-executor-gateway-conformance.test.ts` | `packages/agent/test/harness/executor-gateway-conformance.test.ts` | rename |
| C24 | `packages/agent/test/harness/context-t5-ledger.test.ts` | `packages/agent/test/harness/context-ledger.test.ts` | already renamed in PR-07 |
| C25 | `packages/agent/test/harness/context-t5-regressions.test.ts` | `packages/agent/test/harness/context-ledger-regressions.test.ts` | already renamed in PR-07 |
| C26 | `packages/agent/test/harness/session/t11r-recovery.test.ts` | `packages/agent/test/harness/session/session-recovery.test.ts` | rename |

`t4-tool-gateway.test.ts` and `t5-tool-gateway.test.ts` cannot both become `tool-gateway.test.ts`. The latter specifically tests the immutable route catalog, so its behavior name is `tool-gateway-catalog.test.ts`.

## Remaining coding-agent ticket names

| From | To | Domain/action |
| --- | --- | --- |
| `packages/coding-agent/test/t2-cancel-deadline-settlement.test.ts` | `packages/coding-agent/test/runtime/cancel-deadline-settlement.test.ts` | runtime, move+rename |
| `packages/coding-agent/test/t3-binding-authority.test.ts` | `packages/coding-agent/test/runtime/binding-authority.test.ts` | runtime, move+rename |
| `packages/coding-agent/test/suite/regressions/policy-t7-fake-sandbox.test.ts` | `packages/coding-agent/test/suite/regressions/fake-sandbox.test.ts` | suite, rename |

## Non-script .test.mjs inventory

None. The repository's `.test.mjs` files are under `scripts/` or `packages/coding-agent/scripts/`, which are script self-tests allowed by K10.

## Complete current-file map

| From | To | Domain | Action | Reason |
| --- | --- | --- | --- | --- |
| `packages/agent/test/harness/context-ledger-regressions.test.ts` | `packages/agent/test/harness/context-ledger-regressions.test.ts` | agent-harness | stay | Already renamed from its context-t5 ticket filename in PR-07. |
| `packages/agent/test/harness/context-ledger.test.ts` | `packages/agent/test/harness/context-ledger.test.ts` | agent-harness | stay | Already renamed from its context-t5 ticket filename in PR-07. |
| `packages/agent/test/harness/foundation-t12-workflow-evaluation.test.ts` | `packages/agent/test/harness/workflow-evaluation.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/foundation-t2-run-authority.test.ts` | `packages/agent/test/harness/run-authority.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/foundation-t6-role-binding-results.test.ts` | `packages/agent/test/harness/role-binding-results.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/foundation-t7-ask-store.test.ts` | `packages/agent/test/harness/ask-store.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/foundation-t7-goal-store.test.ts` | `packages/agent/test/harness/goal-store.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/foundation-t7-workflow-store.test.ts` | `packages/agent/test/harness/workflow-store.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/session/t11r-recovery.test.ts` | `packages/agent/test/harness/session/session-recovery.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/t4-agent-harness-pipeline.test.ts` | `packages/agent/test/harness/agent-harness-pipeline.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/t4-runtime-lifecycle.test.ts` | `packages/agent/test/harness/runtime-lifecycle.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/t4-tool-gateway.test.ts` | `packages/agent/test/harness/tool-gateway.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/t4-tool-runtime.test.ts` | `packages/agent/test/harness/tool-runtime.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/agent/test/harness/t5-tool-gateway.test.ts` | `packages/agent/test/harness/tool-gateway-catalog.test.ts` | agent-harness | rename | Names the immutable Tool Gateway catalog behavior and avoids colliding with the T4 gateway test. |
| `packages/agent/test/harness/t6-executor-gateway-conformance.test.ts` | `packages/agent/test/harness/executor-gateway-conformance.test.ts` | agent-harness | rename | Removes the implementation-ticket prefix while preserving the tested harness behavior. |
| `packages/coding-agent/test/acp-connector.test.ts` | `packages/coding-agent/test/connector/acp-connector.test.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-agent-operation.ts`, `external-tool-policy-operation.ts`. |
| `packages/coding-agent/test/agent-runtime-composition.test.ts` | `packages/coding-agent/test/runtime/agent-runtime-composition.test.ts` | runtime | move | Exercises runtime source via `external-agent-registry.ts`, `auth-storage.ts`, `agent-session.ts`. |
| `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts` | `packages/coding-agent/test/session/agent-session-auto-compaction-queue.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-branching.test.ts` | `packages/coding-agent/test/session/agent-session-branching.test.ts` | session | move | Exercises session source via `agent-session.ts`, `agent-session-runtime.ts`. |
| `packages/coding-agent/test/agent-session-capabilities.test.ts` | `packages/coding-agent/test/session/agent-session-capabilities.test.ts` | session | move | Exercises session source via `agent-session.ts`, `context-engine.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-capability-controls.test.ts` | `packages/coding-agent/test/session/agent-session-capability-controls.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-compaction.test.ts` | `packages/coding-agent/test/session/agent-session-compaction.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-concurrent.test.ts` | `packages/coding-agent/test/session/agent-session-concurrent.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-dynamic-provider.test.ts` | `packages/coding-agent/test/session/agent-session-dynamic-provider.test.ts` | session | move | Exercises session source via `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-dynamic-tools.test.ts` | `packages/coding-agent/test/session/agent-session-dynamic-tools.test.ts` | session | move | Exercises session source via `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-mcp-content.test.ts` | `packages/coding-agent/test/session/agent-session-mcp-content.test.ts` | session | move | Exercises session source via `agent-session.ts`, `context-engine.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-retry.test.ts` | `packages/coding-agent/test/session/agent-session-retry.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-runtime-events.test.ts` | `packages/coding-agent/test/session/agent-session-runtime-events.test.ts` | session | move | Exercises session source via `agent-session-runtime.ts`, `agent-session.ts`, `current-session-scope.ts`. |
| `packages/coding-agent/test/agent-session-stats.test.ts` | `packages/coding-agent/test/session/agent-session-stats.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-task-credential.test.ts` | `packages/coding-agent/test/session/agent-session-task-credential.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/agent-session-tree-navigation.test.ts` | `packages/coding-agent/test/session/agent-session-tree-navigation.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/ansi-utils.test.ts` | `packages/coding-agent/test/ansi-utils.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/aos-user-agent.test.ts` | `packages/coding-agent/test/aos-user-agent.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/args.test.ts` | `packages/coding-agent/test/args.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/assistant-message.test.ts` | `packages/coding-agent/test/assistant-message.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/auth-check.test.ts` | `packages/coding-agent/test/auth-check.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/auth-storage.test.ts` | `packages/coding-agent/test/runtime/auth-storage.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`. |
| `packages/coding-agent/test/automation-run-ledger-migration.test.ts` | `packages/coding-agent/test/automation-run-ledger-migration.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/automation-run-projection.test.ts` | `packages/coding-agent/test/runtime/automation-run-projection.test.ts` | runtime | move | Exercises runtime source via `automation-run-projection.ts`. |
| `packages/coding-agent/test/bash-close-hang-windows.test.ts` | `packages/coding-agent/test/bash-close-hang-windows.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/bash-execution-width.test.ts` | `packages/coding-agent/test/bash-execution-width.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/binding-handles.test.ts` | `packages/coding-agent/test/runtime/binding-handles.test.ts` | runtime | move | Exercises runtime source via `binding-handles.ts`, `capability-registry.ts`, `execution-policy.ts`. |
| `packages/coding-agent/test/block-images.test.ts` | `packages/coding-agent/test/block-images.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/branch-summary-extensions.test.ts` | `packages/coding-agent/test/session/branch-summary-extensions.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/cache-stats.test.ts` | `packages/coding-agent/test/session/cache-stats.test.ts` | session | move | Exercises session source via `cache-stats.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/capability-public-identity.test.ts` | `packages/coding-agent/test/runtime/capability-public-identity.test.ts` | runtime | move | Exercises runtime source via `capability-public-identity.ts`. |
| `packages/coding-agent/test/capability-registry.test.ts` | `packages/coding-agent/test/runtime/capability-registry.test.ts` | runtime | move | Exercises runtime source via `capability-registry.ts`, `capability-public-identity.ts`, `source-info.ts`. |
| `packages/coding-agent/test/capability-settings.test.ts` | `packages/coding-agent/test/runtime/capability-settings.test.ts` | runtime | move | Exercises runtime source via `capability-settings.ts`, `capability-registry.ts`. |
| `packages/coding-agent/test/changelog.test.ts` | `packages/coding-agent/test/changelog.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/claude-connector.test.ts` | `packages/coding-agent/test/connector/claude-connector.test.ts` | connector | move | Exercises connector source via `external-session-mapping.ts`, `claude.ts`, `types.ts`. |
| `packages/coding-agent/test/cli-process.ts` | `packages/coding-agent/test/cli-process.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/clipboard-image-bmp-conversion.test.ts` | `packages/coding-agent/test/clipboard-image-bmp-conversion.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/clipboard-image.test.ts` | `packages/coding-agent/test/clipboard-image.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/clipboard-native.test.ts` | `packages/coding-agent/test/clipboard-native.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/clipboard.test.ts` | `packages/coding-agent/test/clipboard.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/codex-connector.test.ts` | `packages/coding-agent/test/connector/codex-connector.test.ts` | connector | move | Exercises connector source via `external-session-mapping.ts`, `codex.ts`, `types.ts`. |
| `packages/coding-agent/test/compaction-extensions-example.test.ts` | `packages/coding-agent/test/session/compaction-extensions-example.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/compaction-extensions.test.ts` | `packages/coding-agent/test/session/compaction-extensions.test.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/compaction-serialization.test.ts` | `packages/coding-agent/test/session/compaction-serialization.test.ts` | session | move | Exercises session source via `utils.ts`. |
| `packages/coding-agent/test/compaction-summary-reasoning.test.ts` | `packages/coding-agent/test/session/compaction-summary-reasoning.test.ts` | session | move | Exercises session source via `index.ts`. |
| `packages/coding-agent/test/compaction.test.ts` | `packages/coding-agent/test/session/compaction.test.ts` | session | move | Exercises session source via `index.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/config-value-migration.test.ts` | `packages/coding-agent/test/config-value-migration.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/config.test.ts` | `packages/coding-agent/test/config.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/connector-retry-circuit.test.ts` | `packages/coding-agent/test/connector/connector-retry-circuit.test.ts` | connector | move | Exercises connector source via `connector-retry-circuit.ts`. |
| `packages/coding-agent/test/connector-runtime-status.test.ts` | `packages/coding-agent/test/connector/connector-runtime-status.test.ts` | connector | move | Exercises connector source via `connector-runtime-status.ts`, `connector-retry-circuit.ts`, `external-connector-readiness.ts`. |
| `packages/coding-agent/test/context-engine-runtime.test.ts` | `packages/coding-agent/test/session/context-engine-runtime.test.ts` | session | move | Exercises session source via `context-engine.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/context-engine-surfaces.test.ts` | `packages/coding-agent/test/session/context-engine-surfaces.test.ts` | session | move | Exercises session source via `context-engine.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/context-engine.test.ts` | `packages/coding-agent/test/session/context-engine.test.ts` | session | move | Exercises session source via `context-engine.ts`, `compaction.ts`. |
| `packages/coding-agent/test/context-memory-store.test.ts` | `packages/coding-agent/test/session/context-memory-store.test.ts` | session | move | Exercises session source via `context-memory-store.ts`. |
| `packages/coding-agent/test/control-plane-atomic-storage.test.ts` | `packages/coding-agent/test/runtime/control-plane-atomic-storage.test.ts` | runtime | move | Exercises runtime source via `control-plane-atomic-storage.ts`, `auth-storage.ts`, `settings-manager.ts`. |
| `packages/coding-agent/test/core-quality-boundaries.test.ts` | `packages/coding-agent/test/runtime/core-quality-boundaries.test.ts` | runtime | move | Exercises runtime source via `execution-error.ts`, `index.ts`, `model-broker.ts`. |
| `packages/coding-agent/test/credential-print.test.ts` | `packages/coding-agent/test/credential-print.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/current-session-scope.test.ts` | `packages/coding-agent/test/session/current-session-scope.test.ts` | session | move | Exercises session source via `current-session-scope.ts`. |
| `packages/coding-agent/test/custom-editor-history-keybindings.test.ts` | `packages/coding-agent/test/custom-editor-history-keybindings.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/custom-message.test.ts` | `packages/coding-agent/test/custom-message.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/edit-tool-legacy-input.test.ts` | `packages/coding-agent/test/edit-tool-legacy-input.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts` | `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/execution-audit-adapter.test.ts` | `packages/coding-agent/test/runtime/execution-audit-adapter.test.ts` | runtime | move | Exercises runtime source via `execution-audit.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/execution-audit-canonical-integration.test.ts` | `packages/coding-agent/test/runtime/execution-audit-canonical-integration.test.ts` | runtime | move | Exercises runtime source via `execution-audit.ts`, `execution-audit-query.ts`, `session-manager-storage.ts`. |
| `packages/coding-agent/test/execution-audit-contract.test.ts` | `packages/coding-agent/test/runtime/execution-audit-contract.test.ts` | runtime | move | Exercises runtime source via `execution-audit.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/execution-audit-mcp-content.test.ts` | `packages/coding-agent/test/runtime/execution-audit-mcp-content.test.ts` | runtime | move | Exercises runtime source via `execution-audit.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/execution-audit-query.test.ts` | `packages/coding-agent/test/runtime/execution-audit-query.test.ts` | runtime | move | Exercises runtime source via `execution-audit-query.ts`, `execution-audit.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/execution-policy-contract.test.ts` | `packages/coding-agent/test/policy/execution-policy-contract.test.ts` | policy | move | Exercises policy behavior; colocate with that source domain. |
| `packages/coding-agent/test/execution-policy-ledger.test.ts` | `packages/coding-agent/test/policy/execution-policy-ledger.test.ts` | policy | move | Exercises policy source via `execution-policy-ledger.ts`, `execution-policy.ts`. |
| `packages/coding-agent/test/execution-policy-settings.test.ts` | `packages/coding-agent/test/policy/execution-policy-settings.test.ts` | policy | move | Exercises policy source via `execution-policy-settings.ts`, `execution-policy.ts`. |
| `packages/coding-agent/test/execution-policy.test.ts` | `packages/coding-agent/test/policy/execution-policy.test.ts` | policy | move | Exercises policy source via `execution-policy.ts`. |
| `packages/coding-agent/test/experimental-cli-command.test.ts` | `packages/coding-agent/test/experimental-cli-command.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/experimental-cli-resolution.test.ts` | `packages/coding-agent/test/experimental-cli-resolution.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/experimental.test.ts` | `packages/coding-agent/test/runtime/experimental.test.ts` | runtime | move | Exercises runtime source via `experimental.ts`. |
| `packages/coding-agent/test/export-html-skill-block.test.ts` | `packages/coding-agent/test/export-html-skill-block.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/export-html-whitespace.test.ts` | `packages/coding-agent/test/export-html-whitespace.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/export-html-xss.test.ts` | `packages/coding-agent/test/export-html-xss.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/extensions-discovery.test.ts` | `packages/coding-agent/test/extensions-discovery.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/extensions-input-event.test.ts` | `packages/coding-agent/test/extensions-input-event.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/extensions-runner.test.ts` | `packages/coding-agent/test/extensions-runner.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/external-agent-capability-truth.test.ts` | `packages/coding-agent/test/connector/external-agent-capability-truth.test.ts` | connector | move | Exercises connector source via `external-model-projection.ts`. |
| `packages/coding-agent/test/external-agent-connector-lifecycle.test.ts` | `packages/coding-agent/test/connector/external-agent-connector-lifecycle.test.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-agent-operation.ts`, `external-session-mapping.ts`. |
| `packages/coding-agent/test/external-agent-input.test.ts` | `packages/coding-agent/test/connector/external-agent-input.test.ts` | connector | move | Exercises connector source via `external-agent-input.ts`. |
| `packages/coding-agent/test/external-agent-integration.test.ts` | `packages/coding-agent/test/connector/external-agent-integration.test.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-connector-product.ts`, `external-agent-operation.ts`. |
| `packages/coding-agent/test/external-agent-model.test.ts` | `packages/coding-agent/test/connector/external-agent-model.test.ts` | connector | move | Exercises connector source via `external-model-projection.ts`. |
| `packages/coding-agent/test/external-agent-public-exports.test.ts` | `packages/coding-agent/test/connector/external-agent-public-exports.test.ts` | connector | move | Exercises connector source via `external-connector.ts`, `types.ts`. |
| `packages/coding-agent/test/external-connector-process-controller.test.ts` | `packages/coding-agent/test/connector/external-connector-process-controller.test.ts` | connector | move | Exercises connector source via `external-connector-process-controller.ts`, `external-connector-supervisor.ts`. |
| `packages/coding-agent/test/external-connector-production.test.ts` | `packages/coding-agent/test/connector/external-connector-production.test.ts` | connector | move | Exercises connector source via `external-connector-production.ts`, `external-agent-connector.ts`, `external-agent-operation.ts`. |
| `packages/coding-agent/test/external-connector-public-taxonomy.test.ts` | `packages/coding-agent/test/connector/external-connector-public-taxonomy.test.ts` | connector | move | Exercises connector behavior; colocate with that source domain. |
| `packages/coding-agent/test/external-connector-readiness-projection.test.ts` | `packages/coding-agent/test/connector/external-connector-readiness-projection.test.ts` | connector | move | Exercises connector source via `external-agent-operation.ts`, `external-agent-registry.ts`, `external-connector-production.ts`. |
| `packages/coding-agent/test/external-connector-receipt-authority.test.ts` | `packages/coding-agent/test/connector/external-connector-receipt-authority.test.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-agent-registry.ts`, `external-agent-operation.ts`. |
| `packages/coding-agent/test/external-connector-registry.test.ts` | `packages/coding-agent/test/connector/external-connector-registry.test.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-agent-operation.ts`, `external-tool-gateway-authority.ts`. |
| `packages/coding-agent/test/external-connector-settings.test.ts` | `packages/coding-agent/test/connector/external-connector-settings.test.ts` | connector | move | Exercises connector source via `external-connector-target-config.ts`. |
| `packages/coding-agent/test/external-connector-supervisor.test.ts` | `packages/coding-agent/test/connector/external-connector-supervisor.test.ts` | connector | move | Exercises connector source via `external-connector-supervisor.ts`. |
| `packages/coding-agent/test/external-connector-test-supervision.ts` | `packages/coding-agent/test/connector/external-connector-test-supervision.ts` | connector | move | Exercises connector source via `external-agent-connector.ts`, `external-agent-operation.ts`, `external-connector-supervisor.ts`. |
| `packages/coding-agent/test/external-editor.test.ts` | `packages/coding-agent/test/external-editor.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/external-process-supervision.test.ts` | `packages/coding-agent/test/connector/external-process-supervision.test.ts` | connector | move | Exercises connector source via `external-agent-operation.ts`, `external-connector-process-controller.ts`, `external-connector-production.ts`. |
| `packages/coding-agent/test/file-mutation-queue.test.ts` | `packages/coding-agent/test/file-mutation-queue.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/first-time-setup-fork.test.ts` | `packages/coding-agent/test/first-time-setup-fork.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/first-time-setup.test.ts` | `packages/coding-agent/test/first-time-setup.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/footer-data-provider.test.ts` | `packages/coding-agent/test/footer-data-provider.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/footer-width.test.ts` | `packages/coding-agent/test/footer-width.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/format-resume-command.test.ts` | `packages/coding-agent/test/session/format-resume-command.test.ts` | session | move | Exercises session source via `session-manager.ts`. |
| `packages/coding-agent/test/foundation-runtime-session-surfaces.test.ts` | `packages/coding-agent/test/session/foundation-runtime-session-surfaces.test.ts` | session | move | Exercises session source via `agent-session-facade.ts`, `agent-session.ts`, `execution-audit-query.ts`. |
| `packages/coding-agent/test/frontmatter.test.ts` | `packages/coding-agent/test/frontmatter.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/git-merge-and-resolve-extension.test.ts` | `packages/coding-agent/test/git-merge-and-resolve-extension.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/git-ssh-url.test.ts` | `packages/coding-agent/test/git-ssh-url.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/git-update.test.ts` | `packages/coding-agent/test/git-update.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/gondolin-sandbox-provider.test.ts` | `packages/coding-agent/test/worker/gondolin-sandbox-provider.test.ts` | worker | move | Exercises worker source via `sandbox.ts`, `remote-operation.ts`. |
| `packages/coding-agent/test/http-dispatcher.test.ts` | `packages/coding-agent/test/runtime/http-dispatcher.test.ts` | runtime | move | Exercises runtime source via `http-dispatcher.ts`. |
| `packages/coding-agent/test/image-process.test.ts` | `packages/coding-agent/test/image-process.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/image-processing.test.ts` | `packages/coding-agent/test/image-processing.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/image-resize-callers.test.ts` | `packages/coding-agent/test/image-resize-callers.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/initial-message.test.ts` | `packages/coding-agent/test/initial-message.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/input-transform-streaming-example.test.ts` | `packages/coding-agent/test/input-transform-streaming-example.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mcp-command.test.ts` | `packages/coding-agent/test/interactive-mcp-command.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-anthropic-warning.test.ts` | `packages/coding-agent/test/interactive-mode-anthropic-warning.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-clone-command.test.ts` | `packages/coding-agent/test/interactive-mode-clone-command.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-compaction.test.ts` | `packages/coding-agent/test/interactive-mode-compaction.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-import-command.test.ts` | `packages/coding-agent/test/interactive-mode-import-command.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-startup-input.test.ts` | `packages/coding-agent/test/interactive-mode-startup-input.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-status.test.ts` | `packages/coding-agent/test/interactive-mode-status.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-mode-suspend.test.ts` | `packages/coding-agent/test/interactive-mode-suspend.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/interactive-tui.test.ts` | `packages/coding-agent/test/interactive-tui.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/keybindings-migration.test.ts` | `packages/coding-agent/test/keybindings-migration.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/llama-extension.test.ts` | `packages/coding-agent/test/llama-extension.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/management-http.test.ts` | `packages/coding-agent/test/management-http.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/max-thinking.test.ts` | `packages/coding-agent/test/max-thinking.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/mcp-attachment.test.ts` | `packages/coding-agent/test/runtime/mcp-attachment.test.ts` | runtime | move | Exercises runtime source via `mcp-attachment.ts`, `mcp-content.ts`, `context-engine.ts`. |
| `packages/coding-agent/test/mcp-auth-manager.test.ts` | `packages/coding-agent/test/runtime/mcp-auth-manager.test.ts` | runtime | move | Exercises runtime source via `mcp-auth-manager.ts`, `auth-storage.ts`, `mcp-auth-storage.ts`. |
| `packages/coding-agent/test/mcp-auth-public-exports.test.ts` | `packages/coding-agent/test/runtime/mcp-auth-public-exports.test.ts` | runtime | move | Exercises runtime behavior; colocate with that source domain. |
| `packages/coding-agent/test/mcp-auth-storage.test.ts` | `packages/coding-agent/test/runtime/mcp-auth-storage.test.ts` | runtime | move | Exercises runtime source via `mcp-auth-storage.ts`, `auth-storage.ts`. |
| `packages/coding-agent/test/mcp-auth.test.ts` | `packages/coding-agent/test/runtime/mcp-auth.test.ts` | runtime | move | Exercises runtime source via `mcp-auth.ts`. |
| `packages/coding-agent/test/mcp-content-safety.test.ts` | `packages/coding-agent/test/runtime/mcp-content-safety.test.ts` | runtime | move | Exercises runtime source via `mcp-content.ts`, `mcp-types.ts`. |
| `packages/coding-agent/test/mcp-default-wiring.test.ts` | `packages/coding-agent/test/runtime/mcp-default-wiring.test.ts` | runtime | move | Exercises runtime source via `agent-session-services.ts`, `auth-storage.ts`, `mcp-auth-manager.ts`. |
| `packages/coding-agent/test/mcp-error-codes.test.ts` | `packages/coding-agent/test/runtime/mcp-error-codes.test.ts` | runtime | move | Exercises runtime source via `mcp-error-codes.ts`. |
| `packages/coding-agent/test/mcp-exact-selection.test.ts` | `packages/coding-agent/test/runtime/mcp-exact-selection.test.ts` | runtime | move | Exercises runtime source via `capability-public-identity.ts`, `capability-registry.ts`, `source-info.ts`. |
| `packages/coding-agent/test/mcp-lifecycle.test.ts` | `packages/coding-agent/test/runtime/mcp-lifecycle.test.ts` | runtime | move | Exercises runtime source via `mcp-lifecycle.ts`, `mcp-types.ts`. |
| `packages/coding-agent/test/mcp-resource-prompt.test.ts` | `packages/coding-agent/test/runtime/mcp-resource-prompt.test.ts` | runtime | move | Exercises runtime source via `mcp-lifecycle.ts`, `mcp-content.ts`, `mcp-types.ts`. |
| `packages/coding-agent/test/mcp-tool-adapter.test.ts` | `packages/coding-agent/test/runtime/mcp-tool-adapter.test.ts` | runtime | move | Exercises runtime source via `mcp-tool-adapter.ts`, `capability-public-identity.ts`, `capability-registry.ts`. |
| `packages/coding-agent/test/mermaid.test.ts` | `packages/coding-agent/test/mermaid.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/migrations-atomic-write.test.ts` | `packages/coding-agent/test/runtime/migrations-atomic-write.test.ts` | runtime | move | Exercises runtime source via `control-plane-atomic-storage.ts`. |
| `packages/coding-agent/test/model-broker-ledger.test.ts` | `packages/coding-agent/test/runtime/model-broker-ledger.test.ts` | runtime | move | Exercises runtime source via `model-broker-ledger.ts`. |
| `packages/coding-agent/test/model-broker-settings.test.ts` | `packages/coding-agent/test/runtime/model-broker-settings.test.ts` | runtime | move | Exercises runtime source via `model-broker-settings.ts`, `settings-manager.ts`. |
| `packages/coding-agent/test/model-broker.test.ts` | `packages/coding-agent/test/runtime/model-broker.test.ts` | runtime | move | Exercises runtime source via `model-broker.ts`. |
| `packages/coding-agent/test/model-registry.test.ts` | `packages/coding-agent/test/runtime/model-registry.test.ts` | runtime | move | Exercises runtime source via `model-registry.ts`, `auth-storage.ts`. |
| `packages/coding-agent/test/model-resolver.test.ts` | `packages/coding-agent/test/runtime/model-resolver.test.ts` | runtime | move | Exercises runtime source via `model-resolver.ts`. |
| `packages/coding-agent/test/model-runtime-auth-options.test.ts` | `packages/coding-agent/test/runtime/model-runtime-auth-options.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `model-runtime.ts`. |
| `packages/coding-agent/test/model-runtime-cloudflare-compat.test.ts` | `packages/coding-agent/test/runtime/model-runtime-cloudflare-compat.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `model-registry.ts`, `model-runtime.ts`. |
| `packages/coding-agent/test/model-runtime-credential-sync.test.ts` | `packages/coding-agent/test/runtime/model-runtime-credential-sync.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `model-runtime.ts`. |
| `packages/coding-agent/test/model-runtime-modify-models-compat.test.ts` | `packages/coding-agent/test/runtime/model-runtime-modify-models-compat.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `model-registry.ts`, `model-runtime.ts`. |
| `packages/coding-agent/test/model-runtime-test-utils.ts` | `packages/coding-agent/test/runtime/model-runtime-test-utils.ts` | runtime | move | Exercises runtime source via `model-registry.ts`, `model-runtime.ts`, `models-store.ts`. |
| `packages/coding-agent/test/model-selector.test.ts` | `packages/coding-agent/test/runtime/model-selector.test.ts` | runtime | move | Exercises runtime behavior; colocate with that source domain. |
| `packages/coding-agent/test/models-store.test.ts` | `packages/coding-agent/test/runtime/models-store.test.ts` | runtime | move | Exercises runtime source via `models-store.ts`. |
| `packages/coding-agent/test/naming-contract.test.ts` | `packages/coding-agent/test/naming-contract.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/oauth-selector.test.ts` | `packages/coding-agent/test/oauth-selector.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/package-command-paths.test.ts` | `packages/coding-agent/test/package-command-paths.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/package-manager-ssh.test.ts` | `packages/coding-agent/test/package-manager-ssh.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/package-manager.test.ts` | `packages/coding-agent/test/package-manager.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/packaged-external-agent-driver.test.ts` | `packages/coding-agent/test/connector/packaged-external-agent-driver.test.ts` | connector | move | Exercises connector source via `packaged-external-agent-driver.ts`. |
| `packages/coding-agent/test/path-utils.test.ts` | `packages/coding-agent/test/path-utils.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/paths.test.ts` | `packages/coding-agent/test/paths.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/plan-mode-extension.test.ts` | `packages/coding-agent/test/plan-mode-extension.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/plan-mode-utils.test.ts` | `packages/coding-agent/test/plan-mode-utils.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/print-mode.test.ts` | `packages/coding-agent/test/session/print-mode.test.ts` | session | move | Exercises session source via `current-session-scope.ts`. |
| `packages/coding-agent/test/product-entry-composition.test.ts` | `packages/coding-agent/test/connector/product-entry-composition.test.ts` | connector | move | Exercises connector source via `packaged-external-agent-driver.ts`. |
| `packages/coding-agent/test/product-prompt-composition.test.ts` | `packages/coding-agent/test/runtime/product-prompt-composition.test.ts` | runtime | move | Exercises runtime source via `prompt-task-adapter.ts`, `product-prompt-ingress.ts`, `subagent-composition.ts`. |
| `packages/coding-agent/test/product-prompt-ingress.test.ts` | `packages/coding-agent/test/runtime/product-prompt-ingress.test.ts` | runtime | move | Exercises runtime source via `product-prompt-ingress.ts`, `product-prompt-binding-authority.ts`, `subagent-composition.ts`. |
| `packages/coding-agent/test/prompt-task-adapter.test.ts` | `packages/coding-agent/test/runtime/prompt-task-adapter.test.ts` | runtime | move | Exercises runtime source via `prompt-task-adapter.ts`. |
| `packages/coding-agent/test/prompt-templates.test.ts` | `packages/coding-agent/test/runtime/prompt-templates.test.ts` | runtime | move | Exercises runtime source via `prompt-templates.ts`. |
| `packages/coding-agent/test/protected-path-review.test.ts` | `packages/coding-agent/test/policy/protected-path-review.test.ts` | policy | move | Exercises policy source via `capability-settings.ts`, `execution-policy.ts`, `execution-policy-ledger.ts`. |
| `packages/coding-agent/test/protocol-resource-limits.test.ts` | `packages/coding-agent/test/runtime/protocol-resource-limits.test.ts` | runtime | move | Exercises runtime source via `bounded-protocol.ts`, `runtime-clock.ts`. |
| `packages/coding-agent/test/public-api-contract.test.ts` | `packages/coding-agent/test/public-api-contract.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/public-naming.test.ts` | `packages/coding-agent/test/public-naming.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/radius.test.ts` | `packages/coding-agent/test/runtime/radius.test.ts` | runtime | move | Exercises runtime source via `radius.ts`, `auth-storage.ts`, `model-runtime.ts`. |
| `packages/coding-agent/test/remote-catalog-provider.test.ts` | `packages/coding-agent/test/runtime/remote-catalog-provider.test.ts` | runtime | move | Exercises runtime source via `remote-catalog-provider.ts`. |
| `packages/coding-agent/test/remote-operation-contract.test.ts` | `packages/coding-agent/test/worker/remote-operation-contract.test.ts` | worker | move | Exercises worker source via `remote-operation.ts`, `task-credential-store.ts`, `task-credential-provider.ts`. |
| `packages/coding-agent/test/resolve-config-value.test.ts` | `packages/coding-agent/test/runtime/resolve-config-value.test.ts` | runtime | move | Exercises runtime source via `resolve-config-value.ts`. |
| `packages/coding-agent/test/resource-loader.test.ts` | `packages/coding-agent/test/runtime/resource-loader.test.ts` | runtime | move | Exercises runtime source via `resource-loader.ts`, `auth-storage.ts`, `runner.ts`. |
| `packages/coding-agent/test/restore-sandbox-env.test.ts` | `packages/coding-agent/test/worker/restore-sandbox-env.test.ts` | worker | move | Exercises worker behavior; colocate with that source domain. |
| `packages/coding-agent/test/rpc-automation-run.test.ts` | `packages/coding-agent/test/runtime/rpc-automation-run.test.ts` | runtime | move | Exercises runtime source via `agent-session.ts`, `agent-runtime-composition.ts`, `agent-session-facade.ts`. |
| `packages/coding-agent/test/rpc-capabilities.test.ts` | `packages/coding-agent/test/runtime/rpc-capabilities.test.ts` | runtime | move | Exercises runtime source via `agent-session-runtime.ts`, `capability-registry.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/rpc-client-automation-run.test.ts` | `packages/coding-agent/test/rpc-client-automation-run.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-capabilities.test.ts` | `packages/coding-agent/test/rpc-client-capabilities.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-clone.test.ts` | `packages/coding-agent/test/rpc-client-clone.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-mcp-auth.test.ts` | `packages/coding-agent/test/rpc-client-mcp-auth.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-mcp-content.test.ts` | `packages/coding-agent/test/rpc-client-mcp-content.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-model-broker.test.ts` | `packages/coding-agent/test/rpc-client-model-broker.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-process-exit.test.ts` | `packages/coding-agent/test/rpc-client-process-exit.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-replay-recovery.test.ts` | `packages/coding-agent/test/rpc-client-replay-recovery.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-client-transport.test.ts` | `packages/coding-agent/test/rpc-client-transport.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-example.ts` | `packages/coding-agent/test/rpc-example.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-host-attach.test.ts` | `packages/coding-agent/test/session/rpc-host-attach.test.ts` | session | move | Exercises session source via `agent-session.ts`, `agent-session-facade.ts`, `agent-session-runtime.ts`. |
| `packages/coding-agent/test/rpc-jsonl.test.ts` | `packages/coding-agent/test/rpc-jsonl.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-mcp-auth.test.ts` | `packages/coding-agent/test/runtime/rpc-mcp-auth.test.ts` | runtime | move | Exercises runtime source via `agent-session.ts`, `agent-session-runtime.ts`, `auth-storage.ts`. |
| `packages/coding-agent/test/rpc-mcp-content.test.ts` | `packages/coding-agent/test/runtime/rpc-mcp-content.test.ts` | runtime | move | Exercises runtime source via `agent-session.ts`, `agent-session-runtime.ts`, `auth-storage.ts`. |
| `packages/coding-agent/test/rpc-model-broker.test.ts` | `packages/coding-agent/test/runtime/rpc-model-broker.test.ts` | runtime | move | Exercises runtime source via `model-broker.ts`. |
| `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts` | `packages/coding-agent/test/session/rpc-prompt-response-semantics.test.ts` | session | move | Exercises session source via `agent-session.ts`, `agent-session-runtime.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/rpc-run-canonical-conflict.test.ts` | `packages/coding-agent/test/session/rpc-run-canonical-conflict.test.ts` | session | move | Exercises session source via `agent-session.ts`, `agent-session-runtime.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/rpc-scheduler.test.ts` | `packages/coding-agent/test/scheduler/rpc-scheduler.test.ts` | scheduler | move | Exercises scheduler behavior; colocate with that source domain. |
| `packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts` | `packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-subagent.test.ts` | `packages/coding-agent/test/subagent/rpc-subagent.test.ts` | subagent | move | Exercises subagent source via `subagent-composition.ts`. |
| `packages/coding-agent/test/rpc-task-credential.test.ts` | `packages/coding-agent/test/worker/rpc-task-credential.test.ts` | worker | move | Exercises worker source via `sandbox.ts`, `task-credential-provider.ts`, `task-credential-lease.ts`. |
| `packages/coding-agent/test/rpc-task-gate.test.ts` | `packages/coding-agent/test/policy/rpc-task-gate.test.ts` | policy | move | Exercises policy source via `execution-policy-ledger.ts`, `execution-policy.ts`. |
| `packages/coding-agent/test/rpc-task-graph.test.ts` | `packages/coding-agent/test/scheduler/rpc-task-graph.test.ts` | scheduler | move | Exercises scheduler behavior; colocate with that source domain. |
| `packages/coding-agent/test/rpc-tcp-cancel-idempotency.test.ts` | `packages/coding-agent/test/session/rpc-tcp-cancel-idempotency.test.ts` | session | move | Exercises session source via `agent-session.ts`, `agent-session-facade.ts`, `agent-session-runtime.ts`. |
| `packages/coding-agent/test/rpc-transport-address.test.ts` | `packages/coding-agent/test/rpc-transport-address.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-transport.test.ts` | `packages/coding-agent/test/rpc-transport.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/rpc-worker.test.ts` | `packages/coding-agent/test/worker/rpc-worker.test.ts` | worker | move | Exercises worker source via `worker.ts`, `worker-sandbox-provider.ts`. |
| `packages/coding-agent/test/rpc.test.ts` | `packages/coding-agent/test/rpc.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/run-lifecycle-canonical-conflict.test.ts` | `packages/coding-agent/test/runtime/run-lifecycle-canonical-conflict.test.ts` | runtime | move | Exercises runtime source via `session-entry.ts`, `run-lifecycle.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/run-lifecycle-process-boundary.test.ts` | `packages/coding-agent/test/runtime/run-lifecycle-process-boundary.test.ts` | runtime | move | Exercises runtime source via `run-lifecycle.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/run-lifecycle-subagent.test.ts` | `packages/coding-agent/test/subagent/run-lifecycle-subagent.test.ts` | subagent | move | Exercises subagent behavior; colocate with that source domain. |
| `packages/coding-agent/test/run-lifecycle-worker.test.ts` | `packages/coding-agent/test/worker/run-lifecycle-worker.test.ts` | worker | move | Exercises worker source via `worker-sandbox-provider.ts`, `worker-supervisor.ts`. |
| `packages/coding-agent/test/run-lifecycle.test.ts` | `packages/coding-agent/test/runtime/run-lifecycle.test.ts` | runtime | move | Exercises runtime source via `run-lifecycle.ts`, `agent-session.ts`, `capability-registry.ts`. |
| `packages/coding-agent/test/run-terminal-cross-layer-acceptance.test.ts` | `packages/coding-agent/test/runtime/run-terminal-cross-layer-acceptance.test.ts` | runtime | move | Exercises runtime source via `automation-run-projection.ts`, `execution-audit-query.ts`, `run-lifecycle.ts`. |
| `packages/coding-agent/test/runtime-clock.test.ts` | `packages/coding-agent/test/runtime/runtime-clock.test.ts` | runtime | move | Exercises runtime source via `runtime-clock.ts`, `scheduler.ts`. |
| `packages/coding-agent/test/runtime-credentials.test.ts` | `packages/coding-agent/test/runtime/runtime-credentials.test.ts` | runtime | move | Exercises runtime source via `runtime-credentials.ts`, `auth-storage.ts`. |
| `packages/coding-agent/test/runtime-limits-soak.test.ts` | `packages/coding-agent/test/runtime/runtime-limits-soak.test.ts` | runtime | move | Exercises runtime source via `runtime-limits.ts`. |
| `packages/coding-agent/test/runtime-shutdown.test.ts` | `packages/coding-agent/test/runtime/runtime-shutdown.test.ts` | runtime | move | Exercises runtime source via `shutdown-coordinator.ts`. |
| `packages/coding-agent/test/sandbox-tools.test.ts` | `packages/coding-agent/test/worker/sandbox-tools.test.ts` | worker | move | Exercises worker source via `sandbox-host.ts`, `sandbox.ts`. |
| `packages/coding-agent/test/scheduler-composition.test.ts` | `packages/coding-agent/test/scheduler/scheduler-composition.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-deadlock.ts`, `scheduler-executors.ts`, `scheduler-fan-in.ts`. |
| `packages/coding-agent/test/scheduler-deadlock.test.ts` | `packages/coding-agent/test/scheduler/scheduler-deadlock.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-deadlock.ts`, `scheduler-handoff.ts`, `scheduler-messages.ts`. |
| `packages/coding-agent/test/scheduler-dispatch.test.ts` | `packages/coding-agent/test/scheduler/scheduler-dispatch.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-dispatch.ts`, `scheduler.ts`, `scheduler-executors.ts`. |
| `packages/coding-agent/test/scheduler-executors.test.ts` | `packages/coding-agent/test/scheduler/scheduler-executors.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-executors.ts`, `scheduler.ts`, `scheduler-selection-reservations.ts`. |
| `packages/coding-agent/test/scheduler-fan-in.test.ts` | `packages/coding-agent/test/scheduler/scheduler-fan-in.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-fan-in.ts`, `scheduler.ts`, `scheduler-dispatch.ts`. |
| `packages/coding-agent/test/scheduler-handoff.test.ts` | `packages/coding-agent/test/scheduler/scheduler-handoff.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-handoff.ts`, `scheduler-queue.ts`, `scheduler.ts`. |
| `packages/coding-agent/test/scheduler-messages.test.ts` | `packages/coding-agent/test/scheduler/scheduler-messages.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-messages.ts`, `scheduler.ts`, `task-graph.ts`. |
| `packages/coding-agent/test/scheduler-queue.test.ts` | `packages/coding-agent/test/scheduler/scheduler-queue.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-queue.ts`, `scheduler.ts`. |
| `packages/coding-agent/test/scheduler-selection-reservations.test.ts` | `packages/coding-agent/test/scheduler/scheduler-selection-reservations.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-selection-reservations.ts`, `scheduler.ts`, `scheduler-executors.ts`. |
| `packages/coding-agent/test/scheduler-workflow.test.ts` | `packages/coding-agent/test/scheduler/scheduler-workflow.test.ts` | scheduler | move | Exercises scheduler source via `scheduler-workflow.ts`, `scheduler-executors.ts`, `scheduler-dispatch.ts`. |
| `packages/coding-agent/test/scrollbar-theme.test.ts` | `packages/coding-agent/test/scrollbar-theme.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/sdk-codex-cache-probe-tool-loop.ts` | `packages/coding-agent/test/runtime/sdk-codex-cache-probe-tool-loop.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `loader.ts`, `types.ts`. |
| `packages/coding-agent/test/sdk-openrouter-attribution.test.ts` | `packages/coding-agent/test/runtime/sdk-openrouter-attribution.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `sdk.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/sdk-session-manager.test.ts` | `packages/coding-agent/test/session/sdk-session-manager.test.ts` | session | move | Exercises session source via `session-manager.ts`. |
| `packages/coding-agent/test/sdk-skills.test.ts` | `packages/coding-agent/test/runtime/sdk-skills.test.ts` | runtime | move | Exercises runtime source via `loader.ts`, `resource-loader.ts`, `sdk.ts`. |
| `packages/coding-agent/test/sdk-stream-options.test.ts` | `packages/coding-agent/test/runtime/sdk-stream-options.test.ts` | runtime | move | Exercises runtime source via `auth-storage.ts`, `sdk.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/sdk-worker-composition.test.ts` | `packages/coding-agent/test/worker/sdk-worker-composition.test.ts` | worker | move | Exercises worker behavior; colocate with that source domain. |
| `packages/coding-agent/test/session-cwd.test.ts` | `packages/coding-agent/test/session/session-cwd.test.ts` | session | move | Exercises session source via `session-cwd.ts`, `agent-session-runtime.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/session-entry-migration.test.ts` | `packages/coding-agent/test/session/session-entry-migration.test.ts` | session | move | Exercises session source via `session-entry.ts`. |
| `packages/coding-agent/test/session-file-invalid.test.ts` | `packages/coding-agent/test/session/session-file-invalid.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/session-id-readonly.test.ts` | `packages/coding-agent/test/session/session-id-readonly.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/session-info-modified-timestamp.test.ts` | `packages/coding-agent/test/session/session-info-modified-timestamp.test.ts` | session | move | Exercises session source via `session-manager.ts`. |
| `packages/coding-agent/test/session-selector-path-delete.test.ts` | `packages/coding-agent/test/session/session-selector-path-delete.test.ts` | session | move | Exercises session source via `session-manager.ts`, `session-selector.ts`. |
| `packages/coding-agent/test/session-selector-rename.test.ts` | `packages/coding-agent/test/session/session-selector-rename.test.ts` | session | move | Exercises session source via `session-manager.ts`, `session-selector.ts`. |
| `packages/coding-agent/test/session-selector-search.test.ts` | `packages/coding-agent/test/session/session-selector-search.test.ts` | session | move | Exercises session source via `session-selector-search.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/session-write-authority.test.ts` | `packages/coding-agent/test/session/session-write-authority.test.ts` | session | move | Exercises session source via `agent-session-facade.ts`, `session-manager.ts`, `session-manager-storage.ts`. |
| `packages/coding-agent/test/settings-manager-bug.test.ts` | `packages/coding-agent/test/runtime/settings-manager-bug.test.ts` | runtime | move | Exercises runtime source via `settings-manager.ts`. |
| `packages/coding-agent/test/settings-manager.test.ts` | `packages/coding-agent/test/runtime/settings-manager.test.ts` | runtime | move | Exercises runtime source via `settings-manager.ts`, `capability-settings.ts`, `http-dispatcher.ts`. |
| `packages/coding-agent/test/settings-selector.test.ts` | `packages/coding-agent/test/settings-selector.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/skills.test.ts` | `packages/coding-agent/test/runtime/skills.test.ts` | runtime | move | Exercises runtime source via `skills.ts`, `diagnostics.ts`, `source-info.ts`. |
| `packages/coding-agent/test/startup-session-name.test.ts` | `packages/coding-agent/test/session/startup-session-name.test.ts` | session | move | Exercises session source via `session-manager-storage.ts`. |
| `packages/coding-agent/test/status-indicator.test.ts` | `packages/coding-agent/test/status-indicator.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/stdout-cleanliness.test.ts` | `packages/coding-agent/test/stdout-cleanliness.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/streaming-render-debug.ts` | `packages/coding-agent/test/streaming-render-debug.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/subagent-binding.test.ts` | `packages/coding-agent/test/subagent/subagent-binding.test.ts` | subagent | move | Exercises subagent source via `subagent-binding.ts`. |
| `packages/coding-agent/test/subagent-composition.test.ts` | `packages/coding-agent/test/subagent/subagent-composition.test.ts` | subagent | move | Exercises subagent source via `subagent-composition.ts`, `subagent-binding.ts`, `subagent-registry.ts`. |
| `packages/coding-agent/test/subagent-context-fork.test.ts` | `packages/coding-agent/test/subagent/subagent-context-fork.test.ts` | subagent | move | Exercises subagent source via `subagent-context-fork.ts`. |
| `packages/coding-agent/test/subagent-context-ingress.test.ts` | `packages/coding-agent/test/subagent/subagent-context-ingress.test.ts` | subagent | move | Exercises subagent source via `subagent-context-ingress.ts`, `subagent-mailbox.ts`, `subagent-supervisor.ts`. |
| `packages/coding-agent/test/subagent-contract.test.ts` | `packages/coding-agent/test/subagent/subagent-contract.test.ts` | subagent | move | Exercises subagent source via `subagent.ts`. |
| `packages/coding-agent/test/subagent-facade-context.test.ts` | `packages/coding-agent/test/subagent/subagent-facade-context.test.ts` | subagent | move | Exercises subagent source via `subagent-composition.ts`. |
| `packages/coding-agent/test/subagent-fork-provider.test.ts` | `packages/coding-agent/test/subagent/subagent-fork-provider.test.ts` | subagent | move | Exercises subagent source via `subagent-fork-provider.ts`, `subagent-registry.ts`, `subagent-binding.ts`. |
| `packages/coding-agent/test/subagent-inprocess-provider.test.ts` | `packages/coding-agent/test/subagent/subagent-inprocess-provider.test.ts` | subagent | move | Exercises subagent source via `subagent-inprocess-provider.ts`, `subagent-registry.ts`, `subagent-supervisor.ts`. |
| `packages/coding-agent/test/subagent-mailbox.test.ts` | `packages/coding-agent/test/subagent/subagent-mailbox.test.ts` | subagent | move | Exercises subagent source via `subagent-mailbox.ts`, `subagent-supervisor.ts`. |
| `packages/coding-agent/test/subagent-memory.test.ts` | `packages/coding-agent/test/subagent/subagent-memory.test.ts` | subagent | move | Exercises subagent source via `subagent-memory.ts`. |
| `packages/coding-agent/test/subagent-registry.test.ts` | `packages/coding-agent/test/subagent/subagent-registry.test.ts` | subagent | move | Exercises subagent source via `subagent-registry.ts`. |
| `packages/coding-agent/test/subagent-result.test.ts` | `packages/coding-agent/test/subagent/subagent-result.test.ts` | subagent | move | Exercises subagent source via `subagent-result.ts`. |
| `packages/coding-agent/test/subagent-supervisor.test.ts` | `packages/coding-agent/test/subagent/subagent-supervisor.test.ts` | subagent | move | Exercises subagent source via `subagent-supervisor.ts`, `subagent-registry.ts`. |
| `packages/coding-agent/test/subagent-worktree.test.ts` | `packages/coding-agent/test/subagent/subagent-worktree.test.ts` | subagent | move | Exercises subagent source via `subagent-worktree.ts`. |
| `packages/coding-agent/test/suite/regressions/policy-t7-fake-sandbox.test.ts` | `packages/coding-agent/test/suite/regressions/fake-sandbox.test.ts` | suite | rename | Removes the T7 ticket prefix; this is not an issue-number regression, so only its suite location stays fixed. |
| `packages/coding-agent/test/syntax-highlight.test.ts` | `packages/coding-agent/test/syntax-highlight.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/system-prompt.test.ts` | `packages/coding-agent/test/runtime/system-prompt.test.ts` | runtime | move | Exercises runtime source via `system-prompt.ts`. |
| `packages/coding-agent/test/t2-cancel-deadline-settlement.test.ts` | `packages/coding-agent/test/runtime/cancel-deadline-settlement.test.ts` | runtime | move+rename | Exercises runtime source via `product-prompt-ingress.ts`. |
| `packages/coding-agent/test/t3-binding-authority.test.ts` | `packages/coding-agent/test/runtime/binding-authority.test.ts` | runtime | move+rename | Exercises runtime source via `binding-handles.ts`. |
| `packages/coding-agent/test/task-credential-delivery.test.ts` | `packages/coding-agent/test/worker/task-credential-delivery.test.ts` | worker | move | Exercises worker source via `sandbox.ts`, `task-credential-lease.ts`, `task-credential-provider.ts`. |
| `packages/coding-agent/test/task-credential-lease.test.ts` | `packages/coding-agent/test/worker/task-credential-lease.test.ts` | worker | move | Exercises worker source via `task-credential-lease.ts`. |
| `packages/coding-agent/test/task-credential-policy.test.ts` | `packages/coding-agent/test/worker/task-credential-policy.test.ts` | worker | move | Exercises worker source via `task-credential-lease.ts`, `task-credential-provider.ts`. |
| `packages/coding-agent/test/task-credential-provider.test.ts` | `packages/coding-agent/test/worker/task-credential-provider.test.ts` | worker | move | Exercises worker source via `task-credential-provider.ts`, `task-credential-lease.ts`. |
| `packages/coding-agent/test/task-credential-public-exports.test.ts` | `packages/coding-agent/test/worker/task-credential-public-exports.test.ts` | worker | move | Exercises worker behavior; colocate with that source domain. |
| `packages/coding-agent/test/task-credential-service.test.ts` | `packages/coding-agent/test/worker/task-credential-service.test.ts` | worker | move | Exercises worker source via `task-credential-service.ts`, `task-credential-lease.ts`, `task-credential-provider.ts`. |
| `packages/coding-agent/test/task-credential-store.test.ts` | `packages/coding-agent/test/worker/task-credential-store.test.ts` | worker | move | Exercises worker source via `task-credential-store.ts`, `task-credential-lease.ts`, `task-credential-provider.ts`. |
| `packages/coding-agent/test/task-credential-worker.test.ts` | `packages/coding-agent/test/worker/task-credential-worker.test.ts` | worker | move | Exercises worker source via `task-credential-lease.ts`, `task-credential-provider.ts`, `task-credential-service.ts`. |
| `packages/coding-agent/test/task-gate.test.ts` | `packages/coding-agent/test/policy/task-gate.test.ts` | policy | move | Exercises policy source via `task-gate.ts`, `execution-policy-ledger.ts`, `execution-policy.ts`. |
| `packages/coding-agent/test/task-graph.test.ts` | `packages/coding-agent/test/scheduler/task-graph.test.ts` | scheduler | move | Exercises scheduler source via `task-graph.ts`. |
| `packages/coding-agent/test/test-harness.test.ts` | `packages/coding-agent/test/session/test-harness.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/test-harness.ts` | `packages/coding-agent/test/session/test-harness.ts` | session | move | Exercises session source via `agent-session.ts`, `session-manager.ts`. |
| `packages/coding-agent/test/test-network-env.ts` | `packages/coding-agent/test/test-network-env.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/test-theme-colors.ts` | `packages/coding-agent/test/test-theme-colors.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/theme-detection.test.ts` | `packages/coding-agent/test/theme-detection.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/theme-export.test.ts` | `packages/coding-agent/test/theme-export.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/theme-picker.test.ts` | `packages/coding-agent/test/theme-picker.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/tool-execution-component.test.ts` | `packages/coding-agent/test/tool-execution-component.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/tool-result-images.test.ts` | `packages/coding-agent/test/tool-result-images.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/tool-system-prompt-contributions.test.ts` | `packages/coding-agent/test/tool-system-prompt-contributions.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/tools.test.ts` | `packages/coding-agent/test/tools.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/tree-selector.test.ts` | `packages/coding-agent/test/tree-selector.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/trigger-compact-extension.test.ts` | `packages/coding-agent/test/session/trigger-compact-extension.test.ts` | session | move | Exercises session behavior; colocate with that source domain. |
| `packages/coding-agent/test/truncate-to-width.test.ts` | `packages/coding-agent/test/truncate-to-width.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/trust-manager.test.ts` | `packages/coding-agent/test/policy/trust-manager.test.ts` | policy | move | Exercises policy source via `trust-manager.ts`. |
| `packages/coding-agent/test/trust-selector.test.ts` | `packages/coding-agent/test/trust-selector.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/user-message.test.ts` | `packages/coding-agent/test/user-message.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/utilities.ts` | `packages/coding-agent/test/utilities.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/version-check.test.ts` | `packages/coding-agent/test/version-check.test.ts` | other | stay | Does not primarily exercise a PR-08 source domain; keep at the test root. |
| `packages/coding-agent/test/worker-contract.test.ts` | `packages/coding-agent/test/worker/worker-contract.test.ts` | worker | move | Exercises worker source via `worker.ts`. |
| `packages/coding-agent/test/worker-protocol.test.ts` | `packages/coding-agent/test/worker/worker-protocol.test.ts` | worker | move | Exercises worker source via `worker-protocol.ts`, `worker.ts`. |
| `packages/coding-agent/test/worker-runtime.test.ts` | `packages/coding-agent/test/worker/worker-runtime.test.ts` | worker | move | Exercises worker source via `worker-runtime.ts`, `worker-protocol.ts`, `worker.ts`. |
| `packages/coding-agent/test/worker-sandbox-provider.test.ts` | `packages/coding-agent/test/worker/worker-sandbox-provider.test.ts` | worker | move | Exercises worker source via `worker-sandbox-provider.ts`, `sandbox-host.ts`, `sandbox.ts`. |
| `packages/coding-agent/test/worker-supervisor.test.ts` | `packages/coding-agent/test/worker/worker-supervisor.test.ts` | worker | move | Exercises worker source via `worker-supervisor.ts`, `worker.ts`. |
