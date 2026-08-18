import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type DeferredHandle, type Model, type Models } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import { Result } from "../../src/harness/result.ts";
import {
	AgentHarness,
	type AgentHarnessOptions,
	type AgentHarnessFoundationExecution,
	type HarnessTool,
	type Resources,
	type StreamOptions,
} from "../../src/harness/agent-harness.ts";
import { InMemoryArtifactBlobStore } from "../../src/harness/artifacts.ts";
import { createAttempt, createHostTerminalGateAuthorityV1, fingerprintFoundationValue, FoundationError, SessionLedgerV1, type AgentBindingV1, type AgentInstanceV1, type AttemptReceiptV1, type AttemptV1, type DispatchV1, type ExecutionCorrelationV1, type FoundationJsonValue, type FoundationProviderCapabilityV1, type FoundationProviderExecutionOptionsV1, type ModelProfileV1, type ModelRouteV1, type RoleRevisionV1, type SideEffectStateV1, type TaskExecutorAttemptContextV1, type TaskExecutorProvider } from "../../src/harness/foundation/index.ts";
import { DurableLedgerError, InMemorySessionStorage, Session, SessionError, T5_LEDGER_OBJECT_TYPES, type FoundationRecordV1, type NewRecord, type OperationStartedRecord } from "../../src/harness/session/index.ts";
import type { AgentMessage } from "../../src/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createModelsWithResponse(): { models: Models; model: Model<"google-generative-ai"> } {
	const models = createModels();
	const model = getModel("google", "gemini-2.5-flash");
	const stub = Object.create(models) as Models;
	const branchModel = getModel("google", "gemini-2.5-pro");
	const originalGetModel = stub.getModel.bind(stub);
	stub.getModel = (provider, id) => {
		if (provider === "google" && id === model.id) return model;
		if (provider === "google" && id === branchModel.id) return branchModel;
		return originalGetModel(provider, id);
	};
	const responseFor = (requestModel: Model<Api>) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	});
	stub.streamSimple = (requestModel) => {
		const stream = createAssistantMessageEventStream();
		const message = responseFor(requestModel);
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	stub.completeSimple = async (requestModel) => responseFor(requestModel);
	return { models: stub, model };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
}

async function facts(session: Session): Promise<Extract<FoundationRecordV1, { kind: "fact" }>[]> {
	const records = await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" });
	return records.filter((record): record is Extract<FoundationRecordV1, { kind: "fact" }> => record.kind === "fact");
}

const RESULT_FACT_TYPES = new Set(["attempt_receipt", "task_result", "run_receipt"]);

async function resultFacts(session: Session): Promise<Extract<FoundationRecordV1, { kind: "fact" }>[]> {
	return (await facts(session)).filter((record) => RESULT_FACT_TYPES.has(record.objectType));
}

