import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@aos-agent/ai";
import {
	canonicalFoundationJson,
	createContextSnapshot,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	projectTaskEnvelope,
	type AgentMessage,
	type ContextSnapshot,
	type Entry,
	type RoleRevision,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import {
	forkChildContextV1,
	TASK_PACKAGE_CRITERION_MAX_CHARS,
	TASK_PACKAGE_GOAL_MAX_CHARS,
	TASK_PACKAGE_MAX_ARTIFACTS,
	TASK_PACKAGE_MAX_CRITERIA,
	validateChildContextForkPlanV1,
	type ForkChildContextInputV1,
} from "../src/core/subagent-context-fork.ts";

const ARTIFACT_DIGEST = `sha256:${"cd".repeat(32)}`;

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "model-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

function messageEntry(id: string, text: string, seq: number, parentId: string | null, role: "user" | "assistant" = "user"): Entry {
	return {
		type: "message",
		id,
		seq,
		parentId,
		timestamp: seq,
		message: role === "assistant" ? assistantMessage(text, seq) : userMessage(text, seq),
	};
}

function safeToolParentSnapshot(): ContextSnapshot {
	const entries: Entry[] = [
		messageEntry("turn-0-user", "parent turn 0", 1, null),
		{
			type: "message",
			id: "turn-0-tool",
			seq: 2,
			parentId: "turn-0-user",
			timestamp: 2,
			message: {
				role: "toolResult",
				toolCallId: "call-safe",
				toolName: "read",
				content: [{ type: "text", text: "file-bytes" }],
				details: { bytes: 9, truncated: false },
				isError: false,
				timestamp: 2,
			},
		},
		messageEntry("turn-0-assistant", "parent reply 0", 3, "turn-0-tool", "assistant"),
	];
	return createContextSnapshot(entries, {
		bindingEpochId: "epoch-parent",
		forkMode: "all",
		source: { sourceId: "parent-session", kind: "session", trust: "user_owned" },
		budget: { maxTokens: 100_000 },
	});
}

function mixedParentSnapshot(): ContextSnapshot {
	const entries: Entry[] = [
		{ type: "thinking_level_change", id: "sys-think", seq: 1, parentId: null, timestamp: 1, thinkingLevel: "low" },
		messageEntry("turn-0-user", "parent turn 0", 2, "sys-think"),
		messageEntry("turn-0-assistant", "parent reply 0", 3, "turn-0-user", "assistant"),
		messageEntry("turn-1-user", "parent turn 1", 4, "turn-0-assistant"),
		messageEntry("turn-1-assistant", "parent reply 1", 5, "turn-1-user", "assistant"),
		messageEntry("turn-2-user", "parent turn 2", 6, "turn-1-assistant"),
		{
			type: "message",
			id: "turn-2-tool",
			seq: 7,
			parentId: "turn-2-user",
			timestamp: 7,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "secret-tool-output" }],
				details: { env: { TOKEN: "secret-token" } },
				isError: false,
				timestamp: 7,
			},
		},
		messageEntry("turn-2-assistant", "parent reply 2", 8, "turn-2-tool", "assistant"),
		{ type: "model_change", id: "sys-model", seq: 9, parentId: "turn-2-assistant", timestamp: 9, provider: "fake", modelId: "model-1" },
	];
	return createContextSnapshot(entries, {
		bindingEpochId: "epoch-parent",
		forkMode: "all",
		source: { sourceId: "parent-system", kind: "system", trust: "builtin" },
		sources: [
			{ sourceId: "parent-system", kind: "system", trust: "builtin", digest: `sha256:${"11".repeat(32)}`, estimatedTokens: 0, disposition: "included" },
			{ sourceId: "parent-instruction", kind: "instruction", trust: "builtin", digest: `sha256:${"22".repeat(32)}`, estimatedTokens: 0, disposition: "included" },
			{ sourceId: "parent-session", kind: "session", trust: "user_owned", digest: `sha256:${"33".repeat(32)}`, estimatedTokens: 0, disposition: "included" },
		],
		budget: { maxTokens: 100_000 },
	});
}

function parentSnapshot(entryCount = 4): ContextSnapshot {
	const entries: Entry[] = [];
	for (let index = 0; index < entryCount; index++) {
		entries.push(messageEntry(`turn-${index}`, `parent turn ${index} ${"token ".repeat(20)}`, index + 1, index === 0 ? null : `turn-${index - 1}`));
	}
	return createContextSnapshot(entries, {
		bindingEpochId: "epoch-parent",
		forkMode: "all",
		source: { sourceId: "parent-session", kind: "session", trust: "user_owned" },
		budget: { maxTokens: 100_000 },
	});
}

