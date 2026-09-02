import { describe, expect, it, vi } from "vitest";
import {
	AgentOperationError,
	FoundationError,
	Result,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type RevisionReference,
	type SessionLedger,
	type TaskEnvelope,
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "../../../agent/src/internal.ts";
import * as packageEntry from "../../src/index.ts";
import {
	DurableExternalAgentConnector,
	externalConnectorAttemptId,
	type ExternalConnectorCredentialRuntime,
	type ExternalConnectorToolGatewayConsumer,
} from "../../src/core/connector/durable-connector.ts";
import type {
	ExternalConnectorDurableStore,
	ExternalConnectorOperation,
	ExternalConnectorOperationStatus,
	ExternalConnectorToolGatewayExecution,
	ExternalConnectorToolGatewayIntent,
	ExternalConnectorToolGatewayTerminal,
} from "../../src/core/connector/operation.ts";
import {
	cloneExternalConnectorOperation,
	externalConnectorToolGatewayExchangeId,
	SessionExternalConnectorDurableStore,
	transitionExternalConnectorOperation,
} from "../../src/core/connector/operation.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMapping,
	type CanonicalExternalConnectorMapping,
} from "../../src/core/connector/session-mapping.ts";
import type { ExternalConnectorSupervisorDeadlineOverrides } from "../../src/core/connector/supervisor.ts";
import {
	decodeRuntimeLimitsOperationNonce,
	encodeRuntimeLimitsOperationNonce,
	type RuntimeLimitsResolutionInput,
	type RuntimeLimitsSnapshot,
	type RuntimeLimitsSource,
} from "../../src/core/runtime/limits.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/connector/vendor/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";
import type { SessionEntry } from "../../src/core/session/manager.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../../src/core/policy/task-credential-provider.ts";
import type {
	TaskCredentialDeliveryReceipt,
	TaskCredentialScope,
} from "../../src/core/policy/task-credential-lease.ts";
import {
	TaskCredentialService,
	type TaskCredentialPreflightResolver,
} from "../../src/core/policy/task-credential-service.ts";
import type { TaskCredentialSession } from "../../src/core/policy/task-credential-store.ts";

const now = "2026-08-27T00:00:00.000Z";
const providerId = "third-party-connector";
const credentialCanary = "external-credential-material-canary";
const task: TaskEnvelope = {
	schemaVersion: 1,
	taskId: "task-external-lifecycle",
	goalId: "goal-external-lifecycle",
	goal: "Exercise durable connector lifecycle",
	workspace: "workspace-ref",
	capabilityRefs: [],
	inputs: [],
	expectedOutputs: [],
	budget: {},
	acceptanceCriteria: [],
	status: "ready",
	createdAt: now,
	updatedAt: now,
};

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-external-lifecycle",
			scope: "project",
			slug: "external-lifecycle",
			name: "External lifecycle",
			description: "External connector lifecycle role",
			revision: 1,
			persona: "Execute externally.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-external", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => now,
	});
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-external",
		provider: "host-model",
		model: "model-1",
		budget: {},
		revision: 1,
		createdAt: now,
	});
	const resolved = resolveAgentBinding({
		task,
		roleRevision: role,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "external-binding-fact"),
		capabilityRevision: immutableFact("capability_binding", "capability-fact"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-binding-fact"),
		policyRevision: immutableFact("policy_binding", "policy-fact"),
		newBindingId: "binding-external-lifecycle",
		now: () => now,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function capability(resume = true, revision = 1, toolGateway = false): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision,
		protocol: { name: "third-party-protocol", version: "1" },
		modelAccess: "agent_owned",
		resume,
		toolGateway,
		artifacts: true,
		images: false,
	});
}

const dispatch: Dispatch = {
	schemaVersion: 1,
	dispatchId: "dispatch-external-lifecycle",
	taskId: task.taskId,
	bindingId: "binding-external-lifecycle",
	taskExecutorProviderId: providerId,
	status: "pending",
	createdAt: now,
};

const correlation: ExecutionCorrelation = {
	sessionId: "session-external-lifecycle",
	laneId: "main",
	revision: 1,
};

function terminalEvidence(
	status: "succeeded" | "cancelled" = "succeeded",
	overrides: Partial<ExternalConnectorTerminalEvidence> = {},
): ExternalConnectorTerminalEvidence {
	return {
		externalSessionId: "external-session-1",
		externalTurnId: "external-turn-1",
		operationNonce: "operation-nonce-1",
		status,
		artifacts: [],
		sideEffectState: "none",
		producedAt: now,
		...overrides,
	};
}

class FakeStore implements ExternalConnectorDurableStore {
	readonly attempts = new Map<string, Attempt>();
	readonly bindings = new Map<string, AgentBinding>();
	readonly operations = new Map<string, ExternalConnectorOperation>();
	readonly mappings = new Map<string, CanonicalExternalConnectorMapping>();
	readonly receipts = new Map<string, AttemptReceipt>();
	readonly toolGatewayExecutions = new Map<string, ExternalConnectorToolGatewayExecution>();
	readonly operationHistory: ExternalConnectorOperationStatus[] = [];
	reads = 0;
	mappingWrites = 0;
	receiptWrites = 0;
	failOperationStatusOnce: ExternalConnectorOperationStatus | undefined;
	mappingWriteGate: Promise<void> | undefined;
	onMappingWrite: (() => void) | undefined;

	async readAttempt(attemptId: string): Promise<Attempt | undefined> {
		this.reads++;
		return this.attempts.get(attemptId);
	}

	async readBinding(bindingId: string): Promise<AgentBinding | undefined> {
		this.reads++;
		return this.bindings.get(bindingId);
	}

	async readExecutionInput(taskId: string) {
		return {
			schemaVersion: 1 as const,
			taskId,
			requestFingerprint: `sha256:${"1".repeat(64)}` as const,
			input: { schemaVersion: 1 as const, text: "fixture", artifacts: [] },
		};
	}

	async readOperation(attemptId: string): Promise<ExternalConnectorOperation | undefined> {
		this.reads++;
		return this.operations.get(attemptId);
	}

	async writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation> {
		if (this.failOperationStatusOnce === operation.status) {
			this.failOperationStatusOnce = undefined;
			throw new FoundationError("session_ledger_storage", "Injected durable write failure");
		}
		this.operations.set(operation.attemptId, operation);
		this.operationHistory.push(operation.status);
		return operation;
	}

	async readMapping(attemptId: string): Promise<CanonicalExternalConnectorMapping | undefined> {
		this.reads++;
		return this.mappings.get(attemptId);
	}

	async writeMapping(mapping: CanonicalExternalConnectorMapping): Promise<CanonicalExternalConnectorMapping> {
		this.onMappingWrite?.();
		if (this.mappingWriteGate !== undefined) await this.mappingWriteGate;
		const existing = this.mappings.get(mapping.attemptId);
		if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(mapping)) {
			throw new FoundationError("session_ledger_conflict", "Injected mapping conflict");
		}
		if (existing === undefined) this.mappingWrites++;
		this.mappings.set(mapping.attemptId, mapping);
		return mapping;
	}

	async readReceipt(attemptId: string): Promise<AttemptReceipt | undefined> {
		this.reads++;
		return this.receipts.get(attemptId);
	}

	async writeReceipt(receipt: AttemptReceipt): Promise<AttemptReceipt> {
		const existing = this.receipts.get(receipt.attemptId);
		if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(receipt)) {
			throw new FoundationError("session_ledger_conflict", "Injected receipt conflict");
		}
		if (existing === undefined) this.receiptWrites++;
		this.receipts.set(receipt.attemptId, receipt);
		return receipt;
	}

	async readToolGatewayExecution(
		attemptId: string,
		toolCallId: string,
	): Promise<ExternalConnectorToolGatewayExecution | undefined> {
		return this.toolGatewayExecutions.get(externalConnectorToolGatewayExchangeId(attemptId, toolCallId));
	}

	async listToolGatewayExecutions(attemptId: string): Promise<readonly ExternalConnectorToolGatewayExecution[]> {
		return [...this.toolGatewayExecutions.values()].filter((execution) => execution.intent.attemptId === attemptId);
	}

	async writeToolGatewayIntent(value: ExternalConnectorToolGatewayIntent) {
		const current = this.toolGatewayExecutions.get(value.id);
		if (current !== undefined) return { intent: current.intent, claimed: false };
		this.toolGatewayExecutions.set(value.id, { intent: value });
		return { intent: value, claimed: true };
	}

	async writeToolGatewayTerminal(value: ExternalConnectorToolGatewayTerminal) {
		const current = this.toolGatewayExecutions.get(value.id);
		if (current === undefined) throw new FoundationError("session_ledger_missing_intent", "Missing test intent");
		this.toolGatewayExecutions.set(value.id, { intent: current.intent, terminal: value });
		return value;
	}
}

class OperationLedger {
	payload: unknown;

	async get(_objectType: string, objectId: string): Promise<unknown> {
		return this.payload === undefined ? undefined : { kind: "fact", objectId, payload: this.payload };
	}

	async appendFact<TPayload>(
		_objectType: string,
		_objectId: string,
		payload: TPayload,
	): Promise<{ readonly payload: TPayload }> {
		this.payload = payload;
		return { payload };
	}
}

class FakeDriver implements ExternalConnectorVendorDriver {
	readonly calls = {
		spawn: 0,
		events: 0,
		connect: 0,
		lookup: 0,
		read: 0,
		write: 0,
		heartbeat: 0,
		cancel: 0,
		dispose: 0,
	};
	readonly spawnStates: Array<ExternalConnectorOperationStatus | undefined> = [];
	readonly spawnRequests: ExternalConnectorDriverSpawnRequest[] = [];
	readonly writes: ExternalConnectorDriverWriteRequest[] = [];
	store: FakeStore | undefined;
	spawnFailure = false;
	spawnGate: Promise<void> | undefined;
	onSpawn: (() => void) | undefined;
	readFailure = false;
	connectFailure = false;
	readHangs = false;
	readAbortObserved = false;
	eventNextHangs = false;
	disposeHangs = false;
	disposeAbortObserved = false;
	eventValues: FoundationJsonValue[] = [];
	evidence: ExternalConnectorTerminalEvidence = terminalEvidence();
	cancelEvidence: ExternalConnectorTerminalEvidence | undefined = terminalEvidence("cancelled");
	spawnHandle: unknown;
	connectHandle: unknown;
	lookupResult: unknown = { status: "terminal", evidence: terminalEvidence() };

