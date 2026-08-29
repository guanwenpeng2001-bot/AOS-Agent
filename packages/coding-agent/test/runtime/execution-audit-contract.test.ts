import { fingerprintFoundationValue } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	AUDIT_EVENT_TYPES as SRC_AUDIT_EVENT_TYPES,
	AUDIT_SOURCE_CUSTOM_TYPES as SRC_AUDIT_SOURCE_CUSTOM_TYPES,
	TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEYS,
	projectSubagentAuditSource,
	replaySubagentAuditSource,
	hasForbiddenSchedulerAuditValue,
	type AuditEvent,
	type AuditSession,
} from "../../src/core/session/execution-audit.ts";
import type { SessionEntry } from "../../src/core/session/manager.ts";
import {
	AUDIT_CONTRACT_CASES,
	AUDIT_CURSOR_SORT_KEYS,
	AUDIT_DEFAULT_LIMIT,
	AUDIT_ERROR_CODES,
	AUDIT_EVENT_TYPES,
	AUDIT_EXCLUDED_CUSTOM_TYPES,
	AUDIT_FORBIDDEN_KEYS,
	AUDIT_MAX_LIMIT,
	AUDIT_NO_SIDE_EFFECT_OPERATIONS,
	AUDIT_PUBLIC_SUMMARY_KEYS,
	AUDIT_QUERY_COMMAND,
	AUDIT_QUERY_SCOPES,
	AUDIT_REPLAY_COMMAND,
	AUDIT_REPLAY_STATUSES,
	AUDIT_SCHEMA_VERSION,
	AUDIT_SOURCE_CUSTOM_TYPES,
	AUDIT_WARNING_CODES,
} from "../fixtures/execution-audit-contract.ts";
import { canonicalAuditRunEntries } from "../support/canonical-audit-run.ts";

describe("execution audit T0 contract", () => {
	it("projects and replays only digest-bound safe child lifecycle fields", () => {
		const base = {
			schemaVersion: 1 as const,
			source: "subagent.lifecycle" as const,
			sessionId: "session-audit",
			runId: "run-audit",
			childAgentInstanceId: "child-audit",
			parentAgentInstanceId: "parent-audit",
			taskId: "task-audit",
			status: "running" as const,
			providerKind: "in_process" as const,
			safeSummary: "Child child-audit is running",
			correlation: { attemptId: "attempt-audit", spawnId: "spawn-audit" },
		};
		const safe = { ...base, digest: fingerprintFoundationValue(base) };
		expect(projectSubagentAuditSource(safe)).toEqual(safe);
		expect(replaySubagentAuditSource(safe)).toEqual(safe);
		expect(projectSubagentAuditSource({ ...safe, prompt: "raw child prompt" })).toBeUndefined();
		expect(projectSubagentAuditSource({ ...safe, safeSummary: "mutated" })).toBeUndefined();
		const { digest: _digest, ...safeBase } = safe;
		const forgedStatusBase = { ...safeBase, status: "forged_status" };
		const forgedProviderBase = { ...safeBase, providerKind: "forged_provider" };
		expect(
			projectSubagentAuditSource({
				...forgedStatusBase,
				digest: fingerprintFoundationValue(forgedStatusBase),
			}),
		).toBeUndefined();
		expect(
			projectSubagentAuditSource({
				...forgedProviderBase,
				digest: fingerprintFoundationValue(forgedProviderBase),
			}),
		).toBeUndefined();
		expect(Object.keys(replaySubagentAuditSource(safe) ?? {})).not.toEqual(
			expect.arrayContaining([
				"pid",
				"executable",
				"argv",
				"cwd",
				"env",
				"transcript",
				"prompt",
				"token",
				"secret",
				"header",
				"providerStack",
				"rawFrame",
			]),
		);
	});
	it("freezes the v1 commands, event union, and source types", () => {
		expect(AUDIT_SCHEMA_VERSION).toBe(1);
		expect(AUDIT_QUERY_COMMAND).toBe("audit.query");
		expect(AUDIT_REPLAY_COMMAND).toBe("audit.replay");
		expect(AUDIT_SOURCE_CUSTOM_TYPES).toEqual([
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"task.gate",
		]);
		expect(AUDIT_EXCLUDED_CUSTOM_TYPES).toEqual(["context.memory", "mcp.content.audit"]);
		expect(AUDIT_EVENT_TYPES).toEqual([
			"run.accepted",
			"run.started",
			"run.completed",
			"run.failed",
			"run.cancelled",
			"run.interrupted",
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"task.gate",
		]);
	});

	it("freezes replay, warning, error, and pagination domains", () => {
		expect(AUDIT_REPLAY_STATUSES).toEqual(["complete", "interrupted", "incomplete"]);
		expect(AUDIT_QUERY_SCOPES).toEqual(["current-session", "session-directory"]);
		expect(AUDIT_WARNING_CODES).toEqual([
			"unknown_source",
			"malformed_source",
			"unsupported_schema",
			"orphan_source",
			"duplicate_source",
			"source_unavailable",
			"ambiguous_run_association",
		]);
		expect(AUDIT_ERROR_CODES).toEqual([
			"audit_query_invalid",
			"audit_cursor_invalid",
			"audit_scope_unavailable",
			"audit_run_not_found",
			"audit_replay_incomplete",
		]);
		expect(AUDIT_DEFAULT_LIMIT).toBe(50);
		expect(AUDIT_MAX_LIMIT).toBe(200);
		expect(AUDIT_CURSOR_SORT_KEYS).toEqual(["recordedAt", "sessionId", "sourceEntryId", "eventId"]);
	});

	it("freezes public summary allowlists", () => {
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.run).toEqual([
			"status",
			"attempt",
			"model",
			"sourceRunId",
			"previousBindingId",
			"capabilityBindingId",
			"modelBindingId",
			"previousModelBindingId",
			"policyBindingId",
			"previousPolicyBindingId",
			"contextSnapshotId",
			"startedAt",
			"endedAt",
			"terminalError",
			"finalModel",
			"modelBudget",
			"attachments",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.modelBinding).toEqual([
			"bindingId",
			"mode",
			"routeId",
			"role",
			"candidates",
			"fallback",
			"budget",
			"configRevision",
			"createdAt",
			"previousModelBindingId",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.modelAttempt).toEqual([
			"attemptId",
			"bindingId",
			"candidate",
			"order",
			"status",
			"startedAt",
			"endedAt",
			"failureCategory",
			"usage",
			"visibleOutput",
			"contextSnapshotId",
			"summary",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.contextSnapshot).toEqual([
			"schemaVersion",
			"id",
			"purpose",
			"sessionId",
			"runId",
			"createdAt",
			"parentSnapshotId",
			"sources",
			"budget",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.contextSource).toEqual([
			"kind",
			"scope",
			"trust",
			"visibility",
			"contentDigest",
			"estimatedTokens",
			"disposition",
			"reason",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.policySummary).toEqual([
			"bindingId",
			"profileId",
			"profileRevision",
			"projectTrust",
			"enforcement",
			"sandboxProviderId",
			"sandboxStatus",
			"sandboxCapabilities",
			"resource",
			"action",
			"outcome",
			"reasonCode",
			"requestId",
			"timestamp",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.taskGate).toEqual([
			"gateId",
			"taskId",
			"stageId",
			"stageRevision",
			"status",
			"action",
			"revision",
			"requestedAt",
			"decidedAt",
			"runId",
			"actorId",
			"reasonCode",
		]);
	});

	it("reads historical Adapter associations without emitting current audit facts", () => {
		const sessionId = "legacy-audit-session";
		const runId = "legacy-audit-run";
		const external = {
			namespace: "legacy-ci",
			externalSessionId: "legacy-job",
			externalRunId: "legacy-attempt",
		};
		const entry = (id: string, timestamp: string, data: unknown): Extract<SessionEntry, { type: "custom" }> => ({
			type: "custom",
			id,
			parentId: null,
			timestamp,
			customType: "automation.run",
			data,
		});
		const entries: SessionEntry[] = [
			entry("legacy-accepted", "2026-08-01T00:00:00.000Z", {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: runId,
					sessionId,
					external,
					attempt: 1,
					status: "accepted",
					model: { provider: "legacy", id: "adapter", thinkingLevel: "off" },
				},
			}),
			entry("legacy-started", "2026-08-01T00:00:01.000Z", {
				schemaVersion: 1,
				kind: "started",
				runId,
				startedAt: "2026-08-01T00:00:01.000Z",
			}),
			entry("legacy-terminal", "2026-08-01T00:00:02.000Z", {
				schemaVersion: 1,
				kind: "terminal",
				receipt: {
					runId,
					sessionId,
					external,
					status: "completed",
					usage: { input: 1, output: 1, total: 2 },
				},
				endedAt: "2026-08-01T00:00:02.000Z",
			}),
		];

		const folded = new ExecutionAuditAdapter({
			getSessionId: () => sessionId,
			getEntries: () => entries,
		}).fold();
		expect(folded.events.map((event) => event.type)).toEqual(["run.accepted", "run.started", "run.completed"]);
		for (const event of folded.events) expect(event).not.toHaveProperty("external");
		const serialized = JSON.stringify(folded);
		expect(serialized).not.toContain("legacy-ci");
		expect(serialized).not.toContain("legacy-job");
		expect(serialized).not.toContain("legacy-attempt");
	});

	it("keeps forbidden data and side effects outside the contract", () => {
		const forbiddenKeys = new Set<string>(AUDIT_FORBIDDEN_KEYS);
		for (const summaryKeys of Object.values(AUDIT_PUBLIC_SUMMARY_KEYS)) {
			for (const key of summaryKeys) expect(forbiddenKeys.has(key), key).toBe(false);
		}

		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("SessionManager.appendCustomEntry");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("ModelBroker provider call or fallback");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("Policy authorize/approve/reject");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("SandboxProvider.prepare/execute/dispose");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("Context memory write");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain(
			"TaskGateStore mutation (task.gate.request/approve/reject/cancel)",
		);
		for (const testCase of AUDIT_CONTRACT_CASES) expect(testCase.sideEffects, testCase.id).toEqual([]);
	});

	it("keeps the replay/error distinction explicit", () => {
		expect(
			AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "accepted-without-terminal-is-interrupted")
				?.expectedStatus,
		).toBe("interrupted");
		expect(
			AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "malformed-source-is-incomplete")?.expectedStatus,
		).toBe("incomplete");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "missing-run-is-an-error")?.expectedError).toBe(
			"audit_run_not_found",
		);
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "bad-cursor-is-an-error")?.expectedError).toBe(
			"audit_cursor_invalid",
		);
	});
});

const GRAPH_SESSION_ID = "session-graph-contract";
const GRAPH_RUN_ID = "run-graph-1";
const GRAPH_TASK_ID = "task_graph_1";
const GRAPH_TIMES = {
	accepted: "2026-08-14T00:00:00.000Z",
	terminal: "2026-08-14T00:00:01.000Z",
	created: "2026-08-14T00:00:02.000Z",
	attached: "2026-08-14T00:00:03.000Z",
	settled: "2026-08-14T00:00:04.000Z",
} as const;

type GraphNodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** The documented `AuditTaskGraphSummary` allowlist, checked against the fixture forbidden keys. */
const TASK_GRAPH_SUMMARY_KEYS = [
	"taskId",
	"graphRevision",
	"nodeId",
	"action",
	"status",
	"nodeRevision",
	"dependsOn",
	"gateRef",
	"runId",
	"outcomeCode",
] as const;

function graphCustomEntry(
	id: string,
	timestamp: string,
	customType: string,
	data: unknown,
): Extract<SessionEntry, { type: "custom" }> {
	return { type: "custom", id, parentId: null, timestamp, customType, data } as Extract<
		SessionEntry,
		{ type: "custom" }
	>;
}

function graphNode(
	nodeId: string,
	options: {
		readonly dependsOn?: ReadonlyArray<string>;
		readonly status?: GraphNodeStatus;
		readonly nodeRevision?: number;
		readonly gateRef?: { readonly stageId: string; readonly stageRevision: number };
		readonly runRef?: { readonly sessionId: string; readonly runId: string };
		readonly outcomeCode?: string;
	} = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		nodeId,
		dependsOn: [...(options.dependsOn ?? [])],
		status: options.status ?? "pending",
		nodeRevision: options.nodeRevision ?? 0,
		...(options.gateRef === undefined ? {} : { gateRef: options.gateRef }),
		...(options.runRef === undefined ? {} : { runRef: options.runRef }),
		...(options.outcomeCode === undefined ? {} : { outcomeCode: options.outcomeCode }),
	};
}

function graphRunEntries(): SessionEntry[] {
	return canonicalAuditRunEntries({
		sessionId: GRAPH_SESSION_ID,
		runId: GRAPH_RUN_ID,
		acceptedAt: GRAPH_TIMES.accepted,
		completedAt: GRAPH_TIMES.terminal,
		fixtureId: "graph",
	});
}

function graphCreatedEntry(
	entryId = "graph-created",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
		readonly nodes?: ReadonlyArray<Record<string, unknown>>;
		readonly timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const taskId = options.taskId ?? GRAPH_TASK_ID;
	const graphRevision = options.graphRevision ?? 1;
	const sessionId = options.sessionId ?? GRAPH_SESSION_ID;
	return graphCustomEntry(entryId, options.timestamp ?? GRAPH_TIMES.created, "task.graph", {
		schemaVersion: 1,
		action: "created",
		taskId,
		graphRevision,
		graph: {
			schemaVersion: 1,
			sessionId,
			taskId,
			graphRevision,
			createdAt: GRAPH_TIMES.created,
			nodes: [
				...(options.nodes ?? [
					graphNode("inspect"),
					graphNode("implement", {
						dependsOn: ["inspect"],
						gateRef: { stageId: "stage_review", stageRevision: 1 },
					}),
				]),
			],
		},
		clientRequestId: options.clientRequestId ?? "graph-create-001",
	});
}

function graphAttachedEntry(
	entryId = "graph-attached",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly nodeId?: string;
		readonly dependsOn?: ReadonlyArray<string>;
		readonly gateRef?: { readonly stageId: string; readonly stageRevision: number };
		readonly runId?: string;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
		readonly nodeRevision?: number;
		readonly previousNodeRevision?: number;
		readonly status?: GraphNodeStatus;
		readonly timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const sessionId = options.sessionId ?? GRAPH_SESSION_ID;
	return graphCustomEntry(entryId, options.timestamp ?? GRAPH_TIMES.attached, "task.graph", {
		schemaVersion: 1,
		action: "node.attached",
		taskId: options.taskId ?? GRAPH_TASK_ID,
		graphRevision: options.graphRevision ?? 1,
		node: graphNode(options.nodeId ?? "inspect", {
			dependsOn: options.dependsOn,
			status: options.status ?? "running",
			nodeRevision: options.nodeRevision ?? 1,
			...(options.gateRef === undefined ? {} : { gateRef: options.gateRef }),
			runRef: {
				sessionId,
				runId: options.runId ?? GRAPH_RUN_ID,
			},
		}),
		previousNodeRevision: options.previousNodeRevision ?? 0,
		clientRequestId: options.clientRequestId ?? "graph-attach-001",
	});
}

function graphSettledEntry(
	entryId: string,
	action: "node.succeeded" | "node.failed" | "node.cancelled",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly nodeId?: string;
		readonly dependsOn?: ReadonlyArray<string>;
		readonly gateRef?: { readonly stageId: string; readonly stageRevision: number };
		readonly runId?: string;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
		readonly nodeRevision?: number;
		readonly previousNodeRevision?: number;
		readonly outcomeCode?: string;
		readonly timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const sessionId = options.sessionId ?? GRAPH_SESSION_ID;
	const status: GraphNodeStatus =
		action === "node.succeeded" ? "succeeded" : action === "node.failed" ? "failed" : "cancelled";
	return graphCustomEntry(entryId, options.timestamp ?? GRAPH_TIMES.settled, "task.graph", {
		schemaVersion: 1,
		action,
		taskId: options.taskId ?? GRAPH_TASK_ID,
		graphRevision: options.graphRevision ?? 1,
		node: graphNode(options.nodeId ?? "inspect", {
			dependsOn: options.dependsOn,
			status,
			nodeRevision: options.nodeRevision ?? 2,
			...(options.gateRef === undefined ? {} : { gateRef: options.gateRef }),
			runRef: {
				sessionId,
				runId: options.runId ?? GRAPH_RUN_ID,
			},
			...(options.outcomeCode === undefined ? {} : { outcomeCode: options.outcomeCode }),
		}),
		previousNodeRevision: options.previousNodeRevision ?? 1,
		clientRequestId: options.clientRequestId ?? `graph-settle-${entryId}`,
	});
}

function graphSession(entries: ReadonlyArray<SessionEntry>): AuditSession {
	return { getSessionId: () => GRAPH_SESSION_ID, getEntries: () => entries };
}

