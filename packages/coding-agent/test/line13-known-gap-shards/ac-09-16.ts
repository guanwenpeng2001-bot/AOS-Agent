import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	InMemorySessionStorage,
	FoundationError,
	Result,
	Session,
	SessionLedger,
	createAgentInstance,
	createAttempt,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createExecutionCorrelation,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
	type BudgetUsage,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ModelProfile,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	type RevisionReference,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	validateAttemptReceiptForProvider,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from "@aos-agent/ai/compat";
import ts from "typescript";
import {
	createAgentRuntimeCompositionFactory,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createRpcHostController,
	DefaultResourceLoader,
	ModelRuntime,
	ProjectTrustStore,
	SchedulerDispatchController,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	SchedulerQueueStore,
	SettingsManager,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
} from "../../src/index.ts";
import { createExternalConnectorRegistry } from "../../src/core/external-agent-registry.ts";
import type { ExternalConnectorDurableStore } from "../../src/core/external-agent-operation.ts";
import { createProductionExternalAgentConnector } from "../../src/core/external-connector-production.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
} from "../../src/core/external-connector-supervisor.ts";
import type { ExternalConnectorVendorDriver } from "../../src/core/vendor-drivers/types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getAgentCanonicalSession } from "../../src/core/agent-session-facade.ts";
import {
	CapabilityPublicIdentity,
	getCapabilityPublicIdentityPath,
} from "../../src/core/capability-public-identity.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	createSchedulerExecutorRuntimeSnapshotV1,
	schedulerBindingRequirementDigestV1,
} from "../../src/core/scheduler-executors.ts";
import { SchedulerSelectionReservationStore } from "../../src/core/scheduler-selection-reservations.ts";
import type {
	SchedulerNativeAgentBridgeV1,
	SchedulerNativeAgentResolutionV1,
} from "../../src/core/scheduler-dispatch.ts";
import type { SchedulerExecutorEntryV1, SchedulerQueueEntryV1 } from "../../src/core/scheduler.ts";
import {
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
} from "../support/line13-known-gaps.ts";
import { LINE13_T0_PUBLIC_ROOTS, line13RepoRoot } from "../support/line13-t0-baseline-inventory.ts";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:01:00.000Z";
const SELECTION_EXPIRES_AT = "2026-08-25T01:00:00.000Z";
const SESSION_ID = "line13-ac09-session";
const TASK_ID = "line13-ac09-task";
const OWNER_ID = "line13-ac09-owner";
const CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function taskEnvelope(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: TASK_ID,
		goalId: "line13-ac09-goal",
		goal: "Prove scheduler decisions survive a Host restart",
		workspace: "line13-ac09-workspace",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100, concurrency: 1 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "line13-ac09-role",
			scope: "project",
			slug: "line13-scheduler-worker",
			name: "Line 13 scheduler worker",
			description: "Executes the selected Scheduler attempt",
			revision: 1,
			persona: "Execute one durable Scheduler attempt.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: "line13-ac09-profile",
				revision: 1,
			},
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "line13-ac09-profile",
		provider: "host",
		model: "host",
		budget: { tokens: 100 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(): AgentBinding {
	const resolved = resolveAgentBinding({
		task: taskEnvelope(),
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "line13-ac09-context"),
		capabilityRevision: immutableFact("capability_binding", "line13-ac09-capability"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "line13-ac09-broker"),
		policyRevision: immutableFact("policy_binding", "line13-ac09-policy"),
		newBindingId: "line13-ac09-binding",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function seedBindingFacts(session: Session, value: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: `${OWNER_ID}-seed` });
	await ledger.appendFact("task", value.taskId, taskEnvelope(), {
		clientRequestId: "line13-ac09-seed-task",
		expectedRevision: 0,
		correlation: { taskId: value.taskId },
	});
	await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision(), {
		clientRequestId: "line13-ac09-seed-role",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile(), {
		clientRequestId: "line13-ac09-seed-model",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	for (const [objectType, reference] of [
		["external_agent_binding", value.contextRevision],
		["capability_binding", value.capabilityRevision],
		["model_broker_binding", value.modelBrokerBindingRevision],
		["policy_binding", value.policyRevision],
	] as const) {
		await ledger.appendFact(
			objectType,
			reference.id,
			{
				schemaVersion: 1,
				type: reference.type,
				id: reference.id,
				revision: reference.revision,
			},
			{
				clientRequestId: `line13-ac09-seed-${objectType}`,
				expectedRevision: 0,
				correlation: { taskId: value.taskId, bindingId: value.bindingId },
			},
		);
	}
	await ledger.release();
}

function queueEntry(queueEntryId = "line13-ac09-queue"): SchedulerQueueEntryV1 {
	return {
		schemaVersion: 1,
		queueEntryId,
		sessionId: SESSION_ID,
		taskId: TASK_ID,
		goalId: "line13-ac09-goal",
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
	};
}

function executorEntry(provider: SchedulerInProcessTaskExecutorProvider): SchedulerExecutorEntryV1 {
	return {
		schemaVersion: 1,
		descriptor: {
			schemaVersion: 1,
			providerId: provider.providerId,
			providerClass: provider.providerClass,
		},
		capabilities: [CAPABILITY],
		costClass: "local",
		registeredAt: NOW,
	};
}

function schedulerRuntimeSnapshot(providerId: string, currentBinding: AgentBinding) {
	const bindingDigest = schedulerBindingRequirementDigestV1(currentBinding);
	if (!bindingDigest.ok) throw bindingDigest.error;
	const policyDigest = currentBinding.policyRevision.fingerprint;
	if (policyDigest === undefined) throw new Error("Line 13 Scheduler binding lacks a policy fingerprint");
	const snapshot = createSchedulerExecutorRuntimeSnapshotV1({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "line13-scheduler", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		}),
		configRevision: fingerprintFoundationValue(`line13-config:${providerId}`),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [currentBinding.mcpSelection.digest],
		policyRevisionDigests: [policyDigest],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: NOW,
		expiresAt: SELECTION_EXPIRES_AT,
	});
	if (!snapshot.ok) throw snapshot.error;
	return snapshot.value;
}

function schedulerExactRequirements(currentBinding: AgentBinding, attemptId: string) {
	return {
		binding: currentBinding,
		attemptId,
		bindingEpochId: `epoch-${attemptId}`,
		requireResume: true,
		modelAccess: "aos_gateway" as const,
	};
}

async function registerExecutor(
	registry: SchedulerExecutorRegistry,
	provider: SchedulerInProcessTaskExecutorProvider,
	maxConcurrency = 1,
	currentBinding?: AgentBinding,
): Promise<void> {
	const registered = await registry.register({
		entry: executorEntry(provider),
		provider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency,
		...(currentBinding === undefined
			? {}
			: { runtimeSnapshot: schedulerRuntimeSnapshot(provider.providerId, currentBinding) }),
	});
	if (!registered.ok) throw registered.error;
}

interface SelectionReplayFixture {
	readonly storage: InMemorySessionStorage;
	readonly currentBinding: AgentBinding;
	reopenedRegistry?: SchedulerExecutorRegistry;
	reopenedStore?: SchedulerSelectionReservationStore;
}

async function prepareSelectionReplayFixture(fixture: SelectionReplayFixture): Promise<void> {
	const firstSession = new Session(fixture.storage);
	await seedBindingFacts(firstSession, fixture.currentBinding);
	const firstStore = new SchedulerSelectionReservationStore(firstSession, {
		ownerId: `${OWNER_ID}-first`,
		now: () => NOW,
	});
	const firstRegistry = new SchedulerExecutorRegistry({ reservationStore: firstStore });
	await registerExecutor(
		firstRegistry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.a", now: () => NOW }),
		1,
		fixture.currentBinding,
	);
	const selected = await firstRegistry.select({
		queueEntry: queueEntry(),
		requiredCapabilities: [CAPABILITY],
		decidedAt: NOW,
		exactRequirements: schedulerExactRequirements(fixture.currentBinding, "line13-ac09-attempt"),
	});
	if (!selected.ok) throw selected.error;
	if (selected.value.provider.providerId !== "line13.scheduler.a") {
		throw new Error("Selection replay fixture did not persist the original Scheduler choice");
	}
	await firstStore.release();

	const reopenedStore = new SchedulerSelectionReservationStore(new Session(fixture.storage), {
		ownerId: `${OWNER_ID}-reopened`,
		now: () => LATER,
	});
	const reopenedRegistry = new SchedulerExecutorRegistry({ reservationStore: reopenedStore });
	await registerExecutor(
		reopenedRegistry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.b", now: () => LATER }),
		1,
		fixture.currentBinding,
	);
	fixture.reopenedRegistry = reopenedRegistry;
	fixture.reopenedStore = reopenedStore;
}

class Line13AgentTaskExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "line13.native-agent";
	readonly providerClass = "agent" as const;

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [];
	}

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		if (context?.agentInstance === undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_required_for_agent_provider",
					"Line 13 agent executor requires the Scheduler-owned AgentInstance",
				),
			);
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			agentInstanceId: context.agentInstance.agentInstanceId,
			now: () => NOW,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		const correlation = options?.correlation;
		if (
			attempt.agentInstanceId === undefined ||
			correlation === undefined ||
			correlation.agentInstanceId !== attempt.agentInstanceId
		) {
			return Result.err(
				new FoundationError("invalid_correlation", "Line 13 agent executor requires AgentInstance correlation"),
			);
		}
		const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
		const receipt: AttemptReceipt = {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: attempt.providerId,
			agentInstanceId: attempt.agentInstanceId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "agent_executor",
				providerId: attempt.providerId,
				producedAt: NOW,
				correlation: { ...correlation, attemptReceiptId },
			},
			sideEffectState: "none",
		};
		return validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}

	async cancelAttempt(_attemptId: string) {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

class Line13NativeAgentBridge implements SchedulerNativeAgentBridgeV1 {
	private readonly session: Session;
	private readonly provider: Line13AgentTaskExecutor;

	constructor(session: Session, provider: Line13AgentTaskExecutor) {
		this.session = session;
		this.provider = provider;
	}

	async resolve(input: Parameters<SchedulerNativeAgentBridgeV1["resolve"]>[0]) {
		const instance = createAgentInstance({
			agentInstanceId: input.agentInstanceId,
			providerId: input.provider.providerId,
			providerDeclaredAgent: true,
			roleRevision: roleRevision(),
			taskId: input.entry.taskId,
			now: () => input.now,
		});
		if (!instance.ok) return instance;
		const epoch = createBindingEpoch({
			bindingEpochId: input.bindingEpochId,
			taskId: input.entry.taskId,
			attemptId: input.attemptId,
			agentInstanceId: input.agentInstanceId,
			bindingId: input.binding.bindingId,
			activationReason: "attempt_started",
			activatedByCommandId: input.activatedByCommandId,
			now: () => input.now,
		});
		if (!epoch.ok) return epoch;
		const resolution: SchedulerNativeAgentResolutionV1 = {
			schemaVersion: 1,
			providerId: input.provider.providerId,
			dispatch: {
				schemaVersion: 1,
				dispatchId: input.dispatchId,
				taskId: input.entry.taskId,
				bindingId: input.binding.bindingId,
				taskExecutorProviderId: input.provider.providerId,
				status: "pending",
				createdAt: input.now,
				...(input.entry.deadlineAt === undefined ? {} : { deadlineAt: input.entry.deadlineAt }),
			},
			agentInstance: instance.value,
			initialBindingEpoch: epoch.value,
			correlation: createExecutionCorrelation(input.sessionId, input.laneId, {
				revision: 0,
				taskId: input.entry.taskId,
				dispatchId: input.dispatchId,
				attemptId: input.attemptId,
				bindingId: input.binding.bindingId,
				bindingEpochId: input.bindingEpochId,
				agentInstanceId: input.agentInstanceId,
				providerId: input.provider.providerId,
			}),
		};
		return Result.ok(resolution);
	}

	async revalidate(input: Parameters<SchedulerNativeAgentBridgeV1["revalidate"]>[0]) {
		const durable = await this.session.getFoundationObject("attempt", input.resolution.initialBindingEpoch.attemptId);
		if (durable?.kind !== "fact" || input.provider !== this.provider) {
			return Result.err(new FoundationError("invalid_correlation", "Line 13 Agent bridge lost durable identity"));
		}
		return Result.ok(undefined);
	}
}

interface AgentDispatchFixture {
	readonly session: Session;
	readonly queue: SchedulerQueueStore;
	readonly registry: SchedulerExecutorRegistry;
	readonly controller: SchedulerDispatchController;
	readonly provider: Line13AgentTaskExecutor;
	readonly currentBinding: AgentBinding;
	fencingToken?: string;
}

function agentDispatchFixture(): AgentDispatchFixture {
	const session = new Session(new InMemorySessionStorage({ id: SESSION_ID, createdAt: 1 }));
	const queue = new SchedulerQueueStore({
		ledger: session,
		sessionId: SESSION_ID,
		ownerId: OWNER_ID,
		now: () => NOW,
	});
	const registry = new SchedulerExecutorRegistry();
	const provider = new Line13AgentTaskExecutor();
	return {
		session,
		queue,
		registry,
		controller: new SchedulerDispatchController({
			session,
			queue,
			registry,
			sessionId: SESSION_ID,
			ownerId: OWNER_ID,
			requiredCapabilities: [],
			nativeAgentBridge: new Line13NativeAgentBridge(session, provider),
			now: () => NOW,
		}),
		provider,
		currentBinding: binding(),
	};
}

async function prepareAgentDispatchFixture(fixture: AgentDispatchFixture): Promise<void> {
	await seedBindingFacts(fixture.session, fixture.currentBinding);
	const enqueued = await fixture.queue.enqueue(queueEntry("line13-ac10-queue"));
	if (!enqueued.ok) throw enqueued.error;
	const claimed = await fixture.queue.claim({
		queueEntryId: "line13-ac10-queue",
		ownerId: OWNER_ID,
		claimId: "line13-ac10-claim",
		fencingToken: "line13-ac10-fence",
	});
	if (!claimed.ok) throw claimed.error;
	fixture.fencingToken = claimed.value.claim.fencingToken;
	const registered = await fixture.registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: fixture.provider.providerId,
				providerClass: fixture.provider.providerClass,
			},
			capabilities: [],
			costClass: "local",
			registeredAt: NOW,
		},
		provider: fixture.provider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency: 1,
	});
	if (!registered.ok) throw registered.error;
}

