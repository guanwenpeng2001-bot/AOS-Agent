import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const LINE13_T0_BASE_SHA = "db279303b9e894b58acea165ab44f74bfdf0cddb";

export const LINE13_T0_BASELINE = Object.freeze({
	baseSha: LINE13_T0_BASE_SHA,
	localMainSha: LINE13_T0_BASE_SHA,
	originMainTrackingSha: LINE13_T0_BASE_SHA,
	originMainRemoteSha: LINE13_T0_BASE_SHA,
	originUrl: "https://github.com/guanwenpeng2001-bot/AOS-Agent.git",
	cleanStart: true,
	cleanStartPorcelain: "",
	capturedOnBranch: "guanwenpeng2001-bot/T0_BASELINE_INVENTORY",
});

export type Line13InventoryCategory =
	| "baseline"
	| "dependency"
	| "public_export"
	| "run_terminal_writer"
	| "session_writer"
	| "binding_consumer"
	| "event_audit_source"
	| "product_construction"
	| "scheduler_recovery_resource"
	| "provider_taxonomy"
	| "operability";

export interface Line13InventoryEntry {
	readonly id: string;
	readonly category: Line13InventoryCategory;
	readonly currentCodeLocation: string;
	readonly acOwner: string;
	readonly migrationOrRemovalStage: string;
	readonly evidence: string;
	readonly publicBarrelPath?: string;
}

interface FactSpec {
	readonly id: string;
	readonly category: Exclude<Line13InventoryCategory, "baseline" | "dependency" | "public_export">;
	readonly path: string;
	readonly needle: string;
	readonly acOwner: string;
	readonly stage: string;
	readonly detail: string;
}

export interface DependencyBaselineEntry {
	readonly path: string;
	readonly sha256: string;
}

export const LINE13_T0_DEPENDENCY_BASELINE: readonly DependencyBaselineEntry[] = Object.freeze([
	{ path: "package-lock.json", sha256: "69142bfdbb026500b91c7f8fd4328bf0f8301c9502c29f2e825548c0c5851f8a" },
	{ path: "package.json", sha256: "68be6481760ef969c96a451baee6152881df22202615b30a09edeb0fe50dfd97" },
	{ path: "packages/agent/package.json", sha256: "f9583a03503bb27925c02ffa14a1a5a1c747776d1a7c2b086b24f438fec89c02" },
	{ path: "packages/ai/package.json", sha256: "b537f3aac9434433581c1018a6f3b5f18c8dfd021d3e5a5ebe76e6a14b65db39" },
	{ path: "packages/client/package.json", sha256: "8a8c519edbd301e566c5b0ab7087892154b56d19270e1f1e7a5f96bb3ef246d7" },
	{ path: "packages/coding-agent/examples/extensions/custom-provider-anthropic/package-lock.json", sha256: "31d58894fe0811bfe608505b1baedca96602222290cf2277da7b09b930af1131" },
	{ path: "packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json", sha256: "ef1882c948380719fd7ce80af6cae8dae494cd69eafe29300719e8c7f79648be" },
	{ path: "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json", sha256: "f18f1455b369cffd5adcc435624d72745d97730c6b58f1e8458c937554612c92" },
	{ path: "packages/coding-agent/examples/extensions/gondolin/package-lock.json", sha256: "eeccffd3c9f506dba35726c310d2e083830283f1329c6a2cb27ea5f1cf8d8e89" },
	{ path: "packages/coding-agent/examples/extensions/gondolin/package.json", sha256: "e270d915462e9c237b0ab3fb7b5d308eb363d7c6e138b86d38aaeff4a0829f79" },
	{ path: "packages/coding-agent/examples/extensions/sandbox/package-lock.json", sha256: "f6aab684b91a03340c2570f072635ffd5506ffa8ab7d36a8ad97c6b8247ee360" },
	{ path: "packages/coding-agent/examples/extensions/sandbox/package.json", sha256: "2eee1e63dd66820fd91bad73ca8ccd9fe87f1ed13d44c6539dedbd682b40b4b0" },
	{ path: "packages/coding-agent/examples/extensions/with-deps/package-lock.json", sha256: "cd8e951e02419434eaad17d8c23b01b3aa5ecec0970eac3f38b3b067b125ac39" },
	{ path: "packages/coding-agent/examples/extensions/with-deps/package.json", sha256: "4c1d011cc25c96dd651896615ee8654f40dcc901c72ec5e464a460136063eb04" },
	{ path: "packages/coding-agent/install-lock/package-lock.json", sha256: "c3d4822654606bfb3a2818d74fc847998b3679e0bc0092152c5812c6642d46a7" },
	{ path: "packages/coding-agent/install-lock/package.json", sha256: "bcb53f29f23cb8d775f5116abc808de7e20a7ad170cb37132443f0b5ee5faa67" },
	{ path: "packages/coding-agent/npm-shrinkwrap.json", sha256: "4d4707e6c14a24d3befad6f1725bb7eeeeb13b3a22a50af48b138e5dde369fd9" },
	{ path: "packages/coding-agent/package.json", sha256: "d7cb3ec0a28041ce58f488b97749b5bc7476ae31663f36d0b2ade0f8d07a5c3d" },
	{ path: "packages/evals/package.json", sha256: "a873569d3309d851ea7daa5dcc0967d7517a8547a72202823e505c2090f13991" },
	{ path: "packages/protocol/package.json", sha256: "1e39d482cf6350c82126c1e93ef2827465dfadad4be1d1e48ecb523994c4849c" },
	{ path: "packages/server/package.json", sha256: "4152c2eb7edcd3ab741a3e007c87c121c02ac329a058d1f4c3bc4ad90729e137" },
	{ path: "packages/session-backends/sqlite-node/package.json", sha256: "95d3b3aa8511aa900bf64e842e530ca15ddcd52e227efe9b6e44f5be94c32738" },
	{ path: "packages/telemetry/package.json", sha256: "bc331d0b16a5497825e47d0cd0874f419a537651f4c0d17a93d1853e5e568da5" },
	{ path: "packages/tui/package.json", sha256: "b3090d77b2ae37d3b52ce8a8838440ae649fdb900a04689d86611249be50ba4f" },
].sort((left, right) => left.path.localeCompare(right.path)));

