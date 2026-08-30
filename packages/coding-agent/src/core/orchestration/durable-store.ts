import {
	canonicalFoundationJson,
	FOUNDATION_ERROR_CODES,
	FoundationError,
	SessionLedgerWriter,
	type FoundationErrorCode,
	type FoundationJsonValue,
	type FoundationRecord,
	type Session,
	type SessionLedgerWriterOptions,
} from "@aos-agent/agent-core";

/** Shared options for the small Session-backed Foundation stores. */
export interface FoundationDurableStoreOptions extends SessionLedgerWriterOptions {
	readonly writer?: SessionLedgerWriter;
}

/** Convert lower-level Session ledger failures to the Foundation error ABI. */
export function asFoundationStoreError(
	error: unknown,
	fallbackCode: FoundationErrorCode = "foundation_schema_invalid_shape",
): FoundationError {
	if (error instanceof FoundationError) return error;
	const candidate = error as { code?: unknown };
	const code =
		candidate !== null &&
		typeof candidate === "object" &&
		typeof candidate.code === "string" &&
		(FOUNDATION_ERROR_CODES as readonly string[]).includes(candidate.code)
			? (candidate.code as FoundationErrorCode)
			: fallbackCode;
	return new FoundationError(code, error instanceof Error ? error.message : String(error), { cause: error });
}

export function storeId(value: string | undefined, field: string): string {
	const result = value ?? "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(result))
		throw new FoundationError("foundation_schema_invalid_shape", `Invalid ${field}`);
	return result;
}

export function storeText(value: string, field: string, maxLength = 16_384): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength)
		throw new FoundationError("foundation_schema_invalid_shape", `Invalid ${field}`);
	return value.trim();
}

export function storeTimestamp(clock: () => number, field = "timestamp"): string {
	const value = clock();
	if (!Number.isSafeInteger(value) || value < 0)
		throw new FoundationError("foundation_schema_invalid_shape", `Clock returned an invalid ${field}`);
	return new Date(value).toISOString();
}

export function validateTimestamp(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		throw new FoundationError("foundation_schema_invalid_shape", `Invalid ${field}`);
	return value;
}

export function cloneStoreValue<T>(value: T): T {
	return structuredClone(value);
}

export function jsonValue(value: unknown, field: string): FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
	} catch {
		throw new FoundationError("foundation_schema_invalid_shape", `${field} must be JSON serializable`);
	}
	return value as FoundationJsonValue;
}

export function mutationId(value: string, field = "clientRequestId"): string {
	return storeId(value, field);
}

export function expectedRevision(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new FoundationError("foundation_schema_invalid_shape", "Invalid expectedRevision");
}

export interface FoundationMutationOptions {
	readonly clientRequestId: string;
	readonly expectedRevision: number;
}

export interface DurableCommandResult<TValue> {
	readonly command: string;
	readonly payload: string;
	readonly result: TValue;
}

export interface DurableCommandIntent {
	readonly command: string;
	readonly payload: string;
}

/**
 * All durable stores share one owner id by default. This is intentional: multiple
 * projections attached to one Session must share its single writer lease.
 */
export function createStoreWriter(
	session: Session,
	options: FoundationDurableStoreOptions = {},
): SessionLedgerWriter {
	if (options.writer !== undefined) {
		if (options.writer.session !== session)
			throw new FoundationError("session_ledger_conflict", "Durable store writer is bound to another Session");
		return options.writer;
	}
	return new SessionLedgerWriter(session, {
		...options,
		ownerId: options.ownerId ?? "foundation-store",
	});
}

export async function readFact<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
): Promise<{ readonly record: Extract<FoundationRecord, { kind: "fact" }>; readonly value: TValue } | undefined> {
	const found = await writer.readFact<FoundationJsonValue>(objectType, objectId);
	return found === undefined ? undefined : { record: found.record, value: found.payload as TValue };
}

export async function listFacts<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
): Promise<readonly { readonly record: Extract<FoundationRecord, { kind: "fact" }>; readonly value: TValue }[]> {
	const records = await writer.listFacts({ objectType, order: "oldestFirst", includePruned: true });
	return records.map((record) => ({ record, value: record.payload as TValue }));
}

/** Read the durable command result before attempting a new mutation. */
export async function readCommand<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	requestId: string,
	command: string,
	payload: string,
): Promise<TValue | undefined> {
	const found = await readFact<DurableCommandResult<TValue>>(writer, objectType, requestId);
	if (found === undefined) return undefined;
	const value = found.value;
	if (value.command !== command || value.payload !== payload)
		throw new FoundationError(
			"session_writer_duplicate_request",
			"clientRequestId was already used with different content",
		);
	return cloneStoreValue(value.result);
}

