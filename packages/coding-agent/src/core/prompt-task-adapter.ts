import {
	canonicalFoundationJson,
	type AgentHarness,
	type AgentHarnessFoundationExecution,
	createAgentInstance,
	createHostTerminalGateAuthorityV1,
	createOrderedBindingEpochV1,
	createTaskEnvelopeV1,
	fingerprintFoundationValue,
	persistTaskEnvelopeBeforeResolverV1,
	resolveAgentBinding,
	SessionLedgerV1,
	validateDispatchV1,
	validateProviderJsonV1,
	validateRoleRevisionV1,
	validateSecretFreeModelProfileV1,
	validateVersionedReferenceV1,
	type AcceptanceFactV1,
	type AgentBindingV1,
	type AgentInstanceV1,
	type ArtifactRefV1,
	type AttemptReceiptV1,
	type BindingEpochV1,
	type DispatchV1,
	type FoundationJsonValue,
	type ModelProfileV1,
	type RevisionReferenceV1,
	type RoleRevisionV1,
	type RunOutcome,
	type RunReceiptV1,
	type SessionLedgerWriter,
	type TaskEnvelopeV1,
	type TaskExecutorProvider,
	type TaskResultV1,
	type ValidationResultV1,
} from "@aos-agent/agent-core";
import type { ImageContent } from "@aos-agent/ai";
import { createCodingAgentHarness, type CreateCodingAgentHarnessOptions } from "../server/create-harness.ts";

export const PROMPT_TASK_DEPENDENCY_NAMES = [
	"context",
	"model",
	"capability",
	"mcp",
	"policy",
	"sandbox",
	"audit",
	"run",
	"gate",
	"graph",
	"credential",
	"adapter",
] as const;

export type PromptTaskDependencyNameV1 = (typeof PROMPT_TASK_DEPENDENCY_NAMES)[number];

const PROMPT_TASK_DEPENDENCY_FACT_TYPES = {
	context: "context_snapshot",
	model: "model_broker_binding",
	capability: "capability_binding",
	mcp: "mcp_binding",
	policy: "policy_binding",
	sandbox: "sandbox_binding",
	audit: "audit_binding",
	run: "run_binding",
	gate: "task_gate_binding",
	graph: "task_graph_binding",
	credential: "credential_lease_binding",
	adapter: "external_agent_binding",
} as const satisfies Record<PromptTaskDependencyNameV1, string>;

export type PromptTaskCompositionErrorCodeV1 =
	| "prompt_task_dependency_missing"
	| "prompt_task_dependency_invalid"
	| "prompt_task_input_invalid"
	| "prompt_task_binding_invalid"
	| "prompt_task_receipt_missing";

export class PromptTaskCompositionError extends Error {
	readonly code: PromptTaskCompositionErrorCodeV1;
	readonly dependency?: PromptTaskDependencyNameV1;

	constructor(code: PromptTaskCompositionErrorCodeV1, message: string, dependency?: PromptTaskDependencyNameV1, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PromptTaskCompositionError";
		this.code = code;
		this.dependency = dependency;
	}
}

export interface PromptTaskDependencyResolutionV1 {
	readonly reference: RevisionReferenceV1;
	readonly payload: FoundationJsonValue;
}

export interface PromptTaskDependencyContextV1 {
	readonly prompt: string;
	readonly task: TaskEnvelopeV1;
	readonly roleRevision: RoleRevisionV1;
	readonly modelProfile: ModelProfileV1;
}

export interface PromptTaskDependencyV1<TName extends PromptTaskDependencyNameV1 = PromptTaskDependencyNameV1> {
	readonly name: TName;
	readonly revision: number;
	resolve(context: PromptTaskDependencyContextV1): PromptTaskDependencyResolutionV1 | Promise<PromptTaskDependencyResolutionV1>;
}

export type PromptTaskCompositionDependenciesV1 = {
	readonly [TName in PromptTaskDependencyNameV1]: PromptTaskDependencyV1<TName>;
};