	readonly handle: ExternalConnectorDriverHandle = {
		externalSessionId: "external-session-1",
		externalTurnId: "external-turn-1",
		supervisorRef: "supervisor-ref-1",
		operationNonce: "operation-nonce-1",
	};

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.calls.spawn++;
		this.spawnStates.push(this.store?.operations.get(request.attempt.attemptId)?.status);
		this.spawnRequests.push(request);
		this.onSpawn?.();
		if (this.spawnGate !== undefined) await this.spawnGate;
		if (this.spawnFailure) throw new Error("injected spawn failure");
		return (this.spawnHandle ?? {
			...this.handle,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		}) as ExternalConnectorDriverHandle;
	}

	events(): AsyncIterable<FoundationJsonValue> {
		this.calls.events++;
		let index = 0;
		return {
			[Symbol.asyncIterator]: () => ({
				next: async () =>
					this.eventNextHangs
						? new Promise<never>(() => undefined)
						: index < this.eventValues.length
							? { done: false, value: this.eventValues[index++] }
							: { done: true, value: undefined },
			}),
		};
	}

	async connect(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverHandle> {
		this.calls.connect++;
		if (this.connectFailure) throw new Error("injected connect failure");
		return (this.connectHandle ?? {
			...this.handle,
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		}) as ExternalConnectorDriverHandle;
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		this.calls.lookup++;
		return this.lookupResult as ExternalConnectorDriverLookup;
	}

	async read(
		_handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence> {
		this.calls.read++;
		if (this.readFailure) throw new Error("injected read failure");
		if (this.readHangs) {
			await new Promise<never>((_resolve, reject) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						this.readAbortObserved = true;
						reject(new Error("read aborted"));
					},
					{ once: true },
				);
			});
		}
		return this.evidence;
	}

	async write(_handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.calls.write++;
		this.writes.push(request);
	}

	async heartbeat(): Promise<void> {
		this.calls.heartbeat++;
	}

	async cancel(): Promise<ExternalConnectorTerminalEvidence | undefined> {
		this.calls.cancel++;
		return this.cancelEvidence;
	}

	async dispose(options?: { readonly signal?: AbortSignal }): Promise<void> {
		this.calls.dispose++;
		if (this.disposeHangs) {
			await new Promise<void>(() => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						this.disposeAbortObserved = true;
					},
					{ once: true },
				);
			});
		}
	}
}

class CredentialSession implements TaskCredentialSession {
	readonly entries: SessionEntry[] = [];

	getSessionId(): string {
		return "session-external-credential";
	}

	getEntries(): ReadonlyArray<SessionEntry> {
		return this.entries;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry = {
			id: `credential-entry-${this.entries.length + 1}`,
			type: "custom",
			customType,
			data,
		} as SessionEntry;
		this.entries.push(entry);
		return entry.id;
	}
}

class ExternalCredentialTarget {
	readonly projectedMaterials: string[] = [];
	readonly renewals: TaskCredentialTargetRenewRequest[] = [];
	readonly revocations: TaskCredentialTargetRevokeRequest[] = [];
	revokeUnknown = false;
	operationStatus: (() => ExternalConnectorOperationStatus | undefined) | undefined;
	onProject: (() => void) | undefined;
	statusAtProjection: ExternalConnectorOperationStatus | undefined;

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		return {
			schemaVersion: 1,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
	}

	project(request: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly scopes: ReadonlyArray<TaskCredentialScope>;
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
	}): TaskCredentialDeliveryReceipt {
		this.statusAtProjection = this.operationStatus?.();
		this.onProject?.();
		this.projectedMaterials.push(...Object.values(request.material));
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			...(request.targetId === undefined ? {} : { targetId: request.targetId }),
			status: "succeeded",
			recordedAt: now,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		this.renewals.push(request);
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: now,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		this.revocations.push(request);
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: this.revokeUnknown ? "revocation_unknown" : "revoked",
			recordedAt: now,
		};
	}
}

interface CredentialHarness {
	readonly session: CredentialSession;
	readonly target: ExternalCredentialTarget;
	readonly provider: TaskCredentialTestProvider;
	readonly clock: { nowMs: number };
	service: TaskCredentialService;
	runtime: ExternalConnectorCredentialRuntime;
	reload(): void;
}

function credentialPreflight(): TaskCredentialPreflightResolver {
	return { resolve: (input) => ({ allowed: true, boundedTtlMs: input.requestedTtlMs }) };
}

function createCredentialHarness(): CredentialHarness {
	const session = new CredentialSession();
	const target = new ExternalCredentialTarget();
	const clock = { nowMs: Date.parse(now) };
	const provider = createTaskCredentialTestProvider({
		materials: { external_registry: credentialCanary },
		target,
		now: () => new Date(clock.nowMs).toISOString(),
	});
	const createService = (): TaskCredentialService => new TaskCredentialService({
		session,
		provider,
		preflight: credentialPreflight(),
		policyMaxTtlMs: 300_000,
		now: () => new Date(clock.nowMs).toISOString(),
	});
	const createRuntime = (service: TaskCredentialService): ExternalConnectorCredentialRuntime => ({
		service,
		resolveIssueContext: (attempt, selectedBinding) => ({
			taskId: attempt.taskId,
			graphRevision: 1,
			nodeId: "node-external-credential",
			runId: "run-external-credential",
			capabilityBindingId: selectedBinding.capabilityRevision.id,
			policyBindingId: selectedBinding.policyRevision.id,
			targetId: "external-target-1",
			targetKind: "external_connector",
			scopes: [{
				credentialName: "external_registry",
				purpose: "read",
				operations: ["read"],
				targetKinds: ["external_connector"],
			}],
			requestedTtlMs: 60_000,
			clientRequestId: "connector-overrides-this-request",
			nodeAttached: true,
		}),
	});
	const service = createService();
	const harness: CredentialHarness = {
		session,
		target,
		provider,
		clock,
		service,
		runtime: createRuntime(service),
		reload: () => {
			const reloaded = createService();
			harness.service = reloaded;
			harness.runtime = createRuntime(reloaded);
		},
	};
	return harness;
}

interface Fixture {
	readonly binding: AgentBinding;
	readonly store: FakeStore;
	readonly driver: FakeDriver;
	readonly connector: DurableExternalAgentConnector;
	readonly attempt: Attempt;
	readonly snapshot: ConnectorCapabilitySnapshot;
	readonly runtimeLimits: RuntimeLimitsSnapshot;
	readonly supervision: ReturnType<typeof createExternalConnectorTestSupervision>;
}

async function fixture(
	options: {
		resume?: boolean;
		capabilityRevision?: number;
		toolGateway?: boolean;
		runtimeLimits?: RuntimeLimitsSource;
		credential?: ExternalConnectorCredentialRuntime;
		supervisionDeadlines?: ExternalConnectorSupervisorDeadlineOverrides;
	} = {},
): Promise<Fixture> {
	const resolvedBinding = binding();
	const snapshot = capability(options.resume ?? true, options.capabilityRevision ?? 1, options.toolGateway ?? false);
	const store = new FakeStore();
	store.bindings.set(resolvedBinding.bindingId, resolvedBinding);
	const driver = new FakeDriver();
	driver.store = store;
	const supervision = createExternalConnectorTestSupervision(options.supervisionDeadlines);
	const connector = new DurableExternalAgentConnector({
		providerId,
		capability: snapshot,
		capabilityProbe: async () => Result.ok(snapshot),
		store,
		driver,
		supervision: supervision.options,
		...(options.runtimeLimits === undefined ? {} : { runtimeLimits: options.runtimeLimits }),
		...(options.credential === undefined ? {} : { credential: options.credential }),
		now: () => now,
		operationNonce: () => "operation-nonce-1",
	});
	const attemptId = externalConnectorAttemptId(providerId, dispatch.dispatchId);
	const epoch = createBindingEpoch({
		bindingEpochId: "binding-epoch-external-0",
		taskId: task.taskId,
		attemptId,
		bindingId: resolvedBinding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: dispatch.dispatchId,
		now: () => now,
	});
	if (!epoch.ok) throw epoch.error;
	const created = await connector.createAttempt(dispatch, resolvedBinding, { initialBindingEpoch: epoch.value });
	if (!created.ok) throw created.error;
	const runtimeLimits = await connector.runtimeLimitsForAttempt(created.value.attemptId);
	if (runtimeLimits === undefined) throw new Error("fixture RuntimeLimits were not frozen");
	store.reads = 0;
	return {
		binding: resolvedBinding,
		store,
		driver,
		connector,
		attempt: created.value,
		snapshot,
		runtimeLimits,
		supervision,
	};
}

function restartedConnector(
	value: Fixture,
	runtimeLimits?: RuntimeLimitsSource,
	credential?: ExternalConnectorCredentialRuntime,
): {
	readonly connector: DurableExternalAgentConnector;
	readonly driver: FakeDriver;
} {
	const driver = new FakeDriver();
	driver.store = value.store;
	return {
		driver,
		connector: new DurableExternalAgentConnector({
			providerId,
			capability: value.snapshot,
			capabilityProbe: async () => Result.ok(value.snapshot),
			store: value.store,
			driver,
			supervision: value.supervision.options,
			...(runtimeLimits === undefined ? {} : { runtimeLimits }),
			...(credential === undefined ? {} : { credential }),
			now: () => now,
			operationNonce: () => "restart-must-not-create-an-operation",
		}),
	};
}

function operationFor(
	value: Fixture,
	status: ExternalConnectorOperationStatus,
	capabilitySnapshot: ConnectorCapabilitySnapshot = value.snapshot,
): ExternalConnectorOperation {
	const revisions: Record<ExternalConnectorOperationStatus, number> = {
		prepared: 1,
		start_intent: 2,
		running: 3,
		cancelling: 4,
		terminal: 4,
		reconcile_required: 4,
	};
	return {
		schemaVersion: 1,
		providerId,
		attemptId: value.attempt.attemptId,
		bindingId: value.attempt.bindingId,
		bindingEpochId: value.attempt.bindingEpochIds[0]!,
		bindingDigest: value.binding.fingerprint,
		bindingRevision: value.binding.contextRevision.revision,
		capabilityDigest: capabilitySnapshot.digest,
		capabilityRevision: capabilitySnapshot.revision,
		operationNonce: encodeRuntimeLimitsOperationNonce(value.runtimeLimits, "operation-nonce-1"),
		correlation: {
			...correlation,
			taskId: value.attempt.taskId,
			dispatchId: value.attempt.dispatchId,
			attemptId: value.attempt.attemptId,
			bindingId: value.attempt.bindingId,
			bindingEpochId: value.attempt.bindingEpochIds[0]!,
			providerId,
		},
		status,
		revision: revisions[status],
		updatedAt: now,
		...(status === "reconcile_required" ? { reconcileReason: "start_outcome_unknown" as const } : {}),
		...(status === "terminal" ? { receiptId: `attempt_receipt_${value.attempt.attemptId}` } : {}),
	};
}

function mappingFor(value: Fixture): CanonicalExternalConnectorMapping {
	const supervisorRef = `external_supervisor_${fingerprintFoundationValue({
		providerId,
		attemptId: value.attempt.attemptId,
	}).value.slice(0, 32)}`;
	return cloneCanonicalExternalConnectorMapping({
		schemaVersion: 1,
		providerId,
		attemptId: value.attempt.attemptId,
		externalSessionId: "external-session-1",
		externalTurnId: "external-turn-1",
		binding: { digest: value.binding.fingerprint, revision: value.binding.contextRevision.revision },
		capability: { digest: value.snapshot.digest, revision: value.snapshot.revision },
		supervisor: { ref: supervisorRef, nonce: "operation-nonce-1" },
		createdAt: now,
	});
}

