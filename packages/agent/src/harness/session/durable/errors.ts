import { SessionError } from "../types.ts";

export type DurableLedgerErrorCode =
	| "session_writer_lease_lost"
	| "session_writer_fencing_token"
	| "session_writer_stale_revision"
	| "session_writer_duplicate_request"
	| "session_writer_busy"
	| "session_writer_lease_expired"
	| "session_ledger_tombstoned"
	| "session_ledger_conflict"
	| "session_ledger_missing_intent"
	| "session_ledger_unknown_format"
	| "session_ledger_corrupt"
	| "session_ledger_truncated"
	| "session_ledger_invalid_record"
	| "session_ledger_invalid_query"
	| "session_ledger_migrating"
	| "session_ledger_storage";

/** Stable errors for durable Foundation writes and replay. */
export class DurableLedgerError extends Error {
	readonly code: DurableLedgerErrorCode;
	readonly expectedRevision?: number;
	readonly actualRevision?: number;

	constructor(
		code: DurableLedgerErrorCode,
		message: string,
		options: { cause?: Error; expectedRevision?: number; actualRevision?: number } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "DurableLedgerError";
		this.code = code;
		this.expectedRevision = options.expectedRevision;
		this.actualRevision = options.actualRevision;
	}
}

export function asDurableLedgerError(error: unknown, message: string): DurableLedgerError {
	if (error instanceof DurableLedgerError) return error;
	if (error instanceof SessionError) {
		return new DurableLedgerError("session_ledger_storage", `${message}: ${error.message}`, { cause: error });
	}
	return new DurableLedgerError(
		"session_ledger_storage",
		`${message}: ${error instanceof Error ? error.message : String(error)}`,
		error instanceof Error ? { cause: error } : {},
	);
}

export function invalidDurableRecord(message: string): DurableLedgerError {
	return new DurableLedgerError("session_ledger_invalid_record", message);
}
