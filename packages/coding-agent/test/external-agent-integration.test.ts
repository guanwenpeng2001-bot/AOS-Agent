import {
	createConnectorCapabilitySnapshot,
	InMemorySessionStorage,
	Session,
	SessionLedger,
	SessionT5Ledger,
	fingerprintFoundationValue,
	validateAttempt,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	createExternalConnectorRegistry,
	executeExternalConnectorProductRun,
	type CanonicalExternalAgentInput,
} from "../src/index.ts";
import { createDurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";
import type {
	ExternalModelProjectionField,
	ExternalModelSupportMatrix,
} from "../src/core/external-model-projection.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

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

function exactModelSupportMatrix(
	unsupportedField?: ExternalModelProjectionField,
): ExternalModelSupportMatrix {
	const exact = (targetField: string, field: ExternalModelProjectionField) =>
		unsupportedField === field
			? { supported: false as const }
			: {
					supported: true as const,
					targetField,
					accepts: (value: string) => value.length > 0,
					translate: (value: string) => ({ kind: "exact" as const, value }),
				};
	return {
		provider: exact("vendorProvider", "provider"),
		model: exact("vendorModel", "model"),
		effort: exact("vendorEffort", "effort"),
		serviceTier: exact("vendorServiceTier", "serviceTier"),
		fallbackDecision: exact("vendorFallbackDecision", "fallbackDecision"),
		bindingDigest: exact("vendorBindingDigest", "bindingDigest"),
	};
}

class FixtureDriver implements ExternalConnectorVendorDriver {
	spawnedAttempt: Attempt | undefined;
	spawnedRequest: ExternalConnectorDriverSpawnRequest | undefined;
	terminalError: ExternalConnectorTerminalEvidence["error"];
	cancelCalls = 0;
	disposeCalls = 0;
	lookupCalls = 0;
	readonly #matrix: ExternalModelSupportMatrix | undefined;
	readonly #throwOnMatrixRead: boolean;
	readonly eventValues: readonly FoundationJsonValue[];

	constructor(
		matrix?: ExternalModelSupportMatrix,
		throwOnMatrixRead = false,
		eventValues: readonly FoundationJsonValue[] = [],
	) {
		this.#matrix = matrix;
		this.#throwOnMatrixRead = throwOnMatrixRead;
		this.eventValues = eventValues;
	}

	get modelSupportMatrix(): ExternalModelSupportMatrix | undefined {
		if (this.#throwOnMatrixRead) throw new Error("model matrix must not be inspected");
		return this.#matrix;
	}

	readonly handle: ExternalConnectorDriverHandle = {
		externalSessionId: "external-session",
		externalTurnId: "external-turn",
		supervisorRef: "supervisor-ref",
		operationNonce: "operation-nonce",
	};

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnedAttempt = request.attempt;
		this.spawnedRequest = request;
		return {
			...this.handle,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(): AsyncIterable<FoundationJsonValue> {
		for (const value of this.eventValues) yield value;
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
			status: this.terminalError === undefined ? "succeeded" : "failed",
			artifacts: [],
			...(this.terminalError === undefined ? {} : { error: this.terminalError }),
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
	readonly unsupportedModelField?: ExternalModelProjectionField;
	readonly throwOnModelMatrixRead?: boolean;
	readonly eventValues?: readonly FoundationJsonValue[];
	readonly supervisionLimits?: {
		readonly maxEvents?: number;
		readonly maxEventsPerWindow?: number;
		readonly eventRateWindowMs?: number;
		readonly maxItemBytes?: number;
		readonly maxTotalBytes?: number;
		readonly maxArtifactRefs?: number;
	};
} = {}) {
	const session = new Session(new InMemorySessionStorage({ id: "external-product-session", createdAt: 1 }));
	const t5 = new SessionT5Ledger(session, { ownerId: "external-product-test" });
	const store = new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: t5.writer }));
	const driver = new FixtureDriver(
		options.modelAccess === "aos_gateway" ? exactModelSupportMatrix(options.unsupportedModelField) : undefined,
		options.throwOnModelMatrixRead,
		options.eventValues,
	);
	const snapshot = capability(options);
	const supervision = createExternalConnectorTestSupervision();
	const connector = createDurableExternalAgentConnector({
		providerId: PROVIDER_ID,
		capability: snapshot,
		store,
		driver,
		supervision: {
			...supervision.options,
			...(options.supervisionLimits === undefined ? {} : { limits: options.supervisionLimits }),
		},
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
	return { session, t5, driver, connector, registry, descriptor, supervision };
}

describe("T4 final acceptance: External Connector product integration", () => {
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
		const trace = JSON.stringify(records);
		expect(trace).not.toContain("agent_instance");
		expect(trace).not.toContain("agentInstanceId");
		const types = records.flatMap((record) => "objectType" in record ? [record.objectType] : []);
		expect(types.indexOf("attempt")).toBeLessThan(types.indexOf("external_connector_operation"));
		for (const objectType of [
			"attempt",
			"external_connector_mapping",
			"attempt_receipt",
			"task_result",
			"run_receipt",
		]) {
			expect(types.filter((type) => type === objectType)).toHaveLength(1);
		}
	});

	it("redacts untrusted vendor errors before canonical and durable settlement", async () => {
		const canaries = [
			"connector-secret-canary",
			"connector-credential-canary",
			"connector-url-canary",
			"connector-path-canary",
			"connector-prompt-canary",
			"connector-transcript-canary",
		];
		const current = await fixture();
		current.driver.terminalError = {
			code: "external_vendor_failure",
			message: [
				`secret=${canaries[0]}`,
				`credential=${canaries[1]}`,
				`url=https://vendor.example/${canaries[2]}?token=unsafe`,
				`path=C:\\Users\\operator\\${canaries[3]}.txt`,
				`prompt=${canaries[4]}`,
				`transcript=${canaries[5]}`,
			].join("\n"),
			category: "transient",
			retryable: true,
		};
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "redact terminal evidence",
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
			runId: "run-external-error-redaction",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			now: () => NOW,
		});
		const expectedError = {
			code: "external_vendor_failure",
			message: [
				"secret=[redacted]",
				"credential=[redacted]",
				"url=[redacted-url]",
				"path=[redacted-path]",
				"prompt=[redacted]",
				"transcript=[redacted]",
			].join("\n"),
			category: "transient" as const,
			retryable: true,
		};
		expect(execution.attemptReceipt.error).toEqual(expectedError);
		expect(execution.runReceipt.terminalErrorCode).toBe(expectedError.code);
		expect(execution.runReceipt.terminalError).toEqual(expectedError);

		const publicTrace = JSON.stringify({
			attemptReceipt: execution.attemptReceipt,
			taskResult: execution.taskResult,
			runReceipt: execution.runReceipt,
		});
		const durableTrace = JSON.stringify(await current.session.findFoundationRecords({ order: "oldestFirst" }));
		for (const canary of canaries) {
			expect(publicTrace).not.toContain(canary);
			expect(durableTrace).not.toContain(canary);
		}
		expect(durableTrace).toContain(expectedError.code);
	});

	for (const testCase of [
		{
			name: "invalid event",
			code: "external_event_invalid",
			message: "External connector emitted invalid supervised output.",
			eventValues: [{
				schemaVersion: 1,
				type: "progress",
				externalSessionId: "external-session",
				externalTurnId: "external-turn",
				sequence: 1,
				producedAt: NOW,
			}],
			supervisionLimits: undefined,
		},
		{
			name: "event resource limit",
			code: "external_resource_limit_exceeded",
			message: "External connector exceeded a supervised resource limit.",
			eventValues: [
				{
					schemaVersion: 1,
					type: "started",
					externalSessionId: "external-session",
					externalTurnId: "external-turn",
					producedAt: NOW,
				},
				{
					schemaVersion: 1,
					type: "progress",
					externalSessionId: "external-session",
					externalTurnId: "external-turn",
					sequence: 1,
					producedAt: NOW,
				},
			],
			supervisionLimits: { maxEvents: 1 },
		},
	] as const) {
		it(`propagates ${testCase.name} through AttemptReceipt and RunReceipt terminalError`, async () => {
			const current = await fixture({
				eventValues: testCase.eventValues,
				...(testCase.supervisionLimits === undefined ? {} : { supervisionLimits: testCase.supervisionLimits }),
			});
			const canonicalInput: CanonicalExternalAgentInput = {
				schemaVersion: 1,
				text: "validate supervised terminal propagation",
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
				runId: `run-${testCase.code}`,
				message: canonicalInput.text,
				canonicalInput,
				inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
				workspace: "workspace-ref",
				now: () => NOW,
			});
			expect(execution.attemptReceipt.status).toBe("failed");
			expect(execution.attemptReceipt.error).toEqual({
				code: testCase.code,
				message: testCase.message,
				category: "side_effect_unknown",
				retryable: false,
			});
			expect(execution.runReceipt.terminalStatus).toBe("failed");
			expect(execution.runReceipt.terminalError).toEqual(execution.attemptReceipt.error);
		});
	}

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
		const restartedSupervision = createExternalConnectorTestSupervision();
		const restarted = createDurableExternalAgentConnector({
			providerId: PROVIDER_ID,
			capability: capability(),
			store: new SessionExternalConnectorDurableStore(new SessionLedger(current.session, { writer: current.t5.writer })),
			driver: restartedDriver,
			supervision: restartedSupervision.options,
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

	it("rejects unsafe product resources before Goal, Task, Attempt, process, or driver side effects", async () => {
		const artifactId = "2".repeat(64);
		const validArtifact = {
			schemaVersion: 1 as const,
			artifactId,
			kind: "image" as const,
			digest: `sha256:${artifactId}` as const,
			mediaType: "image/png",
			sizeBytes: 3,
			provenance: { source: "artifact_store" as const, producer: "fixture", trust: "trusted" as const },
			readHandle: { kind: "artifact_store" as const, ref: artifactId },
		};
		const cases: Array<{
			readonly name: string;
			readonly input: unknown;
			readonly code: string;
			readonly capabilities?: { readonly artifacts?: boolean; readonly images?: boolean };
		}> = [
			{
				name: "raw URL",
				input: { schemaVersion: 1, text: "raw", artifacts: [{ ...validArtifact, url: "https://invalid.example" }] },
				code: "external_binding_invalid",
			},
			{
				name: "unsupported image",
				input: { schemaVersion: 1, text: "unsupported", artifacts: [validArtifact] },
				code: "external_capability_mismatch",
			},
			{
				name: "oversize image",
				input: {
					schemaVersion: 1,
					text: "oversize",
					artifacts: [{ ...validArtifact, sizeBytes: 32 * 1024 * 1024 + 1 }],
				},
				code: "external_resource_limit_exceeded",
				capabilities: { artifacts: true, images: true },
			},
			{
				name: "untrusted image",
				input: {
					schemaVersion: 1,
					text: "untrusted",
					artifacts: [{ ...validArtifact, provenance: { ...validArtifact.provenance, trust: "untrusted" } }],
				},
				code: "external_binding_invalid",
				capabilities: { artifacts: true, images: true },
			},
			{
				name: "workspace escape",
				input: {
					schemaVersion: 1,
					text: "escape",
					artifacts: [{
						...validArtifact,
						kind: "file",
						mediaType: "text/plain",
						provenance: { source: "workspace", producer: "fixture", trust: "trusted" },
						readHandle: {
							kind: "workspace_relative",
							workspaceId: "workspace-main",
							relativePath: "../escape",
							ref: "workspace-ref",
						},
					}],
				},
				code: "external_path_outside_workspace",
				capabilities: { artifacts: true, images: false },
			},
		];
		for (const testCase of cases) {
			const current = await fixture(testCase.capabilities);
			const canonicalInput = testCase.input as CanonicalExternalAgentInput;
			await expect(executeExternalConnectorProductRun({
				session: current.session,
				writer: current.t5.writer,
				registry: current.registry,
				selection: {
					providerId: current.descriptor.providerId,
					revision: current.descriptor.revision,
					capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
				},
				runId: `run-reject-${testCase.name.replaceAll(" ", "-")}`,
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
			})).rejects.toMatchObject({ code: testCase.code });
			for (const objectType of ["goal", "task", "attempt"]) {
				expect(await current.session.findFoundationRecords({ objectType })).toEqual([]);
			}
			expect(current.supervision.processController.launchCalls).toBe(0);
			expect(current.driver.spawnedAttempt).toBeUndefined();
		}
	});

	it("passes the exact AOS gateway model projection to the current driver", async () => {
		const current = await fixture({ modelAccess: "aos_gateway" });
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "use the projected gateway route",
			artifacts: [],
		};
		const bindingDigest = fingerprintFoundationValue({ bindingId: "rpc-local-model-binding" });
		await executeExternalConnectorProductRun({
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
				bindingDigest,
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
			bindingDigest,
		});
		expect(current.driver.spawnedRequest?.modelTranslation).toEqual({
			schemaVersion: 1,
			sourceBindingDigest: bindingDigest,
			fields: {
				provider: { targetField: "vendorProvider", value: "gateway-provider" },
				model: { targetField: "vendorModel", value: "gateway-model" },
				effort: { targetField: "vendorEffort", value: "medium" },
				serviceTier: { targetField: "vendorServiceTier", value: "priority" },
				fallbackDecision: {
					targetField: "vendorFallbackDecision",
					value: '{"kind":"disabled","reason":"fallback_disabled"}',
				},
				bindingDigest: {
					targetField: "vendorBindingDigest",
					value: JSON.stringify(bindingDigest),
				},
			},
		});
	});

	it("rejects an unsupported gateway field before Goal, Task, Attempt, process, or driver side effects", async () => {
		const current = await fixture({ modelAccess: "aos_gateway", unsupportedModelField: "serviceTier" });
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "reject unsupported translation",
			artifacts: [],
		};
		await expect(executeExternalConnectorProductRun({
			session: current.session,
			writer: current.t5.writer,
			registry: current.registry,
			selection: {
				providerId: current.descriptor.providerId,
				revision: current.descriptor.revision,
				capabilitySnapshotDigest: current.descriptor.capabilitySnapshotDigest,
			},
			runId: "run-external-model-unsupported",
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
				bindingDigest: fingerprintFoundationValue({ bindingId: "unsupported" }),
			},
			now: () => NOW,
		})).rejects.toMatchObject({ code: "external_binding_invalid" });
		for (const objectType of ["goal", "task", "attempt"]) {
			expect(await current.session.findFoundationRecords({ objectType })).toEqual([]);
		}
		expect(current.supervision.processController.launchCalls).toBe(0);
		expect(current.driver.spawnedAttempt).toBeUndefined();
	});

	it("does not inspect a local model support matrix for agent-owned execution", async () => {
		const current = await fixture({ throwOnModelMatrixRead: true });
		const canonicalInput: CanonicalExternalAgentInput = {
			schemaVersion: 1,
			text: "agent chooses model",
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
			runId: "run-external-agent-owned-no-matrix",
			message: canonicalInput.text,
			canonicalInput,
			inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
			workspace: "workspace-ref",
			now: () => NOW,
		});
		expect(execution.runReceipt.terminalStatus).toBe("completed");
	});
});
