import { canonicalFoundationJson, type FoundationJsonValue } from "../../foundation/index.ts";
import { err, ok, type Result } from "../../types.ts";
import { JsonlDecodeError } from "../jsonl/errors.ts";
import type {
	FoundationFactRecord,
	FoundationIntentRecord,
	FoundationRecord,
	FoundationRetentionRecord,
	FoundationTombstoneRecord,
} from "./types.ts";

export interface FoundationJsonlMutation {
	kind: "foundation";
	schemaVersion: 1;
	record: FoundationRecord;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new JsonlDecodeError("syntax", "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw new JsonlDecodeError("schema", "is not a JSON object");
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new JsonlDecodeError("schema", `has invalid ${field}`);
	return value;
}

function requireInteger(value: unknown, field: string, positive = false): number {
	if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
		throw new JsonlDecodeError("schema", `has invalid ${field}`);
	}
	return value as number;
}

function requireExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of required) if (!Object.hasOwn(value, key)) throw new JsonlDecodeError("schema", `is missing ${key}`);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new JsonlDecodeError("schema", `has unknown field ${key}`);
}

function decodeCorrelation(value: unknown): FoundationRecord["correlation"] {
	if (!isObject(value)) throw new JsonlDecodeError("schema", "has invalid correlation");
	const allowed = new Set([
		"sessionId", "laneId", "roleId", "roleRevisionId", "modelProfileId", "modelProfileRevisionId", "bindingId",
		"bindingEpochId", "agentInstanceId", "goalId", "planId", "stageId", "taskId", "dispatchId", "attemptId",
		"attemptReceiptId", "taskResultId", "runReceiptId", "runId", "turnId", "stepId", "parentId", "ancestorIds",
		"revision", "fencingToken",
	]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new JsonlDecodeError("schema", `has unknown correlation field ${key}`);
	const sessionId = requireString(value.sessionId, "correlation.sessionId");
	const laneId = requireString(value.laneId, "correlation.laneId");
	const revision = requireInteger(value.revision, "correlation.revision");
	if (value.ancestorIds !== undefined && (!Array.isArray(value.ancestorIds) || value.ancestorIds.some((id) => typeof id !== "string"))) {
		throw new JsonlDecodeError("schema", "has invalid correlation.ancestorIds");
	}
	const fencingToken = requireString(value.fencingToken, "correlation.fencingToken");
	for (const key of Object.keys(value)) {
		if (key === "sessionId" || key === "laneId" || key === "revision" || key === "ancestorIds" || key === "fencingToken") continue;
		if (typeof value[key] !== "string") throw new JsonlDecodeError("schema", `has invalid correlation.${key}`);
	}
	return { ...value, sessionId, laneId, revision, fencingToken } as FoundationRecord["correlation"];
}

function parsePayload(value: unknown, field: string): FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
	} catch (error) {
		throw new JsonlDecodeError("schema", `${field} is not canonical Foundation JSON`, error instanceof Error ? error : undefined);
	}
	return value as FoundationJsonValue;
}

