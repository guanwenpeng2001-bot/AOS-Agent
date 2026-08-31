import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type AgentHarness,
	createSandboxOperationToolGatewayProvider,
	EVENT_CATALOG,
	executeOperation,
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type SandboxOperationRequest,
} from "../../../agent/src/internal.ts";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { googleProvider } from "@aos-agent/ai/providers/google";
import { describe, expect, it, vi } from "vitest";
import {
	FoundationControlPlane,
	type FoundationControlPlaneOptions,
} from "../../src/core/runtime/control-plane.ts";
import { CanonicalAgentSessionServices } from "../../src/core/session/facade.ts";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
} from "../../src/core/policy/execution.ts";
import {
	createBuiltinToolPolicy,
	createSandboxHandleOperationProvider,
} from "../../src/core/policy/sandbox-host.ts";
import { resolveWorkerSandboxOperation, type SandboxHandle } from "../../src/core/policy/sandbox.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import {
	createHarnessCompatibilityWriter,
	createSessionManagerStorage,
} from "../../src/core/session/manager-storage.ts";
import type { TaskCredentialDeliveryReceipt, TaskCredentialScope } from "../../src/core/policy/task-credential-lease.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../../src/core/policy/task-credential-provider.ts";
import { TaskCredentialService } from "../../src/core/policy/task-credential-service.ts";
import {
	parseOperationWorkerFrame,
	serializeWorkerFrameLine,
	type SafeLeaseProjection,
	type SafeLeaseReference,
	type OperationWorkerEventFrame,
	type OperationWorkerRequestFrame,
	validateOperationWorkerEventFrame,
} from "../../src/core/worker/protocol.ts";
import {
	WorkerSandboxProvider,
	createWorkerRequestFingerprint,
	type WorkerSandboxFact,
	type WorkerCredentialDetach,
	type WorkerSandboxProviderOptions,
	type WorkerSandboxPreflightFacts,
	type WorkerSandboxProfile,
} from "../../src/core/worker/sandbox-provider.ts";
import {
	OperationWorkerSupervisor,
	type WorkerActivationPlan,
	type WorkerSupervisorConfig,
} from "../../src/core/worker/supervisor.ts";
import type { WorkerBinding, WorkerRecord } from "../../src/core/worker/lifecycle.ts";
import { runOperationWorkerProcess } from "../../src/worker-entry.ts";
import {
	createCodingAgentHarness,
	createCodingAgentHarnessFromTrustedProvidersForTest,
} from "../../src/server/create-harness.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const REAL_CHILD_ENTRY = fileURLToPath(new URL("../fixtures/real-sandbox-worker-launcher.mjs", import.meta.url));
const WORKER_ASYNC_WAIT_TIMEOUT_MS = 5_000;

const CHILD_POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "worker-child-sandbox",
	enforcement: "sandbox",
	sandboxProvider: "sandbox-worker",
	defaultAction: "allow",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
	rules: [{ resource: "filesystem.write", action: "deny" }],
};

const REAL_CHILD_POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "real-worker-sandbox",
	enforcement: "sandbox",
	sandboxProvider: "sandbox-worker",
	defaultAction: "allow",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
};

