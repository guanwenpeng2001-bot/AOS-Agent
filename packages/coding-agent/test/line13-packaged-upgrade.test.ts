import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPackagedLine13UpgradeMigration } from "../src/core/line13-packaged-upgrade.ts";
import {
	LINE13_AUTH_SECRET_MARKER,
	createLine13PreviousOwnerPublication,
} from "./fixtures/line13-upgrade/owner-state.ts";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJsonFile(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

function publicationPath(root: string): string {
	return join(root, "publication.json");
}

it("migrates real sanitized owner state and repeats migration idempotently", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-"));
	cleanups.push(root);
	const previous = await createLine13PreviousOwnerPublication(root);
	const beforeFaultState = readJsonFile(publicationPath(root));
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "before_publish" }))
		.rejects.toThrow("injected_before_publish");
	expect(readJsonFile(publicationPath(root))).toEqual(beforeFaultState);
	rmSync(join(root, "publication.json.next"), { force: true });

	const migrated = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	const published = readJsonFile(publicationPath(root));
	const repeated = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	expect(migrated.entrypoint).toBe("aos-agent/external-connector");
	expect(migrated.adapter).toBe("packaged_durable_state_migration");
	expect(migrated.owners).toEqual(["session", "settings", "trust", "auth", "identity", "connector_config"]);
	expect(published).toMatchObject({
		schemaVersion: 2,
		packageVersion: previous.packageVersion,
		owners: previous.owners,
		migration: { fromSchemaVersion: 1, complete: true },
	});
	const serialized = JSON.stringify(published);
	expect(serialized).not.toContain(LINE13_AUTH_SECRET_MARKER);
	expect(serialized).not.toContain(JSON.stringify(root).slice(1, -1));
	expect(serialized).not.toContain("executablePath");
	expect(serialized).not.toContain("modulePath");
	expect(serialized).not.toContain("accountReference");
	expect(serialized).not.toContain("accountId");
	expect(repeated.stateDigest).toBe(migrated.stateDigest);
});

it("publishes complete candidate state before an after-publish interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-after-"));
	cleanups.push(root);
	const previous = await createLine13PreviousOwnerPublication(root);
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "after_publish" }))
		.rejects.toThrow("injected_after_publish");
	expect(readJsonFile(publicationPath(root))).toMatchObject({
		schemaVersion: 2,
		owners: previous.owners,
		migration: { fromSchemaVersion: 1, complete: true },
	});
	const restarted = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	const repeated = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	expect(restarted.recoveredSchemaVersion).toBe(2);
	expect(restarted.finalSchemaVersion).toBe(2);
	expect(restarted.stateDigest).toBe(repeated.stateDigest);
});

it("rejects legacy placeholder owners", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-placeholder-"));
	cleanups.push(root);
	writeJsonFile(publicationPath(root), {
		schemaVersion: 1,
		packageVersion: "0.84.2",
		sessionFile: "sessions/line13-upgrade.jsonl",
		cwd: "workspace",
		agentDir: "agent",
		auth: "not_configured",
		identity: "anonymous",
		connector: "disabled",
	});
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" }))
		.rejects.toThrow("Previous packaged publication is invalid");
});

it("rejects publications without a complete owner snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-missing-owner-"));
	cleanups.push(root);
	const previous = await createLine13PreviousOwnerPublication(root);
	const owners: Record<string, unknown> = { ...previous.owners };
	delete owners.auth;
	writeJsonFile(publicationPath(root), { ...previous, owners });
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" }))
		.rejects.toThrow("Previous packaged publication is invalid");
});

it("rejects restarted candidate publications without a complete owner snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-missing-candidate-owner-"));
	cleanups.push(root);
	writeJsonFile(publicationPath(root), {
		schemaVersion: 2,
		packageVersion: "0.84.2",
		migration: { fromSchemaVersion: 1, complete: true },
	});
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" }))
		.rejects.toThrow("Candidate packaged publication is incomplete");
});

it("rejects missing persistent owner state", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-missing-state-"));
	cleanups.push(root);
	await createLine13PreviousOwnerPublication(root);
	rmSync(join(root, "agent", "auth.json"), { force: true });
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" }))
		.rejects.toThrow("Previous packaged owner auth is missing");
});
