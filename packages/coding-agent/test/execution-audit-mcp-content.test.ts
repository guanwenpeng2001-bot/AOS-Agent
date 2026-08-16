import { describe, expect, it } from "vitest";

import {
	ExecutionAuditAdapter,
	type AuditEvent,
	type AuditSession,
} from "../src/core/execution-audit.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const SESSION_ID = "session-mcp-audit-1";
const RUN_ID = "run-mcp-audit-1";
const DIGEST_ID = "A".repeat(43);
const CONTENT_DIGEST = "a".repeat(64);
const CAPABILITY_BINDING_ID = `binding:${"B".repeat(43)}`;
const CAPABILITY_DESCRIPTOR_ID = `mcp_resource:source:${"C".repeat(43)}:${DIGEST_ID}`;
const CAPABILITY_REVISION = `rev:${"D".repeat(43)}`;
const POLICY_BINDING_ID = "policy-binding-1";

const times = {
	accepted: "2026-01-01T00:00:00.000Z",
	started: "2026-01-01T00:00:01.000Z",
	context: "2026-01-01T00:00:02.000Z",
	attachAudit: "2026-01-01T00:00:03.000Z",
	ended: "2026-01-01T00:00:04.000Z",
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

function runEntries(receiptOverrides: Record<string, unknown> = {}): SessionEntry[] {
	return [
		customEntry("run-accepted", times.accepted, "automation.run", {
			schemaVersion: 1,
			kind: "accepted",
			record: {
				id: RUN_ID,
				sessionId: SESSION_ID,
				attempt: 1,
				status: "accepted",
				model: { provider: "test-provider", id: "test-model", thinkingLevel: "high" },
				capabilityBindingId: CAPABILITY_BINDING_ID,
			},
		}),
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
				contextSnapshotId: "snapshot-mcp-1",
				capabilityBindingId: CAPABILITY_BINDING_ID,
				attachments: [
					{
						sourceId: DIGEST_ID,
						kind: "resource",
						descriptorId: CAPABILITY_DESCRIPTOR_ID,
						revision: CAPABILITY_REVISION,
						capabilityBindingId: CAPABILITY_BINDING_ID,
						policyBindingId: POLICY_BINDING_ID,
						contentDigest: CONTENT_DIGEST,
						byteCount: 125,
						blockCount: 3,
						mimeTypes: ["image/png"],
					},
				],
				...receiptOverrides,
			},
		}),
	];
}

function attachmentSnapshotEntry(): SessionEntry {
	return customEntry("context", times.context, "context.snapshot", {
		schemaVersion: 1,
		id: "snapshot-mcp-1",
		purpose: "agent_turn",
		sessionId: SESSION_ID,
		runId: RUN_ID,
		createdAt: times.context,
		sources: [
			{
				sourceId: "system:base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				contentDigest: "digest-base",
				estimatedTokens: 10,
				disposition: "included",
			},
			{
				sourceId: `attachment:${DIGEST_ID}`,
				kind: "attachment",
				scope: "session",
				trust: "user_owned",
				label: "mcp:resource:docs",
				contentDigest: "digest-attachment",
				estimatedTokens: 42,
				disposition: "included",
				capabilityId: CAPABILITY_DESCRIPTOR_ID,
				capabilityRevision: CAPABILITY_REVISION,
				capabilityBindingId: CAPABILITY_BINDING_ID,
				policyBindingId: POLICY_BINDING_ID,
				byteCount: 125,
				blockCount: 3,
				mimeTypes: ["image/png"],
			},
		],
		budget: { contextWindow: 1000, reserveTokens: 100, inputLimit: 900, estimatedInputTokens: 52 },
	});
}

