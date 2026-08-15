import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	AUDIT_EVENT_TYPES as SRC_AUDIT_EVENT_TYPES,
	AUDIT_SOURCE_CUSTOM_TYPES as SRC_AUDIT_SOURCE_CUSTOM_TYPES,
	type AuditEvent,
	type AuditSession,
} from "../src/core/execution-audit.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
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
	EXTERNAL_EXECUTION_REF_KEYS,
	EXTERNAL_MAP_COMMAND,
	EXTERNAL_MAPPING_KEYS,
} from "./fixtures/execution-audit-contract.ts";

describe("execution audit T0 contract", () => {
	it("freezes the v1 commands, event union, and source types", () => {
		expect(AUDIT_SCHEMA_VERSION).toBe(1);
		expect(AUDIT_QUERY_COMMAND).toBe("audit.query");
		expect(AUDIT_REPLAY_COMMAND).toBe("audit.replay");
		expect(EXTERNAL_MAP_COMMAND).toBe("external.map");
		expect(AUDIT_SOURCE_CUSTOM_TYPES).toEqual([
			"automation.run",
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"external.mapping",
			"task.gate",
		]);
		expect(AUDIT_EXCLUDED_CUSTOM_TYPES).toEqual(["context.memory"]);
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
			"external.mapping",
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
			"mapping_conflict",
		]);
		expect(AUDIT_ERROR_CODES).toEqual([
			"audit_query_invalid",
			"audit_cursor_invalid",
			"audit_scope_unavailable",
			"audit_run_not_found",
			"audit_replay_incomplete",
			"external_mapping_invalid",
			"external_mapping_conflict",
			"audit_persistence_failed",
		]);
		expect(AUDIT_DEFAULT_LIMIT).toBe(50);
		expect(AUDIT_MAX_LIMIT).toBe(200);
		expect(AUDIT_CURSOR_SORT_KEYS).toEqual(["recordedAt", "sessionId", "sourceEntryId", "eventId"]);
	});

	it("freezes external mapping keys and public summary allowlists", () => {
		expect(EXTERNAL_EXECUTION_REF_KEYS).toEqual(["namespace", "externalSessionId", "externalRunId"]);
		expect(EXTERNAL_MAPPING_KEYS).toEqual([
			"namespace",
			"externalSessionId",
			"externalRunId",
			"aosSessionId",
			"aosRunId",
			"createdAt",
			"source",
			"correlationId",
		]);
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
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.externalMapping).toBe(EXTERNAL_MAPPING_KEYS);
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
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("TaskGateStore mutation (task.gate.request/approve/reject/cancel)");
		for (const testCase of AUDIT_CONTRACT_CASES) expect(testCase.sideEffects, testCase.id).toEqual([]);
	});

	it("keeps the replay/error distinction explicit", () => {
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "accepted-without-terminal-is-interrupted")?.expectedStatus).toBe(
			"interrupted",
		);
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "malformed-source-is-incomplete")?.expectedStatus).toBe("incomplete");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "missing-run-is-an-error")?.expectedError).toBe("audit_run_not_found");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "bad-cursor-is-an-error")?.expectedError).toBe("audit_cursor_invalid");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "mapping-persistence-failure-is-an-error")?.expectedError).toBe(
			"audit_persistence_failed",
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
	return [
		graphCustomEntry("run-accepted", GRAPH_TIMES.accepted, "automation.run", {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: GRAPH_RUN_ID,
				sessionId: GRAPH_SESSION_ID,
				attempt: 1,
				status: "accepted",
				model: { provider: "provider", id: "model", thinkingLevel: "high" },
			},
		}),
		graphCustomEntry("run-terminal", GRAPH_TIMES.terminal, "automation.run", {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: GRAPH_TIMES.terminal,
			receipt: {
				runId: GRAPH_RUN_ID,
				sessionId: GRAPH_SESSION_ID,
				status: "completed",
				usage: { input: 1, output: 1, total: 2 },
			},
		}),
	];
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
		// The T0 fixture predates the remote.operation source; ignoring that
		// known later addition, task.graph must be the only remaining delta.
		expect(SRC_AUDIT_SOURCE_CUSTOM_TYPES.filter((type) => type !== "remote.operation")).toEqual([
			...AUDIT_SOURCE_CUSTOM_TYPES,
			"task.graph",
		]);
		expect(SRC_AUDIT_EVENT_TYPES.filter((type) => type !== "remote.operation")).toEqual([
			...AUDIT_EVENT_TYPES,
			"task.graph",
		]);
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
		expect(folded.warnings.filter((warning) => warning.eventType === "task.graph").map((warning) => warning.code)).toEqual([
			"malformed_source",
			"malformed_source",
		]);
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
			folded.warnings.filter(
				(warning) => warning.eventType === "task.graph" && warning.sourceEntryId === entryId,
			);
		expect(graphWarnings("graph-unsupported")).toEqual([
			{ code: "unsupported_schema", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-unsupported", eventType: "task.graph", schemaVersion: 2 },
		]);
		expect(graphWarnings("graph-garbage")).toEqual([
			{ code: "malformed_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-garbage", eventType: "task.graph" },
		]);
		expect(graphWarnings("graph-foreign-create")).toEqual([
			{ code: "orphan_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-foreign-create", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-unknown-dep")).toEqual([
			{ code: "malformed_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-unknown-dep", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-cycle")).toEqual([
			{ code: "malformed_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-cycle", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-foreign-attach")).toEqual([
			{ code: "orphan_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-foreign-attach", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-gap")).toEqual([
			{ code: "malformed_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-gap", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-jump")).toEqual([
			{ code: "malformed_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-jump", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-dup-key")).toEqual([
			{ code: "duplicate_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-dup-key", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-dup-run")).toEqual([
			{ code: "duplicate_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-dup-run", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-repeat")).toEqual([
			{ code: "duplicate_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-repeat", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-second-create")).toEqual([
			{ code: "duplicate_source", sessionId: GRAPH_SESSION_ID, sourceEntryId: "graph-second-create", eventType: "task.graph", schemaVersion: 1 },
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