describe("execution audit task graph contract", () => {
	it("adds task.graph as the only additive audit source and event type", () => {
		// The T0 fixture predates the remote.operation and task.credential
		// sources; ignoring those known later additions, task.graph must be the
		// only remaining delta.
		expect(
			SRC_AUDIT_SOURCE_CUSTOM_TYPES.filter(
				(type) =>
					type !== "remote.operation" &&
					type !== "task.credential" &&
					!type.startsWith("worker") &&
					!type.startsWith("scheduler."),
			),
		).toEqual([...AUDIT_SOURCE_CUSTOM_TYPES, "task.graph"]);
		expect(
			SRC_AUDIT_EVENT_TYPES.filter(
				(type) =>
					type !== "remote.operation" &&
					type !== "task.credential" &&
					!type.startsWith("worker") &&
					!type.startsWith("scheduler."),
			),
		).toEqual([...AUDIT_EVENT_TYPES, "task.graph"]);
	});

	it("keeps the task.graph summary allowlist disjoint from the forbidden keys", () => {
		const forbiddenKeys = new Set<string>(AUDIT_FORBIDDEN_KEYS);
		for (const key of TASK_GRAPH_SUMMARY_KEYS) expect(forbiddenKeys.has(key), key).toBe(false);
	});

	it("folds a legal graph lifecycle into allowlisted task.graph summaries", () => {
		const entries = [
			...graphRunEntries(),
			graphCreatedEntry(),
			graphAttachedEntry(),
			graphSettledEntry("graph-settled", "node.succeeded", { outcomeCode: "ok" }),
			graphAttachedEntry("graph-attached-implement", {
				nodeId: "implement",
				dependsOn: ["inspect"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
				runId: "run-graph-2",
				clientRequestId: "graph-attach-implement-001",
				timestamp: "2026-08-14T00:00:05.000Z",
			}),
			graphSettledEntry("graph-settled-implement", "node.succeeded", {
				nodeId: "implement",
				dependsOn: ["inspect"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
				runId: "run-graph-2",
				outcomeCode: "ok",
				timestamp: "2026-08-14T00:00:06.000Z",
			}),
		];
		const folded = new ExecutionAuditAdapter(graphSession(entries)).fold();
		const graphEvents = folded.events.filter((event: AuditEvent) => event.type === "task.graph");
		expect(graphEvents.map((event) => event.sourceEntryId)).toEqual([
			"graph-created",
			"graph-attached",
			"graph-settled",
			"graph-attached-implement",
			"graph-settled-implement",
		]);
		const created = graphEvents[0];
		expect(created).toBeDefined();
		expect(created?.eventId).toBe(created?.sourceEntryId);
		expect(created?.summary).toEqual({
			taskId: GRAPH_TASK_ID,
			graphRevision: 1,
			action: "created",
		});
		expect(Object.keys(created?.summary ?? {})).toEqual(["taskId", "graphRevision", "action"]);
		const attached = graphEvents[1];
		expect(attached?.runId).toBe(GRAPH_RUN_ID);
		expect(attached?.summary).toEqual({
			taskId: GRAPH_TASK_ID,
			graphRevision: 1,
			nodeId: "inspect",
			action: "node.attached",
			status: "running",
			nodeRevision: 1,
			runId: GRAPH_RUN_ID,
		});
		expect(Object.keys(attached?.summary ?? {})).toEqual([
			"taskId",
			"graphRevision",
			"action",
			"nodeId",
			"status",
			"nodeRevision",
			"runId",
		]);
		const settled = graphEvents[2];
		expect(settled?.summary).toEqual({
			taskId: GRAPH_TASK_ID,
			graphRevision: 1,
			nodeId: "inspect",
			action: "node.succeeded",
			status: "succeeded",
			nodeRevision: 2,
			runId: GRAPH_RUN_ID,
			outcomeCode: "ok",
		});
		const settledImplement = graphEvents[4];
		expect(settledImplement?.summary).toEqual({
			taskId: GRAPH_TASK_ID,
			graphRevision: 1,
			nodeId: "implement",
			action: "node.succeeded",
			status: "succeeded",
			nodeRevision: 2,
			dependsOn: ["inspect"],
			gateRef: { stageId: "stage_review", stageRevision: 1 },
			runId: "run-graph-2",
			outcomeCode: "ok",
		});
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("graph-create-001");
		expect(encoded).not.toContain("graph-attach-001");
		expect(encoded).not.toContain("graph-attach-implement-001");
		expect(encoded).not.toContain("clientRequestId");
		expect(folded.warnings).toEqual([]);
	});

	it("rejects entries carrying forbidden keys instead of exposing them", () => {
		const tamperedCreated = graphCreatedEntry("graph-tampered", {
			graphRevision: 2,
			clientRequestId: "graph-create-tampered",
			nodes: [
				{
					...graphNode("inspect"),
					prompt: "top secret prompt",
					command: "rm -rf",
					path: "/home/user/workspace",
					credentials: { token: "secret-token" },
				},
			],
		});
		const tamperedAttached = graphAttachedEntry("graph-tampered-attached", {
			graphRevision: 2,
			clientRequestId: "graph-attach-tampered",
			nodeId: "inspect",
		});
		const tamperedData = tamperedAttached.data as Record<string, unknown>;
		tamperedData.env = { API_KEY: "super-secret-key" };
		(tamperedData.node as Record<string, unknown>).finalText = "secret model output";
		tamperedData.providerError = "model exploded";
		const folded = new ExecutionAuditAdapter(
			graphSession([...graphRunEntries(), tamperedCreated, tamperedAttached]),
		).fold();
		const graphEvents = folded.events.filter((event: AuditEvent) => event.type === "task.graph");
		expect(graphEvents).toEqual([]);
		expect(
			folded.warnings.filter((warning) => warning.eventType === "task.graph").map((warning) => warning.code),
		).toEqual(["malformed_source", "malformed_source"]);
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("top secret prompt");
		expect(encoded).not.toContain("rm -rf");
		expect(encoded).not.toContain("/home/user/workspace");
		expect(encoded).not.toContain("secret-token");
		expect(encoded).not.toContain("super-secret-key");
		expect(encoded).not.toContain("secret model output");
		expect(encoded).not.toContain("model exploded");
		expect(encoded).not.toContain("graph-create-tampered");
		expect(encoded).not.toContain("graph-attach-tampered");
	});

	it("rejects malformed, unsupported, session-mismatched, and revision-invalid graph entries with safe warnings", () => {
		const entries: SessionEntry[] = [
			graphCustomEntry("graph-unsupported", GRAPH_TIMES.created, "task.graph", {
				schemaVersion: 2,
				action: "created",
			}),
			graphCustomEntry("graph-garbage", GRAPH_TIMES.created, "task.graph", "raw graph secret"),
			graphCreatedEntry(),
			graphCreatedEntry("graph-foreign-create", {
				sessionId: "other-session",
				clientRequestId: "graph-create-foreign",
			}),
			graphCreatedEntry("graph-unknown-dep", {
				clientRequestId: "graph-create-unknown-dep",
				nodes: [graphNode("inspect", { dependsOn: ["missing"] })],
			}),
			graphCreatedEntry("graph-cycle", {
				clientRequestId: "graph-create-cycle",
				nodes: [graphNode("a", { dependsOn: ["b"] }), graphNode("b", { dependsOn: ["a"] })],
			}),
			graphAttachedEntry("graph-foreign-attach", {
				sessionId: "other-session",
				runId: "run-foreign",
				clientRequestId: "graph-attach-foreign",
			}),
			graphSettledEntry("graph-gap", "node.succeeded", {
				clientRequestId: "graph-settle-gap",
			}),
			graphAttachedEntry("graph-jump", {
				nodeId: "implement",
				nodeRevision: 2,
				status: "succeeded",
				clientRequestId: "graph-attach-jump",
			}),
			graphAttachedEntry("graph-attached", { runId: "run-a" }),
			graphAttachedEntry("graph-dup-key", {
				runId: "run-b",
				clientRequestId: "graph-attach-dup-key",
			}),
			graphAttachedEntry("graph-dup-run", {
				nodeId: "implement",
				dependsOn: ["inspect"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
				runId: "run-a",
				clientRequestId: "graph-attach-dup-run",
			}),
			graphSettledEntry("graph-settled", "node.succeeded", {
				runId: "run-a",
				clientRequestId: "graph-settle-001",
			}),
			graphSettledEntry("graph-repeat", "node.succeeded", {
				runId: "run-a",
				clientRequestId: "graph-settle-002",
			}),
			graphCreatedEntry("graph-second-create", { clientRequestId: "graph-create-002" }),
		];
		const folded = new ExecutionAuditAdapter(graphSession(entries)).fold();
		const graphEvents = folded.events.filter((event: AuditEvent) => event.type === "task.graph");
		expect(graphEvents.map((event) => event.sourceEntryId)).toEqual([
			"graph-created",
			"graph-attached",
			"graph-settled",
		]);
		const graphWarnings = (entryId: string) =>
			folded.warnings.filter((warning) => warning.eventType === "task.graph" && warning.sourceEntryId === entryId);
		expect(graphWarnings("graph-unsupported")).toEqual([
			{
				code: "unsupported_schema",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-unsupported",
				eventType: "task.graph",
				schemaVersion: 2,
			},
		]);
		expect(graphWarnings("graph-garbage")).toEqual([
			{
				code: "malformed_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-garbage",
				eventType: "task.graph",
			},
		]);
		expect(graphWarnings("graph-foreign-create")).toEqual([
			{
				code: "orphan_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-foreign-create",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-unknown-dep")).toEqual([
			{
				code: "malformed_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-unknown-dep",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-cycle")).toEqual([
			{
				code: "malformed_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-cycle",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-foreign-attach")).toEqual([
			{
				code: "orphan_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-foreign-attach",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-gap")).toEqual([
			{
				code: "malformed_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-gap",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-jump")).toEqual([
			{
				code: "malformed_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-jump",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-dup-key")).toEqual([
			{
				code: "duplicate_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-dup-key",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-dup-run")).toEqual([
			{
				code: "duplicate_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-dup-run",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-repeat")).toEqual([
			{
				code: "duplicate_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-repeat",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		expect(graphWarnings("graph-second-create")).toEqual([
			{
				code: "duplicate_source",
				sessionId: GRAPH_SESSION_ID,
				sourceEntryId: "graph-second-create",
				eventType: "task.graph",
				schemaVersion: 1,
			},
		]);
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("raw graph secret");
		expect(encoded).not.toContain("other-session");
		expect(encoded).not.toContain("run-foreign");
		expect(encoded).not.toContain("graph-create-002");
		expect(encoded).not.toContain("graph-attach-dup-key");
		expect(encoded).not.toContain("graph-attach-dup-run");
		expect(encoded).not.toContain("clientRequestId");
	});

	it("correlates graph events into replay only by runRef runId and never changes terminal status", () => {
		const entries = [
			...graphRunEntries(),
			graphCustomEntry("graph-unsupported", GRAPH_TIMES.created, "task.graph", { schemaVersion: 2 }),
			graphCreatedEntry(),
			graphAttachedEntry("graph-foreign", {
				sessionId: "other-session",
				runId: "run-foreign",
				clientRequestId: "graph-attach-foreign",
			}),
			graphAttachedEntry("graph-attached-other", {
				nodeId: "implement",
				dependsOn: ["inspect"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
				runId: "run-other",
				clientRequestId: "graph-attach-other",
			}),
			graphAttachedEntry(),
			graphSettledEntry("graph-settled", "node.succeeded", { outcomeCode: "ok" }),
		];
		const adapter = new ExecutionAuditAdapter(graphSession(entries));
		const replay = adapter.replay(GRAPH_RUN_ID);
		expect(replay.status).toBe("complete");
		expect(replay.run.status).toBe("completed");
		expect(replay.warnings).toEqual([]);
		const graphEvents = replay.events.filter((event: AuditEvent) => event.type === "task.graph");
		// created has no runRef, the foreign attach is rejected, and the
		// implement node belongs to run-other: only the exact runRef runId
		// correlation appears in this Run's replay.
		expect(graphEvents.map((event) => event.sourceEntryId)).toEqual(["graph-attached", "graph-settled"]);
	});
});

const CREDENTIAL_SESSION_ID = "session-credential-contract";
const CREDENTIAL_RUN_ID = "run-credential-1";
const CREDENTIAL_TIMES = {
	accepted: "2026-08-15T00:00:00.000Z",
	issued: "2026-08-15T00:00:01.000Z",
	delivered: "2026-08-15T00:00:02.000Z",
	renewed: "2026-08-15T00:00:03.000Z",
	revoked: "2026-08-15T00:00:04.000Z",
	settled: "2026-08-15T00:00:05.000Z",
	terminal: "2026-08-15T00:00:06.000Z",
} as const;

/** The documented `AuditTaskCredentialSummary` allowlist, disjoint from the forbidden keys. */
const TASK_CREDENTIAL_SUMMARY_KEYS = [
	"action",
	"grantId",
	"leaseId",
	"bindingId",
	"sessionId",
	"taskId",
	"graphRevision",
	"nodeId",
	"stageId",
	"stageRevision",
	"runId",
	"targetId",
	"scopeDigest",
	"scopeCount",
	"status",
	"recordedAt",
	"reasonCode",
] as const;

const SCOPE_DIGEST = "sha256:55090b395e6efa5cd32c99b656ebf047434ad2784f78d98f303b7857411a53db";

function customEntry(
	id: string,
	timestamp: string,
	customType: string,
	data: unknown,
): Extract<SessionEntry, { type: "custom" }> {
	return { type: "custom", id, parentId: null, timestamp, customType, data } as Extract<
		SessionEntry,
		{ type: "custom" }
	>;
}

function credentialGrantSnapshot(
	options: {
		leaseId?: string;
		grantId?: string;
		bindingId?: string;
		sessionId?: string;
		revision?: number;
		status?: string;
		heartbeatSequence?: number;
		targetId?: string;
		reasonCode?: string;
		runId?: string;
		stageId?: string;
		stageRevision?: number;
	} = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		grantId: options.grantId ?? "cred_grant_1",
		leaseId: options.leaseId ?? "cred_lease_1",
		bindingId: options.bindingId ?? "cred_binding_1",
		sessionId: options.sessionId ?? CREDENTIAL_SESSION_ID,
		taskId: "task_42",
		graphRevision: 1,
		nodeId: "inspect",
		...(options.stageId === undefined ? {} : { stageId: options.stageId }),
		...(options.stageRevision === undefined ? {} : { stageRevision: options.stageRevision }),
		runId: options.runId ?? CREDENTIAL_RUN_ID,
		scopeDigest: SCOPE_DIGEST,
		scopeCount: 1,
		status: options.status ?? "active",
		issuedAt: CREDENTIAL_TIMES.issued,
		expiresAt: "2026-08-15T00:01:01.000Z",
		renewAfter: "2026-08-15T00:00:46.000Z",
		heartbeatSequence: options.heartbeatSequence ?? 0,
		revision: options.revision ?? 0,
		...(options.targetId === undefined ? {} : { targetId: options.targetId }),
		...(options.reasonCode === undefined ? {} : { reasonCode: options.reasonCode }),
	};
}

function credentialBinding(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		bindingId: "cred_binding_1",
		sessionId: CREDENTIAL_SESSION_ID,
		taskId: "task_42",
		graphRevision: 1,
		nodeId: "inspect",
		runId: CREDENTIAL_RUN_ID,
		capabilityBindingId: "cap_001",
		policyBindingId: "policy_001",
		createdAt: "2026-08-15T00:00:00.500Z",
		bindingRevision: 1,
	};
}

function credentialIssuedEntry(
	entryId = "cred-issued",
	options: {
		clientRequestId?: string;
		leaseId?: string;
		grantId?: string;
		bindingId?: string;
		sessionId?: string;
		runId?: string;
		timestamp?: string;
		binding?: Record<string, unknown>;
		extra?: Record<string, unknown>;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	return customEntry(entryId, options.timestamp ?? CREDENTIAL_TIMES.issued, "task.credential", {
		schemaVersion: 1,
		action: "issued",
		leaseId: options.leaseId ?? "cred_lease_1",
		grantId: options.grantId ?? "cred_grant_1",
		bindingId: options.bindingId ?? "cred_binding_1",
		sessionId: options.sessionId ?? CREDENTIAL_SESSION_ID,
		grant: credentialGrantSnapshot({
			leaseId: options.leaseId,
			grantId: options.grantId,
			bindingId: options.bindingId,
			sessionId: options.sessionId,
			runId: options.runId,
		}),
		previousRevision: 0,
		clientRequestId: options.clientRequestId ?? "issue-001",
		recordedAt: options.timestamp ?? CREDENTIAL_TIMES.issued,
		binding: options.binding ?? credentialBinding(),
		...(options.extra === undefined ? {} : options.extra),
	});
}

function credentialDeliveryEntry(
	entryId: string,
	options: {
		outcome?: "succeeded" | "failed";
		clientRequestId?: string;
		leaseId?: string;
		grantId?: string;
		previousRevision?: number;
		revision?: number;
		timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const previousRevision = options.previousRevision ?? 0;
	return customEntry(entryId, options.timestamp ?? CREDENTIAL_TIMES.delivered, "task.credential", {
		schemaVersion: 1,
		action: options.outcome === "failed" ? "delivery_failed" : "delivery_succeeded",
		leaseId: options.leaseId ?? "cred_lease_1",
		grantId: options.grantId ?? "cred_grant_1",
		bindingId: "cred_binding_1",
		sessionId: CREDENTIAL_SESSION_ID,
		grant: credentialGrantSnapshot({
			leaseId: options.leaseId,
			grantId: options.grantId,
			revision: options.revision ?? previousRevision + 1,
		}),
		previousRevision,
		clientRequestId: options.clientRequestId ?? "project-001",
		recordedAt: options.timestamp ?? CREDENTIAL_TIMES.delivered,
		deliveryReceipt: {
			schemaVersion: 1,
			leaseId: options.leaseId ?? "cred_lease_1",
			grantId: options.grantId ?? "cred_grant_1",
			bindingId: "cred_binding_1",
			status: options.outcome ?? "succeeded",
			recordedAt: options.timestamp ?? CREDENTIAL_TIMES.delivered,
		},
	});
}

function credentialRenewedEntry(
	entryId: string,
	options: {
		sequence?: number;
		clientRequestId?: string;
		leaseId?: string;
		grantId?: string;
		previousRevision?: number;
		revision?: number;
		requestedTtlMs?: number;
		timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const previousRevision = options.previousRevision ?? 1;
	return customEntry(entryId, options.timestamp ?? CREDENTIAL_TIMES.renewed, "task.credential", {
		schemaVersion: 1,
		action: "renewed",
		leaseId: options.leaseId ?? "cred_lease_1",
		grantId: options.grantId ?? "cred_grant_1",
		bindingId: "cred_binding_1",
		sessionId: CREDENTIAL_SESSION_ID,
		grant: credentialGrantSnapshot({
			leaseId: options.leaseId,
			grantId: options.grantId,
			revision: options.revision ?? previousRevision + 1,
			heartbeatSequence: options.sequence ?? 1,
		}),
		previousRevision,
		clientRequestId: options.clientRequestId ?? "renew-001",
		recordedAt: options.timestamp ?? CREDENTIAL_TIMES.renewed,
		requestedTtlMs: options.requestedTtlMs ?? 60_000,
	});
}

function credentialRevokedEntry(
	entryId: string,
	options: {
		clientRequestId?: string;
		leaseId?: string;
		grantId?: string;
		reasonCode?: string;
		previousRevision?: number;
		revision?: number;
		heartbeatSequence?: number;
		timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const previousRevision = options.previousRevision ?? 2;
	const reasonCode = options.reasonCode ?? "operator_revoked";
	return customEntry(entryId, options.timestamp ?? CREDENTIAL_TIMES.revoked, "task.credential", {
		schemaVersion: 1,
		action: "revoked",
		leaseId: options.leaseId ?? "cred_lease_1",
		grantId: options.grantId ?? "cred_grant_1",
		bindingId: "cred_binding_1",
		sessionId: CREDENTIAL_SESSION_ID,
		grant: credentialGrantSnapshot({
			leaseId: options.leaseId,
			grantId: options.grantId,
			revision: options.revision ?? previousRevision + 1,
			status: "revoked",
			heartbeatSequence: options.heartbeatSequence ?? 1,
			reasonCode,
		}),
		previousRevision,
		clientRequestId: options.clientRequestId ?? "revoke-001",
		recordedAt: options.timestamp ?? CREDENTIAL_TIMES.revoked,
		reasonCode,
	});
}

function credentialSettledEntry(
	entryId: string,
	options: {
		clientRequestId?: string;
		leaseId?: string;
		grantId?: string;
		previousRevision?: number;
		revision?: number;
		heartbeatSequence?: number;
		timestamp?: string;
	} = {},
): Extract<SessionEntry, { type: "custom" }> {
	const previousRevision = options.previousRevision ?? 3;
	return customEntry(entryId, options.timestamp ?? CREDENTIAL_TIMES.settled, "task.credential", {
		schemaVersion: 1,
		action: "settled",
		leaseId: options.leaseId ?? "cred_lease_1",
		grantId: options.grantId ?? "cred_grant_1",
		bindingId: "cred_binding_1",
		sessionId: CREDENTIAL_SESSION_ID,
		grant: credentialGrantSnapshot({
			leaseId: options.leaseId,
			grantId: options.grantId,
			revision: options.revision ?? previousRevision + 1,
			status: "settled",
			heartbeatSequence: options.heartbeatSequence ?? 1,
		}),
		previousRevision,
		clientRequestId: options.clientRequestId ?? "settle-001",
		recordedAt: options.timestamp ?? CREDENTIAL_TIMES.settled,
	});
}

function credentialRunEntries(): SessionEntry[] {
	return canonicalAuditRunEntries({
		sessionId: CREDENTIAL_SESSION_ID,
		runId: CREDENTIAL_RUN_ID,
		acceptedAt: CREDENTIAL_TIMES.accepted,
		completedAt: CREDENTIAL_TIMES.terminal,
		fixtureId: "credential",
	});
}

function credentialLifecycleEntries(): SessionEntry[] {
	return [
		...credentialRunEntries(),
		credentialIssuedEntry(),
		credentialDeliveryEntry("cred-delivered"),
		credentialRenewedEntry("cred-renewed"),
		credentialRevokedEntry("cred-revoked"),
		credentialSettledEntry("cred-settled"),
	];
}

function credentialSession(entries: ReadonlyArray<SessionEntry>): AuditSession {
	return { getSessionId: () => CREDENTIAL_SESSION_ID, getEntries: () => entries };
}

describe("execution audit task credential contract", () => {
	it("adds task.credential as the only additive audit source and event type", () => {
		expect(
			SRC_AUDIT_SOURCE_CUSTOM_TYPES.filter(
				(type) => type !== "remote.operation" && !type.startsWith("worker") && !type.startsWith("scheduler."),
			),
		).toEqual([...AUDIT_SOURCE_CUSTOM_TYPES, "task.graph", "task.credential"]);
		expect(
			SRC_AUDIT_EVENT_TYPES.filter(
				(type) => type !== "remote.operation" && !type.startsWith("worker") && !type.startsWith("scheduler."),
			),
		).toEqual([...AUDIT_EVENT_TYPES, "task.graph", "task.credential"]);
	});

	it("keeps the task.credential summary allowlist disjoint from the forbidden keys", () => {
		const forbiddenKeys = new Set<string>([...AUDIT_FORBIDDEN_KEYS, ...TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEYS]);
		for (const key of TASK_CREDENTIAL_SUMMARY_KEYS) expect(forbiddenKeys.has(key), key).toBe(false);
	});

	it("folds a legal credential lifecycle into allowlisted summaries with Session entry identities", () => {
		const folded = new ExecutionAuditAdapter(credentialSession(credentialLifecycleEntries())).fold();
		const credentialEvents = folded.events.filter((event: AuditEvent) => event.type === "task.credential");
		expect(credentialEvents.map((event) => event.sourceEntryId)).toEqual([
			"cred-issued",
			"cred-delivered",
			"cred-renewed",
			"cred-revoked",
			"cred-settled",
		]);
		// The transition eventId is the Session entry identity.
		for (const event of credentialEvents) expect(event.eventId).toBe(event.sourceEntryId);
		// Every event correlates by runId only, from the grant.
		for (const event of credentialEvents) expect(event.runId).toBe(CREDENTIAL_RUN_ID);
		const issued = credentialEvents[0]!;
		expect(issued).toMatchObject({
			type: "task.credential",
			sessionId: CREDENTIAL_SESSION_ID,
			recordedAt: CREDENTIAL_TIMES.issued,
			summary: {
				action: "issued",
				grantId: "cred_grant_1",
				leaseId: "cred_lease_1",
				bindingId: "cred_binding_1",
				sessionId: CREDENTIAL_SESSION_ID,
				taskId: "task_42",
				graphRevision: 1,
				nodeId: "inspect",
				runId: CREDENTIAL_RUN_ID,
				scopeDigest: SCOPE_DIGEST,
				scopeCount: 1,
				status: "active",
				recordedAt: CREDENTIAL_TIMES.issued,
			},
		});
		// The summary carries exactly the documented allowlist keys; optional
		// fields are absent when the transition has none.
		for (const key of Object.keys(issued.summary ?? {})) {
			expect(TASK_CREDENTIAL_SUMMARY_KEYS.includes(key as (typeof TASK_CREDENTIAL_SUMMARY_KEYS)[number]), key).toBe(
				true,
			);
		}
		expect(Object.keys(issued.summary ?? {})).toEqual(
			TASK_CREDENTIAL_SUMMARY_KEYS.filter(
				(key) => key !== "stageId" && key !== "stageRevision" && key !== "targetId" && key !== "reasonCode",
			),
		);
		const settled = credentialEvents[4]!;
		expect(settled).toMatchObject({
			type: "task.credential",
			summary: { action: "settled", status: "settled", recordedAt: CREDENTIAL_TIMES.settled },
		});
		expect((settled as { summary: { reasonCode?: string } }).summary.reasonCode).toBeUndefined();
		expect((credentialEvents[3] as { summary: { reasonCode?: string } }).summary.reasonCode).toBe("operator_revoked");
		// No idempotency keys, scope values, or material in any serialization.
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("clientRequestId");
		expect(encoded).not.toContain("package_registry");
		expect(encoded).not.toContain("issue-001");
		expect(folded.warnings).toEqual([]);
	});

	it("rejects entries carrying forbidden keys instead of exposing them", () => {
		const tampered = credentialIssuedEntry("cred-tampered", {
			clientRequestId: "issue-tampered",
			extra: {
				token: "super-secret-token",
				secret: "super-secret-material",
				env: { API_KEY: "super-secret-key" },
				headers: { authorization: "Bearer abc" },
				prompt: "top secret prompt",
				command: "rm -rf",
				cwd: "/home/user/workspace",
				path: "/home/user/workspace/file",
				content: "raw file content",
				stdout: "streamed output",
				stderr: "streamed error",
				raw: "raw provider payload",
				providerError: "model exploded",
				oauthCode: "oauth-code-123",
			},
		});
		const folded = new ExecutionAuditAdapter(credentialSession([...credentialRunEntries(), tampered])).fold();
		const credentialEvents = folded.events.filter((event: AuditEvent) => event.type === "task.credential");
		expect(credentialEvents).toEqual([]);
		expect(
			folded.warnings.filter((warning) => warning.eventType === "task.credential").map((warning) => warning.code),
		).toEqual(["malformed_source"]);
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("super-secret-token");
		expect(encoded).not.toContain("super-secret-material");
		expect(encoded).not.toContain("super-secret-key");
		expect(encoded).not.toContain("Bearer abc");
		expect(encoded).not.toContain("top secret prompt");
		expect(encoded).not.toContain("rm -rf");
		expect(encoded).not.toContain("/home/user/workspace");
		expect(encoded).not.toContain("raw file content");
		expect(encoded).not.toContain("streamed output");
		expect(encoded).not.toContain("streamed error");
		expect(encoded).not.toContain("raw provider payload");
		expect(encoded).not.toContain("model exploded");
		expect(encoded).not.toContain("oauth-code-123");
		expect(encoded).not.toContain("issue-tampered");
	});

	it("rejects malformed, unsupported, session-mismatched, revision-gapped, and conflicting entries with safe warnings", () => {
		const entries: SessionEntry[] = [
			...credentialRunEntries(),
			customEntry("cred-unsupported", CREDENTIAL_TIMES.issued, "task.credential", {
				schemaVersion: 2,
				action: "issued",
			}),
			customEntry("cred-garbage", CREDENTIAL_TIMES.issued, "task.credential", "raw credential secret"),
			credentialIssuedEntry("cred-foreign", {
				sessionId: "session-other",
				binding: { ...credentialBinding(), sessionId: "session-other" },
			}),
			credentialSettledEntry("cred-settled-only"),
			credentialIssuedEntry(),
			// Same clientRequestId + same payload: silent replay, no warning.
			credentialIssuedEntry("cred-replay", { clientRequestId: "issue-001" }),
			// Same clientRequestId + different payload: duplicate_source.
			credentialIssuedEntry("cred-conflict", {
				clientRequestId: "issue-001",
				leaseId: "cred_lease_2",
				grantId: "cred_grant_2",
				bindingId: "cred_binding_2",
				binding: { ...credentialBinding(), bindingId: "cred_binding_2" },
			}),
			// Second issue for the same lease: duplicate_source.
			credentialIssuedEntry("cred-second-issue", { clientRequestId: "issue-002" }),
			// Two leases claiming the same binding: duplicate_source.
			credentialIssuedEntry("cred-binding-dup", {
				leaseId: "cred_lease_3",
				grantId: "cred_grant_3",
				clientRequestId: "issue-003",
			}),
		];
		const folded = new ExecutionAuditAdapter(credentialSession(entries)).fold();
		const credentialEvents = folded.events.filter((event: AuditEvent) => event.type === "task.credential");
		expect(credentialEvents.map((event) => event.sourceEntryId)).toEqual(["cred-issued"]);
		const credentialWarnings = (entryId: string) =>
			folded.warnings.filter(
				(warning) => warning.eventType === "task.credential" && warning.sourceEntryId === entryId,
			);
		expect(credentialWarnings("cred-unsupported")).toEqual([
			{
				code: "unsupported_schema",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-unsupported",
				eventType: "task.credential",
				schemaVersion: 2,
			},
		]);
		expect(credentialWarnings("cred-garbage")).toEqual([
			{
				code: "malformed_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-garbage",
				eventType: "task.credential",
			},
		]);
		expect(credentialWarnings("cred-foreign")).toEqual([
			{
				code: "orphan_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-foreign",
				eventType: "task.credential",
				schemaVersion: 1,
			},
		]);
		expect(credentialWarnings("cred-settled-only")).toEqual([
			{
				code: "malformed_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-settled-only",
				eventType: "task.credential",
				schemaVersion: 1,
			},
		]);
		expect(credentialWarnings("cred-replay")).toEqual([]);
		expect(credentialWarnings("cred-conflict")).toEqual([
			{
				code: "duplicate_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-conflict",
				eventType: "task.credential",
				schemaVersion: 1,
			},
		]);
		expect(credentialWarnings("cred-second-issue")).toEqual([
			{
				code: "duplicate_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-second-issue",
				eventType: "task.credential",
				schemaVersion: 1,
			},
		]);
		expect(credentialWarnings("cred-binding-dup")).toEqual([
			{
				code: "duplicate_source",
				sessionId: CREDENTIAL_SESSION_ID,
				sourceEntryId: "cred-binding-dup",
				eventType: "task.credential",
				schemaVersion: 1,
			},
		]);
		const encoded = JSON.stringify(folded);
		expect(encoded).not.toContain("raw credential secret");
		expect(encoded).not.toContain("session-other");
		expect(encoded).not.toContain("issue-002");
		expect(encoded).not.toContain("issue-003");
		expect(encoded).not.toContain("clientRequestId");
	});

	it("correlates credential events into replay only by runId and never changes terminal status", () => {
		const adapter = new ExecutionAuditAdapter(credentialSession(credentialLifecycleEntries()));
		const replay = adapter.replay(CREDENTIAL_RUN_ID);
		expect(replay.status).toBe("complete");
		expect(replay.run.status).toBe("completed");
		expect(replay.warnings).toEqual([]);
		const credentialEvents = replay.events.filter((event: AuditEvent) => event.type === "task.credential");
		expect(credentialEvents.map((event) => event.sourceEntryId)).toEqual([
			"cred-issued",
			"cred-delivered",
			"cred-renewed",
			"cred-revoked",
			"cred-settled",
		]);
		// A different run's lease never leaks into this Run's replay.
		const otherRun = credentialIssuedEntry("cred-other-run", {
			leaseId: "cred_lease_9",
			grantId: "cred_grant_9",
			bindingId: "cred_binding_9",
			runId: "run-credential-2",
			clientRequestId: "issue-009",
			timestamp: "2026-08-15T00:00:07.000Z",
		});
		const withOther = new ExecutionAuditAdapter(
			credentialSession([...credentialLifecycleEntries(), otherRun]),
		).replay(CREDENTIAL_RUN_ID);
		expect(withOther.events.filter((event: AuditEvent) => event.type === "task.credential").length).toBe(5);
		// Credential warnings never carry a run association or uncertainty, so
		// they cannot mark the run's replay incomplete.
		const malformed = customEntry("cred-malformed", CREDENTIAL_TIMES.revoked, "task.credential", {
			schemaVersion: 1,
			action: "revoked",
			leaseId: "cred_lease_1",
			grantId: "cred_grant_1",
			bindingId: "cred_binding_1",
			sessionId: CREDENTIAL_SESSION_ID,
			grant: credentialGrantSnapshot({ revision: 99, status: "revoked" }),
			previousRevision: 99,
			clientRequestId: "revoke-broken",
			recordedAt: CREDENTIAL_TIMES.revoked,
			reasonCode: "operator_revoked",
		});
		const withMalformed = new ExecutionAuditAdapter(
			credentialSession([...credentialLifecycleEntries(), malformed]),
		).replay(CREDENTIAL_RUN_ID);
		expect(withMalformed.status).toBe("complete");
		expect(withMalformed.warnings).toEqual([]);
	});
});

const WORKER_SESSION_ID = "session-worker";
const WORKER_RUN_ID = "run-worker";
const WORKER_TIMES = {
	starting: "2026-08-16T00:00:00.000Z",
	ready: "2026-08-16T00:00:01.000Z",
	running: "2026-08-16T00:00:02.000Z",
	cancelling: "2026-08-16T00:00:02.500Z",
	completed: "2026-08-16T00:00:03.000Z",
	receipt: "2026-08-16T00:00:04.000Z",
	reclaiming: "2026-08-16T00:00:05.000Z",
	reclaimed: "2026-08-16T00:00:06.000Z",
} as const;

function workerEntry(
	id: string,
	timestamp: string,
	customType: string,
	data: Record<string, unknown>,
): Extract<SessionEntry, { type: "custom" }> {
	return customEntry(id, timestamp, customType, data);
}

function workerRunEntries(
	outcome: "completed" | "failed" | "cancelled" = "completed",
): Extract<SessionEntry, { type: "custom" }>[] {
	return canonicalAuditRunEntries({
		sessionId: WORKER_SESSION_ID,
		runId: WORKER_RUN_ID,
		acceptedAt: WORKER_TIMES.starting,
		completedAt: WORKER_TIMES.completed,
		fixtureId: "worker",
		outcome,
		...(outcome === "failed" ? { sideEffectState: "side_effect_unknown" } : {}),
	});
}

function workerLifecycleEntry(
	id: string,
	timestamp: string,
	status: string,
	revision: number,
	extra: Record<string, unknown> = {},
	entryTimestamp = timestamp,
): Extract<SessionEntry, { type: "custom" }> {
	const { operationId, receiptId: transitionReceiptId, recordReceiptId, ...recordExtra } = extra;
	const persistedReceiptId =
		recordReceiptId === null
			? undefined
			: (recordReceiptId ??
				(["completed", "cancelled"].includes(status)
					? (transitionReceiptId ?? "receipt-1")
					: status === "failed"
						? transitionReceiptId
						: ["reclaiming", "reclaimed", "reclaim_unknown"].includes(status)
							? "receipt-1"
							: undefined));
	return workerEntry(id, entryTimestamp, "worker.lifecycle_transitioned", {
		schemaVersion: 1,
		class: "durable",
		category: "worker.lifecycle_transitioned",
		eventId: `worker-lifecycle:worker-1:${revision}`,
		streamId: "worker-lifecycle:worker-1",
		sequence: revision,
		timestamp,
		correlation: {
			sessionId: WORKER_SESSION_ID,
			laneId: "main",
			workerId: "worker-1",
			runId: WORKER_RUN_ID,
			bindingId: "binding-1",
			bindingEpochId: "epoch-1",
			attemptId: "attempt-1",
			...(operationId === undefined ? {} : { operationId }),
			...(transitionReceiptId === undefined ? {} : { receiptId: transitionReceiptId }),
		},
		payload: {
			schemaVersion: 1,
			workerId: "worker-1",
			providerId: "sandbox",
			sessionId: WORKER_SESSION_ID,
			laneId: "main",
			runId: WORKER_RUN_ID,
			bindingId: "binding-1",
			bindingEpochId: "epoch-1",
			attemptId: "attempt-1",
			profileId: "profile-1",
			status,
			revision,
			createdAt: WORKER_TIMES.starting,
			...(revision >= 2 ? { readyAt: WORKER_TIMES.ready } : {}),
			...(["completed", "failed", "cancelled", "lost", "reclaiming", "reclaimed", "reclaim_unknown"].includes(status)
				? { endedAt: WORKER_TIMES.completed }
				: {}),
			...(status === "running" || status === "cancelling" ? { activeOperationId: "operation-1" } : {}),
			...(persistedReceiptId === undefined ? {} : { receiptId: persistedReceiptId }),
			...(operationId === undefined ? {} : { operationId }),
			...recordExtra,
		},
	});
}

function workerOperationEntry(
	id: string,
	timestamp: string,
	phase: "claimed" | "started" | "terminal",
	revision: number,
	extra: Record<string, unknown> = {},
): Extract<SessionEntry, { type: "custom" }> {
	const { sideEffectState, receiptId: suppliedReceiptId, ...payloadExtra } = extra;
	const receiptId =
		suppliedReceiptId === null ? undefined : (suppliedReceiptId ?? (phase === "terminal" ? "receipt-1" : undefined));
	const effectiveSideEffectState = sideEffectState ?? (phase === "terminal" ? "none" : undefined);
	return workerEntry(id, timestamp, "worker.operation_recorded", {
		schemaVersion: 1,
		class: "durable",
		category: "worker.operation_recorded",
		eventId: `worker-operation:worker-1:${revision}`,
		streamId: "worker-operation:worker-1:operation-1",
		sequence: revision,
		timestamp,
		correlation: {
			sessionId: WORKER_SESSION_ID,
			laneId: "main",
			workerId: "worker-1",
			operationId: "operation-1",
			...(receiptId === undefined ? {} : { receiptId }),
		},
		payload: {
			schemaVersion: 1,
			workerId: "worker-1",
			providerId: "sandbox",
			sessionId: WORKER_SESSION_ID,
			laneId: "main",
			operationId: "operation-1",
			phase,
			revision,
			recordedAt: timestamp,
			...(effectiveSideEffectState === undefined ? {} : { sideEffectState: effectiveSideEffectState }),
			...(receiptId === undefined ? {} : { receiptId }),
			...payloadExtra,
		},
	});
}

function workerReceiptEntry(): Extract<SessionEntry, { type: "custom" }> {
	return workerEntry("worker-receipt-entry", WORKER_TIMES.receipt, "worker_receipt.written", {
		schemaVersion: 1,
		class: "durable",
		category: "worker_receipt.written",
		eventId: "worker-receipt:receipt-1",
		streamId: "worker-receipts:worker-1",
		sequence: 4,
		timestamp: WORKER_TIMES.receipt,
		correlation: {
			sessionId: WORKER_SESSION_ID,
			operationId: "operation-1",
			workerReceiptId: "receipt-1",
			taskId: "task-1",
		},
		payload: {
			schemaVersion: 1,
			workerReceiptId: "receipt-1",
			operationId: "operation-1",
			taskId: "task-1",
		},
	});
}

function workerSession(entries: ReadonlyArray<SessionEntry>): AuditSession {
	return { getSessionId: () => WORKER_SESSION_ID, getEntries: () => entries };
}

function validWorkerEntries(): Extract<SessionEntry, { type: "custom" }>[] {
	return [
		...workerRunEntries(),
		workerLifecycleEntry("worker-starting", WORKER_TIMES.starting, "starting", 1),
		workerLifecycleEntry("worker-ready", WORKER_TIMES.ready, "ready", 2),
		workerOperationEntry("worker-claimed", WORKER_TIMES.ready, "claimed", 2),
		workerLifecycleEntry("worker-running", WORKER_TIMES.running, "running", 3, { operationId: "operation-1" }),
		workerOperationEntry("worker-started", WORKER_TIMES.running, "started", 3),
		workerLifecycleEntry("worker-completed", WORKER_TIMES.completed, "completed", 4, {
			operationId: "operation-1",
			receiptId: "receipt-1",
		}),
		workerOperationEntry("worker-terminal", WORKER_TIMES.completed, "terminal", 4, { receiptId: "receipt-1" }),
		workerReceiptEntry(),
	];
}

function validWorkerPrefix(
	sourceEntryCount: number,
	outcome: "completed" | "failed" | "cancelled" = "completed",
): Extract<SessionEntry, { type: "custom" }>[] {
	const runEntryCount = workerRunEntries().length;
	return [
		...workerRunEntries(outcome),
		...validWorkerEntries().slice(runEntryCount, runEntryCount + sourceEntryCount),
	];
}

function reclaimedWorkerEntries(): Extract<SessionEntry, { type: "custom" }>[] {
	return [
		...validWorkerEntries(),
		workerLifecycleEntry("worker-reclaiming", WORKER_TIMES.reclaiming, "reclaiming", 5),
		workerLifecycleEntry("worker-reclaimed", WORKER_TIMES.reclaimed, "reclaimed", 6),
	];
}

function reclaimUnknownWorkerEntries(): Extract<SessionEntry, { type: "custom" }>[] {
	return [
		...workerRunEntries("failed"),
		workerLifecycleEntry("worker-starting", WORKER_TIMES.starting, "starting", 1),
		workerLifecycleEntry("worker-ready", WORKER_TIMES.ready, "ready", 2),
		workerOperationEntry("worker-claimed", WORKER_TIMES.ready, "claimed", 2),
		workerLifecycleEntry("worker-running", WORKER_TIMES.running, "running", 3, { operationId: "operation-1" }),
		workerOperationEntry("worker-started", WORKER_TIMES.running, "started", 3),
		workerLifecycleEntry("worker-lost", WORKER_TIMES.completed, "lost", 4, {
			operationId: "operation-1",
			recordReceiptId: null,
		}),
		workerOperationEntry("worker-terminal-lost", WORKER_TIMES.completed, "terminal", 4, {
			sideEffectState: "side_effect_unknown",
			receiptId: null,
		}),
		workerLifecycleEntry("worker-reclaiming", WORKER_TIMES.reclaiming, "reclaiming", 5, {
			recordReceiptId: null,
		}),
		workerLifecycleEntry("worker-reclaim-unknown", WORKER_TIMES.reclaimed, "reclaim_unknown", 6, {
			recordReceiptId: null,
		}),
	];
}

function workerEnvelopeParts(entry: Extract<SessionEntry, { type: "custom" }>): {
	readonly data: Record<string, unknown>;
	readonly correlation: Record<string, unknown>;
	readonly payload: Record<string, unknown>;
} {
	const data = entry.data as Record<string, unknown>;
	return {
		data,
		correlation: data.correlation as Record<string, unknown>,
		payload: data.payload as Record<string, unknown>,
	};
}

describe("execution audit Worker source contract", () => {
	it("projects every lifecycle, operation, and receipt source with run linkage", () => {
		const folded = new ExecutionAuditAdapter(workerSession(validWorkerEntries())).fold();
		const workerEvents = folded.events.filter((event) => event.type.startsWith("worker."));
		expect(workerEvents.map((event) => event.type)).toEqual([
			"worker.lifecycle",
			"worker.operation",
			"worker.lifecycle",
			"worker.lifecycle",
			"worker.operation",
			"worker.lifecycle",
			"worker.operation",
			"worker.receipt",
		]);
		expect(workerEvents.every((event) => event.runId === WORKER_RUN_ID)).toBe(true);
		expect(workerEvents.map((event) => event.sourceEntryId)).toEqual([
			"worker-starting",
			"worker-claimed",
			"worker-ready",
			"worker-running",
			"worker-started",
			"worker-completed",
			"worker-terminal",
			"worker-receipt-entry",
		]);
		expect(workerEvents[0]).toMatchObject({
			type: "worker.lifecycle",
			summary: { status: "starting", revision: 1, workerId: "worker-1" },
		});
		expect(workerEvents[1]).toMatchObject({
			type: "worker.operation",
			summary: { phase: "claimed", operationId: "operation-1", revision: 2 },
		});
		expect(workerEvents.at(-1)).toMatchObject({
			type: "worker.receipt",
			summary: { workerReceiptId: "receipt-1", terminalRecordRevision: 4 },
		});
		expect(folded.warnings).toEqual([]);
	});

	it("accepts production-shape reclaimed and reclaim_unknown lifecycles", () => {
		const reclaimedEntries = reclaimedWorkerEntries();
		const reclaiming = workerEnvelopeParts(reclaimedEntries.at(-2)!);
		const reclaimed = workerEnvelopeParts(reclaimedEntries.at(-1)!);
		expect(reclaiming.payload.receiptId).toBe("receipt-1");
		expect(reclaimed.payload.receiptId).toBe("receipt-1");
		expect(reclaiming.correlation.receiptId).toBeUndefined();
		expect(reclaimed.correlation.receiptId).toBeUndefined();

		const reclaimedFold = new ExecutionAuditAdapter(workerSession(reclaimedEntries)).fold();
		expect(reclaimedFold.warnings).toEqual([]);
		expect(reclaimedFold.events.filter((event) => event.type === "worker.lifecycle").slice(-2)).toMatchObject([
			{ summary: { status: "reclaiming", endedAt: WORKER_TIMES.completed, receiptId: "receipt-1" } },
			{ summary: { status: "reclaimed", endedAt: WORKER_TIMES.completed, receiptId: "receipt-1" } },
		]);

		const unknownEntries = reclaimUnknownWorkerEntries();
		const unknownFold = new ExecutionAuditAdapter(workerSession(unknownEntries)).fold();
		expect(unknownFold.warnings).toEqual([]);
		expect(unknownFold.events.filter((event) => event.type === "worker.lifecycle").slice(-2)).toMatchObject([
			{ summary: { status: "reclaiming", endedAt: WORKER_TIMES.completed } },
			{ summary: { status: "reclaim_unknown", endedAt: WORKER_TIMES.completed } },
		]);
		expect(
			JSON.stringify(unknownFold.events.filter((event) => event.type === "worker.lifecycle").slice(-2)),
		).not.toContain("receiptId");
	});

	it("preserves lifecycle facts while allowing only monotonic heartbeat snapshots", () => {
		const entries = [
			...workerRunEntries(),
			workerLifecycleEntry("worker-starting", WORKER_TIMES.starting, "starting", 1),
			workerLifecycleEntry("worker-ready", WORKER_TIMES.ready, "ready", 2),
			workerOperationEntry("worker-claimed", WORKER_TIMES.ready, "claimed", 2),
			workerLifecycleEntry("worker-running", WORKER_TIMES.running, "running", 3, {
				operationId: "operation-1",
				lastHeartbeatAt: "2026-08-16T00:00:01.500Z",
			}),
			workerOperationEntry("worker-started", WORKER_TIMES.running, "started", 3),
			workerLifecycleEntry("worker-completed", WORKER_TIMES.completed, "completed", 4, {
				operationId: "operation-1",
				receiptId: "receipt-1",
				lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
			}),
			workerOperationEntry("worker-terminal", WORKER_TIMES.completed, "terminal", 4),
			workerReceiptEntry(),
			workerLifecycleEntry("worker-reclaiming", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
			}),
			workerLifecycleEntry("worker-reclaimed", WORKER_TIMES.reclaimed, "reclaimed", 6, {
				lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
			}),
		];
		const folded = new ExecutionAuditAdapter(workerSession(entries)).fold();
		expect(folded.warnings).toEqual([]);
		expect(folded.events.filter((event) => event.type === "worker.lifecycle").slice(-3)).toMatchObject([
			{
				summary: {
					status: "completed",
					readyAt: WORKER_TIMES.ready,
					endedAt: WORKER_TIMES.completed,
					receiptId: "receipt-1",
					lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
				},
			},
			{
				summary: {
					status: "reclaiming",
					readyAt: WORKER_TIMES.ready,
					endedAt: WORKER_TIMES.completed,
					receiptId: "receipt-1",
					lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
				},
			},
			{
				summary: {
					status: "reclaimed",
					readyAt: WORKER_TIMES.ready,
					endedAt: WORKER_TIMES.completed,
					receiptId: "receipt-1",
					lastHeartbeatAt: "2026-08-16T00:00:02.500Z",
				},
			},
		]);
	});

	it("rejects heartbeat rollback or disappearance from later lifecycle snapshots", () => {
		const prefix = [
			...validWorkerPrefix(3),
			workerLifecycleEntry("worker-running-heartbeat", WORKER_TIMES.running, "running", 3, {
				operationId: "operation-1",
				lastHeartbeatAt: "2026-08-16T00:00:01.500Z",
			}),
			workerOperationEntry("worker-started-heartbeat", WORKER_TIMES.running, "started", 3),
		];
		const invalidSnapshots = [
			workerLifecycleEntry("worker-heartbeat-rollback", WORKER_TIMES.completed, "completed", 4, {
				operationId: "operation-1",
				receiptId: "receipt-1",
				lastHeartbeatAt: "2026-08-16T00:00:01.400Z",
			}),
			workerLifecycleEntry("worker-heartbeat-disappeared", WORKER_TIMES.completed, "completed", 4, {
				operationId: "operation-1",
				receiptId: "receipt-1",
			}),
		];
		for (const snapshot of invalidSnapshots) {
			const folded = new ExecutionAuditAdapter(workerSession([...prefix, snapshot])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === snapshot.id),
				snapshot.id,
			).toBe(false);
			expect(folded.warnings, snapshot.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: snapshot.id,
				}),
			);
		}
	});

	it("rejects newly introduced or advanced heartbeats before the prior lifecycle transition", () => {
		const prefixes = [
			validWorkerPrefix(3),
			[
				...validWorkerPrefix(3),
				workerLifecycleEntry("worker-running-heartbeat-advanced", WORKER_TIMES.running, "running", 3, {
					operationId: "operation-1",
					lastHeartbeatAt: "2026-08-16T00:00:01.500Z",
				}),
				workerOperationEntry("worker-started-heartbeat-advanced", WORKER_TIMES.running, "started", 3),
			],
		];
		const snapshots = [
			workerLifecycleEntry("worker-heartbeat-introduced-too-early", WORKER_TIMES.completed, "completed", 4, {
				operationId: "operation-1",
				receiptId: "receipt-1",
				lastHeartbeatAt: "2026-08-16T00:00:01.500Z",
			}),
			workerLifecycleEntry("worker-heartbeat-advanced-too-early", WORKER_TIMES.completed, "completed", 4, {
				operationId: "operation-1",
				receiptId: "receipt-1",
				lastHeartbeatAt: "2026-08-16T00:00:01.600Z",
			}),
		];
		for (let index = 0; index < snapshots.length; index++) {
			const snapshot = snapshots[index]!;
			const folded = new ExecutionAuditAdapter(workerSession([...prefixes[index]!, snapshot])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === snapshot.id),
				snapshot.id,
			).toBe(false);
			expect(folded.warnings, snapshot.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: snapshot.id,
				}),
			);
		}
	});

	it("rejects tampered reclaim snapshots and lifecycle transition correlations", () => {
		const scenarios = [
			workerLifecycleEntry("worker-reclaim-repeats-receipt", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				receiptId: "receipt-1",
			}),
			workerLifecycleEntry("worker-reclaim-changes-receipt", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				recordReceiptId: "receipt-other",
			}),
			workerLifecycleEntry("worker-reclaim-has-operation", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				operationId: "operation-1",
			}),
			workerLifecycleEntry("worker-reclaim-changes-ready", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				readyAt: WORKER_TIMES.running,
			}),
			workerLifecycleEntry("worker-reclaim-changes-ended", WORKER_TIMES.reclaiming, "reclaiming", 5, {
				endedAt: WORKER_TIMES.reclaiming,
			}),
		];
		for (const scenario of scenarios) {
			const folded = new ExecutionAuditAdapter(workerSession([...validWorkerEntries(), scenario])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === scenario.id),
				scenario.id,
			).toBe(false);
			expect(folded.warnings, scenario.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: scenario.id,
				}),
			);
		}
	});

	it("binds lifecycle operation correlation to running, cancelling, and execution-terminal transitions", () => {
		const cancellingEntries = [
			...validWorkerPrefix(5, "cancelled"),
			workerLifecycleEntry("worker-cancelling", WORKER_TIMES.cancelling, "cancelling", 4, {
				operationId: "operation-1",
			}),
			workerLifecycleEntry("worker-cancelled", WORKER_TIMES.completed, "cancelled", 5, {
				operationId: "operation-1",
				receiptId: "receipt-1",
			}),
			workerOperationEntry("worker-terminal-cancelled", WORKER_TIMES.completed, "terminal", 5),
		];
		const cancellingFold = new ExecutionAuditAdapter(workerSession(cancellingEntries)).fold();
		expect(cancellingFold.warnings).toEqual([]);
		expect(cancellingFold.events.filter((event) => event.type === "worker.lifecycle").slice(-2)).toMatchObject([
			{ summary: { status: "cancelling", operationId: "operation-1", activeOperationId: "operation-1" } },
			{ summary: { status: "cancelled", operationId: "operation-1", receiptId: "receipt-1" } },
		]);

		const invalidTransitions = [
			workerLifecycleEntry("worker-running-wrong-operation", WORKER_TIMES.running, "running", 3, {
				operationId: "operation-other",
			}),
			workerLifecycleEntry("worker-completed-no-operation", WORKER_TIMES.completed, "completed", 4, {
				receiptId: "receipt-1",
			}),
		];
		const prefixes = [validWorkerPrefix(3), validWorkerPrefix(5)];
		for (let index = 0; index < invalidTransitions.length; index++) {
			const transition = invalidTransitions[index]!;
			const folded = new ExecutionAuditAdapter(workerSession([...prefixes[index]!, transition])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === transition.id),
				transition.id,
			).toBe(false);
			expect(folded.warnings, transition.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: transition.id,
				}),
			);
		}
	});

	it("accepts legal no-operation lifecycle paths without inventing operation facts", () => {
		const scenarios = [
			{
				entries: [
					...workerRunEntries("failed"),
					workerLifecycleEntry("worker-starting-failed", WORKER_TIMES.starting, "starting", 1),
					workerLifecycleEntry("worker-failed-without-operation", WORKER_TIMES.completed, "failed", 2, {
						recordReceiptId: null,
						readyAt: undefined,
					}),
				],
				statuses: ["starting", "failed"],
			},
			{
				entries: [
					...workerRunEntries("failed"),
					workerLifecycleEntry("worker-starting-lost", WORKER_TIMES.starting, "starting", 1),
					workerLifecycleEntry("worker-ready-for-lost", WORKER_TIMES.ready, "ready", 2),
					workerLifecycleEntry("worker-lost-without-operation", WORKER_TIMES.completed, "lost", 3, {
						recordReceiptId: null,
					}),
				],
				statuses: ["starting", "ready", "lost"],
			},
			{
				entries: [
					...workerRunEntries("cancelled"),
					workerLifecycleEntry("worker-starting-for-cancel", WORKER_TIMES.starting, "starting", 1),
					workerLifecycleEntry("worker-ready-for-cancel", WORKER_TIMES.ready, "ready", 2),
					workerLifecycleEntry("worker-cancelling-without-operation", WORKER_TIMES.cancelling, "cancelling", 3, {
						activeOperationId: undefined,
					}),
					workerLifecycleEntry("worker-cancelled-without-operation", WORKER_TIMES.completed, "cancelled", 4, {
						receiptId: "receipt-1",
					}),
				],
				statuses: ["starting", "ready", "cancelling", "cancelled"],
			},
		] as const;
		for (const scenario of scenarios) {
			const folded = new ExecutionAuditAdapter(workerSession(scenario.entries)).fold();
			expect(folded.warnings).toEqual([]);
			const lifecycleEvents = folded.events.filter((event) => event.type === "worker.lifecycle");
			expect(lifecycleEvents.map((event) => event.summary.status)).toEqual(scenario.statuses);
			for (const event of lifecycleEvents) {
				expect(event.summary).not.toHaveProperty("operationId");
				if (["failed", "lost", "cancelling", "cancelled"].includes(event.summary.status)) {
					expect(event.summary).not.toHaveProperty("activeOperationId");
				}
			}
		}
	});

	it("rejects supplied operation IDs when the prior lifecycle has no active operation", () => {
		const scenarios = [
			{
				prefix: [
					...workerRunEntries(),
					workerLifecycleEntry("worker-starting-for-failed-id", WORKER_TIMES.starting, "starting", 1),
				],
				entry: workerLifecycleEntry("worker-failed-with-supplied-id", WORKER_TIMES.completed, "failed", 2, {
					operationId: "operation-1",
					recordReceiptId: null,
					readyAt: undefined,
				}),
			},
			{
				prefix: [
					...workerRunEntries(),
					workerLifecycleEntry("worker-starting-for-lost-id", WORKER_TIMES.starting, "starting", 1),
					workerLifecycleEntry("worker-ready-for-lost-id", WORKER_TIMES.ready, "ready", 2),
				],
				entry: workerLifecycleEntry("worker-lost-with-supplied-id", WORKER_TIMES.completed, "lost", 3, {
					operationId: "operation-1",
					recordReceiptId: null,
				}),
			},
			{
				prefix: [
					...workerRunEntries(),
					workerLifecycleEntry("worker-starting-for-cancel-id", WORKER_TIMES.starting, "starting", 1),
					workerLifecycleEntry("worker-ready-for-cancel-id", WORKER_TIMES.ready, "ready", 2),
				],
				entry: workerLifecycleEntry(
					"worker-cancelling-with-supplied-id",
					WORKER_TIMES.cancelling,
					"cancelling",
					3,
					{
						operationId: "operation-1",
						activeOperationId: undefined,
					},
				),
			},
		];
		for (const scenario of scenarios) {
			const folded = new ExecutionAuditAdapter(workerSession([...scenario.prefix, scenario.entry])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === scenario.entry.id),
				scenario.entry.id,
			).toBe(false);
			expect(folded.warnings, scenario.entry.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: scenario.entry.id,
				}),
			);
		}
	});

	it("enforces phase-specific operation side-effect and receipt facts", () => {
		const claimedWithFacts = workerOperationEntry("worker-claimed-with-facts", WORKER_TIMES.ready, "claimed", 2, {
			sideEffectState: "none",
			receiptId: "receipt-1",
		});
		const startedWithFacts = workerOperationEntry("worker-started-with-facts", WORKER_TIMES.running, "started", 3, {
			receiptId: "receipt-1",
		});
		const completedWrongReceipt = workerOperationEntry(
			"worker-terminal-wrong-receipt",
			WORKER_TIMES.completed,
			"terminal",
			4,
			{ receiptId: "receipt-other" },
		);
		const completedMissingState = workerOperationEntry(
			"worker-terminal-missing-state",
			WORKER_TIMES.completed,
			"terminal",
			4,
		);
		delete workerEnvelopeParts(completedMissingState).payload.sideEffectState;
		const scenarios = [
			{ entry: claimedWithFacts, prefix: validWorkerPrefix(2) },
			{ entry: startedWithFacts, prefix: validWorkerPrefix(4) },
			{ entry: completedWrongReceipt, prefix: validWorkerPrefix(6) },
			{ entry: completedMissingState, prefix: validWorkerPrefix(6) },
		];
		for (const { entry, prefix } of scenarios) {
			const folded = new ExecutionAuditAdapter(workerSession([...prefix, entry])).fold();
			expect(
				folded.events.some((event) => event.sourceEntryId === entry.id),
				entry.id,
			).toBe(false);
			expect(folded.warnings, entry.id).toContainEqual(
				expect.objectContaining({
					code: "malformed_source",
					sourceEntryId: entry.id,
				}),
			);
		}

		const failedEntries = [
			...validWorkerPrefix(5, "failed"),
			workerLifecycleEntry("worker-failed", WORKER_TIMES.completed, "failed", 4, {
				operationId: "operation-1",
				recordReceiptId: null,
			}),
			workerOperationEntry("worker-terminal-failed", WORKER_TIMES.completed, "terminal", 4, {
				sideEffectState: "unknown",
				receiptId: null,
			}),
		];
		const failedFold = new ExecutionAuditAdapter(workerSession(failedEntries)).fold();
		expect(failedFold.warnings).toEqual([]);
		expect(failedFold.events.find((event) => event.sourceEntryId === "worker-terminal-failed")).toMatchObject({
			type: "worker.operation",
			summary: { phase: "terminal", sideEffectState: "unknown" },
		});

		const failedMissingState = workerOperationEntry(
			"worker-terminal-failed-missing-state",
			WORKER_TIMES.completed,
			"terminal",
			4,
			{ receiptId: null },
		);
		delete workerEnvelopeParts(failedMissingState).payload.sideEffectState;
		const missingFold = new ExecutionAuditAdapter(
			workerSession([...failedEntries.slice(0, -1), failedMissingState]),
		).fold();
		expect(missingFold.events.some((event) => event.sourceEntryId === failedMissingState.id)).toBe(false);
		expect(missingFold.warnings).toContainEqual(
			expect.objectContaining({
				code: "malformed_source",
				sourceEntryId: failedMissingState.id,
			}),
		);
	});

	it("binds a receipt marker to the terminal operation record receipt", () => {
		const original = workerReceiptEntry();
		const { data, correlation, payload } = workerEnvelopeParts(original);
		const mismatched = {
			...original,
			id: "worker-receipt-entry-other",
			data: {
				...data,
				eventId: "worker-receipt:receipt-other",
				correlation: { ...correlation, workerReceiptId: "receipt-other" },
				payload: { ...payload, workerReceiptId: "receipt-other" },
			},
		};
		const folded = new ExecutionAuditAdapter(workerSession([...validWorkerEntries(), mismatched])).fold();
		expect(folded.events.some((event) => event.sourceEntryId === mismatched.id)).toBe(false);
		expect(folded.warnings).toContainEqual(
			expect.objectContaining({
				code: "malformed_source",
				sourceEntryId: mismatched.id,
			}),
		);
	});

	it("rejects every forbidden Worker field without echoing its value", () => {
		const forbidden = [
			"pid",
			"executable",
			"argv",
			"cwd",
			"path",
			"env",
			"stdout",
			"stderr",
			"prompt",
			"secret",
			"token",
			"headers",
			"providerError",
			"rawFrame",
		];
		for (const key of forbidden) {
			const tampered = workerLifecycleEntry(`worker-forbidden-${key}`, WORKER_TIMES.starting, "starting", 1, {
				[key]: `sensitive-${key}`,
			});
			const folded = new ExecutionAuditAdapter(workerSession([tampered])).fold();
			expect(folded.events).toEqual([]);
			expect(folded.warnings.some((warning) => warning.code === "malformed_source")).toBe(true);
			expect(JSON.stringify(folded)).not.toContain(`sensitive-${key}`);
		}
	});

	it("fails closed for malformed, unknown, and out-of-order Worker records", () => {
		const malformed = workerOperationEntry("worker-malformed", WORKER_TIMES.starting, "started", 1);
		const unknown = customEntry("worker-unknown", WORKER_TIMES.starting, "worker.unknown", {
			schemaVersion: 1,
			pid: 123,
		});
		const folded = new ExecutionAuditAdapter(workerSession([malformed, unknown])).fold();
		expect(folded.events).toEqual([]);
		expect(folded.warnings.map((warning) => warning.code)).toEqual(["malformed_source", "unknown_source"]);
	});

	it("keeps replay deterministic and ignores late receipts for Run terminal state", () => {
		const entries = validWorkerEntries();
		const adapter = new ExecutionAuditAdapter(workerSession(entries));
		const first = adapter.replay(WORKER_RUN_ID);
		const second = adapter.replay(WORKER_RUN_ID);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.status).toBe("complete");
		expect(first.run.status).toBe("completed");
		const lateReceipt = workerReceiptEntry();
		const withLateReceipt = new ExecutionAuditAdapter(workerSession([...entries, lateReceipt])).replay(WORKER_RUN_ID);
		expect(withLateReceipt.run.status).toBe("completed");
		expect(withLateReceipt.events.filter((event) => event.type === "worker.receipt")).toHaveLength(1);
	});

	it("uses the durable envelope timestamp instead of the SessionEntry clock", () => {
		const entry = workerLifecycleEntry(
			"worker-starting-late-entry",
			WORKER_TIMES.starting,
			"starting",
			1,
			{},
			"2026-08-16T00:00:10.000Z",
		);
		const folded = new ExecutionAuditAdapter(workerSession([entry])).fold();
		expect(folded.events).toHaveLength(1);
		expect(folded.events[0]).toMatchObject({ recordedAt: WORKER_TIMES.starting });
		expect(folded.warnings.some((warning) => warning.code === "malformed_source")).toBe(false);
	});

	it("rejects lifecycle records from another audited session", () => {
		const entry = workerLifecycleEntry("worker-cross-session", WORKER_TIMES.starting, "starting", 1);
		const data = entry.data as Record<string, unknown>;
		const payload = data.payload as Record<string, unknown>;
		const correlation = data.correlation as Record<string, unknown>;
		const crossSession = {
			...entry,
			data: {
				...data,
				payload: { ...payload, sessionId: "other-session" },
				correlation: { ...correlation, sessionId: "other-session" },
			},
		};
		const folded = new ExecutionAuditAdapter(workerSession([crossSession])).fold();
		expect(folded.events).toEqual([]);
		expect(folded.warnings.some((warning) => warning.code === "malformed_source")).toBe(true);
	});

	it("rejects an operation payload whose revision differs from the envelope sequence", () => {
		const entry = workerOperationEntry("worker-claimed-revision-mismatch", WORKER_TIMES.ready, "claimed", 2);
		const data = entry.data as Record<string, unknown>;
		const payload = data.payload as Record<string, unknown>;
		const mismatched = { ...entry, data: { ...data, payload: { ...payload, revision: 99 } } };
		const folded = new ExecutionAuditAdapter(
			workerSession([
				workerLifecycleEntry("worker-starting-for-revision", WORKER_TIMES.starting, "starting", 1),
				workerLifecycleEntry("worker-ready-for-revision", WORKER_TIMES.ready, "ready", 2),
				mismatched,
			]),
		).fold();
		expect(folded.events.filter((event) => event.type === "worker.operation")).toEqual([]);
		expect(folded.warnings.some((warning) => warning.code === "malformed_source")).toBe(true);
	});

	it("rejects lifecycle envelope time rollback for a worker", () => {
		const folded = new ExecutionAuditAdapter(
			workerSession([
				workerLifecycleEntry("worker-starting-time-order", "2026-08-16T00:00:00.500Z", "starting", 1),
				workerLifecycleEntry("worker-ready-time-rollback", "2026-08-16T00:00:00.400Z", "ready", 2, {
					readyAt: "2026-08-16T00:00:00.400Z",
				}),
			]),
		).fold();
		expect(folded.events.map((event) => event.sourceEntryId)).toEqual(["worker-starting-time-order"]);
		expect(
			folded.warnings.some(
				(warning) => warning.sourceEntryId === "worker-ready-time-rollback" && warning.code === "malformed_source",
			),
		).toBe(true);
	});
});