/** Store a command result after the state mutation has been accepted. */
export async function writeCommand<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	requestId: string,
	command: string,
	payload: string,
	result: TValue,
): Promise<void> {
	const value: DurableCommandResult<TValue> = {
		command,
		payload,
		result: cloneStoreValue(result),
	};
	await writer.writeFact({
		objectType,
		objectId: requestId,
		clientRequestId: `${objectType}:${requestId}`,
		expectedRevision: 0,
		payload: jsonValue(value, "command result"),
	});
}

/** Reserve a mutation before its aggregate/projection writes so recovery can resume it. */
export async function writeCommandIntent(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
	requestId: string,
	command: string,
	payload: string,
	intent: "create" | "update" = "create",
	expectedObjectRevision = 0,
): Promise<Extract<FoundationRecord, { kind: "intent" }>> {
	const metadata = await writer.session.getMetadata();
	const result = await writer.appendFoundationRecord({
		schemaVersion: 1,
		kind: "intent",
		intent,
		id: `${objectType}:${objectId}`,
		lane: writer.lane,
		objectType,
		objectId,
		clientRequestId: requestId,
		expectedRevision: expectedObjectRevision,
		payload: jsonValue({ command, payload } satisfies DurableCommandIntent, "command intent"),
		correlation: { sessionId: metadata.id, laneId: writer.lane, revision: 0 },
	});
	if (result.record.kind !== "intent")
		throw new FoundationError("serialization_failed", "Durable store returned a non-intent record");
	return result.record;
}

/** Persist the result on the command object after its intent revision. */
export async function writeCommandResult<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
	requestId: string,
	command: string,
	payload: string,
	result: TValue,
): Promise<TValue> {
	const value = jsonValue({ command, payload, result: cloneStoreValue(result) }, "command result");
	const accepted = await writeFact(writer, objectType, objectId, value, requestId, 1);
	const stored = accepted.value as { command: string; payload: string; result: TValue };
	if (stored.command !== command || stored.payload !== payload)
		throw new FoundationError(
			"session_writer_duplicate_request",
			"clientRequestId was already used with different content",
		);
	return cloneStoreValue(stored.result);
}

/** Read a completed command result; an intent without a result is recoverable. */
export async function readCommandResult<TValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
	requestId: string,
	command: string,
	payload: string,
): Promise<TValue | undefined> {
	const found = await readFact<{ command: string; payload: string; result: TValue }>(writer, objectType, objectId);
	if (found === undefined) return undefined;
	if (found.value.command !== command || found.value.payload !== payload)
		throw new FoundationError(
			"session_writer_duplicate_request",
			"clientRequestId was already used with different content",
		);
	return cloneStoreValue(found.value.result);
}

export async function writeFact<TValue extends FoundationJsonValue>(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
	value: TValue,
	requestId: string,
	revision: number,
): Promise<{
	readonly value: TValue;
	readonly replayed: boolean;
	readonly record: Extract<FoundationRecord, { kind: "fact" }>;
}> {
	const result = await writer.writeFact({
		objectType,
		objectId,
		clientRequestId: requestId,
		expectedRevision: revision,
		payload: value,
	});
	return { value: result.payload as TValue, replayed: result.replayed, record: result.record };
}

export async function writeTombstone(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
	requestId: string,
	expectedObjectRevision: number,
	reason?: string,
): Promise<Extract<FoundationRecord, { kind: "tombstone" }>> {
	const result = await writer.appendFoundationRecord({
		schemaVersion: 1,
		kind: "tombstone",
		id: `${objectType}:${objectId}:${requestId}`,
		lane: writer.lane,
		objectType,
		objectId,
		clientRequestId: requestId,
		expectedRevision: expectedObjectRevision,
		...(reason === undefined ? {} : { reason }),
		correlation: { sessionId: (await writer.session.getMetadata()).id, laneId: writer.lane, revision: 0 },
	});
	if (result.record.kind !== "tombstone")
		throw new FoundationError("serialization_failed", "Durable store returned a non-tombstone record");
	return result.record;
}

export async function recordsForObject(
	writer: SessionLedgerWriter,
	objectType: string,
	objectId: string,
): Promise<readonly FoundationRecord[]> {
	return writer.session.findFoundationRecords({ objectType, objectId, order: "oldestFirst", includePruned: true });
}