function decodeRecord(value: unknown): FoundationRecord {
	if (!isObject(value)) throw new JsonlDecodeError("schema", "foundation mutation record is not an object");
	if (value.schemaVersion !== 1) throw new JsonlDecodeError("schema", "has unsupported durable schema version");
	const kind = requireString(value.kind, "kind");
	const baseRequired = ["schemaVersion", "kind", "id", "seq", "lane", "timestamp", "clientRequestId", "fencingToken", "correlation"];
	const baseOptional = ["expectedRevision"];
	const id = requireString(value.id, "id");
	const seq = requireInteger(value.seq, "seq", true);
	const lane = requireString(value.lane, "lane");
	const timestamp = requireInteger(value.timestamp, "timestamp");
	const clientRequestId = requireString(value.clientRequestId, "clientRequestId");
	const correlation = decodeCorrelation(value.correlation);
	if (value.expectedRevision !== undefined) requireInteger(value.expectedRevision, "expectedRevision");
	const fencingToken = requireString(value.fencingToken, "fencingToken");
	if (correlation.fencingToken !== fencingToken) throw new JsonlDecodeError("schema", "fencingToken does not match correlation.fencingToken");
	if (kind === "retention") {
		requireExactKeys(value, [...baseRequired, "retentionRevision", "policy"], baseOptional);
		const policyValue = value.policy;
		if (!isObject(policyValue) || policyValue.schemaVersion !== 1 || !Number.isSafeInteger(policyValue.cutSequence) || (policyValue.cutSequence as number) < 0) {
			throw new JsonlDecodeError("schema", "has invalid retention policy");
		}
		if (policyValue.reason !== undefined) requireString(policyValue.reason, "policy.reason");
		requireInteger(value.retentionRevision, "retentionRevision", true);
		return {
			schemaVersion: 1,
			kind: "retention",
			id,
			seq,
			lane,
			timestamp,
			retentionRevision: value.retentionRevision as number,
			policy: { ...policyValue, cutSequence: policyValue.cutSequence as number } as FoundationRetentionRecord["policy"],
			clientRequestId,
			...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
			fencingToken,
			correlation,
		};
	}
	const objectType = requireString(value.objectType, "objectType");
	const objectId = requireString(value.objectId, "objectId");
	const revision = requireInteger(value.revision, "revision", true);
	if (correlation.revision !== revision) throw new JsonlDecodeError("schema", "correlation.revision does not match revision");
	if (kind === "fact") {
		requireExactKeys(value, [...baseRequired, "objectType", "objectId", "revision", "payload"], baseOptional);
		return {
			schemaVersion: 1,
			kind: "fact",
			id,
			seq,
			lane,
			timestamp,
			objectType,
			objectId,
			revision,
			clientRequestId,
			...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
			fencingToken,
			correlation,
			payload: parsePayload(value.payload, "payload"),
		} satisfies FoundationFactRecord;
	}
	if (kind === "intent") {
		requireExactKeys(value, [...baseRequired, "objectType", "objectId", "revision", "intent"], [...baseOptional, "payload"]);
		if (value.intent !== "create" && value.intent !== "update" && value.intent !== "delete") throw new JsonlDecodeError("schema", "has invalid intent");
		return {
			schemaVersion: 1,
			kind: "intent",
			id,
			seq,
			lane,
			timestamp,
			objectType,
			objectId,
			revision,
			clientRequestId,
			intent: value.intent,
			...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
			fencingToken,
			correlation,
			...(value.payload === undefined ? {} : { payload: parsePayload(value.payload, "payload") }),
		} satisfies FoundationIntentRecord;
	}
	if (kind === "tombstone") {
		requireExactKeys(value, [...baseRequired, "objectType", "objectId", "revision"], [...baseOptional, "deleteIntentId", "reason"]);
		if (value.deleteIntentId !== undefined) requireString(value.deleteIntentId, "deleteIntentId");
		if (value.reason !== undefined) requireString(value.reason, "reason");
		return {
			schemaVersion: 1,
			kind: "tombstone",
			id,
			seq,
			lane,
			timestamp,
			objectType,
			objectId,
			revision,
			clientRequestId,
			...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
			fencingToken,
			correlation,
			...(value.deleteIntentId === undefined ? {} : { deleteIntentId: value.deleteIntentId as string }),
			...(value.reason === undefined ? {} : { reason: value.reason as string }),
		} satisfies FoundationTombstoneRecord;
	}
	throw new JsonlDecodeError("schema", `has unknown durable record kind ${kind}`);
}

export function parseFoundationMutation(line: string): Result<FoundationRecord, JsonlDecodeError> {
	try {
		const value = parseObject(line);
		if (value.kind !== "foundation") throw new JsonlDecodeError("schema", "is not a foundation mutation");
		if (value.schemaVersion !== 1) throw new JsonlDecodeError("schema", "has unsupported durable schema version");
		requireExactKeys(value, ["kind", "schemaVersion", "record"]);
		return ok(decodeRecord(value.record));
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err(error);
		throw error;
	}
}

export function encodeFoundationMutation(record: FoundationRecord): string {
	const mutation: FoundationJsonlMutation = { kind: "foundation", schemaVersion: 1, record };
	return `${canonicalFoundationJson(mutation)}\n`;
}

export function isFoundationMutationLine(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line);
		return isObject(value) && value.kind === "foundation";
	} catch {
		return false;
	}
}
