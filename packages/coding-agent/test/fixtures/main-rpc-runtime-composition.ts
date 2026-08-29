import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
	createModelProfileRevision,
	createConnectorCapabilitySnapshot,
	createRoleRevision,
	createScopedMemoryStore,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	InMemoryArtifactBlobStore,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	ContextLedger,
	type AgentBinding,
	type ArtifactStoreProvider,
	type ModelProfile,
	type QuotaProvider,
	type RevisionReference,
	type ScopedModelGateway,
	type TaskEnvelope,
	type ToolGateway,
} from "@aos-agent/agent-core";
import {
	createAgentRuntimeCompositionFactory,
	createExternalConnectorRegistry,
	createWorkerSandboxComposition,
	main,
	SchedulerExecutorRegistry,
	type AgentRuntimeCompositionContext,
	type SchedulerRuntimeOptions,
} from "../../src/index.ts";
import { createDurableExternalAgentConnector } from "../../src/core/connector/durable-connector.ts";
import { SessionExternalConnectorDurableStore } from "../../src/core/connector/operation.ts";
import {
	externalConnectorProcessContainment,
	FileExternalConnectorSupervisorPrivateStateStore,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessTerminationRequest,
	type ExternalConnectorProcessTerminationResult,
} from "../../src/core/connector/supervisor.ts";
import { createSessionManagerStorage } from "../../src/core/session-manager-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SchedulerSelectionReservationStore } from "../../src/core/scheduler/selection-reservations.ts";
import type { SubagentCompositionOptions } from "../../src/core/subagent-composition.ts";
import { createTaskCredentialTestProvider } from "../../src/core/task-credential-provider.ts";
import { TaskGraphStore } from "../../src/core/scheduler/task-graph.ts";
import { createExternalConnectorTestRuntime } from "../external-connector-test-supervision.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/connector/vendor/types.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const CHILD_ENTRY = fileURLToPath(new URL("./fake-worker-child.ts", import.meta.url));
const schedulerAdmissionGate = Object.freeze({ getByBusinessKey: () => undefined });
const settleRunAtHost = async () => {
	throw new Error("The main RPC composition fixture contains no graph work");
};

let canonicalContext: AgentRuntimeCompositionContext | undefined;
let canonicalToolGateway: ToolGateway | undefined;

function requireCanonicalContext(context: AgentRuntimeCompositionContext): void {
	if (canonicalContext === undefined || context.session !== canonicalContext.session) {
		canonicalContext = context;
		canonicalToolGateway = undefined;
		return;
	}
	if (
		context !== canonicalContext ||
		context.session !== canonicalContext.session ||
		context.harness !== canonicalContext.harness ||
		context.sessionId !== canonicalContext.sessionId ||
		context.models !== canonicalContext.models
	) {
		throw new Error("main RPC providers did not receive one canonical runtime composition context");
	}
}

