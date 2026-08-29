import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
	AUDIT_MAX_SESSION_CANDIDATES,
	ExecutionAuditQuery,
	createExecutionAuditQuery,
} from "../src/core/session/execution-audit-query.ts";
import { ExecutionAuditError, type AuditSession, type AuditEvent } from "../src/core/session/execution-audit.ts";
import type { FileEntry, SessionEntry } from "../src/core/session/manager.ts";

const CURRENT_SESSION_ID = "session-query-current";
const RUN_ID = "run-query-1";
const ACCEPTED_AT = "2026-08-13T00:00:00.000Z";
const STARTED_AT = "2026-08-13T00:00:00.500Z";
const TERMINAL_AT = "2026-08-13T00:00:01.000Z";
const GATE_REQUESTED_AT = "2026-08-13T00:00:02.000Z";
const GATE_DECIDED_AT = "2026-08-13T00:00:03.000Z";

function customEntry(id: string, timestamp: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp, customType, data };
}

function acceptedEntry(sessionId = CURRENT_SESSION_ID, entryId = "accepted"): SessionEntry {
	return customEntry(entryId, ACCEPTED_AT, "automation.run", {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: RUN_ID,
			sessionId,
			attempt: 1,
			status: "accepted",
			model: { provider: "provider", id: "model", thinkingLevel: "high" },
		},
	});
}

function terminalEntry(entryId = "terminal"): SessionEntry {
	return customEntry(entryId, TERMINAL_AT, "automation.run", {
		schemaVersion: 1,
		kind: "terminal",
		endedAt: TERMINAL_AT,
		receipt: {
			runId: RUN_ID,
			sessionId: CURRENT_SESSION_ID,
			status: "completed",
			usage: { input: 1, output: 1, total: 2 },
		},
	});
}

function startedEntry(entryId = "started"): SessionEntry {
	return customEntry(entryId, STARTED_AT, "automation.run", {
		schemaVersion: 1,
		kind: "started",
		runId: RUN_ID,
		startedAt: STARTED_AT,
	});
}

function gateEntry(
	entryId: string,
	action: "requested" | "approved" | "rejected" | "cancelled",
	gateId: string,
	options: {
		readonly sessionId?: string;
		readonly runId?: string;
		readonly revision?: number;
		readonly taskId?: string;
		readonly stageId?: string;
		readonly stageRevision?: number;
	} = {},
): SessionEntry {
	const sessionId = options.sessionId ?? CURRENT_SESSION_ID;
	const revision = options.revision ?? (action === "requested" ? 0 : 1);
	const status = action === "requested" ? "pending" : action;
	const gate: Record<string, unknown> = {
		schemaVersion: 1,
		sessionId,
		gateId,
		taskId: options.taskId ?? "task_42",
		stageId: options.stageId ?? "stage_review",
		stageRevision: options.stageRevision ?? 3,
		status,
		revision,
		requestedAt: GATE_REQUESTED_AT,
	};
	if (action !== "requested") gate.decidedAt = GATE_DECIDED_AT;
	if (options.runId !== undefined) gate.runId = options.runId;
	return customEntry(entryId, action === "requested" ? GATE_REQUESTED_AT : GATE_DECIDED_AT, "task.gate", {
		schemaVersion: 1,
		action,
		gate,
		previousRevision: 0,
		clientRequestId: `req-${entryId}`,
	});
}

function source(sessionId: string, entries: ReadonlyArray<SessionEntry>, sessionDir: string): AuditSession & { getSessionDir(): string } {
	return {
		getSessionId: () => sessionId,
		getEntries: () => entries,
		getSessionDir: () => sessionDir,
	};
}

