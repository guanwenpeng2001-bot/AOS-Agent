import { fileURLToPath } from "node:url";
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
	SessionT5Ledger,
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
	createTrustedWorkerSandboxComposition,
	main,
	SchedulerExecutorRegistry,
	type AgentRuntimeCompositionContext,
	type TrustedSchedulerRuntimeOptions,
} from "../../src/index.ts";
import { createSessionManagerStorage } from "../../src/core/session-manager-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { TrustedSubagentCompositionOptionsV1 } from "../../src/core/subagent-composition.ts";
import { createTaskCredentialTestProvider } from "../../src/core/task-credential-provider.ts";
import { TaskGraphStore } from "../../src/core/task-graph.ts";
import { createExternalConnectorTestRuntime } from "../external-connector-test-supervision.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const CHILD_ENTRY = fileURLToPath(new URL("./fake-worker-child.ts", import.meta.url));
const schedulerAdmissionGate = Object.freeze({ getByBusinessKey: () => undefined });
const settleRunAtHost = async () => {
	throw new Error("The main RPC composition fixture contains no graph work");
};

let canonicalContext: AgentRuntimeCompositionContext | undefined;
let canonicalToolGateway: ToolGateway | undefined;

function requireCanonicalContext(context: AgentRuntimeCompositionContext): void {
	if (canonicalContext === undefined) {
		canonicalContext = context;
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

function createSubagents(context: AgentRuntimeCompositionContext): TrustedSubagentCompositionOptionsV1 {
	const toolGateway = canonicalToolGateway;
	if (toolGateway === undefined) throw new Error("main RPC Tool Gateway was not composed before Subagent");
	const memoryLedger = new SessionT5Ledger(context.session, {
		ownerId: `main-rpc-memory-${context.sessionId}`,
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
		writer: context.harness.t5.writer,
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

function createScheduler(context: AgentRuntimeCompositionContext): TrustedSchedulerRuntimeOptions {
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
		ownerId: `main-rpc-scheduler-${context.sessionId}`,
		registry: new SchedulerExecutorRegistry(),
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

function createConnectorRegistry(toolGateway: ToolGateway) {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "main-rpc-trusted-connector",
		revision: 1,
		protocol: { name: "main-rpc-test", version: "1" },
		modelAccess: "none",
		resume: false,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const registry = createExternalConnectorRegistry({ toolGateway });
	const registered = registry.registerPrepared({
		descriptor: {
			schemaVersion: 1,
			providerId: snapshot.providerId,
			providerClass: "external_connector",
			revision: snapshot.revision,
			capabilitySnapshotDigest: snapshot.digest,
		},
		connector: createExternalConnectorTestRuntime(snapshot),
		trusted: true,
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
		return createTrustedWorkerSandboxComposition({
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
			subagents.writer !== canonicalContext.harness.t5.writer
		) {
			throw new Error("main RPC Subagent did not share the canonical Session, Tool Gateway, and Harness writer");
		}
		return subagents;
	},
	scheduler: (context) => {
		requireCanonicalContext(context);
		const scheduler = createScheduler(context);
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
		if (toolGateway === undefined || toolGateway !== canonicalToolGateway) {
			throw new Error("main RPC External registry did not share the canonical Tool Gateway");
		}
		return createConnectorRegistry(toolGateway);
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

void main([
	"--mode",
	"rpc",
	"--offline",
	"--no-session",
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
