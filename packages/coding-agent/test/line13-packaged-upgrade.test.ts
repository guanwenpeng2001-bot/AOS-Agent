import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPackagedLine13UpgradeMigration } from "../src/core/line13-packaged-upgrade.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

async function createPreviousOwnerState(root: string): Promise<void> {
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
	new ProjectTrustStore(agentDir).set(cwd, true);
	writeFileSync(join(root, "publication.json"), `${JSON.stringify({
		schemaVersion: 1,
		packageVersion: "0.84.2",
		sessionFile: `sessions/${basename(session.getSessionFile()!)}`,
		cwd: "workspace",
		agentDir: "agent",
		auth: "not_configured",
		identity: "anonymous",
		connector: "disabled",
	})}\n`, "utf8");
}

it("invokes the candidate durable-state adapter and repeats migration idempotently", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-"));
	cleanups.push(root);
	await createPreviousOwnerState(root);
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "before_publish" }))
		.rejects.toThrow("injected_before_publish");
	rmSync(join(root, "publication.json.next"), { force: true });
	const migrated = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	const repeated = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	expect(migrated.entrypoint).toBe("aos-agent/external-connector");
	expect(migrated.adapter).toBe("packaged_durable_state_migration");
	expect(migrated.owners).toEqual(["session", "settings", "trust", "auth", "identity", "connector"]);
	expect(repeated.stateDigest).toBe(migrated.stateDigest);
});

it("publishes a complete candidate state before the after-publish interruption", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-packaged-upgrade-after-"));
	cleanups.push(root);
	await createPreviousOwnerState(root);
	await expect(runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "after_publish" }))
		.rejects.toThrow("injected_after_publish");
	const restarted = await runPackagedLine13UpgradeMigration({ stateDirectory: root, fault: "none" });
	expect(restarted.recoveredSchemaVersion).toBe(2);
	expect(restarted.finalSchemaVersion).toBe(2);
});
