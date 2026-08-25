import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	dependencyBaselineDigest,
	LINE13_T0_BASELINE,
	LINE13_T0_BASE_SHA,
	LINE13_T0_DEPENDENCY_BASELINE,
	LINE13_T0_EXPECTED,
	LINE13_T0_PUBLIC_ROOTS,
	line13InventoryDigest,
	line13RepoRoot,
	loadLine13T0Inventory,
	type Line13InventoryCategory,
} from "./support/line13-t0-baseline-inventory.ts";

const repoRoot = line13RepoRoot();

function git(...args: readonly string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(resolve(repoRoot, path))).digest("hex");
}

function trackedDependencyFiles(): string[] {
	return git(
		"ls-files",
		"package.json",
		"package-lock.json",
		"**/package.json",
		"**/package-lock.json",
		"**/npm-shrinkwrap.json",
	)
		.split(/\r?\n/u)
		.filter((path) => path.length > 0)
		.sort((left, right) => left.localeCompare(right));
}

function packageExportSpecifiers(packagePath: string): string[] {
	const manifest = JSON.parse(readFileSync(resolve(repoRoot, packagePath), "utf8")) as { exports: Record<string, unknown> };
	return Object.keys(manifest.exports)
		.filter((specifier) => specifier !== "./package.json")
		.sort((left, right) => left.localeCompare(right));
}

describe("Line 13 T0 baseline and inventories", () => {
	it("freezes the exact common main base and clean-start fact", () => {
		expect(LINE13_T0_BASELINE).toEqual({
			baseSha: LINE13_T0_BASE_SHA,
			localMainSha: LINE13_T0_BASE_SHA,
			originMainTrackingSha: LINE13_T0_BASE_SHA,
			originMainRemoteSha: LINE13_T0_BASE_SHA,
			originUrl: "https://github.com/guanwenpeng2001-bot/AOS-Agent.git",
			cleanStart: true,
			cleanStartPorcelain: "",
			capturedOnBranch: "guanwenpeng2001-bot/T0_BASELINE_INVENTORY",
		});
		expect(git("rev-parse", "main")).toBe(LINE13_T0_BASE_SHA);
		expect(git("rev-parse", "origin/main")).toBe(LINE13_T0_BASE_SHA);
		expect(git("remote", "get-url", "origin")).toBe(LINE13_T0_BASELINE.originUrl);
		expect(() => git("cat-file", "-e", `${LINE13_T0_BASE_SHA}^{commit}`)).not.toThrow();
	});

	it("freezes every tracked dependency manifest and lock input", () => {
		const expectedPaths = LINE13_T0_DEPENDENCY_BASELINE.map((entry) => entry.path);
		expect(trackedDependencyFiles()).toEqual(expectedPaths);
		for (const entry of LINE13_T0_DEPENDENCY_BASELINE) {
			expect(sha256File(entry.path), entry.path).toBe(entry.sha256);
		}
		expect(dependencyBaselineDigest()).toBe(LINE13_T0_EXPECTED.dependencyDigest);
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
			expect(entry.acOwner, entry.id).not.toBe("");
			expect(entry.migrationOrRemovalStage, entry.id).not.toBe("");
			expect(entry.evidence, entry.id).not.toBe("");
		}

		const counts = new Map<Line13InventoryCategory, number>();
		for (const entry of inventory) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
		expect(counts).toEqual(new Map<Line13InventoryCategory, number>([
			["baseline", 2],
			["binding_consumer", 11],
			["dependency", 24],
			["event_audit_source", 8],
			["operability", 28],
			["product_construction", 23],
			["provider_taxonomy", 11],
			["public_export", 1965],
			["run_terminal_writer", 6],
			["scheduler_recovery_resource", 10],
			["session_writer", 14],
		]));
		expect(inventory.filter((entry) => !["baseline", "dependency", "public_export"].includes(entry.category))).toHaveLength(LINE13_T0_EXPECTED.factCount);
		expect(inventory.filter((entry) => entry.category === "public_export")).toHaveLength(LINE13_T0_EXPECTED.publicExportCount);
		expect(inventory.some((entry) => entry.category === "public_export" && entry.evidence.includes("Public unversioned alias"))).toBe(true);
		const acOwners = [...new Set(inventory.flatMap((entry) => entry.acOwner.match(/AC-\d{2}/gu) ?? []))].sort();
		expect(acOwners).toEqual(Array.from({ length: 24 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`));
		expect(line13InventoryDigest(inventory)).toBe(LINE13_T0_EXPECTED.inventoryDigest);
	});
});
