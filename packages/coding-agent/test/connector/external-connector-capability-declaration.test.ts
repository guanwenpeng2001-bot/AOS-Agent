import {
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	type ConnectorCapabilitySnapshot,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import { createDurableExternalAgentConnector } from "../../src/core/connector/durable-connector.ts";
import { SessionExternalConnectorDurableStore } from "../../src/core/connector/operation.ts";
import { PROVIDER_CLASS } from "../../src/core/connector/provider-class.ts";
import { createExternalConnectorRegistry } from "../../src/core/connector/registry.ts";
import {
	bindExternalConnectorVendorBehaviorManifest,
	readExternalConnectorVendorBehaviorManifest,
	type ExternalConnectorVendorBehaviorManifest,
} from "../../src/core/connector/tool-gateway-binding.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/connector/vendor/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const PROVIDER_ID = "third-party.capability-declaration";
const NOW = "2026-08-31T00:00:00.000Z";
let fixtureId = 0;

class DeclarationDriver implements ExternalConnectorVendorDriver {
	spawnCalls = 0;

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnCalls += 1;
		return {
			externalSessionId: "unused-capability-session",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(): AsyncIterable<never> {}

	async connect(): Promise<ExternalConnectorDriverHandle> {
		throw new Error("not used");
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		return { status: "missing" };
	}

	async read(): Promise<ExternalConnectorTerminalEvidence> {
		throw new Error("not used");
	}

	async write(): Promise<void> {}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<ExternalConnectorTerminalEvidence | undefined> {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

function snapshot(): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		revision: 1,
		protocol: { name: "fixture.jsonl", version: "1" },
		modelAccess: "agent_owned",
		resume: false,
		toolGateway: true,
		artifacts: false,
		images: false,
	});
}

function fixture(readManifest?: () => ExternalConnectorVendorBehaviorManifest) {
	fixtureId += 1;
	const capability = snapshot();
	const session = new Session(new InMemorySessionStorage({ id: `capability-${fixtureId}`, createdAt: fixtureId }));
	const supervision = createExternalConnectorTestSupervision();
	const driver = new DeclarationDriver();
	const connector = createDurableExternalAgentConnector({
		providerId: PROVIDER_ID,
		capability,
		capabilityProbe: async () => Result.ok(capability),
		store: new SessionExternalConnectorDurableStore(new SessionLedger(session)),
		driver,
		supervision: supervision.options,
		now: () => NOW,
	});
	if (readManifest !== undefined) bindExternalConnectorVendorBehaviorManifest(connector, readManifest);
	return { capability, connector, driver };
}

function registry() {
	return createExternalConnectorRegistry({
		toolGateway: createFoundationToolGateway({
			gatewayId: "capability-declaration-gateway",
			providers: [createLocalToolGatewayProvider({
				providerId: "builtin.capability-declaration",
				revision: 1,
				routes: [{
					kind: "local",
					namespace: "workspace",
					toolName: "workspace.read",
					providerId: "builtin.capability-declaration",
					revision: 1,
					operation: { resource: "filesystem.read", effects: ["read"] },
				}],
				invoke: async (request) => Result.ok({
					schemaVersion: 1,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					ok: true,
					sideEffectState: "none",
				}),
			})],
		}),
	});
}

function registration(value: ReturnType<typeof fixture>) {
	return {
		descriptor: {
			schemaVersion: 1 as const,
			providerId: PROVIDER_ID,
			providerClass: PROVIDER_CLASS.externalConnector,
			revision: value.capability.revision,
			capabilitySnapshotDigest: value.capability.digest,
		},
		connector: value.connector,
	};
}

describe("External Connector capability behavior declaration", () => {
	it("fails registration closed when toolGateway true has no adapter behavior manifest", async () => {
		const value = fixture();
		const target = registry();

		expect(target.registerPrepared(registration(value), value.capability)).toMatchObject({
			ok: false,
			error: { code: "external_connector_not_ready" },
		});
		expect(value.driver.spawnCalls).toBe(0);
		await value.connector.dispose();
		await target.dispose();
	});

	it.each([
		{ name: "request event", events: [] as string[], writes: ["tool_gateway_result"] },
		{ name: "result write", events: ["tool_gateway_request"], writes: [] as string[] },
	])("fails registration closed when toolGateway true omits the $name behavior", async ({ events, writes }) => {
		const value = fixture(() => ({ schemaVersion: 1, revision: 1, events, writes }));
		const target = registry();

		expect(target.registerPrepared(registration(value), value.capability)).toMatchObject({
			ok: false,
			error: { code: "external_connector_not_ready" },
		});
		expect(value.driver.spawnCalls).toBe(0);
		await value.connector.dispose();
		await target.dispose();
	});

	it("rechecks the behavior manifest at selection without waiting for an event", async () => {
		let manifest: ExternalConnectorVendorBehaviorManifest = {
			schemaVersion: 1,
			revision: 1,
			events: ["started", "tool_gateway_request"],
			writes: ["tool_gateway_result"],
		};
		const value = fixture(() => manifest);
		const target = registry();
		expect(target.registerPrepared(registration(value), value.capability)).toMatchObject({ ok: true });
		manifest = { ...manifest, revision: 2, writes: [] };

		expect(await target.select({
			providerId: PROVIDER_ID,
			revision: value.capability.revision,
			capabilitySnapshotDigest: value.capability.digest,
		})).toMatchObject({ ok: false, error: { code: "external_connector_not_ready" } });
		expect(value.driver.spawnCalls).toBe(0);
		await target.dispose();
	});

	it("deep-freezes the adapter behavior facts used by capability truth", async () => {
		const source = {
			schemaVersion: 1 as const,
			revision: 1,
			events: ["started", "tool_gateway_request"],
			writes: ["tool_gateway_result"],
		};
		const value = fixture(() => source);
		const manifest = readExternalConnectorVendorBehaviorManifest(value.connector);

		expect(manifest).toEqual(source);
		expect(manifest).not.toBe(source);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest?.events)).toBe(true);
		expect(Object.isFrozen(manifest?.writes)).toBe(true);
		await value.connector.dispose();
	});
});
