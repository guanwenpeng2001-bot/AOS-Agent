import { describe, expect, it } from "vitest";
import { decodeLegacyFoundationRecordV1 } from "../../src/index.ts";
import { encodeFoundationMutation } from "../../src/harness/session/durable/codec.ts";
import { FoundationLedgerState } from "../../src/harness/session/durable/state.ts";
import {
	LegacyFoundationSchemaMigrationError,
	decodeLegacyFoundationSchemaWrapperV1,
	planLegacyFoundationSchemaMigrationV1,
} from "../../src/harness/foundation/migrations/legacy-foundation-schema.ts";

function historicalRecord(name = "Alice") {
	return {
		schemaVersion: 1 as const,
		kind: "fact" as const,
		id: "record-1",
		seq: 1,
		lane: "main",
		timestamp: 100,
		objectType: "identity",
		objectId: "alice",
		revision: 1,
		clientRequestId: "identity-create",
		expectedRevision: 0,
		fencingToken: "fence-1",
		correlation: {
			sessionId: "session-1",
			laneId: "main",
			revision: 1,
			fencingToken: "fence-1",
		},
		payload: { name },
	};
}

function writerProducedRecord() {
	const state = new FoundationLedgerState({ sessionId: "session-1", clock: () => 100 });
	state.acquireWriterLease({ ownerId: "migration-fixture" });
	return state.appendFoundationRecord({
		schemaVersion: 1,
		kind: "fact",
		id: "writer-record-1",
		lane: "main",
		objectType: "identity",
		objectId: "writer-alice",
		clientRequestId: "writer-identity-create",
		expectedRevision: 0,
		correlation: {
			sessionId: "session-1",
			laneId: "main",
			revision: 0,
			operationId: "operation-1",
			providerId: "provider-1",
			toolCallId: "tool-call-1",
		},
		payload: { name: "Alice" },
	}).record;
}

function writerProducedRetentionRecord(reason?: string) {
	const state = new FoundationLedgerState({ sessionId: "session-1", clock: () => 100 });
	state.acquireWriterLease({ ownerId: "migration-fixture" });
	const record = state.setRetentionPolicy(
		reason === undefined ? { schemaVersion: 1, cutSequence: 0 } : { schemaVersion: 1, cutSequence: 0, reason },
		{
			clientRequestId: "retention-create",
			correlation: { sessionId: "session-1", laneId: "main", revision: 0 },
		},
	).record;
	if (record.kind !== "retention") throw new Error("Expected the retention producer to return a retention record");
	return record;
}

describe("private legacy Foundation schema migration", () => {
	it("decodes only schemaVersion 1 Foundation JSONL through the current decoder", () => {
		const record = historicalRecord();
		expect(
			decodeLegacyFoundationSchemaWrapperV1({ kind: "foundation", schemaVersion: 1, record }),
		).toEqual(record);
		expect(() =>
			decodeLegacyFoundationSchemaWrapperV1({ kind: "durable", schemaVersion: 1, record }),
		).toThrow(LegacyFoundationSchemaMigrationError);
	});

	it("keeps exact current validation and JSONL format migration separate", () => {
		const record = historicalRecord();
		expect(() =>
			decodeLegacyFoundationSchemaWrapperV1({
				kind: "foundation",
				schemaVersion: 1,
				record: { ...record, unexpected: true },
			}),
		).toThrow(LegacyFoundationSchemaMigrationError);
		expect(() =>
			decodeLegacyFoundationSchemaWrapperV1({
				kind: "header",
				version: 4,
				id: "session-1",
				createdAt: 1,
				cwd: "/workspace",
			}),
		).toThrow(LegacyFoundationSchemaMigrationError);
		expect(() =>
			decodeLegacyFoundationSchemaWrapperV1({
				kind: "header",
				version: 5,
				schemaVersion: 1,
				id: "session-1",
				createdAt: 1,
				cwd: "/workspace",
				migratedFromVersion: 4,
				migratedAt: 2,
			}),
		).toThrow(LegacyFoundationSchemaMigrationError);
	});

	it("accepts and preserves current writer correlation fields from Foundation JSONL", () => {
		const record = writerProducedRecord();
		const wrapper = JSON.parse(encodeFoundationMutation(record)) as unknown;
		expect(decodeLegacyFoundationRecordV1(record)).toEqual(record);
		expect(decodeLegacyFoundationSchemaWrapperV1(wrapper)).toEqual(record);
		expect(planLegacyFoundationSchemaMigrationV1(wrapper).result).toEqual(record);
		expect(record.correlation).toMatchObject({
			operationId: "operation-1",
			providerId: "provider-1",
			toolCallId: "tool-call-1",
		});

		for (const [key, invalid] of [
			["operationId", 1],
			["providerId", null],
			["toolCallId", false],
		] as const) {
			expect(() =>
				decodeLegacyFoundationSchemaWrapperV1({
					kind: "foundation",
					schemaVersion: 1,
					record: { ...record, correlation: { ...record.correlation, [key]: invalid } },
				}),
			).toThrow(LegacyFoundationSchemaMigrationError);
		}
		expect(() =>
			decodeLegacyFoundationSchemaWrapperV1({
				kind: "foundation",
				schemaVersion: 1,
				record: { ...record, correlation: { ...record.correlation, authority: "forged" } },
			}),
		).toThrow(LegacyFoundationSchemaMigrationError);
	});

	it("accepts producer-shaped retention records and exact-validates nested policies", () => {
		const records = [writerProducedRetentionRecord(), writerProducedRetentionRecord("archive")];
		for (const record of records) {
			const wrapper = JSON.parse(encodeFoundationMutation(record)) as unknown;
			expect(decodeLegacyFoundationSchemaWrapperV1(wrapper)).toEqual(record);
		}

		const record = records[1]!;
		for (const policy of [
			{ ...record.policy, authority: "forged" },
			{ ...record.policy, schemaVersion: 2 },
			{ ...record.policy, cutSequence: -1 },
			{ ...record.policy, cutSequence: 1.5 },
			{ ...record.policy, reason: "" },
			{ ...record.policy, reason: 1 },
			{ schemaVersion: 1 },
		]) {
			expect(() =>
				decodeLegacyFoundationSchemaWrapperV1({
					kind: "foundation",
					schemaVersion: 1,
					record: { ...record, policy },
				}),
			).toThrow(LegacyFoundationSchemaMigrationError);
		}
	});

	it("builds clock-free stable plans while detecting changed source content", () => {
		const first = planLegacyFoundationSchemaMigrationV1({
			kind: "foundation",
			schemaVersion: 1,
			record: historicalRecord(),
		});
		const replay = planLegacyFoundationSchemaMigrationV1({
			record: historicalRecord(),
			schemaVersion: 1,
			kind: "foundation",
		});
		const changed = planLegacyFoundationSchemaMigrationV1({
			kind: "foundation",
			schemaVersion: 1,
			record: historicalRecord("Alicia"),
		});

		expect(replay).toEqual(first);
		expect(first.migrationId).toBe(changed.migrationId);
		expect(first.sourceFingerprint).not.toEqual(changed.sourceFingerprint);
		expect(first.resultFingerprint).not.toEqual(changed.resultFingerprint);
		expect(JSON.stringify(first)).not.toContain("migratedAt");
	});
});
