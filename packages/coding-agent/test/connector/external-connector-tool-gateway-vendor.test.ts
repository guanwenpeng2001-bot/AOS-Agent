import {
	InMemorySessionStorage,
	ContextLedger,
	Result,
	Session,
	SessionLedger,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	type SessionLedgerWriter,
	type ToolGatewayProvider,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import { createDurableExternalAgentConnector } from "../../src/core/connector/durable-connector.ts";
import { SessionExternalConnectorDurableStore } from "../../src/core/connector/operation.ts";
import {
	bindExternalConnectorToolGatewayConsumer,
	createExternalConnectorRegistry,
} from "../../src/core/connector/registry.ts";
import {
	executePreparedExternalConnectorProductRun,
	persistExternalConnectorProductRunAfterAcceptance,
	prepareExternalConnectorProductRun,
	type ExternalConnectorProductExecutionInput,
} from "../../src/core/connector/product-run.ts";
import { PROVIDER_CLASS } from "../../src/core/connector/provider-class.ts";
import { bindExternalConnectorVendorBehaviorManifest } from "../../src/core/connector/tool-gateway-binding.ts";
import type { CapabilityBinding } from "../../src/core/policy/capability-registry.ts";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
} from "../../src/core/policy/execution.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/connector/vendor/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const NOW = "2026-08-31T00:00:00.000Z";
const PROVIDER_ID = "third-party.vendor-tool-gateway";

