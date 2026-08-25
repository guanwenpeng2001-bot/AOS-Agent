import { fauxAssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";

import {
	ExternalSessionMappingStore,
	type ExternalMappingRequest,
} from "../../../src/core/external-session-mapping.ts";
import { ExecutionAuditError } from "../../../src/core/execution-audit.ts";
import { ExecutionAuditQuery } from "../../../src/core/execution-audit-query.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { AUDIT_FORBIDDEN_KEYS } from "../../fixtures/execution-audit-contract.ts";
import { createHarness, type Harness } from "../harness.ts";

const RUN_ID = "audit-replay-regression-run";
const CURSOR_SECRET = "audit-replay-regression-secret";
const PROMPT_SECRET = "audit-replay-prompt-secret";

function collectObjectKeys(value: unknown, path: string[] = [], keys: Array<{ key: string; path: string[] }> = []): Array<{ key: string; path: string[] }> {
	if (Array.isArray(value)) {
		for (const item of value) collectObjectKeys(item, path, keys);
		return keys;
	}
	if (value === null || typeof value !== "object") return keys;
	for (const [key, child] of Object.entries(value)) {
		keys.push({ key, path });
		collectObjectKeys(child, [...path, key], keys);
	}
	return keys;
}

function expectSafePublicValue(value: unknown): void {
	const forbidden = new Set<string>(AUDIT_FORBIDDEN_KEYS);
	const compatibilityUsageKeys = new Set(["input", "output", "total", "cost"]);
	for (const { key, path } of collectObjectKeys(value)) {
		const isCompatibilityUsageKey = path.at(-1) === "usage" && compatibilityUsageKeys.has(key);
		expect(forbidden.has(key) && !isCompatibilityUsageKey, `forbidden audit key: ${key}`).toBe(false);
	}
}

function appendTerminalRun(session: SessionManager): void {
	const sessionId = session.getSessionId();
	const endedAt = new Date().toISOString();
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: RUN_ID,
			sessionId,
			attempt: 1,
			status: "accepted",
			model: { provider: "faux", id: "faux-1", thinkingLevel: "low" },
		},
	});
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "started",
		runId: RUN_ID,
		startedAt: endedAt,
	});
	session.appendCustomEntry("automation.run", {
		schemaVersion: 1,
		kind: "terminal",
		endedAt,
		receipt: {
			runId: RUN_ID,
			sessionId,
			status: "completed",
			usage: { input: 1, output: 1, total: 2 },
		},
	});
}

describe("execution audit/replay PR acceptance regression", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("folds a real faux-provider turn into safe audit output without read side effects", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt(PROMPT_SECRET, { runId: "audit-replay-live-run" });

		const entriesBeforeQuery = harness.sessionManager.getEntries().length;
		const providerCallsBeforeQuery = harness.faux.state.callCount;
		const result = new ExecutionAuditQuery(harness.sessionManager, { cursorSecret: CURSOR_SECRET }).query({
			scope: "current-session",
			limit: 200,
		});
		const eventTypes = new Set(result.events.map((event) => event.type));

		expect(eventTypes.has("model.binding")).toBe(true);
		expect(eventTypes.has("model.attempt")).toBe(true);
		expect(eventTypes.has("context.snapshot")).toBe(true);
		expect(JSON.stringify(result)).not.toContain(PROMPT_SECRET);
		expect(JSON.stringify(result)).not.toContain("faux-key");
		expectSafePublicValue(result);
		expect(harness.sessionManager.getEntries()).toHaveLength(entriesBeforeQuery);
		expect(harness.faux.state.callCount).toBe(providerCallsBeforeQuery);
	});

	it("replays a terminal run with opaque cursor pagination and unknown-source warnings only", () => {
		const session = SessionManager.inMemory("/workspace/audit-replay-regression");
		appendTerminalRun(session);
		session.appendCustomEntry("unknown.custom", {
			prompt: PROMPT_SECRET,
			command: "secret-command",
		});
		const query = new ExecutionAuditQuery(session, { cursorSecret: CURSOR_SECRET });
		const entriesBeforeQuery = session.getEntries().length;

		const firstPage = query.query({ scope: "current-session", limit: 1 });
		expect(firstPage.events).toHaveLength(1);
		expect(firstPage.nextCursor).toBeDefined();
		const secondPage = query.query({
			scope: "current-session",
			limit: 1,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage.events).toHaveLength(1);
		expect(() =>
			query.query({ scope: "current-session", limit: 2, cursor: firstPage.nextCursor }),
		).toThrowError(new ExecutionAuditError("audit_cursor_invalid"));

		const replay = query.replay(RUN_ID);
		expect(replay.status).toBe("incomplete");
		expect(new Set(replay.events.map((event) => event.type))).toEqual(
			new Set(["run.accepted", "run.started", "run.completed"]),
		);
		expect(replay.warnings).toEqual([expect.objectContaining({ code: "unknown_source" })]);
		expect(JSON.stringify(replay)).not.toContain(PROMPT_SECRET);
		expect(JSON.stringify(replay)).not.toContain("secret-command");
		expectSafePublicValue(replay);
		expect(session.getEntries()).toHaveLength(entriesBeforeQuery);
	});

	it("persists external mappings idempotently, rejects conflicts, and recovers them after restart", () => {
		const session = SessionManager.inMemory("/workspace/audit-replay-mapping");
		const request: ExternalMappingRequest = {
			external: {
				namespace: "provider",
				externalSessionId: "external-session",
				externalRunId: "external-run",
			},
			aosSessionId: session.getSessionId(),
			aosRunId: RUN_ID,
		};
		const store = new ExternalSessionMappingStore(session, { now: () => "2026-08-13T00:00:00.000Z" });

		const first = store.persistMapping(request);
		const second = store.persistMapping(request);
		expect(first.appended).toBe(true);
		expect(second).toMatchObject({ appended: false, idempotent: true, mapping: first.mapping });
		expect(() =>
			store.persistMapping({
				...request,
				aosRunId: "different-aos-run",
			}),
		).toThrowError(expect.objectContaining({ code: "external_mapping_conflict" }));

		const restarted = new ExternalSessionMappingStore(session, { now: () => "2026-08-13T00:00:00.000Z" });
		expect(restarted.getByExternal(request.external)).toEqual(first.mapping);
		expect(restarted.getByAos("provider", session.getSessionId(), RUN_ID)).toEqual(first.mapping);
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("external-session");
	});
});
