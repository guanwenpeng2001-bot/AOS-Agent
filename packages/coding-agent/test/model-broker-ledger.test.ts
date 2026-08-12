import { describe, expect, it } from "vitest";
import {
	appendModelAttemptEntry,
	appendModelBindingEntry,
	foldModelAttemptEntries,
	foldModelBindingEntries,
	MODEL_ATTEMPT_CUSTOM_TYPE,
	MODEL_BINDING_CUSTOM_TYPE,
	MODEL_BROKER_LEDGER_SCHEMA_VERSION,
	parseModelAttemptLedgerRecord,
	parseModelBindingLedgerRecord,
	replayModelBrokerLedger,
	serializePublicModelAttempt,
	serializePublicModelBinding,
	serializePublicModelBrokerEntry,
	type ModelAttemptLedgerRecord,
	type ModelBindingLedgerRecord,
	type ModelBrokerLedgerEntry,
	type ModelBrokerLedgerSession,
} from "../src/core/model-broker-ledger.ts";

class MemoryLedgerSession implements ModelBrokerLedgerSession {
	private readonly entries: ModelBrokerLedgerEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<ModelBrokerLedgerEntry> {
		return this.entries;
	}
}

const BINDING: ModelBindingLedgerRecord = {
	bindingId: "model-binding:route:production",
	mode: "route",
	routeId: "route:production",
	role: "assistant",
	candidates: [
		{ order: 0, model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" } },
		{ order: 1, model: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" } },
	],
	fallback: { maxAttempts: 2, on: ["provider_unavailable", "transient_provider_error"] },
	budget: { maxModelCalls: 12, maxInputTokens: 20_000, maxOutputTokens: 4_000, maxTotalTokens: 24_000 },
	configRevision: "config:2026-08-12",
	createdAt: "2026-08-12T00:00:00.000Z",
};

const ATTEMPT: ModelAttemptLedgerRecord = {
	attemptId: "attempt-1",
	bindingId: BINDING.bindingId,
	candidate: BINDING.candidates[0].model ?? { provider: "openai", modelId: "gpt-5" },
	order: 0,
	startedAt: "2026-08-12T00:00:01.000Z",
	status: "failed",
	endedAt: "2026-08-12T00:00:02.000Z",
	usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
	visibleOutput: false,
	contextSnapshotId: "snapshot:attempt-1",
	failureCategory: "transient_provider_error",
	summary: "temporary provider failure",
};

describe("model broker ledger", () => {
	it("appends schema-v1 binding and attempt snapshots without unknown fields", () => {
		const session = new MemoryLedgerSession();
		const unsafeBinding = {
			...BINDING,
			credentials: { apiKey: "binding-secret" },
			headers: { authorization: "Bearer binding-secret" },
		};
		const unsafeAttempt = {
			...ATTEMPT,
			error: new Error("token=attempt-secret"),
			response: "private model response",
		};

		expect(appendModelBindingEntry(session, unsafeBinding)).toBe("entry-1");
		expect(appendModelAttemptEntry(session, unsafeAttempt)).toBe("entry-2");
		expect(session.getEntries()).toHaveLength(2);
		expect(session.getEntries()[0].customType).toBe(MODEL_BINDING_CUSTOM_TYPE);
		expect(session.getEntries()[1].customType).toBe(MODEL_ATTEMPT_CUSTOM_TYPE);
		expect(JSON.stringify(session.getEntries())).not.toContain("binding-secret");
		expect(JSON.stringify(session.getEntries())).not.toContain("attempt-secret");
		expect(JSON.stringify(session.getEntries())).not.toContain("private model response");
		expect((session.getEntries()[0].data as { schemaVersion: number }).schemaVersion).toBe(
		MODEL_BROKER_LEDGER_SCHEMA_VERSION,
	);
	});

	it("folds bindings and attempts independently, with later settlements winning", () => {
		const session = new MemoryLedgerSession();
		appendModelBindingEntry(session, BINDING);
		appendModelAttemptEntry(session, { ...ATTEMPT, status: "started", endedAt: undefined, usage: undefined });
		appendModelAttemptEntry(session, { ...ATTEMPT, status: "completed", failureCategory: undefined, summary: undefined });

		const bindings = foldModelBindingEntries(session.getEntries());
		const attempts = foldModelAttemptEntries(session.getEntries());
		expect(bindings.get(BINDING.bindingId)).toEqual(BINDING);
		expect(attempts.get(ATTEMPT.attemptId)).toMatchObject({ status: "completed", bindingId: BINDING.bindingId });

		const replayed = replayModelBrokerLedger(session);
		expect(replayed.bindings.get(BINDING.bindingId)).toEqual(BINDING);
		expect(replayed.attempts.get(ATTEMPT.attemptId)?.status).toBe("completed");
		expect(replayed.diagnostics).toEqual([]);
	});

	it("skips malformed, orphan and unknown-version entries with stable diagnostics", () => {
		const entries: ModelBrokerLedgerEntry[] = [
			{
				id: "bad-binding",
				type: "custom",
				customType: MODEL_BINDING_CUSTOM_TYPE,
				data: { schemaVersion: 1, binding: { bindingId: "broken" } },
			},
			{
				id: "future-attempt",
				type: "custom",
				customType: MODEL_ATTEMPT_CUSTOM_TYPE,
				data: { schemaVersion: 99, attempt: ATTEMPT },
			},
			{
				id: "orphan-attempt",
				type: "custom",
				customType: MODEL_ATTEMPT_CUSTOM_TYPE,
				data: { schemaVersion: 1, attempt: ATTEMPT },
			},
		];
		const state = replayModelBrokerLedger(entries);
		expect(state.bindings.size).toBe(0);
		expect(state.attempts.size).toBe(0);
		expect(state.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
			"malformed",
			"unknown-schema-version",
			"orphan-attempt",
		]);
	});

	it("serializes only allowlisted metadata and handles persisted wrappers", () => {
		const publicBinding = serializePublicModelBinding(BINDING);
		const publicAttempt = serializePublicModelAttempt(ATTEMPT);
		expect(publicBinding).toEqual(BINDING);
		expect(publicAttempt).toEqual(ATTEMPT);

		const publicEntry = serializePublicModelBrokerEntry({
			id: "binding-entry",
			type: "custom",
			customType: MODEL_BINDING_CUSTOM_TYPE,
			data: { schemaVersion: 1, binding: BINDING },
		});
		expect(publicEntry?.customType).toBe(MODEL_BINDING_CUSTOM_TYPE);
		expect(publicEntry?.data).toEqual({ schemaVersion: 1, binding: BINDING });

		const unsafe = serializePublicModelAttempt({
			...ATTEMPT,
			summary: "https://user:secret@example.invalid token=secret",
		});
		expect(unsafe).toMatchObject({ attemptId: ATTEMPT.attemptId, bindingId: ATTEMPT.bindingId });
		expect(unsafe?.summary).toBeUndefined();
		const legacyBinding = { ...BINDING, bindingId: "binding?token=secret" };
		expect(serializePublicModelBinding(legacyBinding)).toBeUndefined();
	});

	it("rejects unsafe identifiers and Error-shaped records while preserving successor metadata", () => {
		expect(parseModelBindingLedgerRecord({ ...BINDING, previousModelBindingId: "binding:source:old" })).toEqual({
		...BINDING,
		previousModelBindingId: "binding:source:old",
	});
		expect(parseModelBindingLedgerRecord({ ...BINDING, routeId: "token=secret" })).toBeUndefined();
		expect(parseModelAttemptLedgerRecord({ ...ATTEMPT, summary: new Error("secret") })).toBeUndefined();
		expect(parseModelAttemptLedgerRecord({ ...ATTEMPT, failureCategory: "token=secret" })).toBeUndefined();
	});
});