describe("execution audit Scheduler source contract", () => {
	const schedulerEntry = (dataOverride: Record<string, unknown> = {}): Extract<SessionEntry, { type: "custom" }> =>
		customEntry("scheduler-entry-1", "2026-08-22T00:00:00.000Z", "scheduler.executor_selected", {
			schemaVersion: 1,
			class: "durable",
			category: "scheduler.executor_selected",
			eventId: "scheduler-event-1",
			streamId: "scheduler-stream-1",
			sequence: 1,
			timestamp: "2026-08-22T00:00:00.000Z",
			correlation: { sessionId: "scheduler-session", taskId: "task-1" },
			payload: {
				schemaVersion: 1,
				queueEntryId: "queue-1",
				taskId: "task-1",
				chosenProviderId: "provider-1",
				inputsDigest: "sha256:selection",
				decidedAt: "2026-08-22T00:00:00.000Z",
				scoreCount: 1,
			},
			...dataOverride,
		});

	it("projects validated scheduler metadata without payload material", () => {
		const session: AuditSession = { getSessionId: () => "scheduler-session", getEntries: () => [schedulerEntry()] };
		const folded = new ExecutionAuditAdapter(session).fold();
		expect(folded.warnings).toEqual([]);
		expect(folded.events).toHaveLength(1);
		expect(folded.events[0]).toMatchObject({
			type: "scheduler.event",
			recordedAt: "2026-08-22T00:00:00.000Z",
			summary: {
				category: "scheduler.executor_selected",
				eventId: "scheduler-event-1",
				sequence: 1,
				safeSummary: "scheduler.executor_selected revision 1",
				correlation: { sessionId: "scheduler-session", taskId: "task-1" },
			},
		});
		expect(JSON.stringify(folded.events[0])).not.toContain("chosenProviderId");
	});

	it("rejects forbidden scheduler fields recursively", () => {
		expect(hasForbiddenSchedulerAuditValue({ nested: { prompt: "secret" } })).toBe(true);
		const clean = schedulerEntry();
		const data = clean.data as Record<string, unknown>;
		const payload = data.payload as Record<string, unknown>;
		const session: AuditSession = {
			getSessionId: () => "scheduler-session",
			getEntries: () => [{ ...clean, data: { ...data, payload: { ...payload, prompt: "secret" } } }],
		};
		const folded = new ExecutionAuditAdapter(session).fold();
		expect(folded.events).toEqual([]);
		expect(folded.warnings).toContainEqual(expect.objectContaining({ code: "malformed_source" }));
	});
});
