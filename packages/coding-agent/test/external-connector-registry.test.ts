import {
	FoundationError,
	InMemorySessionStorage,
	LayeredResultSettlement,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	fingerprintFoundationValue,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type ExecutionCorrelation,
	type ExternalAgentConnector,
	type FoundationProviderExecutionOptions,
	type FoundationJsonValue,
	type Result as ResultValue,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import { createDurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
} from "../src/core/execution-policy.ts";
import {
	createExternalConnectorRegistry,
	type ExternalConnectorRegistration,
} from "../src/core/external-agent-registry.ts";
import {
	executeExternalConnectorProductRun,
	persistExternalConnectorProductRunAfterAcceptance,
	preflightExternalConnectorProductRecovery,
	prepareExternalConnectorProductRun,
	type ExternalConnectorProductExecutionInput,
} from "../src/core/external-connector-product.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const PROVIDER_ID = "third-party.zeta-connector";
let supervisedFixtureId = 0;

function capabilitySnapshot(
	options: {
		readonly providerId?: string;
		readonly toolGateway?: boolean;
		readonly modelAccess?: "agent_owned" | "aos_gateway";
	} = {},
): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: options.providerId ?? PROVIDER_ID,
		revision: 17,
		protocol: { name: "murmur.mesh", version: "17" },
		modelAccess: options.modelAccess ?? "agent_owned",
		resume: false,
		toolGateway: options.toolGateway ?? false,
		artifacts: false,
		images: false,
	});
}

