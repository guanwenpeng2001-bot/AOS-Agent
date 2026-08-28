import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "./auth-storage.ts";
import {
	CapabilityPublicIdentity,
	getCapabilityPublicIdentityPath,
} from "./capability-public-identity.ts";
import { buildExternalConnectorTargetConfig } from "./external-connector-target-config.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { ProjectTrustStore } from "./trust-manager.ts";

export type Line13UpgradeFault = "none" | "before_publish" | "after_publish";

const LINE13_PACKAGED_UPGRADE_OWNERS = Object.freeze([
	"session",
	"settings",
	"trust",
	"auth",
	"identity",
	"connector_config",
] as const);

const LINE13_CONNECTOR_TARGET_ID = "line13-upgrade-target";
const LINE13_CONNECTOR_PROVIDER_ID = "line13.fake-connector";
const LINE13_OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const LINE13_SESSION_FILE_PATTERN = /^sessions\/[A-Za-z0-9._-]+\.jsonl$/u;
const LINE13_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const LINE13_IDENTITY_DOMAIN = "line13-upgrade-owner";
const LINE13_IDENTITY_INPUT = "installation";

type Line13PackagedUpgradeOwners = typeof LINE13_PACKAGED_UPGRADE_OWNERS;
type Line13AuthProviderType = "api_key" | "oauth";
type Line13ConnectorSource = "managed" | "global";
type Line13ConnectorSelectionSource = "explicit" | "project" | "role";
type Line13ConnectorModelAccess = "none" | "agent_owned" | "aos_gateway";

export interface Line13PackagedUpgradeOptions {
	readonly stateDirectory: string;
	readonly fault: Line13UpgradeFault;
}

export interface Line13PackagedUpgradeResult {
	readonly schemaVersion: 1;
	readonly entrypoint: "aos-agent/external-connector";
	readonly adapter: "packaged_durable_state_migration";
	readonly recoveredSchemaVersion: 1 | 2;
	readonly finalSchemaVersion: 2;
	readonly owners: Line13PackagedUpgradeOwners;
	readonly stateDigest: `sha256:${string}`;
}

interface Line13SessionOwnerState {
	readonly id: string;
	readonly entries: number;
}

interface Line13SettingsOwnerState {
	readonly defaultProvider: string;
	readonly steeringMode: "all" | "one-at-a-time";
}

interface Line13AuthOwnerState {
	readonly providers: readonly Line13AuthProviderState[];
}

interface Line13AuthProviderState {
	readonly providerId: string;
	readonly type: Line13AuthProviderType;
}

interface Line13TrustOwnerState {
	readonly decision: boolean | null;
}

interface Line13IdentityOwnerState {
	readonly installationIdDigest: `sha256:${string}`;
}

interface Line13ConnectorCapabilityState {
	readonly modelAccess: readonly Line13ConnectorModelAccess[];
	readonly resume: boolean;
	readonly toolGateway: boolean;
	readonly artifacts: boolean;
	readonly images: boolean;
}

interface Line13ConnectorConfigOwnerState {
	readonly schemaVersion: 1;
	readonly targetCount: number;
	readonly selectedTargetId: string;
	readonly providerId: string;
	readonly source: Line13ConnectorSource;
	readonly configRevision: `sha256:${string}`;
	readonly selectionRevision: `sha256:${string}`;
	readonly capabilityCeiling: Line13ConnectorCapabilityState;
	readonly selectionSources: readonly Line13ConnectorSelectionSource[];
}

interface Line13PackagedOwnerState {
	readonly session: Line13SessionOwnerState;
	readonly settings: Line13SettingsOwnerState;
	readonly trust: Line13TrustOwnerState;
	readonly auth: Line13AuthOwnerState;
	readonly identity: Line13IdentityOwnerState;
	readonly connectorConfig: Line13ConnectorConfigOwnerState;
}

interface PreviousPublication {
	readonly schemaVersion: 1;
	readonly packageVersion: string;
	readonly sessionFile: string;
	readonly cwd: "workspace";
	readonly agentDir: "agent";
	readonly owners: Line13PackagedOwnerState;
}

interface CandidatePublication {
	readonly schemaVersion: 2;
	readonly packageVersion: string;
	readonly owners: Line13PackagedOwnerState;
	readonly migration: {
		readonly fromSchemaVersion: 1;
		readonly complete: true;
	};
}

function digest(value: unknown): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requireRecord(value: unknown, errorMessage: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(errorMessage);
	return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], errorMessage: string): void {
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) throw new Error(errorMessage);
	}
	const allowed = new Set(keys);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(errorMessage);
	}
}

function requireIdentifier(value: unknown, errorMessage: string): string {
	if (typeof value !== "string" || !LINE13_OWNER_ID_PATTERN.test(value)) throw new Error(errorMessage);
	return value;
}

