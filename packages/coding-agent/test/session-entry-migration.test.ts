import {
	type AppendFoundationFactOptions,
	InMemorySessionStorage,
	Session,
	SessionLedger,
	type SessionLedgerFactResult,
} from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
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

function legacyHookMessage() {
	return {
		role: "hookMessage" as const,
		customType: "legacy.hook",
		content: "legacy",
		display: false,
		timestamp: 1,
	};
}

function durableRecord() {
	return {
		schemaVersion: 1 as const,
		kind: "fact" as const,
		id: "foundation-record-1",
		seq: 1,
		lane: "main",
		timestamp: 1,
		objectType: "fixture",
		objectId: "fixture-1",
		revision: 1,
		clientRequestId: "fixture-create",
		expectedRevision: 0,
		fencingToken: "fence-1",
		correlation: {
			sessionId: "session-3",
			laneId: "main",
			revision: 1,
			fencingToken: "fence-1",
		},
		payload: { value: "fixture" },
	};
}

class InterleavedConflictLedger extends SessionLedger {
	private injected = false;

	override async appendFact<TPayload>(
		objectType: string,
		objectId: string,
		payload: TPayload,
		options: AppendFoundationFactOptions,
	): Promise<SessionLedgerFactResult<TPayload>> {
		if (!this.injected) {
			this.injected = true;
			const conflicting = {
				...(payload as Record<string, unknown>),
				sourceKind: "conflicting-fixture",
			} as unknown as TPayload;
			await super.appendFact(objectType, objectId, conflicting, {
				...options,
				clientRequestId: `${options.clientRequestId}:conflict`,
			});
		}
		return super.appendFact(objectType, objectId, payload, options);
	}
}

