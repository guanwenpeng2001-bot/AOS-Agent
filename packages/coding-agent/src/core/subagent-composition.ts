import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	createExecutionCorrelation,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	LayeredResultSettlement,
	persistTaskEnvelopeBeforeResolver,
	projectMcpSelectionToSelector,
	Result,
	ROLE_RESOLUTION_ORDER,
	SessionLedger,
	SessionLedgerWriter,
	type AgentHarness,
	type AttemptReceipt,
	type ArtifactStoreProvider,
	type ChildAgentProvider,
	type ChildSpawnResult,
	type QuotaProvider,
	type RoleRegistry,
	type ResultValue,
	type ScopedMemoryStore,
	type ScopedModelGateway,
	type Session,
	type SettleTaskResultInput,
	type TaskExecutorProvider,
	type TaskEnvelope,
	type TaskResult,
	type ModelProfile,
	type ToolGateway,
	validateAgentInstance,
	validateBindingEpoch,
	validateDispatch,
} from "@aos-agent/agent-core";
import {
	SubagentContextIngress,
	renderSubagentNextTurnContext,
	type SafeSubagentNextTurnContext,
} from "./subagent-context-ingress.ts";
import { ForkChildAgentProvider } from "./subagent-fork-provider.ts";
import type { LoadParentContext } from "./subagent-provider-context.ts";
import {
	InProcessChildAgentProvider,
	type ChildAgentHarnessCreateInput,
} from "./subagent-inprocess-provider.ts";
import {
	SubagentMailbox,
	type ChildMailboxEndpoint,
	type ChildMailboxMessage,
	type ConsumeChildMailboxInput,
} from "./subagent-mailbox.ts";
import {
	persistChildBindingProjection,
	projectChildBinding,
	type McpInheritanceApprovalAuthority,
} from "./subagent-binding.ts";
import { cleanupChildMemoryScope, createChildMemoryScope } from "./subagent-memory.ts";
import {
	FORK_PROVIDER,
	IN_PROCESS_PROVIDER,
	SubagentProviderRegistry,
	type ExecutableSubagentProvider,
	type SubagentProviderDescriptor,
	type SubagentProviderKind,
} from "./subagent-registry.ts";
import {
	projectSafeChildResult,
	settleChildTaskResult,
	type ChildTaskSettlementPolicy,
	type SafeChildResultProjection,
} from "./subagent-result.ts";
import { SubagentSupervisor, type PlanSubagentSpawnInput, type SubagentSpawnPlan } from "./subagent-supervisor.ts";
import {
	applyChildWorktree,
	cleanupChildWorktree,
	createChildWorktree,
	readChildWorktreeRecord,
	type ChildWorktreeIdentity,
	type ChildWorktreeRecord,
	type WorktreeAdapter,
} from "./subagent-worktree.ts";
import type { ChildAgentRecord, ChildLifecycleStatus } from "./subagent.ts";
import type { RunSubagentLifecycleHooks } from "./run-lifecycle.ts";
import type {
	PromptTaskCompositionRootOptions,
	PromptTaskSubagentCompositionInput,
	PromptTaskSubagentSpawnInput,
	PromptTaskSubagentSpawnResult,
} from "./prompt-task-adapter.ts";
import type {
	SchedulerNativeAgentBridge,
	SchedulerNativeAgentResolution,
	SchedulerNativeAgentResolveInput,
	SchedulerNativeAgentRevalidateInput,
} from "./scheduler/dispatch.ts";

type ExecutableChildProviderV1 = ChildAgentProvider & TaskExecutorProvider & {
	close(attemptId: string): Promise<ResultValue<void, FoundationError>>;
};

/** Trusted Host planner that bridges Scheduler selection into the Native Subagent owner. */
export interface SchedulerNativeAgentPlanner {
	readonly schemaVersion: 1;
	plan(
		input: SchedulerNativeAgentResolveInput,
		descriptor: SubagentProviderDescriptor,
	): Promise<ResultValue<PlanSubagentSpawnInput, FoundationError>>;
}

/** Trusted product-only lane projection over the canonical parent writer lease. */
class ChildLaneSessionLedgerWriterV1 extends SessionLedgerWriter {
	private readonly parent: SessionLedgerWriter;

	constructor(parent: SessionLedgerWriter, childLaneId: string) {
		super(parent.session, { lane: childLaneId });
		this.parent = parent;
	}

	override ensureLease(refresh = false) {
		return this.parent.ensureLease(refresh);
	}

	override async releaseLease(): Promise<void> {}
}

/** Host-owned Subagent inputs bound to canonical Session authorities. */
export interface SubagentCompositionOptions {
	readonly schemaVersion: 1;
	readonly enabled: true;
	readonly session: Session;
	readonly writer?: SessionLedgerWriter;
	readonly ledger: SessionLedger;
	readonly ledgerForLane: (laneId: string) => SessionLedger;
	readonly sessionId: string;
	readonly parentLaneId: string;
	readonly quota: QuotaProvider;
	readonly modelGateway: ScopedModelGateway;
	readonly toolGateway: ToolGateway;
	readonly artifactStore: ArtifactStoreProvider;
	readonly createHarness: (input: ChildAgentHarnessCreateInput) => Promise<AgentHarness>;
	readonly loadParentContext: LoadParentContext;
	readonly parentMemory: { readonly store: ScopedMemoryStore; readonly parentAgentInstanceId: string };
	readonly parentMemoryForAgent?: (
		parentAgentInstanceId: string,
	) => { readonly store: ScopedMemoryStore; readonly parentAgentInstanceId: string };
	/** Effective Host PolicyBinding plus canonical durable approval ledger for non-empty MCP inheritance. */
	readonly mcpInheritanceAuthority?: McpInheritanceApprovalAuthority;
	/** Explicit trusted Host opt-in for isolated in-process child execution. */
	readonly worktree?: {
		readonly schemaVersion: 1;
		readonly enabled: true;
		readonly baseRef: string;
		readonly adapter: WorktreeAdapter & {
			resolveExecutionWorkspace(
				identity: ChildWorktreeIdentity,
			): Promise<ResultValue<string, FoundationError>>;
		};
	};
	readonly fork: {
		readonly executable: string;
		readonly entrypoint: string;
		readonly environment?: Readonly<Record<string, string>>;
	};
	readonly parentEndpoints?: readonly ChildMailboxEndpoint[];
	/** Product prompt spawning remains unavailable unless this trusted Host policy is supplied. */
	readonly productPrompt?: {
		readonly registry: Pick<RoleRegistry, "get" | "search" | "resolve">;
		readonly scope: "global" | "project";
		readonly providerId: string;
		readonly forkScope: "none" | "all" | "recent_n" | "task_package";
		readonly recentN?: number;
		readonly taskPackageRef?: string;
		readonly mailboxRequired: boolean;
		readonly resumeRequired: boolean;
		readonly worktreeRequired: boolean;
		readonly backgroundRequired: boolean;
		/** Fixed trusted Host composition; mode and join cannot come from prompt, RPC, or project text. */
		readonly composition?: ProductPromptCompositionPolicy;
		readonly childModelProfile?: (
			roleId: string,
			parentModelProfile: ModelProfile,
		) => ModelProfile | Promise<ModelProfile>;
	};
	readonly limits: {
		readonly maxDepth: number;
		readonly maxConcurrent: number;
		readonly maxTurns: number;
		readonly queueCapacity: number;
		readonly maximumQueueWaitMs: number;
	};
	readonly now?: () => string;
	readonly onReady?: (composition: SubagentComposition) => void;
}

export interface SafeSubagentLifecycleProjection {
	readonly schemaVersion: 1;
	readonly source: "subagent.lifecycle";
	readonly sessionId: string;
	readonly runId: string;
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly taskId: string;
	readonly status: ChildLifecycleStatus;
	readonly providerKind: SubagentProviderKind;
	readonly safeSummary: string;
	readonly correlation: {
		readonly attemptId: string;
		readonly spawnId: string;
	};
	readonly digest: ReturnType<typeof fingerprintFoundationValue>;
}

export interface ExecuteTrustedSubagentPlanInput {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly plan: SubagentSpawnPlan;
	readonly signal?: AbortSignal;
}

export interface SubagentExecution {
	readonly spawn: ChildSpawnResult;
	readonly receipt: Awaited<ReturnType<LayeredResultSettlement["executeDispatch"]>> extends ResultValue<infer TValue, FoundationError>
		? TValue
		: never;
}

export interface ResumeTrustedSubagentInput {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly childAgentInstanceId: string;
	readonly expectedTurnCount?: number;
	readonly additionalTurns?: number;
	readonly signal?: AbortSignal;
}

export interface SubagentResume {
	readonly lifecycle: SafeSubagentLifecycleProjection;
	readonly receipt: AttemptReceipt;
}

export type SubagentChainStep =
	| {
			readonly input: "root" | "task_package";
			readonly plan: SubagentSpawnPlan;
	  }
	| {
			readonly input: "safe_projection";
			createPlan(
				projection: SafeChildResultProjection,
			): SubagentSpawnPlan | Promise<SubagentSpawnPlan>;
	  };

export interface ExecuteSubagentCompositionInput {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly mode: "parallel" | "chain";
	readonly steps: readonly SubagentChainStep[];
	readonly join: ChildTaskSettlementPolicy;
	readonly taskResultId: string;
	readonly task: TaskEnvelope;
	readonly summary: string;
	readonly artifacts?: SettleTaskResultInput["artifacts"];
	readonly diff?: SettleTaskResultInput["diff"];
	readonly tests: SettleTaskResultInput["tests"];
	readonly evidence: SettleTaskResultInput["evidence"];
	readonly signal?: AbortSignal;
}

export interface SubagentCompositionExecution {
	readonly executions: readonly SubagentExecution[];
	readonly projections: readonly SafeChildResultProjection[];
	readonly taskResult: TaskResult;
	/** Exact unique AttemptReceipt ids accepted by the configured Host join. */
	readonly attemptReceiptIds: readonly string[];
}

export type ProductPromptCompositionPreparation = Omit<
	ExecuteSubagentCompositionInput,
	"schemaVersion" | "runId" | "mode" | "join" | "signal"
>;

/** Trusted Host policy; prompts, RPC, and project text cannot supply its composition decisions. */
export interface ProductPromptCompositionPolicy {
	readonly schemaVersion: 1;
	readonly mode: "parallel" | "chain";
	readonly join: ChildTaskSettlementPolicy;
	prepare(
		input: PromptTaskSubagentCompositionInput,
	): ProductPromptCompositionPreparation | Promise<ProductPromptCompositionPreparation>;
}