export type PromptTaskEnvelopeInputV1 = Omit<
	TaskEnvelopeV1,
	"schemaVersion" | "goal" | "fingerprint" | "status" | "createdAt" | "updatedAt"
>;

export interface PromptTaskIdentityV1 {
	readonly bindingId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId?: string;
}

export interface PromptTaskSettlementV1 {
	readonly summary?: string;
	readonly artifacts: readonly ArtifactRefV1[];
	readonly diff?: ArtifactRefV1;
	readonly tests: readonly ValidationResultV1[];
	readonly evidence: readonly AcceptanceFactV1[];
}

export interface PromptTaskInputV1 {
	readonly prompt: string;
	readonly images?: readonly ImageContent[];
	readonly continuation?: boolean;
	readonly runId?: string;
	readonly task: PromptTaskEnvelopeInputV1;
	readonly roleRevision: RoleRevisionV1;
	readonly modelProfile: ModelProfileV1;
	readonly identity: PromptTaskIdentityV1;
	readonly settlement: PromptTaskSettlementV1;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
	readonly now?: () => string;
}

export interface PromptTaskExecutionV1 {
	readonly task: TaskEnvelopeV1;
	readonly binding: AgentBindingV1;
	readonly dispatch: DispatchV1;
	readonly initialBindingEpoch: BindingEpochV1;
	readonly agentInstance?: AgentInstanceV1;
	readonly run: { readonly runId: string } & RunOutcome;
	readonly attemptReceipt: AttemptReceiptV1;
	readonly taskResult: TaskResultV1;
	readonly runReceipt: RunReceiptV1;
}

export interface PromptTaskCompositionRootOptionsV1 {
	readonly dependencies: PromptTaskCompositionDependenciesV1;
	readonly provider: TaskExecutorProvider;
	readonly harness: Omit<CreateCodingAgentHarnessOptions, "env" | "foundationExecution" | "foundationProvider"> & {
		readonly env?: CreateCodingAgentHarnessOptions["env"];
	};
	/** Long-lived runtime authority used by product entry points. */
	readonly runtimeHarness?: AgentHarness;
	readonly ownerId?: string;
	/** Shared durable writer for composition into a long-lived Harness. */
	readonly writer?: SessionLedgerWriter;
}

export interface PromptTaskAdapterV1 {
	execute(input: PromptTaskInputV1): Promise<PromptTaskExecutionV1>;
}

type ResolvedPromptTaskDependencies = Record<PromptTaskDependencyNameV1, PromptTaskDependencyResolutionV1>;
const SECRET_BEARING_DEPENDENCY_FIELDS = new Set(["token", "accesstoken", "refreshtoken", "password", "secret", "authorization", "apikey", "headers", "environment", "env", "material"]);

function requireNonempty(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new PromptTaskCompositionError("prompt_task_input_invalid", `${field} must be a non-empty string`);
}

function validateSettlementPrerequisites(input: PromptTaskInputV1): void {
	const settlement = input.settlement as PromptTaskSettlementV1 | undefined;
	if (settlement === undefined || !Array.isArray(settlement.artifacts) || !Array.isArray(settlement.tests) || !Array.isArray(settlement.evidence)) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task settlement artifacts, tests, and evidence are required before provider execution");
	}
	const requiredTests = settlement.tests.filter((test) => test.required);
	const requiresAcceptanceProof = input.task.expectedOutputs.length > 0 || input.task.acceptanceCriteria.some((criterion) => criterion.required);
	if (
		requiredTests.some((test) => test.status !== "passed") ||
		(requiresAcceptanceProof && !requiredTests.some((test) => test.status === "passed"))
	) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task settlement requires at least one passed required test and no unmet required test");
	}
	for (const expected of input.task.expectedOutputs) {
		if (!settlement.artifacts.some((artifact) => artifact.artifactId === expected.artifactId && artifact.digest === expected.digest)) {
			throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task settlement is missing expected output ${expected.artifactId}`);
		}
	}
	for (const criterion of input.task.acceptanceCriteria) {
		if (!criterion.required) continue;
		const evidence = settlement.evidence.find((fact) => fact.criterionId === criterion.criterionId && fact.outcome === "satisfied");
		if (evidence?.evidenceRefs === undefined || evidence.evidenceRefs.length === 0) {
			throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task settlement is missing evidence for ${criterion.criterionId}`);
		}
	}
}

