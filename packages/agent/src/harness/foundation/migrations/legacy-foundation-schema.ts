import type { FoundationRecord } from "../../session/durable/types.ts";
import { parseFoundationMutation } from "../../session/durable/codec.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, type Fingerprint } from "../identity.ts";

/** Historical names stay private to the decoder that owns their persisted shape. */
export type LegacyFoundationWrapperKindV1 = "foundation" | "durable";

export interface LegacyFoundationSchemaWrapperV1 {
	readonly kind: LegacyFoundationWrapperKindV1;
	readonly schemaVersion: 1;
	readonly record: unknown;
}

export interface LegacyFoundationSchemaMigrationPlanV1 {
	readonly schemaVersion: 1;
	readonly migrationId: string;
	readonly sourceKind: "foundation.schema.wrapper";
	readonly sourceSchemaVersion: 1;
	readonly targetSchemaVersion: 1;
	readonly sourceFingerprint: Fingerprint;
	readonly resultFingerprint: Fingerprint;
	readonly result: FoundationRecord;
}

export class LegacyFoundationSchemaMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LegacyFoundationSchemaMigrationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeWrapper(value: unknown): LegacyFoundationSchemaWrapperV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["kind", "schemaVersion", "record"])) {
		throw new LegacyFoundationSchemaMigrationError("Historical Foundation wrapper has an invalid exact shape");
	}
	if ((value.kind !== "foundation" && value.kind !== "durable") || value.schemaVersion !== 1) {
		throw new LegacyFoundationSchemaMigrationError("Historical Foundation wrapper has an unsupported kind or schemaVersion");
	}
	return { kind: value.kind, schemaVersion: 1, record: value.record };
}

/**
 * Decode a historical schemaVersion 1 wrapper through the current durable
 * Foundation record decoder. The conversion is deliberately an identity
 * migration for the record itself: current validators remain authoritative.
 */
export function decodeLegacyFoundationSchemaWrapperV1(value: unknown): FoundationRecord {
	const wrapper = decodeWrapper(value);
	let encoded: string;
	try {
		encoded = canonicalFoundationJson({ kind: "foundation", schemaVersion: 1, record: wrapper.record });
	} catch {
		throw new LegacyFoundationSchemaMigrationError("Historical Foundation wrapper is not canonical JSON");
	}
	const decoded = parseFoundationMutation(encoded);
	if (!decoded.ok) {
		throw new LegacyFoundationSchemaMigrationError(`Historical Foundation record is invalid: ${decoded.error.message}`);
	}
	return structuredClone(decoded.value);
}

/** Build a clock-free plan whose identity is stable for one physical record. */
export function planLegacyFoundationSchemaMigrationV1(value: unknown): LegacyFoundationSchemaMigrationPlanV1 {
	const wrapper = decodeWrapper(value);
	const result = decodeLegacyFoundationSchemaWrapperV1(wrapper);
	const identity = {
		schemaVersion: 1,
		kind: result.kind,
		id: result.id,
		lane: result.lane,
		seq: result.seq,
	};
	return {
		schemaVersion: 1,
		migrationId: `legacy-foundation-schema:${fingerprintFoundationValue(identity).value}`,
		sourceKind: "foundation.schema.wrapper",
		sourceSchemaVersion: 1,
		targetSchemaVersion: 1,
		sourceFingerprint: fingerprintFoundationValue(wrapper),
		resultFingerprint: fingerprintFoundationValue(result),
		result,
	};
}
