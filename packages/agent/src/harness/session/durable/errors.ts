import { DURABLE_LEDGER_ERROR_CODES, type DurableLedgerErrorCode } from "../../foundation/errors.ts";
import { SessionError } from "../types.ts";

export { DURABLE_LEDGER_ERROR_CODES };
export type { DurableLedgerErrorCode };

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