describe("Execution Audit folds MCP attachment metadata allowlist-only", () => {
	it("folds a context snapshot with an attachment source without warnings or raw content", () => {
		const adapter = new ExecutionAuditAdapter(
			session([...runEntries(), attachmentSnapshotEntry()]),
		);
		const folded = adapter.fold();

		expect(folded.warnings).toEqual([]);
		const snapshotEvents = folded.events.filter((event) => event.type === "context.snapshot");
		expect(snapshotEvents).toHaveLength(1);
		const snapshotEvent = snapshotEvents[0] as Extract<AuditEvent, { type: "context.snapshot" }>;
		const attachmentSource = snapshotEvent.summary.sources.find(
			(source) => source.kind === "attachment",
		);
		expect(attachmentSource).toBeDefined();
		expect(attachmentSource?.contentDigest).toBe("digest-attachment");
		expect(attachmentSource?.disposition).toBe("included");
		// The frozen Audit source summary deliberately omits source ids, labels,
		// sizes, and bodies; the raw remote text never surfaces anywhere.
		expect(JSON.stringify(folded)).not.toContain("Attached guide text");
		expect(JSON.stringify(folded)).not.toContain("file:///guide.md");
	});

	it("carries run attachment summaries into the run summary and keeps replay complete", () => {
		const adapter = new ExecutionAuditAdapter(
			session([...runEntries(), attachmentSnapshotEntry()]),
		);
		const replayed = adapter.replay(RUN_ID);
		expect(replayed.status).toBe("complete");
		expect(replayed.warnings).toEqual([]);
		expect(replayed.run.attachments).toEqual([
			{
				sourceId: DIGEST_ID,
				kind: "resource",
				descriptorId: CAPABILITY_DESCRIPTOR_ID,
				revision: CAPABILITY_REVISION,
				capabilityBindingId: CAPABILITY_BINDING_ID,
				policyBindingId: POLICY_BINDING_ID,
				contentDigest: CONTENT_DIGEST,
				byteCount: 125,
				blockCount: 3,
				mimeTypes: ["image/png"],
			},
		]);
		// The summary never carries raw URIs, prompt names, args, or bodies.
		const serialized = JSON.stringify(replayed);
		expect(serialized).not.toContain("file:///guide.md");
		expect(serialized).not.toContain("summarize");
		expect(serialized).not.toContain("Attached guide text");
	});

	it("treats mcp.content.audit entries as inspectable Session entries, not audit sources", () => {
		const adapter = new ExecutionAuditAdapter(
			session([
				...runEntries(),
				customEntry("attach-audit", times.attachAudit, "mcp.content.audit", {
					serverId: "docs",
					operation: "context.attach",
					outcome: "success",
					descriptorId: CAPABILITY_DESCRIPTOR_ID,
					revision: CAPABILITY_REVISION,
					provenanceId: DIGEST_ID,
					capabilityBindingId: CAPABILITY_BINDING_ID,
					policyBindingId: POLICY_BINDING_ID,
					contentDigest: CONTENT_DIGEST,
					byteCount: 125,
					blockCount: 3,
					mimeTypes: ["image/png"],
					timestamp: times.attachAudit,
				}),
			]),
		);
		const folded = adapter.fold();
		// No unknown_source warning: the entry is a deliberate non-source.
		expect(folded.warnings.map((warning) => warning.code)).not.toContain("unknown_source");
		const replayed = adapter.replay(RUN_ID);
		expect(replayed.status).toBe("complete");
		expect(replayed.warnings).toEqual([]);
	});

	it("strips raw content fields on snapshot sources instead of leaking them", () => {
		const raw = attachmentSnapshotEntry();
		(raw as { data: { sources: Array<Record<string, unknown>> } }).data.sources[1].text =
			"Attached guide text";
		const adapter = new ExecutionAuditAdapter(session([...runEntries(), raw]));
		const folded = adapter.fold();
		// The allowlist copy never forwards extra raw source fields.
		expect(JSON.stringify(folded)).not.toContain("Attached guide text");
		expect(JSON.stringify(folded)).not.toContain("file:///guide.md");
		expect(folded.warnings).toEqual([]);
	});
});
