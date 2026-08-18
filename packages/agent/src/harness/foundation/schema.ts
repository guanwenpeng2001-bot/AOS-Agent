import { type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError, type FoundationErrorCode } from "./errors.ts";
import { FOUNDATION_SCHEMA_VERSION, canonicalFoundationJson, type ExecutionCorrelationV1, type FingerprintV1, type FoundationLineageV1 } from "./identity.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";

export const ExecutionCorrelationV1Schema = Type.Object(
	{
		sessionId: Type.String({ minLength: 1 }),
		laneId: Type.String({ minLength: 1 }),
		roleId: Type.Optional(Type.String({ minLength: 1 })), roleRevisionId: Type.Optional(Type.String({ minLength: 1 })),
		modelProfileId: Type.Optional(Type.String({ minLength: 1 })), modelProfileRevisionId: Type.Optional(Type.String({ minLength: 1 })),
		bindingId: Type.Optional(Type.String({ minLength: 1 })), bindingEpochId: Type.Optional(Type.String({ minLength: 1 })),
		agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), goalId: Type.Optional(Type.String({ minLength: 1 })),
		planId: Type.Optional(Type.String({ minLength: 1 })), stageId: Type.Optional(Type.String({ minLength: 1 })),
		taskId: Type.Optional(Type.String({ minLength: 1 })), dispatchId: Type.Optional(Type.String({ minLength: 1 })),
		attemptId: Type.Optional(Type.String({ minLength: 1 })), attemptReceiptId: Type.Optional(Type.String({ minLength: 1 })),
		taskResultId: Type.Optional(Type.String({ minLength: 1 })), runReceiptId: Type.Optional(Type.String({ minLength: 1 })),
		runId: Type.Optional(Type.String({ minLength: 1 })), turnId: Type.Optional(Type.String({ minLength: 1 })),
		stepId: Type.Optional(Type.String({ minLength: 1 })), parentId: Type.Optional(Type.String({ minLength: 1 })),
		ancestorIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), revision: Type.Integer({ minimum: 0 }),
		fencingToken: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type ExecutionCorrelationV1Shape = ExecutionCorrelationV1;

export const FingerprintV1Schema = Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type FingerprintV1Shape = FingerprintV1;
export const LineageV1Schema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.String({ minLength: 1 }), entityId: Type.String({ minLength: 1 }), parentId: Type.Optional(Type.String({ minLength: 1 })), ancestorIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), depth: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });

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

export interface FoundationEnvelopeV1<TType extends string = string, TPayload extends FoundationJsonValue = FoundationJsonValue> {
	schemaVersion: 1;
	type: TType;
	id: string;
	sequence: number;
	timestamp: string;
	correlation: ExecutionCorrelationV1;
	payload: TPayload;
}
export type FoundationEnvelope<TType extends string = string, TPayload extends FoundationJsonValue = FoundationJsonValue> = FoundationEnvelopeV1<TType, TPayload>;

export const FoundationEnvelopeV1Schema = Type.Object(
	{ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }), timestamp: Type.String({ minLength: 1 }), correlation: ExecutionCorrelationV1Schema, payload: FoundationJsonValueSchema },
	{ additionalProperties: false },
);

export function foundationEnvelopeSchema<TPayloadSchema extends TSchema>(payloadSchema: TPayloadSchema): TSchema {
	return Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }), timestamp: Type.String({ minLength: 1 }), correlation: ExecutionCorrelationV1Schema, payload: payloadSchema }, { additionalProperties: false });
}

export function createFoundationEnvelope<TType extends string, TPayload extends FoundationJsonValue>(type: TType, id: string, correlation: ExecutionCorrelationV1, payload: TPayload, options: { sequence?: number; timestamp?: string } = {}): FoundationEnvelopeV1<TType, TPayload> {
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

export function validateFoundationEnvelope(value: unknown): ResultValue<FoundationEnvelopeV1<string, FoundationJsonValue>, FoundationError> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const payload = (value as Record<string, unknown>).payload;
		if (payload !== undefined) {
			try { canonicalFoundationJson(payload); } catch { return Result.err(new FoundationError("foundation_schema_invalid_shape", "foundation_envelope payload must be finite, acyclic JSON")); }
		}
	}
	const checked = validateExactShape<FoundationEnvelopeV1<string, FoundationJsonValue>>(FoundationEnvelopeV1Schema, value, "foundation_envelope");
	if (!checked.ok) return checked;
	return checked;
}
export function serializeFoundationEnvelopeV1(value: FoundationEnvelopeV1): string {
	const checked = validateFoundationEnvelope(value);
	if (!checked.ok) throw checked.error;
	return canonicalFoundationJson(checked.value);
}
export function parseFoundationEnvelopeV1(text: string): ResultValue<FoundationEnvelopeV1, FoundationError> { return parseExactShape(FoundationEnvelopeV1Schema, text, "foundation_envelope"); }

export const FOUNDATION_SCHEMA_VERSION_V1 = FOUNDATION_SCHEMA_VERSION;

export function validateExecutionCorrelationV1(value: unknown): ResultValue<ExecutionCorrelationV1, FoundationError> {
	return validateExactShape<ExecutionCorrelationV1>(ExecutionCorrelationV1Schema, value, "execution_correlation");
}
export function serializeExecutionCorrelationV1(value: ExecutionCorrelationV1): string { return serializeExactShape(ExecutionCorrelationV1Schema, value, "execution_correlation"); }
export function parseExecutionCorrelationV1(text: string): ResultValue<ExecutionCorrelationV1, FoundationError> { return parseExactShape(ExecutionCorrelationV1Schema, text, "execution_correlation"); }
export function validateFingerprintV1(value: unknown): ResultValue<FingerprintV1, FoundationError> { return validateExactShape<FingerprintV1>(FingerprintV1Schema, value, "fingerprint"); }
export function serializeFingerprintV1(value: FingerprintV1): string { return serializeExactShape(FingerprintV1Schema, value, "fingerprint"); }
export function parseFingerprintV1(text: string): ResultValue<FingerprintV1, FoundationError> { return parseExactShape(FingerprintV1Schema, text, "fingerprint"); }
export function validateLineageV1(value: unknown): ResultValue<FoundationLineageV1, FoundationError> { return validateExactShape<FoundationLineageV1>(LineageV1Schema, value, "lineage"); }
export function serializeLineageV1(value: FoundationLineageV1): string { return serializeExactShape(LineageV1Schema, value, "lineage"); }
export function parseLineageV1(text: string): ResultValue<FoundationLineageV1, FoundationError> { return parseExactShape(LineageV1Schema, text, "lineage"); }
export const validateExecutionCorrelation = validateExecutionCorrelationV1;
export const serializeExecutionCorrelation = serializeExecutionCorrelationV1;
export const parseExecutionCorrelation = parseExecutionCorrelationV1;
export const validateFoundationEnvelopeV1 = validateFoundationEnvelope;
export const serializeFoundationEnvelope = serializeFoundationEnvelopeV1;
export const parseFoundationEnvelope = parseFoundationEnvelopeV1;