class VendorToolGatewayDriver implements ExternalConnectorVendorDriver {
	readonly spawnRequests: ExternalConnectorDriverSpawnRequest[] = [];
	readonly writes: ExternalConnectorDriverWriteRequest[] = [];
	#request: ExternalConnectorDriverSpawnRequest | undefined;

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnRequests.push(request);
		this.#request = request;
		return {
			externalSessionId: "vendor-tool-gateway-session",
			externalTurnId: "vendor-tool-gateway-turn",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(handle: ExternalConnectorDriverHandle): AsyncIterable<FoundationJsonValue> {
		const request = this.#request;
		if (request === undefined) return;
		const operationId = request.correlation.operationId;
		if (operationId === undefined) throw new Error("vendor fixture requires an operation id");
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
				toolCallId: `vendor-call-${operationId}`,
				toolName: "workspace.read",
				namespace: "workspace",
				originalArguments: { path: "docs/input.txt" },
				idempotencyKey: `vendor-idempotency-${operationId}`,
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
		throw new Error("not used");
	}
	async lookup(): Promise<ExternalConnectorDriverLookup> {
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
	async write(_handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.writes.push(request);
	}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<ExternalConnectorTerminalEvidence | undefined> {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

const POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "vendor-tool-gateway-policy",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: [], deny: ["credentials", "agent-internal"] },
	process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "deny" },
};

function capabilityBinding(runId: string): CapabilityBinding {
	return {
		id: `vendor-capability-${runId}`,
		profile: POLICY_PROFILE.id,
		createdAt: NOW,
		descriptors: [
			{ id: "builtin-read", revision: "1", kind: "builtin_tool", name: "workspace.read", exposedToolName: "workspace.read" },
			{ id: "builtin-write", revision: "1", kind: "builtin_tool", name: "workspace.write", exposedToolName: "workspace.write" },
			{ id: "mcp-server-docs", revision: "1", kind: "mcp_server", name: "docs", mcpServerId: "docs" },
			{
				id: "mcp-tool-docs-list",
				revision: "1",
				kind: "mcp_tool",
				name: "list",
				exposedToolName: "mcp__docs__list",
				parentId: "mcp-server-docs",
				mcpServerId: "docs",
			},
		],
		decisionSummary: { allowed: 4, awaitingApproval: 0, denied: 0 },
		toolAllowlist: ["workspace.read", "workspace.write", "mcp__docs__list"],
	};
}

function policyBinding(runId: string, capability: CapabilityBinding) {
	const result = resolveExecutionPolicyProfile({
		profiles: { [POLICY_PROFILE.id]: POLICY_PROFILE },
		defaultProfile: POLICY_PROFILE.id,
		workspaceIdentity: "workspace-vendor-tool-gateway",
		runId,
		createdAt: NOW,
		capabilityBinding: { id: capability.id },
	});
	if (!result.ok) throw result.error;
	return result.binding;
}

function capabilitySnapshot(): ConnectorCapabilitySnapshot {
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

function productInput(
	session: Session,
	writer: SessionLedgerWriter,
	registry: ReturnType<typeof createExternalConnectorRegistry>,
	capability: ConnectorCapabilitySnapshot,
	runId: string,
): ExternalConnectorProductExecutionInput {
	const binding = capabilityBinding(runId);
	const message = `Execute vendor Tool Gateway run ${runId}`;
	return {
		session,
		writer,
		registry,
		selection: {
			providerId: PROVIDER_ID,
			revision: capability.revision,
			capabilitySnapshotDigest: capability.digest,
		},
		runId,
		message,
		canonicalInput: { schemaVersion: 1, text: message, artifacts: [] },
		inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
		workspace: "workspace-vendor-tool-gateway",
		policyBinding: policyBinding(runId, binding),
		capabilityBinding: binding,
		now: () => NOW,
	};
}

describe("External Connector vendor Tool Gateway", () => {
	it("exposes only the frozen Binding, Policy, exact MCP, and catalog intersection and writes back once", async () => {
		let providerEffects = 0;
		const builtinProviderId = "builtin.vendor-tools";
		const mcpProviderId = "mcp.vendor-docs";
		const mcpProvider: ToolGatewayProvider = {
			providerId: mcpProviderId,
			kind: "mcp",
			revision: 7,
			routes: [
				{
					kind: "mcp",
					namespace: "docs",
					toolName: "list",
					providerId: mcpProviderId,
					revision: 7,
					operation: { resource: "filesystem.read", effects: ["read"] },
				},
				{
					kind: "mcp",
					namespace: "docs",
					toolName: "delete",
					providerId: mcpProviderId,
					revision: 7,
					operation: { resource: "filesystem.write", effects: ["delete"] },
				},
			],
			capabilities: async () => [],
			execute: async (request) => Result.ok({
				schemaVersion: 1,
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				ok: true,
				sideEffectState: "none",
			}),
			dispose: async () => {},
		};
		const toolGateway = createFoundationToolGateway({
			gatewayId: "vendor-tool-gateway",
			providers: [
				createLocalToolGatewayProvider({
					providerId: builtinProviderId,
					revision: 3,
					routes: [
						{
							kind: "local",
							namespace: "workspace",
							toolName: "workspace.read",
							providerId: builtinProviderId,
							revision: 3,
							operation: { resource: "filesystem.read", effects: ["read"] },
						},
						{
							kind: "local",
							namespace: "workspace",
							toolName: "workspace.write",
							providerId: builtinProviderId,
							revision: 3,
							operation: { resource: "filesystem.write", effects: ["write", "create"] },
						},
					],
					invoke: async (request) => {
						providerEffects += 1;
						return Result.ok({
							schemaVersion: 1,
							toolCallId: request.toolCallId,
							toolName: request.toolName,
							ok: true,
							sideEffectState: "none",
							toolReceiptRef: `vendor-receipt-${request.toolCallId}`,
						});
					},
				}),
				mcpProvider,
			],
		});
		const capability = capabilitySnapshot();
		const session = new Session(new InMemorySessionStorage({ id: "vendor-tool-gateway-session", createdAt: 1 }));
		const ledger = new ContextLedger(session, { ownerId: "vendor-tool-gateway-test" });
		const driver = new VendorToolGatewayDriver();
		const connector = createDurableExternalAgentConnector({
			providerId: PROVIDER_ID,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: ledger.writer })),
			driver,
			supervision: createExternalConnectorTestSupervision().options,
			now: () => NOW,
			operationNonce: () => "vendor-tool-gateway-nonce",
		});
		bindExternalConnectorVendorBehaviorManifest(connector, () => ({
			schemaVersion: 1,
			revision: 1,
			events: ["started", "tool_gateway_request"],
			writes: ["tool_gateway_result"],
		}));
		const registry = createExternalConnectorRegistry({ toolGateway });
		expect(registry.registerPrepared({
			descriptor: {
				schemaVersion: 1,
				providerId: PROVIDER_ID,
				providerClass: PROVIDER_CLASS.externalConnector,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			},
			connector,
		}, capability)).toMatchObject({ ok: true });

		const runId = "run-vendor-tool-gateway";
		const admission = await prepareExternalConnectorProductRun(
			productInput(session, ledger.writer, registry, capability, runId),
		);
		const prepared = await persistExternalConnectorProductRunAfterAcceptance(admission);
		const bound = bindExternalConnectorToolGatewayConsumer(
			prepared.selected,
			prepared.initialBindingEpoch.attemptId,
			prepared.binding,
			prepared.input.policyBinding,
		);
		expect(bound.scope.routes).toEqual([
			{
				kind: "local",
				namespace: "workspace",
				toolName: "workspace.read",
				providerId: builtinProviderId,
				revision: 3,
				operation: { resource: "filesystem.read", effects: ["read"] },
			},
			{
				kind: "mcp",
				namespace: "docs",
				toolName: "list",
				providerId: mcpProviderId,
				revision: 7,
				operation: { resource: "filesystem.read", effects: ["read"] },
			},
		]);
		expect(Object.isFrozen(bound)).toBe(true);
		expect(Object.isFrozen(bound.scope)).toBe(true);
		expect(Object.isFrozen(bound.scope.routes)).toBe(true);
		expect(bound.scope).not.toHaveProperty("policyBinding");
		expect(bound.scope).not.toHaveProperty("catalog");
		expect(bound.scope).not.toHaveProperty("credentials");
		bound.release();

		const execution = await executePreparedExternalConnectorProductRun(prepared);
		expect(providerEffects).toBe(1);
		expect(driver.spawnRequests).toHaveLength(1);
		expect(driver.writes).toEqual([{
			schemaVersion: 1,
			kind: "tool_gateway_result",
			operationNonce: "vendor-tool-gateway-nonce",
			result: execution.toolGatewayExchanges?.[0]?.result,
		}]);
		expect(execution).toMatchObject({
			runReceipt: { terminalStatus: "completed" },
			toolGatewayExchanges: [{
				request: { toolName: "workspace.read" },
				result: { ok: true, sideEffectState: "none" },
			}],
		});
		await registry.dispose();
		await toolGateway.dispose();
	});
});
