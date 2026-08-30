import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildExternalConnectorTargetConfig,
	type ExternalConnectorTargetDefinition,
} from "../../src/external-connector.ts";
import {
	createPackagedExternalConnectorRegistryFactory,
} from "../../src/core/connector/packaged-runtime.ts";
import {
	externalConnectorMinimalEnvironment,
	resolveProductionExternalConnectorDriverProvenance,
} from "../../src/core/connector/process-controller.ts";

const FIXTURE_PATH = join(import.meta.dirname, "../fixtures/external-connector-jsonl-driver.mjs");
const PROVIDER_ID = "fixture.external-jsonl-provenance";

function identity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function definition(overrides: Partial<ExternalConnectorTargetDefinition> = {}): ExternalConnectorTargetDefinition {
	return {
		schemaVersion: 1,
		targetId: "fixture-external-jsonl-provenance-target",
		providerId: PROVIDER_ID,
		executablePath: process.execPath,
		modulePath: FIXTURE_PATH,
		cwd: process.cwd(),
		version: "1",
		executableIdentity: identity(process.execPath),
		moduleIdentity: identity(FIXTURE_PATH),
		capabilityCeiling: {
			modelAccess: ["none"],
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		},
		...overrides,
	};
}

function target(overrides: Partial<ExternalConnectorTargetDefinition> = {}) {
	const value = definition(overrides);
	const config = buildExternalConnectorTargetConfig({
		managed: { schemaVersion: 1, targets: [value] },
		explicitTargetId: value.targetId,
	});
	if (config.selectedTarget === undefined) throw new Error("Expected a selected target");
	return config.selectedTarget;
}

describe("generic External Connector provenance", () => {
	it("freezes realpath, identities, cwd, shell, and minimal environment before launch", () => {
		const resolved = resolveProductionExternalConnectorDriverProvenance({
			executablePath: process.execPath,
			arguments: [FIXTURE_PATH],
			trustedProvenance: {
				modulePath: FIXTURE_PATH,
				cwd: process.cwd(),
				version: "1",
				executableIdentity: identity(process.execPath),
				moduleIdentity: identity(FIXTURE_PATH),
			},
		});
		expect(resolved).toMatchObject({
			executablePath: process.execPath,
			modulePath: FIXTURE_PATH,
			cwd: process.cwd(),
			version: "1",
			shell: false,
			executableIdentity: identity(process.execPath),
			moduleIdentity: identity(FIXTURE_PATH),
		});
		expect(resolved?.environmentKeys).toEqual(
			Object.keys(externalConnectorMinimalEnvironment(process.platform)).sort(),
		);
	});

	it("rejects a wrong module digest before the supervised process can launch", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-jsonl-provenance-digest-"));
		try {
			const selected = target({ moduleIdentity: `sha256:${"0".repeat(64)}` });
			await expect(
				createPackagedExternalConnectorRegistryFactory({ target: selected, agentDir: root }),
			).rejects.toThrow("trusted driver file identity does not match");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects relative paths and missing or empty versions during settings parsing", () => {
		expect(() => buildExternalConnectorTargetConfig({
			managed: { schemaVersion: 1, targets: [definition({ modulePath: "relative-driver.mjs" })] },
			explicitTargetId: definition().targetId,
		})).toThrow(/absolute path/u);
		expect(() => buildExternalConnectorTargetConfig({
			managed: { schemaVersion: 1, targets: [definition({ version: undefined as unknown as string })] },
			explicitTargetId: definition().targetId,
		})).toThrow(/version is invalid/u);
		expect(() => buildExternalConnectorTargetConfig({
			managed: { schemaVersion: 1, targets: [definition({ version: "" })] },
			explicitTargetId: definition().targetId,
		})).toThrow(/version is invalid/u);
	});
});