function requireString(value: unknown, errorMessage: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(errorMessage);
	return value;
}

function requireSha256(value: unknown, errorMessage: string): `sha256:${string}` {
	if (typeof value !== "string" || !LINE13_SHA256_PATTERN.test(value)) throw new Error(errorMessage);
	return value as `sha256:${string}`;
}

function requireInteger(value: unknown, errorMessage: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(errorMessage);
	return value;
}

function requireBoolean(value: unknown, errorMessage: string): boolean {
	if (typeof value !== "boolean") throw new Error(errorMessage);
	return value;
}

function requireChoice<T extends string>(value: unknown, choices: readonly T[], errorMessage: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(errorMessage);
	return value as T;
}

function readSessionOwner(value: unknown, errorMessage: string): Line13SessionOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["id", "entries"], errorMessage);
	return Object.freeze({
		id: requireIdentifier(record.id, errorMessage),
		entries: requireInteger(record.entries, errorMessage),
	});
}

function readSettingsOwner(value: unknown, errorMessage: string): Line13SettingsOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["defaultProvider", "steeringMode"], errorMessage);
	return Object.freeze({
		defaultProvider: requireIdentifier(record.defaultProvider, errorMessage),
		steeringMode: requireChoice(record.steeringMode, ["all", "one-at-a-time"] as const, errorMessage),
	});
}

function readTrustOwner(value: unknown, errorMessage: string): Line13TrustOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["decision"], errorMessage);
	if (record.decision !== true && record.decision !== false && record.decision !== null) throw new Error(errorMessage);
	return Object.freeze({ decision: record.decision });
}

function readAuthOwner(value: unknown, errorMessage: string): Line13AuthOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["providers"], errorMessage);
	if (!Array.isArray(record.providers) || record.providers.length === 0 || record.providers.length > 128) {
		throw new Error(errorMessage);
	}
	const providers = record.providers.map((provider) => {
		const providerRecord = requireRecord(provider, errorMessage);
		requireExactKeys(providerRecord, ["providerId", "type"], errorMessage);
		return Object.freeze({
			providerId: requireIdentifier(providerRecord.providerId, errorMessage),
			type: requireChoice(providerRecord.type, ["api_key", "oauth"] as const, errorMessage),
		});
	});
	providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
	return Object.freeze({ providers: Object.freeze(providers) });
}

function readIdentityOwner(value: unknown, errorMessage: string): Line13IdentityOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["installationIdDigest"], errorMessage);
	return Object.freeze({ installationIdDigest: requireSha256(record.installationIdDigest, errorMessage) });
}

function readCapabilityOwner(value: unknown, errorMessage: string): Line13ConnectorCapabilityState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["modelAccess", "resume", "toolGateway", "artifacts", "images"], errorMessage);
	if (!Array.isArray(record.modelAccess) || record.modelAccess.length === 0 || record.modelAccess.length > 3) {
		throw new Error(errorMessage);
	}
	const modelAccess = record.modelAccess.map((entry) =>
		requireChoice(entry, ["none", "agent_owned", "aos_gateway"] as const, errorMessage),
	);
	if (new Set(modelAccess).size !== modelAccess.length) throw new Error(errorMessage);
	return Object.freeze({
		modelAccess: Object.freeze(modelAccess),
		resume: requireBoolean(record.resume, errorMessage),
		toolGateway: requireBoolean(record.toolGateway, errorMessage),
		artifacts: requireBoolean(record.artifacts, errorMessage),
		images: requireBoolean(record.images, errorMessage),
	});
}

function readConnectorConfigOwner(value: unknown, errorMessage: string): Line13ConnectorConfigOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, [
		"schemaVersion",
		"targetCount",
		"selectedTargetId",
		"providerId",
		"source",
		"configRevision",
		"selectionRevision",
		"capabilityCeiling",
		"selectionSources",
	], errorMessage);
	if (record.schemaVersion !== 1) throw new Error(errorMessage);
	if (!Array.isArray(record.selectionSources) || record.selectionSources.length === 0 || record.selectionSources.length > 3) {
		throw new Error(errorMessage);
	}
	const selectionSources = record.selectionSources.map((source) =>
		requireChoice(source, ["explicit", "project", "role"] as const, errorMessage),
	);
	if (new Set(selectionSources).size !== selectionSources.length) throw new Error(errorMessage);
	return Object.freeze({
		schemaVersion: 1 as const,
		targetCount: requireInteger(record.targetCount, errorMessage),
		selectedTargetId: requireIdentifier(record.selectedTargetId, errorMessage),
		providerId: requireIdentifier(record.providerId, errorMessage),
		source: requireChoice(record.source, ["managed", "global"] as const, errorMessage),
		configRevision: requireSha256(record.configRevision, errorMessage),
		selectionRevision: requireSha256(record.selectionRevision, errorMessage),
		capabilityCeiling: readCapabilityOwner(record.capabilityCeiling, errorMessage),
		selectionSources: Object.freeze(selectionSources),
	});
}

