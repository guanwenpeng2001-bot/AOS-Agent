import { describe, expect, it } from "vitest";
import { createExecutionCorrelation } from "../../../src/harness/foundation/identity.ts";
import {
	InMemorySessionStorage,
	LEDGER_OBJECT_TYPES,
	Session,
	SessionLedgerWriter,
} from "../../../src/harness/session/index.ts";

const LEGACY_OBJECT_TYPES: Readonly<Record<keyof typeof LEDGER_OBJECT_TYPES, string>> = {
	contextSnapshot: "t5.context_snapshot",
	instructionSource: "t5.instruction_source",
	instructionLock: "t5.instruction_lock",
	instructionResolution: "t5.instruction_resolution",
	memory: "t5.memory",
	compaction: "t5.compaction",
	promptCache: "t5.prompt_cache",
	checkpoint: "t5.checkpoint",
	rewindPlan: "t5.rewind_plan",
	rewindExecution: "t5.rewind_execution",
	artifactManifest: "t5.artifact_manifest",
	artifactReference: "t5.artifact_reference",
	toolResult: "t5.tool_result",
	contextBuild: "t5.context_build",
	taskContextPackage: "t5.task_context_package",
};

describe("Session ledger object tags", () => {
	it("decodes legacy object tags without rewriting stored records", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "legacy-ledger-tags", createdAt: 1 }));
		const writer = new SessionLedgerWriter(session, { ownerId: "legacy-ledger-reader" });
		const correlation = createExecutionCorrelation("legacy-ledger-tags", "main");

		for (const [key, legacyObjectType] of Object.entries(LEGACY_OBJECT_TYPES) as [keyof typeof LEDGER_OBJECT_TYPES, string][]) {
			await writer.appendFoundationRecord({
				schemaVersion: 1,
				kind: "fact",
				id: `legacy-ledger-fact-${key}`,
				lane: "main",
				objectType: legacyObjectType,
				objectId: key,
				clientRequestId: `legacy-ledger-fact:${key}`,
				correlation,
				payload: { source: "legacy", key },
			});
		}

		for (const key of Object.keys(LEDGER_OBJECT_TYPES) as (keyof typeof LEDGER_OBJECT_TYPES)[]) {
			const objectType = LEDGER_OBJECT_TYPES[key];
			const point = await writer.readFact(objectType, key);
			expect(point).toMatchObject({ record: { objectType, objectId: key }, payload: { source: "legacy", key } });
			expect(await writer.listFacts({ objectType })).toMatchObject([{ objectType, objectId: key, payload: { source: "legacy", key } }]);
		}

		const storedObjectTypes = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" }))
			.filter((record) => record.kind === "fact")
			.map((record) => record.objectType);
		expect(storedObjectTypes).toEqual(Object.values(LEGACY_OBJECT_TYPES));
	});

	it("writes only domain object tags", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "domain-ledger-tags", createdAt: 1 }));
		const writer = new SessionLedgerWriter(session, { ownerId: "domain-ledger-writer" });

		for (const [key, objectType] of Object.entries(LEDGER_OBJECT_TYPES)) {
			await writer.writeFact({
				objectType,
				objectId: key,
				clientRequestId: `domain-ledger-fact:${key}`,
				payload: { source: "domain", key },
			});
		}

		const storedObjectTypes = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" }))
			.filter((record) => record.kind === "fact")
			.map((record) => record.objectType);
		expect(storedObjectTypes).toEqual(Object.values(LEDGER_OBJECT_TYPES));
		expect(storedObjectTypes.every((objectType) => !objectType.startsWith("t5."))).toBe(true);
	});

	it("prefers a current-tag fact over its legacy predecessor", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "mixed-ledger-tags", createdAt: 1 }));
		const writer = new SessionLedgerWriter(session, { ownerId: "mixed-ledger-writer" });
		await writer.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "legacy-context-snapshot",
			lane: "main",
			objectType: LEGACY_OBJECT_TYPES.contextSnapshot,
			objectId: "snapshot",
			clientRequestId: "legacy-context-snapshot",
			correlation: createExecutionCorrelation("mixed-ledger-tags", "main"),
			payload: { source: "legacy" },
		});
		await writer.writeFact({
			objectType: LEDGER_OBJECT_TYPES.contextSnapshot,
			objectId: "snapshot",
			clientRequestId: "domain-context-snapshot",
			payload: { source: "domain" },
		});

		expect(await writer.readFact(LEDGER_OBJECT_TYPES.contextSnapshot, "snapshot")).toMatchObject({
			record: { objectType: LEDGER_OBJECT_TYPES.contextSnapshot },
			payload: { source: "domain" },
		});
		expect(await writer.listFacts({ objectType: LEDGER_OBJECT_TYPES.contextSnapshot })).toMatchObject([
			{ objectType: LEDGER_OBJECT_TYPES.contextSnapshot, payload: { source: "domain" } },
		]);
		expect(await session.findFoundationRecords({ kind: "fact", objectId: "snapshot" })).toHaveLength(2);
	});
});