function foundationRoleRevision() {
	const base = {
		schemaVersion: 1 as const,
		roleRevisionId: "role-revision",
		roleId: "role-harness-runtime",
		scope: "project" as const,
		revision: 1,
		slug: "harness-runtime",
		name: "Harness Runtime",
		description: "Harness runtime role",
		persona: "Execute the harness runtime",
		modelProfileRef: { schemaVersion: 1 as const, type: "model_profile", id: "model-profile", revision: 1 },
		capabilitySelector: { policy: "none" as const },
		skillSelector: { policy: "none" as const },
		mcpSelector: { policy: "none" as const },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function foundationModelProfile() {
	const base = { schemaVersion: 1 as const, modelProfileId: "model-profile", provider: "google", model: "gemini-2.5-flash", budget: {}, revision: 1, createdAt: "2026-01-01T00:00:00.000Z" };
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function createFoundationExecution(): AgentHarnessFoundationExecution {
	const taskId = "task-harness-runtime";
	const bindingId = "binding-harness-runtime";
	const immutableRef = (type: string, id: string) => {
		const payload = { schemaVersion: 1 as const, type, id, revision: 1 };
		return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
	};
	const durableRoleRevision = foundationRoleRevision();
	const durableModelProfile = foundationModelProfile();
	const binding = {
		schemaVersion: 1 as const,
		bindingId,
		taskId,
		goalId: "goal-harness-runtime",
		roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: durableRoleRevision.roleRevisionId, revision: durableRoleRevision.revision, fingerprint: durableRoleRevision.fingerprint },
		modelProfileRevision: { schemaVersion: 1 as const, type: "model_profile_revision", id: durableModelProfile.modelProfileId, revision: durableModelProfile.revision, fingerprint: durableModelProfile.fingerprint },
		modelRoute: { provider: "google", model: "gemini-2.5-flash" },
		contextRevision: immutableRef("external_agent_binding", "external-agent"),
		capabilityRevision: immutableRef("capability_binding", "capability"),
		modelBrokerBindingRevision: immutableRef("model_broker_binding", "model-broker"),
		policyRevision: immutableRef("policy_binding", "policy"),
		capabilitySelector: { policy: "none" as const },
		budget: {},
		sourceTrace: [],
		conflicts: [],
		resolvedAt: "2026-01-01T00:00:00.000Z",
	};
	return {
		task: {
			schemaVersion: 1,
			taskId,
			goalId: "goal-harness-runtime",
			goal: "exercise the AgentHarness runtime",
			workspace: "workspace:test",
			capabilityRefs: [],
			inputs: [],
			expectedOutputs: [],
			budget: {},
			acceptanceCriteria: [],
			status: "ready",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		dispatch: {
			schemaVersion: 1,
			dispatchId: "dispatch-harness-runtime",
			taskId,
			bindingId,
			taskExecutorProviderId: "agent-harness-provider",
			status: "pending",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		binding: { ...binding, fingerprint: fingerprintFoundationValue(binding) },
		providerId: "agent-harness-provider",
		agentInstanceId: "agent-instance-harness-runtime",
		initialBindingEpoch: { schemaVersion: 1, bindingEpochId: "binding-epoch-harness-runtime", taskId, attemptId: "attempt-harness-runtime", agentInstanceId: "agent-instance-harness-runtime", bindingId, ordinal: 0, activationReason: "attempt_started", activatedByCommandId: "command-harness-runtime", activatedAt: "2026-01-01T00:00:00.000Z" },
		agentInstance: { schemaVersion: 1, agentInstanceId: "agent-instance-harness-runtime", providerId: "agent-harness-provider", taskId, roleRevision: { schemaVersion: 1, type: "role_revision", id: durableRoleRevision.roleRevisionId, revision: durableRoleRevision.revision }, bindingEpochIds: ["binding-epoch-harness-runtime"], status: "starting", lineage: { schemaVersion: 1, entityType: "agent_instance", entityId: "agent-instance-harness-runtime", depth: 0 }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
		bindingEpochIds: ["binding-epoch-harness-runtime"],
		settlement: {
			tests: [{ name: "harness runtime", required: true, status: "passed" }],
			evidence: [],
		},
		hostAuthority: createHostTerminalGateAuthorityV1("host-harness-runtime"),
	};
}

const harnessProviderCapability: FoundationProviderCapabilityV1 = { schemaVersion: 1, id: "foundation.harness", version: 1 };

class HarnessFoundationProvider implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "agent" as const;
	private readonly session: Session | undefined;
	createCount = 0;
	runCount = 0;
	cancelCount = 0;
	resumeCount = 0;
	failCreate = false;
	receivedAgentInstance: AgentInstanceV1 | undefined;
	receivedRoleRevision: RoleRevisionV1 | undefined;
	receivedModelProfile: ModelProfileV1 | undefined;
	receivedModelRoute: ModelRouteV1 | undefined;
	receivedBinding: AgentBindingV1 | undefined;
	private lastAttempt: AttemptV1 | undefined;

	constructor(providerId = "agent-harness-provider", session?: Session) {
		this.providerId = providerId;
		this.session = session;
	}

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> { return [harnessProviderCapability]; }

	async createAttempt(dispatch: DispatchV1, binding: AgentBindingV1, context?: TaskExecutorAttemptContextV1) {
		this.createCount += 1;
		if (this.failCreate) return Result.err(new FoundationError("task_executor_invalid_provider_class", "Harness provider create failed"));
		if (context === undefined) return Result.err(new FoundationError("invalid_correlation", "Harness provider requires provider attempt context"));
		this.receivedBinding = binding;
		this.receivedAgentInstance = context.agentInstance;
		this.receivedRoleRevision = context.roleRevision;
		this.receivedModelProfile = context.modelProfile;
		this.receivedModelRoute = context.modelRoute;
		const created = createAttempt({ attemptId: context.initialBindingEpoch.attemptId, dispatch, providerId: this.providerId, initialBindingEpoch: context.initialBindingEpoch, providerClass: this.providerClass, agentInstanceId: context.initialBindingEpoch.agentInstanceId });
		if (created.ok) this.lastAttempt = created.value;
		return created;
	}

	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
		this.runCount += 1;
		if (options === undefined) return Result.err(new FoundationError("invalid_correlation", "Harness provider requires provider execution correlation"));
		if (options.correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "Harness provider requires provider execution correlation"));
		const correlation = { ...options.correlation, taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, bindingId: attempt.bindingId, bindingEpochId: attempt.bindingEpochIds[0], attemptReceiptId: `attempt_receipt_${attempt.attemptId}` };
		const sideEffectState = await this.sideEffectState(correlation);
		const receipt: AttemptReceiptV1 = { schemaVersion: 1, attemptReceiptId: `attempt_receipt_${attempt.attemptId}`, taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, providerId: this.providerId, agentInstanceId: attempt.agentInstanceId, bindingId: attempt.bindingId, bindingEpochIds: [...attempt.bindingEpochIds], status: sideEffectState === "none" ? "succeeded" : "failed", workerReceiptRefs: [], artifacts: [], provenance: { producerKind: "agent_executor", providerId: this.providerId, producedAt: "2026-01-01T00:00:00.000Z", correlation }, sideEffectState, ...(sideEffectState === "none" ? {} : { error: { code: "side_effect_unknown", message: "Provider side effect did not converge", retryable: false } }) };
		return Result.ok(receipt);
	}

	private async sideEffectState(correlation: ExecutionCorrelationV1): Promise<SideEffectStateV1> {
		if (this.session === undefined || correlation.runId === undefined) return "none";
		const starts = await this.session.findRecords({ lane: correlation.laneId, runId: correlation.runId, type: "tool_started", order: "oldestFirst" });
		if (starts.length === 0) return "none";
		for (const start of starts) {
			const result = await this.session.getEntry(start.resultEntryId);
			if (result?.type !== "message" || result.message.role !== "toolResult") return "side_effect_unknown";
		}
		return "unknown";
	}

	async cancelAttempt(_attemptId: string) { this.cancelCount += 1; return Result.ok(undefined); }
	async resume(attemptId: string, options?: { signal?: AbortSignal }) {
		this.resumeCount += 1;
		let attempt = this.lastAttempt;
		if ((attempt === undefined || attempt.attemptId !== attemptId) && this.session !== undefined) {
			const stored = await this.session.getFoundationObject("attempt", attemptId);
			if (stored?.kind === "fact") attempt = stored.payload as unknown as AttemptV1;
		}
		if (attempt === undefined) return Result.err(new FoundationError("invalid_correlation", "Harness provider cannot resume an unknown Attempt"));
		const metadata = this.session === undefined ? { id: "session-harness" } : await this.session.getMetadata();
		return this.runAttempt(attempt, { correlation: { sessionId: metadata.id, laneId: "main", taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, bindingId: attempt.bindingId, bindingEpochId: attempt.bindingEpochIds[0], agentInstanceId: attempt.agentInstanceId, revision: 0 }, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}
	async dispose() {}
}

async function seedFoundationBindingFacts(session: Session, execution: AgentHarnessFoundationExecution): Promise<void> {
	const ledger = new SessionLedgerV1(session, { ownerId: `harness-seed:${execution.binding.bindingId}` });
	await ledger.appendFact("role_revision", execution.binding.roleRevision.id, foundationRoleRevision(), { clientRequestId: `harness-seed:role:${execution.binding.roleRevision.id}`, correlation: { taskId: execution.task.taskId, bindingId: execution.binding.bindingId } });
	await ledger.appendFact("model_profile_revision", execution.binding.modelProfileRevision.id, foundationModelProfile(), { clientRequestId: `harness-seed:model:${execution.binding.modelProfileRevision.id}`, correlation: { taskId: execution.task.taskId, bindingId: execution.binding.bindingId } });
	for (const [objectType, reference] of [["external_agent_binding", execution.binding.contextRevision], ["capability_binding", execution.binding.capabilityRevision], ["model_broker_binding", execution.binding.modelBrokerBindingRevision], ["policy_binding", execution.binding.policyRevision]] as const) {
		const payload = { schemaVersion: 1 as const, type: reference.type, id: reference.id, revision: reference.revision };
		await ledger.appendFact(objectType, reference.id, payload, { clientRequestId: `harness-seed:${objectType}:${reference.id}`, correlation: { taskId: execution.task.taskId, bindingId: execution.binding.bindingId } });
	}
	await ledger.release();
}

async function createFoundationHarness(options: AgentHarnessOptions & { foundationExecution: AgentHarnessFoundationExecution }): Promise<Awaited<ReturnType<typeof AgentHarness.create>> & { provider: HarnessFoundationProvider }> {
	await seedFoundationBindingFacts(options.session, options.foundationExecution);
	const provider = new HarnessFoundationProvider(options.foundationExecution.providerId, options.session);
	const created = await AgentHarness.create({ ...options, foundationProvider: provider });
	return { ...created, provider };
}

function injectFoundationFault(
	session: Session,
	targetObjectType: "attempt_receipt" | "task_result" | "run_receipt",
	when: "before" | "after",
): void {
	const original = session.appendFoundationRecord.bind(session);
	let injected = false;
	session.appendFoundationRecord = async (record) => {
		if (!injected && record.kind === "fact" && record.objectType === targetObjectType && when === "before") {
			injected = true;
			throw new DurableLedgerError("session_ledger_storage", `Injected Foundation ${targetObjectType} write failure`);
		}
		const accepted = await original(record);
		if (!injected && record.kind === "fact" && record.objectType === targetObjectType && when === "after") {
			injected = true;
			throw new DurableLedgerError("session_ledger_storage", `Injected Foundation ${targetObjectType} post-write crash`);
		}
		return accepted;
	};
}

describe("AgentHarness runtime", () => {
	it("persists the TaskEnvelope before rejecting caller-shaped binding sources", async () => {
		const session = createSession("task-before-resolver");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		await expect(AgentHarness.create({ session, models: runtime.models, model: runtime.model, foundationExecution: execution, foundationProvider: new HarnessFoundationProvider(execution.providerId, session) })).rejects.toThrow("durable registry and source facts");
		expect(await session.getFoundationObject("task", execution.task.taskId)).toMatchObject({ kind: "fact", objectType: "task", payload: { taskId: execution.task.taskId } });
	});

	it("drives a public prompt and persists correlated receipts", async () => {
		const session = createSession();
		const { models, model } = createModelsWithResponse();
		const { harness } = await createFoundationHarness({ session, models, model, foundationExecution: createFoundationExecution() });
		expect(harness.context).toBe(harness.t5);
		expect(harness.memory).toBe(harness.t5.memory);
		expect(harness.artifacts).toBe(harness.t5.artifacts);

		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		const persistedFacts = await facts(session);
		const persistedResultFacts = persistedFacts.filter((record) => RESULT_FACT_TYPES.has(record.objectType));
		expect(persistedResultFacts.map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		expect(persistedResultFacts.every((record) => record.correlation.sessionId === "session" && record.correlation.taskId === "task-harness-runtime")).toBe(true);
		expect((persistedResultFacts[0]?.payload as { attemptReceiptId: string }).attemptReceiptId).toContain("attempt_receipt_");
		expect((persistedResultFacts[1]?.payload as { sourceAttemptReceiptIds: string[] }).sourceAttemptReceiptIds).toHaveLength(1);
		expect((persistedResultFacts[2]?.payload as { taskResultId?: string }).taskResultId).toContain("task_result_");
		expect((persistedResultFacts[1]?.payload as { provenance: { providerId: string } }).provenance.providerId).toBe("host-harness-runtime");
		await harness.close();
	});

	it("shares one Session writer across public T5 memory, Foundation settlement, and reopen", async () => {
		const session = createSession("shared-public-writer");
		const blobStore = new InMemoryArtifactBlobStore();
		const execution = createFoundationExecution();
		const options = { t5Options: { ownerId: "shared-public-writer", artifactBlobStore: blobStore } } as const;
		const first = await createFoundationHarness({ session, ...createModelsWithResponse(), foundationExecution: execution, ...options });
		expect(first.harness.t5.writer).toBe(first.harness.context.writer);
		expect(first.harness.t5.writer).toBe(first.harness.memory.writer);
		expect(first.harness.t5.writer).toBe(first.harness.artifacts.writer);

		const firstMemory = await first.harness.memory.put({ id: "public-memory-first", kind: "fact", trust: "user_owned", content: "first", source: "public-test", principal: "system" });
		const firstLease = await session.getWriterLease();
		expect(firstLease?.ownerId).toBe("shared-public-writer");
		expect(firstMemory.retention).toEqual({ policy: "session", purgeOnScopeClose: true });
		const firstResult = await first.harness.prompt("first public write");
		expect(firstResult.ok).toBe(true);
		if (!firstResult.ok) throw firstResult.error;
		const firstRecords = await session.findFoundationRecords({ order: "oldestFirst" });
		const firstFoundationRecords = firstRecords.filter((record) => record.correlation.runId === firstResult.value.runId && record.kind !== "retention" && (record.kind === "intent" || record.objectType === "attempt_receipt" || record.objectType === "task_result" || record.objectType === "run_receipt"));
		expect(firstFoundationRecords.length).toBeGreaterThanOrEqual(4);
		expect(new Set(firstFoundationRecords.map((record) => record.fencingToken))).toEqual(new Set([firstLease?.fencingToken]));
		expect((await session.getWriterLease())?.fencingToken).toBe(firstLease?.fencingToken);
		await first.harness.close();
		expect(await session.getWriterLease()).toBeNull();

		const second = await createFoundationHarness({ session, ...createModelsWithResponse(), foundationExecution: execution, ...options });
		const secondMemory = await second.harness.memory.get(firstMemory.id, "system");
		expect(secondMemory?.content).toBe("first");
		const secondLease = await session.getWriterLease();
		expect(secondLease?.ownerId).toBe("shared-public-writer");
		const secondWrite = await second.harness.memory.put({ id: "public-memory-second", kind: "fact", trust: "user_owned", content: "second", source: "public-test", principal: "system" });
		expect(secondWrite.retention).toEqual({ policy: "session", purgeOnScopeClose: true });
		const secondResult = await second.harness.prompt("second public write");
		expect(secondResult.ok).toBe(true);
		if (!secondResult.ok) throw secondResult.error;
		const reopenedRecords = await session.findFoundationRecords({ order: "oldestFirst" });
		const secondFoundationRecords = reopenedRecords.filter((record) => record.correlation.runId === secondResult.value.runId && record.kind !== "retention" && (record.kind === "intent" || record.objectType === "attempt_receipt" || record.objectType === "task_result" || record.objectType === "run_receipt"));
		expect(new Set(secondFoundationRecords.map((record) => record.fencingToken))).toEqual(new Set([secondLease?.fencingToken]));
		expect((await session.getWriterLease())?.fencingToken).toBe(secondLease?.fencingToken);
		await second.harness.close();
		expect(await session.getWriterLease()).toBeNull();
	});

	it("selects an in-memory artifact backend without an unhandled root rejection", async () => {
		const session = createSession("in-memory-artifacts");
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const { harness } = await AgentHarness.create({ session, ...createModelsWithResponse() });
			await Promise.resolve();
			expect(harness.artifacts.blobs).toBeInstanceOf(InMemoryArtifactBlobStore);
			expect(unhandled).toEqual([]);
			await harness.close();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("projects public tool results through artifact and validation facts", async () => {
		const session = createSession("tool-result-artifacts");
		const blobStore = new InMemoryArtifactBlobStore();
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		let responses = 0;
		models.streamSimple = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			if (responses++ === 0) {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "artifact-call", name: "artifact-tool", arguments: {} }],
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
				});
			} else {
				stream.push({ type: "done", reason: "stop", message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} });
			}
			return stream;
		};
		const tool: HarnessTool = {
			name: "artifact-tool",
			label: "Artifact tool",
			description: "Returns structured and binary data",
			parameters: { type: "object", properties: {}, additionalProperties: false } as HarnessTool["parameters"],
			execute: async () => ({
				content: [
					{ type: "text" as const, text: `large-secret-output-${"x".repeat(4096)}` },
					{ type: "image" as const, data: "AQID", mimeType: "image/png" },
				],
				details: { structured: `secret-structured-output-${"y".repeat(1024)}` },
			}),
		};
		const { harness } = await AgentHarness.create({ session, models, model: runtime.model, tools: [tool], t5Options: { artifactBlobStore: blobStore } });
		const result = await harness.prompt("artifact conversion");
		expect(result.ok).toBe(true);
		const entries = await session.findEntries({ type: "message", order: "oldestFirst" });
		const toolEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolEntry).toBeDefined();
		const persisted = JSON.stringify(toolEntry);
		expect(persisted).not.toContain("large-secret-output");
		expect(persisted).not.toContain("secret-structured-output");
		expect(persisted).not.toContain("AQID");
		const facts = (await session.findFoundationRecords({ kind: "fact", objectType: T5_LEDGER_OBJECT_TYPES.toolResult, order: "oldestFirst" })).filter((record) => record.kind === "fact");
		expect(facts).toHaveLength(1);
		expect(facts[0]?.payload).toMatchObject({ validation: { state: "verified" }, provenance: { runId: expect.any(String), toolCallId: "artifact-call" } });
		const fact = facts[0]?.payload as { content: Array<{ reference: { artifactId: string } }>; detailsRef: { artifactId: string } };
		expect(fact.content).toHaveLength(2);
		expect(await harness.artifacts.verify(fact.content[1]!.reference.artifactId)).toBe("verified");
		expect(await harness.artifacts.verify(fact.detailsRef.artifactId)).toBe("verified");
		await harness.close();
		const reopened = await AgentHarness.create({ session, ...createModelsWithResponse(), t5Options: { artifactBlobStore: blobStore } });
		expect(await reopened.harness.artifacts.verify(fact.content[1]!.reference.artifactId)).toBe("verified");
		expect(await reopened.harness.t5.writer.readFact(T5_LEDGER_OBJECT_TYPES.toolResult, toolEntry!.id)).toBeDefined();
		await reopened.harness.close();
	});

	it("uses the latest durable operation evidence for receipt timestamps", async () => {
		const session = createSession("receipt-time");
		const execution = createFoundationExecution();
		const callerSnapshot = structuredClone(execution);
		const runtime = createModelsWithResponse();
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		expect(execution).toEqual(callerSnapshot);
		const result = await harness.prompt("timestamp evidence");
		expect(result.ok).toBe(true);
		const run = (await session.findRecords({ type: "operation_started", order: "oldestFirst" }))[0];
		if (!run) throw new Error("missing operation start");
		const records = (await session.findRecords({ lane: "main", runId: run.id, order: "oldestFirst" })).filter((record) => record.type !== "operation_finished");
		const entries = await session.view("main").findEntries({ order: "oldestFirst" });
		const latestEvidence = Math.max(run.timestamp, ...records.map((record) => record.timestamp), ...entries.filter((entry) => entry.seq >= run.seq).map((entry) => entry.timestamp));
		const receipt = (await facts(session)).find((record) => record.objectType === "run_receipt");
		expect(receipt).toBeDefined();
		const completedAt = (receipt?.payload as { completedAt: string }).completedAt;
		expect(completedAt).toBe(new Date(latestEvidence).toISOString());
		await harness.close();
	});

	it("keeps normalized Foundation graph and settlement inputs detached from the caller", async () => {
		const session = createSession("foundation-copy");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		const callerSnapshot = structuredClone(execution);
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		(execution.bindingEpochIds as string[]).push("caller-only-epoch");
		(execution.settlement!.tests as { name: string; required: boolean; status: "passed" | "failed" }[])[0]!.status = "failed";
		const result = await harness.prompt("detached inputs");
		expect(result.ok).toBe(true);
		expect(execution).not.toEqual(callerSnapshot);
		const receipt = (await facts(session)).find((record) => record.objectType === "attempt_receipt");
		const taskResult = (await facts(session)).find((record) => record.objectType === "task_result");
		expect((receipt?.payload as { bindingEpochIds: string[] }).bindingEpochIds).toEqual(callerSnapshot.bindingEpochIds);
		expect((taskResult?.payload as { status: string }).status).toBe("succeeded");
		await harness.close();
	});

	it("persists every mutable runtime setting and restores it", async () => {
		const session = createSession("configuration");
		const first = await AgentHarness.create({ session, ...createModelsWithResponse() });
		const harness = first.harness;
		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		await harness.setStreamOptions({ maxTokens: 10 });
		await harness.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 5 });
		await harness.setCompactionSettings({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });
		await harness.setSteeringMode("all");
		await harness.setFollowUpMode("all");
		await harness.setTools([{ name: "tool", label: "Tool" } as HarnessTool], ["tool"]);
		await harness.close();

		const second = await AgentHarness.create({ session, ...createModelsWithResponse() });
		expect(await second.harness.getResources()).toEqual(resources);
		expect(await second.harness.getStreamOptions()).toEqual({ maxTokens: 10 });
		expect(await second.harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 5 });
		expect(await second.harness.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });
		expect(await second.harness.getSteeringMode()).toBe("all");
		expect(await second.harness.getFollowUpMode()).toBe("all");
		expect(await second.harness.getActiveTools()).toEqual(["tool"]);
		await second.harness.close();
	});

	it("restores an abort request as an aborted terminal operation", async () => {
		const session = createSession("restore-abort");
		const runId = "restore-abort-run";
		await session.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		} satisfies NewRecord<OperationStartedRecord>);
		await session.appendRecord({ type: "abort_requested", id: "restore-abort-request", lane: "main", runId });
		const { harness } = await AgentHarness.create({ session, ...createModelsWithResponse() });
		await harness.resume();
		const finished = (await session.findRecords({ type: "operation_finished", runId, order: "oldestFirst" })).find((record) => record.type === "operation_finished");
		expect(finished?.outcome).toBe("aborted");
		expect(finished?.error?.code).toBe("user_aborted");
		await harness.close();
	});

	it("repairs a missing Foundation intent exactly once during restore", async () => {
		const session = createSession("restore-intent");
		const runId = "restore-intent-run";
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "resume me" }], timestamp: 1 };
		const target = { type: "message" as const, id: "restore-intent-user", message: user };
		await session.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [user], initialMessages: [target] },
		} satisfies NewRecord<OperationStartedRecord>);
		const execution = createFoundationExecution();
		const { harness } = await createFoundationHarness({ session, ...createModelsWithResponse(), foundationExecution: execution });
		const intents = await session.findFoundationRecords({ kind: "intent", objectType: "attempt", objectId: `attempt_${runId}`, order: "oldestFirst" });
		expect(intents).toHaveLength(1);
		await harness.close();
		const reopened = await createFoundationHarness({ session, ...createModelsWithResponse(), foundationExecution: execution });
		const replayedIntents = await session.findFoundationRecords({ kind: "intent", objectType: "attempt", objectId: `attempt_${runId}`, order: "oldestFirst" });
		expect(replayedIntents).toHaveLength(1);
		await reopened.harness.close();
	});

	it("fails convergence with a durable termination reason and records tool side effects", async () => {
		const session = createSession("convergence-failure");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		const tool: HarnessTool = {
			name: "loop-tool",
			label: "Loop tool",
			description: "Returns a deterministic result",
			parameters: { type: "object", properties: {}, additionalProperties: false } as HarnessTool["parameters"],
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {}, usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
		};
		models.streamSimple = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "loop-call", name: "loop-tool", arguments: {} }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "toolUse", message: response });
			return stream;
		};
		const { harness } = await AgentHarness.create({
			session,
			models,
			model: runtime.model,
			tools: [tool],
			streamOptions: { loopConvergence: { maxIterations: 1 } } as StreamOptions,
			foundationExecution: createFoundationExecution(),
		});
		const result = await harness.prompt("converge");
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(result.value.kind).toBe("failed");
		if (result.value.kind !== "failed") throw new Error("expected a failed convergence result");
		expect(result.value.error.code).toBe("agent_loop_max_iterations");
		const finished = (await session.findRecords({ type: "operation_finished", order: "oldestFirst" })).find((record) => record.type === "operation_finished");
		expect(finished?.outcome).toBe("failed");
		expect(finished?.error?.code).toBe("agent_loop_max_iterations");
		const attempt = (await facts(session)).find((record) => record.objectType === "attempt_receipt");
		expect((attempt?.payload as { sideEffectState: string }).sideEffectState).toBe("none");
		await harness.close();
	});

	it("fails a provider deadline closed with a stable error code", async () => {
		const session = createSession("provider-deadline");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		models.streamSimple = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "deadline" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				errorMessage: "Provider deadline exceeded",
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "aborted", error: response });
			return stream;
		};
		const { harness } = await createFoundationHarness({ session, models, model: runtime.model, foundationExecution: createFoundationExecution() });
		const result = await harness.prompt("deadline");
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(result.value.kind).toBe("failed");
		if (result.value.kind !== "failed") throw new Error("expected a failed deadline result");
		expect(result.value.error.code).toBe("deadline_exceeded");
		const finished = (await session.findRecords({ type: "operation_finished", order: "oldestFirst" })).find((record) => record.type === "operation_finished");
		expect(finished?.error?.code).toBe("deadline_exceeded");
		await harness.close();
	});

	it("reacquires an expired Foundation lease before completing receipts", async () => {
		const session = createSession("foundation-lease-refresh");
		const runtime = createModelsWithResponse();
		const originalAcquire = session.acquireWriterLease.bind(session);
		let acquireCalls = 0;
		session.acquireWriterLease = async (options) => {
			acquireCalls += 1;
			return originalAcquire(options);
		};
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: createFoundationExecution() });
		const initialAcquireCalls = acquireCalls;
		const originalRenew = session.renewWriterLease.bind(session);
		let renewCalls = 0;
		session.renewWriterLease = async (options) => {
			renewCalls += 1;
			if (renewCalls === 1) throw new DurableLedgerError("session_writer_lease_expired", "Injected Foundation lease expiry");
			return originalRenew(options);
		};
		const result = await harness.prompt("refresh lease");
		expect(result.ok).toBe(true);
		expect(acquireCalls).toBeGreaterThan(initialAcquireCalls);
		expect(renewCalls).toBeGreaterThan(0);
		expect((await resultFacts(session)).map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		await harness.close();
	});

	it("does not reacquire or continue after a non-lease Foundation storage fault", async () => {
		const session = createSession("foundation-lease-storage-fault");
		const runtime = createModelsWithResponse();
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: createFoundationExecution() });
		const originalAcquire = session.acquireWriterLease.bind(session);
		let acquireCalls = 0;
		session.acquireWriterLease = async (options) => {
			acquireCalls += 1;
			return originalAcquire(options);
		};
		session.renewWriterLease = async (options) => {
			throw new DurableLedgerError("session_ledger_storage", "Injected Foundation storage failure");
		};
		await expect(harness.prompt("storage fault")).rejects.toMatchObject({ name: "DurableLedgerError", code: "session_ledger_storage" });
		expect(acquireCalls).toBe(0);
		await expect(harness.prompt("faulted after storage fault")).rejects.toThrow("AgentHarness is faulted");
		await harness.close().catch(() => undefined);
	});

	it("fails closed when an active operation final snapshot refresh fails", async () => {
		const session = createSession("active-final-refresh-fault");
		const runtime = createModelsWithResponse();
		const originalAppendRecord = session.appendRecord.bind(session);
		const originalGetLanes = session.getLanes.bind(session);
		let armed = false;
		let postFinishedReads = 0;
		let injected = false;
		session.appendRecord = async (record) => {
			const accepted = await originalAppendRecord(record);
			if (record.type === "operation_finished") armed = true;
			return accepted;
		};
		session.getLanes = async () => {
			if (armed) {
				postFinishedReads += 1;
				if (!injected && postFinishedReads === 6) {
					injected = true;
					throw new SessionError("storage", "Injected final snapshot refresh failure");
				}
			}
			return originalGetLanes();
		};
		const { harness } = await AgentHarness.create({ session, models: runtime.models, model: runtime.model });
		await expect(harness.prompt("final refresh fault")).rejects.toMatchObject({ name: "SessionError", code: "storage" });
		expect(injected).toBe(true);
		await expect(harness.prompt("faulted harness must reject")).rejects.toThrow("AgentHarness is faulted");
		await harness.close().catch(() => undefined);
	});

	it("fails a recovered tool with side effect unknown when its result is absent", async () => {
		const session = createSession("missing-tool-result");
		const runId = "missing-tool-result-run";
		const user = { role: "user" as const, content: [{ type: "text" as const, text: "tool recovery" }], timestamp: 1 };
		const userEntry = { type: "message" as const, id: "missing-tool-user", message: user };
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "missing-call", name: "missing-tool", arguments: {} }],
			api: "google-generative-ai" as const,
			provider: "google",
			model: "gemini-2.5-flash",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse" as const,
			timestamp: 2,
		};
		const assistantEntry = { type: "message" as const, id: "missing-tool-assistant", message: assistant };
		await session.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [user], initialMessages: [userEntry] },
		} satisfies NewRecord<OperationStartedRecord>);
		await session.appendEntry(userEntry, "main");
		await session.appendRecord({ type: "step_attempt", id: "missing-tool-step", lane: "main", runId, step: "assistant", attempt: 1, resultEntryId: assistantEntry.id });
		await session.appendEntry(assistantEntry, "main");
		await session.appendRecord({ type: "tool_started", id: "missing-tool-start", lane: "main", runId, assistantEntryId: assistantEntry.id, toolIndex: 0, toolCallId: "missing-call", toolName: "missing-tool", effectiveArgs: {}, resultEntryId: "missing-tool-result", replay: "never" });
		const runtime = createModelsWithResponse();
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: createFoundationExecution() });
		await harness.runToCompletion();
		const attempt = (await facts(session)).find((record) => record.objectType === "attempt_receipt");
		expect((attempt?.payload as { sideEffectState: string }).sideEffectState).toBe("side_effect_unknown");
		const finished = (await session.findRecords({ type: "operation_finished", runId, order: "oldestFirst" })).find((record) => record.type === "operation_finished");
		expect(finished?.outcome).toBe("failed");
		await harness.close();
	});

	it("makes action execution and close deterministic", async () => {
		const session = createSession("actions");
		const { models, model } = createModelsWithResponse();
		const { harness } = await AgentHarness.create({ session, models, model, drive: "manual" });
		const prompt: AgentMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
		const started = await harness.prompt(prompt);
		expect(started.ok).toBe(true);
		await harness.runToCompletion();
		const records = await session.findRecords({ order: "oldestFirst" });
		expect(records.some((record) => record.type === "operation_started")).toBe(true);
		expect(records.some((record) => record.type === "operation_finished")).toBe(true);
		await harness.close();
		await expect(harness.waitForIdle()).rejects.toThrow("AgentHarness was closed");
	});

	it("binds lane actions to one harness authority", async () => {
		const session = createSession("lanes");
		const { models, model } = createModelsWithResponse();
		const { harness } = await AgentHarness.create({ session, models, model });
		const created = await harness.createLane("branch", null);
		expect(created.ok).toBe(true);
		if (!created.ok) throw created.error;
		const branch = created.value;
		expect(branch.name).toBe("branch");
		expect((await harness.lane("branch"))?.name).toBe("branch");
		expect((await branch.nextRun("queued")).ok).toBe(true);
		expect((await branch.prompt("hello")).ok).toBe(true);
		expect((await branch.navigateTree(null)).ok).toBe(true);
		const branchRecords = await session.findRecords({ lane: "branch", order: "oldestFirst" });
		expect(branchRecords.some((record) => record.type === "operation_started" && record.intent.kind === "run")).toBe(true);
		expect(branchRecords.some((record) => record.type === "operation_started" && record.intent.kind === "navigation")).toBe(true);
		expect((await branch.getLeafId())).toBeNull();
		await harness.close();
	});

	it("keeps reducer configuration getters isolated across lanes", async () => {
		const session = createSession("lane-config");
		const { models, model: mainModel } = createModelsWithResponse();
		const branchModel = getModel("google", "gemini-2.5-pro");
		const { harness } = await AgentHarness.create({ session, models, model: mainModel });
		const created = await harness.createLane("branch", null);
		expect(created.ok).toBe(true);
		if (!created.ok) throw created.error;
		const branch = created.value;
		await harness.setModel(mainModel);
		await branch.setModel(branchModel);
		await harness.setThinkingLevel("low");
		await branch.setThinkingLevel("high");
		await harness.setActiveTools(["main-tool"]);
		await branch.setActiveTools(["branch-tool"]);
		expect((await harness.getModel()).id).toBe(mainModel.id);
		expect((await branch.getModel()).id).toBe(branchModel.id);
		expect(await harness.getThinkingLevel()).toBe("low");
		expect(await branch.getThinkingLevel()).toBe("high");
		expect(await harness.getActiveTools()).toEqual(["main-tool"]);
		expect(await branch.getActiveTools()).toEqual(["branch-tool"]);
		await harness.close();
	});

	it("returns manual operations as pending intents and drives them explicitly", async () => {
		const session = createSession("manual");
		const { models, model } = createModelsWithResponse();
		const { harness } = await AgentHarness.create({ session, models, model, drive: "manual" });
		const pending = await harness.prompt("hello");
		expect(pending.ok).toBe(true);
		if (!pending.ok) throw pending.error;
		expect(pending.value.kind).toBe("pending");
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(0);
		expect(await harness.peekAction()).toBeDefined();
		await harness.runToCompletion();
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(1);
		const compact = await harness.compact();
		expect(compact.ok).toBe(true);
		if (!compact.ok) throw compact.error;
		expect(compact.value.kind).toBe("pending");
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(1);
		await harness.runToCompletion();
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(2);
		const navigation = await harness.navigateTree(null);
		expect(navigation.ok).toBe(true);
		if (!navigation.ok) throw navigation.error;
		expect(navigation.value.kind).toBe("pending");
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(2);
		await harness.runToCompletion();
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(3);
		await harness.close();
	});

	it("produces an equivalent durable transcript when manual actions are driven", async () => {
		const automaticSession = createSession("equivalent-automatic");
		const manualSession = createSession("equivalent-manual");
		const automatic = await AgentHarness.create({ session: automaticSession, ...createModelsWithResponse() });
		const manual = await AgentHarness.create({ session: manualSession, ...createModelsWithResponse(), drive: "manual" });
		const automaticResult = await automatic.harness.prompt("hello");
		const manualResult = await manual.harness.prompt("hello");
		expect(automaticResult.ok && manualResult.ok).toBe(true);
		if (!manualResult.ok) throw manualResult.error;
		expect(manualResult.value.kind).toBe("pending");
		await manual.harness.runToCompletion();
		const stripIdentity = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stripIdentity);
			if (typeof value !== "object" || value === null) return value;
			const object = value as Record<string, unknown>;
			return Object.fromEntries(Object.entries(object).filter(([key]) => !["id", "seq", "timestamp", "parentId", "runId", "attemptId", "attemptReceiptId", "taskResultId", "runReceiptId", "entryId", "resultEntryId"].includes(key)).map(([key, item]) => [key, stripIdentity(item)]));
		};
		expect(stripIdentity(await automaticSession.getLog())).toEqual(stripIdentity(await manualSession.getLog()));
		await automatic.harness.close();
		await manual.harness.close();
	});

	it("keeps lane execution concurrent and routes abort/steer to the requested lane", async () => {
		const session = createSession("lane-concurrency");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		const mainStarted = deferred<void>();
		const releaseMain = deferred<void>();
		models.streamSimple = (requestModel, context) => {
			const stream = createAssistantMessageEventStream();
			const isBlocked = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("main-blocked"));
			void (async () => {
				if (isBlocked) {
					mainStarted.resolve();
					await releaseMain.promise;
				}
				stream.push({ type: "done", reason: "stop", message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} });
			})();
			return stream;
		};
		const { harness } = await AgentHarness.create({ session, models, model: runtime.model });
		const created = await harness.createLane("branch", null);
		expect(created.ok).toBe(true);
		if (!created.ok) throw created.error;
		const mainPrompt = harness.promptOnLane("main", "main-blocked");
		await mainStarted.promise;
		const branchPrompt = harness.promptOnLane("branch", "branch-fast");
		const branchFinished = await Promise.race([branchPrompt.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
		expect(branchFinished).toBe(true);
		const steer = await harness.steerOnLane("main", "steer-main");
		expect(steer.ok).toBe(true);
		const abortFinished = await Promise.race([harness.abortOnLane("main").then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
		expect(abortFinished).toBe(true);
		releaseMain.resolve();
		await Promise.all([mainPrompt, branchPrompt]);
		const mainRecords = await session.findRecords({ lane: "main", order: "oldestFirst" });
		const branchRecords = await session.findRecords({ lane: "branch", order: "oldestFirst" });
		expect(mainRecords.some((record) => record.type === "abort_requested")).toBe(true);
		expect(mainRecords.some((record) => record.type === "queue_enqueued" && record.queue === "steer")).toBe(true);
		expect(branchRecords.every((record) => record.lane === "branch")).toBe(true);
		await harness.close();
	});

	it("runs compaction outside the mutation queue and propagates abort", async () => {
		const session = createSession("compaction-abort");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		const started = deferred<void>();
		let signal: AbortSignal | undefined;
		models.completeSimple = async (requestModel, _context, options) => {
			signal = options?.signal;
			started.resolve();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				timestamp: Date.now(),
			};
		};
		const { harness } = await AgentHarness.create({ session, models, model: runtime.model, drive: "manual" });
		const prompt = await harness.prompt("history");
		expect(prompt.ok).toBe(true);
		await harness.runToCompletion();
		const compact = await harness.compact();
		expect(compact.ok).toBe(true);
		const action = harness.executeAction();
		await started.promise;
		expect(signal).toBeDefined();
		const close = harness.close();
		const closed = await Promise.race([close.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
		expect(closed).toBe(true);
		expect(signal?.aborted).toBe(true);
		await action;
	});

	it("persists deferred redemption intent/result and passes its abort signal", async () => {
		const session = createSession("deferred-redemption");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		const handle: DeferredHandle = { provider: runtime.model.provider, modelId: runtime.model.id, api: runtime.model.api, id: "deferred-response-1" };
		let fetchSignal: AbortSignal | undefined;
		models.streamSimple = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "pending" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "deferred",
				deferred: handle,
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "deferred", message: response });
			return stream;
		};
		models.fetchDeferred = async (requestModel, _handle, options) => {
			fetchSignal = options?.signal;
			return {
				role: "assistant",
				content: [{ type: "text", text: "redeemed" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
		};
		const { harness } = await AgentHarness.create({ session, models, model: runtime.model });
		const result = await harness.prompt("deferred");
		expect(result.ok).toBe(true);
		expect(fetchSignal).toBeDefined();
		const custom = (await session.view("main").findEntries({ customType: "harness.deferred_fetch.intent", order: "oldestFirst" })).filter((entry) => entry.type === "custom");
		const redemption = (await session.view("main").findEntries({ customType: "harness.deferred_fetch.result", order: "oldestFirst" })).filter((entry) => entry.type === "custom");
		expect(custom).toHaveLength(1);
		expect(redemption).toHaveLength(1);
		expect((redemption[0]?.data as { responseEntryId: string }).responseEntryId).toBeDefined();
		await harness.close();
	});

	it("replays a partial Foundation receipt after an injected durable storage fault", async () => {
		const session = createSession("receipt-partial-task");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		const first = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		injectFoundationFault(session, "task_result", "before");
		await expect(first.harness.prompt("partial task receipt")).rejects.toMatchObject({ name: "DurableLedgerError", code: "session_ledger_storage" });
		await expect(first.harness.prompt("faulted harness must reject")).rejects.toThrow("AgentHarness is faulted");
		const before = await facts(session);
		expect(before.filter((record) => RESULT_FACT_TYPES.has(record.objectType)).map((record) => record.objectType)).toEqual(["attempt_receipt"]);
		await first.harness.close().catch(() => undefined);

		const restored = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		const resumed = await restored.harness.resume();
		expect(resumed.ok).toBe(true);
		const after = await facts(session);
		expect(after.filter((record) => RESULT_FACT_TYPES.has(record.objectType)).map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		expect(after.find((record) => record.objectType === "attempt_receipt")?.payload).toEqual(before.find((record) => record.objectType === "attempt_receipt")?.payload);
		await restored.harness.close();
	});

	it("rejects a conflicting Foundation intent during restore before replay", async () => {
		const session = createSession("receipt-conflict");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		const first = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		injectFoundationFault(session, "task_result", "before");
		await expect(first.harness.prompt("receipt conflict")).rejects.toMatchObject({ name: "DurableLedgerError", code: "session_ledger_storage" });
		const before = await facts(session);
		const revision = await session.getLedgerRevision();
		await first.harness.close().catch(() => undefined);

		const conflicting = createFoundationExecution();
		conflicting.providerId = "conflicting-agent-provider";
		conflicting.dispatch.taskExecutorProviderId = "conflicting-agent-provider";
		conflicting.agentInstance!.providerId = "conflicting-agent-provider";
		await expect(createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: conflicting })).rejects.toThrow("An immutable Foundation fact already exists with different content");
		expect(await facts(session)).toEqual(before);
		expect(await session.getLedgerRevision()).toBe(revision);
	});

	it("rejects recovery when an existing terminal receipt no longer matches its intent correlation", async () => {
		const session = createSession("receipt-correlation-conflict");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		const first = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		injectFoundationFault(session, "task_result", "before");
		await expect(first.harness.prompt("receipt correlation conflict")).rejects.toMatchObject({ name: "DurableLedgerError", code: "session_ledger_storage" });
		await first.harness.close().catch(() => undefined);

		const originalGetFoundationObject = session.getFoundationObject.bind(session);
		session.getFoundationObject = async (objectType, objectId) => {
			const object = await originalGetFoundationObject(objectType, objectId);
			if (objectType !== "attempt_receipt" || object === undefined || object.kind !== "fact" || object.payload === null || typeof object.payload !== "object" || Array.isArray(object.payload)) return object;
			const payload = structuredClone(object.payload) as Record<string, unknown>;
			if (payload.provenance === null || typeof payload.provenance !== "object" || Array.isArray(payload.provenance)) return object;
			payload.providerId = "tampered-agent-provider";
			(payload.provenance as Record<string, unknown>).providerId = "tampered-agent-provider";
			return { ...object, payload: payload as FoundationJsonValue };
		};
		try {
		const restored = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
			await expect(restored.harness.resume()).rejects.toThrow("Existing AttemptReceipt conflicts with its deterministic reconstruction");
			await restored.harness.close().catch(() => undefined);
		} finally {
			session.getFoundationObject = originalGetFoundationObject;
		}
	});

	it("replays a run receipt after a post-write durable storage fault", async () => {
		const session = createSession("receipt-partial-run");
		const runtime = createModelsWithResponse();
		const execution = createFoundationExecution();
		const first = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		injectFoundationFault(session, "run_receipt", "after");
		await expect(first.harness.prompt("partial run receipt")).rejects.toMatchObject({ name: "DurableLedgerError", code: "session_ledger_storage" });
		const before = await facts(session);
		expect(before.filter((record) => RESULT_FACT_TYPES.has(record.objectType)).map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		await first.harness.close().catch(() => undefined);

		const restored = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: execution });
		const resumed = await restored.harness.resume();
		expect(resumed.ok).toBe(true);
		const after = await facts(session);
		expect(after.filter((record) => RESULT_FACT_TYPES.has(record.objectType)).map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		for (const objectType of ["attempt_receipt", "task_result", "run_receipt"] as const) {
			expect(after.find((record) => record.objectType === objectType)?.payload).toEqual(before.find((record) => record.objectType === objectType)?.payload);
		}
		await restored.harness.close();
	});

	it("passes the lane operation signal to navigation summarization", async () => {
		const session = createSession("navigation-summary-signal");
		const runtime = createModelsWithResponse();
		const models = Object.create(runtime.models) as Models;
		const started = deferred<void>();
		let signal: AbortSignal | undefined;
		models.completeSimple = async (requestModel, _context, options) => {
			signal = options?.signal;
			started.resolve();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				timestamp: Date.now(),
			};
		};
		const { harness } = await AgentHarness.create({ session, models, model: runtime.model, drive: "manual" });
		const prompt = await harness.prompt("branch history");
		expect(prompt.ok).toBe(true);
		await harness.runToCompletion();
		const navigation = await harness.navigateTree(null, { summarize: true });
		expect(navigation.ok).toBe(true);
		const action = harness.executeAction();
		await started.promise;
		expect(signal).toBeDefined();
		const close = harness.close();
		const closed = await Promise.race([close.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
		expect(closed).toBe(true);
		expect(signal?.aborted).toBe(true);
		await action;
	});

	it("does not fabricate host settlement and rejects unestablished execution graphs", async () => {
		const runtime = createModelsWithResponse();
		const base = createFoundationExecution();
		const { settlement: _settlement, hostAuthority: _authority, ...executorOnly } = base;
		const session = createSession("executor-only");
		const { harness } = await createFoundationHarness({ session, models: runtime.models, model: runtime.model, foundationExecution: executorOnly });
		const run = await harness.prompt("executor only");
		expect(run.ok).toBe(true);
		expect((await session.findFoundationRecords({ kind: "fact" })).filter((record) => record.kind === "fact").map((record) => record.objectType)).toEqual(["attempt_receipt"]);
		await harness.close();

		const invalid = structuredClone(base);
		(invalid.binding as { fingerprint: { algorithm: string; value: string } }).fingerprint.value = "invalid";
		await expect(createFoundationHarness({ session: createSession("invalid-binding"), models: runtime.models, model: runtime.model, foundationExecution: invalid })).rejects.toThrow("established immutable AgentBinding");
		const mismatch = structuredClone(base);
		mismatch.providerId = "other-provider";
		await expect(createFoundationHarness({ session: createSession("provider-mismatch"), models: runtime.models, model: runtime.model, foundationExecution: mismatch })).rejects.toThrow("provider does not match");
	});

	it("drives the public Foundation lifecycle gates through a consumer-shaped provider", async () => {
		const settledSession = createSession("public-lifecycle-settle");
		const settledExecution = createFoundationExecution();
		const callerAgentInstance = settledExecution.agentInstance;
		if (callerAgentInstance === undefined) throw new Error("missing test AgentInstance");
		settledExecution.agentInstance = { ...callerAgentInstance, roleRevision: { ...callerAgentInstance.roleRevision, fingerprint: { algorithm: "sha256", value: "caller-forged-role-fingerprint" } } };
		const settled = await createFoundationHarness({ session: settledSession, ...createModelsWithResponse(), drive: "manual", foundationExecution: settledExecution });
		const pending = await settled.harness.prompt("start and settle");
		expect(pending).toMatchObject({ ok: true, value: { kind: "pending" } });
		expect(settled.provider.createCount).toBe(1);
		expect(settled.provider.receivedRoleRevision).toEqual(foundationRoleRevision());
		expect(settled.provider.receivedModelProfile).toEqual(foundationModelProfile());
		expect(settled.provider.receivedModelRoute).toEqual({ provider: "google", model: "gemini-2.5-flash" });
		expect(settled.provider.receivedBinding?.modelRoute).toEqual({ provider: "google", model: "gemini-2.5-flash" });
		expect(settled.provider.receivedAgentInstance?.roleRevision).toEqual({ schemaVersion: 1, type: "role_revision", id: "role-revision", revision: 1, fingerprint: foundationRoleRevision().fingerprint });
		expect(settled.provider.runCount).toBe(0);
		await settled.harness.runToCompletion();
		expect(settled.provider.runCount).toBe(1);
		expect(await settledSession.findFoundationRecords({ kind: "fact", objectType: "task_result", order: "oldestFirst" })).toHaveLength(1);
		expect(await settledSession.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" })).toHaveLength(1);
		await settled.harness.close();

		const failure = await createFoundationHarness({ session: createSession("public-lifecycle-failure"), ...createModelsWithResponse(), foundationExecution: createFoundationExecution() });
		failure.provider.failCreate = true;
		await expect(failure.harness.prompt("provider failure")).rejects.toThrow("create failed");
		await failure.harness.close();

		const cancelled = await createFoundationHarness({ session: createSession("public-lifecycle-cancel"), ...createModelsWithResponse(), drive: "manual", foundationExecution: createFoundationExecution() });
		await cancelled.harness.prompt("cancel");
		await cancelled.harness.abort();
		expect(cancelled.provider.cancelCount).toBe(1);
		await cancelled.harness.close();

		const resumedSession = createSession("public-lifecycle-resume");
		const first = await createFoundationHarness({ session: resumedSession, ...createModelsWithResponse(), drive: "manual", foundationExecution: createFoundationExecution() });
		await first.harness.prompt("resume");
		await first.harness.close();
		const reopened = await createFoundationHarness({ session: resumedSession, ...createModelsWithResponse(), foundationExecution: createFoundationExecution() });
		const resumed = await reopened.harness.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run" } });
		expect(reopened.provider.resumeCount).toBe(1);
		await reopened.harness.close();
	});
});
