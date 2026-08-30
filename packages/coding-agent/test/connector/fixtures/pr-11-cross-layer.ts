import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ContextLedger,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	type SessionLedgerWriter,
	type ToolGateway,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "../../../../agent/src/internal.ts";
import {
	createDurableExternalAgentConnector,
	type DurableExternalAgentConnector,
	type ExternalConnectorCredentialRuntime,
} from "../../../src/core/connector/durable-connector.ts";
import { SessionExternalConnectorDurableStore } from "../../../src/core/connector/operation.ts";
import {
	createExternalConnectorRegistry,
	type ExternalConnectorRegistry,
} from "../../../src/core/connector/registry.ts";
import {
	bindExternalConnectorVendorBehaviorManifest,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE,
} from "../../../src/core/connector/tool-gateway-binding.ts";
import { PROVIDER_CLASS } from "../../../src/core/connector/provider-class.ts";
import { createExternalConnectorTestSupervision } from "../external-connector-test-supervision.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../../src/core/connector/vendor/types.ts";
import {
	buildExternalConnectorTargetConfig,
	type ExternalConnectorResolvedTarget,
	type ExternalConnectorTargetConfig,
	type ExternalConnectorTargetDefinition,
} from "../../../src/external-connector.ts";
import type {
	AgentRuntimeCompositionContext,
	ExternalConnectorProductAuthority,
	ExternalConnectorRegistryFactory,
} from "../../../src/core/runtime/composition.ts";
import {
	executeExternalConnectorProductRun,
	type ExternalConnectorProductExecution,
} from "../../../src/core/connector/product-run.ts";
import type { CapabilityBinding } from "../../../src/core/policy/capability-registry.ts";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
	type PolicyBinding,
} from "../../../src/core/policy/execution.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../../../src/core/policy/task-credential-provider.ts";
import type { TaskCredentialDeliveryReceipt, TaskCredentialScope } from "../../../src/core/policy/task-credential-lease.ts";

export const PR11_NOW = "2026-08-31T00:00:00.000Z";
export const PR11_CREDENTIAL_CANARY = "pr11-external-credential-material-canary";
export const PR11_JSONL_FIXTURE_PATH = join(import.meta.dirname, "../../fixtures/external-connector-jsonl-driver.mjs");
export const PR11_SCOPE: TaskCredentialScope = {
	credentialName: "external_registry",
	purpose: "dependency_read",
	operations: ["read"],
	targetKinds: ["external_connector"],
};

export function fileIdentity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export interface Pr11TargetOptions {
	readonly targetId?: string;
	readonly providerId?: string;
	readonly modulePath?: string;
	readonly version?: string;
	readonly executableIdentity?: string;
	readonly moduleIdentity?: string;
	readonly accountReference?: ExternalConnectorTargetDefinition["accountReference"];
	readonly toolGateway?: boolean;
}

export function pr11TargetDefinition(cwd: string, options: Pr11TargetOptions = {}): ExternalConnectorTargetDefinition {
	const modulePath = options.modulePath ?? PR11_JSONL_FIXTURE_PATH;
	const executablePath = process.execPath;
	return {
		schemaVersion: 1,
		targetId: options.targetId ?? "pr11-cross-layer-target",
		providerId: options.providerId ?? "fixture.external-jsonl",
		executablePath,
		modulePath,
		cwd,
		version: options.version ?? "1",
		executableIdentity: options.executableIdentity ?? fileIdentity(executablePath),
		moduleIdentity: options.moduleIdentity ?? fileIdentity(modulePath),
		...(options.accountReference === undefined
			? {}
			: { accountReference: options.accountReference }),
		capabilityCeiling: {
			modelAccess: ["none"],
			resume: false,
			toolGateway: options.toolGateway ?? false,
			artifacts: false,
			images: false,
		},
	};
}

export function pr11TargetConfig(cwd: string, options: Pr11TargetOptions = {}): ExternalConnectorTargetConfig {
	const definition = pr11TargetDefinition(cwd, options);
	return buildExternalConnectorTargetConfig({
		global: { schemaVersion: 1, targets: [definition] },
		explicitTargetId: definition.targetId,
	});
}

