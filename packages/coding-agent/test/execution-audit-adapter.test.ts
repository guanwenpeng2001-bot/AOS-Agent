import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	ExecutionAuditError,
	decodeAuditCursor,
	type AuditEvent,
	type AuditSession,
} from "../src/core/session/execution-audit.ts";
import type { SessionEntry } from "../src/core/session/manager.ts";

const SESSION_ID = "session-audit-1";
const RUN_ID = "run-audit-1";
const MODEL_BINDING_ID = "model-binding-1";
const POLICY_BINDING_ID = "policy-binding-1";
const CAPABILITY_BINDING_ID = `binding:${"A".repeat(43)}`;
const CAPABILITY_DESCRIPTOR_ID = `builtin_tool:source:${"B".repeat(43)}:read`;
const CAPABILITY_REVISION = `rev:${"C".repeat(43)}`;
const SECRET = "audit-test-secret";

const times = {
	accepted: "2026-01-01T00:00:00.000Z",
	started: "2026-01-01T00:00:01.000Z",
	modelBinding: "2026-01-01T00:00:02.000Z",
	modelAttempt: "2026-01-01T00:00:03.000Z",
	context: "2026-01-01T00:00:04.000Z",
	capability: "2026-01-01T00:00:05.000Z",
	policyBinding: "2026-01-01T00:00:06.000Z",
	policyDecision: "2026-01-01T00:00:07.000Z",
	policyApproval: "2026-01-01T00:00:08.000Z",
	sandbox: "2026-01-01T00:00:09.000Z",
	violation: "2026-01-01T00:00:10.000Z",
	ended: "2026-01-01T00:00:12.000Z",
} as const;

function customEntry(id: string, timestamp: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp,
		customType,
		data,
	} as SessionEntry;
}

function session(entries: ReadonlyArray<SessionEntry>): AuditSession {
	return {
		getSessionId: () => SESSION_ID,
		getEntries: () => entries,
	};
}