const fact = (
	category: FactSpec["category"],
	id: string,
	path: string,
	needle: string,
	acOwner: string,
	stage: string,
	detail: string,
): FactSpec => ({ category, id, path, needle, acOwner, stage, detail });

// These are authority and product-surface facts, rather than declarations in a
// new contract. Exact source markers make every fact machine-checkable while
// the final digest below freezes its location and metadata deterministically.
const FACT_SPECS: readonly FactSpec[] = [
	fact("run_terminal_writer", "run-receipt-constructor", "packages/agent/src/harness/foundation/results.ts", "export function finalizeRunReceipt(", "AC-01", "T2 remove competing terminal authors", "Foundation RunReceipt constructor"),
	fact("run_terminal_writer", "foundation-task-settle", "packages/agent/src/harness/foundation/settlement.ts", "async settle(input: LayeredTaskSettlementInput)", "AC-01", "T2 retain behind canonical terminal gate", "Layered task-result settlement writer"),
	fact("run_terminal_writer", "foundation-run-finalize", "packages/agent/src/harness/foundation/settlement.ts", "async finalize(input: LayeredRunFinalizationInput)", "AC-01", "T2 canonical owner", "Foundation run finalization writer"),
	fact("run_terminal_writer", "automation-terminal-append", "packages/coding-agent/src/core/run-lifecycle.ts", "this.coordinator.persist({ schemaVersion: 1, kind: \"terminal\", receipt, endedAt });", "AC-01", "T2 remove after canonical projection migration", "Competing Automation terminal-ledger append"),
	fact("run_terminal_writer", "automation-ledger-physical-write", "packages/coding-agent/src/core/run-lifecycle.ts", "this.session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, entry);", "AC-01", "T2 migrate decoder to private read-only compatibility", "Automation ledger physical Session writer"),
	fact("run_terminal_writer", "rpc-completion-writer", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "const finalizeRun = async (", "AC-01", "T2 replace writer with canonical receipt projection", "RPC completion writer"),

	fact("session_writer", "canonical-session-message", "packages/agent/src/harness/session/session.ts", "async appendMessage(message: AgentMessage)", "AC-13", "T3a canonical owner", "Canonical Session message writer"),
	fact("session_writer", "canonical-session-custom", "packages/agent/src/harness/session/session.ts", "async appendCustomEntry(customType: string, data?: unknown)", "AC-13", "T3a canonical owner", "Canonical Session custom-entry writer"),
	fact("session_writer", "canonical-session-foundation", "packages/agent/src/harness/session/session.ts", "async appendFoundationRecord(record: ProvisionedFoundationRecordV1)", "AC-13", "T3a canonical owner", "Canonical Foundation record writer"),
	fact("session_writer", "harness-custom", "packages/agent/src/harness/agent-harness.ts", "async appendCustomEntry(customType: string, data?: unknown)", "AC-13", "T3a canonical product entry", "Harness custom-entry writer"),
	fact("session_writer", "legacy-manager-physical", "packages/coding-agent/src/core/session-manager.ts", "private _appendEntry(entry: SessionEntry)", "AC-13", "T3a make internal physical store", "Legacy physical append authority"),
	fact("session_writer", "legacy-manager-message", "packages/coding-agent/src/core/session-manager.ts", "appendMessage(message: Message | CustomMessage | BashExecutionMessage)", "AC-13", "T3a remove public writer surface", "Public legacy message writer"),
	fact("session_writer", "legacy-manager-custom", "packages/coding-agent/src/core/session-manager.ts", "appendCustomEntry(customType: string, data?: unknown)", "AC-13", "T3a remove public writer surface", "Public legacy custom-entry writer"),
	fact("session_writer", "compatibility-storage-entry", "packages/coding-agent/src/core/session-manager-storage.ts", "appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string)", "AC-13", "T3a read projection only after migration", "Compatibility storage writer"),
	fact("session_writer", "compatibility-storage-custom", "packages/coding-agent/src/core/session-manager-storage.ts", "appendCustomEntrySync(customType: string, data?: unknown)", "AC-13", "T3a remove compatibility write-back", "Compatibility custom-entry writer"),
	fact("session_writer", "extension-write-path", "packages/coding-agent/src/core/extensions/loader.ts", "appendEntry(customType: string, data?: unknown): void", "AC-13", "T3a route exclusively through Harness", "Extension runtime write path"),
	fact("session_writer", "sdk-model-write", "packages/coding-agent/src/core/sdk.ts", "sessionManager.appendModelChange(model.provider, model.id);", "AC-13", "T3a route through canonical Session", "SDK model selection write path"),
	fact("session_writer", "main-name-write", "packages/coding-agent/src/main.ts", "sessionManager.appendSessionInfo(name);", "AC-13", "T3a route through canonical Session", "Main session-name write path"),
	fact("session_writer", "tui-label-write", "packages/coding-agent/src/modes/interactive/interactive-mode.ts", "this.sessionManager.appendLabelChange(entryId, label);", "AC-13", "T3a route through canonical Session", "TUI label write path"),
	fact("session_writer", "fork-copy-writer", "packages/coding-agent/src/core/agent-session-facade.ts", "await targetStorage.appendEntry(provisioned as ProvisionedEntry, \"main\");", "AC-13", "T3a copy canonical entries without wrapper identities", "Fork materialization writer"),

	fact("binding_consumer", "agent-binding-authority", "packages/agent/src/harness/foundation/role.ts", "export interface AgentBindingV1", "AC-13", "T3a canonical owner", "AgentBinding business authority"),
	fact("binding_consumer", "binding-epoch-consumer", "packages/agent/src/harness/foundation/settlement.ts", "validateBindingEpochV1(input.initialBindingEpoch)", "AC-13", "T3a canonical execution input", "Settlement consumes BindingEpoch"),
	fact("binding_consumer", "run-association-store", "packages/coding-agent/src/core/execution-association.ts", "export function persistExecutionAssociation", "AC-13", "T3a convert to deterministic public view", "Legacy Run execution association writer"),
	fact("binding_consumer", "binding-handle", "packages/coding-agent/src/core/binding-handles.ts", "export function createBindingHandle", "AC-13", "T3a view-only handle", "Binding handle constructor"),
	fact("binding_consumer", "capability-handle-consumer", "packages/coding-agent/src/core/capability-registry.ts", "createBindingHandle({", "AC-13", "T3a project from AgentBinding", "Capability binding handle consumer"),
	fact("binding_consumer", "policy-handle-consumer", "packages/coding-agent/src/core/execution-policy.ts", "createBindingHandle({", "AC-13", "T3a project from AgentBinding", "Policy binding handle consumer"),
	fact("binding_consumer", "model-handle-consumer", "packages/coding-agent/src/core/model-broker.ts", "createBindingHandle({", "AC-13", "T3a project from AgentBinding", "Model binding handle consumer"),
	fact("binding_consumer", "sandbox-handle-consumer", "packages/coding-agent/src/core/sandbox.ts", "createBindingHandle({", "AC-13", "T3a project from AgentBinding", "Sandbox binding handle consumer"),
	fact("binding_consumer", "active-handle-aggregation", "packages/coding-agent/src/core/foundation-control-plane.ts", "getActiveBindingHandles(): ReadonlyArray<BindingHandle>", "AC-13", "T3a derive deterministic view", "Control-plane BindingHandle aggregation"),
	fact("binding_consumer", "synthetic-source-revision", "packages/coding-agent/src/core/source-info.ts", "export function createSyntheticSourceInfo", "AC-13", "T3a remove synthetic revision facts from product ingress", "Synthetic source/revision wrapper"),
	fact("binding_consumer", "prompt-ingress-binding", "packages/coding-agent/src/core/product-prompt-ingress.ts", "_binding: AgentBindingV1", "AC-13", "T3a consume durable AgentBinding directly", "Product prompt ingress binding input"),

	fact("event_audit_source", "harness-live-event-bus", "packages/agent/src/harness/events.ts", "export class HarnessEventBus", "AC-01", "T2 retain as live projection only", "Harness live event source"),
	fact("event_audit_source", "foundation-event-catalog", "packages/agent/src/harness/foundation/event-catalog.ts", "export type DurableEventCategoryV1", "AC-01", "T2 canonical durable event catalog", "Foundation durable event source catalog"),
	fact("event_audit_source", "foundation-run-receipt-event", "packages/agent/src/harness/foundation/event-catalog.ts", "\"run_receipt.written\"", "AC-01", "T2 canonical terminal event", "Canonical run-receipt event category"),
	fact("event_audit_source", "product-event-bus", "packages/coding-agent/src/core/event-bus.ts", "export function createEventBus", "AC-01", "T2 projection only", "Product-local event bus source"),
	fact("event_audit_source", "execution-audit-fold", "packages/coding-agent/src/core/execution-audit.ts", "export class ExecutionAuditAdapter", "AC-01", "T2 derive from canonical records", "Execution Audit fold source"),
	fact("event_audit_source", "execution-audit-query", "packages/coding-agent/src/core/execution-audit-query.ts", "export class ExecutionAuditQuery", "AC-01", "T2 query canonical projection", "Cross-session audit query source"),
	fact("event_audit_source", "automation-run-stream", "packages/coding-agent/src/core/run-lifecycle.ts", "export type RunStreamEvent", "AC-01", "T2 derive from canonical correlation sequence", "Automation public run event source"),
	fact("event_audit_source", "rpc-event-projection", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "const outputRunEvent = (event: RunStreamEvent)", "AC-01", "T2 wait for canonical receipt", "RPC run-event projection source"),

	fact("product_construction", "direct-sdk-factory", "packages/coding-agent/src/core/sdk.ts", "export async function createAgentSession(options", "AC-04,AC-13", "T3b unify product composition", "Direct SDK construction root"),
	fact("product_construction", "services-factory", "packages/coding-agent/src/core/agent-session-services.ts", "export async function createAgentSessionServices(", "AC-04,AC-13", "T3b unify services composition", "Service construction root"),
	fact("product_construction", "services-session-factory", "packages/coding-agent/src/core/agent-session-services.ts", "export async function createAgentSessionFromServices(", "AC-04,AC-13", "T3b unify product composition", "Services-to-Session construction root"),
	fact("product_construction", "runtime-factory", "packages/coding-agent/src/core/agent-session-runtime.ts", "export async function createAgentSessionRuntime(", "AC-04,AC-13", "T3b transactional rebind", "Session runtime factory"),
	fact("product_construction", "main-services", "packages/coding-agent/src/main.ts", "const services = await createAgentSessionServices({", "AC-04", "T3b propagate complete composition", "CLI main service construction"),
	fact("product_construction", "main-session", "packages/coding-agent/src/main.ts", "const created = await createAgentSessionFromServices({", "AC-04", "T3b propagate complete composition", "CLI main Session construction"),
	fact("product_construction", "main-runtime", "packages/coding-agent/src/main.ts", "const runtime = await createAgentSessionRuntime(createRuntime, {", "AC-04", "T3b propagate complete composition", "CLI main runtime construction"),
	fact("product_construction", "interactive-mode", "packages/coding-agent/src/main.ts", "new InteractiveMode(runtime,", "AC-04", "T3b shared product composition", "TUI construction surface"),
	fact("product_construction", "print-mode", "packages/coding-agent/src/main.ts", "const exitCode = await runPrintMode(runtime,", "AC-04", "T3b shared product composition", "Print mode construction surface"),
	fact("product_construction", "rpc-mode", "packages/coding-agent/src/main.ts", "await runRpcMode(runtime,", "AC-04", "T3b shared product composition", "RPC mode construction surface"),
	fact("product_construction", "session-new", "packages/coding-agent/src/core/agent-session-runtime.ts", "async newSession(options?", "AC-17", "T3b transactional replacement", "New Session construction surface"),
	fact("product_construction", "session-switch", "packages/coding-agent/src/core/agent-session-runtime.ts", "async switchSession(", "AC-17", "T3b transactional replacement", "Session switch construction surface"),
	fact("product_construction", "session-fork", "packages/coding-agent/src/core/agent-session-runtime.ts", "async fork(", "AC-17", "T3b transactional replacement", "Session fork construction surface"),
	fact("product_construction", "session-import", "packages/coding-agent/src/core/agent-session-runtime.ts", "async importFromJsonl(", "AC-17", "T3b transactional replacement", "Session import construction surface"),
	fact("product_construction", "session-reload", "packages/coding-agent/src/core/agent-session-facade.ts", "async reload(options?", "AC-17", "T3b transactional rebind", "Session reload construction surface"),
	fact("product_construction", "worker-factory", "packages/coding-agent/src/core/agent-session-facade.ts", "createAgentSessionWithTrustedWorkerSandboxProvider(", "AC-04", "T3b propagate Worker composition", "Worker construction factory"),
	fact("product_construction", "subagent-factory", "packages/coding-agent/src/core/agent-session-facade.ts", "createAgentSessionWithTrustedSubagents(", "AC-04", "T3b propagate Subagent composition", "Subagent construction factory"),
	fact("product_construction", "scheduler-factory", "packages/coding-agent/src/core/agent-session-facade.ts", "createAgentSessionWithTrustedScheduler(", "AC-04", "T3b propagate Scheduler composition", "Scheduler construction factory"),
	fact("product_construction", "external-registry-factory", "packages/coding-agent/src/core/external-agent-registry.ts", "export function createExternalAgentAdapterRegistry", "AC-04", "T4 propagate External composition", "External Connector registry factory"),
	fact("product_construction", "external-foundation-bypass", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "const remoteHandle = startRemoteOperation(", "AC-03", "T4 route External execution through Foundation Task/Attempt/Receipt settlement", "Current RPC External path enters Remote Operation instead of Foundation dispatch"),
	fact("product_construction", "external-images-drop", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "input: { message },", "AC-05", "T4 translate image Artifact references or reject before acceptance", "External start forwards message but omits accepted images"),
	fact("product_construction", "server-construction", "packages/coding-agent/src/server/create-harness.ts", "createAgentSessionWithTrustedScheduler(options, createScheduler)", "AC-04", "T3b propagate complete server composition", "Server harness construction surface"),
	fact("product_construction", "package-root-export", "packages/coding-agent/src/index.ts", "createAgentSession,", "AC-04", "T3b public factory propagation", "Package-root SDK factory export"),

	fact("scheduler_recovery_resource", "queue-cancel-hook", "packages/coding-agent/src/core/scheduler-queue.ts", "readonly cancelAttempt?: SchedulerCancelAttemptV1", "AC-08", "T9b complete recovery hook", "Queue recovery cancellation hook"),
	fact("scheduler_recovery_resource", "queue-recover-expired", "packages/coding-agent/src/core/scheduler-queue.ts", "async recoverExpired()", "AC-08", "T9b production reopen recovery", "Expired queue recovery entry"),
	fact("scheduler_recovery_resource", "selection-fact-shape", "packages/coding-agent/src/core/scheduler.ts", "export interface SchedulerSelectionFactV1", "AC-09", "T9b persist durable fact", "Scheduler selection fact contract"),
	fact("scheduler_recovery_resource", "selection-fact-memory", "packages/coding-agent/src/core/scheduler-executors.ts", "private readonly factsByQueueEntryId", "AC-09", "T9b replace memory-only state with durable persistence", "Current in-memory selection fact store"),
	fact("scheduler_recovery_resource", "selection-fact-write", "packages/coding-agent/src/core/scheduler-executors.ts", "persistSelectionFact(fact: SchedulerSelectionFactV1)", "AC-09", "T9b persist before execution", "Selection fact writer"),
	fact("scheduler_recovery_resource", "agent-instance-assembly", "packages/coding-agent/src/core/scheduler-dispatch.ts", "Scheduler dispatch does not assemble an AgentInstance for an agent provider", "AC-10", "T9b implement Native AgentInstance assembly", "Current fixed rejection in agent assembly"),
	fact("scheduler_recovery_resource", "capacity-filter", "packages/coding-agent/src/core/scheduler-executors.ts", "return candidate.load < candidate.maxConcurrency;", "AC-11", "T9b replace passive load with atomic acquire/release", "Current non-atomic capacity check"),
	fact("scheduler_recovery_resource", "quota-reserve", "packages/coding-agent/src/core/scheduler-executors.ts", "const reserved = await this.quota.reserve(", "AC-12", "T9b retain bounded reservation", "Scheduler Host quota reserve"),
	fact("scheduler_recovery_resource", "quota-settle", "packages/coding-agent/src/core/scheduler-executors.ts", "const settled = await this.quota.settle(", "AC-12", "T9b settle in finally on runner failure", "Scheduler Host quota settle"),
	fact("scheduler_recovery_resource", "host-recovery-poll", "packages/coding-agent/src/core/scheduler.ts", "const recovered = await this.queue.recoverExpired();", "AC-08", "T9b bind production reopen", "Scheduler Host recovery poll"),

	fact("provider_taxonomy", "execution-provider-classes", "packages/agent/src/harness/foundation/providers.ts", "export type FoundationProviderClassV1", "AC-10", "T9b canonical taxonomy owner", "Foundation execution provider classes"),
	fact("provider_taxonomy", "native-agent-instance", "packages/agent/src/harness/foundation/role.ts", "export interface AgentInstanceV1", "AC-10", "T9b Native Agent provider identity", "Native AgentInstance identity"),
	fact("provider_taxonomy", "native-agent-attempt", "packages/agent/src/harness/foundation/task.ts", "export type AttemptProviderClassV1", "AC-10", "T9b canonical attempt taxonomy", "Attempt provider taxonomy"),
	fact("provider_taxonomy", "external-connector", "packages/coding-agent/src/core/external-agent-adapter.ts", "export interface ExternalAgentAdapter", "AC-02,AC-10", "T4 External Connector identity", "External Connector adapter identity"),
	fact("provider_taxonomy", "operation-worker", "packages/agent/src/harness/foundation/results.ts", "export interface WorkerReceiptV1", "AC-10", "T9b Operation Worker identity", "Operation Worker receipt identity"),
	fact("provider_taxonomy", "scheduler-provider-classes", "packages/coding-agent/src/core/scheduler.ts", "export const SCHEDULER_PROVIDER_CLASSES", "AC-10", "T9b align scheduler taxonomy", "Scheduler provider taxonomy"),
	fact("provider_taxonomy", "quota-owner-kinds", "packages/agent/src/harness/foundation/providers.ts", "ownerKind: \"host\" | \"operation_worker\" | \"agent_executor\" | \"external_connector\"", "AC-10", "T9b align resource taxonomy", "Quota attribution taxonomy"),
	fact("provider_taxonomy", "subagent-provider-kinds", "packages/coding-agent/src/core/subagent-registry.ts", "export type SubagentProviderKindV1 =", "AC-10", "T9b remove external protocol placeholders from Native taxonomy", "Subagent provider-kind taxonomy"),
	fact("provider_taxonomy", "subagent-event-provider-kinds", "packages/agent/src/harness/foundation/event-catalog.ts", "providerKind: \"in_process\" | \"fork\" | \"agent_runtime_host\" | \"acp\" | \"sdk\"", "AC-10", "T9b align protocol-visible provider kinds", "Event catalog provider-kind taxonomy"),
	fact("provider_taxonomy", "external-protocol-name", "packages/coding-agent/src/core/external-agent-adapter.ts", "export interface ExternalAgentProtocol", "AC-02", "T4 protocol identity separate from provider kind", "External protocol identity"),
	fact("provider_taxonomy", "external-local-model-gate", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "const modelSelection = await resolveRequestedModel(", "AC-06", "T4 make model resolution execution-class-aware", "External-only RPC path currently performs local model selection"),

	fact("operability", "trusted-external-selection", "packages/coding-agent/src/core/external-agent-registry.ts", "resolve(selection: ExternalAgentSelection)", "AC-15", "T9a trusted selection owner", "Trusted External selection"),
	fact("operability", "external-probe-boundary", "packages/coding-agent/src/core/external-agent-adapter.ts", "probe(target: ExternalAgentTarget, context: ExternalAgentProbeContext)", "AC-15", "T4/T9a bounded active readiness", "External readiness probe"),
	fact("operability", "external-registry-control", "packages/coding-agent/src/core/foundation-control-plane.ts", "getExternalAgentRegistry(): ExternalAgentAdapterRegistry | undefined", "AC-15,AC-16", "T9a control-plane activation", "Control-plane External registry surface"),
	fact("operability", "external-resume-fixed-reject", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "external_agent_resume_unsupported", "AC-07", "T4 capability-behavior conformance", "RPC External resume currently has a fixed unsupported path"),
	fact("operability", "external-gateway-fixed-reject", "packages/coding-agent/src/modes/rpc/rpc-host.ts", "if (prepared.bindingMode === \"tool-gateway\")", "AC-07,AC-21", "T4/T5 capability-behavior conformance", "RPC currently rejects a prepared Tool Gateway binding"),
	fact("operability", "settings-writer", "packages/coding-agent/src/core/settings-manager.ts", "writeFileSync", "AC-16", "T3b shared crash-safe control store", "Settings control-state writer"),
	fact("operability", "auth-writer", "packages/coding-agent/src/core/auth-storage.ts", "writeFileSync", "AC-16", "T3b shared crash-safe control store", "Auth control-state writer"),
	fact("operability", "trust-writer", "packages/coding-agent/src/core/trust-manager.ts", "writeFileSync", "AC-16", "T3b shared crash-safe control store", "Trust control-state writer"),
	fact("operability", "identity-writer", "packages/coding-agent/src/core/capability-public-identity.ts", "writeFileSync", "AC-16", "T3b shared crash-safe control store", "Capability identity control-state writer"),
	fact("operability", "session-teardown", "packages/coding-agent/src/core/agent-session-runtime.ts", "private async teardownCurrent(", "AC-17,AC-18", "T3b/T9c transactional transition and bounded cleanup", "Session transition teardown"),
	fact("operability", "session-replacement", "packages/coding-agent/src/core/agent-session-runtime.ts", "private apply(result: CreateAgentSessionRuntimeResult)", "AC-17", "T3b commit replacement after successful construction", "Session replacement commit point"),
	fact("operability", "sigint-handler", "packages/coding-agent/src/modes/interactive/interactive-mode.ts", "process.on(\"SIGINT\", ignoreSigint);", "AC-18", "T9c route SIGINT through bounded cleanup", "Current SIGINT handling surface"),
	fact("operability", "sigterm-handler", "packages/coding-agent/src/modes/rpc/rpc-mode.ts", "const signals: NodeJS.Signals[] = [\"SIGTERM\"];", "AC-18", "T9c bounded cleanup", "RPC SIGTERM handling surface"),
	fact("operability", "runtime-shutdown-event", "packages/coding-agent/src/core/agent-session-runtime.ts", "type: \"session_shutdown\"", "AC-18", "T9c bounded provider/Driver shutdown", "Runtime shutdown event"),
	fact("operability", "worker-process-protocol", "packages/coding-agent/src/core/worker-protocol.ts", "export const WORKER_PROTOCOL_SCHEMA_VERSION", "AC-19,AC-20", "T9c bounded private process protocol", "Operation Worker process protocol"),
	fact("operability", "worker-supervisor-capacity", "packages/coding-agent/src/core/worker-supervisor.ts", "readonly maxPendingWriteBytes?: number", "AC-19,AC-24", "T9c atomic capacity and containment", "Worker supervisor pending-write capacity"),
	fact("operability", "worker-registry-capacity", "packages/coding-agent/src/core/worker-sandbox-provider.ts", "Operation Worker registry capacity is exhausted", "AC-19,AC-24", "T9c atomic capacity and containment", "Operation Worker registry capacity boundary"),
	fact("operability", "worker-trusted-process-source", "packages/coding-agent/src/core/worker-supervisor.ts", "Absolute trusted executable selected by Host composition", "AC-23", "T9c retain as Connector Driver provenance precedent", "Worker trusted executable, entrypoint, cwd, and minimal environment boundary"),
	fact("operability", "external-target-missing-provenance", "packages/coding-agent/src/core/external-agent-adapter.ts", "export interface ExternalAgentTarget", "AC-23", "T9c add trusted Driver source/version/file identity outside public safe projection", "Current External target exposes only an opaque target id"),
	fact("operability", "rpc-transport-capacity", "packages/coding-agent/src/modes/rpc/rpc-transport.ts", "const pending = this.writer.write(output);", "AC-20,AC-24", "T9c add bounded pending-write accounting", "Current RPC transport write queue"),
	fact("operability", "output-guard", "packages/coding-agent/src/core/output-guard.ts", "let rawStdoutWriteTail: Promise<void>", "AC-20,AC-24", "T9c bound process output backlog", "Current process output promise chain"),
	fact("operability", "gateway-catalog-validation", "packages/agent/src/harness/tool-gateway.ts", "constructor(options: FoundationToolGatewayOptionsV1)", "AC-21", "T5/T9c validate catalog before ready", "Tool Gateway startup validation surface"),
	fact("operability", "gateway-inflight", "packages/agent/src/harness/tool-gateway.ts", "this.inFlight.delete(value.toolCallId);", "AC-21,AC-24", "T5/T9c retain release on callback throw", "Tool Gateway in-flight release"),
	fact("operability", "scheduler-runtime-limit", "packages/coding-agent/src/core/scheduler.ts", "SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS", "AC-24", "T9c/T10 RuntimeLimits owner", "Scheduler active-attempt limit"),
	fact("operability", "audit-query-limit", "packages/coding-agent/src/core/execution-audit-query.ts", "AUDIT_MAX_SESSION_CANDIDATES", "AC-24", "T9c/T10 bounded audit scan", "Audit resource limit"),
	fact("operability", "npm-assets", "packages/coding-agent/package.json", "\"copy-assets\"", "AC-22", "T10 package asset manifest", "npm package asset copy surface"),
	fact("operability", "bun-assets", "packages/coding-agent/package.json", "\"copy-binary-assets\"", "AC-22", "T10 binary asset manifest", "Bun binary asset copy surface"),
	fact("operability", "platform-paths", "packages/coding-agent/src/config.ts", "process.platform === \"win32\"", "AC-22", "T10 Windows/macOS/Linux matrix", "Platform-specific package path behavior"),
];