const ACTIVE_STATUSES = new Set<ChildLifecycleStatus>(["spawning", "running", "awaiting_input", "background", "cancelling"]);
const HOST_PARENT_RUN_KEYS = new Set(["schemaVersion", "sessionId", "runId", "toAgentInstanceId", "byAttemptId"]);
const HOST_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isHostParentRunInput(value: unknown): value is {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly runId: string;
	readonly toAgentInstanceId: string;
	readonly byAttemptId: string;
} {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).every((key) => HOST_PARENT_RUN_KEYS.has(key)) &&
		Object.keys(record).length === HOST_PARENT_RUN_KEYS.size &&
		record.schemaVersion === 1 &&
		[record.sessionId, record.runId, record.toAgentInstanceId, record.byAttemptId]
			.every((entry) => typeof entry === "string" && HOST_IDENTIFIER_PATTERN.test(entry));
}

function providerForKind(
	providers: ReadonlyMap<SubagentProviderKind, ExecutableChildProviderV1>,
	kind: SubagentProviderKind,
): ExecutableChildProviderV1 {
	const provider = providers.get(kind);
	if (provider === undefined) throw new FoundationError("subagent_provider_unavailable", `Trusted provider ${kind} is unavailable`);
	return provider;
}

/** Trusted Host composition for Child Agent planning, execution, settlement, and recovery. */
export class SubagentComposition {
	readonly services = Object.freeze({
		projectSafeChildResult,
		createChildWorktree,
		applyChildWorktree,
		cleanupChildWorktree,
		createChildMemoryScope,
		cleanupChildMemoryScope,
	});
	private readonly sessionId: string;
	private readonly session: Session;
	private readonly ledger: SessionLedger;
	private readonly ledgerForLane: (laneId: string) => SessionLedger;
	private readonly parentLaneId: string;
	private readonly artifactStore: ArtifactStoreProvider;
	private readonly worktree: SubagentCompositionOptions["worktree"];
	private readonly writer: SessionLedgerWriter | undefined;
	private readonly productPrompt: SubagentCompositionOptions["productPrompt"];
	private readonly mcpInheritanceAuthority: McpInheritanceApprovalAuthority | undefined;
	private readonly productPromptComposition: ProductPromptCompositionPolicy | undefined;
	private readonly now: () => string;
	private readonly registry: SubagentProviderRegistry;
	private readonly supervisor: SubagentSupervisor;
	private readonly mailbox: SubagentMailbox;
	private readonly mailboxIngress: SubagentContextIngress;
	private readonly laneWriters = new Map<string, SessionLedgerWriter>();
	private readonly laneLedgers = new Map<string, SessionLedger>();
	private readonly laneSettlements = new Map<string, LayeredResultSettlement>();
	private readonly providers: ReadonlyMap<SubagentProviderKind, ExecutableChildProviderV1>;
	private readonly runByChild = new Map<string, string>();
	private readonly executionWorkspaces = new Map<string, string>();
	private readonly worktreeRecords = new Map<string, ChildWorktreeRecord>();
	private readonly planByChild = new Map<string, SubagentSpawnPlan>();
	private readonly schedulerPlanByAttempt = new Map<string, SubagentSpawnPlan>();
	private readonly parentByRun = new Map<string, { readonly toAgentInstanceId: string; readonly byAttemptId: string }>();
	private recovery: Promise<ResultValue<void, FoundationError>>;
	private disposed = false;

	constructor(options: SubagentCompositionOptions) {
		if (options.schemaVersion !== 1 || options.enabled !== true) {
			throw new FoundationError("subagent_spawn_invalid", "Subagents require an explicit trusted Host opt-in");
		}
		if (options.productPrompt !== undefined && options.writer === undefined) {
			throw new FoundationError("subagent_persistence_failed", "Product prompt Child Agents require the canonical parent SessionLedgerWriter");
		}
		if (
			options.worktree !== undefined &&
			(options.worktree.schemaVersion !== 1 ||
				options.worktree.enabled !== true ||
				typeof options.worktree.baseRef !== "string" ||
				options.worktree.baseRef.length === 0 ||
				typeof options.worktree.adapter.resolveExecutionWorkspace !== "function")
		) {
			throw new FoundationError("subagent_spawn_invalid", "Trusted Child Agent worktree configuration is invalid");
		}
		this.sessionId = options.sessionId;
		this.session = options.session;
		this.ledger = options.ledger;
		this.parentLaneId = options.parentLaneId;
		this.artifactStore = options.artifactStore;
		this.worktree = options.worktree;
		this.writer = options.writer;
		if (this.writer !== undefined) {
			this.laneWriters.set(this.parentLaneId, this.writer);
			this.laneLedgers.set(this.parentLaneId, this.ledger);
		}
		this.ledgerForLane = this.writer === undefined
			? options.ledgerForLane
			: (laneId) => {
				const existing = this.laneLedgers.get(laneId);
				if (existing !== undefined) return existing;
				const ledger = new SessionLedger(this.session, { writer: this.writerForLane(laneId) });
				this.laneLedgers.set(laneId, ledger);
				return ledger;
			};
		this.productPrompt = options.productPrompt;
		this.mcpInheritanceAuthority = options.mcpInheritanceAuthority;
		const productPromptComposition = options.productPrompt?.composition;
		if (
			productPromptComposition !== undefined &&
			(productPromptComposition.schemaVersion !== 1 ||
				(productPromptComposition.mode !== "parallel" && productPromptComposition.mode !== "chain") ||
				typeof productPromptComposition.prepare !== "function")
		) {
			throw new FoundationError("subagent_spawn_invalid", "Trusted product prompt composition policy is invalid");
		}
		this.productPromptComposition = productPromptComposition === undefined
			? undefined
			: Object.freeze({
					schemaVersion: 1,
					mode: productPromptComposition.mode,
					join: cloneDeepFrozen(productPromptComposition.join),
					prepare: productPromptComposition.prepare.bind(productPromptComposition),
				});
		this.now = options.now ?? (() => new Date().toISOString());
		this.registry = new SubagentProviderRegistry();
		this.registry.register({
			...IN_PROCESS_PROVIDER,
			capabilities: {
				...IN_PROCESS_PROVIDER.capabilities,
				worktreeSupported: this.worktree !== undefined,
			},
		});
		this.registry.register({
			...FORK_PROVIDER,
			capabilities: { ...FORK_PROVIDER.capabilities, worktreeSupported: false },
		});
		this.supervisor = new SubagentSupervisor({
			schemaVersion: 1,
			ledger: options.ledger,
			ledgerForLane: this.ledgerForLane,
			sessionId: options.sessionId,
			laneId: options.parentLaneId,
			...options.limits,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		this.mailbox = new SubagentMailbox({
			schemaVersion: 1,
			ledger: options.ledger,
			ledgerForLane: this.ledgerForLane,
			sessionId: options.sessionId,
			laneId: options.parentLaneId,
			roster: () => this.supervisor.roster(),
			...(options.parentEndpoints === undefined ? {} : { endpoints: options.parentEndpoints }),
			maxBodyBytes: 32_768,
			maxPendingPerRecipient: 64,
			maxMessagesPerWindow: 64,
			rateWindowMs: 1_000,
			maxWaitMs: 30_000,
			pollIntervalMs: 25,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		this.mailboxIngress = new SubagentContextIngress({
			schemaVersion: 1,
			mailbox: this.mailbox,
			ledger: options.ledger,
			artifactStore: options.artifactStore,
			sessionId: options.sessionId,
			parentLaneId: options.parentLaneId,
		});
		const loadTurnBoundaryContext = async (input: {
			readonly schemaVersion: 1;
			readonly spawnId: string;
			readonly attemptId: string;
			readonly childAgentInstanceId: string;
		}): Promise<ResultValue<string | undefined, FoundationError>> => {
			const consumed = await this.mailbox.consume({
				schemaVersion: 1,
				sessionId: options.sessionId,
				toAgentInstanceId: input.childAgentInstanceId,
				byAttemptId: input.attemptId,
				limit: 64,
			});
			if (!consumed.ok) return consumed;
			if (consumed.value.length === 0) return Result.ok(undefined);
			return Result.ok(canonicalFoundationJson(consumed.value.map((message) => ({
				messageId: message.messageId,
				fromAgentInstanceId: message.fromAgentInstanceId,
				body: message.body,
			}))));
		};
		const inProcess = new InProcessChildAgentProvider({
			schemaVersion: 1,
			providerId: IN_PROCESS_PROVIDER.descriptor.providerId,
			supervisor: this.supervisor,
			quota: options.quota,
			modelGateway: options.modelGateway,
			toolGateway: options.toolGateway,
			session: options.session,
			ledger: options.ledger,
			createHarness: options.createHarness,
			loadParentContext: options.loadParentContext,
			parentMemory: options.parentMemory,
			...(options.parentMemoryForAgent === undefined ? {} : { resolveParentMemory: options.parentMemoryForAgent }),
			resolveExecutionWorkspace: ({ childAgentInstanceId, attemptId }) =>
				this.executionWorkspaces.get(this.worktreeExecutionKey(childAgentInstanceId, attemptId)),
			loadTurnBoundaryContext,
			...(options.now === undefined ? {} : { now: options.now }),
		});
		const fork = new ForkChildAgentProvider({
			schemaVersion: 1,
			providerId: FORK_PROVIDER.descriptor.providerId,
			supervisor: this.supervisor,
			quota: options.quota,
			ledger: options.ledger,
			executable: options.fork.executable,
			entrypoint: options.fork.entrypoint,
			loadParentContext: options.loadParentContext,
			loadTurnBoundaryContext,
			...(options.fork.environment === undefined ? {} : { environment: options.fork.environment }),
			...(options.now === undefined ? {} : { now: options.now }),
		});
		this.providers = new Map<SubagentProviderKind, ExecutableChildProviderV1>([
			["in_process", inProcess],
			["fork", fork],
		]);
		this.registry.bindExecutable(inProcess);
		this.registry.bindExecutable(fork);
		this.recovery = this.recoverDurableState();
	}

	providerDescriptors(): readonly SubagentProviderDescriptor[] {
		return Object.freeze([this.registry.get(IN_PROCESS_PROVIDER.descriptor.providerId), this.registry.get(FORK_PROVIDER.descriptor.providerId)]);
	}

	/** Exact trusted runtime objects that a Scheduler executor registry may register. */
	schedulerAgentProviders(): readonly TaskExecutorProvider[] {
		return Object.freeze([...this.providers.values()]);
	}

	usesCanonicalWriter(writer: SessionLedgerWriter): boolean {
		return this.writer === writer;
	}

	/** Build the explicit default-off Scheduler bridge over this composition's exact Native runtimes. */
	schedulerNativeAgentBridge(planner: SchedulerNativeAgentPlanner): SchedulerNativeAgentBridge {
		if (planner.schemaVersion !== 1 || typeof planner.plan !== "function") {
			throw new FoundationError("subagent_spawn_invalid", "Trusted Scheduler Native Agent planner is invalid");
		}
		return Object.freeze({
			resolve: (input: SchedulerNativeAgentResolveInput) => this.resolveSchedulerNativeAgent(input, planner),
			revalidate: (input: SchedulerNativeAgentRevalidateInput) =>
				this.revalidateSchedulerNativeAgent(input),
		});
	}

	private async resolveSchedulerNativeAgent(
		input: SchedulerNativeAgentResolveInput,
		planner: SchedulerNativeAgentPlanner,
	): Promise<ResultValue<SchedulerNativeAgentResolution, FoundationError>> {
		if (this.disposed) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Trusted subagent composition is disposed"));
		}
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		let provider: ExecutableSubagentProvider;
		let descriptor: SubagentProviderDescriptor;
		try {
			provider = this.registry.resolveExecutable(input.provider);
			descriptor = this.registry.resolve(provider.providerId);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("subagent_provider_unavailable", "Native Subagent runtime resolution failed"),
			);
		}
		if (
			input.schemaVersion !== 1 ||
			input.sessionId !== this.sessionId ||
			input.provider.providerClass !== "agent" ||
			input.provider.providerId !== descriptor.descriptor.providerId ||
			input.entry.taskId !== input.binding.taskId ||
			input.claim.taskId !== input.entry.taskId ||
			input.claim.queueEntryId !== input.entry.queueEntryId
		) {
			return Result.err(new FoundationError("invalid_correlation", "Scheduler Native Agent request is not canonical"));
		}

		const cached = this.schedulerPlanByAttempt.get(input.attemptId);
		if (cached !== undefined) return this.schedulerResolutionFromPlan(input, cached);
		const durable = await this.loadDurableSchedulerNativeResolution(input);
		if (!durable.ok) return durable;
		if (durable.value !== undefined) return Result.ok(durable.value);
		if (this.supervisor.get(input.agentInstanceId) !== undefined) {
			return Result.err(
				new FoundationError(
					"agent_spawn_recovery_required",
					"Native Subagent control exists without the immutable Scheduler execution facts",
					{ details: { agentInstanceId: input.agentInstanceId, attemptId: input.attemptId } },
				),
			);
		}

		const plannedInput = await planner.plan(input, descriptor);
		if (!plannedInput.ok) return plannedInput;
		if (
			plannedInput.value.schemaVersion !== 1 ||
			plannedInput.value.childAgentInstanceId !== input.agentInstanceId ||
			plannedInput.value.dispatchId !== input.dispatchId ||
			plannedInput.value.attemptId !== input.attemptId ||
			plannedInput.value.bindingEpochId !== input.bindingEpochId ||
			plannedInput.value.activatedByCommandId !== input.activatedByCommandId ||
			plannedInput.value.childLaneId !== input.laneId ||
			plannedInput.value.childBinding.bindingId !== input.binding.bindingId ||
			canonicalFoundationJson(plannedInput.value.childBinding) !== canonicalFoundationJson(input.binding) ||
			canonicalFoundationJson(plannedInput.value.providerDescriptor) !== canonicalFoundationJson(descriptor) ||
			plannedInput.value.request.spawnId !== input.spawnId ||
			plannedInput.value.request.taskEnvelope.taskId !== input.entry.taskId ||
			plannedInput.value.request.roleRevision.roleRevisionId !== input.binding.roleRevision.id ||
			plannedInput.value.request.roleRevision.revision !== input.binding.roleRevision.revision ||
			plannedInput.value.request.modelProfile.modelProfileId !== input.binding.modelProfileRevision.id ||
			plannedInput.value.request.modelProfile.revision !== input.binding.modelProfileRevision.revision ||
			(plannedInput.value.request.parentSpawn?.providerId !== undefined &&
				plannedInput.value.request.parentSpawn.providerId !== input.provider.providerId)
		) {
			return Result.err(
				new FoundationError(
					"subagent_conflict",
					"Trusted Scheduler planner returned a different provider, instance, epoch, or binding",
				),
			);
		}
		const plan = await this.supervisor.planSpawn(plannedInput.value);
		if (!plan.ok) return plan;
		const resolution = this.schedulerResolutionFromPlan(input, plan.value);
		if (!resolution.ok) return resolution;
		this.schedulerPlanByAttempt.set(input.attemptId, plan.value);
		return resolution;
	}

	private async revalidateSchedulerNativeAgent(
		input: SchedulerNativeAgentRevalidateInput,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.disposed) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Trusted subagent composition is disposed"));
		}
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		let provider: ExecutableSubagentProvider;
		try {
			provider = this.registry.resolveExecutable(input.provider);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("subagent_provider_unavailable", "Native Subagent runtime revalidation failed"),
			);
		}
		const resolution = input.resolution;
		const record = this.supervisor.get(resolution.agentInstance.agentInstanceId);
		if (
			input.schemaVersion !== 1 ||
			resolution.providerId !== provider.providerId ||
			resolution.agentInstance.providerId !== provider.providerId ||
			resolution.agentInstance.taskId !== input.binding.taskId ||
			resolution.initialBindingEpoch.agentInstanceId !== resolution.agentInstance.agentInstanceId ||
			resolution.initialBindingEpoch.bindingId !== input.binding.bindingId ||
			resolution.initialBindingEpoch.attemptId !== resolution.correlation.attemptId ||
			resolution.initialBindingEpoch.bindingEpochId !== resolution.correlation.bindingEpochId ||
			record === undefined ||
			record.providerId !== provider.providerId ||
			record.childAgentInstanceId !== resolution.agentInstance.agentInstanceId ||
			record.taskId !== resolution.agentInstance.taskId ||
			record.attemptId !== resolution.initialBindingEpoch.attemptId ||
			record.bindingId !== input.binding.bindingId
		) {
			return Result.err(
				new FoundationError(
					"subagent_conflict",
					"Native Subagent instance or BindingEpoch changed before Scheduler execution",
				),
			);
		}