function sourceEntries(includeTerminal = true): SessionEntry[] {
	const entries: SessionEntry[] = [
		customEntry("run-accepted", times.accepted, "automation.run", {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: RUN_ID,
				sessionId: SESSION_ID,
				attempt: 1,
				status: "accepted",
				model: { provider: "test-provider", id: "test-model", thinkingLevel: "high" },
				modelBindingId: MODEL_BINDING_ID,
				capabilityBindingId: CAPABILITY_BINDING_ID,
				policyBindingId: POLICY_BINDING_ID,
			},
		}),
		customEntry("model-binding", times.modelBinding, "model.binding", {
			schemaVersion: 1,
			binding: {
				bindingId: MODEL_BINDING_ID,
				mode: "route",
				candidates: [{ order: 0, model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "high" } }],
				fallback: { maxAttempts: 2, on: ["provider_unavailable"] },
				budget: { maxModelCalls: 4, maxCostUsd: 1.25 },
				configRevision: "config-1",
				createdAt: times.modelBinding,
			},
		}),
		customEntry("model-attempt", times.modelAttempt, "model.attempt", {
			schemaVersion: 1,
			attempt: {
				attemptId: "attempt-1",
				bindingId: MODEL_BINDING_ID,
				candidate: { provider: "test-provider", modelId: "test-model", thinkingLevel: "high" },
				order: 0,
				status: "completed",
				startedAt: times.modelAttempt,
				endedAt: times.modelAttempt,
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				visibleOutput: true,
				contextSnapshotId: "snapshot-1",
				summary: "safe provider result",
			},
		}),
		customEntry("context", times.context, "context.snapshot", {
			schemaVersion: 1,
			id: "snapshot-1",
			purpose: "agent_turn",
			sessionId: SESSION_ID,
			runId: RUN_ID,
			createdAt: times.context,
			sources: [
				{
					sourceId: "subagent:next-turn:run-audit-1",
					kind: "session_message",
					scope: "turn",
					trust: "untrusted_child_output",
					contentDigest: "child-safe-digest-1",
					estimatedTokens: 20,
					disposition: "included",
					reason: "within_budget",
					body: "raw-child-body-must-not-escape",
					correlation: "raw-child-correlation-must-not-escape",
				},
			],
			budget: { contextWindow: 1000, reserveTokens: 100, inputLimit: 900, estimatedInputTokens: 20 },
		}),
		customEntry("capability", times.capability, "capability.binding", {
			schemaVersion: 1,
			binding: {
				id: CAPABILITY_BINDING_ID,
				profile: "default",
				createdAt: times.capability,
				descriptors: [{ id: CAPABILITY_DESCRIPTOR_ID, revision: CAPABILITY_REVISION, exposedToolName: "read" }],
				decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
				toolAllowlist: ["read"],
			},
		}),
		customEntry("policy-binding", times.policyBinding, "policy.binding", {
			schemaVersion: 1,
			sequence: 1,
			record: {
				schemaVersion: 1,
				id: POLICY_BINDING_ID,
				profileId: "default",
				profileRevision: "revision-1",
				projectTrust: "trusted",
				capabilityBindingId: CAPABILITY_BINDING_ID,
				enforcement: "host",
				sandboxCapabilities: { filesystem: true, process: false, network: false, credentialIsolation: true },
				sandboxStatus: "not_required",
				runId: RUN_ID,
				createdAt: times.policyBinding,
				workspaceIdentity: "internal-workspace",
				constraints: {
					workspace: { read: ["workspace"], write: [], deny: [] },
					process: { action: "deny", inheritEnvironment: false, allowedEnvironmentCount: 0 },
					network: { action: "deny", allowedDestinationCount: 0 },
					credentials: { action: "deny", allowedNameCount: 0 },
				},
				bindingHash: "hash-1",
			},
		}),
		customEntry("policy-decision", times.policyDecision, "policy.decision", {
			schemaVersion: 1,
			sequence: 2,
			record: {
				bindingId: POLICY_BINDING_ID,
				profileId: "default",
				profileRevision: "revision-1",
				projectTrust: "trusted",
				enforcement: "host",
				resource: "filesystem.read",
				action: "allow",
				outcome: "allow",
				timestamp: times.policyDecision,
			},
		}),
		customEntry("policy-approval", times.policyApproval, "policy.approval", {
			schemaVersion: 1,
			sequence: 3,
			record: {
				id: "approval-1",
				requestId: "request-1",
				bindingId: POLICY_BINDING_ID,
				resource: "filesystem.read",
				reasonCode: "policy_approval_required",
				createdAt: times.policyApproval,
				scope: { resource: "filesystem.read", workspaceScopes: ["workspace"], environmentCount: 0 },
			},
		}),
		customEntry("sandbox", times.sandbox, "sandbox.lifecycle", {
			schemaVersion: 1,
			sequence: 4,
			record: {
				bindingId: POLICY_BINDING_ID,
				status: "not_required",
				timestamp: times.sandbox,
				capabilities: { filesystem: false, process: false, network: false, credentialIsolation: false },
			},
		}),
		customEntry("violation", times.violation, "policy.violation", {
			schemaVersion: 1,
			sequence: 5,
			record: {
				bindingId: POLICY_BINDING_ID,
				timestamp: times.violation,
				reasonCode: "policy_violation",
				resource: "filesystem.read",
				requestId: "request-1",
			},
		}),
		customEntry("unknown", times.ended, "unknown.source", {
			prompt: "must not escape",
			payload: { token: "must-not-escape" },
		}),
		customEntry("malformed", times.ended, "model.attempt", {
			schemaVersion: 1,
			attempt: { bindingId: MODEL_BINDING_ID, summary: "C:\\private\\provider-error" },
		}),
	];
	if (includeTerminal) {
		entries.splice(
			1,
			0,
			customEntry("run-started", times.started, "automation.run", {
				schemaVersion: 1,
				kind: "started",
				runId: RUN_ID,
				startedAt: times.started,
			}),
			customEntry("run-terminal", times.ended, "automation.run", {
				schemaVersion: 1,
				kind: "terminal",
				endedAt: times.ended,
				receipt: {
					runId: RUN_ID,
					sessionId: SESSION_ID,
					status: "completed",
					usage: { input: 10, output: 5, total: 15 },
					contextSnapshotId: "snapshot-1",
					capabilityBindingId: CAPABILITY_BINDING_ID,
					modelBindingId: MODEL_BINDING_ID,
					policyBindingId: POLICY_BINDING_ID,
				},
			}),
		);
	}
	return entries;
}

function eventKeys(events: ReadonlyArray<AuditEvent>): string[] {
	return events.map((event) => `${event.recordedAt}|${event.sessionId}|${event.sourceEntryId}|${event.eventId}`);
}

