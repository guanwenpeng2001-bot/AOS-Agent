import {
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	createConnectorCapabilitySnapshot,
	fingerprintFoundationValue,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { createDurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import {
	createExternalConnectorRegistry,
	type ExternalConnectorRegistration,
} from "../src/core/external-agent-registry.ts";
import {
	executeExternalConnectorProductRun,
	type ExternalConnectorProductExecutionInput,
} from "../src/core/external-connector-product.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const PROVIDER_ID = "third-party.zeta-connector";
let supervisedFixtureId = 0;

function capabilitySnapshot(options: {
	readonly providerId?: string;
	readonly toolGateway?: boolean;
	readonly modelAccess?: "agent_owned" | "aos_gateway";
} = {}): ConnectorCapabilitySnapshot {
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

	async capabilities() { return []; }
	async probeCapabilities() {
		this.probeCalls += 1;
		return Result.ok(this.snapshot);
	}
	async createAttempt() { return Result.err(new FoundationError("unsupported_feature", "arbitrary connector")); }
	async runAttempt() { return Result.err(new FoundationError("unsupported_feature", "arbitrary connector")); }
	async cancelAttempt() { return Result.err(new FoundationError("unsupported_feature", "arbitrary connector")); }
	async resumeAttempt() { return Result.err(new FoundationError("unsupported_feature", "arbitrary connector")); }
	async reconcileAttempt() { return Result.err(new FoundationError("unsupported_feature", "arbitrary connector")); }
	async dispose() { this.disposeCalls += 1; }
}

class ThirdPartyZetaDriver implements ExternalConnectorVendorDriver {
	disposeCalls = 0;
	spawnCalls = 0;
	readCalls = 0;
	readonly #throwOnDispose: boolean;

	constructor(options: { readonly throwOnDispose?: boolean } = {}) {
		this.#throwOnDispose = options.throwOnDispose ?? false;
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnCalls += 1;
		return {
			externalSessionId: `zeta-session-${this.spawnCalls}`,
			externalTurnId: `zeta-turn-${this.spawnCalls}`,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(): AsyncIterable<never> {}

	async connect(): Promise<ExternalConnectorDriverHandle> {
		throw new Error("Zeta driver has no resumable session in this fixture.");
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		return { status: "missing" };
	}

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		this.readCalls += 1;
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

	async write(): Promise<void> {}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<undefined> { return undefined; }

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

function createSupportedConnector(options: {
	readonly providerId?: string;
	readonly toolGateway?: boolean;
	readonly modelAccess?: "agent_owned" | "aos_gateway";
	readonly driver?: ThirdPartyZetaDriver;
} = {}): SupportedConnectorFixture {
	supervisedFixtureId += 1;
	const fixtureId = supervisedFixtureId;
	const snapshot = capabilitySnapshot(options);
	const session = new Session(new InMemorySessionStorage({
		id: `supervised-zeta-${fixtureId}`,
		createdAt: fixtureId,
	}));
	const t5 = new SessionT5Ledger(session, { ownerId: `supervised-zeta-${fixtureId}` });
	const supervision = createExternalConnectorTestSupervision();
	const driver = options.driver ?? new ThirdPartyZetaDriver();
	const connector = createDurableExternalAgentConnector({
		providerId: snapshot.providerId,
		capability: snapshot,
		store: new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: t5.writer })),
		driver,
		supervision: supervision.options,
		now: () => NOW,
		operationNonce: () => `zeta-nonce-${fixtureId}`,
	});
	return { connector, driver, session, snapshot, supervision, t5 };
}

function registration(
	fixture: SupportedConnectorFixture,
	options: { readonly toolGatewayCalls?: { count: number } } = {},
): ExternalConnectorRegistration {
	const toolGatewayCalls = options.toolGatewayCalls;
	return {
		descriptor: descriptor(fixture.snapshot),
		connector: fixture.connector,
		trusted: true,
		...(fixture.snapshot.toolGateway ? {
			capabilityEvidence: {
				toolGateway: {
					declaration: { id: "zeta.tool-gateway", revision: 3, reachable: true as const },
					handler: {
						id: "zeta.tool-gateway-handler",
						invoke: () => {
							if (toolGatewayCalls !== undefined) toolGatewayCalls.count += 1;
						},
					},
				},
			},
		} : {}),
	};
}

function productInput(
	fixture: SupportedConnectorFixture,
	registry: ReturnType<typeof createExternalConnectorRegistry>,
	runId: string,
	requiresToolGateway = false,
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
		inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
		workspace: "workspace-zeta",
		...(requiresToolGateway ? { requiresToolGateway: true } : {}),
		now: () => NOW,
	};
}

describe("ExternalConnectorRegistry supervised SPI", () => {
	it("rejects an arbitrary connector before probe and leaves its provider slot available", async () => {
		const arbitrary = new ArbitraryConnector();
		const arbitraryDescriptor = descriptor(arbitrary.snapshot);
		const registry = createExternalConnectorRegistry();

		expect(registry.registerPrepared(
			{ descriptor: arbitraryDescriptor, connector: arbitrary, trusted: true },
			arbitrary.snapshot,
		)).toMatchObject({ ok: false });
		expect(await registry.register({ descriptor: arbitraryDescriptor, connector: arbitrary, trusted: true })).toMatchObject({
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

	it("executes only an advertised Tool Gateway before the supervised vendor driver", async () => {
		const gatewayCalls = { count: 0 };
		const enabled = createSupportedConnector({ toolGateway: true });
		const enabledRegistry = createExternalConnectorRegistry();
		expect(await enabledRegistry.register(registration(enabled, { toolGatewayCalls: gatewayCalls }))).toMatchObject({ ok: true });

		const execution = await executeExternalConnectorProductRun(
			productInput(enabled, enabledRegistry, "run-zeta-tool-gateway"),
		);
		expect(execution.runReceipt.terminalStatus).toBe("completed");
		expect(gatewayCalls.count).toBe(1);
		expect(enabled.driver.spawnCalls).toBe(1);

		const disabled = createSupportedConnector();
		const disabledRegistry = createExternalConnectorRegistry();
		expect(await disabledRegistry.register(registration(disabled))).toMatchObject({ ok: true });
		await expect(executeExternalConnectorProductRun(
			productInput(disabled, disabledRegistry, "run-zeta-tool-gateway-disabled", true),
		)).rejects.toMatchObject({
			code: "external_capability_mismatch",
			message: "External connector does not support the required Tool Gateway bridge",
			retryable: false,
		});
		expect(disabled.driver.spawnCalls).toBe(0);
		expect(await disabled.session.findFoundationRecords({ includePruned: true })).toEqual([]);
		await enabledRegistry.dispose();
		await disabledRegistry.dispose();
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
			expect(await registry.register(invalid as unknown as ExternalConnectorRegistration)).toMatchObject({ ok: false });
			expect(registry.list()).toEqual([]);
		}

		const registry = createExternalConnectorRegistry();
		expect(await registry.register(base)).toMatchObject({ ok: true });
		const selected = selection(fixture.snapshot);
		expect(await registry.select({ ...selected, providerId: "unknown.connector" })).toMatchObject({ ok: false });
		expect(await registry.select({ ...selected, revision: selected.revision + 1 })).toMatchObject({ ok: false });
		expect(await registry.select({
			...selected,
			capabilitySnapshotDigest: fingerprintFoundationValue("wrong-selection"),
		})).toMatchObject({ ok: false });
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

		await registry.dispose();

		expect(first.driver.disposeCalls).toBe(1);
		expect(second.driver.disposeCalls).toBe(1);
	});
});