function containsSecretBearingField(value: FoundationJsonValue): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(containsSecretBearingField);
	return Object.entries(value).some(([key, child]) => SECRET_BEARING_DEPENDENCY_FIELDS.has(key.replaceAll(/[_-]/g, "").toLowerCase()) || containsSecretBearingField(child));
}

function validateCompositionRootDependencies(dependencies: PromptTaskCompositionDependenciesV1): void {
	const record = dependencies as unknown as Record<string, unknown>;
	for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
		const candidate = record[name];
		if (candidate === undefined) throw new PromptTaskCompositionError("prompt_task_dependency_missing", `Prompt Task composition requires the ${name} dependency`, name);
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency is invalid`, name);
		const dependency = candidate as Partial<PromptTaskDependencyV1>;
		if (dependency.name !== name || !Number.isInteger(dependency.revision) || (dependency.revision ?? 0) < 1 || typeof dependency.resolve !== "function") {
			throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency must expose its exact name, revision, and resolver`, name);
		}
	}
}

function validateDependencyResolution(name: PromptTaskDependencyNameV1, declaredRevision: number, value: PromptTaskDependencyResolutionV1): PromptTaskDependencyResolutionV1 {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned no immutable binding fact`, name);
	const checkedReference = validateVersionedReferenceV1(value.reference);
	if (!checkedReference.ok) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned an invalid revision reference`, name, checkedReference.error);
	const reference = checkedReference.value;
	if (reference.revision === undefined || reference.revision !== declaredRevision || reference.revision < 1 || reference.fingerprint === undefined || reference.type !== PROMPT_TASK_DEPENDENCY_FACT_TYPES[name]) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned the wrong immutable fact type or revision`, name);
	}
	if (!validateProviderJsonV1(value.payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned a non-JSON binding fact`, name);
	const payload = value.payload;
	if (containsSecretBearingField(payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned secret-bearing material instead of an immutable reference`, name);
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency returned a non-object binding fact`, name);
	if (payload.schemaVersion !== 1 || payload.type !== reference.type || payload.id !== reference.id || payload.revision !== reference.revision) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency fact does not match its revision reference`, name);
	}
	if (fingerprintFoundationValue(payload).value !== reference.fingerprint.value) {
		throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency fact fingerprint does not match its payload`, name);
	}
	return { reference: { ...reference, revision: reference.revision, fingerprint: reference.fingerprint }, payload: structuredClone(payload) };
}

async function resolveDependencies(
	dependencies: PromptTaskCompositionDependenciesV1,
	context: PromptTaskDependencyContextV1,
): Promise<ResolvedPromptTaskDependencies> {
	const resolved = {} as ResolvedPromptTaskDependencies;
	for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
		try {
			resolved[name] = validateDependencyResolution(name, dependencies[name].revision, await dependencies[name].resolve(context));
		} catch (error) {
			if (error instanceof PromptTaskCompositionError) throw error;
			throw new PromptTaskCompositionError("prompt_task_dependency_invalid", `Prompt Task ${name} dependency resolution failed`, name, error);
		}
	}
	return resolved;
}

