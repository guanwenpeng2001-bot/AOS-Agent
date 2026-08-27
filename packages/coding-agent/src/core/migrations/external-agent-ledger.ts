/** Private decoder vocabulary for historical Adapter-era Session entries. */

export interface LegacyExternalExecutionRefV1 {
	readonly namespace: string;
	readonly externalSessionId: string;
	readonly externalRunId?: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EXECUTION_REF_KEYS = new Set(["namespace", "externalSessionId", "externalRunId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function isIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

export function isLegacyExternalExecutionRefV1(value: unknown): value is LegacyExternalExecutionRefV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, EXECUTION_REF_KEYS) &&
		isIdentifier(value.namespace) &&
		isIdentifier(value.externalSessionId) &&
		(value.externalRunId === undefined || isIdentifier(value.externalRunId))
	);
}