function childRole(persona = "You are the child."): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "child-role",
			scope: "project",
			slug: "child",
			name: "Child",
			description: "Child worker",
			revision: 1,
			persona,
			customInstructions: "Stay in the child task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function artifacts(count: number, prefix: string) {
	return Array.from({ length: count }, (_value, index) => ({
		schemaVersion: 1 as const,
		artifactId: `${prefix}-${index + 1}`,
		mediaType: "text/plain",
		digest: ARTIFACT_DIGEST,
	}));
}

function criteria(count: number, description: string) {
	return Array.from({ length: count }, (_value, index) => ({
		schemaVersion: 1 as const,
		criterionId: `criterion-${index + 1}`,
		description,
		satisfiedBy: "evidence" as const,
		required: true,
	}));
}

function childTask(
	taskId = "task-child",
	goal = "complete the child task",
	overrides: Partial<Pick<TaskEnvelope, "inputs" | "expectedOutputs" | "acceptanceCriteria">> = {},
): TaskEnvelope {
	const result = createTaskEnvelope({
		schemaVersion: 1,
		taskId,
		goalId: "goal-1",
		goal,
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: overrides.inputs ?? [{ schemaVersion: 1, artifactId: "in-1", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
		expectedOutputs: overrides.expectedOutputs ?? [{ schemaVersion: 1, artifactId: "out-1", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
		budget: { tokens: 4000 },
		acceptanceCriteria: overrides.acceptanceCriteria ?? [{ schemaVersion: 1, criterionId: "criterion-1", description: "done", satisfiedBy: "evidence", required: true }],
		status: "ready",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function forkTaskPackage(task: TaskEnvelope, childTokenBudget = 1_000_000) {
	const projection = projectTaskEnvelope(task);
	return forkChildContextV1(
		forkInput({
			forkScope: "task_package",
			taskPackageRef: "pkg-1",
			childTaskEnvelope: task,
			childTokenBudget,
			persistedTaskPackage: {
				ref: "pkg-1",
				digest: fingerprintFoundationValue(projection),
				projection,
			},
		}),
	);
}

function forkInput(overrides: Partial<ForkChildContextInputV1> = {}): ForkChildContextInputV1 {
	const parent = overrides.parentSnapshot ?? parentSnapshot();
	return {
		schemaVersion: 1,
		spawnId: "spawn-fork-1",
		forkScope: "none",
		childRoleRevision: childRole(),
		childTaskEnvelope: childTask(),
		childBindingEpochId: "epoch-child",
		childTokenBudget: 50_000,
		...overrides,
		parentSnapshot: parent,
	};
}

function assertRuntimeProjection(result: { runtimeProjection: { persona: string; customInstructions: string; goal: string; acceptanceCriteria: readonly unknown[]; inputs: readonly { artifactId: string }[]; expectedOutputs: readonly { artifactId: string }[] }; snapshot: ContextSnapshot; record: { summary?: unknown; summaryDigest?: string } }) {
	expect(Object.isFrozen(result.runtimeProjection)).toBe(true);
	expect(result.runtimeProjection.persona).toBe("You are the child.");
	expect(result.runtimeProjection.customInstructions).toBe("Stay in the child task.");
	expect(result.runtimeProjection.goal).toBe("complete the child task");
	expect(result.runtimeProjection.acceptanceCriteria).toEqual([
		{ criterionId: "criterion-1", description: "done", required: true, satisfiedBy: "evidence" },
	]);
	expect(result.runtimeProjection.inputs.map((item) => item.artifactId)).toEqual(["in-1"]);
	expect(result.runtimeProjection.expectedOutputs.map((item) => item.artifactId)).toEqual(["out-1"]);
	expect(result.record).not.toHaveProperty("summary");
	expect(result.record.summaryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(result.snapshot.summary()).toContain("You are the child.");
}

function assertNoUserDowngrade(snapshot: ContextSnapshot) {
	for (const message of snapshot.messages()) {
		const encoded = JSON.stringify(message);
		if (message.role === "user") {
			expect(encoded).not.toContain("You are the child.");
			expect(encoded).not.toContain("Stay in the child task.");
			expect(encoded).not.toContain("complete the child task");
		}
	}
	expect(snapshot.entries().some((entry) => entry.id.includes("instruction") || entry.id.includes("-task"))).toBe(false);
}

function assertValidChain(entries: readonly Entry[]) {
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		expect(ids.has(entry.id)).toBe(false);
		ids.add(entry.id);
		if (index === 0) expect(entry.parentId).toBeNull();
		else expect(entry.parentId).toBe(entries[index - 1]!.id);
		expect(entry.seq).toBe(index + 1);
	}
}

describe("child context fork", () => {
	it("creates a none runtime projection without parent conversation or user-role downgrade", () => {
		const parent = parentSnapshot();
		const originalDigest = parent.digest;
		const result = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "none" }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(validateChildContextForkPlanV1(result.value.plan)).toBe(true);
		expect(result.value.record.forkMode).toBe("none");
		expect(result.value.snapshot.entries()).toEqual([]);
		expect(result.value.snapshot.messages()).toEqual([]);
		assertRuntimeProjection(result.value);
		assertNoUserDowngrade(result.value.snapshot);
		const instructionTokens = result.value.record.sources.find((source) => source.kind === "instruction")?.estimatedTokens ?? 0;
		const taskTokens = result.value.record.sources.find((source) => source.kind === "task")?.estimatedTokens ?? 0;
		expect(instructionTokens).toBeGreaterThan(0);
		expect(taskTokens).toBeGreaterThan(0);
		expect(result.value.snapshot.budget.usedTokens + instructionTokens + taskTokens).toBeLessThanOrEqual(result.value.plan.tokenBudget);
		const durable = JSON.stringify(result.value.record);
		expect(durable).not.toContain("You are the child.");
		expect(durable).not.toContain("Stay in the child task.");
		expect(durable).not.toContain("complete the child task");
		expect(durable).not.toContain("workspace-1");
		expect(durable).not.toContain("secret");
		expect(result.value.record).not.toHaveProperty("messages");
		expect(result.value.record).not.toHaveProperty("transcript");
		expect(parent.digest).toBe(originalDigest);
	});

	it("clones the full parent chain unchanged and keeps the child layer separate", () => {
		const parent = parentSnapshot();
		const before = parent.toJSON();
		const parentIds = parent.entries().map((entry) => ({ id: entry.id, seq: entry.seq, parentId: entry.parentId }));
		const result = forkChildContextV1(
			forkInput({
				parentSnapshot: parent,
				forkScope: "all",
				sourceContextDigest: { algorithm: "sha256", value: parent.digest.replace(/^sha256:/, "") },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(result.value.record.forkMode).toBe("all");
		expect(canonicalFoundationJson(result.value.snapshot.entries())).toBe(canonicalFoundationJson(parent.entries()));
		expect(result.value.snapshot.trust).toBe(parent.trust);
		expect(result.value.record.sources.slice(0, parent.sources().length).map((source) => ({ sourceId: source.sourceId, kind: source.kind, trust: source.trust }))).toEqual(
			parent.sources().map((source) => ({ sourceId: source.sourceId, kind: source.kind, trust: source.trust })),
		);
		expect(result.value.record.sources.map((source) => source.sourceId).slice(-2)).toEqual(["child-role-instructions", "child-task-envelope"]);
		expect(result.value.snapshot.entries().map((entry) => ({ id: entry.id, seq: entry.seq, parentId: entry.parentId }))).toEqual(parentIds);
		expect(JSON.stringify(result.value.snapshot.messages())).toContain("parent turn 0");
		assertRuntimeProjection(result.value);
		assertNoUserDowngrade(result.value.snapshot);
		expect(result.value.snapshot.entries()).not.toBe(parent.entries());
		expect(result.value.snapshot.entries()[0]).not.toBe(parent.entries()[0]);
		expect(parent.toJSON()).toEqual(before);
		expect(JSON.stringify(result.value.record)).not.toContain("parent turn 0");
		expect(JSON.stringify(result.value.record)).not.toContain("You are the child.");
	});

	it("keeps the system/control layer and last N full turns with a valid relinked chain", () => {
		const parent = mixedParentSnapshot();
		const rawTail = parent.entries().slice(-2).map((entry) => entry.id);
		expect(rawTail).toEqual(["turn-2-assistant", "sys-model"]);
		const result = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "recent_n", recentN: 2 }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(result.value.record.forkMode).toBe("recent-N");
		expect(result.value.plan.recentN).toBe(2);
		const ids = result.value.snapshot.entries().map((entry) => entry.id);
		expect(ids).toEqual(["sys-think", "turn-1-user", "turn-1-assistant", "turn-2-user", "turn-2-tool", "turn-2-assistant", "sys-model"]);
		assertValidChain(result.value.snapshot.entries());
		assertRuntimeProjection(result.value);
		assertNoUserDowngrade(result.value.snapshot);
		const runtime = JSON.stringify(result.value.snapshot.messages());
		expect(runtime).toContain("parent turn 2");
		expect(runtime).not.toContain("parent turn 0");
		expect(runtime).not.toContain("You are the child.");
		expect(runtime).not.toContain("secret-tool-output");
		expect(runtime).not.toContain("secret-token");
		const tool = result.value.snapshot.entries().find((entry) => entry.id === "turn-2-tool");
		expect(tool?.type).toBe("message");
		if (tool?.type === "message" && tool.message.role === "toolResult") {
			expect(tool.message.content).toEqual([]);
			expect(tool.message.details).toBeUndefined();
		}
		expect(result.value.record.sources.filter((source) => source.sourceId.startsWith("parent-")).map((source) => source.kind)).toEqual(["system", "instruction"]);
		expect(result.value.record.sources.some((source) => source.kind === "session")).toBe(false);
		expect(result.value.record.sources.map((source) => source.sourceId).slice(-2)).toEqual(["child-role-instructions", "child-task-envelope"]);
	});

	it("projects task_package into the runtime layer with bounded durable artifact refs", () => {
		const task = childTask();
		const projection = projectTaskEnvelope(task);
		const result = forkChildContextV1(
			forkInput({
				forkScope: "task_package",
				taskPackageRef: "pkg-1",
				childTaskEnvelope: task,
				persistedTaskPackage: {
					ref: "pkg-1",
					digest: fingerprintFoundationValue(projection),
					projection,
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(result.value.record.forkMode).toBe("task-package");
		expect(result.value.plan.taskPackageRef).toBe("pkg-1");
		expect(result.value.snapshot.entries()).toEqual([]);
		expect(result.value.snapshot.messages()).toEqual([]);
		assertRuntimeProjection(result.value);
		assertNoUserDowngrade(result.value.snapshot);
		expect(result.value.record.taskPackage?.packageId).toBe("pkg-1");
		expect(result.value.record.taskPackage?.artifactRefs).toEqual(["in-1", "out-1"]);
		expect(JSON.stringify(result.value.record)).not.toContain("complete the child task");
		expect(JSON.stringify(result.value.record)).not.toContain("workspace-1");
	});

	it("rejects a task_package proof bound to a foreign task", () => {
		const task = childTask();
		const foreign = childTask("task-foreign");
		const projection = projectTaskEnvelope(foreign);
		expect(
			forkChildContextV1(
				forkInput({
					forkScope: "task_package",
					taskPackageRef: "pkg-1",
					childTaskEnvelope: task,
					persistedTaskPackage: {
						ref: "pkg-1",
						digest: fingerprintFoundationValue(projection),
						projection,
					},
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
	});

	it("rejects missing recentN and missing taskPackageRef", () => {
		expect(forkChildContextV1(forkInput({ forkScope: "recent_n" }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkChildContextV1(forkInput({ forkScope: "recent_n", recentN: 0 }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkChildContextV1(forkInput({ forkScope: "task_package" }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
	});

	it("rejects a mismatched parent digest and a mismatched task package digest", () => {
		const parent = parentSnapshot();
		expect(
			forkChildContextV1(
				forkInput({
					parentSnapshot: parent,
					forkScope: "all",
					sourceContextDigest: { algorithm: "sha256", value: "0".repeat(64) },
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		const task = childTask();
		const projection = projectTaskEnvelope(task);
		expect(
			forkChildContextV1(
				forkInput({
					forkScope: "task_package",
					taskPackageRef: "pkg-1",
					childTaskEnvelope: task,
					persistedTaskPackage: {
						ref: "pkg-1",
						digest: { algorithm: "sha256", value: "0".repeat(64) },
						projection,
					},
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
	});

	it("rejects an all fork that exceeds the child token budget", () => {
		const parent = parentSnapshot(6);
		const result = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "all", childTokenBudget: 1 }));
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
	});

	it("rejects oversized none and task_package runtime projections against childTokenBudget", () => {
		const oversizedRole = childRole(`You are the child. ${"budget ".repeat(400)}`);
		expect(
			forkChildContextV1(forkInput({ forkScope: "none", childRoleRevision: oversizedRole, childTokenBudget: 8 })),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		const task = childTask("task-child", `complete the child task ${"goal ".repeat(400)}`);
		const projection = projectTaskEnvelope(task);
		expect(
			forkChildContextV1(
				forkInput({
					forkScope: "task_package",
					taskPackageRef: "pkg-1",
					childTaskEnvelope: task,
					childTokenBudget: 8,
					persistedTaskPackage: {
						ref: "pkg-1",
						digest: fingerprintFoundationValue(projection),
						projection,
					},
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
	});

	it("accepts every exported task_package bound at the limit and rejects +1", () => {
		expect(forkTaskPackage(childTask("task-child", "g".repeat(TASK_PACKAGE_GOAL_MAX_CHARS))).ok).toBe(true);
		expect(forkTaskPackage(childTask("task-child", "g".repeat(TASK_PACKAGE_GOAL_MAX_CHARS + 1)))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { acceptanceCriteria: criteria(1, "d".repeat(TASK_PACKAGE_CRITERION_MAX_CHARS)) })).ok).toBe(true);
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { acceptanceCriteria: criteria(1, "d".repeat(TASK_PACKAGE_CRITERION_MAX_CHARS + 1)) }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { acceptanceCriteria: criteria(TASK_PACKAGE_MAX_CRITERIA, "done") })).ok).toBe(true);
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { acceptanceCriteria: criteria(TASK_PACKAGE_MAX_CRITERIA + 1, "done") }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { inputs: artifacts(TASK_PACKAGE_MAX_ARTIFACTS, "in") })).ok).toBe(true);
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { inputs: artifacts(TASK_PACKAGE_MAX_ARTIFACTS + 1, "in") }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { expectedOutputs: artifacts(TASK_PACKAGE_MAX_ARTIFACTS, "out") })).ok).toBe(true);
		expect(forkTaskPackage(childTask("task-child", "complete the child task", { expectedOutputs: artifacts(TASK_PACKAGE_MAX_ARTIFACTS + 1, "out") }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
	});

	it("deep-clones safe tool result content and details on all, and rejects unsafe secrets", () => {
		const safe = safeToolParentSnapshot();
		const cloned = forkChildContextV1(forkInput({ parentSnapshot: safe, forkScope: "all" }));
		expect(cloned.ok).toBe(true);
		if (!cloned.ok) throw cloned.error;
		const tool = cloned.value.snapshot.entries().find((entry) => entry.id === "turn-0-tool");
		expect(tool?.type).toBe("message");
		if (tool?.type === "message" && tool.message.role === "toolResult") {
			expect(tool.message.content).toEqual([{ type: "text", text: "file-bytes" }]);
			expect(tool.message.details).toEqual({ bytes: 9, truncated: false });
		}
		expect(tool).not.toBe(safe.entries().find((entry) => entry.id === "turn-0-tool"));
		expect(forkChildContextV1(forkInput({ parentSnapshot: mixedParentSnapshot(), forkScope: "all" }))).toMatchObject({
			ok: false,
			error: { code: "subagent_context_fork_invalid" },
		});
	});

	it("returns a stable Result for malformed unknown input and never throws", () => {
		expect(() => forkChildContextV1(null)).not.toThrow();
		expect(forkChildContextV1(null)).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		expect(forkChildContextV1({ extra: true })).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		expect(
			forkChildContextV1(forkInput({ sourceContextDigest: { algorithm: "sha256", value: "abc", extra: true } as never })),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		expect(
			forkChildContextV1(
				forkInput({
					forkScope: "task_package",
					taskPackageRef: "pkg-1",
					persistedTaskPackage: { ref: "pkg-1", digest: { algorithm: "sha256", value: "aa" }, extra: true } as never,
				}),
			),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
	});

	it("validates the fork plan as an exact runtime shape", () => {
		const result = forkChildContextV1(forkInput({ forkScope: "none" }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(validateChildContextForkPlanV1(result.value.plan)).toBe(true);
		expect(validateChildContextForkPlanV1({ ...result.value.plan, extra: true })).toBe(false);
		expect(validateChildContextForkPlanV1({ ...result.value.plan, recentN: 2 })).toBe(false);
		expect(validateChildContextForkPlanV1({ ...result.value.plan, taskPackageRef: "pkg-1" })).toBe(false);
	});

	it("charges canonical JSON structure including required and satisfiedBy under a tight budget", () => {
		const evidence = childTask("task-child", "complete the child task", {
			acceptanceCriteria: [{ schemaVersion: 1, criterionId: "criterion-1", description: "done", satisfiedBy: "artifact", required: true }],
		});
		const manual = childTask("task-child", "complete the child task", {
			acceptanceCriteria: [
				{ schemaVersion: 1, criterionId: "criterion-1", description: "done", satisfiedBy: "evidence", required: false },
				{ schemaVersion: 1, criterionId: "criterion-2", description: "also", satisfiedBy: "manual", required: false },
			],
		});
		const evidenceJson = canonicalFoundationJson({
			goal: evidence.goal,
			acceptanceCriteria: [{ criterionId: "criterion-1", description: "done", required: true, satisfiedBy: "artifact" }],
			inputs: projectTaskEnvelope(evidence).inputs,
			expectedOutputs: projectTaskEnvelope(evidence).expectedOutputs,
		});
		const manualJson = canonicalFoundationJson({
			goal: manual.goal,
			acceptanceCriteria: [
				{ criterionId: "criterion-1", description: "done", required: false, satisfiedBy: "evidence" },
				{ criterionId: "criterion-2", description: "also", required: false, satisfiedBy: "manual" },
			],
			inputs: projectTaskEnvelope(manual).inputs,
			expectedOutputs: projectTaskEnvelope(manual).expectedOutputs,
		});
		expect(evidenceJson).not.toBe(manualJson);
		const instructionJson = canonicalFoundationJson({
			schemaVersion: 1,
			kind: "system_task",
			persona: "You are the child.",
			customInstructions: "Stay in the child task.",
		});
		const estimate = (text: string) => Math.ceil(text.length / 4);
		const evidenceTotal = estimate(instructionJson) + estimate(evidenceJson);
		const manualTotal = estimate(instructionJson) + estimate(manualJson);
		const tight = Math.min(evidenceTotal, manualTotal);
		const evidenceResult = forkTaskPackage(evidence, tight);
		const manualResult = forkTaskPackage(manual, tight);
		expect(evidenceResult.ok || manualResult.ok).toBe(true);
		expect(evidenceResult.ok && manualResult.ok).toBe(false);
	});

	it("rejects all and recent_n when inherited system/instruction tokens exceed budget without double-counting session", () => {
		const parent = createContextSnapshot([messageEntry("turn-0", "hi", 1, null)], {
			bindingEpochId: "epoch-parent",
			forkMode: "all",
			source: { sourceId: "parent-session", kind: "session", trust: "user_owned", estimatedTokens: 8000 },
			sources: [
				{ sourceId: "parent-system", kind: "system", trust: "builtin", digest: `sha256:${"11".repeat(32)}`, estimatedTokens: 400, disposition: "included" },
				{ sourceId: "parent-instruction", kind: "instruction", trust: "builtin", digest: `sha256:${"22".repeat(32)}`, estimatedTokens: 50, disposition: "included" },
				{ sourceId: "parent-session", kind: "session", trust: "user_owned", digest: `sha256:${"33".repeat(32)}`, estimatedTokens: 8000, disposition: "included" },
			],
			budget: { maxTokens: 100_000 },
		});
		const noneProbe = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "none", childTokenBudget: 50_000 }));
		expect(noneProbe.ok).toBe(true);
		if (!noneProbe.ok) throw noneProbe.error;
		const runtime =
			(noneProbe.value.record.sources.find((source) => source.kind === "instruction")?.estimatedTokens ?? 0) +
			(noneProbe.value.record.sources.find((source) => source.kind === "task")?.estimatedTokens ?? 0);
		expect(
			forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "all", childTokenBudget: 400 })),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		expect(
			forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "recent_n", recentN: 1, childTokenBudget: 400 })),
		).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
		const justEnough = runtime + 400 + 50 + 200;
		expect(justEnough).toBeLessThan(8000);
		const allOk = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "all", childTokenBudget: justEnough }));
		expect(allOk.ok).toBe(true);
		const recentOk = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "recent_n", recentN: 1, childTokenBudget: justEnough }));
		expect(recentOk.ok).toBe(true);
	});

	it("does not share parent context references with the child snapshot", () => {
		const parent = parentSnapshot();
		const before = parent.toJSON();
		const result = forkChildContextV1(forkInput({ parentSnapshot: parent, forkScope: "all" }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;
		expect(() => {
			(result.value.snapshot.entries() as Entry[]).push(messageEntry("mut", "nope", 99, null));
		}).toThrow();
		expect(parent.toJSON()).toEqual(before);
		expect(parent.entries()).toHaveLength(4);
		expect(result.value.record).not.toBe(before);
	});
});
