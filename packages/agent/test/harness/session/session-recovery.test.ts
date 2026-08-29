import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { encodeFoundationMutation } from "../../../src/harness/session/durable/codec.ts";
import type { ProvisionedFoundationRecord } from "../../../src/harness/session/durable/types.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import { FileError } from "../../../src/harness/types.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "aos-agent-t11r-recovery-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createRepository(root: string, fs = new NodeExecutionEnv({ cwd: root })): JsonlSessionRepo {
	return new JsonlSessionRepo({ fs, sessionsRoot: root });
}

function fact(
	sessionId: string,
	clientRequestId: string,
	name: string,
	expectedRevision?: number,
): ProvisionedFoundationRecord {
	return {
		schemaVersion: 1,
		kind: "fact",
		id: `record-${clientRequestId}`,
		lane: "main",
		objectType: "identity",
		objectId: "alice",
		clientRequestId,
		...(expectedRevision === undefined ? {} : { expectedRevision }),
		correlation: { sessionId, laneId: "main", revision: 0 },
		payload: { name },
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("T11R session and durable-ledger recovery", () => {
	it("preserves the v4 source when migration publication fails", async () => {
		const root = temporaryDirectory();
		const env = new NodeExecutionEnv({ cwd: root });
		const session = await createRepository(root, env).create({ id: "migration-failure", cwd: root });
		const metadata = await session.getMetadata();
		const original = readFileSync(metadata.path, "utf8");
		vi.spyOn(env, "renameFile").mockResolvedValueOnce({
			ok: false,
			error: new FileError("unknown", "injected migration publish failure"),
		});

		await expect(session.acquireWriterLease({ ownerId: "writer" })).rejects.toMatchObject({
			code: "session_ledger_migrating",
		});
		expect(readFileSync(metadata.path, "utf8")).toBe(original);
		expect(JSON.parse(original.split("\n")[0]!).version).toBe(4);
		expect(existsSync(`${metadata.path}.v5.tmp`)).toBe(false);
	});

	it("refolds a truncated durable tail and continues from the valid prefix", async () => {
		const root = temporaryDirectory();
		const session = await createRepository(root).create({ id: "truncated-tail", cwd: root });
		const lease = await session.acquireWriterLease({ ownerId: "writer" });
		await session.appendFoundationRecord({
			...fact("truncated-tail", "create", "Alice"),
			fencingToken: lease.fencingToken,
		});
		const metadata = await session.getMetadata();
		const validPrefix = readFileSync(metadata.path, "utf8");
		appendFileSync(metadata.path, '{"kind":"foundation"');

		const reopened = await createRepository(root).open(metadata);
		expect(readFileSync(metadata.path, "utf8")).toBe(validPrefix);
		expect(await reopened.getLedgerRevision()).toBe(1);
		expect(await reopened.getFoundationRevision("identity", "alice")).toBe(1);
		const next = await reopened.appendFoundationRecord({
			...fact("truncated-tail", "update", "Alicia", 1),
			fencingToken: lease.fencingToken,
		});
		expect(next).toMatchObject({ replayed: false, record: { seq: 2, revision: 2 } });
	});

	it("rejects stale fencing and changed duplicate client requests without appending", async () => {
		const root = temporaryDirectory();
		const session = await createRepository(root).create({ id: "fencing-idempotency", cwd: root });
		const firstLease = await session.acquireWriterLease({ ownerId: "writer-1" });
		await session.appendFoundationRecord({
			...fact("fencing-idempotency", "create", "Alice"),
			fencingToken: firstLease.fencingToken,
		});
		await session.releaseWriterLease({ fencingToken: firstLease.fencingToken });
		const secondLease = await session.acquireWriterLease({ ownerId: "writer-2" });

		await expect(
			session.appendFoundationRecord({
				...fact("fencing-idempotency", "create", "Stale"),
				fencingToken: firstLease.fencingToken,
			}),
		).rejects.toMatchObject({ code: "session_writer_fencing_token" });
		await expect(
			session.appendFoundationRecord({
				...fact("fencing-idempotency", "create", "Changed"),
				fencingToken: secondLease.fencingToken,
			}),
		).rejects.toMatchObject({ code: "session_writer_duplicate_request" });
		expect(await session.getLedgerRevision()).toBe(1);
	});

	it("classifies a semantically invalid persisted durable record as corruption", async () => {
		const root = temporaryDirectory();
		const session = await createRepository(root).create({ id: "corrupt-ledger", cwd: root });
		const lease = await session.acquireWriterLease({ ownerId: "writer" });
		const first = await session.appendFoundationRecord({
			...fact("corrupt-ledger", "create", "Alice"),
			fencingToken: lease.fencingToken,
		});
		const metadata = await session.getMetadata();
		const original = readFileSync(metadata.path, "utf8");
		if (first.record.kind !== "fact") throw new Error("Expected a fact record");
		const reopened = await createRepository(root).open(metadata);
		const invalidRecord = {
			...first.record,
			id: "record-gap",
			seq: 3,
			revision: 2,
			clientRequestId: "gap",
			correlation: { ...first.record.correlation, revision: 2 },
			payload: { name: "Gap" },
		};
		const encodedInvalidRecord = encodeFoundationMutation(invalidRecord);
		appendFileSync(metadata.path, encodedInvalidRecord);

		await expect(reopened.getLedgerRevision()).rejects.toMatchObject({ code: "session_ledger_corrupt" });
		await expect(createRepository(root).open(metadata)).rejects.toMatchObject({ code: "session_ledger_corrupt" });
		expect(readFileSync(metadata.path, "utf8")).toBe(`${original}${encodedInvalidRecord}`);
	});

	it("fails closed on an unknown durable schema without modifying the file", async () => {
		const root = temporaryDirectory();
		const session = await createRepository(root).create({ id: "unknown-schema", cwd: root });
		await session.acquireWriterLease({ ownerId: "writer" });
		const metadata = await session.getMetadata();
		const original = readFileSync(metadata.path, "utf8");
		const unknownSchema = `${JSON.stringify({ kind: "foundation", schemaVersion: 2, record: {} })}\n`;
		appendFileSync(metadata.path, unknownSchema);

		await expect(createRepository(root).open(metadata)).rejects.toMatchObject({
			code: "session_ledger_unknown_format",
		});
		expect(readFileSync(metadata.path, "utf8")).toBe(`${original}${unknownSchema}`);
	});
});