function realChildPolicyBinding(runId: string) {
	const resolved = resolveExecutionPolicyProfile({
		profiles: { [REAL_CHILD_POLICY_PROFILE.id]: REAL_CHILD_POLICY_PROFILE },
		defaultProfile: REAL_CHILD_POLICY_PROFILE.id,
		workspaceIdentity: "real-worker-workspace",
		runId,
		createdAt: "2026-08-21T00:00:00.000Z",
		sandbox: {
			providerConfigured: true,
			providerId: "sandbox-worker",
			providerStatus: "ready",
			providerCapabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
		},
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.binding;
}

function childPolicy(
	execute: SandboxHandle["execute"],
	capabilities: SandboxHandle["capabilities"] = { filesystem: true, process: true, network: false, credentialIsolation: true },
) {
	const resolved = resolveExecutionPolicyProfile({
		profiles: { [CHILD_POLICY_PROFILE.id]: CHILD_POLICY_PROFILE },
		defaultProfile: CHILD_POLICY_PROFILE.id,
		workspaceIdentity: "worker-child-workspace",
		runId: "run-child",
		createdAt: "2026-08-21T00:00:00.000Z",
		sandbox: {
			providerConfigured: true,
			providerId: "sandbox-worker",
			providerStatus: "ready",
			providerCapabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
		},
	});
	if (!resolved.ok) throw resolved.error;
	const handle: SandboxHandle = {
		id: "child-sandbox-handle",
		bindingId: resolved.binding.id,
		providerId: "sandbox-worker",
		status: "ready",
		capabilities,
		execute,
	};
	return createBuiltinToolPolicy({
		profile: CHILD_POLICY_PROFILE,
		binding: resolved.binding,
		roots: { workspace: process.cwd() },
		sandbox: handle,
		source: "builtin",
	});
}

function operation(operationId = "operation-1", deadlineAt?: number): SandboxOperationRequest {
	return {
		schemaVersion: 1,
		operationId,
		providerId: "sandbox-worker",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		taskId: "task-1",
		dispatchId: "dispatch-1",
		attemptId: "attempt-1",
		payload: { resource: "filesystem.read", operation: "file.read", path: "README.md" },
		...(deadlineAt === undefined ? {} : { deadlineAt }),
	};
}

function correlation(operationId = "operation-1"): ExecutionCorrelation {
	return {
		sessionId: "session-1",
		laneId: "main",
		runId: "run-1",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		taskId: "task-1",
		dispatchId: "dispatch-1",
		attemptId: "attempt-1",
		providerId: "sandbox-worker",
		operationId,
		revision: 0,
	};
}

function binding(request: SandboxOperationRequest, profileId: string): WorkerBinding {
	return {
		schemaVersion: 1,
		workerId: `worker-${request.operationId}`,
		providerId: "sandbox-worker",
		sessionId: "session-1",
		laneId: "main",
		runId: "run-1",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		attemptId: "attempt-1",
		profileId,
		profileRevision: 1,
		capabilitySummary: ["filesystem.read", "process.spawn"],
		...(request.deadlineAt === undefined ? { deadlineAt: Date.now() + 10_000 } : { deadlineAt: request.deadlineAt }),
		credentialTargetRefs: [],
		requestFingerprint: createWorkerRequestFingerprint(request),
	};
}

function facts(request: SandboxOperationRequest, profileId: string): WorkerSandboxPreflightFacts {
	return {
		binding: binding(request, profileId),
		runAccepted: true,
		sessionOwned: true,
		laneOwned: true,
		bindingAuthorized: true,
		policyAuthorized: true,
		sandboxAuthorized: true,
		credentialLeaseActive: true,
	};
}

function provider(
	profileId: string | undefined,
	overrides: {
		readonly resolvePreflight?: (
				request: SandboxOperationRequest,
				options: Parameters<WorkerSandboxProviderOptions["resolvePreflight"]>[1],
			) => WorkerSandboxPreflightFacts | Promise<WorkerSandboxPreflightFacts>;
		readonly onRecord?: (record: WorkerRecord) => void;
		readonly onCreate?: () => void;
		readonly requireRegisteredPayload?: boolean;
		readonly createSupervisor?: (config: WorkerSupervisorConfig) => OperationWorkerSupervisor;
		readonly durableOwner?: string | false;
		readonly durableSink?: (fact: WorkerSandboxFact) => void;
		readonly maxRetainedRecords?: number;
	} = {},
): WorkerSandboxProvider {
	const current = new WorkerSandboxProvider({
		providerId: "sandbox-worker",
		...(profileId === undefined
			? {}
			: {
				profile: {
					profileId,
					profileRevision: 1,
					trusted: true,
					supervisor: {
						executable: process.execPath,
						entrypoint: CHILD_ENTRY,
						profileId,
						profileRevision: 1,
						capabilities: ["filesystem.read", "process.spawn"],
						environment: { AOS_SAFE_TEST_MARKER: "1" },
						readyTimeoutMs: 2_000,
						heartbeatTimeoutMs: 2_000,
						cancelTimeoutMs: 120,
						terminateTimeoutMs: 500,
					},
				},
			}),
		resolvePreflight: overrides.resolvePreflight ?? ((request) => facts(request, profileId ?? "disabled")),
		createSupervisor: (config) => {
			overrides.onCreate?.();
			return overrides.createSupervisor?.(config) ?? new OperationWorkerSupervisor(config);
		},
		...(overrides.requireRegisteredPayload === undefined ? {} : { requireRegisteredPayload: overrides.requireRegisteredPayload }),
		...(overrides.onRecord === undefined ? {} : { onWorkerRecord: overrides.onRecord }),
		...(overrides.maxRetainedRecords === undefined ? {} : { maxRetainedRecords: overrides.maxRetainedRecords }),
	});
	if (overrides.durableOwner !== false) {
		current.bindDurableFactSink(overrides.durableOwner ?? "session-1", overrides.durableSink ?? (() => undefined));
	}
	return current;
}

class ReplayableWorkerSandboxProvider extends WorkerSandboxProvider {
	private replaySink: ((fact: WorkerSandboxFact) => void) | undefined;

	override bindDurableFactSink(ownerId: string, sink: (fact: WorkerSandboxFact) => void): () => void {
		const release = super.bindDurableFactSink(ownerId, sink);
		this.replaySink = sink;
		return () => {
			if (this.replaySink === sink) this.replaySink = undefined;
			release();
		};
	}

	replayFact(fact: WorkerSandboxFact): void {
		if (this.replaySink === undefined) throw new Error("Replay sink is not bound");
		this.replaySink(fact);
	}
}

class ActivationBarrierWorkerSupervisor extends OperationWorkerSupervisor {
	private resolveActivationEntered: () => void = () => undefined;
	readonly activationEntered = new Promise<void>((resolve) => { this.resolveActivationEntered = resolve; });

	override activate(plan: WorkerActivationPlan) {
		const activation = super.activate(plan);
		this.resolveActivationEntered();
		return activation;
	}
}

class ExecuteGateWorkerSupervisor extends OperationWorkerSupervisor {
	private resolveExecuteEntered: () => void = () => undefined;
	private releaseExecuteGate: () => void = () => undefined;
	readonly executeEntered = new Promise<void>((resolve) => { this.resolveExecuteEntered = resolve; });
	private readonly executeGate = new Promise<void>((resolve) => { this.releaseExecuteGate = resolve; });

	releaseExecute(): void {
		this.releaseExecuteGate();
	}

	override async execute(request: SandboxOperationRequest) {
		this.resolveExecuteEntered();
		await this.executeGate;
		return super.execute(request);
	}
}

function replayableProvider(
	onCreate?: () => void,
	resolvePreflight: WorkerSandboxProviderOptions["resolvePreflight"] = (request) => facts(request, "success"),
): ReplayableWorkerSandboxProvider {
	return new ReplayableWorkerSandboxProvider({
		providerId: "sandbox-worker",
		profile: {
			profileId: "success",
			profileRevision: 1,
			trusted: true,
			supervisor: {
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "success",
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
				environment: { AOS_SAFE_TEST_MARKER: "1" },
				readyTimeoutMs: 2_000,
				heartbeatTimeoutMs: 2_000,
				cancelTimeoutMs: 120,
				terminateTimeoutMs: 500,
			},
		},
		resolvePreflight,
		createSupervisor: (config) => {
			onCreate?.();
			return new OperationWorkerSupervisor(config);
		},
	});
}

function createWorkerControlPlane(
	sessionManager: SessionManager,
	workerSandboxProvider: WorkerSandboxProvider,
	options: {
		readonly cacheLimit?: number;
		readonly harness?: AgentHarness;
		readonly taskCredentialProvider?: TaskCredentialTestProvider;
	} = {},
): FoundationControlPlane {
	const harness = options.harness ?? ({
		toolsSnapshot: [],
		activeToolNamesSnapshot: [],
		setTools: async () => undefined,
		recordCustomEntry: (customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data),
	} as unknown as AgentHarness);
	return new FoundationControlPlane({
		harness,
		sessionManager,
		settingsManager: {
			getCapabilitySettings: () => ({ mcpServers: [] }),
		} as unknown as FoundationControlPlaneOptions["settingsManager"],
		resourceLoader: {} as FoundationControlPlaneOptions["resourceLoader"],
		modelRuntime: {} as FoundationControlPlaneOptions["modelRuntime"],
		extensionRunner: {
			getAllRegisteredTools: () => [],
		} as unknown as FoundationControlPlaneOptions["extensionRunner"],
		cwd: process.cwd(),
		agentDir: process.cwd(),
		workerSandboxProvider,
		...(options.taskCredentialProvider === undefined
			? {}
			: {
				taskCredentialProvider: options.taskCredentialProvider,
				taskCredentialPolicyMaxTtlMs: 300_000,
			}),
		...(options.cacheLimit === undefined ? {} : { workerFactCacheLimit: options.cacheLimit }),
	});
}

function realWorkerProvider(root: string, policyBindingId: string, runId: string): WorkerSandboxProvider {
	const capabilities = ["filesystem.read", "filesystem.write", "process.spawn"];
	const current = new WorkerSandboxProvider({
		providerId: "sandbox-worker",
		profile: {
			profileId: "real-worker-sandbox",
			profileRevision: 1,
			trusted: true,
			supervisor: {
				executable: process.execPath,
				entrypoint: REAL_CHILD_ENTRY,
				profileId: "real-worker-sandbox",
				profileRevision: 1,
				capabilities,
				environment: { AOS_AGENT_WORKER_SANDBOX_ROOT: root, AOS_AGENT_WORKER_RUN_ID: runId },
				// The test launcher compiles TypeScript before protocol stdout exists. Keep that
				// Windows full-suite bootstrap inside the Host-owned operation deadline.
				readyTimeoutMs: 20_000,
				heartbeatTimeoutMs: 3_000,
				cancelTimeoutMs: 120,
				terminateTimeoutMs: 500,
			},
		},
		requireRegisteredPayload: true,
		resolvePreflight: (request) => ({
			binding: {
				schemaVersion: 1,
				workerId: `worker-${request.operationId}`,
				providerId: "sandbox-worker",
				sessionId: "real-worker-session",
				laneId: "main",
				runId,
				bindingId: policyBindingId,
				...(request.bindingEpochId === undefined ? {} : { bindingEpochId: request.bindingEpochId }),
				...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
				profileId: "real-worker-sandbox",
				profileRevision: 1,
				capabilitySummary: capabilities,
				deadlineAt: request.deadlineAt ?? Date.now() + 30_000,
				credentialTargetRefs: [],
				requestFingerprint: createWorkerRequestFingerprint(request),
			},
			runAccepted: true,
			sessionOwned: true,
			laneOwned: true,
			bindingAuthorized: request.bindingId === policyBindingId,
			policyAuthorized: true,
			sandboxAuthorized: true,
			credentialLeaseActive: true,
		}),
		createSupervisor: (config) => new OperationWorkerSupervisor(config),
	});
	current.bindDurableFactSink("real-worker-session", () => undefined);
	return current;
}

async function waitForRecord(records: readonly WorkerRecord[], status: WorkerRecord["status"]): Promise<void> {
	const expires = Date.now() + WORKER_ASYNC_WAIT_TIMEOUT_MS;
	while (Date.now() < expires) {
		if (records.some((record) => record.status === status)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Timed out waiting for ${status}`);
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
	const expires = Date.now() + WORKER_ASYNC_WAIT_TIMEOUT_MS;
	while (Date.now() < expires) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

async function waitForWorkerFrame(
	frames: readonly OperationWorkerEventFrame[],
	predicate: (frame: OperationWorkerEventFrame) => boolean,
): Promise<OperationWorkerEventFrame> {
	const expires = Date.now() + WORKER_ASYNC_WAIT_TIMEOUT_MS;
	while (Date.now() < expires) {
		const frame = frames.find(predicate);
		if (frame !== undefined) return frame;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Timed out waiting for Worker frame: ${JSON.stringify(frames)}`);
}

const WORKER_CREDENTIAL_NOW = "2026-08-21T00:00:00.000Z";
const WORKER_CREDENTIAL_SECRET = "credential-material-never-enters-worker-queue";
const WORKER_CREDENTIAL_SCOPES: readonly TaskCredentialScope[] = Object.freeze([{
	credentialName: "registry",
	purpose: "read",
	operations: ["read"],
	targetKinds: ["operation_worker"],
}]);

class WorkerCredentialMaterialTarget {
	readonly materials: string[] = [];

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
		this.materials.push(...Object.values(request.material));
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "succeeded",
			recordedAt: WORKER_CREDENTIAL_NOW,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: WORKER_CREDENTIAL_NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: WORKER_CREDENTIAL_NOW,
		};
	}
}

function createWorkerCredentialService(
	current: WorkerSandboxProvider,
	workerId: string,
): {
	readonly service: TaskCredentialService;
	readonly session: SessionManager;
	readonly target: WorkerCredentialMaterialTarget;
	readonly clock: { nowMs: number };
	readonly detaches: WorkerCredentialDetach[];
	readonly providerRevocation: { readonly leaseIds: string[]; onRevoke?: () => void };
} {
	const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
	const target = new WorkerCredentialMaterialTarget();
	const clock = { nowMs: Date.parse(WORKER_CREDENTIAL_NOW) };
	const providerRevocation: { readonly leaseIds: string[]; onRevoke?: () => void } = { leaseIds: [] };
	const baseProvider = createTaskCredentialTestProvider({
		materials: { registry: WORKER_CREDENTIAL_SECRET },
		target,
		now: () => new Date(clock.nowMs).toISOString(),
	});
	const service = new TaskCredentialService({
		session,
		provider: {
			...baseProvider,
			issuer: {
				...baseProvider.issuer,
				revoke: (request) => {
					providerRevocation.onRevoke?.();
					providerRevocation.leaseIds.push(request.leaseId);
					return baseProvider.issuer.revoke(request);
				},
			},
		},
		workerTargets: current.getCredentialWorkerTargets(),
		preflight: { resolve: (input) => ({ allowed: true, boundedTtlMs: input.requestedTtlMs }) },
		policyMaxTtlMs: 300_000,
		now: () => new Date(clock.nowMs).toISOString(),
	});
	const detaches: WorkerCredentialDetach[] = [];
	current.bindCredentialDetachSink("session-1", (detach) => {
		detaches.push(detach);
		service.onWorkerDetach({
			workerId: detach.workerId,
			...(detach.runId === undefined ? {} : { runId: detach.runId }),
		});
	});
	const issued = service.issueForTaskRun({
		taskId: "task-worker-queue",
		graphRevision: 1,
		nodeId: "node-worker-queue",
		stageId: "stage-worker-queue",
		stageRevision: 1,
		runId: "run-1",
		capabilityBindingId: "capability-worker-queue",
		policyBindingId: "policy-worker-queue",
		sandboxBindingId: "sandbox-worker-queue",
		targetId: "worker-target-queue",
		targetKind: "operation_worker",
		workerId,
		scopes: WORKER_CREDENTIAL_SCOPES,
		requestedTtlMs: 60_000,
		clientRequestId: "issue-worker-queue",
		gate: { status: "approved", stageRevision: 1 },
		nodeAttached: true,
	});
	if (!issued.ok) throw new Error(`Expected Worker credential issue: ${issued.code}`);
	return { service, session, target, clock, detaches, providerRevocation };
}

describe("WorkerSandboxProvider", () => {
	it("attempts Host abort when Worker cancellation fails and preserves the first error", async () => {
		const workerFailure = new Error("worker cancellation persistence failed");
		let hostAbortCalls = 0;
		let rejectWorkerCancellation: (error: Error) => void = () => undefined;
		const workerCancellation = new Promise<void>((_resolve, reject) => { rejectWorkerCancellation = reject; });
		const services = {
			controlPlane: {
				cancelMcpContentOperations: () => undefined,
				cancelWorkerOperations: () => workerCancellation,
			},
			harness: {
				abort: async () => {
					hostAbortCalls += 1;
					return { ok: true, value: undefined };
				},
				waitForIdle: async () => undefined,
			},
			activePromptTasks: new Set<Promise<void>>(),
		} as unknown as CanonicalAgentSessionServices;

		const abort = CanonicalAgentSessionServices.prototype.abort.call(services);
		await Promise.resolve();
		expect(hostAbortCalls).toBe(1);
		rejectWorkerCancellation(workerFailure);
		await expect(abort).rejects.toBe(workerFailure);
	});

	it("drains the TaskCredentialService safe projection queue after activation and before execute", async () => {
		const workerId = "worker-credential-order";
		const events: string[] = [];
		const projected: SafeLeaseProjection[] = [];
		class CredentialOrderSupervisor extends OperationWorkerSupervisor {
			override projectCredential(lease: SafeLeaseProjection) {
				events.push("project");
				projected.push(lease);
				return Promise.resolve(Result.ok(undefined));
			}

			override execute(request: SandboxOperationRequest) {
				events.push("execute");
				return super.execute(request);
			}
		}
		const current = provider("success", {
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: {
					...binding(request, "success"),
					workerId,
					bindingId: request.bindingId,
				},
			}),
			createSupervisor: (config) => new CredentialOrderSupervisor(config),
		});
		const credential = createWorkerCredentialService(current, workerId);
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-order"), bindingId: grant.bindingId };
		const result = await current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		});
		expect(result).toMatchObject({ ok: true });
		expect(events.slice(0, 2)).toEqual(["project", "execute"]);
		expect(projected).toHaveLength(1);
		expect(Object.keys(projected[0] ?? {}).sort()).toEqual([
			"bindingId",
			"clientRequestId",
			"expiresAt",
			"grantId",
			"leaseId",
			"schemaVersion",
			"scopeDigest",
		]);
		expect(JSON.stringify(projected)).not.toContain(WORKER_CREDENTIAL_SECRET);
		expect(credential.target.materials).toEqual([WORKER_CREDENTIAL_SECRET]);
	});

	it("injects the dynamic Worker target registry and detach sink through FoundationControlPlane", async () => {
		const operationId = "operation-credential-control-plane";
		const workerId = `worker-${operationId}`;
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const current = provider("success", { durableOwner: false });
		const credentialProvider = createTaskCredentialTestProvider({
			materials: { registry: WORKER_CREDENTIAL_SECRET },
			target: new WorkerCredentialMaterialTarget(),
			now: () => WORKER_CREDENTIAL_NOW,
		});
		const controlPlane = createWorkerControlPlane(session, current, {
			taskCredentialProvider: credentialProvider,
		});
		try {
			const service = controlPlane.getTaskCredentialService();
			if (service === undefined) throw new Error("Expected production TaskCredentialService");
			const detach = vi.spyOn(service, "onWorkerDetach");
			const issue = service.issueForTaskRun({
				taskId: "task-control-plane",
				graphRevision: 1,
				nodeId: "node-control-plane",
				runId: "run-1",
				capabilityBindingId: "capability-control-plane",
				policyBindingId: "binding-1",
				sandboxBindingId: "binding-1",
				targetId: "worker-target-control-plane",
				targetKind: "operation_worker",
				workerId,
				scopes: WORKER_CREDENTIAL_SCOPES,
				requestedTtlMs: 60_000,
				clientRequestId: "issue-control-plane",
				nodeAttached: true,
			});
			expect(issue).not.toEqual({ ok: false, code: "task_credential_target_unavailable" });
			expect(current.getCredentialWorkerTargets().size).toBe(1);
			const request = operation(operationId);
			expect(await current.start(request, { correlation: correlation(operationId) })).toMatchObject({ ok: true });
			expect(detach).toHaveBeenCalledWith(expect.objectContaining({ workerId, runId: "run-1" }));
		} finally {
			await controlPlane.dispose();
		}
	});

	it("fails a credential drain closed through lost, provider revoke, and Worker quarantine", async () => {
		const workerId = "worker-credential-failure";
		let supervisor: OperationWorkerSupervisor | undefined;
		let executeCalls = 0;
		class CredentialFailureSupervisor extends OperationWorkerSupervisor {
			override projectCredential(_lease: SafeLeaseProjection) {
				return Promise.resolve(Result.err(new FoundationError(
					"task_credential_target_unavailable",
					"safe projection failed",
				)));
			}

			override execute(request: SandboxOperationRequest) {
				executeCalls += 1;
				return super.execute(request);
			}
		}
		const current = provider("success", {
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: {
					...binding(request, "success"),
					workerId,
					bindingId: request.bindingId,
				},
			}),
			createSupervisor: (config) => {
				supervisor = new CredentialFailureSupervisor(config);
				return supervisor;
			},
		});
		const credential = createWorkerCredentialService(current, workerId);
		credential.providerRevocation.onRevoke = () => {
			expect(supervisor?.lifecycleState?.transitions.map((transition) => transition.to)).toContain("lost");
		};
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-failure"), bindingId: grant.bindingId };
		expect(await current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		})).toMatchObject({ ok: false, error: { code: "task_credential_target_unavailable" } });
		expect(executeCalls).toBe(0);
		expect(supervisor?.lifecycleState?.transitions.map((transition) => transition.to)).toContain("lost");
		expect(credential.detaches).toEqual([expect.objectContaining({ workerId, reason: "lost" })]);
		expect(credential.service.get(grant.leaseId)?.status).toBe("settled");
		expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
		expect(credential.service.isTargetQuarantined(workerId)).toBe(true);
	});

	it("keeps projection execution blocked and revokes when durable loss persistence fails", async () => {
		const workerId = "worker-credential-loss-fault";
		let executeCalls = 0;
		const records: WorkerRecord[] = [];
		class CredentialLossFaultSupervisor extends OperationWorkerSupervisor {
			override projectCredential(_lease: SafeLeaseProjection) {
				return Promise.resolve(Result.err(new FoundationError(
					"task_credential_target_unavailable",
					"safe projection failed",
				)));
			}

			override failCredentialDelivery(_workerId: string) {
				return Promise.resolve(Result.err(new FoundationError(
					"worker_persistence_failed",
					"durable loss write failed",
				)));
			}

			override execute(request: SandboxOperationRequest) {
				executeCalls += 1;
				return super.execute(request);
			}
		}
		const current = provider("success", {
			onRecord: (record) => records.push(record),
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: { ...binding(request, "success"), workerId, bindingId: request.bindingId },
			}),
			createSupervisor: (config) => new CredentialLossFaultSupervisor(config),
		});
		const credential = createWorkerCredentialService(current, workerId);
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-loss-fault"), bindingId: grant.bindingId };
		expect(await current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		})).toMatchObject({ ok: false, error: { code: "worker_persistence_failed" } });
		expect(executeCalls).toBe(0);
		expect(records.some((record) => record.status === "lost")).toBe(false);
		expect(credential.detaches).toEqual([expect.objectContaining({ workerId, reason: "reclaim" })]);
		expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
		expect(credential.service.get(grant.leaseId)?.status).toBe("settled");
		expect(credential.service.isTargetQuarantined(workerId)).toBe(true);
	});

	it("serializes live TaskCredentialService renew and revoke queue drains", async () => {
		const workerId = "worker-credential-serial";
		const events: string[] = [];
		let enterRenew: () => void = () => undefined;
		let releaseRenew: () => void = () => undefined;
		let releaseExecute: () => void = () => undefined;
		const renewEntered = new Promise<void>((resolve) => { enterRenew = resolve; });
		const renewGate = new Promise<void>((resolve) => { releaseRenew = resolve; });
		const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
		class CredentialSerialSupervisor extends OperationWorkerSupervisor {
			override projectCredential(_lease: SafeLeaseProjection) {
				events.push("project");
				return Promise.resolve(Result.ok(undefined));
			}

			override async renewCredential(_lease: SafeLeaseProjection) {
				events.push("renew:start");
				enterRenew();
				await renewGate;
				events.push("renew:end");
				return Result.ok(undefined);
			}

			override revokeCredential(_lease: SafeLeaseReference) {
				events.push("revoke");
				return Promise.resolve(Result.ok(undefined));
			}

			override async execute(request: SandboxOperationRequest) {
				events.push("execute:start");
				await executeGate;
				return super.execute(request);
			}
		}
		const current = provider("success", {
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: {
					...binding(request, "success"),
					workerId,
					bindingId: request.bindingId,
				},
			}),
			createSupervisor: (config) => new CredentialSerialSupervisor(config),
		});
		const credential = createWorkerCredentialService(current, workerId);
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-serial"), bindingId: grant.bindingId };
		const pending = current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		});
		await waitForCondition(() => events.includes("execute:start"), "Timed out waiting for Worker execute");
		credential.clock.nowMs += 10_000;
		const renewed = credential.service.renew({
			leaseId: grant.leaseId,
			grantId: grant.grantId,
			bindingId: grant.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "renew-worker-queue",
			gate: { status: "approved", stageRevision: 1 },
			nodeAttached: true,
		});
		expect(renewed.ok).toBe(true);
		const revoked = credential.service.revoke({
			leaseId: grant.leaseId,
			clientRequestId: "revoke-worker-queue",
			gate: { status: "approved", stageRevision: 1 },
			nodeAttached: true,
		});
		expect(revoked.ok).toBe(true);
		await renewEntered;
		expect(events).not.toContain("revoke");
		releaseRenew();
		await waitForCondition(() => events.includes("revoke"), "Timed out waiting for serialized Worker revoke");
		expect(events).toEqual(["project", "execute:start", "renew:start", "renew:end", "revoke"]);
		releaseExecute();
		expect(await pending).toMatchObject({ ok: true });
	});

	it("fails a live renew through durable lost, provider revoke, and queue quarantine", async () => {
		const workerId = "worker-credential-renew-failure";
		const events: string[] = [];
		let releaseExecute: () => void = () => undefined;
		const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
		class CredentialRenewFailureSupervisor extends OperationWorkerSupervisor {
			override async execute(request: SandboxOperationRequest) {
				events.push("execute");
				await executeGate;
				return super.execute(request);
			}

			override renewCredential(_lease: SafeLeaseProjection) {
				return Promise.resolve(Result.err(new FoundationError(
					"task_credential_target_unavailable",
					"safe renewal failed",
				)));
			}

			override async failCredentialDelivery(failedWorkerId: string) {
				const result = await super.failCredentialDelivery(failedWorkerId);
				events.push("lost");
				return result;
			}
		}
		const records: WorkerRecord[] = [];
		const current = provider("success", {
			onRecord: (record) => records.push(record),
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: { ...binding(request, "success"), workerId, bindingId: request.bindingId },
			}),
			createSupervisor: (config) => new CredentialRenewFailureSupervisor(config),
		});
		const credential = createWorkerCredentialService(current, workerId);
		credential.providerRevocation.onRevoke = () => events.push("provider:revoke");
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-renew-failure"), bindingId: grant.bindingId };
		const pending = current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		});
		await waitForCondition(() => events.includes("execute"), "Timed out waiting for Worker execute");
		credential.clock.nowMs += 10_000;
		expect(credential.service.renew({
			leaseId: grant.leaseId,
			grantId: grant.grantId,
			bindingId: grant.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "renew-worker-failure",
			gate: { status: "approved", stageRevision: 1 },
			nodeAttached: true,
		})).toMatchObject({ ok: true });
		await waitForCondition(
			() => credential.providerRevocation.leaseIds.length === 1,
			"Timed out waiting for fail-closed provider revoke",
		);
		expect(events.indexOf("lost")).toBeLessThan(events.indexOf("provider:revoke"));
		expect(records.some((record) => record.status === "lost")).toBe(true);
		expect(credential.service.isTargetQuarantined(workerId)).toBe(true);
		releaseExecute();
		expect(await pending).toMatchObject({ ok: false });
		expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
	});

	it("converges a live revoke failure after one provider revoke without a false delivery claim", async () => {
		const workerId = "worker-credential-revoke-failure";
		const events: string[] = [];
		let releaseExecute: () => void = () => undefined;
		let releaseRevoke: () => void = () => undefined;
		const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
		const revokeGate = new Promise<void>((resolve) => { releaseRevoke = resolve; });
		class CredentialRevokeFailureSupervisor extends OperationWorkerSupervisor {
			override async execute(request: SandboxOperationRequest) {
				events.push("execute");
				await executeGate;
				return super.execute(request);
			}

			override async revokeCredential(_lease: SafeLeaseReference) {
				events.push("worker-revoke");
				await revokeGate;
				return Result.err(new FoundationError(
					"task_credential_target_unavailable",
					"safe revocation failed",
				));
			}

			override async failCredentialDelivery(failedWorkerId: string) {
				const result = await super.failCredentialDelivery(failedWorkerId);
				events.push("lost");
				return result;
			}
		}
		const records: WorkerRecord[] = [];
		const current = provider("success", {
			onRecord: (record) => records.push(record),
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: { ...binding(request, "success"), workerId, bindingId: request.bindingId },
			}),
			createSupervisor: (config) => new CredentialRevokeFailureSupervisor(config),
		});
		const credential = createWorkerCredentialService(current, workerId);
		credential.providerRevocation.onRevoke = () => events.push("provider:revoke");
		const grant = credential.service.snapshot()[0];
		if (grant === undefined) throw new Error("Expected queued Worker credential grant");
		const request = { ...operation("operation-credential-revoke-failure"), bindingId: grant.bindingId };
		const pending = current.start(request, {
			correlation: { ...correlation(request.operationId), bindingId: grant.bindingId },
		});
		await waitForCondition(() => events.includes("execute"), "Timed out waiting for Worker execute");
		expect(credential.service.revoke({
			leaseId: grant.leaseId,
			clientRequestId: "revoke-worker-failure",
			gate: { status: "approved", stageRevision: 1 },
			nodeAttached: true,
		})).toMatchObject({ ok: true });
		expect(events).toEqual(["execute", "worker-revoke", "provider:revoke"]);
		expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
		const entriesBeforeFailure = credential.session.getEntries().length;
		releaseRevoke();
		await waitForCondition(() => events.includes("lost"), "Timed out waiting for Worker loss");
		expect(records.some((record) => record.status === "lost")).toBe(true);
		releaseExecute();
		expect(await pending).toMatchObject({ ok: false });
		expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
		const asynchronousActions = credential.session.getEntries().slice(entriesBeforeFailure).map((entry) =>
			entry.type === "custom" && entry.data !== undefined && typeof entry.data === "object" && entry.data !== null
				? (entry.data as { action?: string }).action
				: undefined,
		);
		expect(asynchronousActions).not.toContain("delivery_succeeded");
		expect(asynchronousActions).not.toContain("renewed");
		const queueTarget = current.getCredentialWorkerTargets().get(workerId);
		if (queueTarget === undefined) throw new Error("Expected retained Worker credential target");
		expect(queueTarget.revoke({
			schemaVersion: 1,
			leaseId: grant.leaseId,
			grantId: grant.grantId,
			bindingId: grant.bindingId,
			clientRequestId: "revoke-after-quarantine",
		})).toEqual({ ok: false });
	});

	it("keeps credential delivery failure terminal-idempotent and bounds distinct Worker targets", async () => {
		let supervisor: OperationWorkerSupervisor | undefined;
		const current = provider("success", {
			maxRetainedRecords: 2,
			createSupervisor: (config) => {
				supervisor = new OperationWorkerSupervisor(config);
				return supervisor;
			},
		});
		const targets = current.getCredentialWorkerTargets();
		const first = targets.get("worker-operation-credential-terminal");
		const second = targets.get("worker-registry-second");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(targets.get("worker-registry-third")).toBeUndefined();
		expect(targets.get("worker-operation-credential-terminal")).toBe(first);
		const request = operation("operation-credential-terminal");
		expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		if (supervisor === undefined) throw new Error("Expected Worker supervisor");
		const before = supervisor.lifecycleState;
		if (before === undefined) throw new Error("Expected terminal Worker lifecycle");
		const failed = await supervisor.failCredentialDelivery(before.binding.workerId);
		expect(failed).toMatchObject({ ok: true, value: { status: before.record.status } });
		expect(supervisor.lifecycleState?.transitions).toEqual(before.transitions);
	});

	it("preserves credential detach notifications for cancel, deadline, terminal, lost, and reclaim", async () => {
		const scenarios = [
			{ name: "cancel", profileId: "cancel_success", trigger: "cancel", expected: "cancel" },
			{ name: "deadline", profileId: "deadline_late", trigger: "deadline", expected: "deadline" },
			{ name: "terminal", profileId: "cancel_success", trigger: "terminal", expected: "terminal" },
			{ name: "lost", profileId: "disconnect", trigger: "none", expected: "lost" },
			{ name: "reclaim", profileId: "success", trigger: "none", expected: "reclaim" },
		] as const;
		for (const scenario of scenarios) {
			const operationId = `operation-credential-detach-${scenario.name}`;
			const workerId = `worker-${operationId}`;
			const records: WorkerRecord[] = [];
			const current = provider(scenario.profileId, {
				onRecord: (record) => records.push(record),
				resolvePreflight: (request) => ({
					...facts(request, scenario.profileId),
					binding: {
						...binding(request, scenario.profileId),
						workerId,
						bindingId: request.bindingId,
					},
				}),
			});
			const credential = createWorkerCredentialService(current, workerId);
			const grant = credential.service.snapshot()[0];
			if (grant === undefined) throw new Error("Expected queued Worker credential grant");
			const request = { ...operation(
				operationId,
				scenario.trigger === "deadline" ? Date.now() + 500 : undefined,
			), bindingId: grant.bindingId };
			const pending = current.start(request, {
				correlation: { ...correlation(operationId), bindingId: grant.bindingId },
			});
			if (scenario.trigger === "cancel" || scenario.trigger === "terminal") {
				await waitForRecord(records, "ready");
				if (scenario.trigger === "cancel") await current.cancel(operationId);
				else await current.notifyRun("run-1", "terminal");
			}
			await pending;
			expect(credential.detaches.map((detach) => detach.reason)).toEqual([scenario.expected]);
			expect(credential.providerRevocation.leaseIds).toEqual([grant.leaseId]);
			expect(credential.service.get(grant.leaseId)?.status).toBe("settled");
			await current.dispose();
		}
	});

	it("runs the real provider through executeOperationV1 and validates success and failure receipts", async () => {
		for (const profileId of ["success", "failure"] as const) {
			const current = provider(profileId);
			const request = operation(`operation-${profileId}`);
			const executed = await executeOperation({
				provider: current,
				request,
				correlation: correlation(request.operationId),
			});
			expect(executed).toMatchObject({ ok: true, value: { status: profileId === "success" ? "succeeded" : "failed" } });
			await current.dispose();
		}
	});

	it("uses the ToolGateway payload callback before executing the real provider", async () => {
		const current = provider("success", { requireRegisteredPayload: true });
		const gateway = createSandboxOperationToolGatewayProvider({
			providerId: current.providerId,
			revision: 1,
			routes: [{ kind: "sandbox", toolName: "read", providerId: current.providerId, revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } }],
			sandbox: current,
			onOperationPayload: (operationId, payload) => current.onOperationPayload(operationId, payload),
		});
		const result = await gateway.execute({
			schemaVersion: 1,
			toolCallId: "tool-call-1",
			toolName: "read",
			originalArguments: { resource: "filesystem.read", operation: "file.read", path: "README.md" },
			context: {
				schemaVersion: 1,
				operationId: "gateway-operation",
				providerId: current.providerId,
				bindingId: "binding-1",
				bindingEpochId: "epoch-1",
				taskId: "task-1",
				dispatchId: "dispatch-1",
				attemptId: "attempt-1",
			},
		});
		expect(result).toMatchObject({ ok: true, value: { ok: true, sideEffectState: "none" } });
		await gateway.dispose();
	});

	async function assertIndependentRealSandboxChild(): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), "aos-real-worker-"));
		const runId = "run-real-worker";
		const policyBinding = realChildPolicyBinding(runId);
		const current = realWorkerProvider(root, policyBinding.id, runId);
		const gateway = createSandboxOperationToolGatewayProvider({
			providerId: current.providerId,
			revision: 1,
			routes: [
				{ kind: "sandbox", toolName: "read", providerId: current.providerId, revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } },
				{ kind: "sandbox", toolName: "write", providerId: current.providerId, revision: 1, operation: { resource: "filesystem.write", effects: ["write", "create"] } },
				{ kind: "sandbox", toolName: "list", providerId: current.providerId, revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } },
				{ kind: "sandbox", toolName: "process", providerId: current.providerId, revision: 1, operation: { resource: "process.spawn", effects: ["write", "create", "delete", "move", "command", "network", "commit", "push", "merge"], requiresSandbox: true } },
			],
			sandbox: current,
			onOperationPayload: (operationId, payload) => current.onOperationPayload(operationId, payload),
		});
		const execute = (operationId: string, toolName: string, payload: SandboxOperationRequest["payload"]) => gateway.execute({
			schemaVersion: 1,
			toolCallId: `call-${operationId}`,
			toolName,
			originalArguments: payload ?? {},
			context: {
				schemaVersion: 1,
				operationId,
				bindingId: policyBinding.id,
				bindingEpochId: "epoch-real-worker",
				taskId: "task-real-worker",
				dispatchId: "dispatch-real-worker",
				attemptId: "attempt-real-worker",
			},
		});
		const digest = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
		try {
			await writeFile(join(root, "input.txt"), "real read", "utf8");
			const readResult = await execute("real-read", "read", {
				resource: "filesystem.read",
				operation: "file.read",
				path: "input.txt",
			});
			if (!readResult.ok) throw new Error(`Real Worker read failed: ${readResult.error.code}`);
			expect(readResult).toMatchObject({ ok: true, value: { artifacts: [{ digest: digest("real read") }] } });

			expect(await execute("real-write", "write", {
				resource: "filesystem.write",
				operation: "file.write",
				path: "written.txt",
				content: "real write",
			})).toMatchObject({ ok: true, value: { artifacts: [{ digest: digest("real write") }] } });
			expect(await readFile(join(root, "written.txt"), "utf8")).toBe("real write");

			const entries = await readdir(root);
			expect(await execute("real-list", "list", {
				resource: "filesystem.read",
				operation: "directory.list",
				path: ".",
			})).toMatchObject({ ok: true, value: { artifacts: [{ digest: digest(JSON.stringify(entries)) }] } });

			expect(await execute("real-process", "process", {
				resource: "process.spawn",
				command: process.execPath,
				args: ["-e", "process.stdout.write('real process')"],
				cwd: ".",
				timeoutMs: 1_000,
			})).toMatchObject({ ok: true, value: { artifacts: [{ digest: digest("real process") }] } });
		} finally {
			await gateway.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}

	it("composes the trusted child adapter under WorkerRuntime stdio and denies before handle execution", async () => {
		let executeCalls = 0;
		const mappedResults: string[] = [];
		const projectedLeases: string[] = [];
		const policy = childPolicy(async () => {
			executeCalls += 1;
			return { content: "sandbox result" };
		});
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			receiptId: (operationId) => `receipt-${operationId}`,
			mapResult: (result, operation) => {
				mappedResults.push(`${operation.resource}:${String(result.content)}`);
				return [{
					schemaVersion: 1,
					artifactId: `artifact-${operation.bindingId}`,
					mediaType: "text/plain",
					digest: `sha256:${"1".repeat(64)}`,
					sizeBytes: String(result.content).length,
				}];
			},
			credentialTarget: {
				project: async (lease) => {
					projectedLeases.push(lease.leaseId);
					return { ok: true, value: undefined };
				},
			},
		});
		const input = new PassThrough();
		const output = new PassThrough();
		const frames: OperationWorkerEventFrame[] = [];
		let outputBuffer = "";
		output.setEncoding("utf8");
		output.on("data", (chunk: string) => {
			outputBuffer += chunk;
			for (;;) {
				const newline = outputBuffer.indexOf("\n");
				if (newline < 0) break;
				const parsed = parseOperationWorkerFrame(outputBuffer.slice(0, newline + 1));
				outputBuffer = outputBuffer.slice(newline + 1);
				if (parsed.ok && validateOperationWorkerEventFrame(parsed.value)) {
					frames.push(parsed.value);
				}
			}
		});
		const run = runOperationWorkerProcess({ provider: childProvider, input, output, heartbeatIntervalMs: 0 });
		const request = {
			...operation("child-operation"),
			agentInstanceId: "upstream-agent-only",
			bindingId: policy.binding.id,
		};
		const workerBinding: WorkerBinding = {
			...binding(request, "success"),
			sessionId: "worker-child-session",
			runId: "run-child",
			bindingId: policy.binding.id,
			capabilitySummary: ["filesystem.read"],
		};
		const writeFrame = (frame: OperationWorkerRequestFrame): void => {
			input.write(serializeWorkerFrameLine(frame));
		};
		try {
			writeFrame({ type: "initialize", requestId: "initialize-child", binding: workerBinding });
			await waitForWorkerFrame(frames, (frame) => frame.type === "ready");
			writeFrame({
				type: "credential.project",
				requestId: "credential-child",
				workerId: workerBinding.workerId,
				lease: {
					schemaVersion: 1,
					leaseId: "lease-child",
					grantId: "grant-child",
					bindingId: policy.binding.id,
					scopeDigest: `sha256:${"2".repeat(64)}`,
					expiresAt: "2026-08-21T01:00:00.000Z",
					clientRequestId: "credential-client-child",
				},
			});
			const allowedRequest = { ...request, operationId: "allowed" };
			writeFrame({ type: "execute", requestId: "execute-allowed", workerId: workerBinding.workerId, operationId: "allowed", request: allowedRequest });
			const receipt = await waitForWorkerFrame(frames, (frame) => frame.type === "receipt" && frame.receipt.operationId === "allowed");
			expect(receipt).toMatchObject({ type: "receipt", receipt: { artifacts: [{ artifactId: `artifact-${policy.binding.id}` }] } });
			if (receipt.type !== "receipt") throw new Error("Expected Worker receipt frame");
			expect(receipt.receipt.provenance.correlation).not.toHaveProperty("agentInstanceId");
			expect(executeCalls).toBe(1);
			expect(mappedResults).toEqual(["filesystem.read:sandbox result"]);
			expect(projectedLeases).toEqual(["lease-child"]);

			const invalidRequest = {
				...request,
				operationId: "invalid-payload",
				payload: { resource: "filesystem.read", operation: "file.read", path: "README.md", unauthorized: "host-fallback" },
			};
			writeFrame({ type: "execute", requestId: "execute-invalid", workerId: workerBinding.workerId, operationId: "invalid-payload", request: invalidRequest });
			await waitForWorkerFrame(frames, (frame) => frame.type === "error" && frame.requestId === "execute-invalid");
			const deniedRequest = { ...request, operationId: "policy-denied", payload: { resource: "filesystem.write", operation: "file.write", path: "README.md", content: "denied" } };
			writeFrame({ type: "execute", requestId: "execute-denied", workerId: workerBinding.workerId, operationId: "policy-denied", request: deniedRequest });
			await waitForWorkerFrame(frames, (frame) => frame.type === "error" && frame.requestId === "execute-denied");
			expect(executeCalls).toBe(1);
		} finally {
			writeFrame({ type: "reclaim", requestId: "reclaim-child", workerId: workerBinding.workerId });
			input.end();
			await run;
		}
	});

	it("rejects resource confusion, cross-resource fields, and missing exact sandbox capabilities before execution", async () => {
		let executeCalls = 0;
		const policy = childPolicy(async () => {
			executeCalls += 1;
			return { content: "unexpected" };
		});
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [
				{ schemaVersion: 1, id: "filesystem.read", version: 1 },
				{ schemaVersion: 1, id: "filesystem.write", version: 1 },
				{ schemaVersion: 1, id: "filesystem.find", version: 1 },
				{ schemaVersion: 1, id: "filesystem.grep", version: 1 },
				{ schemaVersion: 1, id: "process.spawn", version: 1 },
			],
			mapResult: () => [],
		});
		const start = (operationId: string, payload: SandboxOperationRequest["payload"]) => childProvider.start({
			...operation(operationId),
			bindingId: policy.binding.id,
			payload,
		}, {
			correlation: {
				sessionId: "worker-child-session",
				laneId: "main",
				runId: "run-child",
				bindingId: policy.binding.id,
				bindingEpochId: "epoch-1",
				operationId,
				revision: 0,
			},
		});
		const invalidPayloads: readonly (readonly [string, SandboxOperationRequest["payload"]])[] = [
			["confused-resource", { resource: "filesystem.read", operation: "file.write", path: "README.md", content: "write" }],
			["read-content", { resource: "filesystem.read", operation: "file.read", path: "README.md", content: "hidden write" }],
			["read-command", { resource: "filesystem.read", operation: "file.read", path: "README.md", command: process.execPath }],
			["process-path", { resource: "process.spawn", command: process.execPath, cwd: ".", path: "README.md" }],
			["process-content", { resource: "process.spawn", command: process.execPath, cwd: ".", content: "hidden write" }],
			["find-missing-cwd", { resource: "filesystem.find", operation: "filesystem.find", path: ".", pattern: "worker", command: process.execPath, args: [], timeoutMs: 100 }],
			["grep-missing-command", { resource: "filesystem.grep", operation: "filesystem.grep", path: ".", pattern: "worker", cwd: ".", args: [], timeoutMs: 100 }],
		];
		for (const [operationId, payload] of invalidPayloads) {
			expect(await start(operationId, payload)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		}
		expect(executeCalls).toBe(0);
		const liveCapabilityMissingPolicy = childPolicy(async () => {
			executeCalls += 1;
			return { content: "unexpected" };
		}, { filesystem: false, process: true, network: false, credentialIsolation: true });
		const liveCapabilityMissing = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy: liveCapabilityMissingPolicy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		expect(await liveCapabilityMissing.start({
			...operation("missing-live-read"),
			bindingId: liveCapabilityMissingPolicy.binding.id,
		})).toMatchObject({ ok: false, error: { code: "sandbox_capability_insufficient" } });
		expect(executeCalls).toBe(0);

		const declaredMissing = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "process.spawn", version: 1 }],
			mapResult: () => [],
		});
		expect(await declaredMissing.start({
			...operation("missing-declared-read"),
			bindingId: policy.binding.id,
		}, {
			correlation: {
				sessionId: "worker-child-session",
				laneId: "main",
				runId: "run-child",
				bindingId: policy.binding.id,
				bindingEpochId: "epoch-1",
				operationId: "missing-declared-read",
				revision: 0,
			},
		})).toMatchObject({ ok: false, error: { code: "sandbox_capability_insufficient" } });
		expect(executeCalls).toBe(0);
	});

	it("uses canonical filesystem/process authorization and rejects outside roots, process denial, and foreign handles", async () => {
		const executed: Parameters<SandboxHandle["execute"]>[0][] = [];
		const policy = childPolicy(async (request) => {
			executed.push(request);
			return { content: "authorized" };
		});
		const createChild = (currentPolicy: typeof policy) => createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy: currentPolicy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [
				{ schemaVersion: 1, id: "filesystem.read", version: 1 },
				{ schemaVersion: 1, id: "filesystem.find", version: 1 },
				{ schemaVersion: 1, id: "filesystem.grep", version: 1 },
				{ schemaVersion: 1, id: "process.spawn", version: 1 },
			],
			mapResult: () => [],
		});
		const start = (child: ReturnType<typeof createChild>, operationId: string, payload: SandboxOperationRequest["payload"]) => child.start({
			...operation(operationId),
			bindingId: policy.binding.id,
			payload,
		});
		expect(await start(createChild(policy), "canonical-read", {
			resource: "filesystem.read",
			operation: "file.read",
			path: "README.md",
		})).toMatchObject({ ok: true });
		expect(executed[0]?.path).toBe(join(process.cwd(), "README.md"));

		expect(await start(createChild(policy), "outside-root", {
			resource: "filesystem.read",
			operation: "file.read",
			path: join(tmpdir(), "outside-worker-root.txt"),
		})).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });

		const processDenied = {
			...policy,
			authorizeProcess: async () => { throw new Error("process denied"); },
		};
		for (const resource of ["filesystem.find", "filesystem.grep"] as const) {
			expect(await start(createChild(processDenied), `denied-${resource}`, {
				resource,
				operation: resource,
				path: ".",
				pattern: "worker",
				command: process.execPath,
				cwd: ".",
				args: [],
				timeoutMs: 100,
			})).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		}

		const foreignHandle: SandboxHandle = {
			id: "foreign-handle",
			capabilities: policy.sandbox!.capabilities,
			execute: async () => ({ content: "foreign" }),
		};
		const foreignPolicy = {
			...policy,
			authorizeFilesystem: async (input: Parameters<typeof policy.authorizeFilesystem>[0]) => {
				const authorization = await policy.authorizeFilesystem(input);
				return { ...authorization, sandbox: foreignHandle };
			},
		};
		expect(await start(createChild(foreignPolicy), "foreign-handle", {
			resource: "filesystem.read",
			operation: "file.read",
			path: "README.md",
		})).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(executed).toHaveLength(1);
	});

	it("accepts native and paired process fallback shapes with optional args and timeout", () => {
		const native = {
			resource: "filesystem.find",
			operation: "filesystem.find",
			path: ".",
			pattern: "worker",
		} as const;
		expect(resolveWorkerSandboxOperation("binding-1", native)).toMatchObject(native);
		const optionalFields: readonly Record<string, FoundationJsonValue>[] = [
			{},
			{ args: ["--name", "worker"] },
			{ timeoutMs: 500 },
			{ args: ["--name", "worker"], timeoutMs: 500 },
		];
		for (const optional of optionalFields) {
			const payload = { ...native, command: "find", cwd: ".", ...optional };
			expect(resolveWorkerSandboxOperation("binding-1", payload)).toMatchObject(payload);
		}
		expect(resolveWorkerSandboxOperation("binding-1", { ...native, args: ["worker"] })).toBeUndefined();
		expect(resolveWorkerSandboxOperation("binding-1", { ...native, timeoutMs: 500 })).toBeUndefined();
	});

	it("reserves child operation identity before asynchronous authorization", async () => {
		let executeCalls = 0;
		let enterAuthorization: () => void = () => undefined;
		let releaseAuthorization: () => void = () => undefined;
		const authorizationEntered = new Promise<void>((resolve) => { enterAuthorization = resolve; });
		const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
		const basePolicy = childPolicy(async () => {
			executeCalls += 1;
			return { content: "ok" };
		});
		const policy = {
			...basePolicy,
			authorizeFilesystem: async (input: Parameters<typeof basePolicy.authorizeFilesystem>[0]) => {
				enterAuthorization();
				await authorizationGate;
				return basePolicy.authorizeFilesystem(input);
			},
		};
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		const request = { ...operation("child-authorization-reservation"), bindingId: policy.binding.id };
		const first = childProvider.start(request);
		await authorizationEntered;
		expect(await childProvider.start(request)).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		releaseAuthorization();
		expect(await first).toMatchObject({ ok: true });
		expect(executeCalls).toBe(1);
	});

	it("cancels reserved child authorization and blocks late execution after dispose", async () => {
		for (const action of ["cancel", "dispose"] as const) {
			let executeCalls = 0;
			let enterAuthorization: () => void = () => undefined;
			const authorizationEntered = new Promise<void>((resolve) => { enterAuthorization = resolve; });
			const authorizationGate = new Promise<void>(() => undefined);
			const basePolicy = childPolicy(async () => {
				executeCalls += 1;
				return { content: "unexpected" };
			});
			const policy = {
				...basePolicy,
				authorizeFilesystem: async (input: Parameters<typeof basePolicy.authorizeFilesystem>[0]) => {
					enterAuthorization();
					await authorizationGate;
					return basePolicy.authorizeFilesystem(input);
				},
			};
			const childProvider = createSandboxHandleOperationProvider({
				providerId: "sandbox-worker",
				policy,
				correlation: { sessionId: "worker-child-session", laneId: "main" },
				capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
				mapResult: () => [],
			});
			const request = { ...operation(`child-authorize-${action}`), bindingId: policy.binding.id };
			const pending = childProvider.start(request);
			await authorizationEntered;
			if (action === "cancel") {
				expect(await childProvider.cancel(request.operationId)).toEqual({ ok: true, value: undefined });
			} else {
				await childProvider.dispose();
			}
			expect(await pending).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
			expect(executeCalls).toBe(0);
			if (action === "dispose") {
				expect(await childProvider.start({ ...operation("child-after-dispose"), bindingId: policy.binding.id })).toMatchObject({
					ok: false,
					error: { code: "worker_unavailable" },
				});
				expect(executeCalls).toBe(0);
			}
		}
	});

	it("captures child composition callbacks and correlation at construction", async () => {
		const policy = childPolicy(async () => ({ content: "stable" }));
		const mutableCorrelation = { sessionId: "worker-child-session", laneId: "main" };
		const mutableOptions = {
			providerId: "sandbox-worker",
			policy,
			correlation: mutableCorrelation,
			capabilities: [{ schemaVersion: 1 as const, id: "filesystem.read", version: 1 }],
			mapResult: () => [{
				schemaVersion: 1 as const,
				artifactId: "stable-artifact",
				mediaType: "text/plain",
				digest: `sha256:${"4".repeat(64)}`,
			}],
			receiptId: (operationId: string) => `stable-${operationId}`,
		};
		const childProvider = createSandboxHandleOperationProvider(mutableOptions);
		mutableOptions.mapResult = () => [];
		mutableOptions.receiptId = () => "mutated-receipt";
		mutableCorrelation.sessionId = "mutated-session";
		const request = { ...operation("stable-composition"), bindingId: policy.binding.id };
		expect(await childProvider.start(request, {
			correlation: {
				sessionId: "worker-child-session",
				laneId: "main",
				runId: "run-child",
				bindingId: policy.binding.id,
				bindingEpochId: "epoch-1",
				operationId: request.operationId,
				revision: 0,
			},
		})).toMatchObject({
			ok: true,
			value: {
				workerReceiptId: "stable-stable-composition",
				artifacts: [{ artifactId: "stable-artifact" }],
				provenance: { correlation: { sessionId: "worker-child-session" } },
			},
		});

		const noRunPolicyBase = childPolicy(async () => ({ content: "no run" }));
		const noRunBinding = Object.fromEntries(
			Object.entries(noRunPolicyBase.binding).filter(([key]) => key !== "runId"),
		) as typeof noRunPolicyBase.binding;
		const noRunPolicy = { ...noRunPolicyBase, binding: noRunBinding };
		const noRunProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy: noRunPolicy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		const noRunRequest = { ...operation("stable-no-run"), bindingId: noRunPolicy.binding.id };
		const noRunResult = await noRunProvider.start(noRunRequest, {
			correlation: {
				sessionId: "worker-child-session",
				laneId: "main",
				bindingId: noRunPolicy.binding.id,
				bindingEpochId: "epoch-1",
				operationId: noRunRequest.operationId,
				revision: 0,
			},
		});
		expect(noRunResult).toMatchObject({ ok: true });
		if (!noRunResult.ok) throw noRunResult.error;
		expect(noRunResult.value.provenance.correlation).not.toHaveProperty("runId");
		expect(() => JSON.stringify(noRunResult.value)).not.toThrow();
	});

	it("cleans active state when the first clock callback fails and checks binding epoch correlation", async () => {
		let executeCalls = 0;
		const policy = childPolicy(async () => {
			executeCalls += 1;
			return { content: "unexpected" };
		});
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			now: () => { throw new Error("clock failed"); },
			mapResult: () => [],
		});
		const request = { ...operation("clock-failure"), bindingId: policy.binding.id };
		expect(await childProvider.start(request)).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(await childProvider.cancel(request.operationId)).toEqual({ ok: true, value: undefined });
		await childProvider.dispose();
		expect(executeCalls).toBe(0);
		const noncanonicalProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		expect(await noncanonicalProvider.start({
			...operation("child-own-undefined"),
			bindingId: policy.binding.id,
			agentInstanceId: undefined,
		} as unknown as SandboxOperationRequest)).toMatchObject({
			ok: false,
			error: { code: "worker_operation_invalid" },
		});
		expect(executeCalls).toBe(0);

		const epochProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		const epochRequest = { ...operation("epoch-mismatch"), bindingId: policy.binding.id };
		expect(await epochProvider.start(epochRequest, {
			correlation: {
				sessionId: "worker-child-session",
				laneId: "main",
				operationId: epochRequest.operationId,
				bindingId: policy.binding.id,
				bindingEpochId: "different-epoch",
				revision: 0,
			},
		})).toMatchObject({ ok: false, error: { code: "invalid_correlation" } });
		expect(executeCalls).toBe(0);
	});

	it("returns cancellation evidence when the child handle throws after abort", async () => {
		let enterExecution: () => void = () => undefined;
		const executionEntered = new Promise<void>((resolve) => { enterExecution = resolve; });
		const policy = childPolicy(async ({ signal }) => {
			enterExecution();
			return new Promise<never>((_resolve, reject) => {
				const fail = (): void => reject(signal?.reason ?? new Error("cancelled"));
				if (signal?.aborted) fail();
				else signal?.addEventListener("abort", fail, { once: true });
			});
		});
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy,
			correlation: { sessionId: "worker-child-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "filesystem.read", version: 1 }],
			mapResult: () => [],
		});
		const request = { ...operation("child-abort-throw"), bindingId: policy.binding.id };
		const controller = new AbortController();
		const result = childProvider.start(request, { signal: controller.signal });
		await executionEntered;
		controller.abort(new DOMException("cancel child", "AbortError"));
		expect(await result).toMatchObject({
			ok: true,
			value: {
				status: "failed",
				sideEffectState: "side_effect_unknown",
				error: { code: "worker_cancel_failed" },
			},
		});
	});

	it("converges cancellation without inventing a terminal receipt", async () => {
		const records: WorkerRecord[] = [];
		const current = provider("cancel_success", { onRecord: (record) => records.push(record) });
		const request = operation("operation-cancel");
		const started = executeOperation({ provider: current, request, correlation: correlation(request.operationId) });
		await waitForRecord(records, "ready");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(await current.cancel(request.operationId)).toEqual({ ok: true, value: undefined });
		expect(await started).toMatchObject({ ok: true, value: { status: "cancelled", sideEffectState: "none" } });
		expect(records.some((record) => record.status === "reclaimed")).toBe(true);
	});

	it("terminates a never-ready child during activation on cancel, cancelAll, and deadline", async () => {
		for (const reason of ["cancel", "cancelAll", "deadline"] as const) {
			let created = 0;
			let provideSupervisor: (supervisor: ActivationBarrierWorkerSupervisor) => void = () => undefined;
			const supervisorCreated = new Promise<ActivationBarrierWorkerSupervisor>((resolve) => { provideSupervisor = resolve; });
			const current = provider("ready_timeout", {
				createSupervisor: (config) => {
					created += 1;
					const supervisor = new ActivationBarrierWorkerSupervisor(config);
					provideSupervisor(supervisor);
					return supervisor;
				},
			});
			const request = operation(
				`operation-activation-${reason}`,
				reason === "deadline" ? Date.now() + 500 : undefined,
			);
			const pending = current.start(request, { correlation: correlation(request.operationId) });
			const supervisor = await supervisorCreated;
			await supervisor.activationEntered;
			if (reason === "cancel") {
				expect(await current.cancel(request.operationId)).toEqual({ ok: true, value: undefined });
			} else if (reason === "cancelAll") {
				await current.cancelAll("cancel");
			}
			expect(await pending).toMatchObject({
				ok: false,
				error: { code: reason === "deadline" ? "worker_deadline_exceeded" : "worker_cancel_failed" },
			});
			expect(created).toBe(1);
			expect(supervisor.snapshot.hasLiveProcess).toBe(false);
			expect(supervisor.lifecycleState?.transitions.map((transition) => transition.to)).not.toContain("running");
			await current.dispose();
		}
	});

	it("treats termination of an idle ready Worker conservatively and leaves no child alive", async () => {
		const request = operation("operation-idle-terminate");
		const current = new OperationWorkerSupervisor({
			executable: process.execPath,
			entrypoint: CHILD_ENTRY,
			profileId: "success",
			profileRevision: 1,
			capabilities: ["filesystem.read", "process.spawn"],
			environment: { AOS_SAFE_TEST_MARKER: "1" },
			readyTimeoutMs: 2_000,
			heartbeatTimeoutMs: 300,
			cancelTimeoutMs: 40,
			terminateTimeoutMs: 500,
		});
		const planned = current.preflight({ binding: binding(request, "success"), runAccepted: true });
		if (!planned.ok) throw planned.error;
		expect(await current.activate(planned.value)).toMatchObject({ ok: true, value: { status: "ready" } });
		const lease = {
			schemaVersion: 1 as const,
			leaseId: "lease-supervisor",
			grantId: "grant-supervisor",
			bindingId: "binding-1",
			scopeDigest: `sha256:${"3".repeat(64)}`,
			expiresAt: "2026-08-21T01:00:00.000Z",
			clientRequestId: "credential-supervisor",
		};
		expect(await current.projectCredential(lease)).toEqual({ ok: true, value: undefined });
		expect(await current.renewCredential({ ...lease, clientRequestId: "credential-renew-supervisor" })).toEqual({ ok: true, value: undefined });
		expect(await current.revokeCredential({
			schemaVersion: 1,
			leaseId: lease.leaseId,
			grantId: lease.grantId,
			bindingId: lease.bindingId,
			clientRequestId: "credential-revoke-supervisor",
		})).toEqual({ ok: true, value: undefined });
		expect(await current.terminate("shutdown")).toMatchObject({ ok: true, value: { status: "reclaimed" } });
		expect(current.snapshot.hasLiveProcess).toBe(false);
		expect(current.lifecycleState?.transitions.map((transition) => transition.to)).toContain("lost");
		expect(current.lifecycleState?.transitions.map((transition) => transition.to)).not.toContain("cancelled");

		const failedStart = new OperationWorkerSupervisor({
			executable: process.execPath,
			entrypoint: CHILD_ENTRY,
			profileId: "ready_timeout",
			profileRevision: 1,
			capabilities: ["filesystem.read", "process.spawn"],
			environment: { AOS_SAFE_TEST_MARKER: "1" },
			readyTimeoutMs: 30,
			heartbeatTimeoutMs: 300,
			cancelTimeoutMs: 40,
			terminateTimeoutMs: 500,
		});
		const timeoutRequest = operation("operation-start-timeout");
		const timeoutPlan = failedStart.preflight({ binding: binding(timeoutRequest, "ready_timeout"), runAccepted: true });
		if (!timeoutPlan.ok) throw timeoutPlan.error;
		expect(await failedStart.activate(timeoutPlan.value)).toMatchObject({ ok: false, error: { code: "worker_start_failed" } });
		expect(failedStart.snapshot).toMatchObject({ hasLiveProcess: false, record: { status: "failed" } });
		expect(failedStart.lifecycleState?.transitions.map((transition) => transition.to)).not.toContain("reclaiming");
	});

	it("fails closed for deadline, lost, invalid receipt, and reclaim-unknown paths", async () => {
		const deadlineAt = Date.now() + 1_000;
		const deadlineProvider = provider("deadline_late");
		const deadlineRequest = operation("operation-deadline", deadlineAt);
		expect(await executeOperation({ provider: deadlineProvider, request: deadlineRequest, correlation: correlation(deadlineRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_deadline_exceeded" },
		});

		for (const [profileId, code] of [["disconnect", "worker_lost"], ["receipt_invalid", "worker_receipt_invalid"]] as const) {
			const current = provider(profileId);
			const request = operation(`operation-${profileId}`);
			expect(await executeOperation({ provider: current, request, correlation: correlation(request.operationId) })).toMatchObject({ ok: false, error: { code } });
		}

		const records: WorkerRecord[] = [];
		const reclaimUnknown = provider("reclaim_unknown", { onRecord: (record) => records.push(record) });
		const request = operation("operation-reclaim-unknown");
		expect(await executeOperation({ provider: reclaimUnknown, request, correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		expect(records.some((record) => record.status === "reclaim_unknown")).toBe(true);
	});

	it("fails every strict preflight and identity mismatch before Supervisor creation", async () => {
		const mismatches: readonly {
			readonly name: string;
			readonly code: string;
			readonly resolvePreflight?: (request: SandboxOperationRequest) => WorkerSandboxPreflightFacts;
			readonly executionCorrelation?: (operationId: string) => ExecutionCorrelation;
		}[] = [
			{ name: "run-accepted", code: "worker_unavailable", resolvePreflight: (request) => ({ ...facts(request, "success"), runAccepted: false }) },
			{ name: "session-owned", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), sessionOwned: false }) },
			{ name: "lane-owned", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), laneOwned: false }) },
			{ name: "binding-authorized", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), bindingAuthorized: false }) },
			{ name: "policy-authorized", code: "worker_unavailable", resolvePreflight: (request) => ({ ...facts(request, "success"), policyAuthorized: false }) },
			{ name: "sandbox-authorized", code: "sandbox_capability_insufficient", resolvePreflight: (request) => ({ ...facts(request, "success"), sandboxAuthorized: false }) },
			{ name: "credential-lease", code: "task_credential_target_unavailable", resolvePreflight: (request) => ({ ...facts(request, "success"), credentialLeaseActive: false }) },
			{ name: "binding-provider", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), providerId: "other-provider" } }) },
			{ name: "binding-profile", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), profileId: "other-profile" } }) },
			{ name: "binding-profile-revision", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), profileRevision: 2 } }) },
			{ name: "request-fingerprint", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), requestFingerprint: `sha256:${"0".repeat(64)}` } }) },
			{ name: "deadline", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), deadlineAt: (request.deadlineAt ?? 0) + 1 } }) },
			{ name: "capability-set", code: "worker_binding_invalid", resolvePreflight: (request) => ({ ...facts(request, "success"), binding: { ...binding(request, "success"), capabilitySummary: ["filesystem.read"] } }) },
			{ name: "correlation-session", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), sessionId: "other-session" }) },
			{ name: "correlation-operation", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), operationId: "other-operation" }) },
			{ name: "correlation-provider", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), providerId: "other-provider" }) },
			{ name: "correlation-revision", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), revision: 1 }) },
			{ name: "correlation-task", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), taskId: "other-task" }) },
			{ name: "correlation-dispatch", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), dispatchId: "other-dispatch" }) },
			{ name: "correlation-agent", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), agentInstanceId: "unexpected-agent" }) },
			{ name: "correlation-tool", code: "worker_binding_invalid", executionCorrelation: (operationId) => ({ ...correlation(operationId), toolCallId: "unexpected-tool" }) },
		];
		for (const mismatch of mismatches) {
			let created = 0;
			const current = provider("success", {
				onCreate: () => { created += 1; },
				...(mismatch.resolvePreflight === undefined ? {} : { resolvePreflight: mismatch.resolvePreflight }),
			});
			const request = operation(`operation-preflight-${mismatch.name}`, Date.now() + 10_000);
			expect(await current.start(request, {
				correlation: mismatch.executionCorrelation?.(request.operationId) ?? correlation(request.operationId),
			})).toMatchObject({
				ok: false,
				error: { code: mismatch.code },
			});
			expect(created).toBe(0);
		}
	});

	it("requires the single durable owner for the resolved Session before spawn", async () => {
		for (const durableOwner of [false, "other-session"] as const) {
			let created = 0;
			const current = provider("success", {
				durableOwner,
				onCreate: () => { created += 1; },
			});
			const request = operation(`operation-owner-${String(durableOwner)}`);
			expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
				ok: false,
				error: { code: "worker_persistence_failed" },
			});
			expect(created).toBe(0);
		}
	});

	it("rejects durable binding and recovery after provider disposal", async () => {
		const current = provider("success", { durableOwner: false });
		await current.dispose();
		expect(() => current.bindDurableFactSink("session-1", () => undefined)).toThrow(
			expect.objectContaining({ code: "service_conflict" }),
		);
		expect(current.restoreWorkerFacts({ records: [], receipts: [], operationIds: [], workerIds: [] })).toMatchObject({
			ok: false,
			error: { code: "worker_persistence_failed" },
		});
		expect(current.hasDurableFactOwner()).toBe(false);
	});

	it("restores records, receipts, and consumed identities atomically", async () => {
		const source = provider("success");
		const request = operation("operation-atomic-restore-source");
		expect(await source.start(request, { correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		const record = source.listWorkerRecords()[0];
		const receipt = source.listWorkerReceipts()[0];
		if (record === undefined || receipt === undefined) throw new Error("Expected source Worker facts");

		const invalidReceiptTarget = provider("success", { durableOwner: false });
		expect(invalidReceiptTarget.restoreWorkerFacts({
			records: [record],
			receipts: [{ ...receipt, operationId: "" }],
			operationIds: [request.operationId],
			workerIds: [record.workerId],
		})).toMatchObject({ ok: false, error: { code: "worker_persistence_failed" } });
		expect(invalidReceiptTarget.listWorkerRecords()).toEqual([]);
		expect(invalidReceiptTarget.listWorkerReceipts()).toEqual([]);

		const identityDriftTarget = provider("success", { durableOwner: false });
		expect(identityDriftTarget.restoreWorkerFacts({
			records: [record, { ...record, sessionId: "foreign-session", revision: record.revision + 1 }],
			operationIds: [request.operationId],
			workerIds: [record.workerId],
		})).toMatchObject({ ok: false, error: { code: "worker_persistence_failed" } });
		expect(identityDriftTarget.listWorkerRecords()).toEqual([]);
		expect(identityDriftTarget.listWorkerReceipts()).toEqual([]);

		let restoredCreates = 0;
		const derivedIdentityTarget = replayableProvider(
			() => { restoredCreates += 1; },
			(operationRequest) => ({
				...facts(operationRequest, "success"),
				binding: { ...binding(operationRequest, "success"), workerId: record.workerId },
			}),
		);
		expect(derivedIdentityTarget.restoreWorkerFacts({ records: [record], receipts: [receipt] })).toEqual({ ok: true, value: undefined });
		derivedIdentityTarget.bindDurableFactSink("session-1", () => undefined);
		expect(await derivedIdentityTarget.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		const secondOperation = operation("operation-restored-worker-reuse");
		expect(await derivedIdentityTarget.start(secondOperation, { correlation: correlation(secondOperation.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(restoredCreates).toBe(0);
		await source.dispose();
	});

	it("claims the Session owner before restoring a second provider and releases it transactionally", async () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const first = replayableProvider();
		const firstControlPlane = createWorkerControlPlane(session, first);
		const firstRequest = operation("operation-first-owner");
		expect(await first.start(firstRequest, { correlation: correlation(firstRequest.operationId) })).toMatchObject({ ok: true });

		const second = replayableProvider();
		const releaseSeedOwner = second.bindDurableFactSink("session-1", () => undefined);
		const seedRequest = operation("operation-second-seed");
		expect(await second.start(seedRequest, { correlation: correlation(seedRequest.operationId) })).toMatchObject({ ok: true });
		releaseSeedOwner();
		const recordsBefore = second.listWorkerRecords();
		const receiptsBefore = second.listWorkerReceipts();

		expect(() => createWorkerControlPlane(session, second)).toThrow(expect.objectContaining({ code: "service_conflict" }));
		expect(second.listWorkerRecords()).toEqual(recordsBefore);
		expect(second.listWorkerReceipts()).toEqual(receiptsBefore);
		expect(second.hasDurableFactOwner()).toBe(false);
		expect(await second.start(seedRequest, { correlation: correlation(seedRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});

		const firstStillOwned = operation("operation-first-owner-after-conflict");
		expect(await first.start(firstStillOwned, { correlation: correlation(firstStillOwned.operationId) })).toMatchObject({ ok: true });
		await firstControlPlane.dispose();

		const secondControlPlane = createWorkerControlPlane(session, second);
		const secondOwned = operation("operation-second-owner-after-release");
		expect(await second.start(secondOwned, { correlation: correlation(secondOwned.operationId) })).toMatchObject({ ok: true });
		await secondControlPlane.dispose();
	});

	it("preserves a runtime untrusted profile and rejects it before spawn", async () => {
		let created = 0;
		const untrustedProfile = {
			profileId: "success",
			profileRevision: 1,
			trusted: false,
			supervisor: {
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "success",
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
			},
		} as unknown as WorkerSandboxProfile;
		const current = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: untrustedProfile,
			resolvePreflight: (request) => facts(request, "success"),
			createSupervisor: (config) => {
				created += 1;
				return new OperationWorkerSupervisor(config);
			},
		});
		current.bindDurableFactSink("session-1", () => undefined);
		const request = operation("operation-untrusted-runtime");
		expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_profile_untrusted" },
		});
		expect(created).toBe(0);
	});

	it("treats declared and profile capabilities as immutable set identities", async () => {
		const declared = [
			{ schemaVersion: 1 as const, id: "process.spawn", version: 1 },
			{ schemaVersion: 1 as const, id: "filesystem.read", version: 1 },
		];
		const current = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			capabilities: declared,
			resolvePreflight: (request) => facts(request, "success"),
		});
		current.bindDurableFactSink("session-1", () => undefined);
		declared[0]!.id = "mutated";
		const snapshot = await current.capabilities();
		expect(snapshot.map((capability) => capability.id)).toEqual(["process.spawn", "filesystem.read"]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot.every((capability) => Object.isFrozen(capability))).toBe(true);
		const request = operation("operation-capability-set-order");
		const completed = await current.start(request, { correlation: correlation(request.operationId) });
		if (!completed.ok) throw completed.error;
	});

	it("reserves operation identity before async preflight and spawns only once", async () => {
		let releasePreflight: () => void = () => undefined;
		const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
		let created = 0;
		const records: WorkerRecord[] = [];
		const current = provider("success", {
			onCreate: () => { created += 1; },
			onRecord: (record) => records.push(record),
			resolvePreflight: async (request) => {
				await preflightGate;
				return facts(request, "success");
			},
		});
		const request = operation("operation-concurrent");
		const first = current.start(request, { correlation: correlation(request.operationId) });
		const second = await current.start(request, { correlation: correlation(request.operationId) });
		expect(second).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		releasePreflight();
		expect(await first).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(created).toBe(1);
		expect(records.filter((record) => record.status === "completed")).toHaveLength(1);
	});

	it("snapshots request and correlation before async preflight and contains invalid runtime inputs", async () => {
		let enterPreflight: () => void = () => undefined;
		let releasePreflight: () => void = () => undefined;
		const preflightEntered = new Promise<void>((resolve) => { enterPreflight = resolve; });
		const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
		let created = 0;
		const current = provider("success", {
			onCreate: () => { created += 1; },
			resolvePreflight: async (request, options) => {
				expect(Object.isFrozen(request)).toBe(true);
				expect(Object.isFrozen(request.payload)).toBe(true);
				expect(Object.isFrozen(options.correlation)).toBe(true);
				enterPreflight();
				await preflightGate;
				expect(request).toMatchObject({
					operationId: "operation-snapshot-original",
					bindingId: "binding-1",
					payload: { path: "README.md" },
				});
				expect(options.correlation).toMatchObject({
					sessionId: "session-1",
					bindingId: "binding-1",
					operationId: "operation-snapshot-original",
				});
				return facts(request, "success");
			},
		});
		const mutableRequest = operation("operation-snapshot-original") as unknown as {
			operationId: string;
			bindingId?: string;
			payload?: Record<string, unknown>;
		};
		const mutableCorrelation = correlation(mutableRequest.operationId) as unknown as {
			sessionId: string;
			bindingId?: string;
			operationId?: string;
		};
		const pending = current.start(
			mutableRequest as unknown as SandboxOperationRequest,
			{ correlation: mutableCorrelation as unknown as ExecutionCorrelation },
		);
		await preflightEntered;
		mutableRequest.operationId = "operation-snapshot-mutated";
		mutableRequest.bindingId = "binding-mutated";
		if (mutableRequest.payload !== undefined) mutableRequest.payload.path = "mutated.txt";
		mutableCorrelation.sessionId = "session-mutated";
		mutableCorrelation.bindingId = "binding-mutated";
		mutableCorrelation.operationId = "operation-snapshot-mutated";
		releasePreflight();
		expect(await pending).toMatchObject({
			ok: true,
			value: { operationId: "operation-snapshot-original" },
		});
		expect(await current.cancel("operation-snapshot-mutated")).toMatchObject({ ok: false, error: { code: "worker_not_found" } });
		expect(created).toBe(1);

		for (const invalidCorrelation of [
			((): Record<string, unknown> => {
				const cyclic = { ...correlation("operation-cyclic-correlation") } as Record<string, unknown>;
				cyclic.self = cyclic;
				return cyclic;
			})(),
			{ ...correlation("operation-bigint-correlation"), revision: 1n },
		]) {
			const invalidRequest = operation(String(invalidCorrelation.operationId));
			expect(await current.start(invalidRequest, {
				correlation: invalidCorrelation as unknown as ExecutionCorrelation,
			})).toMatchObject({ ok: false, error: { code: "invalid_correlation" } });
		}
		expect(await current.start(null as unknown as SandboxOperationRequest)).toMatchObject({ ok: false });
		expect(await current.start({
			...operation("operation-own-undefined"),
			agentInstanceId: undefined,
		} as unknown as SandboxOperationRequest)).toMatchObject({
			ok: false,
			error: { code: "foundation_schema_invalid_shape" },
		});
		expect(created).toBe(1);
	});

	it("snapshots preflight authority facts before Supervisor construction callbacks", async () => {
		const request = operation("operation-preflight-authority-snapshot");
		const mutableFacts = facts(request, "success") as unknown as {
			binding: {
				workerId: string;
				sessionId: string;
				runId?: string;
				bindingId?: string;
				capabilitySummary: string[];
				credentialTargetRefs: string[];
			};
			runAccepted: boolean;
			sessionOwned: boolean;
		};
		const current = provider("success", {
			resolvePreflight: () => mutableFacts as unknown as WorkerSandboxPreflightFacts,
			createSupervisor: (config) => {
				mutableFacts.binding.workerId = "worker-mutated-after-validation";
				mutableFacts.binding.sessionId = "session-mutated-after-validation";
				mutableFacts.binding.runId = "run-mutated-after-validation";
				mutableFacts.binding.bindingId = "binding-mutated-after-validation";
				mutableFacts.binding.capabilitySummary.push("network.connect");
				mutableFacts.binding.credentialTargetRefs.push("secret-target");
				mutableFacts.runAccepted = false;
				mutableFacts.sessionOwned = false;
				return new OperationWorkerSupervisor(config);
			},
		});
		expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: true,
			value: { operationId: request.operationId, status: "succeeded" },
		});
		expect(current.getWorkerRecord(`worker-${request.operationId}`)).toMatchObject({
			sessionId: "session-1",
			runId: "run-1",
			bindingId: "binding-1",
		});
		expect(current.getWorkerRecord("worker-mutated-after-validation")).toBeUndefined();

		let malformedCreates = 0;
		const malformed = provider("success", {
			onCreate: () => { malformedCreates += 1; },
			resolvePreflight: (operationRequest) => ({
				...facts(operationRequest, "success"),
				runAccepted: "true",
			}) as unknown as WorkerSandboxPreflightFacts,
		});
		const malformedRequest = operation("operation-malformed-preflight-boolean");
		expect(await malformed.start(malformedRequest, { correlation: correlation(malformedRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_binding_invalid" },
		});
		expect(malformedCreates).toBe(0);
	});

	it("claims Worker identity atomically across concurrent operations and construction failure", async () => {
		let releasePreflight: () => void = () => undefined;
		const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
		let created = 0;
		const concurrent = provider("success", {
			onCreate: () => { created += 1; },
			resolvePreflight: async (request) => {
				await preflightGate;
				return {
					...facts(request, "success"),
					binding: { ...binding(request, "success"), workerId: "shared-worker" },
				};
			},
		});
		const first = operation("operation-shared-worker-first");
		const second = operation("operation-shared-worker-second");
		const results = Promise.all([
			concurrent.start(first, { correlation: correlation(first.operationId) }),
			concurrent.start(second, { correlation: correlation(second.operationId) }),
		]);
		releasePreflight();
		const settled = await results;
		expect(settled.filter((result) => result.ok)).toHaveLength(1);
		expect(settled.filter((result) => !result.ok)).toEqual([
			expect.objectContaining({ error: expect.objectContaining({ code: "worker_conflict" }) }),
		]);
		expect(created).toBe(1);

		let constructionAttempts = 0;
		const constructionFailure = provider("success", {
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: { ...binding(request, "success"), workerId: "construction-once-worker" },
			}),
			createSupervisor: () => {
				constructionAttempts += 1;
				throw new Error("construction failed");
			},
		});
		const constructionFirst = operation("operation-construction-first");
		expect(await constructionFailure.start(constructionFirst, {
			correlation: correlation(constructionFirst.operationId),
		})).toMatchObject({ ok: false, error: { code: "worker_start_failed" } });
		const constructionSecond = operation("operation-construction-second");
		expect(await constructionFailure.start(constructionSecond, {
			correlation: correlation(constructionSecond.operationId),
		})).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(constructionAttempts).toBe(1);
	});

	it("settles never-resolving preflight on cancel, deadline, and dispose without spawning", async () => {
		const never = new Promise<WorkerSandboxPreflightFacts>(() => undefined);
		let cancelCreated = 0;
		const cancelled = provider("success", {
			onCreate: () => { cancelCreated += 1; },
			resolvePreflight: () => never,
		});
		const cancelRequest = operation("operation-never-cancel");
		const cancelPending = cancelled.start(cancelRequest, { correlation: correlation(cancelRequest.operationId) });
		expect(await cancelled.cancel(cancelRequest.operationId)).toEqual({ ok: true, value: undefined });
		expect(await cancelPending).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
		expect(cancelCreated).toBe(0);

		vi.useFakeTimers();
		try {
			let deadlineCreated = 0;
			const deadline = provider("success", {
				onCreate: () => { deadlineCreated += 1; },
				resolvePreflight: () => never,
			});
			const deadlineRequest = operation("operation-never-deadline", Date.now() + 1_000);
			const deadlinePending = deadline.start(deadlineRequest, { correlation: correlation(deadlineRequest.operationId) });
			await vi.advanceTimersByTimeAsync(1_001);
			expect(await deadlinePending).toMatchObject({ ok: false, error: { code: "worker_deadline_exceeded" } });
			expect(deadlineCreated).toBe(0);
			await deadline.dispose();
		} finally {
			vi.useRealTimers();
		}

		let disposeCreated = 0;
		const disposed = provider("success", {
			onCreate: () => { disposeCreated += 1; },
			resolvePreflight: () => never,
		});
		const disposeRequest = operation("operation-never-dispose");
		const disposePending = disposed.start(disposeRequest, { correlation: correlation(disposeRequest.operationId) });
		await disposed.dispose();
		expect(await disposePending).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
		expect(disposeCreated).toBe(0);
		expect(disposed.hasDurableFactOwner()).toBe(false);
		expect(await disposed.start(operation("operation-after-dispose"))).toMatchObject({
			ok: false,
			error: { code: "worker_unavailable" },
		});

		let releaseDelayedPreflight: () => void = () => undefined;
		const delayedPreflight = new Promise<void>((resolve) => { releaseDelayedPreflight = resolve; });
		let delayedCreated = 0;
		const delayed = provider("success", {
			onCreate: () => { delayedCreated += 1; },
			resolvePreflight: async (request) => {
				await delayedPreflight;
				return facts(request, "success");
			},
		});
		const delayedRequest = operation("operation-many-run-invalidations");
		const delayedStart = delayed.start(delayedRequest, { correlation: correlation(delayedRequest.operationId) });
		await delayed.notifyRun("run-1", "terminal");
		for (let index = 0; index < 1_000; index += 1) await delayed.notifyRun(`unrelated-run-${index}`, "terminal");
		releaseDelayedPreflight();
		expect(await delayedStart).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
		expect(delayedCreated).toBe(0);
		await delayed.dispose();
	});

	it("preserves the first pending Run invalidation reason before preflight resolves", async () => {
		let releasePreflight: () => void = () => undefined;
		const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
		let created = 0;
		const current = provider("success", {
			onCreate: () => { created += 1; },
			resolvePreflight: async (request) => {
				await preflightGate;
				return facts(request, "success");
			},
		});
		const request = operation("operation-first-pending-run-reason");
		const runlessCorrelation = { ...correlation(request.operationId) } as {
			runId?: string;
		} & ExecutionCorrelation;
		delete runlessCorrelation.runId;
		const pending = current.start(request, { correlation: runlessCorrelation });
		await current.notifyRun("run-1", "deadline");
		await current.notifyRun("run-1", "terminal");
		releasePreflight();
		expect(await pending).toMatchObject({
			ok: false,
			error: { code: "worker_deadline_exceeded" },
		});
		expect(created).toBe(0);
	});

	it("bounds pending reservations and registered payloads at small capacity", async () => {
		let releasePreflight: () => void = () => undefined;
		const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
		let created = 0;
		const current = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			maxRetainedRecords: 1,
			resolvePreflight: async (request) => {
				await preflightGate;
				return facts(request, "success");
			},
			createSupervisor: (config) => {
				created += 1;
				return new OperationWorkerSupervisor(config);
			},
		});
		current.bindDurableFactSink("session-1", () => undefined);
		const first = operation("operation-capacity-first");
		const second = operation("operation-capacity-second");
		const pending = current.start(first, { correlation: correlation(first.operationId) });
		expect(await current.start(second, { correlation: correlation(second.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_unavailable" },
		});
		releasePreflight();
		expect(await pending).toMatchObject({ ok: true });
		expect(created).toBe(1);

		expect(await current.start(first, { correlation: correlation(first.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});

		const payloadProvider = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			maxRetainedRecords: 1,
			requireRegisteredPayload: true,
			resolvePreflight: (request) => facts(request, "success"),
		});
		payloadProvider.bindDurableFactSink("session-1", () => undefined);
		const payloadFirst = operation("operation-payload-first");
		const payloadSecond = operation("operation-payload-second");
		payloadProvider.onOperationPayload(payloadFirst.operationId, payloadFirst.payload ?? {});
		payloadProvider.onOperationPayload(payloadSecond.operationId, payloadSecond.payload ?? {});
		const aborted = new AbortController();
		aborted.abort();
		expect(await payloadProvider.start(payloadFirst, { correlation: correlation(payloadFirst.operationId), signal: aborted.signal })).toMatchObject({
			ok: false,
			error: { code: "worker_cancel_failed" },
		});
		expect(await payloadProvider.start(payloadSecond, { correlation: correlation(payloadSecond.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_operation_invalid" },
		});
		payloadProvider.onOperationPayload(payloadSecond.operationId, payloadSecond.payload ?? {});
		expect(await payloadProvider.start(payloadSecond, { correlation: correlation(payloadSecond.operationId) })).toMatchObject({ ok: true });
	});

	it("never evicts completed operation identities at small retention capacity", async () => {
		const current = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			maxRetainedRecords: 1,
			resolvePreflight: (request) => facts(request, "success"),
		});
		current.bindDurableFactSink("session-1", () => undefined);
		for (const operationId of ["operation-one-shot-oldest", "operation-one-shot-newer", "operation-one-shot-newest"]) {
			const request = operation(operationId);
			expect(await current.start(request, { correlation: correlation(operationId) })).toMatchObject({ ok: true });
		}
		const oldest = operation("operation-one-shot-oldest");
		expect(await current.start(oldest, { correlation: correlation(oldest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
	});

	it("keeps an undurable success receipt out of the authoritative registry", async () => {
		const current = provider("success", {
			durableSink: (fact) => {
				if (fact.type === "receipt") throw new Error("sink failed");
			},
		});
		const request = operation("operation-receipt-persistence-failure");
		expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_persistence_failed" },
		});
		expect(current.listWorkerReceipts()).toEqual([]);
		expect(current.getWorkerReceipt("receipt-operation-receipt-persistence-failure")).toBeUndefined();
	});

	it("persists an operation fence before execute and consumes a claimed-only crash prefix", async () => {
		let executeCalls = 0;
		class CountingSupervisor extends OperationWorkerSupervisor {
			override execute(request: SandboxOperationRequest) {
				executeCalls += 1;
				return super.execute(request);
			}
		}
		const fenceFailure = provider("success", {
			durableOwner: false,
			createSupervisor: (config) => new CountingSupervisor(config),
		});
		fenceFailure.bindDurableFactSink("session-1", (fact) => {
			if (fact.type === "operation") throw new Error("fence append failed");
		});
		const failedRequest = operation("operation-fence-failure");
		expect(await fenceFailure.start(failedRequest, { correlation: correlation(failedRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_persistence_failed" },
		});
		expect(executeCalls).toBe(0);
		expect(fenceFailure.listWorkerReceipts()).toEqual([]);
		await fenceFailure.dispose().catch(() => undefined);

		const abortController = new AbortController();
		let abortedSupervisor: CountingSupervisor | undefined;
		const abortOnFence = provider("success", {
			durableOwner: false,
			createSupervisor: (config) => {
				abortedSupervisor = new CountingSupervisor(config);
				return abortedSupervisor;
			},
		});
		abortOnFence.bindDurableFactSink("session-1", (fact) => {
			if (fact.type === "operation") abortController.abort(new DOMException("cancel after fence", "AbortError"));
		});
		const abortRequest = operation("operation-abort-after-fence");
		expect(await abortOnFence.start(abortRequest, {
			correlation: correlation(abortRequest.operationId),
			signal: abortController.signal,
		})).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
		expect(executeCalls).toBe(0);
		expect(abortedSupervisor?.lifecycleState?.transitions.map((transition) => transition.to)).not.toContain("running");
		expect(abortedSupervisor?.snapshot.hasLiveProcess).toBe(false);
		expect(abortOnFence.listWorkerReceipts()).toEqual([]);
		await abortOnFence.dispose();

		const sourceSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		let resolveGatedSupervisor: (supervisor: ExecuteGateWorkerSupervisor) => void = () => undefined;
		const gatedSupervisorCreated = new Promise<ExecuteGateWorkerSupervisor>((resolve) => { resolveGatedSupervisor = resolve; });
		const source = new ReplayableWorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			resolvePreflight: (request) => facts(request, "success"),
			createSupervisor: (config) => {
				const supervisor = new ExecuteGateWorkerSupervisor(config);
				resolveGatedSupervisor(supervisor);
				return supervisor;
			},
		});
		const sourceControlPlane = createWorkerControlPlane(sourceSession, source);
		const claimedRequest = operation("operation-claimed-crash-prefix");
		const pending = source.start(claimedRequest, { correlation: correlation(claimedRequest.operationId) });
		const gatedSupervisor = await Promise.race([
			gatedSupervisorCreated,
			pending.then((result) => { throw new Error(`Operation returned before Supervisor creation: ${JSON.stringify(result)}`); }),
		]);
		await gatedSupervisor.executeEntered;
		const crashPrefix = sourceSession.getPhysicalEntries();
		expect(crashPrefix.some((entry) => entry.type === "custom" && entry.customType === "worker.operation_recorded" &&
			JSON.stringify(entry.data).includes('"phase":"claimed"'))).toBe(true);

		const restoredSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of crashPrefix) {
			if (entry.type === "custom") restoredSession.appendCustomEntry(entry.customType, entry.data);
		}
		gatedSupervisor.releaseExecute();
		expect(await pending).toMatchObject({ ok: true });
		await sourceControlPlane.dispose();

		let restoredCreates = 0;
		const restoredProvider = replayableProvider(() => { restoredCreates += 1; });
		const restoredControlPlane = createWorkerControlPlane(restoredSession, restoredProvider);
		expect(await restoredProvider.start(claimedRequest, { correlation: correlation(claimedRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(restoredCreates).toBe(0);
		await restoredControlPlane.dispose();
	});

	it("never executes after cancellation races with activation", async () => {
		const records: WorkerRecord[] = [];
		let enteredActivate: () => void = () => undefined;
		const activateEntered = new Promise<void>((resolve) => { enteredActivate = resolve; });
		let releaseActivate: () => void = () => undefined;
		const activateRelease = new Promise<void>((resolve) => { releaseActivate = resolve; });
		let executeCalls = 0;
		let supervisor: OperationWorkerSupervisor | undefined;
		class BarrierSupervisor extends OperationWorkerSupervisor {
			override async activate(plan: WorkerActivationPlan) {
				const activation = super.activate(plan);
				if (!this.snapshot.hasLiveProcess || this.snapshot.record?.status !== "starting") {
					throw new Error("Expected live starting Worker at activation barrier");
				}
				enteredActivate();
				await activateRelease;
				return activation;
			}

			override execute(request: SandboxOperationRequest) {
				executeCalls += 1;
				return super.execute(request);
			}
		}
		const current = provider("ready_slow", {
			onRecord: (record) => records.push(record),
			createSupervisor: (config) => {
				supervisor = new BarrierSupervisor(config);
				return supervisor;
			},
		});
		const controller = new AbortController();
		const request = operation("operation-activate-abort");
		const started = current.start(request, { correlation: correlation(request.operationId), signal: controller.signal });
		await activateEntered;
		controller.abort(new DOMException("cancel activation", "AbortError"));
		releaseActivate();
		expect(await started).toMatchObject({ ok: false, error: { code: "worker_cancel_failed" } });
		expect(executeCalls).toBe(0);
		expect(records.some((record) => record.status === "running")).toBe(false);
		expect(records.at(-1)?.status).toMatch(/reclaimed|reclaim_unknown/);
		expect(supervisor?.snapshot.hasLiveProcess).toBe(false);
	});

	it("waits for in-flight activation before releasing a failing durable owner on dispose", async () => {
		let supervisor: ActivationBarrierWorkerSupervisor | undefined;
		let durableCalls = 0;
		const current = provider("ready_timeout", {
			durableOwner: false,
			createSupervisor: (config) => {
				supervisor = new ActivationBarrierWorkerSupervisor(config);
				return supervisor;
			},
		});
		current.bindDurableFactSink("session-1", () => {
			durableCalls += 1;
			throw new Error("durable shutdown failed");
		});
		const request = operation("operation-dispose-durable-failure");
		const pending = current.start(request, { correlation: correlation(request.operationId) });
		while (supervisor === undefined) await Promise.resolve();
		await supervisor.activationEntered;
		await expect(current.dispose()).rejects.toMatchObject({ code: "worker_persistence_failed" });
		expect(await pending).toMatchObject({ ok: false, error: { code: "worker_persistence_failed" } });
		expect(supervisor.snapshot.hasLiveProcess).toBe(false);
		expect(current.hasDurableFactOwner()).toBe(false);
		const callsAfterDispose = durableCalls;
		await Promise.resolve();
		expect(durableCalls).toBe(callsAfterDispose);
		expect(await current.start(operation("operation-after-failed-dispose"))).toMatchObject({
			ok: false,
			error: { code: "worker_unavailable" },
		});
	});

	it("contains injected callback failures and rejects capability drift before spawn", async () => {
		const callbackFailure = provider("success", { onRecord: () => { throw new Error("unsafe callback"); } });
		const callbackRequest = operation("operation-callback-failure");
		expect(await callbackFailure.start(callbackRequest, { correlation: correlation(callbackRequest.operationId) })).toMatchObject({
			ok: true,
			value: { status: "succeeded" },
		});

		const constructionFailure = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read"],
				},
			},
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: { ...binding(request, "success"), capabilitySummary: ["filesystem.read"] },
			}),
			createSupervisor: () => { throw new Error("unsafe constructor"); },
		});
		const constructionRequest = operation("operation-construction-failure");
		constructionFailure.bindDurableFactSink("session-1", () => undefined);
		expect(await constructionFailure.start(constructionRequest, { correlation: correlation(constructionRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_start_failed" },
		});

		let driftCreated = 0;
		const drift = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read"],
				},
			},
			capabilities: [{ schemaVersion: 1, id: "process.spawn", version: 1 }],
			resolvePreflight: (request) => facts(request, "success"),
			createSupervisor: (config) => {
				driftCreated += 1;
				return new OperationWorkerSupervisor(config);
			},
		});
		const driftRequest = operation("operation-capability-drift");
		expect(await drift.start(driftRequest, { correlation: correlation(driftRequest.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_profile_untrusted" },
		});
		expect(driftCreated).toBe(0);
	});

	it("normalizes shuffled Host capability facts to the trusted profile order", async () => {
		const current = provider("success", {
			resolvePreflight: (request) => ({
				...facts(request, "success"),
				binding: {
					...binding(request, "success"),
					capabilitySummary: ["process.spawn", "filesystem.read"],
				},
			}),
		});
		const request = operation("operation-shuffled-capabilities");
		expect(await executeOperation({
			provider: current,
			request,
			correlation: correlation(request.operationId),
		})).toMatchObject({ ok: true, value: { status: "succeeded" } });
	});

	it("retains bounded authoritative safe records, receipts, and complete transition facts", async () => {
		const factsSeen: WorkerSandboxFact[] = [];
		const current = new WorkerSandboxProvider({
			providerId: "sandbox-worker",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
					cancelTimeoutMs: 120,
					terminateTimeoutMs: 500,
				},
			},
			maxRetainedRecords: 1,
			resolvePreflight: (request) => facts(request, "success"),
			createSupervisor: (config) => new OperationWorkerSupervisor(config),
		});
		current.bindDurableFactSink("session-1", () => undefined);
		const unsubscribe = current.subscribeFacts((fact) => factsSeen.push(fact));
		for (const operationId of ["operation-retained-first", "operation-retained-second"]) {
			const request = operation(operationId);
			expect(await current.start(request, { correlation: correlation(operationId) })).toMatchObject({ ok: true });
		}
		unsubscribe();
		expect(current.listWorkerRecords()).toHaveLength(1);
		expect(current.listWorkerReceipts()).toHaveLength(1);
		const retained = current.listWorkerRecords()[0];
		if (retained === undefined) throw new Error("Expected retained Worker record");
		expect(current.getWorkerRecord(retained.workerId)).toEqual(retained);
		expect(await current.reclaimWorker(retained.workerId)).toMatchObject({ ok: true, value: { status: "reclaimed" } });
		expect(await current.reclaimWorker("missing-worker")).toMatchObject({ ok: false, error: { code: "worker_not_found" } });
		const lastRecordFact = factsSeen.filter((fact) => fact.type === "record").at(-1);
		if (lastRecordFact?.type !== "record") throw new Error("Expected safe record fact");
		expect(lastRecordFact.transitions.map((transition) => transition.to)).toEqual([
			"starting",
			"ready",
			"running",
			"completed",
			"reclaiming",
			"reclaimed",
		]);
		expect(factsSeen.filter((fact) => fact.type === "receipt")).toHaveLength(2);
		expect(JSON.stringify(factsSeen)).not.toMatch(/AOS_SAFE_TEST_MARKER|entrypoint|stdout|environment/);
	});

	it("rejects reclaim while a live Worker operation is running", async () => {
		let resolveRunning: (record: WorkerRecord) => void = () => undefined;
		const running = new Promise<WorkerRecord>((resolve) => { resolveRunning = resolve; });
		let supervisor: OperationWorkerSupervisor | undefined;
		class RunningObservedSupervisor extends OperationWorkerSupervisor {
			override execute(request: SandboxOperationRequest) {
				const execution = super.execute(request);
				const observeRunning = (): void => {
					const record = this.snapshot.record;
					if (record?.status === "running") {
						resolveRunning(record);
						return;
					}
					setImmediate(observeRunning);
				};
				setImmediate(observeRunning);
				return execution;
			}
		}
		const current = provider("cancel_success", {
			createSupervisor: (config) => {
				supervisor = new RunningObservedSupervisor(config);
				return supervisor;
			},
		});
		const request = operation("operation-live-reclaim-conflict");
		const pending = current.start(request, { correlation: correlation(request.operationId) });
		const runningRecord = await running;
		expect(await current.reclaimWorker(runningRecord.workerId)).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(supervisor?.snapshot).toMatchObject({
			hasLiveProcess: true,
			record: { status: "running" },
		});
		expect(supervisor?.lifecycleState?.transitions.map((transition) => transition.to)).not.toContain("reclaiming");
		expect(await current.cancel(request.operationId)).toEqual({ ok: true, value: undefined });
		expect(await pending).toMatchObject({ ok: true, value: { status: "cancelled" } });
	});

	it("persists deterministic transition envelopes, deduplicates after cache eviction, and restores consumed identities", async () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const current = replayableProvider();
		const factsSeen: WorkerSandboxFact[] = [];
		current.subscribeFacts((fact) => factsSeen.push(fact));
		const controlPlane = createWorkerControlPlane(session, current, { cacheLimit: 1 });
		const request = operation("operation-durable-reload");
		const completed = await current.start(request, { correlation: correlation(request.operationId) });
		if (!completed.ok) throw completed.error;
		const terminalSnapshot = current.listWorkerRecords()[0];
		if (terminalSnapshot === undefined) throw new Error("Expected a durable Worker snapshot");
		const persistedCount = session.getPhysicalEntries().length;
		for (const fact of factsSeen) current.replayFact(fact);
		expect(session.getPhysicalEntries()).toHaveLength(persistedCount);
		await controlPlane.dispose();

		let created = 0;
		const restoredProvider = replayableProvider(() => { created += 1; });
		const restoredControlPlane = createWorkerControlPlane(session, restoredProvider, { cacheLimit: 1 });
		expect(restoredProvider.listWorkerRecords()).toEqual([terminalSnapshot]);
		expect(await restoredProvider.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(created).toBe(0);
		await restoredControlPlane.dispose();
	});

	it("pins receipt persistence to the execution-terminal revision when observation aborts", async () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const current = replayableProvider();
		const controller = new AbortController();
		current.subscribeFacts((fact) => {
			if (fact.type === "record" && fact.record.status === "completed") {
				controller.abort(new DOMException("late terminal observation", "AbortError"));
			}
		});
		const controlPlane = createWorkerControlPlane(session, current);
		const request = operation("operation-terminal-observation-abort");
		expect(await current.start(request, {
			correlation: correlation(request.operationId),
			signal: controller.signal,
		})).toMatchObject({ ok: true });
		const workerEvents = session.getPhysicalEntries().filter((entry) => entry.type === "custom");
		const completedLifecycle = workerEvents.find((entry) =>
			entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned" && JSON.stringify(entry.data).includes('"status":"completed"'));
		const receiptEvent = workerEvents.find((entry) => entry.type === "custom" && entry.customType === "worker_receipt.written");
		if (completedLifecycle?.type !== "custom" || receiptEvent?.type !== "custom" ||
			completedLifecycle.data === null || typeof completedLifecycle.data !== "object" || Array.isArray(completedLifecycle.data) ||
			receiptEvent.data === null || typeof receiptEvent.data !== "object" || Array.isArray(receiptEvent.data)) {
			throw new Error("Expected terminal lifecycle and receipt events");
		}
		if (!("sequence" in receiptEvent.data) || !("sequence" in completedLifecycle.data)) throw new Error("Expected event sequences");
		expect(receiptEvent.data.sequence).toBe(completedLifecycle.data.sequence);
		await controlPlane.dispose();
		const restored = replayableProvider();
		const restoredControlPlane = createWorkerControlPlane(session, restored);
		expect(restored.listWorkerReceipts()).toHaveLength(0);
		expect(await restored.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		await restoredControlPlane.dispose();
	});

	it("quarantines a restored execution-terminal Worker as reclaim_unknown without spawning", async () => {
		const sourceSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const source = provider("disconnect", { durableOwner: false });
		const sourceControlPlane = createWorkerControlPlane(sourceSession, source);
		const request = operation("operation-restored-lost");
		expect(await source.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_lost" },
		});
		await sourceControlPlane.dispose();
		const lostPrefix = sourceSession.getPhysicalEntries().filter((entry) => {
			if (entry.type !== "custom" ||
				(entry.customType !== "worker.lifecycle_transitioned" && entry.customType !== "worker.operation_recorded")) return false;
			if (entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) return false;
			if (entry.customType === "worker.operation_recorded") {
				return "sequence" in entry.data && typeof entry.data.sequence === "number" && entry.data.sequence <= 4;
			}
			const payload = "payload" in entry.data ? entry.data.payload : undefined;
			return payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
				"status" in payload && ["starting", "ready", "running", "lost"].includes(String(payload.status));
		});
		expect(lostPrefix.filter((entry) => entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned")).toHaveLength(4);

		const restoredSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of lostPrefix) {
			if (entry.type !== "custom") throw new Error("Expected Worker lifecycle entry");
			restoredSession.appendCustomEntry(entry.customType, entry.data);
		}
		let created = 0;
		const restored = replayableProvider(() => { created += 1; });
		const restoredControlPlane = createWorkerControlPlane(restoredSession, restored);
		const quarantined = restored.listWorkerRecords()[0];
		if (quarantined === undefined) throw new Error("Expected restored Worker quarantine");
		expect(quarantined).toMatchObject({
			status: "reclaim_unknown",
			revision: 6,
		});
		expect(created).toBe(0);
		const statuses = restoredSession.getPhysicalEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== "worker.lifecycle_transitioned") return [];
			if (entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) return [];
			const payload = "payload" in entry.data ? entry.data.payload : undefined;
			return payload !== null && typeof payload === "object" && !Array.isArray(payload) && "status" in payload
				? [String(payload.status)]
				: [];
		});
		expect(statuses.slice(-2)).toEqual(["reclaiming", "reclaim_unknown"]);
		expect(await restored.reclaimWorker(quarantined.workerId)).toEqual({ ok: true, value: quarantined });
		await restoredControlPlane.dispose();
	});

	it("converges starting, ready, running, cancelling, and reclaiming history prefixes without spawning", async () => {
		const sourceSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const source = replayableProvider();
		const sourceControlPlane = createWorkerControlPlane(sourceSession, source);
		const request = operation("operation-recovery-prefix-source");
		expect(await source.start(request, { correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		await source.reclaimWorker(source.listWorkerRecords()[0]?.workerId ?? "missing");
		await sourceControlPlane.dispose();
		const sourceEntries = sourceSession.getPhysicalEntries().filter((entry) => entry.type === "custom");
		const sequenceOf = (entry: (typeof sourceEntries)[number]): number => {
			if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) {
				throw new Error("Expected Worker custom event");
			}
			const sequence = "sequence" in entry.data ? entry.data.sequence : undefined;
			if (typeof sequence !== "number") throw new Error("Expected Worker event sequence");
			return sequence;
		};
		const lifecycleByStatus = (status: string) => sourceEntries.find((entry) =>
			entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned" &&
			JSON.stringify(entry.data).includes(`"status":"${status}"`));
		const running = lifecycleByStatus("running");
		const completed = lifecycleByStatus("completed");
		if (running?.type !== "custom" || completed?.type !== "custom") throw new Error("Expected source execution lifecycle");
		const cancellingData = JSON.parse(JSON.stringify(running.data)) as Record<string, unknown>;
		const completedData = completed.data;
		if (completedData === null || typeof completedData !== "object" || Array.isArray(completedData)) throw new Error("Expected completed envelope");
		const cancellingPayload = cancellingData.payload;
		if (cancellingPayload === null || typeof cancellingPayload !== "object" || Array.isArray(cancellingPayload)) throw new Error("Expected running payload");
		cancellingData.eventId = String("eventId" in completedData ? completedData.eventId : "");
		cancellingData.sequence = 4;
		cancellingData.timestamp = "timestamp" in completedData ? completedData.timestamp : undefined;
		(cancellingPayload as Record<string, unknown>).status = "cancelling";
		(cancellingPayload as Record<string, unknown>).revision = 4;

		for (const scenario of [
			{ status: "starting", revision: 1 },
			{ status: "ready", revision: 2 },
			{ status: "running", revision: 3 },
			{ status: "cancelling", revision: 4 },
			{ status: "reclaiming", revision: 5 },
		] as const) {
			const restoredSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			for (const entry of sourceEntries) {
				if (entry.type !== "custom" || sequenceOf(entry) > scenario.revision) continue;
				if (entry.customType === "worker.lifecycle_transitioned" && sequenceOf(entry) === 4 && scenario.status === "cancelling") {
					restoredSession.appendCustomEntry(entry.customType, cancellingData);
					continue;
				}
				if (scenario.status === "cancelling" && entry.customType === "worker_receipt.written") continue;
				if (scenario.status === "cancelling" && entry.customType === "worker.operation_recorded" && sequenceOf(entry) === 4) continue;
				restoredSession.appendCustomEntry(entry.customType, entry.data);
			}
			let created = 0;
			const restored = replayableProvider(() => { created += 1; });
			const restoredControlPlane = createWorkerControlPlane(restoredSession, restored);
			expect(restored.listWorkerRecords()).toEqual([
				expect.objectContaining({ status: "reclaim_unknown", revision: scenario.revision < 5 ? scenario.revision + 3 : 6 }),
			]);
			expect(created).toBe(0);
			const statuses = restoredSession.getPhysicalEntries().flatMap((entry) =>
				entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned"
					? [JSON.stringify(entry.data)]
					: []);
			expect(statuses.at(-1)).toContain('"status":"reclaim_unknown"');
			await restoredControlPlane.dispose();
		}
	});

	it("fails closed and leaves ownership unbound for malformed historical lifecycle streams", async () => {
		const sourceSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const sourceProvider = replayableProvider();
		const sourceControlPlane = createWorkerControlPlane(sourceSession, sourceProvider);
		const request = operation("operation-history-source");
		expect(await sourceProvider.start(request, { correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		await sourceControlPlane.dispose();
		const lifecycleEntries = sourceSession.getPhysicalEntries().filter((entry) =>
			entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned");
		expect(lifecycleEntries.length).toBeGreaterThan(3);
		const cloneData = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
		const lifecycleData = (index: number): unknown => {
			const entry = lifecycleEntries[index];
			if (entry?.type !== "custom") throw new Error("Expected lifecycle custom entry");
			return entry.data;
		};
		const first = cloneData(lifecycleData(0));
		const second = cloneData(lifecycleData(1));
		const third = cloneData(lifecycleData(2));
		const alternateId = cloneData(first);
		alternateId.eventId = "tampered-id";
		const identityDrift = cloneData(second);
		const driftPayload = identityDrift.payload;
		const driftCorrelation = identityDrift.correlation;
		if (driftPayload === null || typeof driftPayload !== "object" || Array.isArray(driftPayload)) throw new Error("Expected lifecycle payload");
		if (driftCorrelation === null || typeof driftCorrelation !== "object" || Array.isArray(driftCorrelation)) throw new Error("Expected lifecycle correlation");
		(driftPayload as Record<string, unknown>).profileId = "drifted-profile";
		const duplicateConflict = cloneData(first);
		const duplicatePayload = duplicateConflict.payload;
		if (duplicatePayload === null || typeof duplicatePayload !== "object" || Array.isArray(duplicatePayload)) throw new Error("Expected duplicate payload");
		(duplicatePayload as Record<string, unknown>).profileId = "conflicting-profile";
		const foreignSession = cloneData(first);
		const foreignPayload = foreignSession.payload;
		const foreignCorrelation = foreignSession.correlation;
		if (foreignPayload === null || typeof foreignPayload !== "object" || Array.isArray(foreignPayload)) throw new Error("Expected foreign payload");
		if (foreignCorrelation === null || typeof foreignCorrelation !== "object" || Array.isArray(foreignCorrelation)) throw new Error("Expected foreign correlation");
		(foreignPayload as Record<string, unknown>).sessionId = "foreign-session";
		(foreignCorrelation as Record<string, unknown>).sessionId = "foreign-session";
		const numericOperationId = cloneData(first);
		const numericOperationPayload = numericOperationId.payload;
		if (numericOperationPayload === null || typeof numericOperationPayload !== "object" || Array.isArray(numericOperationPayload)) {
			throw new Error("Expected numeric operation payload");
		}
		(numericOperationPayload as Record<string, unknown>).operationId = 123;
		const nonCanonicalTimestamp = cloneData(first);
		nonCanonicalTimestamp.timestamp = "2026-08-21T00:00:00Z";
		const startingBeforeCreatedAt = cloneData(first);
		startingBeforeCreatedAt.timestamp = "2000-01-01T00:00:00.000Z";
		const scenarios: readonly (readonly Record<string, unknown>[])[] = [
			[first, third],
			[alternateId],
			[first, identityDrift],
			[second, first],
			[first, duplicateConflict],
			[foreignSession],
			[numericOperationId],
			[nonCanonicalTimestamp],
			[startingBeforeCreatedAt],
		];
		for (const entries of scenarios) {
			const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			for (const event of entries) session.appendCustomEntry("worker.lifecycle_transitioned", event);
			const current = replayableProvider();
			expect(() => createWorkerControlPlane(session, current)).toThrow(expect.objectContaining({ code: "worker_persistence_failed" }));
			expect(current.hasDurableFactOwner()).toBe(false);
			const release = current.bindDurableFactSink("session-1", () => undefined);
			release();
		}
	});

	it("keeps recovery construction transactional across provider and append failures", async () => {
		const sourceSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const source = replayableProvider();
		const sourceControlPlane = createWorkerControlPlane(sourceSession, source);
		const request = operation("operation-transaction-prefix");
		expect(await source.start(request, { correlation: correlation(request.operationId) })).toMatchObject({ ok: true });
		await sourceControlPlane.dispose();
		const readyPrefix = sourceSession.getPhysicalEntries().filter((entry) => {
			if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) return false;
			return "sequence" in entry.data && typeof entry.data.sequence === "number" && entry.data.sequence <= 2;
		});
		const makePrefixSession = (): SessionManager => {
			const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			for (const entry of readyPrefix) {
				if (entry.type === "custom") session.appendCustomEntry(entry.customType, entry.data);
			}
			return session;
		};

		const disposedSession = makePrefixSession();
		const disposed = replayableProvider();
		await disposed.dispose();
		const disposedCount = disposedSession.getPhysicalEntries().length;
		expect(() => createWorkerControlPlane(disposedSession, disposed)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(disposedSession.getPhysicalEntries()).toHaveLength(disposedCount);
		expect(disposed.hasDurableFactOwner()).toBe(false);
		const afterDisposed = replayableProvider();
		const afterDisposedControlPlane = createWorkerControlPlane(disposedSession, afterDisposed);
		await afterDisposedControlPlane.dispose();

		const foreignSession = makePrefixSession();
		const foreignProvider = new WorkerSandboxProvider({
			providerId: "foreign-provider",
			profile: {
				profileId: "success",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "success",
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 2_000,
				},
			},
			resolvePreflight: (operationRequest) => facts(operationRequest, "success"),
		});
		const foreignCount = foreignSession.getPhysicalEntries().length;
		expect(() => createWorkerControlPlane(foreignSession, foreignProvider)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(foreignSession.getPhysicalEntries()).toHaveLength(foreignCount);
		expect(foreignProvider.hasDurableFactOwner()).toBe(false);

		const tamperedClaimSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of readyPrefix) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== "worker.operation_recorded") {
				tamperedClaimSession.appendCustomEntry(entry.customType, entry.data);
				continue;
			}
			const claim = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
			const payload = claim.payload;
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected claimed payload");
			(payload as Record<string, unknown>).providerId = "foreign-provider";
			tamperedClaimSession.appendCustomEntry(entry.customType, claim);
		}
		const tamperedClaimCount = tamperedClaimSession.getPhysicalEntries().length;
		const tamperedClaimProvider = replayableProvider();
		expect(() => createWorkerControlPlane(tamperedClaimSession, tamperedClaimProvider)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(tamperedClaimSession.getPhysicalEntries()).toHaveLength(tamperedClaimCount);
		expect(tamperedClaimProvider.hasDurableFactOwner()).toBe(false);

		const receiptDriftSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of sourceSession.getPhysicalEntries()) {
			if (entry.type !== "custom") continue;
			const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
			const payload = event.payload;
			if (entry.customType === "worker.operation_recorded" && payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
				"phase" in payload && payload.phase === "terminal") {
				(payload as Record<string, unknown>).receiptId = "tampered-receipt";
				const eventCorrelation = event.correlation;
				if (eventCorrelation === null || typeof eventCorrelation !== "object" || Array.isArray(eventCorrelation)) throw new Error("Expected operation correlation");
				(eventCorrelation as Record<string, unknown>).receiptId = "tampered-receipt";
			}
			receiptDriftSession.appendCustomEntry(entry.customType, event);
		}
		const receiptDriftProvider = replayableProvider();
		expect(() => createWorkerControlPlane(receiptDriftSession, receiptDriftProvider)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(receiptDriftProvider.hasDurableFactOwner()).toBe(false);

		const forbiddenHistoryScenarios = [
			{ customType: "worker.lifecycle_transitioned", target: "correlation", key: "agentInstanceId" },
			{ customType: "worker.operation_recorded", target: "correlation", key: "agentInstanceId" },
			{ customType: "worker_receipt.written", target: "correlation", key: "agentInstanceId" },
			{ customType: "worker.operation_recorded", target: "payload", key: "command" },
			{ customType: "worker_receipt.written", target: "payload", key: "path" },
		] as const;
		for (const scenario of forbiddenHistoryScenarios) {
			const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			let tampered = false;
			for (const entry of sourceSession.getPhysicalEntries()) {
				if (entry.type !== "custom") continue;
				const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
				if (!tampered && entry.customType === scenario.customType) {
					const target = event[scenario.target];
					if (target === null || typeof target !== "object" || Array.isArray(target)) {
						throw new Error("Expected Worker event object");
					}
					(target as Record<string, unknown>)[scenario.key] = "forbidden";
					tampered = true;
				}
				session.appendCustomEntry(entry.customType, event);
			}
			expect(tampered).toBe(true);
			const countBefore = session.getPhysicalEntries().length;
			const current = replayableProvider();
			expect(() => createWorkerControlPlane(session, current)).toThrow(
				expect.objectContaining({ code: "worker_persistence_failed" }),
			);
			expect(session.getPhysicalEntries()).toHaveLength(countBefore);
			expect(current.hasDurableFactOwner()).toBe(false);
		}

		for (const customType of [
			"worker.lifecycle_transitioned",
			"worker.operation_recorded",
			"worker_receipt.written",
		] as const) {
			const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			let tampered = false;
			for (const entry of sourceSession.getPhysicalEntries()) {
				if (entry.type !== "custom") continue;
				const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
				if (!tampered && entry.customType === customType) {
					event.timestamp = "2026-08-21T00:00:00Z";
					tampered = true;
				}
				session.appendCustomEntry(entry.customType, event);
			}
			expect(tampered).toBe(true);
			const countBefore = session.getPhysicalEntries().length;
			const current = replayableProvider();
			expect(() => createWorkerControlPlane(session, current)).toThrow(
				expect.objectContaining({ code: "worker_persistence_failed" }),
			);
			expect(session.getPhysicalEntries()).toHaveLength(countBefore);
			expect(current.hasDurableFactOwner()).toBe(false);
		}

		const receiptTaskDriftSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		let receiptTaskDrifted = false;
		for (const entry of sourceSession.getPhysicalEntries()) {
			if (entry.type !== "custom") continue;
			const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
			if (!receiptTaskDrifted && entry.customType === "worker_receipt.written") {
				const eventCorrelation = event.correlation;
				if (eventCorrelation === null || typeof eventCorrelation !== "object" || Array.isArray(eventCorrelation)) {
					throw new Error("Expected receipt correlation");
				}
				(eventCorrelation as Record<string, unknown>).taskId = "task-drifted";
				receiptTaskDrifted = true;
			}
			receiptTaskDriftSession.appendCustomEntry(entry.customType, event);
		}
		expect(receiptTaskDrifted).toBe(true);
		const receiptTaskDriftCount = receiptTaskDriftSession.getPhysicalEntries().length;
		const receiptTaskDriftProvider = replayableProvider();
		expect(() => createWorkerControlPlane(receiptTaskDriftSession, receiptTaskDriftProvider)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(receiptTaskDriftSession.getPhysicalEntries()).toHaveLength(receiptTaskDriftCount);
		expect(receiptTaskDriftProvider.hasDurableFactOwner()).toBe(false);

		for (const phaseScenario of ["missing-started", "missing-terminal", "duplicate-started"] as const) {
			const session = SessionManager.inMemory(process.cwd(), { id: "session-1" });
			for (const entry of sourceSession.getPhysicalEntries()) {
				if (entry.type !== "custom") continue;
				const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
				const payload = event.payload;
				const phase = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "phase" in payload
					? payload.phase
					: undefined;
				if (entry.customType === "worker.operation_recorded" && (
					phaseScenario === "missing-started" && phase === "started" ||
					phaseScenario === "missing-terminal" && phase === "terminal"
				)) continue;
				if (entry.customType === "worker.operation_recorded" && phaseScenario === "duplicate-started" && phase === "terminal") {
					const eventCorrelation = event.correlation;
					if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
						eventCorrelation === null || typeof eventCorrelation !== "object" || Array.isArray(eventCorrelation)) {
						throw new Error("Expected terminal operation event");
					}
					(payload as Record<string, unknown>).phase = "started";
					delete (payload as Record<string, unknown>).sideEffectState;
					delete (payload as Record<string, unknown>).receiptId;
					delete (eventCorrelation as Record<string, unknown>).receiptId;
				}
				session.appendCustomEntry(entry.customType, event);
			}
			const countBefore = session.getPhysicalEntries().length;
			const current = replayableProvider();
			expect(() => createWorkerControlPlane(session, current)).toThrow(
				expect.objectContaining({ code: "worker_persistence_failed" }),
			);
			expect(session.getPhysicalEntries()).toHaveLength(countBefore);
			expect(current.hasDurableFactOwner()).toBe(false);
		}

		const operationDriftSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of sourceSession.getPhysicalEntries()) {
			if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data) ||
				!("sequence" in entry.data) || typeof entry.data.sequence !== "number" || entry.data.sequence > 3) continue;
			const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
			const payload = event.payload;
			const eventCorrelation = event.correlation;
			if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
				eventCorrelation === null || typeof eventCorrelation !== "object" || Array.isArray(eventCorrelation)) throw new Error("Expected operation prefix envelope");
			if (entry.data.sequence === 3) {
				(payload as Record<string, unknown>).operationId = "operation-drifted-after-claim";
				(eventCorrelation as Record<string, unknown>).operationId = "operation-drifted-after-claim";
				if (entry.customType === "worker.lifecycle_transitioned") {
					(payload as Record<string, unknown>).activeOperationId = "operation-drifted-after-claim";
				} else if (entry.customType === "worker.operation_recorded") {
					event.streamId = "worker-operation:worker-operation-transaction-prefix:operation-drifted-after-claim";
				}
			}
			operationDriftSession.appendCustomEntry(entry.customType, event);
		}
		const operationDriftProvider = replayableProvider();
		expect(() => createWorkerControlPlane(operationDriftSession, operationDriftProvider)).toThrow(
			expect.objectContaining({ code: "worker_persistence_failed" }),
		);
		expect(operationDriftProvider.hasDurableFactOwner()).toBe(false);

		const publicOperationId = `operation durable 空格 ${"长".repeat(300)}`;
		const publicIdSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		for (const entry of readyPrefix) {
			if (entry.type !== "custom" || entry.customType !== "worker.operation_recorded") {
				if (entry.type === "custom") publicIdSession.appendCustomEntry(entry.customType, entry.data);
				continue;
			}
			const event = JSON.parse(JSON.stringify(entry.data)) as Record<string, unknown>;
			const payload = event.payload;
			const eventCorrelation = event.correlation;
			if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
				eventCorrelation === null || typeof eventCorrelation !== "object" || Array.isArray(eventCorrelation)) {
				throw new Error("Expected claimed operation envelope");
			}
			(payload as Record<string, unknown>).operationId = publicOperationId;
			(eventCorrelation as Record<string, unknown>).operationId = publicOperationId;
			event.streamId = `worker-operation:worker-operation-transaction-prefix:${publicOperationId}`;
			publicIdSession.appendCustomEntry(entry.customType, event);
		}
		let publicIdCreates = 0;
		const publicIdProvider = replayableProvider(() => { publicIdCreates += 1; });
		const publicIdControlPlane = createWorkerControlPlane(publicIdSession, publicIdProvider);
		const publicIdRequest = operation(publicOperationId);
		expect(await publicIdProvider.start(publicIdRequest, { correlation: correlation(publicOperationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(publicIdCreates).toBe(0);
		await publicIdControlPlane.dispose();

		const appendFailureSession = makePrefixSession();
		const originalAppend = appendFailureSession.appendCustomEntry.bind(appendFailureSession);
		let convergenceAppends = 0;
		const appendSpy = vi.spyOn(appendFailureSession, "appendCustomEntry").mockImplementation((customType, data) => {
			convergenceAppends += 1;
			if (convergenceAppends === 2) throw new Error("durable append failed");
			return originalAppend(customType, data);
		});
		const beforeAppendFailure = appendFailureSession.getPhysicalEntries().length;
		const failedProvider = replayableProvider();
		expect(() => createWorkerControlPlane(appendFailureSession, failedProvider)).toThrow();
		expect(appendFailureSession.getPhysicalEntries()).toHaveLength(beforeAppendFailure + 1);
		expect(failedProvider.hasDurableFactOwner()).toBe(false);
		appendSpy.mockRestore();
		const retryProvider = replayableProvider();
		const retryControlPlane = createWorkerControlPlane(appendFailureSession, retryProvider);
		expect(retryProvider.listWorkerRecords()).toEqual([
			expect.objectContaining({ status: "reclaim_unknown" }),
		]);
		await retryControlPlane.dispose();

		const collisionSession = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const firstLifecycle = sourceSession.getPhysicalEntries().find((entry) =>
			entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned");
		if (firstLifecycle?.type !== "custom") throw new Error("Expected source lifecycle event");
		collisionSession.appendCustomEntry("unrelated.plugin_event", firstLifecycle.data);
		const collisionProvider = replayableProvider();
		const collisionControlPlane = createWorkerControlPlane(collisionSession, collisionProvider);
		expect(await collisionProvider.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_persistence_failed" },
		});
		expect(collisionSession.getPhysicalEntries().filter((entry) =>
			entry.type === "custom" && entry.customType === "worker.lifecycle_transitioned")).toEqual([]);
		await collisionControlPlane.dispose().catch(() => undefined);
	});

	it("ignores a heartbeat emitted after the terminal receipt and reclaims normally", async () => {
		const records: WorkerRecord[] = [];
		const current = provider("late_heartbeat", { onRecord: (record) => records.push(record) });
		const request = operation("operation-late-heartbeat");
		const result = await executeOperation({
			provider: current,
			request,
			correlation: correlation(request.operationId),
		});
		expect(result).toMatchObject({ ok: true, value: { workerReceiptId: "receipt-operation-late-heartbeat" } });
		const terminal = records.filter((record) => record.status === "completed");
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			receiptId: "receipt-operation-late-heartbeat",
		});
		const reclaimed = records.at(-1);
		expect(reclaimed).toMatchObject({ status: "reclaimed", receiptId: "receipt-operation-late-heartbeat" });
		expect(reclaimed?.revision).toBe((terminal[0]?.revision ?? 0) + 2);
		expect(reclaimed?.lastHeartbeatAt).toBe(terminal[0]?.lastHeartbeatAt);

		const crossWorker = provider("late_heartbeat_cross_worker");
		const crossRequest = operation("operation-cross-worker-heartbeat");
		expect(await executeOperation({
			provider: crossWorker,
			request: crossRequest,
			correlation: correlation(crossRequest.operationId),
		})).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("uses one provider instance for Harness gateway execution and ControlPlane durable ownership", async () => {
		const sessionManager = SessionManager.inMemory(process.cwd(), { id: "session-1" });
		const workerProvider = replayableProvider();
		const models = createModels();
		models.setProvider(googleProvider());
		const storage = createSessionManagerStorage(sessionManager);
		const session = new Session(storage);
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarnessFromTrustedProvidersForTest({
			session,
			models,
			model: getModel("google", "gemini-2.5-flash"),
			env,
			compatibilityWriter: createHarnessCompatibilityWriter(session, storage),
			workerSandbox: {
				provider: workerProvider,
				routes: [{ kind: "sandbox", toolName: "worker-read", providerId: workerProvider.providerId, revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } }],
				onOperationPayload: (operationId, payload) => workerProvider.onOperationPayload(operationId, payload),
			},
		});
		if (!("operationToolGateway" in created)) throw new Error("Expected configured Worker ToolGateway");
		const controlPlane = createWorkerControlPlane(sessionManager, workerProvider, { harness: created.harness });
		try {
			expect((await created.operationToolGateway.capabilities()).map((capability) => capability.id)).toEqual([
				"tool_gateway",
				"filesystem.read",
				"process.spawn",
			]);
			const result = await created.operationToolGateway.execute({
				schemaVersion: 1,
				toolCallId: "call-production-composition",
				toolName: "worker-read",
				originalArguments: { resource: "filesystem.read", operation: "file.read", path: "README.md" },
				context: {
					schemaVersion: 1,
					operationId: "operation-production-composition",
					agentInstanceId: "upstream-agent-only",
					bindingId: "binding-1",
					bindingEpochId: "epoch-1",
					taskId: "task-1",
					dispatchId: "dispatch-1",
					attemptId: "attempt-1",
				},
			});
			expect(result).toMatchObject({ ok: true, value: { ok: true } });
			if (!result.ok || result.value.toolReceiptRef === undefined) throw new Error("Expected gateway receipt reference");
			const receipt = workerProvider.getWorkerReceipt(result.value.toolReceiptRef);
			expect(receipt?.provenance.correlation).not.toHaveProperty("agentInstanceId");
			expect(workerProvider.listWorkerRecords()).toEqual([
				expect.objectContaining({ sessionId: "session-1", status: "reclaimed" }),
			]);
			const durableWorkerEvents = (await session.findEntries({ type: "custom", order: "oldestFirst" })).filter((entry) =>
				entry.type === "custom" && entry.customType.startsWith("worker"));
			expect(durableWorkerEvents.length).toBeGreaterThan(0);
			for (const entry of durableWorkerEvents) {
				if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) {
					throw new Error("Expected durable Worker event envelope");
				}
				const category = entry.customType as keyof typeof EVENT_CATALOG;
				const catalogEntry = EVENT_CATALOG[category];
				const eventCorrelation = "correlation" in entry.data ? entry.data.correlation : undefined;
				if (
					catalogEntry === undefined || eventCorrelation === null || typeof eventCorrelation !== "object" ||
					Array.isArray(eventCorrelation)
				) {
					throw new Error("Expected catalogued Worker event correlation");
				}
				const allowedFields: readonly string[] = catalogEntry.correlationFields;
				expect(Object.keys(eventCorrelation).every((key) => allowedFields.includes(key))).toBe(true);
				if (category === "worker_receipt.written") {
					expect(Object.keys(eventCorrelation).sort()).toEqual([
						"operationId",
						"sessionId",
						"taskId",
						"workerReceiptId",
					]);
				}
			}
			expect(JSON.stringify(durableWorkerEvents)).toContain('"status":"completed"');
			expect(JSON.stringify(durableWorkerEvents)).not.toContain("agentInstanceId");
		} finally {
			await created.operationToolGateway.dispose();
			await controlPlane.dispose();
			await created.harness.close();
			await env.cleanup();
		}

		const defaultSession = new Session(new InMemorySessionStorage({ id: "session-default", createdAt: 1 }));
		const defaultEnv = new NodeExecutionEnv({ cwd: process.cwd() });
		const defaults = await createCodingAgentHarness({
			session: defaultSession,
			models,
			model: getModel("google", "gemini-2.5-flash"),
			env: defaultEnv,
		});
		try {
			expect("operationToolGateway" in defaults).toBe(false);
		} finally {
			await defaults.harness.close();
			await defaultEnv.cleanup();
		}
	});

	it("keeps the default inline/Host path free of Worker construction", async () => {
		let created = 0;
		const current = provider(undefined, { onCreate: () => { created += 1; } });
		const request = operation("operation-default");
		expect(await current.start(request, { correlation: correlation(request.operationId) })).toMatchObject({
			ok: false,
			error: { code: "worker_unavailable" },
		});
		expect(created).toBe(0);
	});

	it("spawns the independent real-sandbox child for filesystem and process operations", assertIndependentRealSandboxChild, 60_000);
});
