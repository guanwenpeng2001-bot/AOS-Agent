import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

function publicExportNames(): readonly string[] {
	const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const program = ts.createProgram({
		rootNames: [sourcePath],
		options: {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ESNext,
		},
	});
	const source = program.getSourceFile(sourcePath);
	const symbol = source === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(source);
	if (symbol === undefined) throw new Error("coding-agent public entrypoint could not be inspected");
	return program.getTypeChecker().getExportsOfModule(symbol).map((entry) => entry.name);
}

describe("External Connector public exports", () => {
	it("exports only the current connector contract and safe product gates", () => {
		expect(typeof publicApi.createExternalConnectorRegistry).toBe("function");
		expect(typeof publicApi.executeExternalConnectorProductRun).toBe("function");
		expect(typeof publicApi.gateCanonicalExternalAgentInputBeforeAcceptance).toBe("function");
		expect(typeof publicApi.projectExternalModelForExecution).toBe("function");
	});

	it("does not export legacy Adapter, mapping, or private driver contracts", () => {
		const exports = publicExportNames();
		for (const name of [
			"ExternalAgentAdapter",
			"ExternalAgentBindingInput",
			"ExternalAgentPreparedBinding",
			"ExternalAgentHandle",
			"ExternalAgentReceipt",
			"ExternalAdapterIdentity",
			"ExternalAgentError",
			"createExternalAgentAdapterRegistry",
			"createExternalAgentPreparedBinding",
			"runExternalAgentAdapter",
			"ExternalExecutionMapping",
			"ExternalMappingSummary",
			"ExternalMappingRequest",
			"ExternalMappingPersistenceResult",
			"ExternalMapData",
			"DurableExternalAgentConnector",
			"createDurableExternalAgentConnector",
			"externalConnectorAttemptId",
			"ExternalAgentConnectorRuntimeOptions",
			"ExternalConnectorBoundedSupervisor",
			"ExternalConnectorVendorDriver",
			"ExternalConnectorDriverHandle",
		]) {
			expect(name in publicApi).toBe(false);
			expect(exports).not.toContain(name);
		}
	});

	it("keeps vendor driver modules outside the package export map", () => {
		const require = createRequire(import.meta.url);
		expect(() => require.resolve("aos-agent/core/vendor-drivers/types")).toThrow(
			/Package subpath|not defined by "exports"/u,
		);
	});
});
