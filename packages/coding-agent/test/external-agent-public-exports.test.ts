import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

const CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS = [
	{
		code: "external_connector_unavailable",
		meaning: "No trusted External Connector registry is composed, or the selected Connector is not registered",
		retryable: "no",
	},
	{
		code: "external_mapping_conflict",
		meaning: "Mapping history already conflicts with the persisted External Connector Attempt",
		retryable: "no",
	},
	{
		code: "external_resume_unsupported",
		meaning: "The source External Connector run cannot be restored as the same durable Attempt",
		retryable: "no",
	},
	{
		code: "external_binding_invalid",
		meaning:
			"Connector selection, canonical input, or gateway model binding is invalid or cannot be translated safely",
		retryable: "no",
	},
	{
		code: "external_capability_mismatch",
		meaning: "The pinned Connector capability snapshot is missing, unsupported, or changed during preflight",
		retryable: "no",
	},
	{
		code: "external_event_invalid",
		meaning: "The Connector emitted invalid or out-of-order supervised output",
		retryable: "no",
	},
	{
		code: "external_resource_limit_exceeded",
		meaning: "Connector input or supervised output exceeded a bounded resource limit",
		retryable: "no",
	},
	{
		code: "external_path_outside_workspace",
		meaning: "A Connector input or artifact reference resolves outside its trusted workspace",
		retryable: "no",
	},
	{
		code: "side_effect_unknown",
		meaning: "An external effect may have occurred without conclusive durable evidence; automatic retry is forbidden",
		retryable: "no",
	},
] as const;

const LEGACY_EXTERNAL_AGENT_ERROR_CODES = [
	"external_agent_adapter_invalid",
	"external_agent_target_not_found",
	"external_agent_probe_failed",
	"external_agent_protocol_unsupported",
	"external_agent_capability_missing",
	"external_agent_binding_unsupported",
	"external_agent_start_failed",
	"external_agent_mapping_invalid",
	"external_agent_mapping_conflict",
	"external_agent_cancel_unsupported",
	"external_agent_cancel_failed",
	"external_agent_receipt_invalid",
	"external_agent_side_effect_unknown",
	"external_agent_resume_unsupported",
	"external_agent_persistence_failed",
] as const;

function inspectPublicEntrypoint(): { checker: ts.TypeChecker; symbol: ts.Symbol } {
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
	const checker = program.getTypeChecker();
	const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
	if (symbol === undefined) throw new Error("coding-agent public entrypoint could not be inspected");
	return { checker, symbol };
}

function publicExportNames(): readonly string[] {
	const { checker, symbol } = inspectPublicEntrypoint();
	return checker.getExportsOfModule(symbol).map((entry) => entry.name);
}

function publicAutomationErrorCodes(): readonly string[] {
	const { checker, symbol } = inspectPublicEntrypoint();
	const exported = checker.getExportsOfModule(symbol).find((entry) => entry.name === "AutomationErrorCode");
	if (exported === undefined) throw new Error("AutomationErrorCode is not publicly exported");
	const declared = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
	const type = checker.getDeclaredTypeOfSymbol(declared);
	if (!type.isUnion()) throw new Error("AutomationErrorCode must remain a string-literal union");
	const literals = type.types.filter((member) => member.isStringLiteral());
	if (literals.length !== type.types.length) {
		throw new Error("AutomationErrorCode must remain a string-literal union");
	}
	return literals.map((member) => member.value);
}

describe("External Connector public exports", () => {
	it("exports only the current connector contract and safe product gates", () => {
		expect(typeof publicApi.createExternalConnectorRegistry).toBe("function");
		expect(typeof publicApi.createProductionExternalAgentConnector).toBe("function");
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
			"ExternalExecutionRef",
			"DurableExternalAgentConnector",
			"createDurableExternalAgentConnector",
			"getHostSupervisedExternalAgentConnectorImplementation",
			"isHostSupervisedExternalAgentConnector",
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

	it("documents exactly the public Connector-era external error contract", () => {
		const publicCodes = publicAutomationErrorCodes();
		const currentCodes = CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS.map((row) => row.code);
		expect(publicCodes.filter((code) => code.startsWith("external_") || code === "side_effect_unknown")).toEqual(
			currentCodes,
		);
		for (const code of LEGACY_EXTERNAL_AGENT_ERROR_CODES) expect(publicCodes).not.toContain(code);
		expect(publicCodes).not.toContain("audit_persistence_failed");

		const rpcDocs = readFileSync(fileURLToPath(new URL("../docs/rpc.md", import.meta.url)), "utf8");
		const documentedRows = [...rpcDocs.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (yes|no) \|$/gmu)]
			.map((match) => ({ code: match[1], meaning: match[2]?.trim(), retryable: match[3] }))
			.filter((row) => row.code?.startsWith("external_") || row.code === "side_effect_unknown");
		expect(documentedRows).toEqual(CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS);
		expect(rpcDocs).not.toMatch(/\bexternal_agent_[a-z0-9_]+\b/u);
	});
});