interface CapacityFixture {
	readonly session: Session;
	readonly currentBinding: AgentBinding;
	readonly reservationStore: SchedulerSelectionReservationStore;
	readonly registry: SchedulerExecutorRegistry;
}

function capacityFixture(): CapacityFixture {
	const session = new Session(new InMemorySessionStorage({ id: "line13-ac11-session", createdAt: 1 }));
	const reservationStore = new SchedulerSelectionReservationStore(session, {
		ownerId: "line13-ac11-selection-owner",
		now: () => NOW,
	});
	return {
		session,
		currentBinding: binding(),
		reservationStore,
		registry: new SchedulerExecutorRegistry({ reservationStore }),
	};
}

async function prepareCapacityFixture(fixture: CapacityFixture): Promise<void> {
	await seedBindingFacts(fixture.session, fixture.currentBinding);
	await registerExecutor(
		fixture.registry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.capacity", now: () => NOW }),
		1,
		fixture.currentBinding,
	);
}

interface QuotaThrowFixture {
	readonly provider: SchedulerInProcessTaskExecutorProvider;
	readonly attempt: Attempt;
	readonly correlation: ReturnType<typeof createExecutionCorrelation>;
	readonly reserved: { count: number };
	readonly settled: { count: number };
}

function quotaThrowFixture(): QuotaThrowFixture {
	const reserved = { count: 0 };
	const settled = { count: 0 };
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: "line13.scheduler.quota",
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution: QuotaAttribution, budget: QuotaReservation["budget"]) => {
			reserved.count += 1;
			return Result.ok({
				schemaVersion: 1,
				reservationId: "line13-ac12-reservation",
				attribution,
				budget,
				grantedAt: NOW,
			});
		},
		settle: async (_reservation: QuotaReservation, usage: BudgetUsage) => {
			settled.count += 1;
			return Result.ok(usage);
		},
		dispose: async () => {},
	};
	const provider = new SchedulerInProcessTaskExecutorProvider({
		providerId: "line13.scheduler.quota-runner",
		quota,
		budget: { tokens: 10, concurrency: 1 },
		now: () => NOW,
		hostAttemptRunner: async () => {
			throw new Error("planned runner crash");
		},
	});
	const dispatch = {
		schemaVersion: 1 as const,
		dispatchId: "line13-ac12-dispatch",
		taskId: TASK_ID,
		bindingId: "line13-ac12-binding",
		taskExecutorProviderId: provider.providerId,
		status: "pending" as const,
		createdAt: NOW,
	};
	const createdEpoch = createBindingEpoch({
		bindingEpochId: "line13-ac12-epoch",
		taskId: TASK_ID,
		attemptId: "line13-ac12-attempt",
		bindingId: dispatch.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: "line13-ac12-command",
		now: () => NOW,
	});
	if (!createdEpoch.ok) throw createdEpoch.error;
	const createdAttempt = createAttempt({
		attemptId: "line13-ac12-attempt",
		dispatch,
		providerId: provider.providerId,
		initialBindingEpoch: createdEpoch.value,
		providerClass: provider.providerClass,
		now: () => NOW,
	});
	if (!createdAttempt.ok) throw createdAttempt.error;
	return {
		provider,
		attempt: createdAttempt.value,
		correlation: createExecutionCorrelation(SESSION_ID, "main", {
			revision: 1,
			taskId: TASK_ID,
			dispatchId: dispatch.dispatchId,
			attemptId: createdAttempt.value.attemptId,
			bindingId: dispatch.bindingId,
			bindingEpochId: createdEpoch.value.bindingEpochId,
			providerId: provider.providerId,
		}),
		reserved,
		settled,
	};
}

