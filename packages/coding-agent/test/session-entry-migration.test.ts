import { InMemorySessionStorage, Session, SessionLedger } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	PrivateMigrationError,
	createPrivateMigrationPlanV1,
	decodeLegacyUnavailableProviderDescriptorV1,
	migrateLegacySessionEntriesV1,
	planLegacySessionEntryMigrationV1,
	runPrivateMigrationV1,
} from "../src/core/migrations/session-entry.ts";

function unavailableDescriptor(providerKind: "acp" | "sdk") {
	return {
		schemaVersion: 1 as const,
		providerKind,
		descriptor: {
			schemaVersion: 1 as const,
			providerId: `connector.${providerKind}`,
			providerClass: "agent" as const,
		},
		revision: 1,
		capabilities: {
			resumeSupported: false,
			mailboxSupported: false,
			backgroundSupported: false,
			worktreeSupported: false,
			maxDepth: 1,
		},
		implementedInThisLine: false,
	};
}

describe("private historical Session entry migration", () => {
	it("applies deterministic v1 to v2 to v3 semantics", () => {
		const source = [
			{ type: "session", id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "hookMessage", content: "legacy" },
			},
			{
				type: "compaction",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: "summary",
				firstKeptEntryIndex: 1,
				tokensBefore: 10,
			},
		];

		const first = migrateLegacySessionEntriesV1(source);
		const replay = migrateLegacySessionEntriesV1(source);
		const header = first.entries[0];
		const message = first.entries[1];
		const compaction = first.entries[2];
		if (header?.type !== "session" || message?.type !== "message" || compaction?.type !== "compaction") {
			throw new Error("Expected migrated Session fixture shapes");
		}

		expect(replay).toEqual(first);
		expect(header.version).toBe(3);
		expect(message.id).toMatch(/^[a-f0-9]{8}$/u);
		expect(message.parentId).toBeNull();
		expect(message.message).toMatchObject({ role: "custom" });
		expect(compaction.parentId).toBe(message.id);
		expect(compaction.firstKeptEntryId).toBe(message.id);
		expect("firstKeptEntryIndex" in compaction).toBe(false);
		expect(planLegacySessionEntryMigrationV1(source)).toEqual(planLegacySessionEntryMigrationV1(source));
	});

	it("preserves v2 ids while applying only the v2 to v3 role migration", () => {
		const migrated = migrateLegacySessionEntriesV1([
			{ type: "session", version: 2, id: "session-2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "hookMessage", content: "legacy" },
			},
		]);
		const entry = migrated.entries[1];
		if (entry?.type !== "message") throw new Error("Expected a message entry");
		expect(entry.id).toBe("message-1");
		expect(entry.message).toMatchObject({ role: "custom" });
	});

	it("keeps compatibility wrappers as strict read views", () => {
		const source = [
			{ type: "session", version: 3, id: "session-3", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
			{
				type: "custom",
				id: "lane-entry",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				customType: "__aos.foundation.lane.v1",
				data: { schemaVersion: 1, kind: "lane", lane: "main", leafId: null },
			},
		];
		const migrated = migrateLegacySessionEntriesV1(source);
		expect(migrated.compatibilityViews).toEqual([
			{
				entryId: "lane-entry",
				kind: "lane",
				value: { schemaVersion: 1, kind: "lane", lane: "main", leafId: null },
			},
		]);
		expect(migrated.entries).toEqual(source);
		expect(() =>
			migrateLegacySessionEntriesV1([
				source[0],
				{
					...source[1],
					data: { schemaVersion: 1, kind: "lane", lane: "main", leafId: null, authority: true },
				},
			]),
		).toThrow(PrivateMigrationError);
	});

	it("consumes ACP/SDK descriptors only as unavailable and rejects lifecycle claims", () => {
		expect(decodeLegacyUnavailableProviderDescriptorV1(unavailableDescriptor("acp"))).toEqual({
			schemaVersion: 1,
			providerKind: "acp",
			providerId: "connector.acp",
			revision: 1,
			status: "unavailable",
		});
		expect(decodeLegacyUnavailableProviderDescriptorV1(unavailableDescriptor("sdk"))).toMatchObject({
			providerKind: "sdk",
			status: "unavailable",
		});
		expect(() =>
			decodeLegacyUnavailableProviderDescriptorV1({
				...unavailableDescriptor("acp"),
				childAgentInstanceId: "child-1",
				status: "running",
			}),
		).toThrow("execution or lifecycle claim");
		expect(() =>
			decodeLegacyUnavailableProviderDescriptorV1({
				...unavailableDescriptor("sdk"),
				implementedInThisLine: true,
			}),
		).toThrow(PrivateMigrationError);
	});
});

describe("private migration runner", () => {
	it("writes one deterministic marker and no-ops an exact replay", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "migration-session", createdAt: 1 }));
		const ledger = new SessionLedger(session, { ownerId: "migration-writer" });
		const plan = createPrivateMigrationPlanV1({
			migrationName: "fixture-v1",
			sourceIdentity: { id: "fixture-1" },
			sourceKind: "fixture",
			sourceSchemaVersion: 1,
			targetSchemaVersion: 2,
			source: { schemaVersion: 1, value: "before" },
			result: { schemaVersion: 2, value: "after" },
		});

		const applied = await runPrivateMigrationV1(ledger, plan);
		const replayed = await runPrivateMigrationV1(ledger, plan);
		const records = await ledger.find({ objectType: "migration.applied", objectId: plan.migrationId });

		expect(applied.status).toBe("applied");
		expect(replayed.status).toBe("replayed");
		expect(replayed.marker).toEqual(applied.marker);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ revision: 1, expectedRevision: 0 });
		expect(Object.keys(applied.marker).sort()).toEqual([
			"migrationId",
			"resultFingerprint",
			"schemaVersion",
			"sourceFingerprint",
			"sourceKind",
			"sourceSchemaVersion",
			"status",
			"targetSchemaVersion",
		].sort());
		expect(JSON.stringify(applied.marker)).not.toContain("At");
		await ledger.release();
	});

	it("fails closed when the same migration identity has different content", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "migration-conflict", createdAt: 1 }));
		const ledger = new SessionLedger(session, { ownerId: "migration-writer" });
		const first = createPrivateMigrationPlanV1({
			migrationName: "fixture-v1",
			sourceIdentity: { id: "fixture-1" },
			sourceKind: "fixture",
			sourceSchemaVersion: 1,
			targetSchemaVersion: 2,
			source: { schemaVersion: 1, value: "before" },
			result: { schemaVersion: 2, value: "after" },
		});
		const changed = createPrivateMigrationPlanV1({
			migrationName: "fixture-v1",
			sourceIdentity: { id: "fixture-1" },
			sourceKind: "fixture",
			sourceSchemaVersion: 1,
			targetSchemaVersion: 2,
			source: { schemaVersion: 1, value: "changed" },
			result: { schemaVersion: 2, value: "different" },
		});

		await runPrivateMigrationV1(ledger, first);
		await expect(runPrivateMigrationV1(ledger, changed)).rejects.toThrow("marker conflicts");
		expect(await ledger.find({ objectType: "migration.applied", objectId: first.migrationId })).toHaveLength(1);
		await ledger.release();
	});
});
