import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	dependencyBaselineDigest,
	discoverLine13T0Candidates,
	discoverRealConnectorCandidates,
	LINE13_T0_BASELINE,
	LINE13_T0_BASE_SHA,
	LINE13_T0_DEPENDENCY_BASELINE,
	LINE13_T0_EXPECTED,
	LINE13_T0_PUBLIC_ROOTS,
	line13BaseBlob,
	line13BaseDependencyPaths,
	line13InventoryDigest,
	line13RepoRoot,
	loadLine13T0Inventory,
	type Line13InventoryCategory,
} from "./support/line13-t0-baseline-inventory.ts";

const repoRoot = line13RepoRoot();

function git(...args: readonly string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function sha256BaseBlob(path: string): string {
	return createHash("sha256").update(line13BaseBlob(repoRoot, path)).digest("hex");
}

function packageExportSpecifiers(packagePath: string): string[] {
	const manifest = JSON.parse(new TextDecoder().decode(line13BaseBlob(repoRoot, packagePath))) as { exports: Record<string, unknown> };
	return Object.keys(manifest.exports)
		.filter((specifier) => specifier !== "./package.json")
		.sort((left, right) => left.localeCompare(right));
}

describe("Line 13 T0 baseline and inventories", () => {
	it("freezes the exact common main base and clean-start fact", () => {
		expect(LINE13_T0_BASELINE).toEqual({
			baseSha: LINE13_T0_BASE_SHA,
			baseTreeSha: "f308d718bfdf4de05e6bf3b5337deb93ceb72b07",
			localMainSha: LINE13_T0_BASE_SHA,
			originMainTrackingSha: LINE13_T0_BASE_SHA,
			originMainRemoteSha: LINE13_T0_BASE_SHA,
			originUrl: "https://github.com/guanwenpeng2001-bot/AOS-Agent.git",
			cleanStart: true,
			cleanStartPorcelain: "",
			capturedOnBranch: "guanwenpeng2001-bot/T0_BASELINE_INVENTORY",
			nodeVersion: "v24.18.1",
			npmVersion: "12.0.2",
			installCommand: "npm ci --ignore-scripts",
			installExitCode: 0,
			installAddedPackages: 408,
			installAuditedPackages: 428,
			auditCommand: "npm audit --json",
			auditExitCode: 1,
			auditReportVersion: 2,
			auditVulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
			auditDependencies: { prod: 259, dev: 229, optional: 86, peer: 0, peerOptional: 0, total: 503 },
			realConnectorEnabled: false,
		});
		expect(() => git("cat-file", "-e", `${LINE13_T0_BASE_SHA}^{commit}`)).not.toThrow();
		expect(git("show", "-s", "--format=%T", LINE13_T0_BASE_SHA)).toBe(LINE13_T0_BASELINE.baseTreeSha);
	});

	it("freezes every base-commit dependency manifest and lock input", () => {
		const expectedPaths = LINE13_T0_DEPENDENCY_BASELINE.map((entry) => entry.path);
		expect(line13BaseDependencyPaths()).toEqual(expectedPaths);
		for (const entry of LINE13_T0_DEPENDENCY_BASELINE) {
			expect(sha256BaseBlob(entry.path), entry.path).toBe(entry.sha256);
		}
		expect(dependencyBaselineDigest()).toBe(LINE13_T0_EXPECTED.dependencyDigest);
	});

	it("records that no real Connector was enabled at T0", () => {
		expect(LINE13_T0_BASELINE.realConnectorEnabled).toBe(false);
		expect(discoverRealConnectorCandidates()).toEqual([]);
		expect(loadLine13T0Inventory().find((entry) => entry.id === "no-real-connector-enabled")).toMatchObject({
			category: "baseline",
			targetAuthorityOwner: "Trusted External Connector composition",
		});
	});

	it("covers every declared public package entrypoint", () => {
		const actual = new Map<string, string[]>();
		for (const root of LINE13_T0_PUBLIC_ROOTS) {
			const specifiers = actual.get(root.packageName) ?? [];
			specifiers.push(root.specifier);
			actual.set(root.packageName, specifiers);
		}
		expect([...actual.get("@aos-agent/agent-core")!].sort()).toEqual(packageExportSpecifiers("packages/agent/package.json"));
		expect([...actual.get("aos-agent")!].sort()).toEqual(packageExportSpecifiers("packages/coding-agent/package.json"));
	});

	it("materializes exhaustive deterministic inventories with ownership and evidence", () => {
		const inventory = loadLine13T0Inventory();
		const repeated = loadLine13T0Inventory();
		expect(repeated).toEqual(inventory);
		expect(new Set(inventory.map((entry) => entry.id)).size).toBe(inventory.length);
		for (const entry of inventory) {
			expect(entry.currentCodeLocation, entry.id).not.toBe("");
			expect(entry.acceptanceCriterionOwner, entry.id).toMatch(/AC-\d{2}/u);
			expect(entry.targetAuthorityOwner.trim(), entry.id).not.toBe("");
			expect(entry.targetAuthorityOwner, entry.id).not.toContain(",");
			expect(entry.targetAuthorityOwner, entry.id).not.toMatch(/\s(?:and|or)\s/u);
			expect(entry.migrationStrategy, entry.id).toMatch(/^(?:At T\d|Compare|Preserve|Read|Replace|Reproduce|Require|Retain|Use)/u);
			expect(entry.migrationStrategy, entry.id).not.toBe(entry.deletionStage);
			expect(entry.deletionStage, entry.id).toMatch(/^(?:Not scheduled for deletion|T\d+[a-z]?(?:\/T\d+[a-z]?)*)$/u);
			expect(entry.evidence, entry.id).not.toBe("");
		}

		const counts = new Map<Line13InventoryCategory, number>();
		for (const entry of inventory) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
		expect(counts).toEqual(new Map<Line13InventoryCategory, number>([
			["baseline", 6],
			["binding_consumer", 24],
			["dependency", 24],
			["event_audit_source", 8],
			["operability", 35],
			["product_construction", 25],
			["provider_taxonomy", 12],
			["public_export", 1965],
			["run_terminal_writer", 6],
			["scheduler_recovery_resource", 10],
			["session_writer", 26],
		]));
		expect(inventory.filter((entry) => !["baseline", "dependency", "public_export"].includes(entry.category))).toHaveLength(LINE13_T0_EXPECTED.factCount);
		expect(inventory.filter((entry) => entry.category === "public_export")).toHaveLength(LINE13_T0_EXPECTED.publicExportCount);
		expect(inventory.some((entry) => entry.category === "public_export" && entry.evidence.includes("Public unversioned alias"))).toBe(true);
		const publicExports = inventory.filter((entry) => entry.category === "public_export");
		expect(publicExports.every((entry) => (entry.publicBarrelPaths?.length ?? 0) > 0)).toBe(true);
		expect(publicExports.some((entry) => entry.publicBarrelPaths?.some((path) => path.split(" -> ").length >= 4))).toBe(true);
		for (const entry of publicExports) {
			const location = /^(packages\/.+)#[^ ]+ -> (packages\/.+):\d+$/u.exec(entry.currentCodeLocation);
			expect(location, entry.id).not.toBeNull();
			for (const path of entry.publicBarrelPaths ?? []) {
				expect(path, entry.id).toContain(` -> ${location![1]}#`);
				expect(path, entry.id).toContain(` -> ${location![2]}#`);
			}
		}
		const acOwners = [...new Set(inventory.flatMap((entry) => entry.acceptanceCriterionOwner.match(/AC-\d{2}/gu) ?? []))].sort();
		expect(acOwners).toEqual(Array.from({ length: 24 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`));
		expect([...counts.keys()].filter((category) => category !== "baseline").sort()).toEqual([
			"binding_consumer",
			"dependency",
			"event_audit_source",
			"operability",
			"product_construction",
			"provider_taxonomy",
			"public_export",
			"run_terminal_writer",
			"scheduler_recovery_resource",
			"session_writer",
		]);
		expect(line13InventoryDigest(inventory)).toBe(LINE13_T0_EXPECTED.inventoryDigest);
	});

	it("matches category-specific discovery to the reviewed fact allowlists", () => {
		const inventory = loadLine13T0Inventory().filter((entry) => !["baseline", "dependency", "public_export"].includes(entry.category));
		const reviewedLocations = [...new Set(inventory.map((entry) => `${entry.category}:${entry.currentCodeLocation}`))].sort();
		const discoveredLocations = [...new Set(discoverLine13T0Candidates()
			.map((entry) => `${entry.category}:${entry.path}:${entry.line}`))]
			.sort();
		expect(discoveredLocations).toEqual(reviewedLocations);
	});
});
