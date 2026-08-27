import { describe, expect, it } from "vitest";
import {
	AgentOperationError,
	FoundationError,
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
} from "@aos-agent/agent-core";
import * as packageEntry from "../src/index.ts";
import {
	DurableExternalAgentConnector,
	externalConnectorAttemptId,
} from "../src/core/external-agent-connector.ts";
import type {
	ExternalConnectorDurableStore,
	ExternalConnectorOperation,
	ExternalConnectorOperationStatus,
} from "../src/core/external-agent-operation.ts";
import {
	cloneExternalConnectorOperation,
	SessionExternalConnectorDurableStore,
	transitionExternalConnectorOperation,
} from "../src/core/external-agent-operation.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMapping,
	type CanonicalExternalConnectorMapping,
} from "../src/core/external-session-mapping.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const now = "2026-08-27T00:00:00.000Z";
const providerId = "third-party-connector";
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

function capability(resume = true, revision = 1): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision,
		protocol: { name: "third-party-protocol", version: "1" },
		modelAccess: "agent_owned",
		resume,
		toolGateway: false,
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
	readonly calls = { spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 };
	readonly spawnStates: Array<ExternalConnectorOperationStatus | undefined> = [];
	store: FakeStore | undefined;
	spawnFailure = false;
	spawnGate: Promise<void> | undefined;
	onSpawn: (() => void) | undefined;
	readFailure = false;
	readHangs = false;
	eventNextHangs = false;
	disposeHangs = false;
	disposeAbortObserved = false;
	eventValues: FoundationJsonValue[] = [];
	evidence: ExternalConnectorTerminalEvidence = terminalEvidence();
	cancelEvidence: ExternalConnectorTerminalEvidence = terminalEvidence("cancelled");
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
				next: async () => this.eventNextHangs
					? new Promise<never>(() => undefined)
					: index < this.eventValues.length
						? { done: false, value: this.eventValues[index++] }
						: { done: true, value: undefined },
			}),
		};
	}

	async connect(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverHandle> {
		this.calls.connect++;
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

	async read(): Promise<ExternalConnectorTerminalEvidence> {
		this.calls.read++;
		if (this.readFailure) throw new Error("injected read failure");
		if (this.readHangs) await new Promise<void>(() => undefined);
		return this.evidence;
	}

	async write(_handle: ExternalConnectorDriverHandle, _request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.calls.write++;
	}

	async heartbeat(): Promise<void> {
		this.calls.heartbeat++;
	}

	async cancel(): Promise<ExternalConnectorTerminalEvidence> {
		this.calls.cancel++;
		return this.cancelEvidence;
	}

	async dispose(options?: { readonly signal?: AbortSignal }): Promise<void> {
		this.calls.dispose++;
		if (this.disposeHangs) {
			await new Promise<void>(() => {
				options?.signal?.addEventListener("abort", () => {
					this.disposeAbortObserved = true;
				}, { once: true });
			});
		}
	}
}

interface Fixture {
	readonly binding: AgentBinding;
	readonly store: FakeStore;
	readonly driver: FakeDriver;
	readonly connector: DurableExternalAgentConnector;
	readonly attempt: Attempt;
	readonly snapshot: ConnectorCapabilitySnapshot;
	readonly supervision: ReturnType<typeof createExternalConnectorTestSupervision>;
}

async function fixture(options: { resume?: boolean; capabilityRevision?: number } = {}): Promise<Fixture> {
	const resolvedBinding = binding();
	const snapshot = capability(options.resume ?? true, options.capabilityRevision ?? 1);
	const store = new FakeStore();
	store.bindings.set(resolvedBinding.bindingId, resolvedBinding);
	const driver = new FakeDriver();
	driver.store = store;
	const supervision = createExternalConnectorTestSupervision();
	const connector = new DurableExternalAgentConnector({
		providerId,
		capability: snapshot,
		store,
		driver,
		supervision: supervision.options,
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
	return { binding: resolvedBinding, store, driver, connector, attempt: created.value, snapshot, supervision };
}

function restartedConnector(value: Fixture): {
	readonly connector: DurableExternalAgentConnector;
	readonly driver: FakeDriver;
} {
	const driver = new FakeDriver();
	driver.store = value.store;
	const supervision = createExternalConnectorTestSupervision();
	return {
		driver,
		connector: new DurableExternalAgentConnector({
			providerId,
			capability: value.snapshot,
			store: value.store,
			driver,
			supervision: supervision.options,
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
		operationNonce: "operation-nonce-1",
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
	const handle = value.supervision.processController.launch({
		supervisorRef: mapping.supervisor.ref,
		operationNonce: mapping.supervisor.nonce,
		detached: false,
		containment: value.supervision.options.containment,
	});
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

describe("durable ExternalAgentConnector lifecycle", () => {
	it("keeps createAttempt pure and enforces persist-before-start", async () => {
		const value = await fixture();
		expect(value.store.reads).toBe(0);
		expect(value.store.operationHistory).toEqual([]);
		expect(value.driver.calls).toEqual({ spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 });

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
		expect(restarted.driver.calls).toEqual({ spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 });

		const replayed = await restarted.connector.reconcileAttempt(value.attempt, { correlation });

		expect(replayed).toEqual({ ok: true, value: value.store.receipts.get(value.attempt.attemptId) });
		expect(value.store.operationHistory).toEqual(["terminal"]);
		expect(restarted.driver.calls).toEqual({ spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 });
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
		if (!resumed.ok) expect(resumed.error.code).toBe("unsupported_feature");
		expect(value.driver.calls.connect).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
	});

	it("propagates supervised resume event failures through the same Attempt receipt", async () => {
		const value = await fixture();
		persistAttempt(value);
		value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
		value.store.mappings.set(value.attempt.attemptId, mappingFor(value));
		await persistSupervisorIdentity(value);
		value.driver.eventValues = [{
			schemaVersion: 1,
			type: "progress",
			externalSessionId: value.driver.handle.externalSessionId,
			...(value.driver.handle.externalTurnId === undefined
				? {}
				: { externalTurnId: value.driver.handle.externalTurnId }),
			sequence: 1,
			producedAt: now,
		}];
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
		expect(value.driver.calls).toEqual({ spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 });
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
		expect(restarted.driver.calls).toEqual({ spawn: 0, events: 0, connect: 0, lookup: 0, read: 0, write: 0, heartbeat: 0, cancel: 0, dispose: 0 });
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
		expect(value.supervision.processController.forceCalls).toBe(1);
		expect(value.driver.calls.spawn).toBe(0);
		expect(await value.supervision.privateStateStore.read(value.attempt.attemptId)).toMatchObject({
			reference: { operationNonce: "operation-nonce-1" },
			processIdentity: { pid: 20_000, startToken: "start-20000" },
		});
		expect(value.store.operations.get(value.attempt.attemptId)?.status).toBe("reconcile_required");
	});

	it("never launches a replacement supervisor during resume, reconcile, or cancellation recovery", async () => {
		for (const recovery of ["resume", "reconcile", "cancel"] as const) {
			const value = await fixture();
			persistAttempt(value);
			value.store.operations.set(value.attempt.attemptId, operationFor(value, "running"));
			value.store.mappings.set(value.attempt.attemptId, mappingFor(value));

			const result = recovery === "resume"
				? await value.connector.resumeAttempt(value.attempt, { correlation })
				: recovery === "reconcile"
					? await value.connector.reconcileAttempt(value.attempt, { correlation })
					: await value.connector.cancelAttempt(value.attempt.attemptId);

			expect(result.ok).toBe(false);
			expect(value.supervision.processController.launchCalls).toBe(0);
			expect(value.driver.calls).toMatchObject({ spawn: 0, connect: 0, lookup: 0, cancel: 0 });
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
		expect(value.driver.calls.connect).toBe(0);
		expect(value.driver.calls.spawn).toBe(0);
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
			expect(() => cloneExternalConnectorOperation({ ...prepared, ...injected })).toThrowError(
				FoundationError,
			);
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
		expect(() => cloneExternalConnectorOperation({ ...prepared, operationNonce: "https://secret.invalid" })).toThrowError(FoundationError);
		expect(() => cloneExternalConnectorOperation({ ...prepared, updatedAt: "2026-08-27T00:00:00Z" })).toThrowError(FoundationError);
		expect(() => cloneExternalConnectorOperation({ ...prepared, bindingDigest: { algorithm: "sha256", value: "bad" } })).toThrowError(FoundationError);
		expect(() => cloneExternalConnectorOperation({ ...prepared, reconcileReason: "unknown_reason" })).toThrowError(FoundationError);

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
});