function writeSession(dir: string, sessionId: string, entries: ReadonlyArray<SessionEntry>, fileName = sessionId): string {
	const path = join(dir, `${fileName}.jsonl`);
	const header: FileEntry = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: ACCEPTED_AT,
		cwd: dir,
	};
	writeFileSync(path, `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

describe("cross-session execution audit query", () => {
	it("merges directory sessions deterministically and deduplicates source identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a", "same-source")]);
			writeSession(dir, "session-a", [acceptedEntry("session-a", "same-source")], "session-a-copy");
			writeSession(dir, "session-b", [acceptedEntry("session-b", "other-source")]);
			const query = createExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir));

			const result = query.query({ scope: "session-directory", types: ["run.accepted"], limit: 200 });
			expect(result.events.map((event) => `${event.sessionId}:${event.sourceEntryId}`)).toEqual([
				"session-a:same-source",
				"session-b:other-source",
			]);
			expect(result.events).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("binds cursors to the directory query, including scope and limit", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a", "a")]);
			writeSession(dir, "session-b", [acceptedEntry("session-b", "b")]);
			const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir), { cursorSecret: "query-secret" });
			const first = query.query({ scope: "session-directory", limit: 1 });
			expect(first.nextCursor).toBeDefined();
			expect(query.query({ scope: "session-directory", limit: 1, cursor: first.nextCursor }).events).toHaveLength(1);
			expect(() => query.query({ scope: "session-directory", limit: 2, cursor: first.nextCursor })).toThrowError(
				new ExecutionAuditError("audit_cursor_invalid"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps directory paths server-resolved and rejects symlink candidates safely", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		const outside = mkdtempSync(join(tmpdir(), "aos-audit-outside-"));
		try {
			writeSession(outside, "outside", [acceptedEntry("outside")]);
			try {
				symlinkSync(join(outside, "outside.jsonl"), join(dir, "outside.jsonl"));
			} catch {
				return;
			}
			const result = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir)).query({
				scope: "session-directory",
				limit: 200,
			});
			expect(result.events).toEqual([]);
			expect(result.warnings.some((warning) => warning.code === "source_unavailable")).toBe(true);
			expect(JSON.stringify(result)).not.toContain(outside);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("returns complete and interrupted replay without invoking execution", () => {
		const completeEntries = [acceptedEntry(CURRENT_SESSION_ID), startedEntry(), terminalEntry()];
		const complete = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, completeEntries, ""));
		expect(complete.replay(RUN_ID).status).toBe("complete");

		const interrupted = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [acceptedEntry()], ""));
		const replay = interrupted.replay(RUN_ID);
		expect(replay.status).toBe("interrupted");
		expect(replay.events.some((event: AuditEvent) => event.type === "run.interrupted")).toBe(true);

		const incomplete = new ExecutionAuditQuery(
			source(CURRENT_SESSION_ID, [acceptedEntry(), customEntry("unknown", TERMINAL_AT, "unknown.source", { raw: "secret" })], ""),
		);
		const incompleteReplay = incomplete.replay(RUN_ID);
		expect(incompleteReplay.status).toBe("incomplete");
		expect(incompleteReplay.warnings.map((warning) => warning.code)).toContain("unknown_source");
		expect(JSON.stringify(incompleteReplay)).not.toContain("secret");
	});

	it("enforces the candidate limit before reading unbounded files", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a")]);
			writeSession(dir, "session-b", [acceptedEntry("session-b")]);
			const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir), { maxCandidates: 1 });
			expect(() => query.query({ scope: "session-directory" })).toThrowError(new ExecutionAuditError("audit_scope_unavailable"));
			expect(AUDIT_MAX_SESSION_CANDIDATES).toBeGreaterThan(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("folds task.gate entries into allowlisted events and filters them by type", () => {
		const entries = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			gateEntry("gate-request", "requested", "gate_001", { runId: RUN_ID }),
			gateEntry("gate-approve", "approved", "gate_001", { runId: RUN_ID }),
			gateEntry("gate-standalone", "requested", "gate_002", { stageRevision: 4, runId: "run-other" }),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const result = query.query({ scope: "current-session", types: ["task.gate"], limit: 200 });
		expect(result.events.map((event) => `${event.sourceEntryId}:${event.type}`)).toEqual([
			"gate-request:task.gate",
			"gate-standalone:task.gate",
			"gate-approve:task.gate",
		]);
		const requested = result.events[0];
		expect(requested?.runId).toBe(RUN_ID);
		expect(requested?.summary).toEqual({
			gateId: "gate_001",
			taskId: "task_42",
			stageId: "stage_review",
			stageRevision: 3,
			status: "pending",
			action: "requested",
			revision: 0,
			requestedAt: GATE_REQUESTED_AT,
			runId: RUN_ID,
		});
		const approved = result.events[2];
		expect(approved?.summary).toMatchObject({
			status: "approved",
			action: "approved",
			revision: 1,
			decidedAt: GATE_DECIDED_AT,
			runId: RUN_ID,
		});
		const encoded = JSON.stringify(result);
		expect(encoded).not.toContain("req-gate-request");
		expect(encoded).not.toContain("clientRequestId");
	});

	it("correlates a gate into replay only by exact runId without changing terminal status", () => {
		const entries = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			gateEntry("gate-request", "requested", "gate_001", { runId: RUN_ID }),
			gateEntry("gate-approve", "approved", "gate_001", { runId: RUN_ID }),
			gateEntry("gate-standalone", "requested", "gate_002", { stageRevision: 4 }),
			gateEntry("gate-other-run", "requested", "gate_003", { stageRevision: 5, runId: "run-other" }),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const replay = query.replay(RUN_ID);
		expect(replay.status).toBe("complete");
		const gateEvents = replay.events.filter((event: AuditEvent) => event.type === "task.gate");
		expect(gateEvents.map((event) => event.sourceEntryId)).toEqual(["gate-request", "gate-approve"]);
		// A gate without runId is never guessed into a Run, and a gate with a
		// different runId is never pulled into this replay.
		expect(gateEvents.some((event) => event.sourceEntryId === "gate-standalone")).toBe(false);
		expect(gateEvents.some((event) => event.sourceEntryId === "gate-other-run")).toBe(false);
	});

	it("skips malformed and mismatched task.gate entries with warnings and no raw data", () => {
		const entries: SessionEntry[] = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			customEntry("gate-unsupported", GATE_REQUESTED_AT, "task.gate", { schemaVersion: 2, action: "requested" }),
			customEntry("gate-garbage", GATE_REQUESTED_AT, "task.gate", "raw secret payload"),
			gateEntry("gate-foreign", "requested", "gate_foreign", { sessionId: "other-session" }),
			customEntry("gate-gap", GATE_DECIDED_AT, "task.gate", {
				schemaVersion: 1,
				action: "approved",
				gate: {
					schemaVersion: 1,
					sessionId: CURRENT_SESSION_ID,
					gateId: "gate_gap",
					taskId: "task_42",
					stageId: "stage_review",
					stageRevision: 3,
					status: "approved",
					revision: 1,
					requestedAt: GATE_REQUESTED_AT,
					decidedAt: GATE_DECIDED_AT,
				},
				previousRevision: 0,
				clientRequestId: "req-gap",
			}),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const result = query.query({ scope: "current-session", types: ["task.gate"], limit: 200 });
		expect(result.events).toEqual([]);
			expect(result.warnings.map((warning) => warning.code)).toEqual([
			"orphan_source",
			"malformed_source",
			"malformed_source",
			"unsupported_schema",
		]);
		const encoded = JSON.stringify(result);
		expect(encoded).not.toContain("raw secret payload");
		expect(encoded).not.toContain("other-session");
		expect(encoded).not.toContain("req-gap");
		// Gate warnings never change the Run's replay completeness.
		const replay = query.replay(RUN_ID);
		expect(replay.status).toBe("complete");
		expect(replay.events.some((event: AuditEvent) => event.type === "task.gate")).toBe(false);
	});
});

const GRAPH_CREATED_AT = "2026-08-13T00:00:04.000Z";
const GRAPH_ATTACHED_AT = "2026-08-13T00:00:05.000Z";
const GRAPH_SETTLED_AT = "2026-08-13T00:00:06.000Z";
const GRAPH_TASK_ID = "task_graph_1";

type GraphNodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

function graphNodeRecord(
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

function graphCreated(
	entryId = "graph-created",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
	} = {},
): SessionEntry {
	const taskId = options.taskId ?? GRAPH_TASK_ID;
	const graphRevision = options.graphRevision ?? 1;
	return customEntry(entryId, GRAPH_CREATED_AT, "task.graph", {
		schemaVersion: 1,
		action: "created",
		taskId,
		graphRevision,
		graph: {
			schemaVersion: 1,
			sessionId: options.sessionId ?? CURRENT_SESSION_ID,
			taskId,
			graphRevision,
			createdAt: GRAPH_CREATED_AT,
			nodes: [graphNodeRecord("inspect"), graphNodeRecord("implement", { dependsOn: ["inspect"] })],
		},
		clientRequestId: options.clientRequestId ?? "req-graph-create",
	});
}

function graphAttached(
	entryId = "graph-attached",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly nodeId?: string;
		readonly dependsOn?: ReadonlyArray<string>;
		readonly runId?: string;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
		readonly nodeRevision?: number;
		readonly status?: GraphNodeStatus;
	} = {},
): SessionEntry {
	return customEntry(entryId, GRAPH_ATTACHED_AT, "task.graph", {
		schemaVersion: 1,
		action: "node.attached",
		taskId: options.taskId ?? GRAPH_TASK_ID,
		graphRevision: options.graphRevision ?? 1,
		node: graphNodeRecord(options.nodeId ?? "inspect", {
			dependsOn: options.dependsOn,
			status: options.status ?? "running",
			nodeRevision: options.nodeRevision ?? 1,
			runRef: {
				sessionId: options.sessionId ?? CURRENT_SESSION_ID,
				runId: options.runId ?? RUN_ID,
			},
		}),
		previousNodeRevision: 0,
		clientRequestId: options.clientRequestId ?? "req-graph-attach",
	});
}

function graphSettled(
	entryId: string,
	action: "node.succeeded" | "node.failed" | "node.cancelled",
	options: {
		readonly taskId?: string;
		readonly graphRevision?: number;
		readonly nodeId?: string;
		readonly runId?: string;
		readonly sessionId?: string;
		readonly clientRequestId?: string;
		readonly outcomeCode?: string;
	} = {},
): SessionEntry {
	const status: GraphNodeStatus =
		action === "node.succeeded" ? "succeeded" : action === "node.failed" ? "failed" : "cancelled";
	return customEntry(entryId, GRAPH_SETTLED_AT, "task.graph", {
		schemaVersion: 1,
		action,
		taskId: options.taskId ?? GRAPH_TASK_ID,
		graphRevision: options.graphRevision ?? 1,
		node: graphNodeRecord(options.nodeId ?? "inspect", {
			status,
			nodeRevision: 2,
			runRef: {
				sessionId: options.sessionId ?? CURRENT_SESSION_ID,
				runId: options.runId ?? RUN_ID,
			},
			...(options.outcomeCode === undefined ? {} : { outcomeCode: options.outcomeCode }),
		}),
		previousNodeRevision: 1,
		clientRequestId: options.clientRequestId ?? `req-graph-${entryId}`,
	});
}

describe("cross-session execution audit query task graph", () => {
	it("folds task.graph entries into allowlisted events and filters them by type", () => {
		const entries = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			graphCreated(),
			graphAttached(),
			graphSettled("graph-settled", "node.succeeded", { outcomeCode: "ok" }),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const result = query.query({ scope: "current-session", types: ["task.graph"], limit: 200 });
		expect(result.events.map((event) => `${event.sourceEntryId}:${event.type}`)).toEqual([
			"graph-created:task.graph",
			"graph-attached:task.graph",
			"graph-settled:task.graph",
		]);
		const created = result.events[0];
		expect(created?.runId).toBeUndefined();
		expect(created?.summary).toEqual({ taskId: GRAPH_TASK_ID, graphRevision: 1, action: "created" });
		const attached = result.events[1];
		expect(attached?.runId).toBe(RUN_ID);
		expect(attached?.summary).toEqual({
			taskId: GRAPH_TASK_ID,
			graphRevision: 1,
			nodeId: "inspect",
			action: "node.attached",
			status: "running",
			nodeRevision: 1,
			runId: RUN_ID,
		});
		const settled = result.events[2];
		expect(settled?.summary).toMatchObject({
			action: "node.succeeded",
			status: "succeeded",
			nodeRevision: 2,
			runId: RUN_ID,
			outcomeCode: "ok",
		});
		const encoded = JSON.stringify(result);
		expect(encoded).not.toContain("req-graph-create");
		expect(encoded).not.toContain("req-graph-attach");
		expect(encoded).not.toContain("req-graph-graph-settled");
		expect(encoded).not.toContain("clientRequestId");
	});

	it("correlates a graph into replay only by exact runId without changing terminal status", () => {
		const entries = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			graphCreated(),
			graphAttached(),
			graphSettled("graph-settled", "node.succeeded", { outcomeCode: "ok" }),
			graphAttached("graph-attached-other", {
				nodeId: "implement",
				dependsOn: ["inspect"],
				runId: "run-other",
				clientRequestId: "req-graph-other",
			}),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const replay = query.replay(RUN_ID);
		expect(replay.status).toBe("complete");
		const graphEvents = replay.events.filter((event: AuditEvent) => event.type === "task.graph");
		expect(graphEvents.map((event) => event.sourceEntryId)).toEqual(["graph-attached", "graph-settled"]);
		// created has no runId and the implement node belongs to run-other;
		// neither is guessed into this Run by taskId, nodeId, or dependencies.
		expect(graphEvents.some((event) => event.sourceEntryId === "graph-created")).toBe(false);
		expect(graphEvents.some((event) => event.sourceEntryId === "graph-attached-other")).toBe(false);
	});

	it("skips malformed, unsupported, session-mismatched, and duplicate graph entries with safe warnings", () => {
		const entries: SessionEntry[] = [
			acceptedEntry(),
			startedEntry(),
			terminalEntry(),
			customEntry("graph-unsupported", GRAPH_CREATED_AT, "task.graph", { schemaVersion: 2, action: "created" }),
			customEntry("graph-garbage", GRAPH_CREATED_AT, "task.graph", "raw graph secret"),
			graphCreated(),
			graphCreated("graph-second-create", { clientRequestId: "req-graph-create-2" }),
			graphAttached("graph-foreign", {
				sessionId: "other-session",
				runId: "run-foreign",
				clientRequestId: "req-graph-foreign",
			}),
			graphSettled("graph-gap", "node.succeeded", { clientRequestId: "req-graph-gap" }),
			graphAttached("graph-jump", {
				nodeId: "implement",
				nodeRevision: 2,
				status: "succeeded",
				clientRequestId: "req-graph-jump",
			}),
			graphAttached(),
			graphAttached("graph-attached-dup", { runId: "run-b", clientRequestId: "req-graph-dup" }),
			graphSettled("graph-settled", "node.succeeded", { outcomeCode: "ok" }),
		];
		const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, entries, ""));

		const result = query.query({ scope: "current-session", types: ["task.graph"], limit: 200 });
		expect(result.events.map((event) => event.sourceEntryId)).toEqual([
			"graph-created",
			"graph-attached",
			"graph-settled",
		]);
		expect(result.warnings.map((warning) => warning.code)).toEqual(
			expect.arrayContaining(["unsupported_schema", "malformed_source", "orphan_source", "duplicate_source"]),
		);
		const graphWarnings = (entryId: string) =>
			result.warnings.filter(
				(warning) => warning.eventType === "task.graph" && warning.sourceEntryId === entryId,
			);
		expect(graphWarnings("graph-second-create")).toEqual([
			{ code: "duplicate_source", sessionId: CURRENT_SESSION_ID, sourceEntryId: "graph-second-create", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-foreign")).toEqual([
			{ code: "orphan_source", sessionId: CURRENT_SESSION_ID, sourceEntryId: "graph-foreign", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-gap")).toEqual([
			{ code: "malformed_source", sessionId: CURRENT_SESSION_ID, sourceEntryId: "graph-gap", eventType: "task.graph", schemaVersion: 1 },
		]);
		expect(graphWarnings("graph-attached-dup")).toEqual([
			{ code: "duplicate_source", sessionId: CURRENT_SESSION_ID, sourceEntryId: "graph-attached-dup", eventType: "task.graph", schemaVersion: 1 },
		]);
		const encoded = JSON.stringify(result);
		expect(encoded).not.toContain("raw graph secret");
		expect(encoded).not.toContain("other-session");
		expect(encoded).not.toContain("run-foreign");
		expect(encoded).not.toContain("req-graph-create-2");
		expect(encoded).not.toContain("req-graph-foreign");
		expect(encoded).not.toContain("req-graph-dup");
		expect(encoded).not.toContain("clientRequestId");
		// Graph warnings never change the Run's replay completeness, and graph
		// events never change the Run terminal status.
		const replay = query.replay(RUN_ID);
		expect(replay.status).toBe("complete");
		expect(replay.events.map((event: AuditEvent) => event.sourceEntryId)).toEqual([
			"accepted",
			"started",
			"terminal",
			"graph-attached",
			"graph-settled",
		]);
	});
});
