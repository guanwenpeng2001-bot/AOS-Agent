import type { FoundationRecord, LedgerWriterLease } from "@aos-agent/agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

interface FoundationRecordRow {
	seq: number;
	payload: string;
}

interface FoundationLeaseRow {
	lease_revision: number;
	payload: string;
}

export function readFoundationRecords(db: SqliteDatabase, sessionId: string): FoundationRecord[] {
	return sql`SELECT seq, payload FROM foundation_records WHERE session_id = ${sessionId} ORDER BY seq`
		.all<FoundationRecordRow>(db)
		.map((row) => JSON.parse(row.payload) as FoundationRecord);
}

export function insertFoundationRecord(db: SqliteDatabase, sessionId: string, record: FoundationRecord): void {
	sql`INSERT INTO foundation_records (session_id, seq, payload)
		VALUES (${sessionId}, ${record.seq}, ${JSON.stringify(record)})`.run(db);
}

export function deleteFoundationRecords(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM foundation_records WHERE session_id = ${sessionId}`.run(db);
}

export function readFoundationWriterLease(
	db: SqliteDatabase,
	sessionId: string,
): { lease: LedgerWriterLease; leaseRevision: number } | undefined {
	const row = sql`SELECT lease_revision, payload FROM foundation_writer_leases WHERE session_id = ${sessionId}`
		.get<FoundationLeaseRow>(db);
	if (row === undefined) return undefined;
	return { lease: JSON.parse(row.payload) as LedgerWriterLease, leaseRevision: row.lease_revision };
}

export function writeFoundationWriterLease(db: SqliteDatabase, sessionId: string, lease: LedgerWriterLease): void {
	sql`INSERT INTO foundation_writer_leases (session_id, lease_revision, payload)
		VALUES (${sessionId}, ${lease.leaseRevision}, ${JSON.stringify(lease)})
		ON CONFLICT(session_id) DO UPDATE SET
			lease_revision = excluded.lease_revision,
			payload = excluded.payload`.run(db);
}

export function expireFoundationWriterLease(db: SqliteDatabase, sessionId: string): void {
	const stored = readFoundationWriterLease(db, sessionId);
	if (stored === undefined) return;
	writeFoundationWriterLease(db, sessionId, { ...stored.lease, expiresAt: 0 });
}

export function deleteFoundationWriterLease(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM foundation_writer_leases WHERE session_id = ${sessionId}`.run(db);
}
