import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { ProjectTrustStore } from "./trust-manager.ts";

export type Line13UpgradeFault = "none" | "before_publish" | "after_publish";

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
	readonly owners: readonly ["session", "settings", "trust", "auth", "identity", "connector"];
	readonly stateDigest: `sha256:${string}`;
}

interface PreviousPublication {
	readonly schemaVersion: 1;
	readonly packageVersion: string;
	readonly sessionFile: string;
	readonly cwd: "workspace";
	readonly agentDir: "agent";
	readonly auth: "not_configured";
	readonly identity: "anonymous";
	readonly connector: "disabled";
}

function digest(value: unknown): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function readPreviousPublication(path: string): PreviousPublication {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Previous packaged publication is invalid");
	}
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== 1 ||
		typeof record.packageVersion !== "string" ||
		typeof record.sessionFile !== "string" ||
		!/^sessions\/[A-Za-z0-9._-]+\.jsonl$/u.test(record.sessionFile) ||
		record.cwd !== "workspace" ||
		record.agentDir !== "agent" ||
		record.auth !== "not_configured" ||
		record.identity !== "anonymous" ||
		record.connector !== "disabled"
	) throw new Error("Previous packaged publication is invalid");
	return record as unknown as PreviousPublication;
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
		const migration = (current as Record<string, unknown>).migration;
		if (
			typeof migration !== "object" ||
			migration === null ||
			Array.isArray(migration) ||
			(migration as Record<string, unknown>).complete !== true
		) throw new Error("Candidate packaged publication is incomplete");
		return Object.freeze({
			schemaVersion: 1,
			entrypoint: "aos-agent/external-connector",
			adapter: "packaged_durable_state_migration",
			recoveredSchemaVersion: 2,
			finalSchemaVersion: 2,
			owners: Object.freeze(["session", "settings", "trust", "auth", "identity", "connector"] as const),
			stateDigest: digest(current),
		});
	}
	const previous = readPreviousPublication(publicationPath);
	const cwd = join(options.stateDirectory, previous.cwd);
	const agentDir = join(options.stateDirectory, previous.agentDir);
	const session = SessionManager.open(join(options.stateDirectory, previous.sessionFile), undefined, cwd);
	const settings = SettingsManager.create(cwd, agentDir);
	const trust = new ProjectTrustStore(agentDir);
	const migrated = {
		schemaVersion: 2,
		packageVersion: previous.packageVersion,
		owners: {
			session: {
				id: session.getSessionId(),
				entries: session.getEntries().length,
			},
			settings: {
				defaultProvider: settings.getDefaultProvider(),
				steeringMode: settings.getSteeringMode(),
			},
			trust: trust.get(cwd),
			auth: previous.auth,
			identity: previous.identity,
			connector: previous.connector,
		},
		migration: { fromSchemaVersion: 1, complete: true },
	};
	await settings.flush();
	writeFileSync(temporaryPath, `${JSON.stringify(migrated, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (options.fault === "before_publish") throw new Error("injected_before_publish");
	renameSync(temporaryPath, publicationPath);
	if (options.fault === "after_publish") throw new Error("injected_after_publish");
	const recovered: unknown = JSON.parse(readFileSync(publicationPath, "utf8"));
	if (typeof recovered !== "object" || recovered === null || Array.isArray(recovered)) {
		throw new Error("Candidate packaged publication is invalid");
	}
	const recoveredSchemaVersion = (recovered as Record<string, unknown>).schemaVersion;
	if (recoveredSchemaVersion !== 2) throw new Error("Candidate packaged migration did not publish schema 2");
	if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
	return Object.freeze({
		schemaVersion: 1,
		entrypoint: "aos-agent/external-connector",
		adapter: "packaged_durable_state_migration",
		recoveredSchemaVersion: 2,
		finalSchemaVersion: 2,
		owners: Object.freeze(["session", "settings", "trust", "auth", "identity", "connector"] as const),
		stateDigest: digest(recovered),
	});
}
