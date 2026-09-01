import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import type { WriterLease } from "./writer-leases.ts";

export type SqliteWriterTakeoverReason = "expired" | "forced";

export interface SqliteWriterTakeoverAuditRecord {
	sessionId: string;
	fence: number;
	previousOwnerId: string | null;
	ownerId: string;
	previousFence: number | null;
	previousExpiresAtMs: number | null;
	takenOverAtMs: number;
	reason: SqliteWriterTakeoverReason;
}

interface WriterTakeoverRow {
	session_id: string;
	fence: number;
	previous_owner_id: string | null;
	owner_id: string;
	previous_fence: number | null;
	previous_expires_at_ms: number | null;
	taken_over_at_ms: number;
	reason: SqliteWriterTakeoverReason;
}

function decodeWriterTakeover(row: WriterTakeoverRow): SqliteWriterTakeoverAuditRecord {
	return {
		sessionId: row.session_id,
		fence: row.fence,
		previousOwnerId: row.previous_owner_id,
		ownerId: row.owner_id,
		previousFence: row.previous_fence,
		previousExpiresAtMs: row.previous_expires_at_ms,
		takenOverAtMs: row.taken_over_at_ms,
		reason: row.reason,
	};
}

export function appendWriterTakeover(
	db: SqliteDatabase,
	sessionId: string,
	previous: WriterLease | undefined,
	lease: WriterLease,
	takenOverAtMs: number,
): SqliteWriterTakeoverAuditRecord {
	const reason: SqliteWriterTakeoverReason =
		previous !== undefined && previous.expiresAtMs > 0 && previous.expiresAtMs <= takenOverAtMs ? "expired" : "forced";
	sql`INSERT INTO writer_takeovers (
			session_id,
			fence,
			previous_owner_id,
			owner_id,
			previous_fence,
			previous_expires_at_ms,
			taken_over_at_ms,
			reason
		) VALUES (
			${sessionId},
			${lease.fence},
			${previous?.ownerId ?? null},
			${lease.ownerId},
			${previous?.fence ?? null},
			${previous?.expiresAtMs ?? null},
			${takenOverAtMs},
			${reason}
		)`.run(db);
	return {
		sessionId,
		fence: lease.fence,
		previousOwnerId: previous?.ownerId ?? null,
		ownerId: lease.ownerId,
		previousFence: previous?.fence ?? null,
		previousExpiresAtMs: previous?.expiresAtMs ?? null,
		takenOverAtMs,
		reason,
	};
}

export function readWriterTakeovers(db: SqliteDatabase, sessionId: string): SqliteWriterTakeoverAuditRecord[] {
	return sql`SELECT
			session_id,
			fence,
			previous_owner_id,
			owner_id,
			previous_fence,
			previous_expires_at_ms,
			taken_over_at_ms,
			reason
		FROM writer_takeovers
		WHERE session_id = ${sessionId}
		ORDER BY fence`.all<WriterTakeoverRow>(db).map(decodeWriterTakeover);
}

export function deleteWriterTakeovers(db: SqliteDatabase, sessionId: string): void {
	sql`DELETE FROM writer_takeovers WHERE session_id = ${sessionId}`.run(db);
}