		const plan = this.schedulerPlanByAttempt.get(resolution.initialBindingEpoch.attemptId);
		if (plan !== undefined && canonicalFoundationJson(plan.childBinding) !== canonicalFoundationJson(input.binding)) {
			return Result.err(new FoundationError("subagent_conflict", "Native Subagent binding changed before execution"));
		}
		if (plan !== undefined && record.status === "spawning") {
			if (
				canonicalFoundationJson(plan.agentInstance) !== canonicalFoundationJson(resolution.agentInstance) ||
				canonicalFoundationJson(plan.initialBindingEpoch) !==
					canonicalFoundationJson(resolution.initialBindingEpoch) ||
				canonicalFoundationJson(plan.dispatch) !== canonicalFoundationJson(resolution.dispatch) ||
				canonicalFoundationJson(plan.correlation) !== canonicalFoundationJson(resolution.correlation)
			) {
				return Result.err(new FoundationError("subagent_conflict", "Native Subagent plan changed before execution"));
			}
			const spawned = await this.supervisor.executeSpawn(
				plan,
				provider,
				this.settlementForLane(plan.childLaneId),
			);
			if (!spawned.ok) return spawned;
			if (!this.schedulerSpawnMatchesResolution(spawned.value, resolution)) {
				return Result.err(new FoundationError("subagent_lost", "Native Subagent spawned a different identity"));
			}
			return Result.ok(undefined);
		}

