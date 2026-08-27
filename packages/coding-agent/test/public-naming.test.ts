import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as AgentPublic from "@aos-agent/agent-core";
import { parseTaskEnvelope, serializeTaskEnvelope, type TaskEnvelope } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import * as CodingAgentPublic from "../src/index.ts";
import { LINE13_T0_PUBLIC_ROOTS, line13RepoRoot } from "./support/line13-t0-baseline-inventory.ts";
import ts from "typescript";

const businessVersionPattern = /_?V\d+(?=[A-Z_]|$)/u;
const legacyPublicSurfacePatterns = [
	/External Agent Adapter/giu,
	/Execution Audit \/ Replay \/ External Mapping Contract/gu,
	/\bexternal mapping\b/giu,
	/\bExternalExecutionRef\b/gu,
	/\baudit_persistence_failed\b/gu,
	/\bexternal_agent_[a-z0-9_]+\b/gu,
] as const;

describe("current public naming", () => {
	it("exposes only unversioned business names from package roots and subpaths", () => {
		const root = line13RepoRoot();
		const rootNames = LINE13_T0_PUBLIC_ROOTS.map((entry) => resolve(root, entry.source));
		const program = ts.createProgram({
			rootNames,
			options: {
				allowImportingTsExtensions: true,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				noEmit: true,
				skipLibCheck: true,
				target: ts.ScriptTarget.ESNext,
			},
		});
		const checker = program.getTypeChecker();
		const versionedExports: string[] = [];
		const migrationExports: string[] = [];
		const exportsBySpecifier = new Map<string, ReadonlySet<string>>();
		for (const publicRoot of LINE13_T0_PUBLIC_ROOTS) {
			const sourceFile = program.getSourceFile(resolve(root, publicRoot.source));
			if (sourceFile === undefined) throw new Error(`Missing public entrypoint ${publicRoot.source}`);
			const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
			if (moduleSymbol === undefined) throw new Error(`Missing module symbol for ${publicRoot.source}`);
			const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
			exportsBySpecifier.set(
				`${publicRoot.packageName}:${publicRoot.specifier}`,
				new Set(exportedSymbols.map((symbol) => symbol.name)),
			);
			for (const symbol of exportedSymbols) {
				if (businessVersionPattern.test(symbol.name)) {
					versionedExports.push(`${publicRoot.specifier}:${symbol.name}`);
					continue;
				}
				const resolved = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
				if (businessVersionPattern.test(resolved.name))
					versionedExports.push(`${publicRoot.specifier}:${symbol.name}->${resolved.name}`);
				if (
					resolved
						.getDeclarations()
						?.some((declaration) =>
							declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/migrations/"),
						)
				) {
					migrationExports.push(`${publicRoot.specifier}:${symbol.name}`);
				}
			}
		}
		expect(versionedExports).toEqual([]);
		expect(migrationExports).toEqual([]);
		expect(AgentPublic.TaskEnvelopeSchema).toBeDefined();
		expect("TaskEnvelopeV1Schema" in AgentPublic).toBe(false);
		expect(CodingAgentPublic.SchedulerHost).toBeDefined();
		expect("SchedulerHostV1" in CodingAgentPublic).toBe(false);
		const agentRootExports = exportsBySpecifier.get("@aos-agent/agent-core:.");
		expect(agentRootExports?.has("JsonlSessionHeader")).toBe(true);
		expect(agentRootExports?.has("JsonlV4Header")).toBe(false);
		expect(agentRootExports?.has("JsonlV5Header")).toBe(false);
		const jsonlTypes = readFileSync(join(root, "packages/agent/src/harness/session/jsonl/types.ts"), "utf8");
		expect(jsonlTypes).toMatch(/export interface JsonlV4Header[\s\S]*version: 4;/u);
		expect(jsonlTypes).toMatch(/export interface JsonlV5Header[\s\S]*version: 5;/u);
		expect(jsonlTypes).toMatch(/JsonlSessionHeader = JsonlV4Header \| JsonlV5Header/u);
	});

	it("keeps schemaVersion in schema round trips", () => {
		const task: TaskEnvelope = {
			schemaVersion: 1,
			taskId: "public-naming-task",
			goalId: "public-naming-goal",
			goal: "Verify the current public schema name",
			workspace: "public-naming-workspace",
			capabilityRefs: [],
			inputs: [],
			expectedOutputs: [],
			budget: {},
			acceptanceCriteria: [],
			status: "ready",
			createdAt: "2026-08-25T00:00:00.000Z",
			updatedAt: "2026-08-25T00:00:00.000Z",
		};
		const parsed = parseTaskEnvelope(serializeTaskEnvelope(task));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual(task);
		expect(parsed.value.schemaVersion).toBe(1);
	});

	it("keeps user documentation on current product names", () => {
		const root = line13RepoRoot();
		const docsRoot = join(root, "packages/coding-agent/docs");
		const pending = [docsRoot];
		const documents: string[] = [];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (directory === undefined) break;
			for (const entry of readdirSync(directory)) {
				const path = join(directory, entry);
				if (statSync(path).isDirectory()) pending.push(path);
				else if (entry.endsWith(".md") || entry.endsWith(".html")) documents.push(path);
			}
		}
		const staleNames: string[] = [];
		const maturityLabels: string[] = [];
		const legacyPublicSurfaces: string[] = [];
		for (const path of documents) {
			const text = readFileSync(path, "utf8");
			for (const match of text.matchAll(/[$A-Z_a-z][$\w]*_?V\d+(?:[A-Z_][$\w]*)?/gu)) {
				if (match[0] !== "WorkerProtocolV1") staleNames.push(`${path}:${match[0]}`);
			}
			if (
				/\b(?:Foundation|Automation Host|Task Gate|Task Graph|Task Credential|Capability|Context Engine|Execution Policy|Execution Audit|External Agent Connector|Sandbox Operation Worker) \(?v\d+\)?\b/iu.test(
					text,
				) ||
				/^(?:#.*(?:External Agent Connector|Execution Audit|Remote-Neutral Operation Contract).*)\(v\d+\)$/imu.test(
					text,
				) ||
				/\b(?:a v1 response|v1 (?:does|never|performs|has|rejects))\b|\(v1:\s*\d/iu.test(text) ||
				/Out of scope \(v1\)/iu.test(text)
			) {
				maturityLabels.push(path);
			}
			for (const pattern of legacyPublicSurfacePatterns) {
				for (const match of text.matchAll(pattern)) legacyPublicSurfaces.push(`${path}:${match[0]}`);
			}
		}
		expect(staleNames).toEqual([]);
		expect(maturityLabels).toEqual([]);
		expect(legacyPublicSurfaces).toEqual([]);
		expect(existsSync(join(docsRoot, "architecture-atlas-foundation.md"))).toBe(true);
		expect(existsSync(join(docsRoot, "architecture-atlas-foundation-v1.md"))).toBe(false);
		expect(existsSync(join(docsRoot, "foundation-final-audit.md"))).toBe(true);
		expect(existsSync(join(docsRoot, "foundation-v1-final-audit.md"))).toBe(false);
	});
});