async function persistSupervisorIdentity(value: Fixture): Promise<void> {
	const mapping = mappingFor(value);
	const handle = await value.supervision.processController.launch({
		supervisorRef: mapping.supervisor.ref,
		operationNonce: mapping.supervisor.nonce,
		detached: false,
		containment: value.supervision.options.containment,
	});
	await handle.activate();
	value.supervision.processController.launchCalls = 0;
	await value.supervision.privateStateStore.write(value.attempt.attemptId, {
		schemaVersion: 1,
		reference: {
			schemaVersion: 1,
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		},
		detached: false,
		containment: value.supervision.options.containment,
		processIdentity: handle.identity,
	});
}

function receiptFor(value: Fixture, receiptProviderId = providerId): AttemptReceipt {
	const attemptReceiptId = `attempt_receipt_${value.attempt.attemptId}`;
	return {
		schemaVersion: 1,
		attemptReceiptId,
		taskId: value.attempt.taskId,
		dispatchId: value.attempt.dispatchId,
		attemptId: value.attempt.attemptId,
		providerId: receiptProviderId,
		bindingId: value.attempt.bindingId,
		bindingEpochIds: [...value.attempt.bindingEpochIds],
		status: "succeeded",
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "external_connector",
			providerId: receiptProviderId,
			producedAt: now,
			correlation: {
				...operationFor(value, "prepared").correlation,
				providerId: receiptProviderId,
				attemptReceiptId,
			},
		},
		sideEffectState: "none",
	};
}

function persistAttempt(value: Fixture): void {
	value.store.attempts.set(value.attempt.attemptId, value.attempt);
}

async function createAdditionalAttempt(value: Fixture, suffix: string): Promise<Attempt> {
	const nextDispatch: Dispatch = {
		...dispatch,
		dispatchId: `${dispatch.dispatchId}-${suffix}`,
	};
	const attemptId = externalConnectorAttemptId(providerId, nextDispatch.dispatchId);
	const epoch = createBindingEpoch({
		bindingEpochId: `binding-epoch-external-${suffix}`,
		taskId: task.taskId,
		attemptId,
		bindingId: value.binding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: nextDispatch.dispatchId,
		now: () => now,
	});
	if (!epoch.ok) throw epoch.error;
	const created = await value.connector.createAttempt(nextDispatch, value.binding, { initialBindingEpoch: epoch.value });
	if (!created.ok) throw created.error;
	return created.value;
}

function gatewayCorrelation(): ExecutionCorrelation {
	return {
		...correlation,
		runId: "run-external-tool-gateway",
		operationId: "run-external-tool-gateway",
	};
}

function gatewayRequestFor(
	value: Fixture,
	toolCallId: string,
	originalArguments: FoundationJsonValue,
): ToolGatewayRequest {
	return {
		schemaVersion: 1,
		toolCallId,
		toolName: "workspace.read",
		namespace: "workspace",
		originalArguments,
		idempotencyKey: `once-${toolCallId}`,
		context: {
			schemaVersion: 1,
			bindingId: value.attempt.bindingId,
			bindingEpochId: value.attempt.bindingEpochIds[0]!,
			taskId: value.attempt.taskId,
			dispatchId: value.attempt.dispatchId,
			providerId,
			attemptId: value.attempt.attemptId,
			operationId: "run-external-tool-gateway",
		},
	};
}

function scopedConsumer(
	value: Fixture,
	invoke: (
		request: ToolGatewayRequest,
		options?: { readonly signal?: AbortSignal },
	) => ReturnType<ExternalConnectorToolGatewayConsumer>,
): ExternalConnectorToolGatewayConsumer {
	Object.defineProperty(invoke, "scope", {
		value: Object.freeze({
			schemaVersion: 1,
			gatewayId: "test-tool-gateway",
			catalogDigest: fingerprintFoundationValue("test-tool-gateway-catalog"),
			bindingId: value.binding.bindingId,
			capabilityBindingId: value.binding.capabilityRevision.id,
			policyBindingId: value.binding.policyRevision.id,
			policyRevision: value.binding.policyRevision.revision,
			policyBindingDigest: value.binding.policyRevision.fingerprint!,
			mcpSelectionDigest: value.binding.mcpSelection.digest,
			routes: Object.freeze([Object.freeze({
				kind: "local" as const,
				namespace: "workspace",
				toolName: "workspace.read",
				providerId,
				revision: 1,
				operation: { resource: "filesystem.read" as const, effects: ["read" as const] },
			})]),
		}),
	});
	return Object.freeze(invoke) as ExternalConnectorToolGatewayConsumer;
}

function gatewayEventsFor(value: Fixture, requests: readonly ToolGatewayRequest[]): FoundationJsonValue[] {
	return [
		{
			schemaVersion: 1,
			type: "started",
			externalSessionId: value.driver.handle.externalSessionId,
			externalTurnId: value.driver.handle.externalTurnId!,
			producedAt: now,
		},
		...requests.map((request) => ({
			schemaVersion: 1 as const,
			type: "tool_gateway_request" as const,
			externalSessionId: value.driver.handle.externalSessionId,
			externalTurnId: value.driver.handle.externalTurnId!,
			operationNonce: "operation-nonce-1",
			request: request as unknown as FoundationJsonValue,
			producedAt: now,
		})),
	];
}

