import { describe, expect, it } from "vitest";
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