function settledResponse(text: string): AssistantMessage {
	const {
		deferred: _deferred,
		errorMessage: _errorMessage,
		responseId: _responseId,
		...message
	} = fauxAssistantMessage(text);
	return message;
}

interface ProductAuthorityFixture {
	readonly tempDir: string;
	readonly result: CreateAgentSessionResult;
	readonly unregisterFaux: () => void;
	canonicalObjectTypes: string[];
}

async function productAuthorityFixture(): Promise<ProductAuthorityFixture> {
	const tempDir = mkdtempSync(join(tmpdir(), "aos-line13-ac13-"));
	const faux = registerFauxProvider();
	try {
		faux.setResponses([settledResponse("line13 canonical product response")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "line13-faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRuntime,
			resourceLoader,
			settingsManager,
			session: { mode: "memory" },
			noTools: "all",
		});
		return {
			tempDir,
			result,
			unregisterFaux: faux.unregister,
			canonicalObjectTypes: [],
		};
	} catch (error) {
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}
}

async function prepareProductAuthorityFixture(fixture: ProductAuthorityFixture): Promise<void> {
	await fixture.result.session.prompt("exercise the package-root product composition", {
		runId: "line13-ac13-run",
	});
	const durableSession = getAgentCanonicalSession(fixture.result.session);
	const records = await durableSession.findFoundationRecords({ kind: "fact", order: "oldestFirst" });
	fixture.canonicalObjectTypes = records.flatMap((record) => (record.kind === "fact" ? [record.objectType] : []));
	if (
		!fixture.canonicalObjectTypes.includes("agent_binding") ||
		!fixture.canonicalObjectTypes.includes("run_receipt")
	) {
		throw new Error("Package-root product fixture did not persist the canonical Foundation chain");
	}
}