describe("private historical Session entry migration", () => {
	it("applies deterministic v1 to v2 to v3 semantics", () => {
		const source = [
			{ type: "session", id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
			{
				type: "message",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: legacyHookMessage(),
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
				message: legacyHookMessage(),
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

	it("exact-validates every reserved wrapper inner contract and leaves extension data opaque", () => {
		const header = { type: "session", version: 3, id: "session-3", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" };
		const wrappers = [
			{
				type: "custom",
				id: "entry-wrapper",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				customType: "__aos.foundation.entry.v1",
				data: {
					schemaVersion: 1,
					kind: "entry",
					entry: { type: "custom", id: "inner-entry", seq: 1, parentId: null, timestamp: 1, customType: "extension", data: { opaque: [1, true] } },
				},
			},
			{
				type: "custom",
				id: "record-wrapper",
				parentId: "entry-wrapper",
				timestamp: "2026-01-01T00:00:02.000Z",
				customType: "__aos.foundation.record.v1",
				data: {
					schemaVersion: 1,
					kind: "record",
					record: { type: "abort_requested", id: "record-1", seq: 2, lane: "main", timestamp: 2, runId: "run-1" },
				},
			},
			{
				type: "custom",
				id: "fact-wrapper",
				parentId: "record-wrapper",
				timestamp: "2026-01-01T00:00:03.000Z",
				customType: "__aos.foundation.fact.v1",
				data: { schemaVersion: 1, kind: "name", name: "fixture" },
			},
			{
				type: "custom",
				id: "durable-wrapper",
				parentId: "fact-wrapper",
				timestamp: "2026-01-01T00:00:04.000Z",
				customType: "__aos.foundation.durable.v1",
				data: { schemaVersion: 1, kind: "durable", record: durableRecord() },
			},
			{
				type: "custom",
				id: "extension-entry",
				parentId: "durable-wrapper",
				timestamp: "2026-01-01T00:00:05.000Z",
				customType: "extension.opaque",
				data: { nested: { remains: ["opaque", 1, true] } },
			},
		];
		const migrated = migrateLegacySessionEntriesV1([header, ...wrappers]);
		expect(migrated.compatibilityViews.map((view) => view.kind)).toEqual(["entry", "record", "name", "durable"]);
		expect(migrated.entries.at(-1)).toEqual(wrappers.at(-1));

		const invalidWrappers = [
			{
				...wrappers[0],
				data: { schemaVersion: 1, kind: "entry", entry: { type: "message", id: "inner", seq: 1, parentId: null, timestamp: 1, message: { role: "user" } } },
			},
			{
				...wrappers[1],
				data: { schemaVersion: 1, kind: "record", record: { type: "abort_requested", id: "record-1", seq: 2, lane: "main", timestamp: 2, runId: 1 } },
			},
			{
				...wrappers[2],
				data: { schemaVersion: 1, kind: "name", name: "fixture", authority: true },
			},
			{
				...wrappers[3],
				data: { schemaVersion: 1, kind: "durable", record: { ...durableRecord(), unexpected: true } },
			},
			{
				...wrappers[3],
				data: {
					schemaVersion: 1,
					kind: "durable",
					record: {
						schemaVersion: 1,
						kind: "retention",
						id: "retention-1",
						seq: 1,
						lane: "main",
						timestamp: 1,
						retentionRevision: 1,
						policy: { schemaVersion: 1, cutSequence: 0, authority: true },
						clientRequestId: "retention-create",
						fencingToken: "fence-1",
						correlation: {
							sessionId: "session-3",
							laneId: "main",
							revision: 0,
							fencingToken: "fence-1",
						},
					},
				},
			},
		];
		for (const invalid of invalidWrappers) {
			expect(() => migrateLegacySessionEntriesV1([header, invalid])).toThrow(PrivateMigrationError);
		}
	});

	it("rejects invalid v1, v2, and v3 entry contracts after conversion", () => {
		const invalidSessions = [
			[
				{ type: "session", id: "session-v1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
				{ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "hookMessage", content: "missing contract fields" } },
			],
			[
				{ type: "session", version: 2, id: "session-v2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
				{
					type: "compaction",
					id: "compaction-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					summary: "summary",
					firstKeptEntryId: "compaction-1",
					tokensBefore: 1,
					usage: { input: 1 },
				},
			],
			[
				{ type: "session", version: 3, id: "session-v3", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" },
				{
					type: "custom_message",
					id: "custom-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					customType: "extension",
					content: [{ type: "text", text: "hello", authority: true }],
					display: true,
				},
			],
		];
		for (const invalid of invalidSessions) {
			expect(() => migrateLegacySessionEntriesV1(invalid)).toThrow(PrivateMigrationError);
		}
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
		for (const invalid of [
			{
				...unavailableDescriptor("acp"),
				capabilities: { ...unavailableDescriptor("acp").capabilities, resumeSupported: true },
			},
			{
				...unavailableDescriptor("acp"),
				descriptor: { ...unavailableDescriptor("acp").descriptor, providerId: "connector.sdk" },
			},
			{ ...unavailableDescriptor("sdk"), revision: 2 },
			{
				...unavailableDescriptor("sdk"),
				capabilities: { ...unavailableDescriptor("sdk").capabilities, maxDepth: 2 },
			},
		]) {
			expect(() => decodeLegacyUnavailableProviderDescriptorV1(invalid)).toThrow(PrivateMigrationError);
		}
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
		const revision = vi.spyOn(ledger, "revision");

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
		expect(revision).not.toHaveBeenCalled();
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

	it("uses the observed absence revision and classifies an interleaved marker race as conflict", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "migration-race", createdAt: 1 }));
		const ledger = new InterleavedConflictLedger(session, { ownerId: "migration-writer" });
		const plan = createPrivateMigrationPlanV1({
			migrationName: "fixture-v1",
			sourceIdentity: { id: "fixture-1" },
			sourceKind: "fixture",
			sourceSchemaVersion: 1,
			targetSchemaVersion: 2,
			source: { schemaVersion: 1, value: "before" },
			result: { schemaVersion: 2, value: "after" },
		});

		await expect(runPrivateMigrationV1(ledger, plan)).rejects.toThrow("marker conflicts");
		expect(await ledger.find({ objectType: "migration.applied", objectId: plan.migrationId })).toHaveLength(1);
		await ledger.release();
	});

	it("rejects every forged plan field before any ledger read or write", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "migration-forged", createdAt: 1 }));
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
		const reads = vi.spyOn(ledger, "get");
		const writes = vi.spyOn(ledger, "appendFact");
		const revisions = vi.spyOn(ledger, "revision");
		const forged = [
			{ ...plan, schemaVersion: 2 },
			{ ...plan, migrationId: "migration:bad" },
			{ ...plan, sourceKind: 1 },
			{ ...plan, sourceSchemaVersion: -1 },
			{ ...plan, targetSchemaVersion: 1.5 },
			{ ...plan, sourceFingerprint: { algorithm: "sha1", value: plan.sourceFingerprint.value } },
			{ ...plan, resultFingerprint: { algorithm: "sha256", value: "bad" } },
			{ ...plan, status: "pending" },
			{ ...plan, source: { schemaVersion: 1, value: "forged" } },
			{ ...plan, result: { schemaVersion: 2, value: "forged" } },
			{ ...plan, authority: true },
		];
		for (const candidate of forged) {
			await expect(
				runPrivateMigrationV1(ledger, candidate as unknown as typeof plan),
			).rejects.toThrow(PrivateMigrationError);
		}
		expect(reads).not.toHaveBeenCalled();
		expect(writes).not.toHaveBeenCalled();
		expect(revisions).not.toHaveBeenCalled();
		await ledger.release();
	});
});
