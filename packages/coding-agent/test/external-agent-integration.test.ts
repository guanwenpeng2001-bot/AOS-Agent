import {
	createConnectorCapabilitySnapshot,
	InMemorySessionStorage,
	Session,
	SessionLedger,
	SessionT5Ledger,
	validateAttempt,
	type Attempt,
	type ConnectorCapabilitySnapshot,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	createDurableExternalAgentConnector,
	createExternalConnectorRegistry,
	executeExternalConnectorProductRun,
	type CanonicalExternalAgentInput,
} from "../src/index.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const PROVIDER_ID = "fixture.external-connector";

function capability(options: {
	readonly artifacts?: boolean;
	readonly images?: boolean;
	readonly modelAccess?: "agent_owned" | "aos_gateway";
} = {}): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		revision: 1,
		protocol: { name: "fixture", version: "1" },
		modelAccess: options.modelAccess ?? "agent_owned",
		resume: false,
		toolGateway: false,
		artifacts: options.artifacts ?? false,
		images: options.images ?? false,
	});
}

class FixtureDriver implements ExternalConnectorVendorDriver {
	spawnedAttempt: Attempt | undefined;
	spawnedRequest: ExternalConnectorDriverSpawnRequest | undefined;
	cancelCalls = 0;
	disposeCalls = 0;
	lookupCalls = 0;

	readonly handle: ExternalConnectorDriverHandle = {
		externalSessionId: "external-session",
		externalTurnId: "external-turn",
		supervisorRef: "supervisor-ref",
		operationNonce: "operation-nonce",
	};

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnedAttempt = request.attempt;
		this.spawnedRequest = request;
		return { ...this.handle, operationNonce: request.operationNonce };
	}

	events(): AsyncIterable<never> {
		return {
			[Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
		};
	}

	async connect(): Promise<ExternalConnectorDriverHandle> {
		return this.handle;
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		this.lookupCalls += 1;
		return { status: "missing" };
	}

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		return {
			externalSessionId: handle.externalSessionId,
			externalTurnId: handle.externalTurnId,
			operationNonce: handle.operationNonce,
			status: "succeeded",
			artifacts: [],
			sideEffectState: "none",
			producedAt: NOW,
		};
	}

	async write(_handle: ExternalConnectorDriverHandle, _request: ExternalConnectorDriverWriteRequest): Promise<void> {}
	async heartbeat(): Promise<void> {}

	async cancel(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		this.cancelCalls += 1;
		return {
			externalSessionId: handle.externalSessionId,
			externalTurnId: handle.externalTurnId,
			operationNonce: handle.operationNonce,
			status: "cancelled",
			artifacts: [],
			sideEffectState: "none",
			producedAt: NOW,
		};
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
	}
}

async function fixture(options: {
	readonly artifacts?: boolean;
	readonly images?: boolean;
	readonly modelAccess?: "agent_owned" | "aos_gateway";
} = {}) {
	const session = new Session(new InMemorySessionStorage({ id: "external-product-session", createdAt: 1 }));
	const t5 = new SessionT5Ledger(session, { ownerId: "external-product-test" });
	const store = new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: t5.writer }));
	const driver = new FixtureDriver();
	const snapshot = capability(options);
	const connector = createDurableExternalAgentConnector({
		providerId: PROVIDER_ID,
		capability: snapshot,
		store,
		driver,
		now: () => NOW,
		operationNonce: () => "operation-nonce",
	});
	const registry = createExternalConnectorRegistry();
	const descriptor = {
		schemaVersion: 1 as const,
		providerId: PROVIDER_ID,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
	const registered = await registry.register({
		descriptor,
		connector,
		trusted: true,
		...(!snapshot.artifacts && !snapshot.images && snapshot.modelAccess !== "aos_gateway" ? {} : {
			capabilityEvidence: {
				...(snapshot.artifacts ? {
					artifacts: {
						declaration: { id: "fixture.artifacts", revision: 1, reachable: true as const },
						handler: { id: "fixture.artifacts.handler", invoke: () => undefined },
					},
				} : {}),
				...(snapshot.images ? {
					images: {
						declaration: { id: "fixture.images", revision: 1, reachable: true as const },
						handler: { id: "fixture.images.handler", invoke: () => undefined },
					},
				} : {}),
				...(snapshot.modelAccess === "aos_gateway" ? {
					aosGateway: {
						declaration: { id: "fixture.model-gateway", revision: 1, reachable: true as const },
						handler: { id: "fixture.model-gateway.handler", invoke: () => undefined },
					},
				} : {}),
			},
		}),
	});
	if (!registered.ok) throw registered.error;
	return { session, t5, driver, connector, registry, descriptor };
}

