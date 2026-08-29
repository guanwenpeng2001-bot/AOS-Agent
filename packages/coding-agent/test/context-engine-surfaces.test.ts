import { describe, expect, it } from "vitest";
import {
	CONTEXT_SNAPSHOT_CUSTOM_TYPE,
	assertSnapshotMetadataOnly,
	compareContextSources,
	freezeContext,
	resolveContext,
} from "../src/core/session/context-engine.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import type { GetContextData } from "../src/modes/rpc/rpc-types.ts";

function buildSnapshot(sessionId: string, id: string) {
	const result = resolveContext({
		purpose: "agent_turn",
		sessionId,
		contextWindow: 100_000,
		reserveTokens: 1_000,
		sources: [
			{
				sourceId: "sys",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "secret system body",
				required: true,
			},
			{
				sourceId: "instr",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				path: "/proj/AGENTS.md",
				content: "SECRET PROJECT RULES MUST NOT LEAK",
				required: true,
			},
		],
		sessionMessages: [],
		turnMessages: [],
	});
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(result.error.message);
	}
	return freezeContext(result.plan, { id, createdAt: new Date().toISOString() });
}

describe("context-engine surfaces", () => {
	it("get_context payload shape is metadata-only and supports drift without bodies", () => {
		const session = SessionManager.inMemory();
		const snapshot = buildSnapshot(session.getSessionId(), "snap-surface-1");
		assertSnapshotMetadataOnly(snapshot);
		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);

		const loaded = session.getContextSnapshot("snap-surface-1");
		expect(loaded).toBeDefined();

		const drift = compareContextSources(loaded!, [
			{
				sourceId: "sys",
				content: "secret system body",
			},
			{
				sourceId: "instr",
				content: "CHANGED PROJECT RULES",
				path: "/proj/AGENTS.md",
			},
		]);
		expect(drift.find((d) => d.sourceId === "instr")?.status).toBe("source_changed");

		const data: GetContextData = {
			snapshot: loaded!,
			drift,
			preview: false,
		};
		const json = JSON.stringify(data);
		expect(json).not.toContain("SECRET PROJECT RULES");
		expect(json).not.toContain("secret system body");
		expect(json).not.toContain("CHANGED PROJECT RULES");
		expect(json).toContain("source_changed");
		expect(json).toContain("contentDigest");
	});
});