function readOwners(value: unknown, errorMessage: string): Line13PackagedOwnerState {
	const record = requireRecord(value, errorMessage);
	requireExactKeys(record, ["session", "settings", "trust", "auth", "identity", "connectorConfig"], errorMessage);
	return Object.freeze({
		session: readSessionOwner(record.session, errorMessage),
		settings: readSettingsOwner(record.settings, errorMessage),
		trust: readTrustOwner(record.trust, errorMessage),
		auth: readAuthOwner(record.auth, errorMessage),
		identity: readIdentityOwner(record.identity, errorMessage),
		connectorConfig: readConnectorConfigOwner(record.connectorConfig, errorMessage),
	});
}

function readPreviousPublication(value: unknown): PreviousPublication {
	const record = requireRecord(value, "Previous packaged publication is invalid");
	requireExactKeys(
		record,
		["schemaVersion", "packageVersion", "sessionFile", "cwd", "agentDir", "owners"],
		"Previous packaged publication is invalid",
	);
	const sessionFile = requireString(record.sessionFile, "Previous packaged publication is invalid");
	if (
		record.schemaVersion !== 1 ||
		!LINE13_SESSION_FILE_PATTERN.test(sessionFile) ||
		record.cwd !== "workspace" ||
		record.agentDir !== "agent"
	) throw new Error("Previous packaged publication is invalid");
	return Object.freeze({
		schemaVersion: 1,
		packageVersion: requireString(record.packageVersion, "Previous packaged publication is invalid"),
		sessionFile,
		cwd: "workspace" as const,
		agentDir: "agent" as const,
		owners: readOwners(record.owners, "Previous packaged publication is invalid"),
	});
}

function readCandidatePublication(value: unknown): CandidatePublication {
	const record = requireRecord(value, "Candidate packaged publication is incomplete");
	requireExactKeys(record, ["schemaVersion", "packageVersion", "owners", "migration"], "Candidate packaged publication is incomplete");
	const migration = requireRecord(record.migration, "Candidate packaged publication is incomplete");
	requireExactKeys(migration, ["fromSchemaVersion", "complete"], "Candidate packaged publication is incomplete");
	if (record.schemaVersion !== 2 || migration.fromSchemaVersion !== 1 || migration.complete !== true) {
		throw new Error("Candidate packaged publication is incomplete");
	}
	return Object.freeze({
		schemaVersion: 2,
		packageVersion: requireString(record.packageVersion, "Candidate packaged publication is incomplete"),
		owners: readOwners(record.owners, "Candidate packaged publication is incomplete"),
		migration: Object.freeze({ fromSchemaVersion: 1 as const, complete: true as const }),
	});
}

function createConnectorConfigOwner(cwd: string): Line13ConnectorConfigOwnerState {
	const fileIdentity: `sha256:${string}` = `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`;
	const config = buildExternalConnectorTargetConfig({
		managed: {
			schemaVersion: 1,
			targets: [
				{
					schemaVersion: 1,
					targetId: LINE13_CONNECTOR_TARGET_ID,
					providerId: LINE13_CONNECTOR_PROVIDER_ID,
					executablePath: process.execPath,
					modulePath: process.execPath,
					cwd,
					version: process.version,
					executableIdentity: fileIdentity,
					moduleIdentity: fileIdentity,
					capabilityCeiling: {
						modelAccess: ["none"],
						resume: false,
						toolGateway: false,
						artifacts: false,
						images: false,
					},
				},
			],
		},
		explicitTargetId: LINE13_CONNECTOR_TARGET_ID,
	});
	const selectedTarget = config.selectedTarget;
	if (selectedTarget === undefined) throw new Error("Previous packaged owner connector config is missing");
	return Object.freeze({
		schemaVersion: 1 as const,
		targetCount: config.targets.length,
		selectedTargetId: selectedTarget.targetId,
		providerId: selectedTarget.providerId,
		source: selectedTarget.source,
		configRevision: config.configRevision as `sha256:${string}`,
		selectionRevision: selectedTarget.selectionRevision as `sha256:${string}`,
		capabilityCeiling: Object.freeze({
			modelAccess: Object.freeze([...selectedTarget.capabilityCeiling.modelAccess] as Line13ConnectorModelAccess[]),
			resume: selectedTarget.capabilityCeiling.resume,
			toolGateway: selectedTarget.capabilityCeiling.toolGateway,
			artifacts: selectedTarget.capabilityCeiling.artifacts,
			images: selectedTarget.capabilityCeiling.images,
		}),
		selectionSources: Object.freeze([...selectedTarget.selectionSources] as Line13ConnectorSelectionSource[]),
	});
}

