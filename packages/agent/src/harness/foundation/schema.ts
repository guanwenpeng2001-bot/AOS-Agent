import { type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError, type FoundationErrorCode } from "./errors.ts";
import { canonicalFoundationJson, type ExecutionCorrelation, type Fingerprint, type FoundationLineage } from "./identity.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";

export const ExecutionCorrelationSchema = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		laneId: Type.String({ minLength: 1 }),
		roleId: Type.Optional(Type.String({ minLength: 1 })), roleRevisionId: Type.Optional(Type.String({ minLength: 1 })),
		modelProfileId: Type.Optional(Type.String({ minLength: 1 })), modelProfileRevisionId: Type.Optional(Type.String({ minLength: 1 })),
		bindingId: Type.Optional(Type.String({ minLength: 1 })), bindingEpochId: Type.Optional(Type.String({ minLength: 1 })),
		agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), goalId: Type.Optional(Type.String({ minLength: 1 })),
		planId: Type.Optional(Type.String({ minLength: 1 })), stageId: Type.Optional(Type.String({ minLength: 1 })),
		taskId: Type.Optional(Type.String({ minLength: 1 })), dispatchId: Type.Optional(Type.String({ minLength: 1 })), operationId: Type.Optional(Type.String({ minLength: 1 })),
		attemptId: Type.Optional(Type.String({ minLength: 1 })), attemptReceiptId: Type.Optional(Type.String({ minLength: 1 })),
		taskResultId: Type.Optional(Type.String({ minLength: 1 })), runReceiptId: Type.Optional(Type.String({ minLength: 1 })),
		runId: Type.Optional(Type.String({ minLength: 1 })), providerId: Type.Optional(Type.String({ minLength: 1 })), toolCallId: Type.Optional(Type.String({ minLength: 1 })), turnId: Type.Optional(Type.String({ minLength: 1 })),
		stepId: Type.Optional(Type.String({ minLength: 1 })), parentId: Type.Optional(Type.String({ minLength: 1 })),
		ancestorIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), revision: Type.Integer({ minimum: 0 }),
		fencingToken: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const FingerprintSchema = Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const LineageSchema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.String({ minLength: 1 }), entityId: Type.String({ minLength: 1 }), parentId: Type.Optional(Type.String({ minLength: 1 })), ancestorIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), depth: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });

/** Recursive JSON values are the only unstructured values allowed at a public boundary. */
export const FoundationJsonValueSchema = Type.Cyclic(
	{
		FoundationJsonValueV1: Type.Union([
			Type.Null(),
			Type.String(),
			Type.Boolean(),
			Type.Number(),
			Type.Array(Type.Ref("FoundationJsonValueV1")),
			Type.Record(Type.String(), Type.Ref("FoundationJsonValueV1")),
		]),
	},
	"FoundationJsonValueV1",
);

export interface FoundationEnvelope<TType extends string = string, TPayload extends FoundationJsonValue = FoundationJsonValue> {
	schemaVersion: 1;
	type: TType;
	id: string;
	sequence: number;
	timestamp: string;
	correlation: ExecutionCorrelation;
	payload: TPayload;
}

export const FoundationEnvelopeSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }), timestamp: Type.String({ minLength: 1 }), correlation: ExecutionCorrelationSchema, payload: FoundationJsonValueSchema },
	{ additionalProperties: false },
);

export function foundationEnvelopeSchema<TPayloadSchema extends TSchema>(payloadSchema: TPayloadSchema): TSchema {
	return Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }), timestamp: Type.String({ minLength: 1 }), correlation: ExecutionCorrelationSchema, payload: payloadSchema }, { additionalProperties: false });
}

export function createFoundationEnvelope<TType extends string, TPayload extends FoundationJsonValue>(type: TType, id: string, correlation: ExecutionCorrelation, payload: TPayload, options: { sequence?: number; timestamp?: string } = {}): FoundationEnvelope<TType, TPayload> {
	canonicalFoundationJson(payload);
	return { schemaVersion: 1, type, id, sequence: options.sequence ?? 0, timestamp: options.timestamp ?? new Date().toISOString(), correlation, payload };
}

export type ExactShapeIssue = { path: string; message: string };