function declarationVersionTarget(declaration: ts.Declaration): string | undefined {
	if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeReferenceNode(declaration.type)) {
		return declaration.type.typeName.getText(declaration.getSourceFile());
	}
	if (
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer !== undefined &&
		ts.isIdentifier(declaration.initializer)
	) {
		return declaration.initializer.text;
	}
	return undefined;
}

function versionedTarget(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
	if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		const aliased = checker.getAliasedSymbol(symbol);
		if (/_?V\d+(?=[A-Z_]|$)/.test(aliased.name)) return aliased.name;
	}
	for (const declaration of symbol.declarations ?? []) {
		const target = declarationVersionTarget(declaration);
		if (target !== undefined && /_?V\d+(?=[A-Z_]|$)/.test(target)) return target;
	}
	return undefined;
}

let cachedVersionedPublicExports: readonly string[] | undefined;

function currentVersionedPublicExports(): readonly string[] {
	if (cachedVersionedPublicExports !== undefined) return cachedVersionedPublicExports;
	const root = line13RepoRoot();
	const rootNames = LINE13_T0_PUBLIC_ROOTS.map((entry) => resolve(root, entry.source));
	const program = ts.createProgram({
		rootNames,
		options: {
			allowImportingTsExtensions: true,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ESNext,
		},
	});
	const checker = program.getTypeChecker();
	const found: string[] = [];
	for (const publicRoot of LINE13_T0_PUBLIC_ROOTS) {
		const sourceFile = program.getSourceFile(resolve(root, publicRoot.source));
		if (sourceFile === undefined) throw new Error(`Missing public entrypoint ${publicRoot.source}`);
		const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
		if (moduleSymbol === undefined) throw new Error(`Missing module symbol for ${publicRoot.source}`);
		for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
			if (/_?V\d+(?=[A-Z_]|$)/.test(symbol.name) || versionedTarget(checker, symbol) !== undefined) {
				found.push(`${publicRoot.packageName}:${publicRoot.specifier}:${symbol.name}`);
			}
		}
	}
	cachedVersionedPublicExports = Object.freeze(found.sort((left, right) => left.localeCompare(right)));
	return cachedVersionedPublicExports;
}