async function readOwnerStateFromApis(
	previous: PreviousPublication,
	stateDirectory: string,
	cwd: string,
	agentDir: string,
): Promise<Line13PackagedOwnerState> {
	const session = SessionManager.open(join(stateDirectory, previous.sessionFile), undefined, cwd);
	const settings = SettingsManager.create(cwd, agentDir);
	const defaultProvider = settings.getDefaultProvider();
	const trust = new ProjectTrustStore(agentDir);
	const authPath = join(agentDir, "auth.json");
	const identityPath = getCapabilityPublicIdentityPath(agentDir);
	if (defaultProvider === undefined) throw new Error("Previous packaged owner settings is missing");
	if (!existsSync(authPath)) throw new Error("Previous packaged owner auth is missing");
	if (!existsSync(identityPath)) throw new Error("Previous packaged owner identity is missing");
	const providers = (await AuthStorage.create(authPath).list()).map((provider) => {
		const type = provider.type;
		if (type !== "api_key" && type !== "oauth") throw new Error("Previous packaged owner auth is invalid");
		return Object.freeze({
			providerId: requireIdentifier(provider.providerId, "Previous packaged owner auth is invalid"),
			type,
		});
	});
	providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
	if (providers.length === 0) throw new Error("Previous packaged owner auth is missing");
	const installationId = CapabilityPublicIdentity.loadSync(agentDir).derive(LINE13_IDENTITY_DOMAIN, LINE13_IDENTITY_INPUT);
	const installationIdDigest: `sha256:${string}` = `sha256:${createHash("sha256").update(installationId).digest("hex")}`;
	return Object.freeze({
		session: Object.freeze({
			id: session.getSessionId(),
			entries: session.getEntries().length,
		}),
		settings: Object.freeze({
			defaultProvider,
			steeringMode: settings.getSteeringMode(),
		}),
		trust: Object.freeze({ decision: trust.get(cwd) }),
		auth: Object.freeze({ providers: Object.freeze(providers) }),
		identity: Object.freeze({
			installationIdDigest,
		}),
		connectorConfig: createConnectorConfigOwner(cwd),
	});
}

function assertOwnerStateMatches(actual: Line13PackagedOwnerState, expected: Line13PackagedOwnerState): void {
	for (const owner of ["session", "settings", "trust", "auth", "identity", "connectorConfig"] as const) {
		if (JSON.stringify(actual[owner]) !== JSON.stringify(expected[owner])) {
			throw new Error(`Previous packaged owner state does not match ${owner}`);
		}
	}
}

function resultFor(recoveredSchemaVersion: 1 | 2, publication: CandidatePublication): Line13PackagedUpgradeResult {
	return Object.freeze({
		schemaVersion: 1 as const,
		entrypoint: "aos-agent/external-connector" as const,
		adapter: "packaged_durable_state_migration" as const,
		recoveredSchemaVersion,
		finalSchemaVersion: 2 as const,
		owners: LINE13_PACKAGED_UPGRADE_OWNERS,
		stateDigest: digest(publication),
	});
}

/** Consume previous-package owner state and atomically publish one candidate view. */
export async function runPackagedLine13UpgradeMigration(
	options: Line13PackagedUpgradeOptions,
): Promise<Line13PackagedUpgradeResult> {
	const publicationPath = join(options.stateDirectory, "publication.json");
	const temporaryPath = `${publicationPath}.next`;
	const current: unknown = JSON.parse(readFileSync(publicationPath, "utf8"));
	if (
		typeof current === "object" &&
		current !== null &&
		!Array.isArray(current) &&
		(current as Record<string, unknown>).schemaVersion === 2
	) {
		return resultFor(2, readCandidatePublication(current));
	}
	const previous = readPreviousPublication(current);
	const cwd = join(options.stateDirectory, previous.cwd);
	const agentDir = join(options.stateDirectory, previous.agentDir);
	const ownerState = await readOwnerStateFromApis(previous, options.stateDirectory, cwd, agentDir);
	assertOwnerStateMatches(ownerState, previous.owners);
	const settings = SettingsManager.create(cwd, agentDir);
	await settings.flush();
	const migrated: CandidatePublication = {
		schemaVersion: 2,
		packageVersion: previous.packageVersion,
		owners: ownerState,
		migration: { fromSchemaVersion: 1, complete: true },
	};
	writeFileSync(temporaryPath, `${JSON.stringify(migrated, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (options.fault === "before_publish") throw new Error("injected_before_publish");
	renameSync(temporaryPath, publicationPath);
	if (options.fault === "after_publish") throw new Error("injected_after_publish");
	const recovered: unknown = JSON.parse(readFileSync(publicationPath, "utf8"));
	const candidate = readCandidatePublication(recovered);
	if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
	return resultFor(2, candidate);
}