export function exactShapeIssues(schema: TSchema, value: unknown, limit = 5): ExactShapeIssue[] {
	return Array.from(Errors(schema, value)).slice(0, limit).map((error: { instancePath: string; message: string }) => ({ path: error.instancePath, message: error.message }));
}

export function validateExactShape<TShape>(schema: TSchema, value: unknown, kind: string, failureCode: FoundationErrorCode = "foundation_schema_invalid_shape"): ResultValue<TShape, FoundationError> {
	if (Check(schema, value)) return Result.ok(value as TShape);
	return Result.err(new FoundationError(failureCode, `${kind} failed exact-shape validation`, { details: { kind, issues: exactShapeIssues(schema, value) } }));
}

export function makeExactShapeGuard<TShape>(schema: TSchema, _kind: string): (value: unknown) => value is TShape {
	return (value: unknown): value is TShape => Check(schema, value);
}

export function requireExactShape<TShape>(schema: TSchema, value: unknown, kind: string, failureCode: FoundationErrorCode = "foundation_schema_invalid_shape"): TShape {
	const result = validateExactShape<TShape>(schema, value, kind, failureCode);
	if (!result.ok) throw result.error;
	return result.value;
}

export function serializeExactShape<TShape>(schema: TSchema, value: TShape, kind: string): string {
	const checked = requireExactShape(schema, value, kind);
	return canonicalFoundationJson(checked);
}

export function parseExactShape<TShape>(schema: TSchema, text: string, kind: string): ResultValue<TShape, FoundationError> {
	try {
		return validateExactShape<TShape>(schema, JSON.parse(text) as unknown, kind);
	} catch (error) {
		return Result.err(new FoundationError("foundation_schema_unknown_record", `${kind} is not valid JSON`, { cause: error }));
	}
}

export function validateFoundationEnvelope(value: unknown): ResultValue<FoundationEnvelope<string, FoundationJsonValue>, FoundationError> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const payload = (value as Record<string, unknown>).payload;
		if (payload !== undefined) {
			try { canonicalFoundationJson(payload); } catch { return Result.err(new FoundationError("foundation_schema_invalid_shape", "foundation_envelope payload must be finite, acyclic JSON")); }
		}
	}
	const checked = validateExactShape<FoundationEnvelope<string, FoundationJsonValue>>(FoundationEnvelopeSchema, value, "foundation_envelope");
	if (!checked.ok) return checked;
	return checked;
}
export function serializeFoundationEnvelope(value: FoundationEnvelope): string {
	const checked = validateFoundationEnvelope(value);
	if (!checked.ok) throw checked.error;
	return canonicalFoundationJson(checked.value);
}
export function parseFoundationEnvelope(text: string): ResultValue<FoundationEnvelope, FoundationError> { return parseExactShape(FoundationEnvelopeSchema, text, "foundation_envelope"); }

export function validateExecutionCorrelation(value: unknown): ResultValue<ExecutionCorrelation, FoundationError> {
	return validateExactShape<ExecutionCorrelation>(ExecutionCorrelationSchema, value, "execution_correlation");
}
export function serializeExecutionCorrelation(value: ExecutionCorrelation): string { return serializeExactShape(ExecutionCorrelationSchema, value, "execution_correlation"); }
export function parseExecutionCorrelation(text: string): ResultValue<ExecutionCorrelation, FoundationError> { return parseExactShape(ExecutionCorrelationSchema, text, "execution_correlation"); }
export function validateFingerprint(value: unknown): ResultValue<Fingerprint, FoundationError> { return validateExactShape<Fingerprint>(FingerprintSchema, value, "fingerprint"); }
export function serializeFingerprint(value: Fingerprint): string { return serializeExactShape(FingerprintSchema, value, "fingerprint"); }
export function parseFingerprint(text: string): ResultValue<Fingerprint, FoundationError> { return parseExactShape(FingerprintSchema, text, "fingerprint"); }
export function validateLineage(value: unknown): ResultValue<FoundationLineage, FoundationError> { return validateExactShape<FoundationLineage>(LineageSchema, value, "lineage"); }
export function serializeLineage(value: FoundationLineage): string { return serializeExactShape(LineageSchema, value, "lineage"); }
export function parseLineage(text: string): ResultValue<FoundationLineage, FoundationError> { return parseExactShape(LineageSchema, text, "lineage"); }