export const LINE13_T0_PUBLIC_ROOTS = Object.freeze([
	{ packageName: "@aos-agent/agent-core", specifier: ".", source: "packages/agent/src/index.ts" },
	{ packageName: "@aos-agent/agent-core", specifier: "./node", source: "packages/agent/src/node.ts" },
	{ packageName: "@aos-agent/agent-core", specifier: "./session/testing", source: "packages/agent/src/harness/session/testing/index.ts" },
	{ packageName: "aos-agent", specifier: ".", source: "packages/coding-agent/src/index.ts" },
	{ packageName: "aos-agent", specifier: "./client", source: "packages/coding-agent/src/client/index.ts" },
	{ packageName: "aos-agent", specifier: "./rpc-entry", source: "packages/coding-agent/src/rpc-entry.ts" },
]);

export const LINE13_T0_EXPECTED = Object.freeze({
	factCount: 111,
	publicExportCount: 1965,
	inventoryDigest: "431725463bd9d8f1d578f31b2054f9f4343c0672c243b6074018cb1b17ec6832",
	dependencyDigest: "ead81d7793fff1fa2ce8cdd9b44d8e1d7610e29ec9ef7a17107f70c4290abee2",
});

export function line13RepoRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizedPath(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function lineForOffset(source: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (source.charCodeAt(index) === 10) line += 1;
	}
	return line;
}