function descriptor(snapshot: ConnectorCapabilitySnapshot) {
	return {
		schemaVersion: 1 as const,
		providerId: snapshot.providerId,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
}

function selection(snapshot: ConnectorCapabilitySnapshot) {
	return {
		providerId: snapshot.providerId,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
}

class ArbitraryConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "external_connector" as const;
	readonly snapshot: ConnectorCapabilitySnapshot;
	disposeCalls = 0;
	probeCalls = 0;

	constructor(providerId = PROVIDER_ID) {
		this.providerId = providerId;
		this.snapshot = capabilitySnapshot({ providerId });
	}

	async capabilities() {
		return [];
	}
	async probeCapabilities() {
		this.probeCalls += 1;
		return Result.ok(this.snapshot);
	}
	async createAttempt() {
		return Result.err(new FoundationError("unsupported_feature", "arbitrary connector"));
	}
	async runAttempt() {
		return Result.err(new FoundationError("unsupported_feature", "arbitrary connector"));
	}
	async cancelAttempt() {
		return Result.err(new FoundationError("unsupported_feature", "arbitrary connector"));
	}
	async resumeAttempt() {
		return Result.err(new FoundationError("unsupported_feature", "arbitrary connector"));
	}
	async reconcileAttempt() {
		return Result.err(new FoundationError("unsupported_feature", "arbitrary connector"));
	}
	async dispose() {
		this.disposeCalls += 1;
	}
}

class ThirdPartyZetaDriver implements ExternalConnectorVendorDriver {
	cancelCalls = 0;
	connectCalls = 0;
	disposeCalls = 0;
	lookupCalls = 0;
	spawnCalls = 0;
	readCalls = 0;
	readonly writes: ExternalConnectorDriverWriteRequest[] = [];
	readonly #throwOnDispose: boolean;
	readonly #readHangs: boolean;
	readonly #returnsCancelEvidence: boolean;
	readonly #emitToolGatewayRequest: boolean;
	#spawnedRequest: ExternalConnectorDriverSpawnRequest | undefined;

	constructor(
		options: {
			readonly emitToolGatewayRequest?: boolean;
			readonly readHangs?: boolean;
			readonly returnsCancelEvidence?: boolean;
			readonly throwOnDispose?: boolean;
		} = {},
	) {
		this.#throwOnDispose = options.throwOnDispose ?? false;
		this.#readHangs = options.readHangs ?? false;
		this.#returnsCancelEvidence = options.returnsCancelEvidence ?? false;
		this.#emitToolGatewayRequest = options.emitToolGatewayRequest ?? false;
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnCalls += 1;
		this.#spawnedRequest = request;
		return {
			externalSessionId: `zeta-session-${this.spawnCalls}`,
			externalTurnId: `zeta-turn-${this.spawnCalls}`,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(handle: ExternalConnectorDriverHandle): AsyncIterable<FoundationJsonValue> {
		const request = this.#spawnedRequest;
		const operationId = request?.correlation.operationId;
		if (!this.#emitToolGatewayRequest || request === undefined) return;
		if (operationId === undefined) throw new Error("Zeta driver requires an operation correlation");
		yield {
			schemaVersion: 1,
			type: "started",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			producedAt: NOW,
		};
		yield {
			schemaVersion: 1,
			type: "tool_gateway_request",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			operationNonce: handle.operationNonce,
			request: {
				schemaVersion: 1,
				toolCallId: `tool-call-${operationId}`,
				toolName: "workspace.read",
				namespace: "workspace",
				originalArguments: { path: "docs/input.txt" },
				idempotencyKey: `gateway-${operationId}`,
				context: {
					schemaVersion: 1,
					bindingId: request.attempt.bindingId,
					bindingEpochId: request.attempt.bindingEpochIds[0]!,
					taskId: request.attempt.taskId,
					dispatchId: request.attempt.dispatchId,
					providerId: request.capability.providerId,
					attemptId: request.attempt.attemptId,
					operationId,
				},
			},
			producedAt: NOW,
		};
	}

	async connect(): Promise<ExternalConnectorDriverHandle> {
		this.connectCalls += 1;
		throw new Error("Zeta driver has no resumable session in this fixture.");
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		this.lookupCalls += 1;
		return { status: "missing" };
	}

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		this.readCalls += 1;
		if (this.#readHangs) await new Promise<never>(() => undefined);
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

	async write(_handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.writes.push(request);
	}
	async heartbeat(): Promise<void> {}
	async cancel(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence | undefined> {
		this.cancelCalls += 1;
		return this.#returnsCancelEvidence
			? {
					externalSessionId: handle.externalSessionId,
					externalTurnId: handle.externalTurnId,
					operationNonce: handle.operationNonce,
					status: "cancelled",
					artifacts: [],
					sideEffectState: "none",
					producedAt: NOW,
				}
			: undefined;
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.#throwOnDispose) throw new Error("planned third-party driver disposal failure");
	}
}

interface SupportedConnectorFixture {
	readonly connector: ExternalAgentConnector;
	readonly driver: ThirdPartyZetaDriver;
	readonly session: Session;
	readonly snapshot: ConnectorCapabilitySnapshot;
	readonly supervision: ReturnType<typeof createExternalConnectorTestSupervision>;
	readonly t5: SessionT5Ledger;
}

function createSupportedConnector(
	options: {
		readonly providerId?: string;
		readonly toolGateway?: boolean;
		readonly modelAccess?: "agent_owned" | "aos_gateway";
		readonly driver?: ThirdPartyZetaDriver;
		readonly capabilityProbe?: (
			snapshot: ConnectorCapabilitySnapshot,
			options?: FoundationProviderExecutionOptions,
		) => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>;
		readonly supervisionDeadlines?: {
			readonly event?: { readonly hardMs: number; readonly idleMs: number };
			readonly receipt?: { readonly hardMs: number; readonly idleMs: number };
			readonly dispose?: { readonly hardMs: number; readonly idleMs: number };
		};
	} = {},
): SupportedConnectorFixture {
	supervisedFixtureId += 1;
	const fixtureId = supervisedFixtureId;
	const snapshot = capabilitySnapshot(options);
	const session = new Session(
		new InMemorySessionStorage({
			id: `supervised-zeta-${fixtureId}`,
			createdAt: fixtureId,
		}),
	);
	const t5 = new SessionT5Ledger(session, { ownerId: `supervised-zeta-${fixtureId}` });
	const supervision = createExternalConnectorTestSupervision();
	const driver = options.driver ?? new ThirdPartyZetaDriver();
	const capabilityProbe = options.capabilityProbe;
	const supervisionOptions =
		options.supervisionDeadlines === undefined
			? supervision.options
			: {
					...supervision.options,
					deadlines: { ...supervision.options.deadlines, ...options.supervisionDeadlines },
				};
	const connector = createDurableExternalAgentConnector({
		providerId: snapshot.providerId,
		capability: snapshot,
		...(capabilityProbe === undefined
			? {}
			: {
					capabilityProbe: (probeOptions?: FoundationProviderExecutionOptions) =>
						capabilityProbe(snapshot, probeOptions),
				}),
		store: new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: t5.writer })),
		driver,
		supervision: supervisionOptions,
		now: () => NOW,
		operationNonce: () => `zeta-nonce-${fixtureId}`,
	});
	return { connector, driver, session, snapshot, supervision, t5 };
}

function registration(fixture: SupportedConnectorFixture): ExternalConnectorRegistration {
	return {
		descriptor: descriptor(fixture.snapshot),
		connector: fixture.connector,
		trusted: true,
	};
}

const EXTERNAL_POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "external-registry-test",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: [], deny: ["credentials", "agent-internal"] },
	process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "deny" },
};