describe("single-session execution audit adapter", () => {
	it("folds every landed source through explicit allowlists and stable ordering", () => {
		const adapter = new ExecutionAuditAdapter(session(sourceEntries()));
		const result = adapter.query({ scope: "current-session", limit: 200 });

		expect(result.events).toHaveLength(12);
		expect(eventKeys(result.events)).toEqual([...eventKeys(result.events)].sort());
		expect(result.events.map((event) => event.type)).toEqual([
			"run.accepted",
			"run.started",
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"run.completed",
		]);
		expect(result.events.find((event) => event.type === "capability.binding")?.summary).toMatchObject({ id: CAPABILITY_BINDING_ID });
		expect(result.events.find((event) => event.type === "model.attempt")?.runId).toBe(RUN_ID);
		expect(result.events.find((event) => event.type === "context.snapshot")?.summary).toMatchObject({
			sources: [
				{
					trust: "untrusted_child_output",
					disposition: "included",
					reason: "within_budget",
				},
			],
		});
		expect(result.events.find((event) => event.type === "policy.decision")?.summary).toMatchObject({
			bindingId: POLICY_BINDING_ID,
			sandboxStatus: "not_required",
		});
		const encoded = JSON.stringify(result.events);
		expect(encoded).not.toContain("must-not-escape");
		expect(encoded).not.toContain("private");
		expect(encoded).not.toContain("raw-child-body-must-not-escape");
		expect(encoded).not.toContain("raw-child-correlation-must-not-escape");
		expect(result.warnings.map((item) => item.code)).toEqual(["malformed_source", "unknown_source"]);
	});

	it("returns interrupted replay without fabricating a terminal", () => {
		const adapter = new ExecutionAuditAdapter(session(sourceEntries(false)));
		const result = adapter.replay(RUN_ID);

		expect(result.status).toBe("incomplete");
		expect(result.events.some((event) => event.type === "run.interrupted")).toBe(true);
		expect(result.events.some((event) => event.type === "run.completed")).toBe(false);
		// The malformed source is relevant to this run and makes the safe replay incomplete.
		expect(result.warnings.some((item) => item.code === "malformed_source")).toBe(true);
	});

	it("binds cursors to the complete query and rejects tampering or reuse", () => {
		const adapter = new ExecutionAuditAdapter(session(sourceEntries()), { cursorSecret: SECRET });
		const first = adapter.query({ scope: "current-session", limit: 3 });
		expect(first.nextCursor).toBeDefined();
		const cursor = decodeAuditCursor(first.nextCursor ?? "", SECRET);
		expect(cursor?.last.eventId).toBe(first.events[2]?.eventId);
		const second = adapter.query({ scope: "current-session", limit: 3, cursor: first.nextCursor });
		expect(second.events[0]?.eventId).not.toBe(first.events[0]?.eventId);
		expect(() => adapter.query({ scope: "current-session", limit: 4, cursor: first.nextCursor })).toThrowError(
			new ExecutionAuditError("audit_cursor_invalid"),
		);
		const tampered = `${first.nextCursor?.slice(0, -1)}x`;
		expect(() => adapter.query({ scope: "current-session", limit: 3, cursor: tampered })).toThrowError(
			new ExecutionAuditError("audit_cursor_invalid"),
		);
	});

	it("rejects directory scope and missing runs without reading or writing another session", () => {
		const entries = sourceEntries();
		let reads = 0;
		const adapter = new ExecutionAuditAdapter({
			getSessionId: () => SESSION_ID,
			getEntries: () => {
				reads += 1;
				return entries;
			},
		});

		expect(() => adapter.query({ scope: "session-directory" })).toThrowError(new ExecutionAuditError("audit_scope_unavailable"));
		expect(() => adapter.replay("missing-run")).toThrowError(new ExecutionAuditError("audit_run_not_found"));
		expect(reads).toBe(1);
	});

	it("derives an interrupted event for an accepted-only run", () => {
		const acceptedOnly = sourceEntries(false).filter((entry) => entry.type === "custom" && entry.customType === "automation.run" && entry.id === "run-accepted");
		const adapter = new ExecutionAuditAdapter(session(acceptedOnly));
		const result = adapter.replay(RUN_ID);

		expect(result.status).toBe("interrupted");
		expect(result.events.map((event) => event.type)).toEqual(["run.accepted", "run.interrupted"]);
		expect(result.run.status).toBe("accepted");
	});

});