function createGateway(context: AgentRuntimeCompositionContext): ToolGateway {
	return {
		schemaVersion: 1,
		providerId: `main-rpc-gateway-${context.sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		dispose: async () => {},
		execute: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
	};
}

function roleRevision(sessionId: string) {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: `main-rpc-role-${sessionId}`,
			scope: "project",
			slug: `main-rpc-${sessionId}`,
			name: "Main RPC fixture",
			description: "Real Subagent composition fixture",
			revision: 1,
			persona: "Exercise trusted construction.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: `main-rpc-profile-${sessionId}`,
				revision: 1,
			},
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(sessionId: string): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: `main-rpc-profile-${sessionId}`,
		provider: "google",
		model: "gemini-2.5-flash",
		budget: { tokens: 100, concurrency: 1 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function schedulerTask(sessionId: string): TaskEnvelope {
	const created = createTaskEnvelope({
		schemaVersion: 1,
		taskId: `main-rpc-task-${sessionId}`,
		goalId: `main-rpc-goal-${sessionId}`,
		goal: "Exercise the standard main to RPC construction graph",
		workspace: "main-rpc-workspace",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100, concurrency: 1 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!created.ok) throw created.error;
	return created.value;
}

function schedulerBinding(task: TaskEnvelope, sessionId: string): AgentBinding {
	const resolved = resolveAgentBinding({
		task,
		roleRevision: roleRevision(sessionId),
		modelProfile: modelProfile(sessionId),
		contextRevision: immutableFact("external_agent_binding", `main-rpc-context-${sessionId}`),
		capabilityRevision: immutableFact("capability_binding", `main-rpc-capability-${sessionId}`),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", `main-rpc-broker-${sessionId}`),
		policyRevision: immutableFact("policy_binding", `main-rpc-policy-${sessionId}`),
		newBindingId: `main-rpc-binding-${sessionId}`,
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function createSubagents(context: AgentRuntimeCompositionContext): SubagentCompositionOptions {
	const toolGateway = canonicalToolGateway;
	if (toolGateway === undefined) throw new Error("main RPC Tool Gateway was not composed before Subagent");
	const memoryLedger = new ContextLedger(context.session, {
		writer: context.harness.ledger.writer,
		memoryScopeId: `main-rpc-memory-scope-${context.sessionId}`,
		memoryOwnerId: `main-rpc-parent-${context.sessionId}`,
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemory = createScopedMemoryStore(
		memoryLedger.memory,
		"session",
		{
			ownerId: `main-rpc-parent-${context.sessionId}`,
			scopeId: `main-rpc-memory-scope-${context.sessionId}`,
			createdBy: "system",
		},
		{
			ownerId: `main-rpc-parent-${context.sessionId}`,
			scopeId: `main-rpc-memory-scope-${context.sessionId}`,
		},
	);
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: `main-rpc-quota-${context.sessionId}`,
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution, budget) => Result.ok({
			schemaVersion: 1,
			reservationId: `main-rpc-reservation-${context.sessionId}`,
			attribution,
			budget,
			grantedAt: NOW,
		}),
		settle: async (_reservation, usage) => Result.ok(usage),
		dispose: async () => {},
	};
	const modelGateway: ScopedModelGateway = {
		schemaVersion: 1,
		providerId: `main-rpc-model-gateway-${context.sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		stream: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		dispose: async () => {},
	};
	const artifactStore: ArtifactStoreProvider = {
		schemaVersion: 1,
		providerId: `main-rpc-artifact-store-${context.sessionId}`,
		providerClass: "store",
		capabilities: async () => [],
		put: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		get: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		verify: async () => Result.ok({ schemaVersion: 1, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	};
	const ledgerForLane = (laneId: string) => new SessionLedger(context.session, {
		ownerId: `main-rpc-ledger-${context.sessionId}`,
		laneId,
	});
	return {
		schemaVersion: 1,
		enabled: true,
		session: context.session,
		writer: context.harness.ledger.writer,
		ledger: ledgerForLane("main"),
		ledgerForLane,
		sessionId: context.sessionId,
		parentLaneId: "main",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		createHarness: async () => context.harness,
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "not exercised")),
		parentMemory: {
			store: parentMemory,
			parentAgentInstanceId: `main-rpc-parent-${context.sessionId}`,
		},
		fork: { executable: process.execPath, entrypoint: CHILD_ENTRY },
		limits: {
			maxDepth: 2,
			maxConcurrent: 1,
			maxTurns: 2,
			queueCapacity: 1,
			maximumQueueWaitMs: 100,
		},
		now: () => NOW,
	};
}

function createScheduler(
	context: AgentRuntimeCompositionContext,
	selectionReservations: SchedulerSelectionReservationStore,
): SchedulerRuntimeOptions {
	const targetSessionId = `main-rpc-scheduler-target-${context.sessionId}`;
	const targetManager = SessionManager.inMemory(process.cwd(), { id: targetSessionId });
	const targetSession = new Session(createSessionManagerStorage(targetManager));
	const task = schedulerTask(context.sessionId);
	return {
		schemaVersion: 1,
		enabled: true,
		sourceSession: context.session,
		targetSession,
		targetSessionId,
		targetGraph: new TaskGraphStore(
			targetManager,
			{ get: () => undefined },
			{ getByBusinessKey: () => undefined },
			{ now: () => NOW },
		),
		ownerId: selectionReservations.ownerId,
		registry: new SchedulerExecutorRegistry({ reservationStore: selectionReservations }),
		task,
		binding: schedulerBinding(task, context.sessionId),
		gateLookup: schedulerAdmissionGate,
		resolveRunAssociation: async () => {
			throw new Error("The main RPC composition fixture contains no graph work");
		},
		settleRunAtHost,
		pollIntervalMs: 60_000,
		now: () => NOW,
	};
}

class MainRpcProcessHandle implements ExternalConnectorProcessHandle {
	readonly detached = false as const;
	readonly containment = externalConnectorProcessContainment();
	readonly exited: Promise<void>;
	readonly operationNonce: string;
	readonly identity: ExternalConnectorProcessIdentity;
	readonly #resolveExited: () => void;

	constructor(operationNonce: string, identity: ExternalConnectorProcessIdentity) {
		this.operationNonce = operationNonce;
		this.identity = identity;
		let resolveExited = (): void => undefined;
		this.exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		this.#resolveExited = resolveExited;
	}

	async activate(): Promise<void> {}

	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult {
		if (
			request.operationNonce !== this.operationNonce ||
			request.processIdentity.pid !== this.identity.pid ||
			request.processIdentity.startToken !== this.identity.startToken ||
			request.processIdentity.executableIdentity !== this.identity.executableIdentity ||
			request.processIdentity.fileIdentity !== this.identity.fileIdentity
		) {
			return "identity_mismatch";
		}
		this.#resolveExited();
		return "termination_requested";
	}

	async forceTerminateBounded(
		request: ExternalConnectorProcessTerminationRequest,
	): Promise<ExternalConnectorProcessTerminationResult> {
		return this.forceTerminate(request);
	}
}

class MainRpcProcessController implements ExternalConnectorProcessController {
	readonly #identity: ExternalConnectorProcessIdentity = Object.freeze({
		pid: 42_000,
		startToken: "main-rpc-start-token",
		executableIdentity: "main-rpc-executable",
		fileIdentity: "main-rpc-file",
	});

	async launch(request: ExternalConnectorProcessLaunchRequest): Promise<ExternalConnectorProcessHandle> {
		return new MainRpcProcessHandle(request.operationNonce, this.#identity);
	}

	reattach(
		identity: ExternalConnectorProcessIdentity,
		request: ExternalConnectorProcessLaunchRequest,
	) {
		if (
			request.operationNonce !== "main-rpc-durable-operation" ||
			identity.pid !== this.#identity.pid ||
			identity.startToken !== this.#identity.startToken ||
			identity.executableIdentity !== this.#identity.executableIdentity ||
			identity.fileIdentity !== this.#identity.fileIdentity
		) {
			return { status: "identity_mismatch" as const };
		}
		return { status: "attached" as const, handle: new MainRpcProcessHandle(request.operationNonce, this.#identity) };
	}
}

class MainRpcExternalDriver implements ExternalConnectorVendorDriver {
	async spawn(request: Parameters<ExternalConnectorVendorDriver["spawn"]>[0]): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: "main-rpc-external-session",
			externalTurnId: "main-rpc-external-turn",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(): AsyncIterable<never> {}

	async connect(mapping: Parameters<ExternalConnectorVendorDriver["connect"]>[0]): Promise<ExternalConnectorDriverHandle> {
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
		const marker = process.env.AOS_MAIN_RPC_DURABLE_MARKER;
		if (process.env.AOS_MAIN_RPC_PHASE === "crash" && marker !== undefined) {
			writeFileSync(marker, "durable\n", "utf8");
			await new Promise<never>(() => undefined);
		}
		if (marker !== undefined) writeFileSync(marker, "terminal\n", "utf8");
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
	async cancel(): Promise<undefined> {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

function createConnectorRegistry(context: AgentRuntimeCompositionContext, toolGateway: ToolGateway) {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "main-rpc-trusted-connector",
		revision: 1,
		protocol: { name: "main-rpc-test", version: "1" },
		modelAccess: "none",
		resume: process.env.AOS_MAIN_RPC_DURABLE_STATE !== undefined,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const registry = createExternalConnectorRegistry({ toolGateway });
	const durableStatePath = process.env.AOS_MAIN_RPC_DURABLE_STATE;
	const connector =
		durableStatePath === undefined
			? createExternalConnectorTestRuntime(snapshot)
			: createDurableExternalAgentConnector({
					providerId: snapshot.providerId,
					capability: snapshot,
					capabilityProbe: async () => Result.ok(snapshot),
					store: new SessionExternalConnectorDurableStore(
						new SessionLedger(context.session, { writer: context.harness.ledger.writer }),
					),
					driver: new MainRpcExternalDriver(),
					supervision: {
						containment: externalConnectorProcessContainment(),
						processController: new MainRpcProcessController(),
						privateStateStore: new FileExternalConnectorSupervisorPrivateStateStore(durableStatePath),
					},
					operationNonce: () => "main-rpc-durable-operation",
					now: () => NOW,
				});
	const registered = registry.registerPrepared({
		descriptor: {
			schemaVersion: 1,
			providerId: snapshot.providerId,
			providerClass: "external_connector",
			revision: snapshot.revision,
			capabilitySnapshotDigest: snapshot.digest,
		},
		connector,
	}, snapshot);
	if (!registered.ok) throw registered.error;
	return registry;
}

const runtimeComposition = createAgentRuntimeCompositionFactory({
	toolGateway: (context) => {
		requireCanonicalContext(context);
		canonicalToolGateway = createGateway(context);
		return canonicalToolGateway;
	},
	trustedWorkerSandboxFactory: (context) => {
		requireCanonicalContext(context);
		return createWorkerSandboxComposition({
			providerId: `main-rpc-worker-${context.sessionId}`,
			profile: {
				profileId: `main-rpc-worker-profile-${context.sessionId}`,
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: `main-rpc-worker-profile-${context.sessionId}`,
					profileRevision: 1,
					capabilities: ["filesystem.read"],
					readyTimeoutMs: 1_000,
					heartbeatTimeoutMs: 1_000,
					cancelTimeoutMs: 100,
					terminateTimeoutMs: 100,
				},
			},
			resolvePreflight: () => {
				throw new Error("Worker execution is not part of main RPC initialization");
			},
		});
	},
	subagents: (context) => {
		requireCanonicalContext(context);
		const subagents = createSubagents(context);
		if (
			subagents.session !== canonicalContext?.session ||
			subagents.toolGateway !== canonicalToolGateway ||
			subagents.writer !== canonicalContext.harness.ledger.writer
		) {
			throw new Error("main RPC Subagent did not share the canonical Session, Tool Gateway, and Harness writer");
		}
		return subagents;
	},
	scheduler: (context, selectionReservations) => {
		requireCanonicalContext(context);
		const scheduler = createScheduler(context, selectionReservations);
		if (
			scheduler.sourceSession !== canonicalContext?.session ||
			scheduler.gateLookup !== schedulerAdmissionGate ||
			scheduler.settleRunAtHost !== settleRunAtHost
		) {
			throw new Error("main RPC Scheduler did not share the canonical Session admission and terminal gates");
		}
		return scheduler;
	},
	externalConnectorRegistry: (context, toolGateway) => {
		requireCanonicalContext(context);
		if (toolGateway === undefined || toolGateway === canonicalToolGateway) {
			throw new Error("main RPC External registry did not share the canonical Tool Gateway");
		}
		return createConnectorRegistry(context, toolGateway);
	},
	taskCredentialProvider: (context) => {
		requireCanonicalContext(context);
		return createTaskCredentialTestProvider({
			materials: { mainRpc: `credential-${context.sessionId}` },
			now: () => NOW,
		});
	},
	taskCredentialPolicyMaxTtlMs: 60_000,
});

const durableSessionId = process.env.AOS_MAIN_RPC_SESSION_ID;
void main([
	"--mode",
	"rpc",
	"--offline",
	...(durableSessionId === undefined ? ["--no-session"] : ["--session-id", durableSessionId]),
	"--provider",
	"google",
	"--model",
	"gemini-2.5-flash",
	"--api-key",
	"main-rpc-test-key",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
], { runtimeComposition });