describe("durable ExternalAgentConnector lifecycle", () => {
	it("keeps createAttempt pure and enforces persist-before-start", async () => {
		const value = await fixture();
		expect(value.store.reads).toBe(0);
		expect(value.store.operationHistory).toEqual([]);
		expect(value.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});

		const rejected = await value.connector.runAttempt(value.attempt, { correlation });
		expect(rejected.ok).toBe(false);
		expect(value.driver.calls.spawn).toBe(0);

		persistAttempt(value);
		const completed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(completed.ok).toBe(true);
		expect(value.driver.spawnStates).toEqual(["start_intent"]);
		expect(value.driver.calls.events).toBe(1);
		expect(value.store.operationHistory).toEqual(["prepared", "start_intent", "running", "terminal"]);
	});

	it("issues after durable start intent and exposes only a safe per-binding lease projection", async () => {
		const credentials = createCredentialHarness();
		const value = await fixture({ credential: credentials.runtime });
		credentials.target.operationStatus = () =>
			value.store.operations.get(value.attempt.attemptId)?.status;
		persistAttempt(value);

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(credentials.target.statusAtProjection).toBe("start_intent");
		expect(credentials.target.projectedMaterials).toEqual([credentialCanary]);
		const driverProjection = value.driver.spawnRequests[0]?.credential;
		expect(driverProjection).toBeDefined();
		expect(Object.keys(driverProjection ?? {}).sort()).toEqual([
			"bindingId",
			"clientRequestId",
			"expiresAt",
			"grantId",
			"leaseId",
			"schemaVersion",
			"scopeDigest",
		]);
		const operation = value.store.operations.get(value.attempt.attemptId);
		expect(operation?.credential).toMatchObject({
			targetId: "external-target-1",
			targetKind: "external_connector",
			projection: driverProjection,
			delivery: { status: "succeeded", targetId: "external-target-1" },
		});
		expect(credentials.target.revocations).toHaveLength(1);
		const leaseId = operation?.credential?.projection.leaseId;
		expect(leaseId === undefined ? undefined : credentials.service.get(leaseId)?.status).toBe("settled");
		const durableTrace = JSON.stringify({
			operation,
			credentialEntries: credentials.session.entries,
			driverProjection,
			result: completed,
		});
		expect(durableTrace).not.toContain(credentialCanary);
		expect(durableTrace).not.toContain("material");

		const replayed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(replayed).toEqual(completed);
		expect(value.driver.calls.spawn).toBe(1);
		expect(credentials.target.revocations).toHaveLength(1);
	});

	it("quarantines an external target when terminal revocation cannot be confirmed", async () => {
		const credentials = createCredentialHarness();
		credentials.target.revokeUnknown = true;
		const value = await fixture({ credential: credentials.runtime });
		persistAttempt(value);

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		const lease = value.store.operations.get(value.attempt.attemptId)?.credential;
		if (lease === undefined) throw new Error("missing durable credential lease");
		expect(credentials.target.revocations).toHaveLength(1);
		expect(credentials.service.get(lease.projection.leaseId)?.status).toBe("revocation_unknown");
		expect(credentials.service.isTargetQuarantined(lease.targetId)).toBe(true);

		expect(await value.connector.runAttempt(value.attempt, { correlation })).toMatchObject({ ok: false });
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "credential_unavailable",
		});
		expect(credentials.target.revocations).toHaveLength(1);
	});

	it("keeps cancellation-before-launch non-terminal when credential revocation is unknown", async () => {
		const credentials = createCredentialHarness();
		credentials.target.revokeUnknown = true;
		const value = await fixture({ credential: credentials.runtime });
		persistAttempt(value);
		const controller = new AbortController();
		credentials.target.onProject = () => controller.abort();

		const cancelled = await value.connector.runAttempt(value.attempt, {
			correlation,
			signal: controller.signal,
		});

		expect(cancelled).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "credential_unavailable",
		});
		const lease = value.store.operations.get(value.attempt.attemptId)?.credential;
		if (lease === undefined) throw new Error("missing durable credential lease");
		expect(credentials.service.get(lease.projection.leaseId)?.status).toBe("revocation_unknown");
		expect(credentials.service.isTargetQuarantined(lease.targetId)).toBe(true);
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
	});

	for (const terminalPath of ["launch_failure", "runner_throw", "cancel", "deadline", "dispose"] as const) {
		it(`revokes and clears the external lease on ${terminalPath}`, async () => {
			const credentials = createCredentialHarness();
			const value = await fixture({ credential: credentials.runtime });
			persistAttempt(value);
			const controller = new AbortController();
			if (terminalPath === "launch_failure") value.supervision.privateStateStore.failWrites = 1;
			if (terminalPath === "runner_throw") value.driver.spawnFailure = true;
			if (terminalPath === "cancel" || terminalPath === "dispose") {
				value.driver.readHangs = true;
				value.driver.eventNextHangs = true;
			}
			if (terminalPath === "deadline") {
				credentials.target.onProject = () => controller.abort(new AgentOperationError("deadline_exceeded"));
			}

			const running = value.connector.runAttempt(value.attempt, {
				correlation,
				...(terminalPath === "deadline" ? { signal: controller.signal } : {}),
			});
			if (terminalPath === "cancel" || terminalPath === "dispose") {
				await expect.poll(() => value.driver.calls.read).toBe(1);
				if (terminalPath === "cancel") await value.connector.cancelAttempt(value.attempt.attemptId);
				else await value.connector.dispose();
			}
			await running;

			const operation = value.store.operations.get(value.attempt.attemptId);
			const leaseId = operation?.credential?.projection.leaseId;
			expect(leaseId).toBeDefined();
			expect(credentials.target.revocations).toHaveLength(1);
			expect(leaseId === undefined ? undefined : credentials.service.get(leaseId)?.status).toBe("settled");
			expect(JSON.stringify({ operation, entries: credentials.session.entries })).not.toContain(credentialCanary);
		});
	}

	it("renews an active external target only through the bounded Host lease authority", async () => {
		const credentials = createCredentialHarness();
		const value = await fixture({ credential: credentials.runtime });
		persistAttempt(value);
		value.driver.readHangs = true;
		value.driver.eventNextHangs = true;
		const running = value.connector.runAttempt(value.attempt, { correlation });
		await expect.poll(() => value.driver.calls.read).toBe(1);
		const projection = value.store.operations.get(value.attempt.attemptId)?.credential?.projection;
		if (projection === undefined) throw new Error("missing external credential projection");
		credentials.clock.nowMs += 10_000;

		const renewed = credentials.service.renew({
			leaseId: projection.leaseId,
			grantId: projection.grantId,
			bindingId: projection.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 120_000,
			clientRequestId: "external-credential-renew-1",
			nodeAttached: true,
		});
		expect(renewed).toMatchObject({ ok: true, grant: { heartbeatSequence: 1 } });
		expect(credentials.target.renewals).toHaveLength(1);
		expect(credentials.target.renewals[0]?.requestedTtlMs).toBe(120_000);
		const rejected = credentials.service.renew({
			leaseId: projection.leaseId,
			grantId: projection.grantId,
			bindingId: projection.bindingId,
			heartbeatSequence: 2,
			requestedTtlMs: 300_001,
			clientRequestId: "external-credential-renew-unbounded",
			nodeAttached: true,
		});
		expect(rejected.ok).toBe(false);
		expect(credentials.target.renewals).toHaveLength(1);

		await value.connector.cancelAttempt(value.attempt.attemptId);
		await running;
		expect(credentials.target.revocations).toHaveLength(1);
		expect(credentials.service.get(projection.leaseId)?.status).toBe("settled");
	});

	it("freezes limits for an accepted Attempt while reload updates only later Attempts", async () => {
		let current: RuntimeLimitsResolutionInput = {
			global: {
				attemptWallMs: 10_000,
				attemptIdleMs: 1_000,
				cancelGraceMs: 2_000,
				shutdownHardMs: 3_000,
				maxFrameBytes: 100_000,
				maxPendingWriteBytes: 200_000,
				maxStderrBytes: 50_000,
				maxEvents: 10,
				maxOutputBytes: 300_000,
				maxConcurrency: 2,
				maxRetries: 1,
				retryBudgetMs: 4_000,
				maxBacklog: 10,
			},
		};
		const value = await fixture({ runtimeLimits: () => current });
		const firstLimits = await value.connector.runtimeLimitsForAttempt(value.attempt.attemptId);
		expect(firstLimits?.values).toMatchObject({
			attemptWallMs: 10_000,
			attemptIdleMs: 1_000,
			cancelGraceMs: 2_000,
			shutdownHardMs: 3_000,
			maxFrameBytes: 100_000,
			maxPendingWriteBytes: 200_000,
			maxStderrBytes: 50_000,
			maxEvents: 10,
			maxOutputBytes: 300_000,
			maxConcurrency: 2,
			maxRetries: 1,
			retryBudgetMs: 4_000,
			maxBacklog: 10,
		});

		current = {
			global: {
				attemptWallMs: 20_000,
				attemptIdleMs: 2_000,
				cancelGraceMs: 3_000,
				shutdownHardMs: 4_000,
				maxFrameBytes: 120_000,
				maxPendingWriteBytes: 220_000,
				maxStderrBytes: 60_000,
				maxEvents: 20,
				maxOutputBytes: 320_000,
				maxConcurrency: 3,
				maxRetries: 2,
				retryBudgetMs: 5_000,
				maxBacklog: 20,
			},
		};
		const secondAttempt = await createAdditionalAttempt(value, "reload");
		const secondLimits = await value.connector.runtimeLimitsForAttempt(secondAttempt.attemptId);
		expect(secondLimits?.values).toMatchObject({
			attemptWallMs: 20_000,
			maxFrameBytes: 120_000,
			maxEvents: 20,
			maxOutputBytes: 320_000,
			maxConcurrency: 3,
			maxRetries: 2,
			retryBudgetMs: 5_000,
			maxBacklog: 20,
		});
		expect(await value.connector.runtimeLimitsForAttempt(value.attempt.attemptId)).toEqual(firstLimits);

		persistAttempt(value);
		const completed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(completed.ok).toBe(true);
		const operation = value.store.operations.get(value.attempt.attemptId);
		expect(decodeRuntimeLimitsOperationNonce(operation?.operationNonce)?.snapshot).toEqual(firstLimits);

		current = { global: { attemptWallMs: 30_000, maxEvents: 30, maxConcurrency: 4 } };
		const restarted = restartedConnector(value, () => current);
		expect(await restarted.connector.runtimeLimitsForAttempt(value.attempt.attemptId)).toEqual(firstLimits);
		const replayed = await restarted.connector.runAttempt(value.attempt, { correlation });
		expect(replayed).toEqual(completed);
		expect(restarted.driver.calls.spawn).toBe(0);
	});

	it("fails closed after restart when an unsettled Attempt has no valid durable limits", async () => {
		const missing = await fixture();
		persistAttempt(missing);
		const missingRestart = restartedConnector(missing);
		const missingResult = await missingRestart.connector.runAttempt(missing.attempt, { correlation });
		expect(missingResult).toMatchObject({ ok: false, error: { code: "external_connector_config_invalid" } });
		expect(missingRestart.driver.calls.spawn).toBe(0);

		const invalid = await fixture();
		persistAttempt(invalid);
		invalid.store.operations.set(invalid.attempt.attemptId, {
			...operationFor(invalid, "running"),
			operationNonce: "operation-nonce-1",
		});
		invalid.store.mappings.set(invalid.attempt.attemptId, mappingFor(invalid));
		const invalidRestart = restartedConnector(invalid);
		const invalidResult = await invalidRestart.connector.resumeAttempt(invalid.attempt, { correlation });
		expect(invalidResult).toMatchObject({ ok: false, error: { code: "external_connector_config_invalid" } });
		expect(invalidRestart.driver.calls.connect).toBe(0);
		expect(invalid.store.operations.get(invalid.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "capability_drift",
		});
	});

	it("reuses the durable frozen snapshot for non-terminal restart recovery", async () => {
		const value = await fixture({
			runtimeLimits: { global: { attemptWallMs: 10_000, attemptIdleMs: 5_000, maxEvents: 10 } },
		});
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		const restarted = restartedConnector(value, {
			global: { attemptWallMs: 20_000, attemptIdleMs: 6_000, maxEvents: 20 },
		});

		expect((await restarted.connector.runtimeLimitsForAttempt(value.attempt.attemptId))?.values).toMatchObject({
			attemptWallMs: 10_000,
			attemptIdleMs: 5_000,
			maxEvents: 10,
		});
		const resumed = await restarted.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(true);
		expect(restarted.driver.calls).toMatchObject({ spawn: 0, connect: 1, read: 1 });
	});

	it("recovers only a current delivered lease and fails closed for expired, revoked, missing, or disconnected authority", async () => {
		const prepareRunning = async () => {
			const credentials = createCredentialHarness();
			const value = await fixture({ credential: credentials.runtime });
			persistAttempt(value);
			value.driver.readHangs = true;
			value.driver.eventNextHangs = true;
			const running = value.connector.runAttempt(value.attempt, { correlation });
			void running.catch(() => undefined);
			await expect.poll(() => value.driver.calls.read).toBe(1);
			const operation = value.store.operations.get(value.attempt.attemptId);
			const credential = operation?.credential;
			if (operation === undefined || credential === undefined) {
				throw new Error("missing durable credential lease");
			}
			return { credentials, value, running, operation, credential };
		};

		const valid = await prepareRunning();
		valid.credentials.reload();
		const validRestart = restartedConnector(valid.value, undefined, valid.credentials.runtime);
		const resumed = await validRestart.connector.resumeAttempt(valid.value.attempt, { correlation });
		expect(resumed).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(validRestart.driver.calls).toMatchObject({ spawn: 0, connect: 1, read: 1 });
		expect(valid.credentials.target.revocations).toHaveLength(1);
		expect(
			valid.credentials.service.get(valid.credential.projection.leaseId)?.status,
		).toBe("settled");
		await valid.value.connector.dispose().catch(() => undefined);
		await valid.running;

		const expired = await prepareRunning();
		expired.credentials.clock.nowMs += 61_000;
		expired.credentials.reload();
		const expiredRestart = restartedConnector(expired.value, undefined, expired.credentials.runtime);
		const expiredResult = await expiredRestart.connector.resumeAttempt(expired.value.attempt, { correlation });
		expect(expiredResult).toMatchObject({ ok: false, error: { code: "external_credential_unavailable" } });
		expect(expiredRestart.driver.calls.connect).toBe(0);
		expect(expired.credentials.target.revocations).toHaveLength(1);
		expect(
			expired.credentials.service.get(expired.credential.projection.leaseId)?.status,
		).toBe("settled");

		const revoked = await prepareRunning();
		const revokedProjection = revoked.credential.projection;
		expect(revoked.credentials.service.releaseDeliveredLease({
			reference: {
				schemaVersion: 1,
				leaseId: revokedProjection.leaseId,
				grantId: revokedProjection.grantId,
				bindingId: revokedProjection.bindingId,
				clientRequestId: revokedProjection.clientRequestId,
			},
			targetId: revoked.credential.targetId,
			reasonCode: "run_cancelled",
		}).ok).toBe(true);
		revoked.credentials.reload();
		const revokedRestart = restartedConnector(revoked.value, undefined, revoked.credentials.runtime);
		expect(await revokedRestart.connector.resumeAttempt(revoked.value.attempt, { correlation })).toMatchObject({
			ok: false,
			error: { code: "external_credential_unavailable" },
		});
		expect(revokedRestart.driver.calls.connect).toBe(0);
		expect(revoked.credentials.target.revocations).toHaveLength(1);

		const missing = await prepareRunning();
		const missingRestart = restartedConnector(missing.value);
		expect(await missingRestart.connector.resumeAttempt(missing.value.attempt, { correlation })).toMatchObject({
			ok: false,
			error: { code: "external_credential_unavailable" },
		});
		expect(missingRestart.driver.calls.connect).toBe(0);
		expect(missing.value.store.operations.get(missing.value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "credential_unavailable",
		});
		expect(missing.credentials.target.revocations).toHaveLength(0);

		const disconnected = await prepareRunning();
		disconnected.credentials.reload();
		const disconnectedRestart = restartedConnector(
			disconnected.value,
			undefined,
			disconnected.credentials.runtime,
		);
		disconnectedRestart.driver.connectFailure = true;
		expect(await disconnectedRestart.connector.resumeAttempt(disconnected.value.attempt, { correlation })).toMatchObject({
			ok: false,
			error: { code: "worker_lost" },
		});
		expect(disconnectedRestart.driver.calls.connect).toBe(1);
		expect(disconnected.credentials.target.revocations).toHaveLength(1);
	});

	it("uses each Attempt frozen concurrency limit without stranding later work", async () => {
		const value = await fixture({ runtimeLimits: { global: { maxConcurrency: 1 } } });
		const secondAttempt = await createAdditionalAttempt(value, "concurrency");
		value.store.attempts.set(value.attempt.attemptId, value.attempt);
		value.store.attempts.set(secondAttempt.attemptId, secondAttempt);
		let markSpawnStarted: (() => void) | undefined;
		let releaseSpawn: (() => void) | undefined;
		const spawnStarted = new Promise<void>((resolve) => {
			markSpawnStarted = resolve;
		});
		value.driver.spawnGate = new Promise<void>((resolve) => {
			releaseSpawn = resolve;
		});
		value.driver.onSpawn = () => markSpawnStarted?.();

		const first = value.connector.runAttempt(value.attempt, { correlation });
		await spawnStarted;
		const rejected = await value.connector.runAttempt(secondAttempt, { correlation });
		expect(rejected).toMatchObject({ ok: false, error: { code: "external_resource_limit_exceeded" } });
		expect(value.driver.calls.spawn).toBe(1);

		releaseSpawn?.();
		expect((await first).ok).toBe(true);
		expect((await value.connector.runAttempt(secondAttempt, { correlation })).ok).toBe(true);
		expect(value.driver.calls.spawn).toBe(2);
	});

	it("bounds the accepted backlog and releases its frozen snapshot after durable execution", async () => {
		const value = await fixture({ runtimeLimits: { global: { maxBacklog: 1 } } });
		await expect(createAdditionalAttempt(value, "backlog")).rejects.toMatchObject({
			code: "external_resource_limit_exceeded",
		});

		persistAttempt(value);
		expect((await value.connector.runAttempt(value.attempt, { correlation })).ok).toBe(true);
		const admitted = await createAdditionalAttempt(value, "backlog");
		expect(admitted.attemptId).toBe(externalConnectorAttemptId(providerId, `${dispatch.dispatchId}-backlog`));
	});

	it("persists one Attempt mapping and canonical receipt across replay", async () => {
		const value = await fixture();
		persistAttempt(value);
		const first = await value.connector.runAttempt(value.attempt, { correlation });
		const second = await value.connector.runAttempt(value.attempt, { correlation });
		expect(first).toEqual(second);
		expect(value.store.attempts.size).toBe(1);
		expect(value.store.mappings.size).toBe(1);
		expect(value.store.receipts.size).toBe(1);
		expect(value.store.mappingWrites).toBe(1);
		expect(value.store.receiptWrites).toBe(1);
		expect(value.driver.calls.spawn).toBe(1);
		expect("ExternalConnectorVendorDriver" in packageEntry).toBe(false);
	});

	it("persists distinct toolCallId exchanges and replays a duplicate without repeating its effect", async () => {
		const value = await fixture({ toolGateway: true });
		persistAttempt(value);
		const first = gatewayRequestFor(value, "tool-call-1", { path: "docs/one.txt" });
		const second = gatewayRequestFor(value, "tool-call-2", { path: "docs/two.txt" });
		value.driver.eventValues = gatewayEventsFor(value, [first, first, second]);
		const effects: ToolGatewayRequest[] = [];
		const consumer = scopedConsumer(value, async (request) => {
			effects.push(request);
			return Result.ok({
				schemaVersion: 1,
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				ok: true,
				sideEffectState: "none",
				toolReceiptRef: `receipt-${request.toolCallId}`,
			});
		});
		const release = value.connector.bindToolGatewayConsumer(value.attempt.attemptId, consumer);
		try {
			const completed = await value.connector.runAttempt(value.attempt, {
				correlation: gatewayCorrelation(),
			});
			expect(completed.ok).toBe(true);
			if (completed.ok) expect(completed.value.status).toBe("succeeded");
			expect(value.driver.spawnRequests[0]?.toolGatewayRoutes).toEqual(consumer.scope.routes);
			expect(effects).toEqual([first, second]);
			expect(value.driver.writes.map((write) => write.result.toolCallId)).toEqual([
				"tool-call-1",
				"tool-call-1",
				"tool-call-2",
			]);
			expect(await value.store.listToolGatewayExecutions(value.attempt.attemptId)).toHaveLength(2);
		} finally {
			release();
		}
	});

	it("fails closed when one durable toolCallId is reused with a conflicting payload", async () => {
		const value = await fixture({ toolGateway: true });
		persistAttempt(value);
		const first = gatewayRequestFor(value, "tool-call-conflict", { path: "docs/one.txt" });
		const conflict = gatewayRequestFor(value, "tool-call-conflict", { path: "docs/two.txt" });
		value.driver.eventValues = gatewayEventsFor(value, [first, conflict]);
		const effects: ToolGatewayRequest[] = [];
		const release = value.connector.bindToolGatewayConsumer(value.attempt.attemptId, scopedConsumer(value, async (request) => {
			effects.push(request);
			const result: ToolExecutionResult = {
				schemaVersion: 1,
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				ok: true,
				sideEffectState: "none",
				toolReceiptRef: `receipt-${request.toolCallId}`,
			};
			return Result.ok(result);
		}));
		try {
			const completed = await value.connector.runAttempt(value.attempt, {
				correlation: gatewayCorrelation(),
			});
			expect(completed.ok).toBe(true);
			if (completed.ok) {
				expect(completed.value).toMatchObject({
					status: "failed",
					error: { code: "external_event_invalid" },
				});
			}
			expect(effects).toEqual([first]);
			expect(value.driver.writes).toHaveLength(1);
			expect(await value.store.listToolGatewayExecutions(value.attempt.attemptId)).toHaveLength(1);
		} finally {
			release();
		}
	});

	it("rejects a wrong-nonce Tool Gateway request before provider or driver write effects", async () => {
		const value = await fixture({ toolGateway: true });
		persistAttempt(value);
		const request = gatewayRequestFor(value, "tool-call-wrong-nonce", { path: "docs/one.txt" });
		value.driver.eventValues = gatewayEventsFor(value, [request]).map((event) =>
			typeof event === "object" && event !== null && "type" in event && event.type === "tool_gateway_request"
				? { ...event, operationNonce: "wrong-operation-nonce" }
				: event,
		);
		const effects: ToolGatewayRequest[] = [];
		const release = value.connector.bindToolGatewayConsumer(
			value.attempt.attemptId,
			scopedConsumer(value, async (gatewayRequest) => {
				effects.push(gatewayRequest);
				return Result.ok({
					schemaVersion: 1,
					toolCallId: gatewayRequest.toolCallId,
					toolName: gatewayRequest.toolName,
					ok: true,
					sideEffectState: "none",
					toolReceiptRef: "wrong-nonce-receipt",
				});
			}),
		);
		try {
			const completed = await value.connector.runAttempt(value.attempt, { correlation: gatewayCorrelation() });
			expect(completed).toMatchObject({
				ok: true,
				value: { status: "failed", error: { code: "external_event_invalid" } },
			});
			expect(effects).toEqual([]);
			expect(value.driver.writes).toEqual([]);
		} finally {
			release();
		}
	});

	it("rejects a result that does not match the exact in-flight toolCallId", async () => {
		const value = await fixture({ toolGateway: true });
		persistAttempt(value);
		const request = gatewayRequestFor(value, "tool-call-in-flight", { path: "docs/one.txt" });
		value.driver.eventValues = gatewayEventsFor(value, [request]);
		const release = value.connector.bindToolGatewayConsumer(
			value.attempt.attemptId,
			scopedConsumer(value, async (gatewayRequest) =>
				Result.ok({
					schemaVersion: 1,
					toolCallId: "orphan-tool-call",
					toolName: gatewayRequest.toolName,
					ok: true,
					sideEffectState: "none",
					toolReceiptRef: "orphan-result-receipt",
				}),
			),
		);
		try {
			const completed = await value.connector.runAttempt(value.attempt, { correlation: gatewayCorrelation() });
			expect(completed).toMatchObject({
				ok: true,
				value: { status: "failed", error: { code: "external_event_invalid" } },
			});
			expect(value.driver.writes).toEqual([]);
		} finally {
			release();
		}
	});

	it("repairs the terminal operation after a crash following canonical receipt persistence", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		value.store.receipts.set(value.attempt.attemptId, receiptFor(value));
		const restarted = restartedConnector(value);

		const recovered = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

		expect(recovered).toEqual({ ok: true, value: receiptFor(value) });
		expect(value.store.receipts.size).toBe(1);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.mappings.size).toBe(1);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "terminal",
			receiptId: `attempt_receipt_${value.attempt.attemptId}`,
		});
		expect(value.store.operationHistory).toEqual(["terminal"]);
		expect(restarted.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});

		const replayed = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

		expect(replayed).toEqual({ ok: true, value: value.store.receipts.get(value.attempt.attemptId) });
		expect(value.store.operationHistory).toEqual(["terminal"]);
		expect(restarted.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});
	});

	it("resumes only an existing mapped Attempt when capability is supported", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(true);
		expect(value.driver.calls.connect).toBe(1);
		expect(value.driver.calls.events).toBe(1);
		expect(value.driver.calls.read).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
	});

	it("rejects a connected handle that drifts from the durable mapping before observation", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		const mapping = mappingFor(value);
		value.store.mappings.set(value.attempt.attemptId, mapping);
		await persistSupervisorIdentity(value);
		value.driver.connectHandle = {
			externalSessionId: "different-external-session",
			externalTurnId: mapping.externalTurnId,
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};

		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });

		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("invalid_correlation");
		expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 1, events: 0, read: 0, cancel: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("rejects pre-aborted resume before supervisor launch or driver recovery", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		const controller = new AbortController();
		controller.abort();

		const resumed = await value.connector.resumeAttempt(value.attempt, {
			correlation,
			signal: controller.signal,
		});

		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("scheduler_attempt_recovery_failed");
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 0, lookup: 0, events: 0, read: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("running");
	});

	it("rejects unsupported resume without touching the driver", async () => {
		const value = await fixture({ resume: false });
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("external_resume_unsupported");
		expect(value.driver.calls.connect).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
	});

	it("propagates supervised resume event failures through the same Attempt receipt", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.eventValues = [
			{
				schemaVersion: 1,
				type: "progress",
				externalSessionId: value.driver.handle.externalSessionId,
				...(value.driver.handle.externalTurnId === undefined
					? {}
					: { externalTurnId: value.driver.handle.externalTurnId }),
				sequence: 1,
				producedAt: now,
			},
		];
		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(true);
		if (resumed.ok) {
			expect(resumed.value.attemptId).toBe(value.attempt.attemptId);
			expect(resumed.value).toMatchObject({
				status: "failed",
				error: {
					code: "external_event_invalid",
					message: "External connector emitted invalid supervised output.",
				},
			});
		}
		expect(value.driver.calls.connect).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.store.receiptWrites).toBe(1);
	});

	it("settles an already-aborted run without process, driver, events, or iterator side effects", async () => {
		const value = await fixture();
		persistAttempt(value);
		const controller = new AbortController();
		controller.abort();
		const completed = await value.connector.runAttempt(value.attempt, {
			correlation,
			signal: controller.signal,
		});
		expect(completed.ok).toBe(true);
		if (completed.ok) expect(completed.value.status).toBe("cancelled");
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});
	});

	it("cleans a launched supervisor before settling an abort observed ahead of driver observation", async () => {
		const value = await fixture();
		persistAttempt(value);
		let markMappingWrite: (() => void) | undefined;
		let releaseMappingWrite: (() => void) | undefined;
		const mappingWriteStarted = new Promise<void>((resolve) => {
			markMappingWrite = resolve;
		});
		value.store.mappingWriteGate = new Promise<void>((resolve) => {
			releaseMappingWrite = resolve;
		});
		value.store.onMappingWrite = () => markMappingWrite?.();
		const controller = new AbortController();
		const running = value.connector.runAttempt(value.attempt, {
			correlation,
			signal: controller.signal,
		});
		await mappingWriteStarted;

		controller.abort(new AgentOperationError("deadline_exceeded"));
		releaseMappingWrite?.();
		const completed = await running;

		expect(completed.ok).toBe(true);
		if (completed.ok) {
			expect(completed.value).toMatchObject({
				status: "failed",
				error: { code: "run_deadline_exceeded" },
			});
		}
		expect(value.driver.calls).toMatchObject({ spawn: 1, events: 0, read: 0, cancel: 0 });
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
	});

	it("rejects a malformed spawned handle before mapping or observation", async () => {
		const value = await fixture();
		persistAttempt(value);
		const mapping = mappingFor(value);
		value.driver.spawnHandle = {
			externalSessionId: mapping.externalSessionId,
			externalTurnId: mapping.externalTurnId,
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
			transcript: "untrusted",
		};

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed.ok).toBe(false);
		if (!completed.ok) expect(completed.error.code).toBe("invalid_correlation");
		expect(value.driver.calls).toMatchObject({ spawn: 1, events: 0, read: 0, cancel: 0 });
		expect(value.store.mappingWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("remembers cancel before Attempt persistence and never launches later", async () => {
		const value = await fixture();
		const requested = await value.connector.cancelAttempt(value.attempt.attemptId);
		expect(requested.ok).toBe(true);
		persistAttempt(value);
		const completed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(completed.ok).toBe(true);
		if (completed.ok) expect(completed.value.status).toBe("cancelled");
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.driver.calls.cancel).toBe(0);
		expect(value.store.operations.has(value.attempt.attemptId)).toBe(false);

		const restarted = restartedConnector(value);
		const replayed = await restarted.connector.reconcileAttempt(value.attempt, { correlation });
		expect(replayed).toEqual(completed);
		expect(value.store.operations.has(value.attempt.attemptId)).toBe(false);
		expect(value.store.receipts.size).toBe(1);
		expect(value.store.receiptWrites).toBe(1);
		expect(restarted.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});
	});

	it("uses one cooperative driver cancel after launch and returns one canonical cancelled receipt", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.driver.readHangs = true;
		value.driver.eventNextHangs = true;
		const running = value.connector.runAttempt(value.attempt, { correlation });
		await expect.poll(() => value.driver.calls.read).toBe(1);
		const cancelled = await value.connector.cancelAttempt(value.attempt.attemptId);
		expect(cancelled.ok).toBe(true);
		const completed = await running;
		expect(completed.ok).toBe(true);
		if (completed.ok) expect(completed.value.status).toBe("cancelled");
		expect(value.driver.calls.cancel).toBe(1);
		expect(value.driver.calls.connect).toBe(0);
		expect(value.store.receiptWrites).toBe(1);
		expect(value.store.receipts.get(value.attempt.attemptId)?.status).toBe("cancelled");
	});

	it("stops observation and force-contains the process after evidence-free cancel grace", async () => {
		vi.useFakeTimers();
		try {
			const value = await fixture();
			persistAttempt(value);
			value.driver.readHangs = true;
			value.driver.eventNextHangs = true;
			value.driver.cancelEvidence = undefined;
			const running = value.connector.runAttempt(value.attempt, { correlation });
			await vi.waitFor(() => expect(value.driver.calls.read).toBe(1));

			const cancelled = value.connector.cancelAttempt(value.attempt.attemptId);
			await vi.waitFor(() => expect(value.driver.readAbortObserved).toBe(true));
			expect(value.supervision.processController.forceCalls).toBe(0);
			await vi.advanceTimersByTimeAsync(500);
			expect(value.supervision.processController.forceCalls).toBe(0);
			await vi.advanceTimersByTimeAsync(500);

			await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
			await expect(running).resolves.toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
			expect(value.supervision.processController.forceCalls).toBe(1);
			expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
				status: "reconcile_required",
				reconcileReason: "driver_failure",
			});
			expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
			await value.connector.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("honors cancel grace while driver start is active before exact forced containment", async () => {
		vi.useFakeTimers();
		try {
			const value = await fixture();
			persistAttempt(value);
			let markSpawnStarted: (() => void) | undefined;
			const spawnStarted = new Promise<void>((resolve) => {
				markSpawnStarted = resolve;
			});
			value.driver.onSpawn = () => markSpawnStarted?.();
			value.driver.spawnGate = new Promise<never>(() => undefined);
			const running = value.connector.runAttempt(value.attempt, { correlation });
			await spawnStarted;

			const cancelled = value.connector.cancelAttempt(value.attempt.attemptId);
			for (let index = 0; index < 8; index += 1) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(999);
			expect(value.supervision.processController.forceCalls).toBe(0);
			await vi.advanceTimersByTimeAsync(1);

			await expect(cancelled).resolves.toMatchObject({ ok: true });
			await expect(running).resolves.toMatchObject({
				ok: true,
				value: { status: "failed", sideEffectState: "unknown" },
			});
			expect(value.supervision.processController.forceCalls).toBe(1);
			expect(value.store.receipts.get(value.attempt.attemptId)).toMatchObject({
				status: "failed",
				sideEffectState: "unknown",
			});
			await value.connector.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps failed-without-mapping non-terminal when credential revocation is unknown", async () => {
		vi.useFakeTimers();
		try {
			const credentials = createCredentialHarness();
			credentials.target.revokeUnknown = true;
			const value = await fixture({ credential: credentials.runtime });
			persistAttempt(value);
			let markSpawnStarted: (() => void) | undefined;
			const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
			value.driver.onSpawn = () => markSpawnStarted?.();
			value.driver.spawnGate = new Promise<never>(() => undefined);
			const running = value.connector.runAttempt(value.attempt, { correlation });
			await spawnStarted;

			const cancellation = value.connector.cancelAttempt(value.attempt.attemptId);
			for (let index = 0; index < 8; index += 1) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(1_000);

			await expect(cancellation).resolves.toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
			await expect(running).resolves.toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
			expect(value.store.receiptWrites).toBe(0);
			expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
				status: "reconcile_required",
				reconcileReason: "credential_unavailable",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels idempotently after persisting cancelling", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		const first = await value.connector.cancelAttempt(value.attempt.attemptId);
		const second = await value.connector.cancelAttempt(value.attempt.attemptId);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(value.driver.calls.cancel).toBe(1);
		expect(value.store.operationHistory).toEqual(["cancelling", "terminal"]);
		expect(value.store.receipts.get(value.attempt.attemptId)?.status).toBe("cancelled");
	});

	it("reconciles persisted cancelling after restart instead of returning success without work", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "cancelling"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		const restarted = restartedConnector(value);
		restarted.driver.lookupResult = { status: "terminal", evidence: terminalEvidence("cancelled") };

		const first = await restarted.connector.cancelAttempt(value.attempt.attemptId);
		const second = await restarted.connector.cancelAttempt(value.attempt.attemptId);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(restarted.driver.calls).toMatchObject({ spawn: 0, lookup: 1, cancel: 0 });
		expect(value.store.receiptWrites).toBe(1);
		expect(value.store.receipts.get(value.attempt.attemptId)?.status).toBe("cancelled");
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "terminal",
			receiptId: `attempt_receipt_${value.attempt.attemptId}`,
		});
	});

	it("rejects a connected cancellation handle before invoking driver cancel", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		const mapping = mappingFor(value);
		value.store.mappings.set(value.attempt.attemptId, mapping);
		await persistSupervisorIdentity(value);
		value.driver.connectHandle = {
			externalSessionId: mapping.externalSessionId,
			externalTurnId: "different-external-turn",
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};

		const cancelled = await value.connector.cancelAttempt(value.attempt.attemptId);

		expect(cancelled.ok).toBe(false);
		if (!cancelled.ok) expect(cancelled.error.code).toBe("invalid_correlation");
		expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 1, events: 0, read: 0, cancel: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("does not start when the start_intent durable write crashes and can retry prepared", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.failOperationStatusOnce = "start_intent";
		const crashed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(crashed.ok).toBe(false);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("prepared");

		const retried = await value.connector.runAttempt(value.attempt, { correlation });
		expect(retried.ok).toBe(true);
		expect(value.driver.calls.spawn).toBe(1);
	});

	it("marks a crash after start_intent for reconciliation and never restarts", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.driver.spawnFailure = true;
		const crashed = await value.connector.runAttempt(value.attempt, { correlation });
		const retried = await value.connector.runAttempt(value.attempt, { correlation });
		expect(crashed.ok).toBe(false);
		expect(retried.ok).toBe(false);
		expect(value.driver.calls.spawn).toBe(1);
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("reconcile_required");
	});

	it("closes the launch-before-private-identity-persist window before driver start", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.supervision.privateStateStore.failWrites = 1;

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed.ok).toBe(false);
		expect(value.supervision.processController.launchCalls).toBe(1);
		expect(value.supervision.processController.activationCalls).toBe(0);
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("reconcile_required");
	});

	it("fails closed and retains exact identity when launch cleanup cannot be confirmed", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.supervision.privateStateStore.failWrites = 1;
		value.supervision.processController.forceExits = false;

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed.ok).toBe(false);
		expect(value.supervision.processController.activationCalls).toBe(0);
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toMatchObject({
			reference: { operationNonce: "operation-nonce-1" },
			processIdentity: { pid: 20_000, startToken: "start-20000" },
		});
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("reconcile_required");
	});

	it("persists unknown state when an aborted non-cooperative launch cannot be cleaned", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.supervision.processController.forceExits = false;
		let markLaunchStarted: (() => void) | undefined;
		let releaseLaunch: (() => void) | undefined;
		const launchStarted = new Promise<void>((resolve) => {
			markLaunchStarted = resolve;
		});
		value.supervision.processController.launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		value.supervision.processController.onLaunch = () => markLaunchStarted?.();
		const abort = new AbortController();
		const running = value.connector.runAttempt(value.attempt, { correlation, signal: abort.signal });
		await launchStarted;
		abort.abort();

		await expect(running).resolves.toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		expect(value.store.receipts.has(value.attempt.attemptId)).toBe(false);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "start_outcome_unknown",
		});

		releaseLaunch?.();
		await expect.poll(() => value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toMatchObject({
			reference: { operationNonce: "operation-nonce-1" },
			processIdentity: { pid: 20_000, startToken: "start-20000" },
		});
		value.supervision.processController.resolveExits();
		await value.connector.dispose();
	});

	it("never launches a replacement supervisor during resume, reconcile, or cancellation recovery", async () => {
		for (const recovery of ["resume", "reconcile", "cancel"] as const) {
			const value = await fixture();
			persistAttempt(value);
			value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
			value.store.mappings.set(value.attempt.attemptId, mappingFor(value));

			const result =
				recovery === "resume"
					? await value.connector.resumeAttempt(value.attempt, { correlation })
					: recovery === "reconcile"
						? await value.connector.reconcileAttempt(value.attempt, { correlation })
						: await value.connector.cancelAttempt(value.attempt.attemptId);

			expect(result.ok).toBe(false);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 0, lookup: 0, cancel: 0 });
		}
	});

	it("reaps the exact activated tree after a crash before mapping persistence", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "start_intent"));
		await persistSupervisorIdentity(value);
		const restarted = restartedConnector(value);

		const reconciled = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

		expect(reconciled.ok).toBe(false);
		if (!reconciled.ok) expect(reconciled.error.code).toBe("side_effect_unknown");
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
		expect(restarted.driver.calls).toEqual({
			spawn: 0,
			events: 0,
			connect: 0,
			lookup: 0,
			read: 0,
			write: 0,
			heartbeat: 0,
			cancel: 0,
			dispose: 0,
		});
		expect(value.store.mappings.size).toBe(0);
		expect(value.store.receipts.size).toBe(0);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "mapping_missing",
		});
	});

	it("startup-reaps exact private trees despite missing or drifted canonical state", async () => {
		for (const state of ["missing_operation", "missing_mapping", "capability_and_mapping_drift"] as const) {
			const value = await fixture();
			persistAttempt(value);
			if (state !== "missing_operation") {
				value.store.operations.set(
					value.attempt.attemptId,
					operationFor(
						value,
						"running",
						state === "capability_and_mapping_drift" ? capability(true, 2) : value.snapshot,
					),
				);
			}
			if (state === "capability_and_mapping_drift") {
				value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
			}
			await persistSupervisorIdentity(value);
			const restarted = restartedConnector(value);

			const recovered = await restarted.connector.recoverPrivateSupervisorState();

			expect(recovered).toEqual([{ attemptId: value.attempt.attemptId, status: "reaped" }]);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.supervision.processController.forceCalls).toBe(1);
			expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
			expect(restarted.driver.calls).toEqual({
				spawn: 0,
				events: 0,
				connect: 0,
				lookup: 0,
				read: 0,
				write: 0,
				heartbeat: 0,
				cancel: 0,
				dispose: 0,
			});
			if (state !== "missing_operation") {
				expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
					status: "reconcile_required",
					reconcileReason: "driver_failure",
				});
			}

			const laterOpened = await restarted.connector.reconcileAttempt(value.attempt, { correlation });
			expect(laterOpened.ok).toBe(false);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(restarted.driver.calls.spawn).toBe(0);
		}
	});

	it("startup reattaches a mapped running operation for resume instead of reaping it", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		const restarted = restartedConnector(value);

		const recovered = await restarted.connector.recoverPrivateSupervisorState();

		expect(recovered).toEqual([{ attemptId: value.attempt.attemptId, status: "reattached" }]);
		expect(value.supervision.processController.forceCalls).toBe(0);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeDefined();

		const resumed = await restarted.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(restarted.driver.calls).toMatchObject({ spawn: 0, connect: 1, read: 1 });
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
		await restarted.connector.dispose();
	});

	it("startup quarantines a reaped credential-bearing operation when revoke is unknown", async () => {
		const credentials = createCredentialHarness();
		const value = await fixture({ credential: credentials.runtime });
		persistAttempt(value);
		value.driver.readHangs = true;
		value.driver.eventNextHangs = true;
		const running = value.connector.runAttempt(value.attempt, { correlation });
		void running.catch(() => undefined);
		await expect.poll(() => value.driver.calls.read).toBe(1);
		credentials.target.revokeUnknown = true;
		const restarted = restartedConnector(value, undefined, credentials.runtime);

		const recovered = await restarted.connector.recoverPrivateSupervisorState();

		expect(recovered).toEqual([{ attemptId: value.attempt.attemptId, status: "quarantined" }]);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "driver_failure",
		});
		const lease = value.store.operations.get(value.attempt.attemptId)?.credential;
		if (lease === undefined) throw new Error("missing durable credential lease");
		expect(credentials.service.get(lease.projection.leaseId)?.status).toBe("revocation_unknown");
		expect(credentials.service.isTargetQuarantined(lease.targetId)).toBe(true);
		await value.connector.dispose().catch(() => undefined);
		await running;
	});

	it("startup quarantines not-found, PID-reused, and ambiguous identities without killing", async () => {
		for (const status of ["not_found", "identity_mismatch", "ambiguous"] as const) {
			const value = await fixture();
			persistAttempt(value);
			value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
			await persistSupervisorIdentity(value);
			value.supervision.processController.reattachResult = { status };
			const restarted = restartedConnector(value);

			const recovered = await restarted.connector.recoverPrivateSupervisorState();

			expect(recovered).toEqual([{ attemptId: value.attempt.attemptId, status: "quarantined" }]);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.supervision.processController.forceCalls).toBe(0);
			expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeDefined();
			expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
				status: "reconcile_required",
				reconcileReason: "driver_failure",
			});
			expect(restarted.driver.calls).toEqual({
				spawn: 0,
				events: 0,
				connect: 0,
				lookup: 0,
				read: 0,
				write: 0,
				heartbeat: 0,
				cancel: 0,
				dispose: 0,
			});
		}
	});

	it("retains private state when confirmed startup cleanup cannot be durably deleted", async () => {
		// This assertion targets the durable-delete failure after a confirmed reap.
		// Keep full-suite contention outside the test-only 10 ms disposal deadline.
		const value = await fixture({
			supervisionDeadlines: { dispose: { hardMs: 1_000, idleMs: 1_000 } },
		});
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		await persistSupervisorIdentity(value);
		value.supervision.privateStateStore.failDeletes = 1;
		const restarted = restartedConnector(value);

		const recovered = await restarted.connector.recoverPrivateSupervisorState();

		expect(recovered).toEqual([
			{
				attemptId: value.attempt.attemptId,
				status: "cleanup_confirmed_state_retained",
			},
		]);
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeDefined();
	});

	it("fails production startup when private state cannot be safely enumerated", async () => {
		const value = await fixture();
		value.supervision.privateStateStore.failLists = 1;
		const restarted = restartedConnector(value);

		await expect(restarted.connector.recoverPrivateSupervisorState()).rejects.toThrow("list failure");
		expect(value.supervision.processController.forceCalls).toBe(0);
		expect(value.supervision.processController.launchCalls).toBe(0);
	});

	it("keeps missing, PID-reuse, and ambiguous mappingless identities quarantined without killing", async () => {
		for (const status of ["not_found", "identity_mismatch", "ambiguous"] as const) {
			const value = await fixture();
			persistAttempt(value);
			value.store.operations.set(value.attempt.attemptId, operationFor(value, "start_intent"));
			await persistSupervisorIdentity(value);
			value.supervision.processController.reattachResult = { status };
			const restarted = restartedConnector(value);

			const reconciled = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

			expect(reconciled.ok).toBe(false);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.supervision.processController.forceCalls).toBe(0);
			expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeDefined();
			expect(restarted.driver.calls).toEqual({
				spawn: 0,
				events: 0,
				connect: 0,
				lookup: 0,
				read: 0,
				write: 0,
				heartbeat: 0,
				cancel: 0,
				dispose: 0,
			});
			expect(value.store.receipts.size).toBe(0);
			expect(value.store.receiptWrites).toBe(0);
			expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
				status: "reconcile_required",
				reconcileReason: "mapping_missing",
			});
		}
	});

	it("surfaces mappingless private-state read and delete failures", async () => {
		for (const failure of ["read", "delete"] as const) {
			const value = await fixture();
			persistAttempt(value);
			value.store.operations.set(value.attempt.attemptId, operationFor(value, "start_intent"));
			await persistSupervisorIdentity(value);
			if (failure === "read") value.supervision.privateStateStore.failReads = 1;
			else value.supervision.privateStateStore.failDeletes = 1;
			const restarted = restartedConnector(value);

			const reconciled = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

			expect(reconciled.ok).toBe(false);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.supervision.processController.forceCalls).toBe(failure === "read" ? 0 : 1);
			expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeDefined();
			expect(value.store.receipts.size).toBe(0);
			expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
				status: "reconcile_required",
				reconcileReason: "mapping_missing",
			});
		}
	});

	it("reconciles with mapping and driver lookup without restarting", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "reconcile_required"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.lookupResult = { status: "terminal", evidence: terminalEvidence() };
		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });
		expect(reconciled.ok).toBe(true);
		expect(value.driver.calls.lookup).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.store.receiptWrites).toBe(1);
	});

	it("preserves an ambiguous terminal lookup as external_terminal_ambiguous", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "reconcile_required"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.lookupResult = { status: "ambiguous" };

		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });

		expect(reconciled.ok).toBe(false);
		if (!reconciled.ok) expect(reconciled.error.code).toBe("external_terminal_ambiguous");
		expect(value.driver.calls).toMatchObject({ spawn: 0, lookup: 1, events: 0, read: 0 });
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "driver_state_ambiguous",
		});
	});

	it("rejects a running lookup handle that does not match durable authority before reads", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		const mapping = mappingFor(value);
		value.store.mappings.set(value.attempt.attemptId, mapping);
		await persistSupervisorIdentity(value);
		value.driver.lookupResult = {
			status: "running",
			handle: {
				externalSessionId: "different-external-session",
				externalTurnId: mapping.externalTurnId,
				supervisorRef: mapping.supervisor.ref,
				operationNonce: mapping.supervisor.nonce,
			},
		};

		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });

		expect(reconciled.ok).toBe(false);
		if (!reconciled.ok) expect(reconciled.error.code).toBe("invalid_correlation");
		expect(value.driver.calls).toMatchObject({ spawn: 0, lookup: 1, events: 0, read: 0, cancel: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("rejects malformed lookup protocol results before any driver observation", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.lookupResult = { status: "running", handle: value.driver.handle, transcript: "untrusted" };

		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });

		expect(reconciled.ok).toBe(false);
		if (!reconciled.ok) expect(reconciled.error.code).toBe("invalid_correlation");
		expect(value.driver.calls).toMatchObject({ spawn: 0, lookup: 1, events: 0, read: 0, cancel: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("rejects pre-aborted reconciliation before supervisor launch or driver lookup", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		const controller = new AbortController();
		controller.abort();

		const reconciled = await value.connector.reconcileAttempt(value.attempt, {
			correlation,
			signal: controller.signal,
		});

		expect(reconciled.ok).toBe(false);
		if (!reconciled.ok) expect(reconciled.error.code).toBe("scheduler_attempt_recovery_failed");
		expect(value.supervision.processController.launchCalls).toBe(0);
		expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 0, lookup: 0, events: 0, read: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("running");
	});

	it("fails closed on mapping conflict without connect or restart", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		const conflicting = {
			...mappingFor(value),
			supervisor: { ref: "supervisor-ref-1", nonce: "different-nonce" },
		};
		value.store.mappings.set(value.attempt.attemptId, conflicting);
		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(false);
		if (!resumed.ok) expect(resumed.error.code).toBe("external_mapping_conflict");
		expect(value.driver.calls.connect).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("projects a durable mapping write collision as external_mapping_conflict", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.mappings.set(value.attempt.attemptId, {
			...mappingFor(value),
			externalSessionId: "conflicting-external-session",
		});

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed.ok).toBe(false);
		if (!completed.ok) expect(completed.error.code).toBe("external_mapping_conflict");
		expect(value.driver.calls).toMatchObject({ spawn: 1, events: 0, read: 0 });
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("fails closed on frozen capability drift before lookup or restart", async () => {
		const value = await fixture({ capabilityRevision: 2 });
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running", capability(true, 1)));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });
		expect(reconciled.ok).toBe(false);
		expect(value.driver.calls.lookup).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("capability_drift");
	});

	it("rejects unknown durable operation fields and strips none through transitions", async () => {
		const value = await fixture();
		const prepared = operationFor(value, "prepared");
		for (const injected of [
			{ rawConfig: { token: "secret" } },
			{ prompt: "secret" },
			{ transcript: "secret" },
			{ credential: "secret" },
			{ url: "https://secret.invalid" },
			{ path: "C:\\secret" },
		]) {
			expect(() => cloneExternalConnectorOperation({ ...prepared, ...injected })).toThrowError(FoundationError);
			expect(() =>
				transitionExternalConnectorOperation(
					{ ...prepared, ...injected } as unknown as ExternalConnectorOperation,
					"start_intent",
					{ now },
				),
			).toThrowError(FoundationError);
		}

		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, {
			...operationFor(value, "running"),
			prompt: "secret",
		} as unknown as ExternalConnectorOperation);
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		expect(resumed.ok).toBe(false);
		expect(value.driver.calls.connect).toBe(0);
		expect(value.store.receiptWrites).toBe(0);
	});

	it("validates, clones, and freezes the exact durable operation shape", async () => {
		const value = await fixture();
		const prepared = operationFor(value, "prepared");
		const cloned = cloneExternalConnectorOperation(prepared);
		expect(Object.isFrozen(cloned)).toBe(true);
		expect(Object.isFrozen(cloned.correlation)).toBe(true);
		expect(Object.isFrozen(cloned.bindingDigest)).toBe(true);
		expect(Object.isFrozen(cloned.capabilityDigest)).toBe(true);
		expect(() =>
			cloneExternalConnectorOperation({ ...prepared, operationNonce: "https://secret.invalid" }),
		).toThrowError(FoundationError);
		expect(() => cloneExternalConnectorOperation({ ...prepared, updatedAt: "2026-08-27T00:00:00Z" })).toThrowError(
			FoundationError,
		);
		expect(() =>
			cloneExternalConnectorOperation({ ...prepared, bindingDigest: { algorithm: "sha256", value: "bad" } }),
		).toThrowError(FoundationError);
		expect(() => cloneExternalConnectorOperation({ ...prepared, reconcileReason: "unknown_reason" })).toThrowError(
			FoundationError,
		);

		const ledger = new OperationLedger();
		ledger.payload = { ...prepared, prompt: "secret" };
		const store = new SessionExternalConnectorDurableStore(ledger as unknown as SessionLedger);
		await expect(store.readOperation(prepared.attemptId)).rejects.toMatchObject({ code: "session_ledger_corrupt" });
	});

	it("pins every immutable operation fact across durable revisions", async () => {
		const value = await fixture();
		const ledger = new OperationLedger();
		const store = new SessionExternalConnectorDurableStore(ledger as unknown as SessionLedger);
		const prepared = await store.writeOperation(operationFor(value, "prepared"));
		const startIntent = transitionExternalConnectorOperation(prepared, "start_intent", { now });
		const drifts: ExternalConnectorOperation[] = [
			cloneExternalConnectorOperation({ ...startIntent, capabilityRevision: startIntent.capabilityRevision + 1 }),
			cloneExternalConnectorOperation({ ...startIntent, bindingRevision: startIntent.bindingRevision + 1 }),
			cloneExternalConnectorOperation({ ...startIntent, operationNonce: "operation-nonce-2" }),
			cloneExternalConnectorOperation({
				...startIntent,
				bindingEpochId: "binding-epoch-external-1",
				correlation: { ...startIntent.correlation, bindingEpochId: "binding-epoch-external-1" },
			}),
			cloneExternalConnectorOperation({
				...startIntent,
				correlation: { ...startIntent.correlation, laneId: "different-lane" },
			}),
		];
		for (const drift of drifts) {
			await expect(store.writeOperation(drift)).rejects.toMatchObject({ code: "session_ledger_conflict" });
		}
		const persisted = await store.writeOperation(startIntent);
		expect(Object.isFrozen(persisted)).toBe(true);
		expect(Object.isFrozen(persisted.correlation)).toBe(true);
	});

	it("rejects extra correlation fields and AgentInstance correlation before start", async () => {
		const extra = await fixture();
		persistAttempt(extra);
		const withExtra = await extra.connector.runAttempt(extra.attempt, {
			correlation: { ...correlation, rawConfig: { token: "secret" } } as unknown as ExecutionCorrelation,
		});
		expect(withExtra.ok).toBe(false);
		expect(extra.driver.calls.spawn).toBe(0);
		expect(extra.store.operationHistory).toEqual([]);

		const agent = await fixture();
		persistAttempt(agent);
		const withAgentInstance = await agent.connector.runAttempt(agent.attempt, {
			correlation: { ...correlation, agentInstanceId: "agent-instance-1" },
		});
		expect(withAgentInstance.ok).toBe(false);
		expect(agent.driver.calls.spawn).toBe(0);
		expect(agent.store.operationHistory).toEqual([]);
	});

	it("fails closed on a canonical receipt from the wrong provider for resume and cancel", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		value.store.receipts.set(value.attempt.attemptId, receiptFor(value, "wrong-provider"));

		const resumed = await value.connector.resumeAttempt(value.attempt, { correlation });
		const cancelled = await value.connector.cancelAttempt(value.attempt.attemptId);
		expect(resumed.ok).toBe(false);
		expect(cancelled.ok).toBe(false);
		expect(value.driver.calls.connect).toBe(0);
		expect(value.driver.calls.cancel).toBe(0);
	});

	it("preserves a supported protocol failure code in canonical terminal evidence", async () => {
		const value = await fixture({
			// Keep full-suite contention outside the default 1s start/event/receipt window.
			supervisionDeadlines: {
				start: { hardMs: 10_000, idleMs: 10_000 },
				event: { hardMs: 10_000, idleMs: 10_000 },
				receipt: { hardMs: 10_000, idleMs: 10_000 },
			},
		});
		persistAttempt(value);
		value.driver.evidence = terminalEvidence("succeeded", {
			status: "failed",
			error: {
				code: "external_protocol_unsupported",
				message: "vendor protocol detail",
				category: "parameter",
				retryable: true,
			},
		});

		const completed = await value.connector.runAttempt(value.attempt, { correlation });

		expect(completed.ok).toBe(true);
		if (!completed.ok) throw completed.error;
		expect(completed.value).toMatchObject({
			status: "failed",
			error: {
				code: "external_protocol_unsupported",
				message: "External connector protocol is unsupported.",
				category: "parameter",
				retryable: false,
			},
		});
	});

	it("reconciles instead of settling terminal evidence for a different external session", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.driver.evidence = terminalEvidence("succeeded", { externalSessionId: "different-session" });
		const completed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(completed.ok).toBe(false);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "mapping_conflict",
		});
		expect(value.store.operationHistory).not.toContain("terminal");
	});

	it("reconciles instead of settling terminal evidence with a different operation nonce", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "reconcile_required"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.lookupResult = {
			status: "terminal",
			evidence: terminalEvidence("succeeded", { operationNonce: "different-nonce" }),
		};
		const reconciled = await value.connector.reconcileAttempt(value.attempt, { correlation });
		expect(reconciled.ok).toBe(false);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)).toMatchObject({
			status: "reconcile_required",
			reconcileReason: "mapping_conflict",
		});
		expect(value.store.operationHistory).not.toContain("terminal");
	});

	it("rejects unknown terminal evidence fields without writing a receipt", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.driver.evidence = {
			...terminalEvidence(),
			transcript: "secret",
		} as unknown as ExternalConnectorTerminalEvidence;
		const completed = await value.connector.runAttempt(value.attempt, { correlation });
		expect(completed.ok).toBe(false);
		expect(value.store.receiptWrites).toBe(0);
		expect(value.store.operations.get(value.attempt.attemptId)?.reconcileReason).toBe("mapping_conflict");
	});

	it("accepts only the canonical safe mapping shape", () => {
		const value = {
			schemaVersion: 1,
			providerId,
			attemptId: "attempt-1",
			externalSessionId: "session-1",
			binding: { digest: fingerprintFoundationValue("binding"), revision: 1 },
			capability: { digest: fingerprintFoundationValue("capability"), revision: 1 },
			supervisor: { ref: "supervisor-1", nonce: "nonce-1" },
			createdAt: now,
		};
		expect(isCanonicalExternalConnectorMapping(value)).toBe(true);
		expect(isCanonicalExternalConnectorMapping({ ...value, url: "https://secret.invalid" })).toBe(false);
		expect(isCanonicalExternalConnectorMapping({ ...value, prompt: "secret" })).toBe(false);
		expect(isCanonicalExternalConnectorMapping({ ...value, externalSessionId: "C:\\absolute\\path" })).toBe(false);
		expect(isCanonicalExternalConnectorMapping({ ...value, createdAt: "2026-08-27T00:00:00Z" })).toBe(false);
	});

	it("bounds dispose even when the driver does not settle", async () => {
		const value = await fixture();
		value.driver.disposeHangs = true;
		const startedAt = Date.now();
		await expect(value.connector.dispose()).rejects.toMatchObject({
			code: "side_effect_unknown",
			segment: "dispose",
		});
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(value.driver.calls.dispose).toBe(1);
		expect(value.driver.disposeAbortObserved).toBe(true);
		expect(value.supervision.processController.launchCalls).toBe(0);
	});

	it("fences admission and drains a supervisor added during concurrent disposal", async () => {
		// This assertion coordinates a late supervisor admission with connector draining.
		// Keep full-suite contention outside the test-only 10 ms disposal deadline.
		const value = await fixture({
			supervisionDeadlines: { dispose: { hardMs: 1_000, idleMs: 1_000 } },
		});
		persistAttempt(value);
		value.driver.readHangs = true;
		value.driver.eventNextHangs = true;
		let markPrivateWrite: (() => void) | undefined;
		let releasePrivateWrite: (() => void) | undefined;
		const privateWriteStarted = new Promise<void>((resolve) => {
			markPrivateWrite = resolve;
		});
		value.supervision.privateStateStore.writeGate = new Promise<void>((resolve) => {
			releasePrivateWrite = resolve;
		});
		value.supervision.privateStateStore.onWrite = () => markPrivateWrite?.();
		const running = value.connector.runAttempt(value.attempt, { correlation });
		await privateWriteStarted;
		let disposalSettled = false;
		const disposal = value.connector.dispose().finally(() => {
			disposalSettled = true;
		});
		await Promise.resolve();
		expect(disposalSettled).toBe(false);

		releasePrivateWrite?.();
		await disposal;

		expect(await running).toMatchObject({ ok: false });
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toBeUndefined();
		expect(value.driver.calls.dispose).toBe(1);
		const launchCalls = value.supervision.processController.launchCalls;
		expect(await value.connector.runAttempt(value.attempt, { correlation })).toMatchObject({ ok: false });
		expect(value.supervision.processController.launchCalls).toBe(launchCalls);
	});
});
