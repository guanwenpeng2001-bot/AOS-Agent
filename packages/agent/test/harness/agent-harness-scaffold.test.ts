import { createAssistantMessageEventStream, createModels, type Api, type Model, type Models } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentHarnessFoundationExecution,
	type HarnessTool,
	type Resources,
} from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
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

function createFoundationExecution(): AgentHarnessFoundationExecution {
	const taskId = "task-harness-runtime";
	const bindingId = "binding-harness-runtime";
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
		binding: {
			schemaVersion: 1,
			bindingId,
			taskId,
			roleRevision: { schemaVersion: 1, type: "role_revision", id: "role-revision", revision: 1 },
			modelProfileRevision: { schemaVersion: 1, type: "model_profile_revision", id: "model-profile", revision: 1 },
			modelRoute: { provider: "google", model: "gemini-2.5-flash" },
			contextRevision: { schemaVersion: 1, type: "context_revision", id: "context", revision: 1 },
			capabilityRevision: { schemaVersion: 1, type: "capability_revision", id: "capability", revision: 1 },
			policyRevision: { schemaVersion: 1, type: "policy_revision", id: "policy", revision: 1 },
			capabilitySelector: { policy: "none" },
			budget: {},
			sourceTrace: [],
			conflicts: [],
			fingerprint: { algorithm: "sha256", value: "binding-fingerprint" },
			resolvedAt: "2026-01-01T00:00:00.000Z",
		},
		providerId: "agent-harness-provider",
		agentInstanceId: "agent-instance-harness-runtime",
		bindingEpochIds: ["binding-epoch-harness-runtime"],
		settlement: {
			tests: [{ name: "harness runtime", required: true, status: "passed" }],
			evidence: [],
		},
	};
}

describe("AgentHarness runtime", () => {
	it("drives a public prompt and persists correlated receipts", async () => {
		const session = createSession();
		const { models, model } = createModelsWithResponse();
		const { harness } = await AgentHarness.create({ session, models, model, foundationExecution: createFoundationExecution() });

		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		expect(facts.map((record) => record.objectType)).toEqual(["attempt_receipt", "task_result", "run_receipt"]);
		expect(facts.every((record) => record.correlation.sessionId === "session" && record.correlation.taskId === "task-harness-runtime")).toBe(true);
		expect((facts[0]?.payload as { attemptReceiptId: string }).attemptReceiptId).toContain("attempt_receipt_");
		expect((facts[1]?.payload as { sourceAttemptReceiptIds: string[] }).sourceAttemptReceiptIds).toHaveLength(1);
		expect((facts[2]?.payload as { taskResultId?: string }).taskResultId).toContain("task_result_");
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
});