function materializeFacts(root: string): Line13InventoryEntry[] {
	return FACT_SPECS.map((spec) => {
		const source = readFileSync(resolve(root, spec.path), "utf8");
		const offset = source.indexOf(spec.needle);
		if (offset < 0) throw new Error(`Missing Line 13 inventory marker ${spec.id}: ${spec.path} :: ${spec.needle}`);
		return {
			id: spec.id,
			category: spec.category,
			currentCodeLocation: `${spec.path}:${lineForOffset(source, offset)}`,
			acOwner: spec.acOwner,
			migrationOrRemovalStage: spec.stage,
			evidence: `${spec.detail}; exact marker ${JSON.stringify(spec.needle)}; source sha256 ${sha256(source)}`,
		};
	});
}

function declarationVersionTarget(declaration: ts.Declaration): string | undefined {
	if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeReferenceNode(declaration.type)) {
		return declaration.type.typeName.getText(declaration.getSourceFile());
	}
	if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && ts.isIdentifier(declaration.initializer)) {
		return declaration.initializer.text;
	}
	return undefined;
}

function versionedTarget(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
	if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		const aliased = checker.getAliasedSymbol(symbol);
		if (/V\d+$/.test(aliased.name)) return aliased.name;
	}
	for (const declaration of symbol.declarations ?? []) {
		const target = declarationVersionTarget(declaration);
		if (target !== undefined && /V\d+$/.test(target)) return target;
	}
	return undefined;
}