export type Pr11DriverMode = "complete" | "tool_gateway" | "unknown" | "unauthorized" | "orphan" | "nonce";

export class Pr11RecordingDriver implements ExternalConnectorVendorDriver {
	readonly mode: Pr11DriverMode;
	readonly spawnRequests: ExternalConnectorDriverSpawnRequest[] = [];
	readonly writes: ExternalConnectorDriverWriteRequest[] = [];
	readCalls = 0;

	constructor(mode: Pr11DriverMode) {
		this.mode = mode;
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnRequests.push(request);
		return {
			externalSessionId: `pr11-session-${request.attempt.attemptId}`,
			externalTurnId: `pr11-turn-${request.attempt.attemptId}`,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(handle: ExternalConnectorDriverHandle): AsyncIterable<FoundationJsonValue> {
		const request = this.spawnRequests.at(-1);
		if (request === undefined) return;
		yield {
			schemaVersion: 1,
			type: "started",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			producedAt: PR11_NOW,
		};
		if (this.mode === "complete") return;
		const operationId = request.correlation.operationId;
		if (operationId === undefined) throw new Error("PR-11 fixture requires an operation id");
		const requestOperationId = this.mode === "orphan" ? "pr11-orphan-operation" : operationId;
		const toolName =
			this.mode === "unknown"
				? "workspace.unknown"
				: this.mode === "unauthorized"
					? "workspace.write"
					: "workspace.read";
		const toolRequest: ToolGatewayRequest = {
			schemaVersion: 1,
			toolCallId: `pr11-tool-call-${requestOperationId}`,
			toolName,
			namespace: "workspace",
			originalArguments: { path: "docs/input.txt" },
			idempotencyKey: `pr11-idempotency-${requestOperationId}`,
			context: {
				schemaVersion: 1,
				bindingId: request.attempt.bindingId,
				bindingEpochId: request.attempt.bindingEpochIds[0]!,
				taskId: request.attempt.taskId,
				dispatchId: request.attempt.dispatchId,
				providerId: request.capability.providerId,
				attemptId: request.attempt.attemptId,
				operationId: requestOperationId,
			},
		};
		yield {
			schemaVersion: 1,
			type: "tool_gateway_request",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			operationNonce: this.mode === "nonce" ? `${handle.operationNonce}-orphan` : handle.operationNonce,
			request: toolRequest as unknown as FoundationJsonValue,
			producedAt: PR11_NOW,
		} as unknown as FoundationJsonValue;
	}

	async connect(mapping: { readonly externalSessionId: string; readonly externalTurnId?: string; readonly supervisor: { readonly ref: string; readonly nonce: string } }): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: mapping.externalSessionId,
			...(mapping.externalTurnId === undefined ? {} : { externalTurnId: mapping.externalTurnId }),
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};
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
			producedAt: PR11_NOW,
		};
	}

	async write(_handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.writes.push(request);
	}

	async heartbeat(): Promise<void> {}

	async cancel(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		return {
			externalSessionId: handle.externalSessionId,
			externalTurnId: handle.externalTurnId,
			operationNonce: handle.operationNonce,
			status: "cancelled",
			artifacts: [],
			sideEffectState: "none",
			producedAt: PR11_NOW,
		};
	}

	async dispose(): Promise<void> {}
}

export interface Pr11RegistryCapture {
	readonly target: ExternalConnectorResolvedTarget;
	readonly authority: ExternalConnectorProductAuthority;
	readonly credential: ExternalConnectorCredentialRuntime | undefined;
	readonly toolGateway: ToolGateway | undefined;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly driver: Pr11RecordingDriver;
	readonly connector: DurableExternalAgentConnector;
	readonly registry: ExternalConnectorRegistry;
}