async function persistImmutableFact(
	ledger: SessionLedgerV1,
	objectType: string,
	objectId: string,
	payload: FoundationJsonValue,
	taskId: string,
	bindingId: string,
	clientRequestId: string,
): Promise<void> {
	const existing = await ledger.get(objectType, objectId);
	if (existing !== undefined) {
		if (existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return;
		throw new PromptTaskCompositionError("prompt_task_binding_invalid", `Durable ${objectType} ${objectId} conflicts with the Prompt Task binding`);
	}
	await ledger.appendFact(objectType, objectId, payload, {
		clientRequestId,
		expectedRevision: 0,
		correlation: { taskId, bindingId },
	});
}

async function persistBindingSources(
	options: PromptTaskCompositionRootOptionsV1,
	input: PromptTaskInputV1,
	resolved: ResolvedPromptTaskDependencies,
): Promise<void> {
	const ledger = new SessionLedgerV1(options.harness.session, { ownerId: options.ownerId ?? `prompt-task:${input.identity.bindingId}`, writer: options.writer });
	try {
		await persistImmutableFact(ledger, "role_revision", input.roleRevision.roleRevisionId, input.roleRevision as unknown as FoundationJsonValue, input.task.taskId, input.identity.bindingId, `prompt-task:role:${input.roleRevision.roleRevisionId}`);
		await persistImmutableFact(ledger, "model_profile_revision", input.modelProfile.modelProfileId, input.modelProfile as unknown as FoundationJsonValue, input.task.taskId, input.identity.bindingId, `prompt-task:model-profile:${input.modelProfile.modelProfileId}`);
		for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
			const resolution = resolved[name];
			await persistImmutableFact(ledger, resolution.reference.type, resolution.reference.id, resolution.payload, input.task.taskId, input.identity.bindingId, `prompt-task:${name}:${resolution.reference.id}`);
		}
	} finally {
		await ledger.release();
	}
}