		if (provider.lookupSpawn === undefined) {
			return Result.err(
				new FoundationError(
					"agent_spawn_recovery_required",
					"Native Subagent provider cannot revalidate a durable Scheduler spawn",
				),
			);
		}
		const found = await provider.lookupSpawn(record.spawnId, input.signal === undefined ? undefined : { signal: input.signal });
		if (!found.ok) return found;
		if (found.value === undefined || !this.schedulerSpawnMatchesResolution(found.value, resolution)) {
			return Result.err(
				new FoundationError(
					"agent_spawn_recovery_required",
					"Native Subagent provider cannot recover the captured Scheduler instance and BindingEpoch",
					{ details: { agentInstanceId: resolution.agentInstance.agentInstanceId } },
				),
			);
		}
		return Result.ok(undefined);
	}

	private schedulerResolutionFromPlan(
		input: SchedulerNativeAgentResolveInput,
		plan: SubagentSpawnPlan,
	): ResultValue<SchedulerNativeAgentResolution, FoundationError> {
		if (
			plan.providerId !== input.provider.providerId ||
			plan.dispatch.dispatchId !== input.dispatchId ||
			plan.dispatch.taskId !== input.entry.taskId ||
			plan.dispatch.bindingId !== input.binding.bindingId ||
			plan.dispatch.taskExecutorProviderId !== input.provider.providerId ||
			plan.dispatch.deadlineAt !== input.entry.deadlineAt ||
			plan.agentInstance.agentInstanceId !== input.agentInstanceId ||
			plan.agentInstance.providerId !== input.provider.providerId ||
			plan.initialBindingEpoch.bindingEpochId !== input.bindingEpochId ||
			plan.initialBindingEpoch.attemptId !== input.attemptId ||
			plan.initialBindingEpoch.agentInstanceId !== input.agentInstanceId ||
			plan.initialBindingEpoch.activatedByCommandId !== input.activatedByCommandId ||
			plan.correlation.sessionId !== input.sessionId ||
			plan.correlation.laneId !== input.laneId ||
			plan.correlation.providerId !== input.provider.providerId
		) {
			return Result.err(
				new FoundationError("subagent_conflict", "Native Subagent plan does not match Scheduler identity"),
			);
		}
		return Result.ok(
			cloneDeepFrozen({
				schemaVersion: 1 as const,
				providerId: plan.providerId,
				dispatch: plan.dispatch,
				agentInstance: plan.agentInstance,
				initialBindingEpoch: plan.initialBindingEpoch,
				correlation: plan.correlation,
			}),
		);
	}

	private async loadDurableSchedulerNativeResolution(
		input: SchedulerNativeAgentResolveInput,
	): Promise<ResultValue<SchedulerNativeAgentResolution | undefined, FoundationError>> {
		const [agentRecord, epochRecord, dispatchRecord] = await Promise.all([
			this.session.getFoundationObject("agent_instance", input.agentInstanceId),
			this.session.getFoundationObject("binding_epoch", input.bindingEpochId),
			this.session.getFoundationObject("dispatch", input.dispatchId),
		]);
		if (agentRecord === undefined && epochRecord === undefined && dispatchRecord === undefined) {
			return Result.ok(undefined);
		}
		if (
			agentRecord?.kind !== "fact" ||
			epochRecord?.kind !== "fact" ||
			dispatchRecord?.kind !== "fact"
		) {
			return Result.err(
				new FoundationError("agent_spawn_recovery_required", "Native Scheduler identity facts are incomplete"),
			);
		}
		const agent = validateAgentInstance(agentRecord.payload);
		const epoch = validateBindingEpoch(epochRecord.payload);
		const dispatch = validateDispatch(dispatchRecord.payload);
		if (!agent.ok || !epoch.ok || !dispatch.ok) {
			return Result.err(new FoundationError("invalid_correlation", "Native Scheduler identity facts are invalid"));
		}
		if (
			agent.value.agentInstanceId !== input.agentInstanceId ||
			agent.value.providerId !== input.provider.providerId ||
			agent.value.taskId !== input.entry.taskId ||
			agent.value.roleRevision.id !== input.binding.roleRevision.id ||
			agent.value.roleRevision.revision !== input.binding.roleRevision.revision ||
			epoch.value.bindingEpochId !== input.bindingEpochId ||
			epoch.value.attemptId !== input.attemptId ||
			epoch.value.agentInstanceId !== input.agentInstanceId ||
			epoch.value.bindingId !== input.binding.bindingId ||
			dispatch.value.dispatchId !== input.dispatchId ||
			dispatch.value.taskId !== input.entry.taskId ||
			dispatch.value.bindingId !== input.binding.bindingId ||
			dispatch.value.taskExecutorProviderId !== input.provider.providerId
		) {
			return Result.err(new FoundationError("subagent_conflict", "Durable Native Scheduler identity is stale"));
		}
		const correlation = createExecutionCorrelation(input.sessionId, input.laneId, {
			revision: 0,
			taskId: input.entry.taskId,
			dispatchId: input.dispatchId,
			attemptId: input.attemptId,
			bindingId: input.binding.bindingId,
			bindingEpochId: input.bindingEpochId,
			agentInstanceId: input.agentInstanceId,
			providerId: input.provider.providerId,
			...(agent.value.lineage.parentId === undefined ? {} : { parentId: agent.value.lineage.parentId }),
			...(agent.value.lineage.ancestorIds === undefined
				? {}
				: { ancestorIds: agent.value.lineage.ancestorIds }),
		});
		return Result.ok({
			schemaVersion: 1,
			providerId: input.provider.providerId,
			dispatch: dispatch.value,
			agentInstance: agent.value,
			initialBindingEpoch: epoch.value,
			correlation,
		});
	}

	private schedulerSpawnMatchesResolution(
		spawn: ChildSpawnResult,
		resolution: SchedulerNativeAgentResolution,
	): boolean {
		return (
			spawn.attempt.attemptId === resolution.initialBindingEpoch.attemptId &&
			spawn.attempt.dispatchId === resolution.dispatch.dispatchId &&
			spawn.attempt.providerId === resolution.providerId &&
			spawn.attempt.agentInstanceId === resolution.agentInstance.agentInstanceId &&
			spawn.agentInstance.agentInstanceId === resolution.agentInstance.agentInstanceId &&
			spawn.agentInstance.providerId === resolution.agentInstance.providerId &&
			spawn.agentInstance.taskId === resolution.agentInstance.taskId &&
			spawn.agentInstance.roleRevision.id === resolution.agentInstance.roleRevision.id &&
			spawn.agentInstance.roleRevision.revision === resolution.agentInstance.roleRevision.revision &&
			canonicalFoundationJson(spawn.agentInstance.lineage) ===
				canonicalFoundationJson(resolution.agentInstance.lineage) &&
			canonicalFoundationJson(spawn.initialBindingEpoch) ===
				canonicalFoundationJson(resolution.initialBindingEpoch)
		);
	}

	productPromptRoles(): PromptTaskCompositionRootOptions["subagentRoles"] {
		if (this.productPrompt === undefined) return undefined;
		return Object.freeze({
			registry: this.productPrompt.registry,
			scope: this.productPrompt.scope,
			parentLaneId: this.parentLaneId,
			spawn: (input: PromptTaskSubagentSpawnInput) => this.spawnProductPromptChild(input),
			...(this.productPromptComposition === undefined ? {} : {
				compose: (input: PromptTaskSubagentCompositionInput) => this.composeProductPromptChildren(input),
			}),
		});
	}

	async reload(): Promise<ResultValue<void, FoundationError>> {
		if (this.disposed) return Result.err(new FoundationError("subagent_provider_unavailable", "Trusted subagent composition is disposed"));
		this.recovery = this.recoverDurableState();
		return this.recovery;
	}

	async planSpawn(input: PlanSubagentSpawnInput) {
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		return this.supervisor.planSpawn(input);
	}

	async executePlan(input: ExecuteTrustedSubagentPlanInput): Promise<ResultValue<SubagentExecution, FoundationError>> {
		if (this.disposed) return Result.err(new FoundationError("subagent_provider_unavailable", "Trusted subagent composition is disposed"));
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		const provider = providerForKind(this.providers, input.plan.providerKind);
		const settlement = this.settlementForLane(input.plan.childLaneId);
		const spawn = await this.supervisor.executeSpawn(input.plan, provider, settlement);
		if (!spawn.ok) return spawn;
		const childAgentInstanceId = input.plan.agentInstance.agentInstanceId;
		this.planByChild.set(childAgentInstanceId, input.plan);
		this.runByChild.set(childAgentInstanceId, input.runId);
		const boundParent = this.bindTrustedParentRun({
			schemaVersion: 1,
			sessionId: this.sessionId,
			runId: input.runId,
			toAgentInstanceId: input.plan.request.parentAgentInstanceId,
			byAttemptId: input.plan.request.parentAttemptId,
		});
		if (!boundParent.ok) {
			await this.convergePostSpawnFailure(childAgentInstanceId, provider);
			return boundParent;
		}
		const preparedWorktree = await this.prepareExecutionWorktree(input.plan);
		if (!preparedWorktree.ok) {
			await this.convergePostSpawnFailure(childAgentInstanceId, provider);
			await this.cleanupExecutionWorktree(input.plan).catch(() => undefined);
			return preparedWorktree;
		}
		const receipt = await settlement.executeDispatch({
			provider,
			dispatch: {
				schemaVersion: 1,
				dispatchId: spawn.value.attempt.dispatchId,
				taskId: spawn.value.attempt.taskId,
				bindingId: spawn.value.attempt.bindingId,
				taskExecutorProviderId: spawn.value.attempt.providerId,
				status: "pending",
				createdAt: spawn.value.attempt.startedAt,
			},
			binding: input.plan.childBinding,
			initialBindingEpoch: spawn.value.initialBindingEpoch,
			agentInstance: spawn.value.agentInstance,
			correlation: input.plan.correlation,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!receipt.ok) {
			await this.convergePostSpawnFailure(childAgentInstanceId, provider);
			return receipt;
		}
		const settled = await this.supervisor.settleReceipt(childAgentInstanceId, receipt.value.receipt);
		if (!settled.ok) {
			await this.convergePostSpawnFailure(childAgentInstanceId, provider);
			return settled;
		}
		if (receipt.value.receipt.status === "succeeded") {
			const applied = await this.applyExecutionWorktree(input.plan);
			if (!applied.ok) {
				await this.cleanupExecutionWorktree(input.plan).catch(() => undefined);
				await this.convergeProductTerminal(childAgentInstanceId, provider);
				return applied;
			}
		}
		return Result.ok(cloneDeepFrozen({ spawn: spawn.value, receipt: receipt.value }));
	}

	async resumeChild(input: ResumeTrustedSubagentInput): Promise<ResultValue<SubagentResume, FoundationError>> {
		if (
			input.schemaVersion !== 1 ||
			typeof input.runId !== "string" ||
			input.runId.length === 0 ||
			typeof input.childAgentInstanceId !== "string" ||
			input.childAgentInstanceId.length === 0 ||
			(input.expectedTurnCount === undefined) !== (input.additionalTurns === undefined) ||
			(input.expectedTurnCount !== undefined && (!Number.isSafeInteger(input.expectedTurnCount) || input.expectedTurnCount < 0)) ||
			(input.additionalTurns !== undefined && (!Number.isSafeInteger(input.additionalTurns) || input.additionalTurns < 1))
		) {
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent continuation input is invalid"));
		}
		if (this.disposed) return Result.err(new FoundationError("subagent_provider_unavailable", "Trusted subagent composition is disposed"));
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		if (this.runByChild.get(input.childAgentInstanceId) !== input.runId) {
			return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found for this Run"));
		}
		let record = this.supervisor.get(input.childAgentInstanceId);
		if (record === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		const provider = providerForKind(this.providers, record.providerKind);
		const spawn = await this.lookupProviderHandle(record, provider, input.signal);
		if (spawn === undefined) {
			const marked = await this.markUnrecoverableChild(record);
			if (!marked.ok) return marked;
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent provider handle could not be recovered"));
		}
		const plan = this.planByChild.get(input.childAgentInstanceId);
		if (
			plan === undefined ||
			plan.providerId !== record.providerId ||
			plan.initialBindingEpoch.attemptId !== record.attemptId
		) {
			const marked = await this.markUnrecoverableChild(record);
			if (!marked.ok) return marked;
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent continuation plan could not be recovered"));
		}
		if (input.expectedTurnCount !== undefined && input.additionalTurns !== undefined) {
			const decided = await this.supervisor.decideMaxTurns({
				schemaVersion: 1,
				childAgentInstanceId: input.childAgentInstanceId,
				expectedTurnCount: input.expectedTurnCount,
				decision: "continue",
				additionalTurns: input.additionalTurns,
			});
			if (!decided.ok) return decided;
			record = decided.value;
		}
		let acceptedReceipt: AttemptReceipt | undefined;
		const lookupSpawn = provider.lookupSpawn?.bind(provider);
		const resumed = await this.supervisor.resume(input.childAgentInstanceId, {
			providerId: provider.providerId,
			...(lookupSpawn === undefined ? {} : { lookupSpawn }),
			resume: async (attemptId: string) => {
				if (attemptId !== plan.initialBindingEpoch.attemptId) {
					return Result.err(new FoundationError("subagent_resume_failed", "Child Agent continuation Attempt identity changed"));
				}
				const continued = await this.settlementForLane(plan.childLaneId).resumeDispatch({
					provider,
					dispatch: {
						schemaVersion: 1,
						dispatchId: spawn.attempt.dispatchId,
						taskId: spawn.attempt.taskId,
						bindingId: spawn.attempt.bindingId,
						taskExecutorProviderId: spawn.attempt.providerId,
						status: "pending",
						createdAt: spawn.attempt.startedAt,
					},
					binding: plan.childBinding,
					initialBindingEpoch: spawn.initialBindingEpoch,
					agentInstance: spawn.agentInstance,
					correlation: plan.correlation,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				});
				if (!continued.ok) return continued;
				if (continued.value.receipt === undefined) {
					return Result.err(new FoundationError("subagent_resume_failed", "Child Agent continuation produced no receipt"));
				}
				acceptedReceipt = continued.value.receipt;
				return Result.ok(continued.value.receipt);
			},
		});
		if (!resumed.ok) {
			if (this.supervisor.get(input.childAgentInstanceId)?.status === "lost") {
				const sealed = this.mailbox.sealEndpoint(input.childAgentInstanceId);
				if (!sealed.ok) return sealed;
			}
			return resumed;
		}
		if (acceptedReceipt === undefined) {
			const marked = await this.markUnrecoverableChild(record);
			if (!marked.ok) return marked;
			return Result.err(new FoundationError("subagent_resume_failed", "Child Agent continuation receipt was not accepted"));
		}
		return Result.ok(cloneDeepFrozen({
			lifecycle: this.safeProjection(input.runId, resumed.value),
			receipt: acceptedReceipt,
		}));
	}

	async executeComposition(
		input: ExecuteSubagentCompositionInput,
	): Promise<ResultValue<SubagentCompositionExecution, FoundationError>> {
		if (
			input.schemaVersion !== 1 ||
			(input.mode !== "parallel" && input.mode !== "chain") ||
			input.steps.length === 0 ||
			typeof input.runId !== "string" ||
			input.runId.length === 0 ||
			typeof input.taskResultId !== "string" ||
			input.taskResultId.length === 0
		) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Trusted Child Agent composition input is invalid"));
		}
		if (input.mode === "parallel" && input.steps.some((step) => step.input === "safe_projection")) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Parallel Child Agent composition cannot consume an ordered safe projection"));
		}
		if (input.mode === "chain" && input.steps[0]!.input !== "root") {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent chain must start from a root plan"));
		}

		const plans: SubagentSpawnPlan[] = [];
		const executions: SubagentExecution[] = [];
		const projections: SafeChildResultProjection[] = [];
		const executeStaticStep = async (
			step: Extract<SubagentChainStep, { readonly input: "root" | "task_package" }>,
		): Promise<ResultValue<SubagentExecution, FoundationError>> => {
			if (step.input === "task_package" && step.plan.request.forkScope !== "task_package") {
				return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent task_package chain step did not preserve task_package context isolation"));
			}
			if (step.plan.request.taskEnvelope.taskId !== input.task.taskId) {
				return Result.err(new FoundationError("subagent_conflict", "Child Agent composition plans must settle the declared Task"));
			}
			plans.push(step.plan);
			return this.executePlan({
				schemaVersion: 1,
				runId: input.runId,
				plan: step.plan,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
		};

		if (input.mode === "parallel") {
			const staticSteps = input.steps as readonly Extract<SubagentChainStep, { readonly input: "root" | "task_package" }>[];
			const executed = await Promise.all(staticSteps.map(executeStaticStep));
			const failure = executed.find((result) => !result.ok);
			if (failure !== undefined && !failure.ok) {
				await this.closeCompositionPlans(plans);
				return failure;
			}
			for (const result of executed) {
				if (result.ok) executions.push(result.value);
			}
		} else {
			for (let index = 0; index < input.steps.length; index += 1) {
				const step = input.steps[index]!;
				let planResult: ResultValue<SubagentSpawnPlan, FoundationError>;
				if (step.input === "safe_projection") {
					const previous = projections.at(-1);
					if (previous === undefined) {
						await this.closeCompositionPlans(plans);
						return Result.err(new FoundationError("subagent_result_untrusted", "Child Agent chain has no safe prior projection"));
					}
					try {
						planResult = Result.ok(await step.createPlan(previous));
					} catch {
						planResult = Result.err(new FoundationError("subagent_spawn_invalid", "Trusted Host could not create the next Child Agent chain plan"));
					}
				} else {
					planResult = Result.ok(step.plan);
				}
				if (!planResult.ok) {
					await this.closeCompositionPlans(plans);
					return planResult;
				}
				const normalizedStep = step.input === "safe_projection"
					? { input: "root" as const, plan: planResult.value }
					: step;
				if (index > 0 && normalizedStep.input === "root" && step.input !== "safe_projection") {
					await this.closeCompositionPlans(plans);
					return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent chain steps must consume SafeChildResultProjection or task_package"));
				}
				const executed = await executeStaticStep(normalizedStep);
				if (!executed.ok) {
					await this.closeCompositionPlans(plans);
					return executed;
				}
				executions.push(executed.value);
				const projected = await this.projectAttemptResult(planResult.value, executed.value.receipt.receipt);
				if (!projected.ok) {
					await this.closeCompositionPlans(plans);
					return projected;
				}
				projections.push(projected.value);
				if (executed.value.receipt.receipt.status !== "succeeded") {
					await this.closeCompositionPlans(plans);
					return Result.err(new FoundationError("subagent_result_untrusted", "Child Agent chain stopped at a failed terminal receipt"));
				}
			}
		}

		if (input.mode === "parallel") {
			for (let index = 0; index < executions.length; index += 1) {
				const projected = await this.projectAttemptResult(plans[index]!, executions[index]!.receipt.receipt);
				if (!projected.ok) {
					await this.closeCompositionPlans(plans);
					return projected;
				}
				projections.push(projected.value);
			}
		}
		const receipts = executions.map((execution) => execution.receipt.receipt);
		if (new Set(receipts.map((receipt) => receipt.attemptReceiptId)).size !== receipts.length) {
			await this.closeCompositionPlans(plans);
			return Result.err(new FoundationError("subagent_conflict", "Child Agent composition repeated an AttemptReceipt"));
		}
		const firstPlan = plans[0]!;
		const firstReceipt = receipts[0]!;
		const settled = await settleChildTaskResult(this.settlementForLane(this.parentLaneId), {
			taskResultId: input.taskResultId,
			task: input.task,
			receipts,
			policy: input.join,
			summary: input.summary,
			...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
			...(input.diff === undefined ? {} : { diff: input.diff }),
			tests: input.tests,
			evidence: input.evidence,
			producer: {
				producerKind: "host",
				providerId: `subagent-host:${this.sessionId}`,
				producedAt: this.now(),
				correlation: {
					...firstPlan.correlation,
					laneId: this.parentLaneId,
					taskResultId: input.taskResultId,
					attemptReceiptId: firstReceipt.attemptReceiptId,
				},
			},
		});
		if (!settled.ok) {
			await this.closeCompositionPlans(plans);
			return settled;
		}
		for (let index = 0; index < executions.length; index += 1) {
			const plan = plans[index]!;
			const receipt = executions[index]!.receipt.receipt;
			const delivered = await this.mailbox.send({
				schemaVersion: 1,
				messageId: `result_ref_join_${fingerprintFoundationValue({ runId: input.runId, attemptReceiptId: receipt.attemptReceiptId }).value.slice(0, 32)}`,
				fromAgentInstanceId: plan.agentInstance.agentInstanceId,
				toAgentInstanceId: plan.request.parentAgentInstanceId,
				fromAttemptId: receipt.attemptId,
				kind: "result_ref",
				body: {
					schemaVersion: 1,
					objectType: "attempt_receipt",
					objectId: receipt.attemptReceiptId,
					digest: fingerprintFoundationValue(receipt),
				},
				correlation: {
					sessionId: this.sessionId,
					laneId: this.parentLaneId,
					taskId: plan.request.parentSpawn?.parentTaskId ?? plan.correlation.taskId,
					attemptId: plan.request.parentAttemptId,
					agentInstanceId: plan.request.parentAgentInstanceId,
				},
			});
			if (!delivered.ok) {
				await this.closeCompositionPlans(plans);
				return delivered;
			}
		}
		const closed = await this.closeCompositionPlans(plans);
		if (!closed.ok) return closed;
		return Result.ok(cloneDeepFrozen({
			executions,
			projections,
			taskResult: settled.value,
			attemptReceiptIds: settled.value.sourceAttemptReceiptIds,
		}));
	}

	async consumeParentNextTurn(input: ConsumeChildMailboxInput): Promise<ResultValue<{
		readonly entries: readonly SafeSubagentNextTurnContext[];
		readonly contextText: string;
	}, FoundationError>> {
		const entries = await this.mailboxIngress.consumeNextTurn(input);
		if (!entries.ok) return entries;
		return Result.ok(cloneDeepFrozen({ entries: entries.value, contextText: renderSubagentNextTurnContext(entries.value) }));
	}

	async consumeParentNextTurnForRun(runId: string): Promise<ResultValue<{
		readonly entries: readonly SafeSubagentNextTurnContext[];
		readonly contextText: string;
	}, FoundationError>> {
		const parent = this.parentByRun.get(runId);
		if (parent === undefined) return Result.ok(cloneDeepFrozen({ entries: [], contextText: "" }));
		return this.consumeParentNextTurn({
			schemaVersion: 1,
			sessionId: this.sessionId,
			toAgentInstanceId: parent.toAgentInstanceId,
			byAttemptId: parent.byAttemptId,
			limit: 32,
		});
	}

	/** Named trusted Host injection for associating an active parent Run with its durable Attempt. */
	bindTrustedParentRun(input: unknown): ResultValue<void, FoundationError> {
		if (!isHostParentRunInput(input) || input.sessionId !== this.sessionId) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Parent Run mailbox authority is invalid"));
		}
		const parent = { toAgentInstanceId: input.toAgentInstanceId, byAttemptId: input.byAttemptId };
		const existing = this.parentByRun.get(input.runId);
		if (existing !== undefined && (existing.toAgentInstanceId !== parent.toAgentInstanceId || existing.byAttemptId !== parent.byAttemptId)) {
			return Result.err(new FoundationError("subagent_conflict", "A Run cannot consume Child mailbox data for different parent authorities"));
		}
		this.parentByRun.set(input.runId, parent);
		return Result.ok(undefined);
	}

	/** Trusted child delivery point; exact mailbox shape validation remains authoritative. */
	deliverChildMailbox(input: unknown): Promise<ResultValue<ChildMailboxMessage, FoundationError>> {
		return this.mailbox.send(input);
	}

	async get(runId: string, childAgentInstanceId: string): Promise<ResultValue<SafeSubagentLifecycleProjection | undefined, FoundationError>> {
		if (this.runByChild.get(childAgentInstanceId) !== runId) return Result.ok(undefined);
		const record = this.supervisor.get(childAgentInstanceId);
		return Result.ok(record === undefined ? undefined : this.safeProjection(runId, record));
	}

	async list(runId: string, filter: { readonly parentAgentInstanceId?: string; readonly status?: ChildLifecycleStatus; readonly limit: number }): Promise<ResultValue<readonly SafeSubagentLifecycleProjection[], FoundationError>> {
		if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 100) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Subagent list limit must be between 1 and 100"));
		}
		const records = this.supervisor.list()
			.filter((record) => this.runByChild.get(record.childAgentInstanceId) === runId)
			.filter((record) => filter.parentAgentInstanceId === undefined || record.parentAgentInstanceId === filter.parentAgentInstanceId)
			.filter((record) => filter.status === undefined || record.status === filter.status)
			.slice(0, filter.limit)
			.map((record) => this.safeProjection(runId, record));
		return Result.ok(Object.freeze(records));
	}

	async cancel(runId: string, childAgentInstanceId: string): Promise<ResultValue<SafeSubagentLifecycleProjection | undefined, FoundationError>> {
		if (this.runByChild.get(childAgentInstanceId) !== runId) return Result.ok(undefined);
		const record = this.supervisor.get(childAgentInstanceId);
		if (record === undefined) return Result.ok(undefined);
		const cancelled = await this.supervisor.cancel(childAgentInstanceId, providerForKind(this.providers, record.providerKind));
		return cancelled.ok ? Result.ok(this.safeProjection(runId, cancelled.value)) : cancelled;
	}

	lifecycleHooks(): RunSubagentLifecycleHooks {
		return Object.freeze({
			onRunCancelRequested: (runId: string) => { void this.cancelRun(runId); },
			onRunDeadlineExceeded: (runId: string) => { void this.cancelRun(runId); },
			onRunTerminal: (runId: string) => { void this.cancelRun(runId); },
			onRunInterrupted: (runId: string) => { void this.cancelRun(runId); },
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const [childAgentInstanceId, plan] of this.planByChild) {
			const record = this.supervisor.get(childAgentInstanceId);
			if (record !== undefined && record.status !== "closed") {
				await this.convergeProductTerminal(childAgentInstanceId, providerForKind(this.providers, plan.providerKind));
			}
		}
		await Promise.all([...this.providers.values()].map((provider) => provider.dispose()));
		this.executionWorkspaces.clear();
	}

	private async cancelRun(runId: string): Promise<void> {
		for (const record of this.supervisor.list()) {
			if (this.runByChild.get(record.childAgentInstanceId) !== runId || !ACTIVE_STATUSES.has(record.status)) continue;
			await this.supervisor.cancel(record.childAgentInstanceId, providerForKind(this.providers, record.providerKind)).catch(() => undefined);
		}
	}

	private async spawnProductPromptChild(
		input: PromptTaskSubagentSpawnInput,
	): Promise<ResultValue<PromptTaskSubagentSpawnResult, FoundationError>> {
		const policy = this.productPrompt;
		if (policy === undefined) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Product prompt Child Agents are disabled"));
		}
		const recovered = await this.recovery;
		if (!recovered.ok) return recovered;
		const token = fingerprintFoundationValue({
			runId: input.runId,
			parentTaskId: input.parentTask.taskId,
			roleRevisionId: input.selectedRoleRevision.roleRevisionId,
			prompt: input.prompt,
		}).value.slice(0, 32);
		const spawnId = `spawn_product_${token}`;
		const parentSpawnId = `origin_${spawnId}`;
		const childTaskId = `task_child_${token}`;
		const childBindingId = `binding_child_${token}`;
		const childLaneId = `child_${token}`;
		const childAgentInstanceId = `agent_child_${token}`;
		const childAttemptId = `attempt_child_${token}`;
		const childDispatchId = `dispatch_child_${token}`;
		const childEpochId = `binding_epoch_child_${token}`;
		const childLedger = this.ledgerForLane(childLaneId);
		const parentSettlement = this.settlementForLane(this.parentLaneId);
		const deadlineAt = input.deadlineMs === undefined
			? undefined
			: new Date(Date.parse(input.timestamp) + input.deadlineMs).toISOString();
		let provider: ExecutableChildProviderV1 | undefined;
		let plannedChildId: string | undefined;
		try {
			const descriptor = this.registry.resolve(policy.providerId, {
				forkScope: policy.forkScope,
				mailboxRequired: policy.mailboxRequired,
				resumeRequired: policy.resumeRequired,
				worktreeRequired: policy.worktreeRequired,
				backgroundRequired: policy.backgroundRequired,
			});
			provider = providerForKind(this.providers, descriptor.providerKind);
			const childProfile = policy.childModelProfile === undefined
				? input.parentModelProfile
				: await policy.childModelProfile(input.selectedRoleRevision.roleId, input.parentModelProfile);
			const childTask = createTaskEnvelope({
				schemaVersion: 1,
				taskId: childTaskId,
				goalId: input.parentTask.goalId,
				goal: input.prompt,
				kind: "task",
				title: `Child Agent: ${input.selectedRoleRevision.name}`,
				description: `Distinct Child Task selected from product prompt for role ${input.selectedRoleRevision.roleId}`,
				workspace: input.parentTask.workspace,
				capabilityRefs: input.parentTask.capabilityRefs,
				inputs: input.parentTask.inputs,
				expectedOutputs: [],
				budget: input.parentTask.budget,
				...(deadlineAt === undefined ? {} : { requirements: { deadlineAt } }),
				acceptanceCriteria: [],
				...(input.parentTask.attempts === undefined ? {} : { attempts: input.parentTask.attempts }),
				status: "ready",
				createdAt: input.timestamp,
				updatedAt: input.timestamp,
			});
			if (!childTask.ok) return childTask;
			const persistedTask = await persistTaskEnvelopeBeforeResolver(this.session, childTask.value, {
				ownerId: `subagent-product:${this.sessionId}`,
				...(this.writer === undefined ? {} : { writer: this.writerForLane(childLaneId) }),
			});
			if (!persistedTask.ok) return persistedTask;
			const seededRole = await this.persistExactFact(
				"role_revision",
				input.selectedRoleRevision.roleRevisionId,
				input.selectedRoleRevision,
				{ taskId: childTaskId },
				`subagent-product:role:${spawnId}`,
				childLedger,
			);
			if (!seededRole.ok) return seededRole;
			const seededProfile = await this.persistExactFact(
				"model_profile_revision",
				childProfile.modelProfileId,
				childProfile,
				{ taskId: childTaskId },
				`subagent-product:model:${spawnId}`,
				childLedger,
			);
			if (!seededProfile.ok) return seededProfile;
			const childMcpSelection = projectMcpSelectionToSelector(
				input.parentBinding.mcpSelection,
				input.selectedRoleRevision.mcpSelector,
				input.parentBinding.capabilityRevision.id,
			);
			if (!childMcpSelection.ok) return childMcpSelection;
			const resolved = policy.registry.resolve({
				schemaVersion: 1,
				task: persistedTask.value,
				roleId: input.selectedRoleRevision.roleId,
				scope: policy.scope,
				modelProfile: childProfile,
				orderedLayers: ROLE_RESOLUTION_ORDER.map((layer, ordinal) => ({
					schemaVersion: 1 as const,
					layer,
					ordinal,
					referenceId: `${spawnId}:${layer}`,
					revision: 0,
					overrideReason: "Explicit product Child Agent resolution",
				})),
				externalAgentBindingRevision: input.parentBinding.contextRevision,
				capabilityRevision: input.parentBinding.capabilityRevision,
				modelBrokerBindingRevision: input.parentBinding.modelBrokerBindingRevision,
				policyRevision: input.parentBinding.policyRevision,
				mcpSelection: childMcpSelection.value,
				bindingId: childBindingId,
				now: () => input.timestamp,
			});
			if (!resolved.ok) return resolved;
			const projection = projectChildBinding(
				{
					schemaVersion: 1,
					spawnId,
					parentBinding: input.parentBinding,
					childBindingId,
					parentRoleRevision: input.parentRoleRevision,
					childRoleRevision: input.selectedRoleRevision,
					parentModelProfile: input.parentModelProfile,
					childModelProfile: childProfile,
					childTaskEnvelope: persistedTask.value,
					childMcpSelection: childMcpSelection.value,
					createdAt: input.timestamp,
				},
				this.mcpInheritanceAuthority,
			);
			if (!projection.ok) return projection;
			const persistedProjection = await persistChildBindingProjection(childLedger, projection.value, {
				clientRequestId: `subagent-product:projection:${spawnId}`,
				correlation: { taskId: childTaskId, attemptId: childAttemptId, agentInstanceId: childAgentInstanceId },
			});
			if (!persistedProjection.ok) return persistedProjection;
			const seededBinding = await this.persistExactFact(
				"agent_binding",
				resolved.value.binding.bindingId,
				resolved.value.binding,
				{ taskId: childTaskId, bindingId: childBindingId },
				`subagent-product:binding:${spawnId}`,
				childLedger,
			);
			if (!seededBinding.ok) return seededBinding;
			const parentContextId = `context_${parentSpawnId}`;
			const seededContext = await this.persistExactFact(
				"context",
				parentContextId,
				{
					schemaVersion: 1,
					contextId: parentContextId,
					taskId: input.parentTask.taskId,
					spawnId: parentSpawnId,
					forkScope: policy.forkScope,
					lineage: { schemaVersion: 1, entityType: "context", entityId: parentContextId, depth: 0 },
					createdAt: input.timestamp,
				},
				{ taskId: input.parentTask.taskId, attemptId: input.parentBindingEpoch.attemptId, agentInstanceId: input.parentAgentInstance.agentInstanceId },
				`subagent-product:context:${spawnId}`,
			);
			if (!seededContext.ok) return seededContext;
			const registeredParent = this.mailbox.registerEndpoint({
				schemaVersion: 1,
				sessionId: this.sessionId,
				laneId: this.parentLaneId,
				agentInstanceId: input.parentAgentInstance.agentInstanceId,
				taskId: input.parentTask.taskId,
				attemptId: input.parentBindingEpoch.attemptId,
			});
			if (!registeredParent.ok) return registeredParent;
			const parentSpawn = {
				schemaVersion: 1 as const,
				type: "agent.spawn" as const,
				spawnId: parentSpawnId,
				parentTaskId: input.parentTask.taskId,
				newTaskEnvelopeRef: {
					schemaVersion: 1 as const,
					type: "task_envelope" as const,
					id: childTaskId,
					revision: 1,
					fingerprint: persistedTask.value.fingerprint,
				},
				providerId: descriptor.descriptor.providerId,
				createdAt: input.timestamp,
			};
			const plan = await this.planSpawn({
				schemaVersion: 1,
				request: {
					schemaVersion: 1,
					spawnId,
					parentSpawn,
					taskEnvelope: persistedTask.value,
					roleRevision: input.selectedRoleRevision,
					modelProfile: childProfile,
					parentAttemptId: input.parentBindingEpoch.attemptId,
					parentAgentInstanceId: input.parentAgentInstance.agentInstanceId,
					forkScope: policy.forkScope,
					...(policy.recentN === undefined ? {} : { recentN: policy.recentN }),
					...(policy.taskPackageRef === undefined ? {} : { taskPackageRef: policy.taskPackageRef }),
				},
				originParentAgentInstance: input.parentAgentInstance,
				originParentAttemptId: input.parentBindingEpoch.attemptId,
				lineageParentAgentInstance: input.parentAgentInstance,
				childLaneId,
				childBinding: resolved.value.binding,
				providerDescriptor: descriptor,
				childAgentInstanceId,
				dispatchId: childDispatchId,
				attemptId: childAttemptId,
				bindingEpochId: childEpochId,
				activatedByCommandId: spawnId,
				queue: { mode: "fail" },
				...(input.deadlineMs === undefined ? {} : {
					parentDeadlineAt: new Date(Date.parse(input.timestamp) + input.deadlineMs).toISOString(),
				}),
			});
			if (!plan.ok) return plan;
			plannedChildId = childAgentInstanceId;
			const executed = await this.executePlan({
				schemaVersion: 1,
				runId: input.runId,
				plan: plan.value,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (!executed.ok) return executed;
			const taskResultId = `task_result_child_${token}`;
			const taskResult = await settleChildTaskResult(parentSettlement, {
				taskResultId,
				task: persistedTask.value,
				receipts: [executed.value.receipt.receipt],
				policy: { type: "all_succeed" },
				summary: `Child Agent ${input.selectedRoleRevision.roleId} completed`,
				tests: [],
				evidence: [],
				producer: {
					producerKind: "host",
					providerId: `subagent-host:${this.sessionId}`,
					producedAt: this.now(),
					correlation: {
						...plan.value.correlation,
						laneId: this.parentLaneId,
						taskResultId,
						attemptReceiptId: executed.value.receipt.receipt.attemptReceiptId,
					},
				},
			});
			if (!taskResult.ok) return taskResult;
			const projected = await projectSafeChildResult(
				{
					artifactStore: this.artifactStore,
					ledger: this.ledger,
					sessionId: this.sessionId,
					childLaneId,
					parentLaneId: this.parentLaneId,
					now: () => Date.parse(this.now()),
				},
				{
					schemaVersion: 1,
					type: "task_result",
					childAgentInstanceId,
					taskId: childTaskId,
					taskResult: taskResult.value,
					sourceReceipts: [executed.value.receipt.receipt],
				},
			);
			if (!projected.ok) return projected;
			const delivered = await this.mailbox.send({
				schemaVersion: 1,
				messageId: `result_ref_child_${token}`,
				fromAgentInstanceId: childAgentInstanceId,
				toAgentInstanceId: input.parentAgentInstance.agentInstanceId,
				fromAttemptId: childAttemptId,
				kind: "result_ref",
				body: {
					schemaVersion: 1,
					objectType: "task_result",
					objectId: taskResultId,
					digest: fingerprintFoundationValue(taskResult.value),
				},
				correlation: {
					sessionId: this.sessionId,
					laneId: this.parentLaneId,
					taskId: input.parentTask.taskId,
					attemptId: input.parentBindingEpoch.attemptId,
					agentInstanceId: input.parentAgentInstance.agentInstanceId,
				},
			});
			if (!delivered.ok) return delivered;
			const closedProvider = await provider.close(childAttemptId);
			if (!closedProvider.ok) return closedProvider;
			const cleanedWorktree = await this.cleanupExecutionWorktree(plan.value);
			if (!cleanedWorktree.ok) return cleanedWorktree;
			const closedSupervisor = await this.supervisor.close(childAgentInstanceId, true);
			if (!closedSupervisor.ok) return closedSupervisor;
			const sealed = this.mailbox.sealEndpoint(childAgentInstanceId);
			if (!sealed.ok) return sealed;
			return Result.ok(cloneDeepFrozen({ attemptReceiptIds: [executed.value.receipt.receipt.attemptReceiptId] }));
		} catch (error) {
			return Result.err(error instanceof FoundationError
				? error
				: new FoundationError("subagent_spawn_invalid", "Product prompt Child Agent execution failed"));
		} finally {
			if (plannedChildId !== undefined) {
				const record = this.supervisor.get(plannedChildId);
				if (record !== undefined && record.status !== "closed") {
					await this.convergeProductTerminal(plannedChildId, provider);
				}
			}
		}
	}

	private async composeProductPromptChildren(
		input: PromptTaskSubagentCompositionInput,
	): Promise<ResultValue<PromptTaskSubagentSpawnResult, FoundationError>> {
		const policy = this.productPromptComposition;
		if (policy === undefined) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Product prompt Child Agent composition is disabled"));
		}
		const registeredParent = this.mailbox.registerEndpoint({
			schemaVersion: 1,
			sessionId: this.sessionId,
			laneId: this.parentLaneId,
			agentInstanceId: input.parentAgentInstance.agentInstanceId,
			taskId: input.parentTask.taskId,
			attemptId: input.parentBindingEpoch.attemptId,
		});
		if (!registeredParent.ok) return registeredParent;
		let prepared: ProductPromptCompositionPreparation;
		try {
			prepared = await policy.prepare(input);
		} catch {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Trusted Host could not prepare product Child Agent composition"));
		}
		const executed = await this.executeComposition({
			schemaVersion: 1,
			runId: input.runId,
			mode: policy.mode,
			steps: prepared.steps,
			join: policy.join,
			taskResultId: prepared.taskResultId,
			task: prepared.task,
			summary: prepared.summary,
			...(prepared.artifacts === undefined ? {} : { artifacts: prepared.artifacts }),
			...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
			tests: prepared.tests,
			evidence: prepared.evidence,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!executed.ok) return executed;
		const attemptReceiptIds = [...executed.value.attemptReceiptIds];
		if (attemptReceiptIds.length === 0 || new Set(attemptReceiptIds).size !== attemptReceiptIds.length) {
			return Result.err(new FoundationError("subagent_conflict", "Trusted product composition returned invalid accepted AttemptReceipt ids"));
		}
		return Result.ok(cloneDeepFrozen({ attemptReceiptIds }));
	}

	private worktreeExecutionKey(childAgentInstanceId: string, attemptId: string): string {
		return `${childAgentInstanceId}\u0000${attemptId}`;
	}

	private projectAttemptResult(
		plan: SubagentSpawnPlan,
		receipt: AttemptReceipt,
	): Promise<ResultValue<SafeChildResultProjection, FoundationError>> {
		return projectSafeChildResult(
			{
				artifactStore: this.artifactStore,
				ledger: this.ledger,
				sessionId: this.sessionId,
				childLaneId: plan.childLaneId,
				parentLaneId: this.parentLaneId,
				now: () => Date.parse(this.now()),
			},
			{
				schemaVersion: 1,
				type: "attempt_receipt",
				childAgentInstanceId: plan.agentInstance.agentInstanceId,
				taskId: plan.request.taskEnvelope.taskId,
				receipt,
			},
		);
	}

	private async closeCompositionPlans(
		plans: readonly SubagentSpawnPlan[],
	): Promise<ResultValue<void, FoundationError>> {
		for (const plan of plans) {
			const childAgentInstanceId = plan.agentInstance.agentInstanceId;
			const record = this.supervisor.get(childAgentInstanceId);
			if (record === undefined || record.status === "closed") continue;
			const provider = providerForKind(this.providers, plan.providerKind);
			const closedProvider = await provider.close(plan.initialBindingEpoch.attemptId);
			if (!closedProvider.ok) return closedProvider;
			const cleanedWorktree = await this.cleanupExecutionWorktree(plan);
			if (!cleanedWorktree.ok) return cleanedWorktree;
			const closed = await this.supervisor.close(childAgentInstanceId, true);
			if (!closed.ok) return closed;
			const sealed = this.mailbox.sealEndpoint(childAgentInstanceId);
			if (!sealed.ok) return sealed;
		}
		return Result.ok(undefined);
	}

	private async prepareExecutionWorktree(
		plan: SubagentSpawnPlan,
	): Promise<ResultValue<void, FoundationError>> {
		const configured = this.worktree;
		if (configured === undefined) return Result.ok(undefined);
		let negotiated: SubagentProviderDescriptor;
		try {
			negotiated = this.registry.resolve(plan.providerId, {
				providerKind: "in_process",
				worktreeRequired: true,
			});
		} catch (error) {
			return Result.err(error instanceof FoundationError
				? error
				: new FoundationError("subagent_capability_unsupported", "Child worktree capability negotiation failed"));
		}
		if (negotiated.providerKind !== plan.providerKind || negotiated.descriptor.providerId !== plan.providerId) {
			return Result.err(new FoundationError("subagent_capability_unsupported", "Child plan did not preserve the exact negotiated worktree capability descriptor"));
		}
		const childAgentInstanceId = plan.agentInstance.agentInstanceId;
		const attemptId = plan.initialBindingEpoch.attemptId;
		const key = this.worktreeExecutionKey(childAgentInstanceId, attemptId);
		const host = {
			adapter: configured.adapter,
			ledger: this.ledgerForLane(plan.childLaneId),
			sessionId: this.sessionId,
			laneId: plan.childLaneId,
			now: () => Date.parse(this.now()),
		};
		const created = await createChildWorktree(host, childAgentInstanceId, attemptId, configured.baseRef);
		if (!created.ok) return created;
		this.worktreeRecords.set(key, created.value);
		this.planByChild.set(childAgentInstanceId, plan);
		const identity = {
			schemaVersion: 1 as const,
			childAgentInstanceId,
			attemptId,
		};
		let workspace: ResultValue<string, FoundationError>;
		try {
			workspace = await configured.adapter.resolveExecutionWorkspace(identity);
		} catch {
			workspace = Result.err(new FoundationError("subagent_worktree_conflict", "Host adapter could not resolve the child execution workspace"));
		}
		if (!workspace.ok || workspace.value.trim().length === 0) {
			return Result.err(workspace.ok
				? new FoundationError("subagent_worktree_conflict", "Host adapter returned an invalid child execution workspace")
				: workspace.error);
		}
		this.executionWorkspaces.set(key, workspace.value);
		return Result.ok(undefined);
	}

	private async applyExecutionWorktree(
		plan: SubagentSpawnPlan,
	): Promise<ResultValue<void, FoundationError>> {
		const configured = this.worktree;
		if (configured === undefined) return Result.ok(undefined);
		const key = this.worktreeExecutionKey(plan.agentInstance.agentInstanceId, plan.initialBindingEpoch.attemptId);
		const record = this.worktreeRecords.get(key);
		if (record === undefined) {
			return Result.err(new FoundationError("subagent_worktree_conflict", "Successful Child Agent execution has no owned worktree record"));
		}
		const applied = await applyChildWorktree({
			adapter: configured.adapter,
			ledger: this.ledgerForLane(plan.childLaneId),
			sessionId: this.sessionId,
			laneId: plan.childLaneId,
			now: () => Date.parse(this.now()),
		}, record);
		if (!applied.ok) {
			const durable = await readChildWorktreeRecord({
				adapter: configured.adapter,
				ledger: this.ledgerForLane(plan.childLaneId),
				sessionId: this.sessionId,
				laneId: plan.childLaneId,
				now: () => Date.parse(this.now()),
			}, plan.agentInstance.agentInstanceId, plan.initialBindingEpoch.attemptId);
			if (durable.ok && durable.value !== undefined) this.worktreeRecords.set(key, durable.value);
			return applied;
		}
		this.worktreeRecords.set(key, applied.value);
		return Result.ok(undefined);
	}

	private async cleanupExecutionWorktree(
		plan: SubagentSpawnPlan,
	): Promise<ResultValue<void, FoundationError>> {
		const configured = this.worktree;
		if (configured === undefined) return Result.ok(undefined);
		const key = this.worktreeExecutionKey(plan.agentInstance.agentInstanceId, plan.initialBindingEpoch.attemptId);
		this.executionWorkspaces.delete(key);
		const record = this.worktreeRecords.get(key);
		if (record === undefined) return Result.ok(undefined);
		const cleaned = await cleanupChildWorktree({
			adapter: configured.adapter,
			ledger: this.ledgerForLane(plan.childLaneId),
			sessionId: this.sessionId,
			laneId: plan.childLaneId,
			now: () => Date.parse(this.now()),
		}, record);
		if (!cleaned.ok) return cleaned;
		this.worktreeRecords.set(key, cleaned.value);
		return Result.ok(undefined);
	}

	private async persistExactFact(
		objectType: string,
		objectId: string,
		payload: unknown,
		correlation: { readonly taskId?: string; readonly attemptId?: string; readonly agentInstanceId?: string; readonly bindingId?: string },
		clientRequestId: string,
		ledger: SessionLedger = this.ledger,
	): Promise<ResultValue<void, FoundationError>> {
		try {
			const existing = await ledger.get(objectType, objectId);
			if (existing !== undefined) {
				return existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)
					? Result.ok(undefined)
					: Result.err(new FoundationError("subagent_conflict", `Durable ${objectType} identity conflicts with product Child Agent input`));
			}
			await ledger.appendFact(objectType, objectId, payload, { clientRequestId, expectedRevision: 0, correlation });
			return Result.ok(undefined);
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", `Durable ${objectType} fact could not be persisted`));
		}
	}

	/** Reload restores safe facts only. Provider handles must pass lookup before explicit transcript resume. */
	private async recoverDurableState(): Promise<ResultValue<void, FoundationError>> {
		const reloaded = await this.supervisor.reload();
		if (!reloaded.ok) return reloaded;
		for (const record of reloaded.value) {
			if (!ACTIVE_STATUSES.has(record.status)) continue;
			const provider = providerForKind(this.providers, record.providerKind);
			if (await this.lookupProviderHandle(record, provider) !== undefined) continue;
			const marked = await this.markUnrecoverableChild(record);
			if (!marked.ok) return marked;
		}
		return Result.ok(undefined);
	}

	private async lookupProviderHandle(
		record: ChildAgentRecord,
		provider: ExecutableChildProviderV1,
		signal?: AbortSignal,
	): Promise<ChildSpawnResult | undefined> {
		if (provider.lookupSpawn === undefined) return undefined;
		try {
			const found = await provider.lookupSpawn(record.spawnId, signal === undefined ? undefined : { signal });
			if (
				!found.ok ||
				found.value === undefined ||
				found.value.agentInstance.agentInstanceId !== record.childAgentInstanceId ||
				found.value.attempt.attemptId !== record.attemptId ||
				found.value.attempt.providerId !== record.providerId
			) {
				return undefined;
			}
			return found.value;
		} catch {
			return undefined;
		}
	}

	private async markUnrecoverableChild(record: ChildAgentRecord): Promise<ResultValue<void, FoundationError>> {
		const current = this.supervisor.get(record.childAgentInstanceId);
		if (current !== undefined && ACTIVE_STATUSES.has(current.status)) {
			const lost = await this.supervisor.markLost(record.childAgentInstanceId);
			if (!lost.ok) return lost;
		}
		const sealed = this.mailbox.sealEndpoint(record.childAgentInstanceId);
		if (!sealed.ok) return sealed;
		return Result.ok(undefined);
	}

	private writerForLane(laneId: string): SessionLedgerWriter {
		if (this.writer === undefined) {
			throw new FoundationError("subagent_persistence_failed", "Trusted child lane writer requires the canonical parent writer");
		}
		const existing = this.laneWriters.get(laneId);
		if (existing !== undefined) return existing;
		const writer = new ChildLaneSessionLedgerWriterV1(this.writer, laneId);
		this.laneWriters.set(laneId, writer);
		return writer;
	}

	private settlementForLane(laneId: string): LayeredResultSettlement {
		const existing = this.laneSettlements.get(laneId);
		if (existing !== undefined) return existing;
		const settlement = new LayeredResultSettlement(this.session, {
			ownerId: `subagent-host:${this.sessionId}:${laneId}`,
			...(this.writer === undefined ? {} : { writer: this.writerForLane(laneId) }),
		});
		this.laneSettlements.set(laneId, settlement);
		return settlement;
	}

	private async convergeProductTerminal(
		childAgentInstanceId: string,
		provider: ExecutableChildProviderV1 | undefined,
	): Promise<void> {
		const record = this.supervisor.get(childAgentInstanceId);
		if (record === undefined) return;
		let cleanupConfirmed = provider !== undefined;
		if (ACTIVE_STATUSES.has(record.status) && provider !== undefined) {
			const cancelled = await this.supervisor.cancel(childAgentInstanceId, provider).catch(() => undefined);
			if (cancelled?.ok !== true) await this.supervisor.markLost(childAgentInstanceId).catch(() => undefined);
		}
		if (provider !== undefined) {
			const closed = await provider.close(record.attemptId).catch(() => undefined);
			cleanupConfirmed = closed?.ok === true;
		}
		const plan = this.planByChild.get(childAgentInstanceId);
		if (plan !== undefined) {
			const cleaned = await this.cleanupExecutionWorktree(plan).catch(() => undefined);
			cleanupConfirmed = cleanupConfirmed && cleaned?.ok === true;
		}
		const terminal = this.supervisor.get(childAgentInstanceId);
		if (terminal !== undefined && terminal.status !== "closed") {
			await this.supervisor.forceClose(childAgentInstanceId, cleanupConfirmed).catch(() => undefined);
		}
		this.mailbox.sealEndpoint(childAgentInstanceId);
	}

	private async convergePostSpawnFailure(
		childAgentInstanceId: string,
		provider: ExecutableChildProviderV1,
	): Promise<void> {
		await this.convergeProductTerminal(childAgentInstanceId, provider);
		this.runByChild.delete(childAgentInstanceId);
	}

	private safeProjection(runId: string, record: ChildAgentRecord): SafeSubagentLifecycleProjection {
		const base = {
			schemaVersion: 1 as const,
			source: "subagent.lifecycle" as const,
			sessionId: this.sessionId,
			runId,
			childAgentInstanceId: record.childAgentInstanceId,
			parentAgentInstanceId: record.parentAgentInstanceId,
			taskId: record.taskId,
			status: record.status,
			providerKind: record.providerKind,
			safeSummary: `Child ${record.childAgentInstanceId} is ${record.status}`,
			correlation: { attemptId: record.attemptId, spawnId: record.spawnId },
		};
		return cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) });
	}
}

/** Construct the trusted Host Subagent authority for one canonical Session. */
export function createSubagentComposition(
	options: SubagentCompositionOptions | undefined,
): SubagentComposition | undefined {
	if (options === undefined) return undefined;
	const composition = new SubagentComposition(options);
	options.onReady?.(composition);
	return composition;
}
