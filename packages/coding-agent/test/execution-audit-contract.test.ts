import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	AUDIT_EVENT_TYPES as SRC_AUDIT_EVENT_TYPES,
	AUDIT_SOURCE_CUSTOM_TYPES as SRC_AUDIT_SOURCE_CUSTOM_TYPES,
	TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEYS,
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
		// The T0 fixture predates the remote.operation and task.credential
		// sources; ignoring those known later additions, task.graph must be the
		// only remaining delta.
		expect(SRC_AUDIT_SOURCE_CUSTOM_TYPES.filter((type) => type !== "remote.operation" && type !== "task.credential")).toEqual([
			...AUDIT_SOURCE_CUSTOM_TYPES,
			"task.graph",
		]);
		expect(SRC_AUDIT_EVENT_TYPES.filter((type) => type !== "remote.operation" && type !== "task.credential")).toEqual([
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

function credentialGrantSnapshot(options: {
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
} = {}): Record<string, unknown> {
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
	return [
		customEntry("run-accepted", CREDENTIAL_TIMES.accepted, "automation.run", {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: CREDENTIAL_RUN_ID,
				sessionId: CREDENTIAL_SESSION_ID,
				attempt: 1,
				status: "accepted",
				model: { provider: "provider", id: "model", thinkingLevel: "high" },
			},
		}),
		customEntry("run-terminal", CREDENTIAL_TIMES.terminal, "automation.run", {
			schemaVersion: 1,
			kind: "terminal",
			endedAt: CREDENTIAL_TIMES.terminal,
			receipt: {
				runId: CREDENTIAL_RUN_ID,
				sessionId: CREDENTIAL_SESSION_ID,
				status: "completed",
				usage: { input: 1, output: 1, total: 2 },
			},
		}),
	];
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
		expect(SRC_AUDIT_SOURCE_CUSTOM_TYPES.filter((type) => type !== "remote.operation")).toEqual([
			...AUDIT_SOURCE_CUSTOM_TYPES,
			"task.graph",
			"task.credential",
		]);
		expect(SRC_AUDIT_EVENT_TYPES.filter((type) => type !== "remote.operation")).toEqual([
			...AUDIT_EVENT_TYPES,
			"task.graph",
			"task.credential",
		]);
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
			expect(
				TASK_CREDENTIAL_SUMMARY_KEYS.includes(key as (typeof TASK_CREDENTIAL_SUMMARY_KEYS)[number]),
				key,
			).toBe(true);
		}
		expect(Object.keys(issued.summary ?? {})).toEqual(
			TASK_CREDENTIAL_SUMMARY_KEYS.filter((key) => key !== "stageId" && key !== "stageRevision" && key !== "targetId" && key !== "reasonCode"),
		);
		const settled = credentialEvents[4]!;
		expect(settled).toMatchObject({
			type: "task.credential",
			summary: { action: "settled", status: "settled", recordedAt: CREDENTIAL_TIMES.settled },
		});
		expect((settled as { summary: { reasonCode?: string } }).summary.reasonCode).toBeUndefined();
		expect((credentialEvents[3] as { summary: { reasonCode?: string } }).summary.reasonCode).toBe(
			"operator_revoked",
		);
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
