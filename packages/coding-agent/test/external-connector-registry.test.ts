import {
	FoundationError,
	Result,
	createAttempt,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	executeDispatch,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type ExternalAgentConnector,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type RevisionReference,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	createExternalConnectorRegistry,
	type ExternalConnectorRegistration,
} from "../src/core/external-agent-registry.ts";
import { SchedulerExecutorRegistry } from "../src/core/scheduler-executors.ts";
import type { SchedulerExecutorEntryV1, SchedulerQueueEntryV1 } from "../src/core/scheduler.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const PROVIDER_ID = "arbitrary.zeta-connector";
const CAPABILITY: FoundationProviderCapability = { schemaVersion: 1, id: "arbitrary.zeta.execute", version: 4 };

const TASK: TaskEnvelope = {
	schemaVersion: 1,
	taskId: "task-zeta",
	goalId: "goal-zeta",
	goal: "Prove the open connector SPI",
	workspace: "workspace-zeta",
	capabilityRefs: [],
	inputs: [],
	expectedOutputs: [],
	budget: {},
	acceptanceCriteria: [],
	status: "ready",
	createdAt: NOW,
	updatedAt: NOW,
};

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-zeta",
			scope: "project",
			slug: "zeta",
			name: "Zeta",
			description: "Arbitrary connector conformance role",
			revision: 1,
			persona: "Execute through the selected connector.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-zeta", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-zeta",
		provider: "host-model",
		model: "model-zeta-1",
		budget: {},
		revision: 1,
		createdAt: NOW,
	});
	const resolved = resolveAgentBinding({
		task: TASK,
		roleRevision: role,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "context-zeta"),
		capabilityRevision: immutableFact("capability_binding", "capability-zeta"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-zeta"),
		policyRevision: immutableFact("policy_binding", "policy-zeta"),
		newBindingId: "binding-zeta",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

class ZetaConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerId = PROVIDER_ID;
	readonly providerClass = "external_connector" as const;
	#snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		revision: 17,
		protocol: { name: "murmur.mesh", version: "17" },
		modelAccess: "aos_gateway",
		resume: false,
		toolGateway: true,
		artifacts: false,
		images: false,
	});

	get snapshot(): ConnectorCapabilitySnapshot {
		return this.#snapshot;
	}

	drift(): void {
		const { digest: _digest, ...snapshot } = this.#snapshot;
		this.#snapshot = createConnectorCapabilitySnapshot({
			...snapshot,
			revision: this.#snapshot.revision + 1,
		});
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [CAPABILITY];
	}

	async probeCapabilities(): Promise<Result<ConnectorCapabilitySnapshot, FoundationError>> {
		return Result.ok(this.#snapshot);
	}

	async createAttempt(
		dispatch: Dispatch,
		agentBinding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<Result<Attempt, FoundationError>> {
		if (context === undefined || agentBinding.taskId !== dispatch.taskId || agentBinding.bindingId !== dispatch.bindingId) {
			return Result.err(new FoundationError("invalid_correlation", "Zeta connector requires the selected Binding and initial epoch."));
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: () => NOW,
		});
	}

	async runAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		return Result.ok(this.receipt(attempt, options));
	}

	async resumeAttempt(
		_attempt: Attempt,
		_options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		return Result.err(new FoundationError("unsupported_feature", "Zeta connector does not advertise resume."));
	}

	async reconcileAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		return Result.ok(this.receipt(attempt, options));
	}

	async cancelAttempt(_attemptId: string): Promise<Result<void, FoundationError>> {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}

	private receipt(attempt: Attempt, options?: FoundationProviderExecutionOptions): AttemptReceipt {
		const bindingEpochId = attempt.bindingEpochIds[0];
		if (bindingEpochId === undefined) throw new FoundationError("invalid_correlation", "Zeta Attempt requires a BindingEpoch.");
		const attemptReceiptId = `receipt-${attempt.attemptId}`;
		return {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: NOW,
				correlation: {
					...(options?.correlation ?? { sessionId: "session-zeta", laneId: "main", revision: 1 }),
					taskId: attempt.taskId,
					dispatchId: attempt.dispatchId,
					attemptId: attempt.attemptId,
					bindingId: attempt.bindingId,
					bindingEpochId,
					attemptReceiptId,
				},
			},
			sideEffectState: "none",
		};
	}
}

