import assert from "node:assert/strict";
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
	SessionLedgerV1,
	createAttempt,
	createBindingEpoch,
	createExecutionCorrelation,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBindingV1,
	type AttemptReceiptV1,
	type AttemptV1,
	type BudgetUsageV1,
	type DispatchV1,
	type FoundationProviderCapabilityV1,
	type FoundationProviderExecutionOptionsV1,
	type ModelProfileV1,
	type QuotaAttributionV1,
	type QuotaProvider,
	type QuotaReservationV1,
	type RevisionReferenceV1,
	type TaskEnvelopeV1,
	type TaskExecutorAttemptContextV1,
	type TaskExecutorProvider,
	validateAttemptReceiptForProviderV1,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from "@aos-agent/ai/compat";
import ts from "typescript";
import {
	createAgentSession,
	createExternalAgentAdapterRegistry,
	DefaultResourceLoader,
	externalAgentCapabilityError,
	ModelRuntime,
	ProjectTrustStore,
	SchedulerDispatchController,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	SchedulerQueueStore,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
	type ExternalAgentAdapter,
	type ExternalAgentCapabilitySnapshot,
} from "../../src/index.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	CapabilityPublicIdentity,
	getCapabilityPublicIdentityPath,
} from "../../src/core/capability-public-identity.ts";
import { SCHEDULER_IN_PROCESS_CAPABILITY_ID } from "../../src/core/scheduler-executors.ts";
import type {
	SchedulerExecutorEntryV1,
	SchedulerQueueEntryV1,
} from "../../src/core/scheduler.ts";
import { SessionManagerStorage } from "../../src/core/session-manager-storage.ts";
import { defineLine13KnownGapCase, defineLine13KnownGapCaseShard } from "../support/line13-known-gaps.ts";
import { LINE13_T0_PUBLIC_ROOTS, line13RepoRoot } from "../support/line13-t0-baseline-inventory.ts";

