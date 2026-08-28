import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CapabilityPublicIdentity } from "../../../src/core/capability-public-identity.ts";
import { buildExternalConnectorTargetConfig } from "../../../src/core/external-connector-target-config.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";

export const LINE13_AUTH_PROVIDER_ID = "line13.faux-provider";
export const LINE13_AUTH_SECRET_MARKER = "line13-secret";
export const LINE13_CONNECTOR_TARGET_ID = "line13-upgrade-target";
export const LINE13_CONNECTOR_PROVIDER_ID = "line13.fake-connector";

const LINE13_IDENTITY_DOMAIN = "line13-upgrade-owner";
const LINE13_IDENTITY_INPUT = "installation";

type Line13AuthProviderType = "api_key" | "oauth";
type Line13ConnectorSource = "managed" | "global";
type Line13ConnectorSelectionSource = "explicit" | "project" | "role";
type Line13ConnectorModelAccess = "none" | "agent_owned" | "aos_gateway";

interface Line13AuthProviderState {
	readonly providerId: string;
	readonly type: Line13AuthProviderType;
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

export interface Line13PreviousOwnerPublication {
	readonly schemaVersion: 1;
	readonly packageVersion: string;
	readonly sessionFile: string;
	readonly cwd: "workspace";
	readonly agentDir: "agent";
	readonly owners: {
		readonly session: {
			readonly id: string;
			readonly entries: number;
		};
		readonly settings: {
			readonly defaultProvider: string;
			readonly steeringMode: "all" | "one-at-a-time";
		};
		readonly trust: {
			readonly decision: boolean | null;
		};
		readonly auth: {
			readonly providers: readonly Line13AuthProviderState[];
		};
		readonly identity: {
			readonly installationIdDigest: `sha256:${string}`;
		};
		readonly connectorConfig: Line13ConnectorConfigOwnerState;
	};
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
	if (selectedTarget === undefined) throw new Error("Line 13 connector config did not select a target");
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

export async function createLine13PreviousOwnerPublication(
	root: string,
	packageVersion = "0.84.2",
): Promise<Line13PreviousOwnerPublication> {
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const directory of [cwd, agentDir, sessionDir]) mkdirSync(directory, { recursive: true });

	const session = SessionManager.create(cwd, sessionDir, { id: "line13-upgrade" });
	session.appendCustomEntry("line13.previous", { sanitized: true });
	session.flushPendingSession();

	const settings = SettingsManager.create(cwd, agentDir);
	settings.setDefaultProvider("faux");
	settings.setSteeringMode("one-at-a-time");
	await settings.flush();

	await AuthStorage.create(join(agentDir, "auth.json")).modify(LINE13_AUTH_PROVIDER_ID, async () => ({
		type: "api_key",
		key: LINE13_AUTH_SECRET_MARKER,
	}));
	new ProjectTrustStore(agentDir).set(cwd, true);
	const identity = CapabilityPublicIdentity.loadSync(agentDir);
	const sessionFile = session.getSessionFile();
	const defaultProvider = settings.getDefaultProvider();
	if (sessionFile === undefined) throw new Error("Line 13 fixture did not create a session file");
	if (defaultProvider === undefined) throw new Error("Line 13 fixture did not persist settings");
	const installationIdDigest: `sha256:${string}` = `sha256:${createHash("sha256").update(identity.derive(LINE13_IDENTITY_DOMAIN, LINE13_IDENTITY_INPUT)).digest("hex")}`;

	const publication = Object.freeze({
		schemaVersion: 1 as const,
		packageVersion,
		sessionFile: `sessions/${basename(sessionFile)}`,
		cwd: "workspace" as const,
		agentDir: "agent" as const,
		owners: Object.freeze({
			session: Object.freeze({
				id: session.getSessionId(),
				entries: session.getEntries().length,
			}),
			settings: Object.freeze({
				defaultProvider,
				steeringMode: settings.getSteeringMode(),
			}),
			trust: Object.freeze({ decision: new ProjectTrustStore(agentDir).get(cwd) }),
			auth: Object.freeze({
				providers: Object.freeze([{ providerId: LINE13_AUTH_PROVIDER_ID, type: "api_key" as const }]),
			}),
			identity: Object.freeze({
				installationIdDigest,
			}),
			connectorConfig: createConnectorConfigOwner(cwd),
		}),
	});
	writeFileSync(join(root, "publication.json"), `${JSON.stringify(publication, undefined, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return publication;
}
