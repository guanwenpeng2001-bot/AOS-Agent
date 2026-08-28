import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES = Object.freeze(["fake-connector"] as const);
export type PackagedExternalAgentDriverName = (typeof PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES)[number];
export type PackagedExternalAgentDriverOperationKind = "start" | "tool" | "resume" | "cancel";

export interface PackagedExternalAgentDriverOperation {
	readonly sequence: number;
	readonly kind: PackagedExternalAgentDriverOperationKind;
	readonly input: string;
	readonly output: string;
}

/** Non-secret deterministic fixture shipped for package and binary verification. */
export interface PackagedExternalAgentDriver {
	readonly schemaVersion: 1;
	readonly fixtureId: "line13-fake-connector";
	readonly providerId: "line13.fake-connector";
	readonly fauxProviderId: "line13.faux-provider";
	readonly defaultEnabled: false;
	readonly credentialMode: "none";
	readonly networkMode: "disabled";
	readonly operations: readonly PackagedExternalAgentDriverOperation[];
}

export type PackagedExternalAgentDriverAssetErrorCode =
	| "external_agent_driver_asset_missing"
	| "external_agent_driver_asset_invalid";

export class PackagedExternalAgentDriverAssetError extends Error {
	readonly code: PackagedExternalAgentDriverAssetErrorCode;

	constructor(code: PackagedExternalAgentDriverAssetErrorCode, message: string) {
		super(message);
		this.name = "PackagedExternalAgentDriverAssetError";
		this.code = code;
	}
}

const EXACT_DRIVER_KEYS = new Set([
	"schemaVersion",
	"fixtureId",
	"providerId",
	"fauxProviderId",
	"defaultEnabled",
	"credentialMode",
	"networkMode",
	"operations",
]);
const EXACT_OPERATION_KEYS = new Set(["sequence", "kind", "input", "output"]);
const OPERATION_KINDS: ReadonlySet<string> = new Set(["start", "tool", "resume", "cancel"]);
const COMPILED_BUN_URL_MARKERS = Object.freeze(["$bunfs", "~BUN", "%7EBUN"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.size && ownKeys.every((key) => typeof key === "string" && keys.has(key));
}

function isOperation(value: unknown, sequence: number): value is PackagedExternalAgentDriverOperation {
	return isRecord(value) &&
		hasExactKeys(value, EXACT_OPERATION_KEYS) &&
		value.sequence === sequence &&
		typeof value.kind === "string" &&
		OPERATION_KINDS.has(value.kind) &&
		typeof value.input === "string" &&
		value.input.length > 0 &&
		typeof value.output === "string" &&
		value.output.length > 0;
}

function parseDriver(value: unknown): PackagedExternalAgentDriver {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, EXACT_DRIVER_KEYS) ||
		value.schemaVersion !== 1 ||
		value.fixtureId !== "line13-fake-connector" ||
		value.providerId !== "line13.fake-connector" ||
		value.fauxProviderId !== "line13.faux-provider" ||
		value.defaultEnabled !== false ||
		value.credentialMode !== "none" ||
		value.networkMode !== "disabled" ||
		!Array.isArray(value.operations) ||
		value.operations.length !== 4 ||
		!value.operations.every((operation, index) => isOperation(operation, index + 1)) ||
		value.operations.map((operation) => operation.kind).join(",") !== "start,tool,resume,cancel"
	) {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_invalid",
			"The packaged External Agent driver fixture is invalid.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		fixtureId: value.fixtureId,
		providerId: value.providerId,
		fauxProviderId: value.fauxProviderId,
		defaultEnabled: false,
		credentialMode: "none",
		networkMode: "disabled",
		operations: Object.freeze(value.operations.map((operation) => Object.freeze({ ...operation }))),
	});
}

function packagedAssetDirectory(): string {
	const compiled = COMPILED_BUN_URL_MARKERS.some((marker) => import.meta.url.includes(marker));
	return compiled
		? join(dirname(process.execPath), "external-connector-assets")
		: join(dirname(fileURLToPath(import.meta.url)), "external-connector-assets");
}

/** Load an allowlisted packaged fixture without enabling a production Connector. */
export function loadPackagedExternalAgentDriver(name: string): PackagedExternalAgentDriver {
	if (name !== "fake-connector") {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_missing",
			"The requested packaged External Agent driver fixture is unavailable.",
		);
	}
	let serialized: string;
	try {
		serialized = readFileSync(join(packagedAssetDirectory(), "fake-connector.json"), "utf8");
	} catch {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_missing",
			"The requested packaged External Agent driver fixture is unavailable.",
		);
	}
	try {
		return parseDriver(JSON.parse(serialized));
	} catch (error) {
		if (error instanceof PackagedExternalAgentDriverAssetError) throw error;
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_invalid",
			"The packaged External Agent driver fixture is invalid.",
		);
	}
}

export interface PackagedExternalAgentDriverTrace {
	readonly schemaVersion: 1;
	readonly fixtureId: "line13-fake-connector";
	readonly providerId: "line13.fake-connector";
	readonly fauxProviderId: "line13.faux-provider";
	readonly defaultEnabled: false;
	readonly credentialMode: "none";
	readonly networkMode: "disabled";
	readonly events: readonly PackagedExternalAgentDriverOperation[];
}

/** Exercise the same deterministic start/tool/resume/cancel trace in every packaged runtime. */
export function runPackagedExternalAgentDriverFixture(): PackagedExternalAgentDriverTrace {
	const fixture = loadPackagedExternalAgentDriver("fake-connector");
	return Object.freeze({
		schemaVersion: 1,
		fixtureId: fixture.fixtureId,
		providerId: fixture.providerId,
		fauxProviderId: fixture.fauxProviderId,
		defaultEnabled: fixture.defaultEnabled,
		credentialMode: fixture.credentialMode,
		networkMode: fixture.networkMode,
		events: fixture.operations,
	});
}