interface ExternalReadinessFixture {
	readonly root: string;
	readonly controller: ReturnType<typeof createRpcHostController>;
	readonly descriptor: {
		readonly providerId: string;
		readonly revision: number;
		readonly capabilitySnapshotDigest: ConnectorCapabilitySnapshot["digest"];
	};
	readonly effects: Record<"probe" | "spawn" | "network" | "account" | "task" | "tool", number>;
}

async function externalReadinessFixture(): Promise<ExternalReadinessFixture> {
	const root = mkdtempSync(join(tmpdir(), "aos-line13-ac15-"));
	const privateStatePath = join(root, "private", "supervisors.json");
	const providerId = "line13.readiness-connector";
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision: 1,
		protocol: { name: "line13-protocol", version: "1" },
		modelAccess: "none",
		resume: false,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const effects = { probe: 0, spawn: 0, network: 0, account: 0, task: 0, tool: 0 };
	await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath).write("attempt-ac15-quarantine", {
		schemaVersion: 1,
		reference: { schemaVersion: 1, supervisorRef: "ac15-supervisor", operationNonce: "ac15-nonce" },
		detached: false,
		containment: externalConnectorProcessContainment(),
		processIdentity: {
			pid: 2_147_483_000,
			startToken: "missing",
			executableIdentity: "sha256:missing",
			fileIdentity: "file:missing",
		},
	});
	const connector = await createProductionExternalAgentConnector({
		providerId,
		capability: snapshot,
		capabilityProbe: async () => {
			effects.probe += 1;
			effects.network += 1;
			return Result.ok(snapshot);
		},
		store: Object.freeze({
			readOperation: async () => {
				effects.task += 1;
				return undefined;
			},
			readMapping: async () => {
				effects.task += 1;
				return undefined;
			},
		}) as unknown as ExternalConnectorDurableStore,
		driver: Object.freeze({
			spawn: async () => {
				effects.spawn += 1;
				effects.account += 1;
				throw new Error("AC-15 passive status spawned a driver");
			},
			write: async () => {
				effects.tool += 1;
			},
			dispose: async () => undefined,
		}) as unknown as ExternalConnectorVendorDriver,
		privateStatePath,
		process: {
			executablePath: process.execPath,
			arguments: ["-e", "setInterval(function(){},2147483647)"],
			trustedProvenance: {
				modulePath: process.execPath,
				cwd: root,
				version: process.version,
				executableIdentity: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
				moduleIdentity: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
			},
		},
	});
	const descriptor = {
		schemaVersion: 1 as const,
		providerId,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
	const registry = createExternalConnectorRegistry();
	const registered = registry.registerPrepared({
		descriptor,
		connector,
	}, snapshot);
	if (!registered.ok) throw registered.error;
	const runtimeComposition = createAgentRuntimeCompositionFactory({
		externalConnectorRegistry: () => registry,
	});
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir: root,
		modelRuntime,
		settingsManager,
		runtimeComposition,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			noTools: "all",
		});
		runtimeOptions.registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: root,
		agentDir: root,
		session: { mode: "memory", id: "line13-ac15-product-rpc" },
	});
	const controller = createRpcHostController(runtime);
	await controller.start();
	return { root, controller, descriptor, effects };
}