describe("External Connector product integration", () => {
	it("runs Task -> Dispatch -> Attempt -> AttemptReceipt -> TaskResult -> RunReceipt without AgentInstance", async () => {
		const current = await fixture();
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "execute externally",
			artifacts: [],
		};
		const execution = await executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-product",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			now: () => NOW,
		});

		expect(current.driver.spawnedAttempt?.attemptId).toBe(execution.attemptReceipt.attemptId);
		expect(current.driver.spawnedRequest?.input).toEqual(canonicalInput);
		expect(execution.attemptReceipt.provenance.producerKind).toBe("external_connector");
		expect(execution.taskResult.sourceAttemptReceiptIds).toEqual([execution.attemptReceipt.attemptReceiptId]);
		expect(execution.runReceipt.taskResultId).toBe(execution.taskResult.taskResultId);
		expect(execution.runReceipt.terminalStatus).toBe("completed");
		expect(execution.initialBindingEpoch.agentInstanceId).toBeUndefined();
		expect(current.driver.spawnedAttempt?.agentInstanceId).toBeUndefined();
		const instances = await current.session.findFoundationRecords({ objectType: "agent_instance" });
		expect(instances).toEqual([]);

		const records = await current.session.findFoundationRecords({ order: "oldestFirst" });
		const types = records.flatMap((record) => "objectType" in record ? [record.objectType] : []);
		expect(types.indexOf("attempt")).toBeLessThan(types.indexOf("external_connector_operation"));
		expect(types).toContain("attempt_receipt");
		expect(types).toContain("task_result");
		expect(types).toContain("run_receipt");
	});

	it("fails closed when current connector capability identity drifts", async () => {
		const current = await fixture();
		const selected = await current.registry.select({
			providerId: current.descriptor.providerId,
			revision: current.descriptor.revision,
			capabilitySnapshotDigest: { algorithm: "sha256", value: "0".repeat(64) },
		});
		expect(selected.ok).toBe(false);
	});

	it("restarts from the durable canonical receipt without another driver side effect", async () => {
		const current = await fixture();
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "persist before restart",
			artifacts: [],
		};
		const execution = await executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-restart",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			now: () => NOW,
		});
		const attempts = await current.session.findFoundationRecords({ objectType: "attempt" });
		const durableAttempt = attempts.at(-1);
		if (durableAttempt === undefined || durableAttempt.kind !== "fact") throw new Error("missing durable Attempt");
		const checkedAttempt = validateAttempt(durableAttempt.payload);
		if (!checkedAttempt.ok) throw checkedAttempt.error;
		const restartedDriver = new FixtureDriver();
		const restarted = createDurableExternalAgentConnector({
			providerId: PROVIDER_ID,
			capability: capability(),
			store: new SessionExternalConnectorDurableStore(new SessionLedger(current.session, { writer: current.t5.writer })),
			driver: restartedDriver,
			now: () => NOW,
			operationNonce: () => "new-operation-nonce-must-not-be-used",
		});
		const correlation = execution.attemptReceipt.provenance.correlation;
		if (correlation === undefined) throw new Error("missing receipt correlation");
		const replayed = await restarted.reconcileAttempt(checkedAttempt.value, { correlation });
		expect(replayed).toEqual({ ok: true, value: execution.attemptReceipt });
		expect(restartedDriver.spawnedAttempt).toBeUndefined();
		expect(restartedDriver.lookupCalls).toBe(0);
	});

	it("keeps cancellation idempotent after canonical terminal settlement", async () => {
		const current = await fixture();
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "complete before cancellation",
			artifacts: [],
		};
		const execution = await executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-cancel-after-terminal",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			now: () => NOW,
		});
		expect(await current.connector.cancelAttempt(execution.attemptReceipt.attemptId)).toEqual({ ok: true, value: undefined });
		expect(current.driver.cancelCalls).toBe(0);
		expect(await current.session.findFoundationRecords({ objectType: "run_receipt" })).toHaveLength(1);
	});

	it("forwards only admitted artifact and image references to the current driver", async () => {
		const current = await fixture({ artifacts: true, images: true });
		const digestValue = "1".repeat(64);
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "inspect the image reference",
			artifacts: [{
				schemaVersion: 1,
				artifactId: digestValue,
				kind: "image",
				digest: `sha256:${digestValue}`,
				mediaType: "image/png",
				sizeBytes: 3,
				provenance: { source: "artifact_store", producer: "fixture", trust: "trusted" },
				readHandle: { kind: "artifact_store", ref: digestValue },
			}],
		};
		await executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-artifact-input",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: {
				inspectArtifact: (reference) => ({
					artifactId: reference.artifactId,
					ref: reference.readHandle.ref,
					digest: reference.digest,
					mediaType: reference.mediaType,
					sizeBytes: reference.sizeBytes,
					trusted: true,
					workspaceContained: true,
				}),
			},
			workspace: "workspace-ref",
			now: () => NOW,
		});
		expect(current.driver.spawnedRequest?.input).toEqual(canonicalInput);
	});

	it("passes the exact AOS gateway model projection to the current driver", async () => {
		const current = await fixture({ modelAccess: "aos_gateway" });
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "use the projected gateway route",
			artifacts: [],
		};
		const execution = await executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-model-gateway",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			gatewayModelRoute: {
				provider: "gateway-provider",
				model: "gateway-model",
				effort: "medium",
				serviceTier: "priority",
				fallbackDecision: { kind: "disabled", reason: "fallback_disabled" },
			},
			now: () => NOW,
		});
		expect(current.driver.spawnedRequest?.modelProjection).toEqual({
			schemaVersion: 1,
			provider: "gateway-provider",
			model: "gateway-model",
			effort: "medium",
			serviceTier: "priority",
			fallbackDecision: { kind: "disabled", reason: "fallback_disabled" },
			bindingDigest: execution.binding.fingerprint,
		});
	});
});