function declarationLocation(root: string, symbol: ts.Symbol): { readonly path: string; readonly line: number } {
	const declaration = symbol.declarations?.find((candidate) => normalizedPath(root, candidate.getSourceFile().fileName).startsWith("packages/"));
	if (declaration === undefined) return { path: "<external>", line: 0 };
	const sourceFile = declaration.getSourceFile();
	return {
		path: normalizedPath(root, sourceFile.fileName),
		line: sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1,
	};
}

function materializePublicExports(root: string): Line13InventoryEntry[] {
	const rootNames = LINE13_T0_PUBLIC_ROOTS.map((entry) => resolve(root, entry.source));
	const program = ts.createProgram(rootNames, {
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
	});
	const checker = program.getTypeChecker();
	const entries: Line13InventoryEntry[] = [];
	for (const publicRoot of LINE13_T0_PUBLIC_ROOTS) {
		const sourceFile = program.getSourceFile(resolve(root, publicRoot.source));
		if (sourceFile === undefined) throw new Error(`Missing public entrypoint ${publicRoot.source}`);
		const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
		if (moduleSymbol === undefined) throw new Error(`Missing module symbol for ${publicRoot.source}`);
		for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
			const exportName = symbol.name;
			const target = versionedTarget(checker, symbol);
			const kind = /V\d+$/.test(exportName) ? "versioned" : target === undefined ? undefined : "alias";
			if (kind === undefined) continue;
			const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
			const declaration = declarationLocation(root, resolved);
			const publicBarrelPath = `${publicRoot.packageName}${publicRoot.specifier === "." ? "" : publicRoot.specifier.slice(1)}`;
			entries.push({
				id: `public-export:${publicRoot.packageName}:${publicRoot.specifier}:${exportName}`,
				category: "public_export",
				currentCodeLocation: `${publicRoot.source}#${exportName} -> ${declaration.path}:${declaration.line}`,
				acOwner: "AC-14",
				migrationOrRemovalStage: "T1a remove business version suffixes and transitional aliases",
				evidence: kind === "versioned"
					? `Public business export ${exportName} has a version suffix; declaration ${declaration.path}:${declaration.line}`
					: `Public unversioned alias ${exportName} resolves to ${target}; declaration ${declaration.path}:${declaration.line}`,
				publicBarrelPath,
			});
		}
	}
	return entries;
}