export function createPr11RegistryFactory(options: {
	readonly mode: Pr11DriverMode;
	readonly bindBehaviorManifest?: boolean;
	readonly captures?: Pr11RegistryCapture[];
}): ExternalConnectorRegistryFactory {
	return (context, toolGateway, target, authority, credential) => {
		if (target === undefined) throw new TypeError("PR-11 fixture requires an explicitly selected target");
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: target.providerId,
			revision: 1,
			protocol: { name: target.providerId, version: target.version },
			modelAccess: target.capabilityCeiling.modelAccess[0]!,
			resume: target.capabilityCeiling.resume,
			toolGateway: target.capabilityCeiling.toolGateway,
			artifacts: target.capabilityCeiling.artifacts,
			images: target.capabilityCeiling.images,
		});
		const driver = new Pr11RecordingDriver(options.mode);
		const ledger = new SessionLedger(context.session, {
			ownerId: `pr11-cross-layer:${context.sessionId}`,
			writer: context.harness.ledger.writer,
		});
		const connector = createDurableExternalAgentConnector({
			providerId: target.providerId,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: new SessionExternalConnectorDurableStore(ledger),
			driver,
			supervision: createExternalConnectorTestSupervision().options,
			...(credential === undefined ? {} : { credential }),
			now: () => PR11_NOW,
			operationNonce: () => `pr11-nonce-${context.sessionId}`,
		});
		if (capability.toolGateway && options.bindBehaviorManifest !== false) {
			bindExternalConnectorVendorBehaviorManifest(connector, () => ({
				schemaVersion: 1,
				revision: 1,
				events: [EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT],
				writes: [EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE],
			}));
		}
		const registry = createExternalConnectorRegistry({
			...(toolGateway === undefined ? {} : { toolGateway }),
		});
		const registered = registry.registerPrepared({
			descriptor: {
				schemaVersion: 1,
				providerId: target.providerId,
				providerClass: PROVIDER_CLASS.externalConnector,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			},
			connector,
		}, capability);
		if (!registered.ok) {
			void connector.dispose().catch(() => undefined);
			throw registered.error;
		}
		options.captures?.push({ target, authority, credential, toolGateway, capability, driver, connector, registry });
		return registry;
	};
}

export function createPr11ToolGateway(onExecute?: (request: ToolGatewayRequest) => void): ToolGateway {
	const providerId = "pr11-builtin-tools";
	const routes: readonly ToolGatewayRoute[] = [
		{
			kind: "local",
			namespace: "workspace",
			toolName: "workspace.read",
			providerId,
			revision: 1,
			operation: { resource: "filesystem.read", effects: ["read"] },
		},
		{
			kind: "local",
			namespace: "workspace",
			toolName: "workspace.write",
			providerId,
			revision: 1,
			operation: { resource: "filesystem.write", effects: ["write", "create"] },
		},
	];
	return createFoundationToolGateway({
		gatewayId: "pr11-cross-layer-gateway",
		providers: [createLocalToolGatewayProvider({
			providerId,
			revision: 1,
			routes,
			invoke: async (request) => {
				onExecute?.(request);
				return Result.ok({
					schemaVersion: 1,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					ok: true,
					sideEffectState: "none",
					toolReceiptRef: `pr11-tool-receipt-${request.toolCallId}`,
				});
			},
		})],
	});
}

export function pr11CapabilityBinding(runId: string): CapabilityBinding {
	return {
		id: `pr11-capability-${runId}`,
		profile: `pr11-policy-${runId}`,
		createdAt: PR11_NOW,
		descriptors: [
			{
				id: "pr11-workspace-read",
				revision: "1",
				kind: "builtin_tool",
				name: "workspace.read",
				exposedToolName: "workspace.read",
			},
			{
				id: "pr11-workspace-write",
				revision: "1",
				kind: "builtin_tool",
				name: "workspace.write",
				exposedToolName: "workspace.write",
			},
		],
		decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
		toolAllowlist: ["workspace.read"],
	};
}

