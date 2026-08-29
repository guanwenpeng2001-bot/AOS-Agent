import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	EXTERNAL_ERROR_CODES,
	EXTERNAL_ERROR_MESSAGES,
	FOUNDATION_ERROR_CODES,
	FoundationError,
} from "@aos-agent/agent-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as externalConnectorApi from "../../src/external-connector.ts";
import * as publicApi from "../../src/index.ts";
import {
	isAutomationErrorCode,
	serializePublicAutomationError,
	serializePublicRunReceipt,
} from "../../src/core/session/run-lifecycle.ts";
import { cloneExternalConnectorTerminalEvidence } from "../../src/core/connector/vendor/types.ts";

const CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS = [
	{
		code: "external_connector_unavailable",
		meaning: "No trusted External Connector registry is composed, or the selected Connector is not registered",
		retryable: "no",
	},
	{
		code: "external_protocol_unsupported",
		meaning: "The selected Connector protocol or version is not supported by the trusted Host",
		retryable: "no",
	},
	{
		code: "external_capability_mismatch",
		meaning: "The pinned Connector capability snapshot is missing, unsupported, or changed during preflight",
		retryable: "no",
	},
	{
		code: "external_binding_invalid",
		meaning:
			"Connector selection, canonical input, or gateway model binding is invalid or cannot be translated safely",
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
		code: "external_event_invalid",
		meaning: "The Connector emitted invalid or out-of-order supervised output",
		retryable: "no",
	},
	{
		code: "external_tool_route_denied",
		meaning: "Tool Gateway policy or route denied a Connector-originated tool request",
		retryable: "no",
	},
	{
		code: "external_path_outside_workspace",
		meaning: "A Connector input or artifact reference resolves outside its trusted workspace",
		retryable: "no",
	},
	{
		code: "external_review_required",
		meaning: "The Connector operation requires an explicit review decision before execution",
		retryable: "no",
	},
	{
		code: "external_review_rejected",
		meaning: "The Connector operation was rejected by the required review decision",
		retryable: "no",
	},
	{
		code: "external_credential_unavailable",
		meaning: "A trusted credential target required by the Connector is unavailable",
		retryable: "no",
	},
	{
		code: "external_terminal_ambiguous",
		meaning: "Vendor terminal lookup returned ambiguous state; operator reconciliation is required",
		retryable: "no",
	},
	{
		code: "external_connector_config_invalid",
		meaning: "The trusted Connector configuration is invalid or violates the public registration contract",
		retryable: "no",
	},
	{
		code: "external_connector_not_ready",
		meaning: "The trusted Connector has not completed the readiness checks required for this operation",
		retryable: "no",
	},
	{
		code: "external_connector_readiness_stale",
		meaning: "The Connector readiness snapshot is stale and must be refreshed before execution",
		retryable: "no",
	},
	{
		code: "external_connector_circuit_open",
		meaning: "The Connector retry circuit is open after recent bounded failures",
		retryable: "no",
	},
	{
		code: "external_connector_dependency_missing",
		meaning: "A trusted dependency required by the Connector is missing or unavailable",
		retryable: "no",
	},
	{
		code: "external_connector_executable_untrusted",
		meaning: "The Connector executable or module is not from a trusted target",
		retryable: "no",
	},
	{
		code: "external_resource_limit_exceeded",
		meaning: "Connector input or supervised output exceeded a bounded resource limit",
		retryable: "no",
	},
	{
		code: "external_frame_oversize",
		meaning: "A Connector protocol frame exceeded the configured byte limit",
		retryable: "no",
	},
	{
		code: "tool_gateway_catalog_invalid",
		meaning: "The Tool Gateway route catalog is duplicate, incomplete, or inconsistent",
		retryable: "no",
	},
	{
		code: "control_state_corrupt",
		meaning: "Trusted control-plane state is corrupt and cannot be used safely",
		retryable: "no",
	},
	{
		code: "control_state_write_failed",
		meaning: "Trusted control-plane state could not be published atomically",
		retryable: "no",
	},
	{
		code: "session_transition_failed",
		meaning: "A transactional Session scope transition failed before commit",
		retryable: "no",
	},
	{
		code: "external_process_identity_ambiguous",
		meaning: "A Connector process identity could not be matched uniquely for safe recovery or termination",
		retryable: "no",
	},
	{
		code: "control_state_migration_failed",
		meaning: "Trusted control-plane state could not be migrated safely",
		retryable: "no",
	},
	{
		code: "shutdown_deadline_exceeded",
		meaning: "Host shutdown exceeded its bounded cleanup deadline",
		retryable: "no",
	},
	{
		code: "side_effect_unknown",
		meaning: "An external effect may have occurred without conclusive durable evidence; automatic retry is forbidden",
		retryable: "no",
	},
	{
		code: "run_terminal_conflict",
		meaning: "A terminal Run fact conflicts with the canonical Run receipt",
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
	const sourcePath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
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

function publicTypePropertyNames(exportName: string): readonly string[] {
	const { checker, symbol } = inspectPublicEntrypoint();
	const exported = checker.getExportsOfModule(symbol).find((entry) => entry.name === exportName);
	if (exported === undefined) throw new Error(`${exportName} is not publicly exported`);
	const declared = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
	return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(declared)).map((property) => property.name);
}

describe("External Connector public exports", () => {
	it("exports only the current connector contract and safe input gates", () => {
		expect(typeof publicApi.createExternalConnectorRegistry).toBe("function");
		expect(typeof publicApi.createAgentRuntimeCompositionFactory).toBe("function");
		expect(typeof publicApi.gateCanonicalExternalAgentInputBeforeAcceptance).toBe("function");
		expect(typeof publicApi.projectExternalModelForExecution).toBe("function");
		expect(typeof publicApi.loadPackagedExternalAgentDriver).toBe("function");
		expect(typeof publicApi.runPackagedExternalAgentDriverFixture).toBe("function");
		expect(typeof externalConnectorApi.loadPackagedExternalAgentDriver).toBe("function");
		expect(typeof externalConnectorApi.runPackagedExternalAgentDriverFixture).toBe("function");
	});

	it("keeps Tool Gateway consumer authority out of the public resolved selection", () => {
		expect(publicTypePropertyNames("ExternalConnectorResolvedSelection")).not.toContain(
			"bindToolGatewayConsumer",
		);
	});

	it("keeps connector trust attestation out of the public registration contract", () => {
		expect([...publicTypePropertyNames("ExternalConnectorRegistration")].sort()).toEqual(["connector", "descriptor"]);
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
			"createProductionExternalAgentConnector",
			"createProductionExternalConnectorSupervision",
			"getProductionExternalConnectorDriverProvenance",
			"ProductionExternalAgentConnectorRuntimeOptions",
			"ProductionExternalConnectorSupervisionOptions",
			"bindExternalConnectorToolGatewayConsumer",
			"executeExternalConnectorProductRun",
			"externalConnectorProductIdentity",
			"ExternalConnectorProductExecution",
			"ExternalConnectorProductExecutionInput",
			"ExternalConnectorToolGatewayExchange",
		]) {
			expect(name in publicApi).toBe(false);
			expect(exports).not.toContain(name);
		}
	});

	it("keeps vendor driver modules outside the package export map", () => {
		const require = createRequire(import.meta.url);
		expect(() => require.resolve("aos-agent/core/connector/vendor/types")).toThrow(
			/Package subpath|not defined by "exports"/u,
		);
	});

	it("keeps private production drivers out of the External Connector subpath", () => {
		for (const name of [
			"ExternalConnectorVendorDriver",
			"createProductionExternalAgentConnector",
			"createProductionExternalConnectorSupervision",
			"executeExternalConnectorProductRun",
		]) {
			expect(name in externalConnectorApi).toBe(false);
		}
	});

	it("documents exactly the public Connector-era external error contract", () => {
		const publicCodes = publicAutomationErrorCodes();
		const currentCodes = CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS.map((row) => row.code);
		expect(publicCodes.filter((code) => EXTERNAL_ERROR_CODES.some((externalCode) => externalCode === code))).toEqual(currentCodes);
		for (const code of LEGACY_EXTERNAL_AGENT_ERROR_CODES) expect(publicCodes).not.toContain(code);
		expect(publicCodes).not.toContain("audit_persistence_failed");

		const rpcDocs = readFileSync(fileURLToPath(new URL("../../docs/rpc.md", import.meta.url)), "utf8");
		const documentedRows = [...rpcDocs.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (yes|no) \|$/gmu)]
			.map((match) => ({ code: match[1], meaning: match[2]?.trim(), retryable: match[3] }))
			.filter((row) => EXTERNAL_ERROR_CODES.some((externalCode) => externalCode === row.code));
		expect(documentedRows).toEqual(CURRENT_EXTERNAL_AUTOMATION_ERROR_ROWS);
		expect(rpcDocs).not.toMatch(/\bexternal_agent_[a-z0-9_]+\b/u);
	});

	it("publishes Tool Gateway denial through the Foundation error contract", () => {
		expect(FOUNDATION_ERROR_CODES).toContain("external_tool_route_denied");
		expect(
			new FoundationError(
				"external_tool_route_denied",
				"External connector Tool Gateway policy or route denied the request.",
			).category,
		).toBe("permission");
	});

	it("publishes every stable External Connector error through Foundation and Automation", () => {
		expect(FOUNDATION_ERROR_CODES.filter((code) => EXTERNAL_ERROR_CODES.some((externalCode) => externalCode === code))).toEqual(EXTERNAL_ERROR_CODES);
		const expectedCategories = {
			external_connector_unavailable: "provider",
			external_protocol_unsupported: "provider",
			external_capability_mismatch: "provider",
			external_binding_invalid: "validation",
			external_mapping_conflict: "conflict",
			external_resume_unsupported: "provider",
			external_event_invalid: "provider",
			external_tool_route_denied: "permission",
			external_path_outside_workspace: "validation",
			external_review_required: "permission",
			external_review_rejected: "permission",
			external_credential_unavailable: "provider",
			external_terminal_ambiguous: "provider",
			external_connector_config_invalid: "validation",
			external_connector_not_ready: "provider",
			external_connector_readiness_stale: "provider",
			external_connector_circuit_open: "provider",
			external_connector_dependency_missing: "provider",
			external_connector_executable_untrusted: "permission",
			external_resource_limit_exceeded: "provider",
			external_frame_oversize: "validation",
			tool_gateway_catalog_invalid: "validation",
			control_state_corrupt: "validation",
			control_state_write_failed: "provider",
			session_transition_failed: "provider",
			external_process_identity_ambiguous: "provider",
			control_state_migration_failed: "provider",
			shutdown_deadline_exceeded: "provider",
			side_effect_unknown: "unknown",
			run_terminal_conflict: "conflict",
		} as const;
		for (const code of EXTERNAL_ERROR_CODES) {
			expect(isAutomationErrorCode(code)).toBe(true);
			const rawMessage = `private external failure ${code} C:\\private\\credential.txt`;
			const foundation = new FoundationError(code, rawMessage, { retryable: true });
			expect(foundation.category).toBe(expectedCategories[code]);
			expect(foundation.toPublicExecutionError()).toEqual({
				code,
				message: EXTERNAL_ERROR_MESSAGES[code],
				retryable: true,
			});
			expect(serializePublicAutomationError({ code, message: rawMessage, retryable: true })).toEqual({
				code,
				message: EXTERNAL_ERROR_MESSAGES[code],
				retryable: true,
			});
			const evidence = cloneExternalConnectorTerminalEvidence({
				externalSessionId: "external-session",
				externalTurnId: "external-turn",
				operationNonce: "operation-nonce",
				status: "failed",
				sideEffectState: "none",
				producedAt: "2026-08-27T00:00:00.000Z",
				error: { code, message: rawMessage, retryable: true },
			});
			expect(evidence.error).toMatchObject({ code });
			expect(evidence.error?.message).toBe(EXTERNAL_ERROR_MESSAGES[code]);
			const receipt = serializePublicRunReceipt({
				runId: `run-${code}`,
				sessionId: "session-external",
				runReceiptId: `receipt-${code}`,
				attemptReceiptIds: [],
				sideEffectState: "none",
				status: "failed",
				usage: { input: 0, output: 0, total: 0 },
				terminalError: { code, message: rawMessage, retryable: true },
			});
			expect(receipt.terminalError).toEqual({
				code,
				message: EXTERNAL_ERROR_MESSAGES[code],
				retryable: true,
			});
		}
	});
});
