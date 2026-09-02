import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	Session,
	type Entry,
	type LaneRecord,
	type NewRecord,
	type ProvisionedFoundationRecord,
	type ProvisionedEntry,
} from "@aos-agent/agent-core";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import {
	createNodeSqliteFactory,
	SqliteSessionRepository,
	type SqliteSessionMetadata,
	type SqliteWriterLeaseOptions,
	type SqliteWriterTakeoverAuditRecord,
} from "@aos-agent/session-backend-sqlite-node";
import { SessionManager } from "./core/session/manager.ts";
import {
	type CodingAgentSessionMetadata,
	SessionManagerStorage,
} from "./core/session/manager-storage.ts";

export type SharedSessionAccess = "writer" | "follower";

export interface SqliteSharedSessionLedgerOptions {
	databasePath: string;
	cwd?: string;
	/** Stable, non-secret identity used for writer ownership and take-over audit records. */
	hostId?: string;
	writerLease?: SqliteWriterLeaseOptions;
}

export interface OpenSharedSessionOptions {
	access?: SharedSessionAccess;
	/** Explicitly replaces the current writer. The previous host is fenced on its next write. */
	takeOver?: boolean;
}

export interface CreateSharedSessionOptions {
	id?: string;
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

function provisionEntry(entry: Entry): ProvisionedEntry {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
	return provisioned as ProvisionedEntry;
}

function provisionRecord(record: LaneRecord): NewRecord {
	const { seq: _seq, timestamp: _timestamp, ...provisioned } = record;
	return provisioned as NewRecord;
}

async function copySession(source: Session, target: Session): Promise<void> {
	const [entries, records, foundationRecords, lanes, name] = await Promise.all([
		source.findEntries({ order: "oldestFirst" }),
		source.findRecords({ order: "oldestFirst" }),
		source.findFoundationRecords({ order: "oldestFirst", includePruned: true }),
		source.getLanes(),
		source.getName(),
	]);

	for (const entry of entries) {
		await target.moveLane("main", entry.parentId);
		await target.appendEntry(provisionEntry(entry), "main");
	}

	const main = lanes.find((lane) => lane.lane === "main");
	await target.moveLane("main", main?.leafId ?? null);
	for (const lane of lanes) {
		if (lane.lane !== "main") await target.createLane(lane.lane, lane.leafId);
	}
	for (const record of records) await target.appendRecord(provisionRecord(record));
	if (foundationRecords.length > 0) {
		const lease = await target.acquireWriterLease({ ownerId: `migration:${process.pid}` });
		try {
			for (const record of foundationRecords) {
				const { fencingToken: _correlationFence, ...sourceCorrelation } = record.correlation;
				const correlation = { ...sourceCorrelation, revision: 0 };
				let provisioned: ProvisionedFoundationRecord;
				if (record.kind === "retention") {
					const { seq: _seq, timestamp: _timestamp, fencingToken: _fencingToken, correlation: _correlation, ...input } = record;
					provisioned = { ...input, fencingToken: lease.fencingToken, correlation };
				} else {
					const {
						seq: _seq,
						timestamp: _timestamp,
						revision: _revision,
						fencingToken: _fencingToken,
						correlation: _correlation,
						...input
					} = record;
					provisioned = { ...input, fencingToken: lease.fencingToken, correlation } as ProvisionedFoundationRecord;
				}
				await target.appendFoundationRecord(provisioned);
			}
		} finally {
			await target.releaseWriterLease({ fencingToken: lease.fencingToken });
		}
	}
	if (name !== undefined) await target.setName(name);
	for (const entry of entries) {
		const label = await source.getLabel(entry.id);
		if (label !== undefined) await target.setLabel(entry.id, label);
	}
	await target.drain();
}

function openJsonlSession(path: string): {
	manager: SessionManager;
	session: Session<CodingAgentSessionMetadata>;
} {
	const manager = SessionManager.open(path);
	return { manager, session: new Session(new SessionManagerStorage(manager)) };
}

/**
 * Optional Node-only shared ledger entry point for coding-agent integrations.
 * Followers read the latest SQLite state available on their replica and cannot write.
 */
export class SqliteSharedSessionLedger implements AsyncDisposable {
	private readonly repository: SqliteSessionRepository;

	constructor(options: SqliteSharedSessionLedgerOptions) {
		const cwd = resolve(options.cwd ?? process.cwd());
		this.repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd }),
			sqlite: createNodeSqliteFactory(),
			databasePath: options.databasePath,
			...(options.hostId === undefined ? {} : { hostId: options.hostId }),
			...(options.writerLease === undefined ? {} : { writerLease: options.writerLease }),
		});
	}

	create(options: CreateSharedSessionOptions): Promise<Session<SqliteSessionMetadata>> {
		return this.repository.create(options);
	}

	async list(cwd?: string): Promise<SqliteSessionMetadata[]> {
		return this.repository.list(cwd === undefined ? {} : { cwd: resolve(cwd) });
	}

	async open(sessionId: string, options: OpenSharedSessionOptions = {}): Promise<Session<SqliteSessionMetadata>> {
		const metadata = (await this.repository.list()).find((candidate) => candidate.id === sessionId);
		if (metadata === undefined) throw new Error(`SQLite session not found: ${sessionId}`);
		if (options.access === "follower" && options.takeOver === true) {
			throw new TypeError("A follower cannot take over SQLite writer ownership");
		}
		return this.repository.open(metadata, {
			mode: options.access === "follower" ? "readOnly" : "writer",
			...(options.takeOver === true ? { takeOver: true } : {}),
		});
	}

	async getWriterTakeoverAudit(sessionId: string): Promise<SqliteWriterTakeoverAuditRecord[]> {
		const metadata = (await this.repository.list()).find((candidate) => candidate.id === sessionId);
		if (metadata === undefined) throw new Error(`SQLite session not found: ${sessionId}`);
		return this.repository.getWriterTakeoverAudit(metadata);
	}

	async importJsonl(path: string): Promise<SqliteSessionMetadata> {
		const source = openJsonlSession(resolve(path)).session;
		const metadata = await source.getMetadata();
		const target = await this.repository.create({
			id: metadata.id,
			cwd: metadata.cwd,
			...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
			metadata: { codingAgentFormat: "jsonl-v3" },
		});
		const targetMetadata = await target.getMetadata();
		try {
			await copySession(source, target);
			return target.getMetadata();
		} catch (error) {
			await this.repository.delete(targetMetadata);
			throw error;
		}
	}

	async exportJsonl(sessionId: string, path: string): Promise<string> {
		const targetPath = resolve(path);
		if (existsSync(targetPath)) throw new Error(`JSONL migration target already exists: ${targetPath}`);
		const source = await this.open(sessionId, { access: "follower" });
		const metadata = await source.getMetadata();
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(
			targetPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: metadata.id,
				timestamp: new Date(metadata.createdAt).toISOString(),
				cwd: metadata.cwd,
				...(metadata.parentSessionId === undefined ? {} : { parentSession: metadata.parentSessionId }),
			})}\n`,
			{ encoding: "utf8", flag: "wx" },
		);
		try {
			const target = openJsonlSession(targetPath);
			await copySession(source, target.session);
			target.manager.flushPendingSession();
			return targetPath;
		} catch (error) {
			unlinkSync(targetPath);
			throw error;
		}
	}

	close(): Promise<void> {
		return this.repository.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