export function pr11PolicyBinding(runId: string, capability: CapabilityBinding): PolicyBinding {
	const profile: ExecutionPolicyProfile = {
		id: `pr11-policy-${runId}`,
		enforcement: "host",
		defaultAction: "deny",
		workspace: { read: ["workspace"], write: [], deny: ["credentials", "agent-internal"] },
		process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
		network: { action: "deny", allowDestinations: [] },
		credentials: { action: "deny", allowNames: [] },
		approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "deny" },
	};
	const resolved = resolveExecutionPolicyProfile({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		workspaceIdentity: "workspace-pr11-cross-layer",
		runId,
		createdAt: PR11_NOW,
		capabilityBinding: { id: capability.id },
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.binding;
}

export async function executePr11ProductRun(
	context: AgentRuntimeCompositionContext,
	capture: Pr11RegistryCapture,
	runId: string,
): Promise<ExternalConnectorProductExecution> {
	const capabilityBinding = pr11CapabilityBinding(runId);
	const message = `Execute PR-11 cross-layer run ${runId}`;
	return executeExternalConnectorProductRun({
		session: context.session,
		writer: context.harness.ledger.writer as SessionLedgerWriter,
		registry: capture.registry,
		selection: {
			providerId: capture.capability.providerId,
			revision: capture.capability.revision,
			capabilitySnapshotDigest: capture.capability.digest,
		},
		runId,
		message,
		canonicalInput: { schemaVersion: 1, text: message, artifacts: [] },
		inputAdmission: { inspectArtifact: () => { throw new Error("PR-11 fixture has no artifacts"); } },
		workspace: "workspace-pr11-cross-layer",
		policyBinding: pr11PolicyBinding(runId, capabilityBinding),
		capabilityBinding: capture.capability.toolGateway ? capabilityBinding : undefined,
		now: () => PR11_NOW,
	});
}

export interface Pr11SyntheticCompositionContext {
	readonly session: Session;
	readonly context: AgentRuntimeCompositionContext;
	readonly writer: SessionLedgerWriter;
}

export function createPr11SyntheticCompositionContext(sessionId: string): Pr11SyntheticCompositionContext {
	const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
	const ledger = new ContextLedger(session, { ownerId: `pr11-context:${sessionId}` });
	const writer = ledger.writer as SessionLedgerWriter;
	return {
		session,
		writer,
		context: {
			session,
			harness: { ledger: { writer } },
			sessionId,
			models: {},
		} as unknown as AgentRuntimeCompositionContext,
	};
}

export class Pr11CredentialTarget {
	readonly projectedMaterials: string[] = [];
	readonly renewals: TaskCredentialTargetRenewRequest[] = [];
	readonly revocations: TaskCredentialTargetRevokeRequest[] = [];

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest) {
		return {
			schemaVersion: 1 as const,
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
		readonly scopes: readonly TaskCredentialScope[];
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
	}): TaskCredentialDeliveryReceipt {
		this.projectedMaterials.push(...Object.values(request.material));
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "succeeded",
			recordedAt: PR11_NOW,
			...(request.targetId === undefined ? {} : { targetId: request.targetId }),
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
			recordedAt: PR11_NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		this.revocations.push(request);
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: PR11_NOW,
		};
	}
}

export function createPr11CredentialProvider(target = new Pr11CredentialTarget()): {
	readonly provider: TaskCredentialTestProvider;
	readonly target: Pr11CredentialTarget;
} {
	return {
		provider: createTaskCredentialTestProvider({
			materials: { external_registry: PR11_CREDENTIAL_CANARY },
			target,
			now: () => PR11_NOW,
		}),
		target,
	};
}

export function pr11CredentialPolicySettings(): {
	readonly defaultProfile: string;
	readonly profiles: Record<string, unknown>;
} {
	const profileId = "pr11-external-credential-policy";
	return {
		defaultProfile: profileId,
		profiles: {
			[profileId]: {
				id: profileId,
				enforcement: "host",
				defaultAction: "allow",
				workspace: { read: ["workspace"], write: [], deny: ["credentials", "agent-internal"] },
				process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
				network: { action: "deny", allowDestinations: [] },
				credentials: { action: "allow", allowNames: ["external_registry"] },
				approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "deny", credentials: "allow" },
				rules: [],
			},
		},
	};
}