function evidence() {
	return {
		toolGateway: {
			declaration: { id: "zeta.tool-gateway", revision: 3, reachable: true as const },
			handler: { id: "zeta.tool-gateway-handler", invoke: () => undefined },
		},
		aosGateway: {
			declaration: { id: "zeta.model-gateway", revision: 5, reachable: true as const },
			handler: { id: "zeta.model-gateway-handler", invoke: () => undefined },
		},
	};
}

function registration(connector: ZetaConnector): ExternalConnectorRegistration {
	return {
		descriptor: {
			schemaVersion: 1,
			providerId: connector.providerId,
			providerClass: "external_connector",
			revision: connector.snapshot.revision,
			capabilitySnapshotDigest: connector.snapshot.digest,
		},
		connector,
		trusted: true,
		capabilityEvidence: evidence(),
	};
}

function expectSafeRegistryProbeFailure(
	error: FoundationError,
	expectedMessage: string,
	forbiddenValues: readonly string[],
): void {
	expect(error.code).toBe("task_executor_invalid_provider_class");
	expect(error.message).toBe(expectedMessage);
	expect(error.cause).toBeUndefined();
	expect(error.details).toBeUndefined();

	const exposedSurfaces = [
		...Object.getOwnPropertyNames(error).map((property) => `${property}:${String(Reflect.get(error, property))}`),
		JSON.stringify(error),
		String(error.cause),
		error.message,
		JSON.stringify(error.details),
		JSON.stringify(error.redact()),
		JSON.stringify(error.toPublicExecutionError()),
	].join("\n");
	for (const forbiddenValue of forbiddenValues) {
		expect(exposedSurfaces).not.toContain(forbiddenValue);
	}
}