const BASE_SHA = "db279303b9e894b58acea165ab44f74bfdf0cddb" as const;
const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:01:00.000Z";
const SESSION_ID = "line13-ac09-session";
const TASK_ID = "line13-ac09-task";
const OWNER_ID = "line13-ac09-owner";
const CAPABILITY: FoundationProviderCapabilityV1 = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function taskEnvelope(): TaskEnvelopeV1 {
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

function modelProfile(): ModelProfileV1 {
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

function immutableFact(type: string, id: string): RevisionReferenceV1 {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(): AgentBindingV1 {
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

async function seedBindingFacts(session: Session, value: AgentBindingV1): Promise<void> {
	const ledger = new SessionLedgerV1(session, { ownerId: `${OWNER_ID}-seed` });
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

async function registerExecutor(
	registry: SchedulerExecutorRegistry,
	provider: SchedulerInProcessTaskExecutorProvider,
	maxConcurrency = 1,
): Promise<void> {
	const registered = await registry.register({
		entry: executorEntry(provider),
		provider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency,
	});
	if (!registered.ok) throw registered.error;
}

interface SelectionReplayFixture {
	readonly session: Session;
	readonly currentBinding: AgentBindingV1;
	reopenedController?: SchedulerDispatchController;
	request?: {
		readonly queueEntryId: string;
		readonly fencingToken: string;
		readonly binding: AgentBindingV1;
	};
}

async function prepareSelectionReplayFixture(fixture: SelectionReplayFixture): Promise<void> {
	await seedBindingFacts(fixture.session, fixture.currentBinding);
	const queue = new SchedulerQueueStore({
		ledger: fixture.session,
		sessionId: SESSION_ID,
		ownerId: OWNER_ID,
		now: () => NOW,
	});
	const enqueued = await queue.enqueue(queueEntry());
	if (!enqueued.ok) throw enqueued.error;
	const claimed = await queue.claim({
		queueEntryId: "line13-ac09-queue",
		ownerId: OWNER_ID,
		claimId: "line13-ac09-claim",
		fencingToken: "line13-ac09-fence",
	});
	if (!claimed.ok) throw claimed.error;
	const request = {
		queueEntryId: "line13-ac09-queue",
		fencingToken: claimed.value.claim.fencingToken,
		binding: fixture.currentBinding,
	};
	const firstRegistry = new SchedulerExecutorRegistry();
	await registerExecutor(
		firstRegistry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.a", now: () => NOW }),
	);
	const firstController = new SchedulerDispatchController({
		session: fixture.session,
		queue,
		registry: firstRegistry,
		sessionId: SESSION_ID,
		ownerId: OWNER_ID,
		now: () => NOW,
	});
	const first = await firstController.dispatchClaimed(request);
	firstController.dispose();
	if (first.ok || first.error.code !== "scheduler_executor_unavailable") {
		throw new Error("Selection replay fixture did not reach the intended pre-execution crash boundary");
	}

	const reopenedQueue = new SchedulerQueueStore({
		ledger: fixture.session,
		sessionId: SESSION_ID,
		ownerId: OWNER_ID,
		now: () => LATER,
	});
	const reopenedRegistry = new SchedulerExecutorRegistry();
	await registerExecutor(
		reopenedRegistry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.b", now: () => LATER }),
	);
	fixture.reopenedController = new SchedulerDispatchController({
		session: fixture.session,
		queue: reopenedQueue,
		registry: reopenedRegistry,
		sessionId: SESSION_ID,
		ownerId: OWNER_ID,
		now: () => LATER,
	});
	fixture.request = request;
}

class Line13AgentTaskExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "line13.native-agent";
	readonly providerClass = "agent" as const;

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return [];
	}

	async createAttempt(
		dispatch: DispatchV1,
		_binding: AgentBindingV1,
		context?: TaskExecutorAttemptContextV1,
	) {
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

	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
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
		const receipt: AttemptReceiptV1 = {
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
		return validateAttemptReceiptForProviderV1(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}

	async cancelAttempt(_attemptId: string) {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

interface AgentDispatchFixture {
	readonly session: Session;
	readonly queue: SchedulerQueueStore;
	readonly registry: SchedulerExecutorRegistry;
	readonly controller: SchedulerDispatchController;
	readonly provider: Line13AgentTaskExecutor;
	readonly currentBinding: AgentBindingV1;
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
			now: () => NOW,
		}),
		provider: new Line13AgentTaskExecutor(),
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
	readonly registry: SchedulerExecutorRegistry;
}

async function prepareCapacityFixture(fixture: CapacityFixture): Promise<void> {
	await registerExecutor(
		fixture.registry,
		new SchedulerInProcessTaskExecutorProvider({ providerId: "line13.scheduler.capacity", now: () => NOW }),
		1,
	);
}

interface QuotaThrowFixture {
	readonly provider: SchedulerInProcessTaskExecutorProvider;
	readonly attempt: AttemptV1;
	readonly correlation: ReturnType<typeof createExecutionCorrelation>;
	readonly settled: { count: number };
}

function quotaThrowFixture(): QuotaThrowFixture {
	const settled = { count: 0 };
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: "line13.scheduler.quota",
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution: QuotaAttributionV1, budget: QuotaReservationV1["budget"]) =>
			Result.ok({
				schemaVersion: 1,
				reservationId: "line13-ac12-reservation",
				attribution,
				budget,
				grantedAt: NOW,
			}),
		settle: async (_reservation: QuotaReservationV1, usage: BudgetUsageV1) => {
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
			sessionManager: SessionManager.inMemory(tempDir),
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
	const durableSession = new Session(new SessionManagerStorage(fixture.result.session.sessionManager));
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
		if (/V\d+$/.test(aliased.name)) return aliased.name;
	}
	for (const declaration of symbol.declarations ?? []) {
		const target = declarationVersionTarget(declaration);
		if (target !== undefined && /V\d+$/.test(target)) return target;
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
			if (/V\d+$/.test(symbol.name) || versionedTarget(checker, symbol) !== undefined) {
				found.push(`${publicRoot.packageName}:${publicRoot.specifier}:${symbol.name}`);
			}
		}
	}
	cachedVersionedPublicExports = Object.freeze(found.sort((left, right) => left.localeCompare(right)));
	return cachedVersionedPublicExports;
}

interface ExternalReadinessFixture {
	readonly registry: ReturnType<typeof createExternalAgentAdapterRegistry>;
	readonly calls: { probe: number; prepare: number; start: number };
}

function externalReadinessFixture(): ExternalReadinessFixture {
	const calls = { probe: 0, prepare: 0, start: 0 };
	const adapter: ExternalAgentAdapter = {
		id: "line13-readiness-adapter",
		probe: async (target): Promise<ExternalAgentCapabilitySnapshot> => {
			calls.probe += 1;
			return {
				schemaVersion: 1,
				adapterId: "line13-readiness-adapter",
				targetId: target.targetId,
				protocol: { name: "line13-protocol", version: "1" },
				status: "unavailable",
				capabilities: {
					start: false,
					events: "none",
					cancel: "none",
					receipt: "none",
					resume: false,
					artifacts: false,
					toolGateway: false,
				},
				reasonCode: "driver_not_ready",
				observedAt: NOW,
			};
		},
		prepare: async () => {
			calls.prepare += 1;
			throw new Error("prepare must not run during readiness probing");
		},
		start: async () => {
			calls.start += 1;
			throw new Error("start must not run during readiness probing");
		},
	};
	const registry = createExternalAgentAdapterRegistry();
	registry.register(adapter, {
		displayName: "Line 13 readiness adapter",
		version: "1",
		targets: ["line13-target"],
	});
	return { registry, calls };
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
	const identity = CapabilityPublicIdentity.loadSync(identityAgentDir);
	if (identity.derive("line13", "control-state").length !== 43) {
		throw new Error("Capability identity fixture did not create a valid durable identity");
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

export const line13KnownGapCasesAc09Ac16 = defineLine13KnownGapCaseShard({
	schemaVersion: 1,
	shardId: "ac-09-16",
	complete: true,
	cases: [
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-09",
				fullTestName: "Line 13 AC-09 replays the durable SelectionFact after Scheduler Host restart",
				baseSha: BASE_SHA,
				ownerStage: "T9b",
				mode: "fails",
				expectedFailure: {
					reason: "scheduler.selection_fact_not_durable",
					fingerprint: "sha256:ffd25d6eb9c99a48a810c48f983dbc10adc08a69f5d837531010f691d96a17d5",
				},
			},
			scenario: {
				fixture: (): SelectionReplayFixture => ({
					session: new Session(new InMemorySessionStorage({ id: SESSION_ID, createdAt: 1 })),
					currentBinding: binding(),
				}),
				setup: prepareSelectionReplayFixture,
				assertion: async (fixture) => {
					if (fixture.reopenedController === undefined || fixture.request === undefined) {
						throw new Error("Selection replay fixture is incomplete");
					}
					const replayed = await fixture.reopenedController.dispatchClaimed(fixture.request);
					assert.equal(replayed.ok, false, "expected the restarted Scheduler to reject an unavailable durable selection");
					if (replayed.ok) return;
					assert.equal(
						replayed.error.code,
						"scheduler_executor_unavailable",
						"expected the restarted Scheduler to replay the original durable SelectionFact",
					);
				},
				cleanup: (fixture) => {
					fixture.reopenedController?.dispose();
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-10",
				fullTestName: "Line 13 AC-10 assembles one AgentInstance across Dispatch BindingEpoch and correlation",
				baseSha: BASE_SHA,
				ownerStage: "T9b",
				mode: "fails",
				expectedFailure: {
					reason: "scheduler.agent_instance_not_assembled",
					fingerprint: "sha256:c921f9a15d36a70eeb216a99d362e49551e6935a2430dd51d13f5888de6446d5",
				},
			},
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
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-11",
				fullTestName: "Line 13 AC-11 admits atomically at maxConcurrency one",
				baseSha: BASE_SHA,
				ownerStage: "T9b",
				mode: "fails",
				expectedFailure: {
					reason: "scheduler.capacity_not_atomic",
					fingerprint: "sha256:89a016104a76c004248bac76b4ad4cd7e4fce20ca6369b6112ea93b6b0081838",
				},
			},
			scenario: {
				fixture: () => ({ registry: new SchedulerExecutorRegistry() }),
				setup: prepareCapacityFixture,
				assertion: async ({ registry }) => {
					const attempts = await Promise.all(
						["line13-ac11-queue-a", "line13-ac11-queue-b"].map((queueEntryId) =>
							registry.select({
								queueEntry: queueEntry(queueEntryId),
								requiredCapabilities: [CAPABILITY],
								sessionId: SESSION_ID,
								decidedAt: NOW,
							}),
						),
					);
					assert.equal(
						attempts.filter((attempt) => attempt.ok).length,
						1,
						"expected maxConcurrency one admission to accept exactly one concurrent attempt",
					);
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-12",
				fullTestName: "Line 13 AC-12 releases Scheduler quota when the attempt runner throws",
				baseSha: BASE_SHA,
				ownerStage: "T9b",
				mode: "fails",
				expectedFailure: {
					reason: "scheduler.quota_not_released",
					fingerprint: "sha256:8058b976471215a8c56d7d668daf1029fc5a10a3a2f9fdf6a4ff3ddcd0267d67",
				},
			},
			scenario: {
				fixture: quotaThrowFixture,
				assertion: async ({ provider, attempt, correlation, settled }) => {
					let runnerThrew = false;
					try {
						await provider.runAttempt(attempt, { correlation });
					} catch (error) {
						runnerThrew = error instanceof Error && error.message === "planned runner crash";
					}
					assert.equal(runnerThrew, true, "expected the planned Scheduler runner crash");
					assert.equal(settled.count, 1, "expected Scheduler quota reservation release after runner throw");
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-13",
				fullTestName: "Line 13 AC-13 exposes one canonical Session authority from package-root composition",
				baseSha: BASE_SHA,
				ownerStage: "T3a",
				mode: "fails",
				expectedFailure: {
					reason: "session.legacy_writer_public",
					fingerprint: "sha256:90826c548cd59ec7e46004bb07824b015315f6c94b44a5f8b8a417ef9ce58380",
				},
			},
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
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-14",
				fullTestName: "Line 13 AC-14 removes version-suffixed business exports and aliases from public roots",
				baseSha: BASE_SHA,
				ownerStage: "T1a",
				mode: "fails",
				expectedFailure: {
					reason: "public.version_suffix_exported",
					fingerprint: "sha256:bb1618b6e76a7d139b5ad09d68e4303bda0a4e6fa40c509bf824416949231b67",
				},
			},
			scenario: {
				fixture: currentVersionedPublicExports,
				assertion: (versionedExports) => {
					assert.equal(
						versionedExports.length,
						0,
						"expected public roots to expose no version-suffixed business declarations or aliases",
					);
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-15",
				fullTestName: "Line 13 AC-15 keeps metadata passive and exposes exact side-effect-free readiness diagnostics",
				baseSha: BASE_SHA,
				ownerStage: "T9a",
				mode: "fails",
				expectedFailure: {
					reason: "external.readiness_api_missing",
					fingerprint: "sha256:95fdeb1ac1b991e6876a509559f265a2cd67d19c41aa5008b2885a2dcab1551e",
				},
			},
			scenario: {
				fixture: externalReadinessFixture,
				assertion: async ({ registry, calls }) => {
					assert.deepEqual(registry.list(), [
						{
							adapterId: "line13-readiness-adapter",
							displayName: "Line 13 readiness adapter",
							version: "1",
						},
					]);
					const resolved = registry.resolve({
						adapterId: "line13-readiness-adapter",
						targetId: "line13-target",
					});
					assert.deepEqual(calls, { probe: 0, prepare: 0, start: 0 });
					const snapshot = await resolved.adapter.probe(resolved.target, {
						signal: new AbortController().signal,
						deadlineAt: LATER,
					});
					assert.equal(externalAgentCapabilityError(snapshot), "external_agent_probe_failed");
					assert.deepEqual(calls, { probe: 1, prepare: 0, start: 0 });
					assert.equal(
						"probe" in registry,
						true,
						"expected the trusted External registry to expose bounded readiness diagnostics",
					);
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-16",
				fullTestName: "Line 13 AC-16 exposes only old-or-new settings auth trust and identity state",
				baseSha: BASE_SHA,
				ownerStage: "T3b",
				mode: "fails",
				expectedFailure: {
					reason: "control_state.write_not_atomic",
					fingerprint: "sha256:7c3091907617951330a5f266c12154373752093396a02ddd9490dbadc6db3f98",
				},
			},
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
