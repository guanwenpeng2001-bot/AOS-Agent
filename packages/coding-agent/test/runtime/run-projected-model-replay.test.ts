import { describe, expect, it, vi } from "vitest";
import {
	createRunLifecycleCoordinator,
	RUN_LEDGER_CUSTOM_TYPE,
	serializePublicRunRecord,
	serializePublicSessionEntry,
	type RunLedgerSession,
	type RunRecord,
} from "../../src/core/session/run-lifecycle.ts";
import type { SessionEntry } from "../../src/core/session/manager.ts";

vi.mock("@aos-agent/ai/compat", () => ({}));
vi.mock("@aos-agent/ai/providers/all", () => ({}));

const digest = { algorithm: "sha256" as const, value: "a".repeat(64) };

function record(projectedModel: unknown): RunRecord {
	return {
		id: "run-projected-model",
		sessionId: "session-projected-model",
		attempt: 1,
		status: "accepted",
		model: { provider: "external_connector", id: "fixture", thinkingLevel: "off" },
		projectedModel,
	} as unknown as RunRecord;
}

function sessionFor(runRecord: RunRecord): RunLedgerSession {
	const entry = {
		id: "entry-projected-model",
		type: "custom",
		customType: RUN_LEDGER_CUSTOM_TYPE,
		data: { schemaVersion: 1, kind: "accepted", record: runRecord },
	} as unknown as SessionEntry;
	return {
		getSessionId: () => "session-projected-model",
		getSessionFile: () => undefined,
		appendCustomEntry: () => "unused",
		getEntries: () => [entry],
	};
}

describe("Run projectedModel replay", () => {
	it("rejects added keys, malformed digests, and unbounded identities", () => {
		for (const projectedModel of [
			{ provider: "openai", model: "gpt", modelBindingDigest: digest, authorization: "canary" },
			{ provider: "openai", model: "gpt", modelBindingDigest: { ...digest, authorization: "canary" } },
			{ provider: "", model: "gpt", modelBindingDigest: digest },
			{ provider: "p".repeat(513), model: "gpt", modelBindingDigest: digest },
			{ provider: "openai", model: "https://model.invalid", modelBindingDigest: digest },
		]) {
			const coordinator = createRunLifecycleCoordinator(sessionFor(record(projectedModel)), { diagnostics: () => undefined });
			expect(coordinator.rebuildIndex().size).toBe(0);
			expect(coordinator.diagnostics()).toMatchObject([{ kind: "malformed" }]);
		}
	});

	it("reconstructs public output from the three allowlisted fields", () => {
		const internal = record({
			provider: "openai",
			model: "gpt",
			modelBindingDigest: digest,
			authorization: "canary",
		});
		const serialized = serializePublicRunRecord(internal);
		expect(serialized.projectedModel).toEqual({
			provider: "openai",
			model: "gpt",
			modelBindingDigest: digest,
		});
		expect(JSON.stringify(serialized)).not.toContain("canary");

		const publicEntry = serializePublicSessionEntry(sessionFor(internal).getEntries()[0]!);
		expect(publicEntry.type).toBe("custom");
		if (publicEntry.type === "custom") expect(publicEntry.data).toBeUndefined();
	});
});
