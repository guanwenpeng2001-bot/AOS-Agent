import { describe, expect, it } from "vitest";
import { encodeFoundationMutation, parseFoundationMutation } from "../../../src/harness/session/durable/codec.ts";
import { FoundationLedgerState } from "../../../src/harness/session/durable/state.ts";
import type { FoundationRecord } from "../../../src/harness/session/durable/types.ts";

function writerProducedRecord() {
	const state = new FoundationLedgerState({ sessionId: "session-1", clock: () => 1_700_000_000_000 });
	state.acquireWriterLease({ ownerId: "durable-codec-fixture" });
	return state.appendFoundationRecord({
		schemaVersion: 1,
		kind: "fact",
		id: "record-tool-receipt-1",
		lane: "main",
		objectType: "tool_receipt",
		objectId: "tool-receipt-1",
		clientRequestId: "tool-receipt:tool-receipt-1",
		expectedRevision: 0,
		correlation: {
			sessionId: "session-1",
			laneId: "main",
			taskId: "task-1",
			dispatchId: "dispatch-1",
			operationId: "operation-1",
			providerId: "provider-1",
			toolCallId: "tool-call-1",
			revision: 0,
		},
		payload: { schemaVersion: 1, toolReceiptId: "tool-receipt-1", outcome: "completed" },
	}).record;
}

function encodeWithCorrelation(record: FoundationRecord, correlation: Record<string, unknown>): string {
	return JSON.stringify({
		kind: "foundation",
		schemaVersion: 1,
		record: { ...record, correlation },
	});
}

describe("Foundation durable codec correlation", () => {
	it("round trips the official writer operation, provider, and tool-call identities", () => {
		const productionRecord = writerProducedRecord();
		const encoded = encodeFoundationMutation(productionRecord);

		expect(parseFoundationMutation(encoded)).toEqual({ ok: true, value: productionRecord });
		expect(productionRecord.correlation).toMatchObject({
			operationId: "operation-1",
			providerId: "provider-1",
			toolCallId: "tool-call-1",
		});
	});

	it.each(
		(["operationId", "providerId", "toolCallId"] as const).flatMap((field) =>
			([null, 1, true] as const).map((value) => ({ field, value })),
		),
	)("rejects $field with invalid value $value", ({ field, value }) => {
		const productionRecord = writerProducedRecord();
		const result = parseFoundationMutation(encodeWithCorrelation(productionRecord, { ...productionRecord.correlation, [field]: value }));

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error(`Expected invalid ${field} correlation to fail`);
		expect(result.error.kind).toBe("schema");
		expect(result.error.message).toBe(`has invalid correlation.${field}`);
	});

	it("rejects unknown correlation fields", () => {
		const productionRecord = writerProducedRecord();
		const result = parseFoundationMutation(encodeWithCorrelation(productionRecord, {
			...productionRecord.correlation,
			vendorSessionId: "vendor-session-1",
		}));

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected unknown correlation field to fail");
		expect(result.error.kind).toBe("schema");
		expect(result.error.message).toBe("has unknown correlation field vendorSessionId");
	});
});