interface AtomicControlStateFixture {
	readonly tempDir: string;
	readonly oldContents: ReadonlyMap<string, string>;
	readonly sentinelPaths: ReadonlyMap<string, string>;
	readonly controlPaths: ReadonlyMap<string, string>;
	readonly projectDir: string;
	readonly identityEscapePath: string;
	mutatedCommittedFiles: string[];
}

function atomicControlStateFixture(): AtomicControlStateFixture {
	const tempDir = mkdtempSync(join(tmpdir(), "aos-line13-ac16-"));
	const sentinelsDir = join(tempDir, "sentinels");
	const agentDir = join(tempDir, "agent");
	const identityAgentDir = join(tempDir, "identity-agent");
	const projectDir = join(tempDir, "project");
	mkdirSync(sentinelsDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(identityAgentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	const oldContents = new Map<string, string>([
		["settings", `${JSON.stringify({ defaultProvider: "old-provider" })}\n`],
		["auth", "{}\n"],
		["trust", "{}\n"],
	]);
	const sentinelPaths = new Map<string, string>();
	const controlPaths = new Map<string, string>([
		["settings", join(agentDir, "settings.json")],
		["auth", join(agentDir, "auth.json")],
		["trust", join(agentDir, "trust.json")],
	]);
	for (const [name, oldContent] of oldContents) {
		const sentinelPath = join(sentinelsDir, `${name}-committed.json`);
		writeFileSync(sentinelPath, oldContent, "utf8");
		const controlPath = controlPaths.get(name);
		if (controlPath === undefined) throw new Error(`Missing ${name} control path`);
		linkSync(sentinelPath, controlPath);
		sentinelPaths.set(name, sentinelPath);
	}

	const identityEscapePath = join(sentinelsDir, "identity-escaped.json");
	symlinkSync(identityEscapePath, getCapabilityPublicIdentityPath(identityAgentDir), "file");
	return {
		tempDir,
		oldContents,
		sentinelPaths,
		controlPaths,
		projectDir,
		identityEscapePath,
		mutatedCommittedFiles: [],
	};
}

async function prepareAtomicControlStateFixture(fixture: AtomicControlStateFixture): Promise<void> {
	const settingsPath = fixture.controlPaths.get("settings");
	const authPath = fixture.controlPaths.get("auth");
	const trustPath = fixture.controlPaths.get("trust");
	if (settingsPath === undefined || authPath === undefined || trustPath === undefined) {
		throw new Error("Atomic control-state fixture paths are incomplete");
	}
	const agentDir = resolve(settingsPath, "..");
	const settings = SettingsManager.create(fixture.projectDir, agentDir);
	settings.setDefaultProvider("new-provider");
	await settings.flush();
	const auth = AuthStorage.create(authPath);
	await auth.modify("line13-provider", async () => ({ type: "api_key", key: "line13-new-key" }));
	const trust = new ProjectTrustStore(agentDir);
	trust.set(fixture.projectDir, true);
	const identityAgentDir = join(fixture.tempDir, "identity-agent");
	let rejectedCorruptIdentity = false;
	try {
		CapabilityPublicIdentity.loadSync(identityAgentDir);
	} catch {
		rejectedCorruptIdentity = true;
	}
	if (!rejectedCorruptIdentity) {
		throw new Error("Capability identity fixture minted a new identity over corrupt state");
	}

	if (JSON.parse(readFileSync(settingsPath, "utf8")).defaultProvider !== "new-provider") {
		throw new Error("Settings fixture did not commit the requested update");
	}
	if (JSON.parse(readFileSync(authPath, "utf8"))["line13-provider"]?.key !== "line13-new-key") {
		throw new Error("Auth fixture did not commit the requested update");
	}
	if (trust.get(fixture.projectDir) !== true) {
		throw new Error("Trust fixture did not commit the requested update");
	}

	fixture.mutatedCommittedFiles = [...fixture.oldContents].flatMap(([name, oldContent]) => {
		const sentinelPath = fixture.sentinelPaths.get(name);
		if (sentinelPath === undefined) throw new Error(`Missing ${name} committed sentinel`);
		return readFileSync(sentinelPath, "utf8") === oldContent ? [] : [name];
	});
	if (existsSync(fixture.identityEscapePath)) fixture.mutatedCommittedFiles.push("identity");
}

const ac15 = defineLine13ResolvedCase({
	ac: "AC-15",
	fullTestName: "Line 13 AC-15 keeps metadata passive and exposes exact side-effect-free readiness diagnostics",
	scenario: {
		fixture: externalReadinessFixture,
		assertion: async ({ root, controller, descriptor, effects }) => {
			const before = { ...effects };
			const expectedDescriptors = [{
				schemaVersion: 1,
				providerId: descriptor.providerId,
				providerClass: "external_connector",
				revision: descriptor.revision,
				capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
			}];
			const expectedReadiness = [{
				schemaVersion: 1,
				providerId: descriptor.providerId,
				trust: "host_configured",
				status: "quarantined",
				reasonCode: "cleanup_unconfirmed",
			}];
			const first = await controller.dispatch({ id: "ac15-readiness-first", type: "initialize", protocolVersion: 1 });
			if (first === undefined || first.command !== "initialize" || !first.success) {
				throw new Error("AC-15 product RPC did not return its initialize readiness projection");
			}
			assert.deepEqual(first.data.externalConnectors, expectedDescriptors);
			assert.deepEqual(first.data.externalConnectorReadiness, expectedReadiness);
			assert.deepEqual(effects, before);
			const second = await controller.dispatch({ id: "ac15-readiness-second", type: "initialize", protocolVersion: 1 });
			if (second === undefined || second.command !== "initialize" || !second.success) {
				throw new Error("AC-15 product RPC did not repeat its passive readiness projection");
			}
			assert.deepEqual(second.data.externalConnectors, expectedDescriptors);
			assert.deepEqual(second.data.externalConnectorReadiness, expectedReadiness);
			assert.deepEqual(effects, before);
			const publicStatus = JSON.stringify({
				descriptors: second.data.externalConnectors,
				readiness: second.data.externalConnectorReadiness,
			});
			for (const privateValue of [root, join(root, "private", "supervisors.json"), process.execPath, "ac15-nonce", "ac15-supervisor"]) {
				assert.equal(publicStatus.includes(privateValue), false);
			}
		},
		cleanup: async ({ controller, root }) => {
			await controller.shutdown().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		},
	},
});

export const line13KnownGapCasesAc09Ac16 = defineLine13KnownGapCaseShard({
	schemaVersion: 1,
	shardId: "ac-09-16",
	complete: true,
	cases: [],
	resolvedCases: [
		defineLine13ResolvedCase({
			ac: "AC-09",
			fullTestName: "Line 13 AC-09 replays the durable SelectionFact after Scheduler Host restart",
			scenario: {
				fixture: (): SelectionReplayFixture => ({
					storage: new InMemorySessionStorage({ id: SESSION_ID, createdAt: 1 }),
					currentBinding: binding(),
				}),
				setup: prepareSelectionReplayFixture,
				assertion: async (fixture) => {
					if (fixture.reopenedRegistry === undefined) {
						throw new Error("Selection replay fixture is incomplete");
					}
					const replayed = await fixture.reopenedRegistry.select({
						queueEntry: queueEntry(),
						requiredCapabilities: [CAPABILITY],
						decidedAt: LATER,
						exactRequirements: schedulerExactRequirements(fixture.currentBinding, "line13-ac09-attempt"),
					});
					assert.equal(
						replayed.ok,
						false,
						"expected the restarted Scheduler to reject an unavailable durable selection",
					);
					if (replayed.ok) return;
					assert.equal(
						replayed.error.code,
						"scheduler_executor_unavailable",
						"expected the restarted Scheduler to replay the original durable SelectionFact",
					);
				},
				cleanup: async (fixture) => fixture.reopenedStore?.release(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-10",
			fullTestName: "Line 13 AC-10 assembles one AgentInstance across Dispatch BindingEpoch and correlation",
			scenario: {
				fixture: agentDispatchFixture,
				setup: prepareAgentDispatchFixture,
				assertion: async ({ controller, currentBinding, fencingToken }) => {
					if (fencingToken === undefined) throw new Error("AC-10 package-root Scheduler fixture is incomplete");
					const dispatched = await controller.dispatchClaimed({
						queueEntryId: "line13-ac10-queue",
						fencingToken,
						binding: currentBinding,
						requiredCapabilities: [],
					});
					assert.equal(
						dispatched.ok,
						true,
						"expected package-root Scheduler agent dispatch to assemble and execute one AgentInstance",
					);
					if (!dispatched.ok) return;
					assert.equal(
						dispatched.value.attempt.agentInstanceId,
						dispatched.value.receipt.provenance.correlation?.agentInstanceId,
						"expected one AgentInstance identity across the Attempt and execution correlation",
					);
					assert.ok(
						dispatched.value.attempt.agentInstanceId,
						"expected Scheduler agent dispatch to retain a non-empty AgentInstance identity",
					);
				},
				cleanup: async ({ controller, provider }) => {
					controller.dispose();
					await provider.dispose();
				},
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-11",
			fullTestName: "Line 13 AC-11 admits atomically at maxConcurrency one",
			scenario: {
				fixture: capacityFixture,
				setup: prepareCapacityFixture,
				assertion: async ({ currentBinding, registry }) => {
					const attempts = await Promise.all(
						["line13-ac11-queue-a", "line13-ac11-queue-b"].map((queueEntryId) =>
							registry.select({
								queueEntry: queueEntry(queueEntryId),
								requiredCapabilities: [CAPABILITY],
								sessionId: SESSION_ID,
								decidedAt: NOW,
								exactRequirements: schedulerExactRequirements(
									currentBinding,
									`line13-ac11-attempt-${queueEntryId}`,
								),
							}),
						),
					);
					assert.equal(
						attempts.filter((attempt) => attempt.ok).length,
						1,
						"expected maxConcurrency one admission to accept exactly one concurrent attempt",
					);
				},
				cleanup: async ({ reservationStore }) => reservationStore.release(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-12",
			fullTestName: "Line 13 AC-12 releases Scheduler quota when the attempt runner throws",
			scenario: {
				fixture: quotaThrowFixture,
				assertion: async ({ provider, attempt, correlation, reserved, settled }) => {
					const executed = await provider.runAttempt(attempt, { correlation });
					assert.equal(executed.ok, false, "expected the planned Scheduler runner crash to fail execution");
					assert.equal(reserved.count, 1, "expected one Scheduler quota reservation");
					assert.equal(settled.count, 1, "expected Scheduler quota reservation release after runner throw");
				},
			},
		}),
		ac15,
		defineLine13ResolvedCase({
			ac: "AC-13",
			fullTestName: "Line 13 AC-13 exposes one canonical Session authority from package-root composition",
			scenario: {
				fixture: productAuthorityFixture,
				setup: prepareProductAuthorityFixture,
				assertion: ({ result }) => {
					assert.equal(
						"sessionManager" in result.session,
						false,
						"expected package-root AgentSession to hide legacy SessionManager write authority",
					);
				},
				cleanup: async ({ tempDir, result, unregisterFaux }) => {
					result.session.dispose();
					await result.session.waitForDispose();
					unregisterFaux();
					rmSync(tempDir, { recursive: true, force: true });
				},
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-14",
			fullTestName: "Line 13 AC-14 removes version-suffixed business exports and aliases from public roots",
			scenario: {
				fixture: currentVersionedPublicExports,
				assertion: (versionedExports) => {
					assert.equal(
						versionedExports.length,
						0,
						`expected public roots to expose no version-suffixed business declarations or aliases: ${versionedExports.join(", ")}`,
					);
				},
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-16",
			fullTestName: "Line 13 AC-16 exposes only old-or-new settings auth trust and identity state",
			scenario: {
				fixture: atomicControlStateFixture,
				setup: prepareAtomicControlStateFixture,
				assertion: ({ mutatedCommittedFiles }) => {
					assert.equal(
						mutatedCommittedFiles.length,
						0,
						"expected control-state writes to replace committed files atomically",
					);
				},
				cleanup: ({ tempDir }) => {
					rmSync(tempDir, { recursive: true, force: true });
				},
			},
		}),
	],
});