export function dependencyBaselineDigest(): string {
	return sha256(JSON.stringify(LINE13_T0_DEPENDENCY_BASELINE));
}

export function loadLine13T0Inventory(root = line13RepoRoot()): readonly Line13InventoryEntry[] {
	const baselineEntries: Line13InventoryEntry[] = [
		{
			id: "base-origin-main",
			category: "baseline",
			currentCodeLocation: `git:${LINE13_T0_BASE_SHA}`,
			acOwner: "AC-01–AC-24 shared T0 baseline",
			migrationOrRemovalStage: "Permanent baseline evidence",
			evidence: `HEAD, local main, origin/main tracking ref, and remote refs/heads/main all resolved to ${LINE13_T0_BASE_SHA}; origin ${LINE13_T0_BASELINE.originUrl}`,
		},
		{
			id: "clean-start",
			category: "baseline",
			currentCodeLocation: "git:status --porcelain=v1",
			acOwner: "AC-01–AC-24 shared T0 baseline",
			migrationOrRemovalStage: "Permanent baseline evidence",
			evidence: "Clean start was captured before npm hydration or file creation; porcelain output was the empty string",
		},
	];
	const dependencyEntries: Line13InventoryEntry[] = LINE13_T0_DEPENDENCY_BASELINE.map((entry) => ({
		id: `dependency:${entry.path}`,
		category: "dependency",
		currentCodeLocation: entry.path,
		acOwner: "AC-01–AC-24 shared T0 baseline",
		migrationOrRemovalStage: "Re-freeze only on an intentionally reviewed dependency change",
		evidence: `sha256 ${entry.sha256}`,
	}));
	return [...baselineEntries, ...dependencyEntries, ...materializePublicExports(root), ...materializeFacts(root)]
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function line13InventoryDigest(entries: readonly Line13InventoryEntry[]): string {
	return sha256(`${JSON.stringify(entries)}\n`);
}