function policyBinding(runId: string) {
	const resolved = resolveExecutionPolicyProfile({
		profiles: { [EXTERNAL_POLICY_PROFILE.id]: EXTERNAL_POLICY_PROFILE },
		defaultProfile: EXTERNAL_POLICY_PROFILE.id,
		workspaceIdentity: "workspace-zeta",
		runId,
		createdAt: NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.binding;
}

function productInput(
	fixture: SupportedConnectorFixture,
	registry: ReturnType<typeof createExternalConnectorRegistry>,
	runId: string,
): ExternalConnectorProductExecutionInput {
	const text = `Execute supervised third-party connector run ${runId}`;
	return {
		session: fixture.session,
		writer: fixture.t5.writer,
		registry,
		selection: {
			providerId: fixture.snapshot.providerId,
			revision: fixture.snapshot.revision,
			capabilitySnapshotDigest: fixture.snapshot.digest,
		},
		runId,
		message: text,
		canonicalInput: { schemaVersion: 1, text, artifacts: [] },
		inputAdmission: {
			inspectArtifact: () => {
				throw new Error("no artifacts");
			},
		},
		workspace: "workspace-zeta",
		policyBinding: policyBinding(runId),
		now: () => NOW,
	};
}

function driftedCapabilitySnapshot(snapshot: ConnectorCapabilitySnapshot): ConnectorCapabilitySnapshot {
	const { digest: _digest, ...unpinned } = snapshot;
	return createConnectorCapabilitySnapshot({ ...unpinned, revision: snapshot.revision + 1 });
}

function createDriftingConnector(
	driftAt = 3,
	driver?: ThirdPartyZetaDriver,
): SupportedConnectorFixture & { readonly probeCalls: () => number } {
	let probeCalls = 0;
	const fixture = createSupportedConnector({
		...(driver === undefined ? {} : { driver }),
		capabilityProbe: async (snapshot) => {
			probeCalls += 1;
			return Result.ok(probeCalls === driftAt ? driftedCapabilitySnapshot(snapshot) : snapshot);
		},
	});
	return { ...fixture, probeCalls: () => probeCalls };
}

async function createPersistedProductAttempt(
	fixture: SupportedConnectorFixture,
	registry: ReturnType<typeof createExternalConnectorRegistry>,
	runId: string,
): Promise<{
	readonly attempt: Attempt;
	readonly connector: ExternalAgentConnector;
	readonly correlation: ExecutionCorrelation;
	readonly settlement: LayeredResultSettlement;
}> {
	const admission = await prepareExternalConnectorProductRun(productInput(fixture, registry, runId));
	const prepared = await persistExternalConnectorProductRunAfterAcceptance(admission);
	const settlement = new LayeredResultSettlement(fixture.session, {
		ownerId: `external-connector-registry:${runId}`,
		writer: fixture.t5.writer,
	});
	const started = await settlement.startDispatch({
		provider: prepared.selected.connector,
		dispatch: prepared.dispatch,
		binding: prepared.binding,
		initialBindingEpoch: prepared.initialBindingEpoch,
		correlation: prepared.correlation,
	});
	if (!started.ok) {
		await settlement.release();
		throw started.error;
	}
	return {
		attempt: started.value.attempt,
		connector: prepared.selected.connector,
		correlation: prepared.correlation,
		settlement,
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

describe("ExternalConnectorRegistry supervised SPI", () => {
	it("projects unsupported Connector resume for a terminal source without a second vendor effect", async () => {
		const fixture = createSupportedConnector();
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const runId = "run-zeta-resume-unsupported";
		const message = `Execute supervised third-party connector run ${runId}`;
		await expect(executeExternalConnectorProductRun(productInput(fixture, registry, runId))).resolves.toMatchObject({
			runReceipt: { terminalStatus: "completed" },
		});
		expect(fixture.driver.spawnCalls).toBe(1);
		expect(
			await fixture.session.findFoundationRecords({
				objectType: "run_receipt",
				objectId: runId,
				includePruned: true,
			}),
		).toHaveLength(1);

		await expect(
			preflightExternalConnectorProductRecovery({
				session: fixture.session,
				writer: fixture.t5.writer,
				registry,
				runId,
				providerId: fixture.snapshot.providerId,
				selection: selection(fixture.snapshot),
				expectedCanonicalInput: {
					schemaVersion: 1,
					text: message,
					artifacts: [],
				},
			}),
		).rejects.toMatchObject({
			code: "external_resume_unsupported",
			message: "The selected External Connector does not support resume.",
			retryable: false,
		});
		expect(fixture.driver.spawnCalls).toBe(1);
		await registry.dispose();
	});

	it("rejects an arbitrary connector before probe and leaves its provider slot available", async () => {
		const arbitrary = new ArbitraryConnector();
		const arbitraryDescriptor = descriptor(arbitrary.snapshot);
		const registry = createExternalConnectorRegistry();

		expect(
			registry.registerPrepared(
				{ descriptor: arbitraryDescriptor, connector: arbitrary, trusted: true },
				arbitrary.snapshot,
			),
		).toMatchObject({ ok: false });
		expect(
			await registry.register({ descriptor: arbitraryDescriptor, connector: arbitrary, trusted: true }),
		).toMatchObject({
			ok: false,
		});
		expect(arbitrary.probeCalls).toBe(0);
		expect(arbitrary.disposeCalls).toBe(0);
		expect(registry.list()).toEqual([]);

		const supported = createSupportedConnector();
		expect(await registry.register(registration(supported))).toMatchObject({ ok: true });
		expect(registry.list()).toEqual([arbitraryDescriptor]);
		expect(await registry.select(selection(supported.snapshot))).toMatchObject({ ok: true });

		await registry.dispose();
		expect(supported.driver.disposeCalls).toBe(1);
		expect(supported.supervision.processController.launchCalls).toBe(0);
	});

	it("rejects a factory-created connector whose lifecycle implementation changes before registration", async () => {
		const fixture = createSupportedConnector();
		const prepared = registration(fixture);
		let replacementCalls = 0;
		const replacement: ExternalAgentConnector["runAttempt"] = async () => {
			replacementCalls += 1;
			return Result.err(new FoundationError("provider_spawn_failed", "unsupervised replacement"));
		};
		Object.defineProperty(fixture.connector, "runAttempt", { configurable: true, value: replacement });

		const preparedRegistry = createExternalConnectorRegistry();
		expect(preparedRegistry.registerPrepared(prepared, fixture.snapshot)).toMatchObject({ ok: false });
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(prepared)).toMatchObject({ ok: false });
		expect(replacementCalls).toBe(0);
		expect(registry.list()).toEqual([]);
		await fixture.connector.dispose();
	});

	it("rejects selection after a registered connector identity property is replaced without invoking it", async () => {
		const fixture = createSupportedConnector();
		const prepared = registration(fixture);
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(prepared)).toMatchObject({ ok: true });
		let providerGetterCalls = 0;
		Object.defineProperty(fixture.connector, "providerId", {
			configurable: true,
			get: () => {
				providerGetterCalls += 1;
				return fixture.snapshot.providerId;
			},
		});

		expect(await registry.select(selection(fixture.snapshot))).toMatchObject({ ok: false });
		expect(providerGetterCalls).toBe(0);
		await registry.dispose();
		expect(fixture.driver.disposeCalls).toBe(1);
	});

	it("keeps a selected Host wrapper immutable and independent from later method replacement", async () => {
		const fixture = createSupportedConnector();
		const prepared = registration(fixture);
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(prepared)).toMatchObject({ ok: true });
		const selected = await registry.select(selection(fixture.snapshot));
		if (!selected.ok) throw selected.error;
		let replacementCalls = 0;
		Object.defineProperty(fixture.connector, "probeCapabilities", {
			configurable: true,
			value: async () => {
				replacementCalls += 1;
				return Result.err(new FoundationError("provider_spawn_failed", "unsupervised replacement"));
			},
		});

		expect(Object.isFrozen(selected.value.connector)).toBe(true);
		expect("bindToolGatewayConsumer" in selected.value).toBe(false);
		expect(await selected.value.connector.probeCapabilities()).toMatchObject({
			ok: true,
			value: { providerId: fixture.snapshot.providerId },
		});
		expect(replacementCalls).toBe(0);
		expect(await registry.select(selection(fixture.snapshot))).toMatchObject({ ok: false });
		await registry.dispose();
	});

	it("registers and runs a supported third-party driver through the durable supervised factory", async () => {
		const fixture = createSupportedConnector();
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });

		const execution = await executeExternalConnectorProductRun(
			productInput(fixture, registry, "run-zeta-supervised"),
		);

		expect(execution.runReceipt.terminalStatus).toBe("completed");
		expect(execution.attemptReceipt).toMatchObject({
			providerId: PROVIDER_ID,
			status: "succeeded",
			provenance: { producerKind: "external_connector" },
		});
		expect(fixture.driver.spawnCalls).toBe(1);
		expect(fixture.driver.readCalls).toBe(1);
		expect(fixture.supervision.processController.launchCalls).toBe(1);
		expect(fixture.supervision.processController.activationCalls).toBe(1);
		await registry.dispose();
	});

	it("routes only an advertised Connector-originated request through Tool Gateway", async () => {
		const gateway = { count: 0, requests: [] as ToolGatewayRequest[] };
		const canonicalToolGateway = createFoundationToolGateway({
			gatewayId: "zeta-foundation-tool-gateway",
			providers: [
				createLocalToolGatewayProvider({
					providerId: PROVIDER_ID,
					routes: [{
						kind: "local",
						toolName: "workspace.read",
						namespace: "workspace",
						providerId: PROVIDER_ID,
						revision: 1,
					}],
					invoke: async (request) => {
						gateway.count += 1;
						gateway.requests.push(request);
						return Result.ok({
							schemaVersion: 1,
							toolCallId: request.toolCallId,
							toolName: request.toolName,
							ok: true,
							sideEffectState: "none",
							toolReceiptRef: `tool-receipt-${request.toolCallId}`,
						});
					},
				}),
			],
		});
		const enabled = createSupportedConnector({
			toolGateway: true,
			driver: new ThirdPartyZetaDriver({ emitToolGatewayRequest: true }),
		});
		const unboundRegistry = createExternalConnectorRegistry();
		expect(await unboundRegistry.register(registration(enabled))).toMatchObject({ ok: false });
		const enabledRegistry = createExternalConnectorRegistry({ toolGateway: canonicalToolGateway });
		expect(await enabledRegistry.register(registration(enabled))).toMatchObject({
			ok: true,
		});

		const runId = "run-zeta-tool-gateway";
		const execution = await executeExternalConnectorProductRun(productInput(enabled, enabledRegistry, runId));
		expect(execution.runReceipt.terminalStatus).toBe("completed");
		expect(gateway.count).toBe(1);
		expect(gateway.requests).toHaveLength(1);
		expect(gateway.requests[0]).toMatchObject({
			toolCallId: `tool-call-${runId}`,
			toolName: "workspace.read",
			context: {
				providerId: PROVIDER_ID,
				operationId: runId,
			},
		});
		expect(execution.toolGatewayExchanges).toEqual([
			{
				request: gateway.requests[0],
				result: {
					schemaVersion: 1,
					toolCallId: `tool-call-${runId}`,
					toolName: "workspace.read",
					ok: true,
					sideEffectState: "none",
					toolReceiptRef: `tool-receipt-tool-call-${runId}`,
				},
			},
		]);
		expect(enabled.driver.spawnCalls).toBe(1);
		expect(enabled.driver.writes).toEqual([
			{
				schemaVersion: 1,
				kind: "tool_gateway_result",
				operationNonce: expect.any(String),
				result: execution.toolGatewayExchanges?.[0]?.result,
			},
		]);

		const disabled = createSupportedConnector({
			driver: new ThirdPartyZetaDriver({ emitToolGatewayRequest: true }),
		});
		const disabledRegistry = createExternalConnectorRegistry();
		expect(await disabledRegistry.register(registration(disabled))).toMatchObject({ ok: true });
		const disabledExecution = await executeExternalConnectorProductRun(
			productInput(disabled, disabledRegistry, "run-zeta-tool-gateway-disabled"),
		);
		expect(disabledExecution).toMatchObject({
			runReceipt: { terminalStatus: "failed", terminalError: { code: "external_event_invalid" } },
			attemptReceipt: { status: "failed", error: { code: "external_event_invalid" } },
		});
		expect(disabled.driver.spawnCalls).toBe(1);
		expect(disabled.driver.writes).toEqual([]);
		await enabledRegistry.dispose();
		await unboundRegistry.dispose();
		await disabledRegistry.dispose();
	});

	it.each(["route", "policy"] as const)(
		"projects Tool Gateway %s denial without collapsing it to unknown side effect",
		async (kind) => {
			const gateway = { count: 0, requests: [] as ToolGatewayRequest[] };
			const canonicalToolGateway = createFoundationToolGateway({
				gatewayId: `zeta-foundation-tool-gateway-${kind}-denied`,
				providers: [
					createLocalToolGatewayProvider({
						providerId: PROVIDER_ID,
						routes: [
							{
								kind: "local",
								toolName: "workspace.read",
								namespace: "workspace",
								providerId: PROVIDER_ID,
								revision: 1,
							},
						],
						invoke: async (request) => {
							gateway.count += 1;
							gateway.requests.push(request);
							if (kind === "route") {
								return Result.err(
									new FoundationError("invalid_identifier", "fixture route denied request"),
								);
							}
							return Result.ok({
								schemaVersion: 1,
								toolCallId: request.toolCallId,
								toolName: request.toolName,
								ok: false,
								sideEffectState: "none",
								error: {
									code: "tool_guard_denied",
									message: "fixture policy denied request",
									category: "permission",
									retryable: false,
								},
							});
						},
					}),
				],
			});
			const fixture = createSupportedConnector({
				toolGateway: true,
				driver: new ThirdPartyZetaDriver({ emitToolGatewayRequest: true }),
			});
			const registry = createExternalConnectorRegistry({ toolGateway: canonicalToolGateway });
			expect(await registry.register(registration(fixture))).toMatchObject({
				ok: true,
			});

			const execution = await executeExternalConnectorProductRun(
				productInput(fixture, registry, `run-zeta-tool-gateway-${kind}-denied`),
			);

				expect(execution).toMatchObject({
					runReceipt: {
						terminalStatus: "failed",
						terminalError: {
						code: "external_tool_route_denied",
						category: "permission",
						retryable: false,
					},
				},
				attemptReceipt: {
					status: "failed",
					sideEffectState: "none",
					error: {
						code: "external_tool_route_denied",
						category: "permission",
						retryable: false,
					},
				},
			});
			expect(gateway.count).toBe(1);
			expect(execution.toolGatewayExchanges).toEqual([
				{
					request: gateway.requests[0],
					result: {
						schemaVersion: 1,
						toolCallId: `tool-call-run-zeta-tool-gateway-${kind}-denied`,
						toolName: "workspace.read",
						ok: false,
						sideEffectState: "none",
						error: {
							code: "external_tool_route_denied",
							message: "External connector Tool Gateway policy or route denied the request.",
							category: "permission",
							retryable: false,
						},
					},
				},
			]);
			expect(fixture.driver.writes).toEqual([]);
			await registry.dispose();
		},
	);

	it("rechecks pinned truth before run and routes drift to supervised reconciliation", async () => {
		const fixture = createDriftingConnector();
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-capability-drift");

		const result = await persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
		});

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "scheduler_attempt_recovery_failed",
				message: "External connector operation does not exist",
			},
		});
		expect(fixture.probeCalls()).toBe(3);
		expect(fixture.driver.spawnCalls).toBe(0);
		await persisted.settlement.release();
		await registry.dispose();
	});

	it("keeps an aborted selected launch unknown when exact cleanup cannot be proven", async () => {
		const fixture = createSupportedConnector();
		fixture.supervision.processController.forceExits = false;
		let markLaunchStarted: (() => void) | undefined;
		let releaseLaunch: (() => void) | undefined;
		const launchStarted = new Promise<void>((resolve) => {
			markLaunchStarted = resolve;
		});
		fixture.supervision.processController.launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		fixture.supervision.processController.onLaunch = () => markLaunchStarted?.();
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-aborted-launch");
		const abort = new AbortController();
		const running = persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
			signal: abort.signal,
		});
		await launchStarted;
		abort.abort();

		await expect(running).resolves.toMatchObject({
			ok: false,
			error: { code: "side_effect_unknown" },
		});
		releaseLaunch?.();
		await expect.poll(() => fixture.supervision.processController.forceCalls).toBe(1);
		await expect.poll(async () => fixture.supervision.privateStateStore.list()).toHaveLength(1);

		fixture.supervision.processController.resolveExits();
		await fixture.supervision.privateStateStore.delete(persisted.attempt.attemptId);
		await persisted.settlement.release();
		await registry.dispose();
	});

	it("rechecks pinned truth for resume and reconcile lifecycle entry points", async () => {
		for (const operation of ["resume", "reconcile"] as const) {
			const fixture = createDriftingConnector();
			const registry = createExternalConnectorRegistry();
			expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
			const persisted = await createPersistedProductAttempt(fixture, registry, `run-zeta-${operation}-drift`);

			const result =
				operation === "resume"
					? await persisted.connector.resumeAttempt(persisted.attempt, { correlation: persisted.correlation })
					: await persisted.connector.reconcileAttempt(persisted.attempt, {
							correlation: persisted.correlation,
						});

			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "scheduler_attempt_recovery_failed",
					message: "External connector operation does not exist",
				},
			});
			expect(fixture.probeCalls()).toBe(3);
			expect(fixture.driver.connectCalls).toBe(0);
			expect(fixture.driver.lookupCalls).toBe(0);
			expect(fixture.driver.cancelCalls).toBe(0);
			await persisted.settlement.release();
			await registry.dispose();
		}
	});

	it("contains the same Attempt when capability truth drifts during cancellation", async () => {
		const driver = new ThirdPartyZetaDriver({ readHangs: true, returnsCancelEvidence: true });
		const fixture = createDriftingConnector(4, driver);
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-cancel-drift");
		const running = persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
		});
		await expect.poll(() => driver.readCalls).toBe(1);

		const cancelled = await persisted.connector.cancelAttempt(persisted.attempt.attemptId);

		expect(cancelled).toMatchObject({
			ok: false,
			error: {
				code: "scheduler_attempt_recovery_failed",
				message: "External connector capability truth could not be rechecked",
			},
		});
		expect(fixture.probeCalls()).toBe(4);
		expect(driver.cancelCalls).toBe(1);
		expect(await running).toMatchObject({ ok: true, value: { status: "cancelled" } });
		await persisted.settlement.release();
		await registry.dispose();
	});

	it("bounds hanging capability probes and aborts the probe operation", async () => {
		let abortObserved = false;
		const fixture = createSupportedConnector({
			capabilityProbe: async (_snapshot, options) =>
				new Promise<never>(() => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							abortObserved = true;
						},
						{ once: true },
					);
				}),
		});
		const registry = createExternalConnectorRegistry({
			capabilityProbeDeadline: { hardMs: 50, idleMs: 10 },
		});
		expect(registry.registerPrepared(registration(fixture), fixture.snapshot)).toMatchObject({ ok: true });
		const startedAt = Date.now();

		const selected = await registry.select(selection(fixture.snapshot));

		expect(selected).toMatchObject({ ok: false });
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(abortObserved).toBe(true);
		await registry.dispose();
	});

	it("bounds a hanging lifecycle recheck before same-Attempt cancellation containment", async () => {
		let probeCalls = 0;
		let abortObserved = false;
		const driver = new ThirdPartyZetaDriver({ readHangs: true, returnsCancelEvidence: true });
		const fixture = createSupportedConnector({
			driver,
			capabilityProbe: async (snapshot, options) => {
				probeCalls += 1;
				if (probeCalls < 4) return Result.ok(snapshot);
				return new Promise<never>(() => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							abortObserved = true;
						},
						{ once: true },
					);
				});
			},
		});
		const registry = createExternalConnectorRegistry({
			capabilityProbeDeadline: { hardMs: 10, idleMs: 50 },
		});
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-cancel-probe-hang");
		const running = persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
		});
		await expect.poll(() => driver.readCalls).toBe(1);
		const startedAt = Date.now();

		const cancelled = await persisted.connector.cancelAttempt(persisted.attempt.attemptId);

		expect(cancelled).toMatchObject({ ok: false, error: { code: "scheduler_attempt_recovery_failed" } });
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(abortObserved).toBe(true);
		expect(driver.cancelCalls).toBe(1);
		expect(await running).toMatchObject({ ok: true, value: { status: "cancelled" } });
		await persisted.settlement.release();
		await registry.dispose();
	});

	it("keeps caller abort separate from capability drift during lifecycle entry", async () => {
		const fixture = createSupportedConnector();
		const registry = createExternalConnectorRegistry();
		expect(await registry.register(registration(fixture))).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-aborted-recheck");
		const controller = new AbortController();
		controller.abort();

		const completed = await persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
			signal: controller.signal,
		});

		expect(completed).toMatchObject({ ok: true, value: { status: "cancelled" } });
		expect(fixture.driver.spawnCalls).toBe(0);
		await persisted.settlement.release();
		await registry.dispose();
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
			capabilityProbe: () => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>,
			expectedMessage: string,
			sourceError: Error,
		): Promise<void> => {
			const fixture = createSupportedConnector({ capabilityProbe });
			const registry = createExternalConnectorRegistry();
			const result = await registry.register(registration(fixture));

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).not.toBe(sourceError);
				expectSafeRegistryProbeFailure(result.error, expectedMessage, forbiddenValues);
			}
			await fixture.connector.dispose();
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

	it("disposes a pending registration exactly once when shutdown wins its delayed probe", async () => {
		let markProbeStarted: (() => void) | undefined;
		let releaseProbe: (() => void) | undefined;
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const fixture = createSupportedConnector({
			capabilityProbe: async (snapshot) => {
				markProbeStarted?.();
				await probeGate;
				return Result.ok(snapshot);
			},
		});
		const registry = createExternalConnectorRegistry();
		const pendingRegistration = registry.register(registration(fixture));
		await probeStarted;

		await registry.dispose();
		releaseProbe?.();
		const registered = await pendingRegistration;

		expect(registered.ok).toBe(false);
		expect(registry.list()).toEqual([]);
		expect(fixture.driver.disposeCalls).toBe(1);
	});

	it("fails a delayed selection closed when shutdown disposes its registered connector", async () => {
		let markProbeStarted: (() => void) | undefined;
		let releaseProbe: (() => void) | undefined;
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const fixture = createSupportedConnector({
			capabilityProbe: async (snapshot) => {
				markProbeStarted?.();
				await probeGate;
				return Result.ok(snapshot);
			},
		});
		const registry = createExternalConnectorRegistry();
		expect(registry.registerPrepared(registration(fixture), fixture.snapshot)).toMatchObject({ ok: true });
		const pendingSelection = registry.select(selection(fixture.snapshot));
		await probeStarted;

		await registry.dispose();
		releaseProbe?.();
		const selected = await pendingSelection;

		expect(selected.ok).toBe(false);
		expect(fixture.driver.disposeCalls).toBe(1);
	});

	it("cannot install a prepared connector after reentrant registry disposal", async () => {
		const fixture = createSupportedConnector();
		const prepared = registration(fixture);
		const registry = createExternalConnectorRegistry();
		let armed = false;
		const reentrantRegistration: ExternalConnectorRegistration = {
			get descriptor() {
				if (armed) void registry.dispose();
				return prepared.descriptor;
			},
			connector: prepared.connector,
			trusted: true,
		};
		armed = true;

		const registered = registry.registerPrepared(reentrantRegistration, fixture.snapshot);

		expect(registered.ok).toBe(false);
		expect(registry.list()).toEqual([]);
		expect(fixture.driver.disposeCalls).toBe(0);
		await registry.dispose();
		await fixture.connector.dispose();
		expect(fixture.driver.disposeCalls).toBe(1);
	});

	it("fails closed on untrusted, mismatched, and unknown connector facts", async () => {
		const fixture = createSupportedConnector();
		const base = registration(fixture);
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
		]) {
			const registry = createExternalConnectorRegistry();
			expect(await registry.register(invalid as unknown as ExternalConnectorRegistration)).toMatchObject({
				ok: false,
			});
			expect(registry.list()).toEqual([]);
		}

		const registry = createExternalConnectorRegistry();
		expect(await registry.register(base)).toMatchObject({ ok: true });
		const selected = selection(fixture.snapshot);
		expect(await registry.select({ ...selected, providerId: "unknown.connector" })).toMatchObject({ ok: false });
		expect(await registry.select({ ...selected, revision: selected.revision + 1 })).toMatchObject({ ok: false });
		expect(
			await registry.select({
				...selected,
				capabilitySnapshotDigest: fingerprintFoundationValue("wrong-selection"),
			}),
		).toMatchObject({ ok: false });
		await registry.dispose();
	});

	it("attempts every owned connector disposal when one third-party driver rejects", async () => {
		const first = createSupportedConnector({
			providerId: "third-party.first-connector",
			driver: new ThirdPartyZetaDriver({ throwOnDispose: true }),
		});
		const second = createSupportedConnector({ providerId: "third-party.second-connector" });
		const registry = createExternalConnectorRegistry();
		expect(registry.registerPrepared(registration(first), first.snapshot)).toMatchObject({ ok: true });
		expect(registry.registerPrepared(registration(second), second.snapshot)).toMatchObject({ ok: true });

		const disposal = registry.dispose();
		await expect(disposal).rejects.toMatchObject({
			code: "side_effect_unknown",
			message: "External connector registry shutdown could not confirm cleanup.",
		});
		await disposal.catch((error: unknown) => {
			expect(JSON.stringify(error)).not.toContain("planned third-party driver disposal failure");
			expect(FoundationError.is(error)).toBe(true);
			if (FoundationError.is(error)) {
				expect(error.cause).toBeUndefined();
				expect(error.details).toBeUndefined();
			}
		});

		expect(first.driver.disposeCalls).toBe(1);
		expect(second.driver.disposeCalls).toBe(1);
	});

	it("does not finish registry disposal before slow forced process cleanup is confirmed", async () => {
		vi.useFakeTimers();
		try {
			const driver = new ThirdPartyZetaDriver({ readHangs: true });
			const fixture = createSupportedConnector({
				driver,
				supervisionDeadlines: {
					event: { hardMs: 10_000, idleMs: 10_000 },
					receipt: { hardMs: 10_000, idleMs: 10_000 },
					dispose: { hardMs: 6_000, idleMs: 6_000 },
				},
			});
			fixture.supervision.processController.forceExits = false;
			const registry = createExternalConnectorRegistry();
			expect(registry.registerPrepared(registration(fixture), fixture.snapshot)).toMatchObject({ ok: true });
			const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-slow-cleanup");
			const running = persisted.connector.runAttempt(persisted.attempt, {
				correlation: persisted.correlation,
			});
			await vi.waitFor(() => expect(driver.readCalls).toBe(1));
			let disposalSettled = false;
			const disposal = registry.dispose().finally(() => {
				disposalSettled = true;
			});
			await vi.advanceTimersByTimeAsync(5_000);

			expect(disposalSettled).toBe(false);
			expect(fixture.supervision.processController.forceCalls).toBe(1);
			fixture.supervision.processController.resolveExits();
			await disposal;
			expect(disposalSettled).toBe(true);
			expect(await running).toMatchObject({ ok: false });
			await persisted.settlement.release();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drains a selected run whose supervisor appears while registry replacement disposes the connector", async () => {
		const driver = new ThirdPartyZetaDriver({ readHangs: true });
		const fixture = createSupportedConnector({ driver });
		const registry = createExternalConnectorRegistry();
		expect(registry.registerPrepared(registration(fixture), fixture.snapshot)).toMatchObject({ ok: true });
		const persisted = await createPersistedProductAttempt(fixture, registry, "run-zeta-replacement-race");
		let markPrivateWrite: (() => void) | undefined;
		let releasePrivateWrite: (() => void) | undefined;
		const privateWriteStarted = new Promise<void>((resolve) => {
			markPrivateWrite = resolve;
		});
		fixture.supervision.privateStateStore.writeGate = new Promise<void>((resolve) => {
			releasePrivateWrite = resolve;
		});
		fixture.supervision.privateStateStore.onWrite = () => markPrivateWrite?.();
		const running = persisted.connector.runAttempt(persisted.attempt, {
			correlation: persisted.correlation,
		});
		await privateWriteStarted;
		let replacementSettled = false;
		const replacement = registry.dispose().finally(() => {
			replacementSettled = true;
		});
		await Promise.resolve();
		expect(replacementSettled).toBe(false);

		releasePrivateWrite?.();
		await replacement;

		expect(await running).toMatchObject({ ok: false });
		expect(fixture.supervision.processController.forceCalls).toBe(1);
		expect(await fixture.supervision.privateStateStore.list()).toEqual([]);
		expect(driver.disposeCalls).toBe(1);
		await persisted.settlement.release();
	});
});