function createTask(input: PromptTaskInputV1, timestamp: string): TaskEnvelopeV1 {
	const created = createTaskEnvelopeV1({
		...input.task,
		schemaVersion: 1,
		goal: input.prompt,
		status: "ready",
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	if (!created.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task input could not create a TaskEnvelope", undefined, created.error);
	return created.value;
}

function createBinding(
	input: PromptTaskInputV1,
	task: TaskEnvelopeV1,
	resolved: ResolvedPromptTaskDependencies,
	timestamp: string,
): AgentBindingV1 {
	const binding = resolveAgentBinding({
		task,
		roleRevision: input.roleRevision,
		modelProfile: input.modelProfile,
		externalAgentBindingRevision: resolved.adapter.reference,
		capabilityRevision: resolved.capability.reference,
		modelBrokerBindingRevision: resolved.model.reference,
		policyRevision: resolved.policy.reference,
		sourceTrace: PROMPT_TASK_DEPENDENCY_NAMES.map((name) => ({ field: name, layer: "task" as const, referenceId: resolved[name].reference.id, revision: resolved[name].reference.revision })),
		newBindingId: input.identity.bindingId,
		now: () => timestamp,
	});
	if (!binding.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task dependency facts could not resolve an AgentBinding", undefined, binding.error);
	return binding.value;
}

function createDispatch(input: PromptTaskInputV1, task: TaskEnvelopeV1, provider: TaskExecutorProvider, timestamp: string): DispatchV1 {
	const dispatch = validateDispatchV1({ schemaVersion: 1, dispatchId: input.identity.dispatchId, taskId: task.taskId, bindingId: input.identity.bindingId, taskExecutorProviderId: provider.providerId, status: "pending", createdAt: timestamp });
	if (!dispatch.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create a Dispatch", undefined, dispatch.error);
	return dispatch.value;
}

function createExecutionIdentity(
	input: PromptTaskInputV1,
	task: TaskEnvelopeV1,
	provider: TaskExecutorProvider,
	timestamp: string,
): { readonly epoch: BindingEpochV1; readonly agentInstance?: AgentInstanceV1 } {
	const isAgent = provider.providerClass === "agent";
	if (isAgent !== (input.identity.agentInstanceId !== undefined)) throw new PromptTaskCompositionError("prompt_task_input_invalid", isAgent ? "Agent provider requires agentInstanceId" : "Non-agent provider forbids agentInstanceId");
	const epoch = createOrderedBindingEpochV1({ bindingEpochId: input.identity.bindingEpochId, taskId: task.taskId, attemptId: input.identity.attemptId, bindingId: input.identity.bindingId, activationReason: "attempt_started", activatedByCommandId: input.identity.dispatchId, ...(input.identity.agentInstanceId === undefined ? {} : { agentInstanceId: input.identity.agentInstanceId }), now: () => timestamp });
	if (!epoch.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create the initial BindingEpoch", undefined, epoch.error);
	if (!isAgent || input.identity.agentInstanceId === undefined) return { epoch: epoch.value };
	const created = createAgentInstance({ agentInstanceId: input.identity.agentInstanceId, providerId: provider.providerId, providerDeclaredAgent: true, roleRevision: input.roleRevision, taskId: task.taskId, now: () => timestamp });
	if (!created.ok) throw new PromptTaskCompositionError("prompt_task_binding_invalid", "Prompt Task input could not create an AgentInstance", undefined, created.error);
	return { epoch: epoch.value, agentInstance: { ...created.value, bindingEpochIds: [epoch.value.bindingEpochId] } };
}

async function requireReceipt<T>(session: CreateCodingAgentHarnessOptions["session"], objectType: string, objectId: string): Promise<T> {
	const record = await session.getFoundationObject(objectType, objectId);
	if (record?.kind !== "fact") throw new PromptTaskCompositionError("prompt_task_receipt_missing", `Prompt Task execution did not persist ${objectType} ${objectId}`);
	return record.payload as unknown as T;
}

async function findAttemptReceipt(session: CreateCodingAgentHarnessOptions["session"], attemptId: string): Promise<AttemptReceiptV1> {
	const records = await session.findFoundationRecords({ kind: "fact", objectType: "attempt_receipt", order: "oldestFirst" });
	const record = records.find((candidate) => candidate.kind === "fact" && (candidate.payload as { attemptId?: unknown }).attemptId === attemptId);
	if (record?.kind !== "fact") throw new PromptTaskCompositionError("prompt_task_receipt_missing", `Prompt Task execution did not persist an AttemptReceipt for ${attemptId}`);
	return record.payload as unknown as AttemptReceiptV1;
}

export function createPromptTaskAdapter(options: PromptTaskCompositionRootOptionsV1): PromptTaskAdapterV1 {
	validateCompositionRootDependencies(options.dependencies);
	requireNonempty(options.provider.providerId, "provider.providerId");
	if (options.harness.drive === "manual") throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires automatic Harness drive to produce terminal receipts");
	if (options.runtimeHarness === undefined && options.harness.env === undefined) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires an execution environment when it creates a Harness");
	}
	if (options.runtimeHarness !== undefined && options.runtimeHarness.session !== options.harness.session) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task runtime Harness must use the composition Session");
	}
	if (options.runtimeHarness !== undefined && options.writer !== options.runtimeHarness.t5.writer) {
		throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task runtime Harness must share its Session ledger writer with the composition root");
	}
	return {
		async execute(input) {
			requireNonempty(input.prompt, "prompt");
			if (input.runId !== undefined) requireNonempty(input.runId, "runId");
			if (input.signal?.aborted) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task was aborted before execution");
			if (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs < 0)) {
				throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task deadlineMs must be non-negative");
			}
			for (const [field, value] of Object.entries(input.identity)) requireNonempty(value, `identity.${field}`);
			validateSettlementPrerequisites(input);
			const timestamp = (input.now ?? (() => new Date().toISOString()))();
			if (Number.isNaN(Date.parse(timestamp))) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task clock must return an ISO timestamp");
			const checkedRole = validateRoleRevisionV1(input.roleRevision);
			if (!checkedRole.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task RoleRevision is invalid", undefined, checkedRole.error);
			const { fingerprint: _roleFingerprint, ...roleBase } = checkedRole.value;
			if (fingerprintFoundationValue(roleBase).value !== checkedRole.value.fingerprint.value) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task RoleRevision fingerprint is invalid");
			const checkedProfile = validateSecretFreeModelProfileV1(input.modelProfile);
			if (!checkedProfile.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task ModelProfile is invalid", undefined, checkedProfile.error);
			const normalizedInput = { ...input, roleRevision: checkedRole.value, modelProfile: checkedProfile.value };
			const task = createTask(normalizedInput, timestamp);
			const persistedTask = await persistTaskEnvelopeBeforeResolverV1(options.harness.session, task, { ownerId: options.ownerId, writer: options.writer });
			if (!persistedTask.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task TaskEnvelope could not be persisted before resolution", undefined, persistedTask.error);
			const resolved = await resolveDependencies(options.dependencies, { prompt: input.prompt, task: persistedTask.value, roleRevision: checkedRole.value, modelProfile: checkedProfile.value });
			if (resolved.adapter.reference.providerId !== options.provider.providerId) {
				throw new PromptTaskCompositionError("prompt_task_dependency_invalid", "Prompt Task Adapter binding does not match the trusted execution provider", "adapter");
			}
			await persistBindingSources(options, normalizedInput, resolved);
			const binding = createBinding(normalizedInput, persistedTask.value, resolved, timestamp);
			const dispatch = createDispatch(normalizedInput, persistedTask.value, options.provider, timestamp);
			const identity = createExecutionIdentity(normalizedInput, persistedTask.value, options.provider, timestamp);
			const foundationExecution: AgentHarnessFoundationExecution = {
				task: persistedTask.value,
				binding,
				dispatch,
				providerId: options.provider.providerId,
				initialBindingEpoch: identity.epoch,
				bindingEpochIds: [identity.epoch.bindingEpochId],
				...(identity.agentInstance === undefined ? {} : { agentInstanceId: identity.agentInstance.agentInstanceId, agentInstance: identity.agentInstance }),
				settlement: input.settlement,
				hostAuthority: createHostTerminalGateAuthorityV1(resolved.gate.reference.id, resolved.gate.reference.revision),
			};
			let created: { harness: AgentHarness };
			if (options.runtimeHarness === undefined) {
				const env = options.harness.env;
				if (env === undefined) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task composition requires an execution environment when it creates a Harness");
				created = await createCodingAgentHarness({
					...options.harness,
					env,
					foundationProvider: options.provider,
					foundationExecution,
				});
			} else {
				created = { harness: options.runtimeHarness };
			}
			if (options.runtimeHarness !== undefined) {
				await created.harness.activateFoundationExecution(foundationExecution, options.provider);
			}
			if (input.signal?.aborted) throw new PromptTaskCompositionError("prompt_task_input_invalid", "Prompt Task was aborted before provider execution");
			let execution: PromptTaskExecutionV1 | undefined;
			let executionError: unknown;
			try {
				const preflight = (signal: AbortSignal): void => {
					if (signal.aborted) throw signal.reason;
				};
				const runOptions = {
					...(input.runId === undefined ? {} : { runId: input.runId }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
				};
				const run = input.continuation === true
					? await created.harness.continueWithPreflight(preflight, runOptions)
					: await created.harness.promptWithPreflight(input.prompt, preflight, {
						...runOptions,
						...(input.images === undefined ? {} : { images: [...input.images] }),
					});
				if (!run.ok) throw new PromptTaskCompositionError("prompt_task_input_invalid", `Prompt Task Harness rejected the prompt: ${run.error.message}`, undefined, run.error);
				const attemptReceipt = await findAttemptReceipt(options.harness.session, input.identity.attemptId);
				const taskResult = await requireReceipt<TaskResultV1>(options.harness.session, "task_result", `task_result_${run.value.runId}`);
				const runReceipt = await requireReceipt<RunReceiptV1>(options.harness.session, "run_receipt", run.value.runId);
				execution = { task: persistedTask.value, binding, dispatch, initialBindingEpoch: identity.epoch, ...(identity.agentInstance === undefined ? {} : { agentInstance: identity.agentInstance }), run: run.value, attemptReceipt, taskResult, runReceipt };
			} catch (error) {
				executionError = error;
			}
			let closeError: unknown;
			if (options.runtimeHarness === undefined) {
				try {
					await created.harness.close();
				} catch (error) {
					closeError = error;
				}
			}
			if (executionError !== undefined) throw executionError;
			if (closeError !== undefined) throw closeError;
			if (execution === undefined) throw new PromptTaskCompositionError("prompt_task_receipt_missing", "Prompt Task execution ended without a terminal result");
			return execution;
		},
	};
}