describe("ExternalConnectorRegistry open SPI", () => {
	it("registers and selects an arbitrary connector, then schedules, runs, and settles its Attempt", async () => {
		const connector = new ZetaConnector();
		const executor: TaskExecutorProvider = connector;
		expect(executor.providerClass).toBe("external_connector");

		const registry = createExternalConnectorRegistry();
		const registered = await registry.register(registration(connector));
		expect(registered.ok).toBe(true);
		expect(registry.list()).toEqual([registration(connector).descriptor]);

		const selected = await registry.select({
			providerId: connector.providerId,
			revision: connector.snapshot.revision,
			capabilitySnapshotDigest: connector.snapshot.digest,
		});
		if (!selected.ok) throw selected.error;
		expect(selected.value.connector).toBe(connector);
		expect(selected.value.capabilityTruth.evidence).toMatchObject({
			toolGateway: { handlerId: "zeta.tool-gateway-handler" },
			aosGateway: { handlerId: "zeta.model-gateway-handler" },
		});

		const scheduler = new SchedulerExecutorRegistry();
		const entry: SchedulerExecutorEntryV1 = {
			schemaVersion: 1,
			descriptor: { schemaVersion: 1, providerId: connector.providerId, providerClass: "external_connector" },
			capabilities: [CAPABILITY],
			costClass: "remote_paid",
			registeredAt: NOW,
		};
		expect((await scheduler.register({ entry, provider: selected.value.connector, trusted: true, latencyMs: 0 })).ok).toBe(true);
		const queueEntry: SchedulerQueueEntryV1 = {
			schemaVersion: 1,
			queueEntryId: "queue-zeta",
			sessionId: "session-zeta",
			taskId: TASK.taskId,
			state: "queued",
			priority: 1,
			attemptsUsed: 0,
			enqueuedAt: NOW,
			revision: 0,
		};
		const scheduled = await scheduler.select({
			queueEntry,
			requiredCapabilities: [CAPABILITY],
			decidedAt: NOW,
		});
		if (!scheduled.ok) throw scheduled.error;
		expect(scheduled.value.provider).toBe(connector);

		const dispatch: Dispatch = {
			schemaVersion: 1,
			dispatchId: "dispatch-zeta",
			taskId: TASK.taskId,
			bindingId: "binding-zeta",
			taskExecutorProviderId: connector.providerId,
			status: "pending",
			createdAt: NOW,
		};
		const epochResult = createBindingEpoch({
			bindingEpochId: "epoch-zeta",
			taskId: TASK.taskId,
			attemptId: "attempt-zeta",
			bindingId: dispatch.bindingId,
			activationReason: "attempt_started",
			activatedByCommandId: dispatch.dispatchId,
			now: () => NOW,
		});
		if (!epochResult.ok) throw epochResult.error;
		const settled = await executeDispatch({
			dispatch,
			binding: binding(),
			initialBindingEpoch: epochResult.value,
			provider: scheduled.value.provider,
			correlation: {
				sessionId: "session-zeta",
				laneId: "main",
				taskId: TASK.taskId,
				dispatchId: dispatch.dispatchId,
				attemptId: epochResult.value.attemptId,
				bindingId: dispatch.bindingId,
				bindingEpochId: epochResult.value.bindingEpochId,
				revision: 1,
			},
		});
		expect(settled.ok).toBe(true);
		if (settled.ok) {
			expect(settled.value.attempt.providerId).toBe(PROVIDER_ID);
			expect(settled.value.receipt).toMatchObject({
				providerId: PROVIDER_ID,
				status: "succeeded",
				provenance: { producerKind: "external_connector" },
			});
		}
	});

	it("normalizes thrown and returned probe failures without exposing connector error data", async () => {
		const rawExceptionText = "raw vendor exception text 9f4d";
		const credential = "credential-registry-canary";
		const token = "sk-registry-token-canary";
		const path = "C:\\vendor-private\\connector\\credentials.json";
		const url = "https://user:password@vendor.invalid/probe?token=registry-canary";
		const vendorPayload = "vendor-payload-registry-canary";
		const forbiddenValues = [rawExceptionText, credential, token, path, url, vendorPayload];
		const thrownError = Object.assign(
			new Error(`${rawExceptionText}; ${credential}; ${token}; ${path}; ${url}; ${vendorPayload}`),
			{ credential, token, path, url, vendorPayload: { body: vendorPayload } },
		);

		const assertProbeFailure = async (
			probeCapabilities: () => Promise<Result<ConnectorCapabilitySnapshot, FoundationError>>,
			expectedMessage: string,
			sourceError: Error,
		): Promise<void> => {
			const connector = new ZetaConnector();
			Object.defineProperty(connector, "probeCapabilities", { value: probeCapabilities });
			const registry = createExternalConnectorRegistry();
			const result = await registry.register(registration(connector));

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).not.toBe(sourceError);
			expectSafeRegistryProbeFailure(result.error, expectedMessage, forbiddenValues);
		};

		await assertProbeFailure(
			async () => {
				throw thrownError;
			},
			"External connector threw while probing capabilities.",
			thrownError,
		);

		const returnedError = new FoundationError("provider_spawn_failed", rawExceptionText, {
			cause: thrownError,
			details: { credential, token, path, url, vendorPayload },
		});
		await assertProbeFailure(
			async () => Result.err(returnedError),
			"External connector capability probe failed.",
			returnedError,
		);
	});

	it("fails closed on untrusted, mismatched, unknown, and drifted connector facts", async () => {
		const connector = new ZetaConnector();
		const base = registration(connector);
		for (const invalid of [
			{ ...base, trusted: false },
			{ ...base, descriptor: { ...base.descriptor, providerClass: "agent" } },
			{ ...base, descriptor: { ...base.descriptor, providerId: "other.connector" } },
			{ ...base, descriptor: { ...base.descriptor, revision: base.descriptor.revision + 1 } },
			{
				...base,
				descriptor: {
					...base.descriptor,
					capabilitySnapshotDigest: fingerprintFoundationValue("wrong-digest"),
				},
			},
			{ ...base, capabilityEvidence: undefined },
		]) {
			const registry = createExternalConnectorRegistry();
			expect(await registry.register(invalid as unknown as ExternalConnectorRegistration)).toMatchObject({ ok: false });
			expect(registry.list()).toEqual([]);
		}
		const malformedProbe = new ZetaConnector();
		Object.defineProperty(malformedProbe, "probeCapabilities", {
			value: async () => ({ ok: true, value: malformedProbe.snapshot, unknown: true }),
		});
		const malformedRegistry = createExternalConnectorRegistry();
		expect(await malformedRegistry.register(registration(malformedProbe))).toMatchObject({ ok: false });
		expect(malformedRegistry.list()).toEqual([]);

		const registry = createExternalConnectorRegistry();
		expect((await registry.register(base)).ok).toBe(true);
		const selection = {
			providerId: base.descriptor.providerId,
			revision: base.descriptor.revision,
			capabilitySnapshotDigest: base.descriptor.capabilitySnapshotDigest,
		};
		expect(await registry.select({ ...selection, providerId: "unknown.connector" })).toMatchObject({ ok: false });
		expect(await registry.select({ ...selection, revision: selection.revision + 1 })).toMatchObject({ ok: false });
		expect(
			await registry.select({
				...selection,
				capabilitySnapshotDigest: fingerprintFoundationValue("wrong-selection"),
			}),
		).toMatchObject({ ok: false });
		connector.drift();
		expect(await registry.select(selection)).toMatchObject({ ok: false });
	});
});
