import {
	createConnectorCapabilitySnapshot,
	type ArtifactStoreProvider,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExternalAgentConnectorRuntimeOptions } from "../durable-connector.ts";
import type { ExternalConnectorDurableStore } from "../operation.ts";
import { createProductionExternalConnectorSupervision } from "../production.ts";
import { resolveProductionExternalConnectorDriverProvenance } from "../process-controller.ts";
import { packagedClaudeProcessBridgeModulePath } from "../packaged-driver.ts";
import {
	externalConnectorProcessForTarget,
	type ExternalConnectorResolvedTarget,
} from "../target-config.ts";
import {
	bindExternalConnectorVendorBehaviorManifest,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE,
} from "../tool-gateway-binding.ts";
import { createPrivateClaudeAgentSdkCompanion } from "../../../vendor-driver-companions/claude-entry.ts";
import {
	createPrivateClaudeExternalAgentConnector,
	type PrivateClaudeAgentSdkCompanion,
} from "./claude.ts";
import {
	createPrivateCodexExternalAgentConnector,
	type PrivateCodexAppServerTransportFactory,
} from "./codex.ts";
import {
	createPrivateAcpExternalAgentConnector,
	type PrivateAcpStableV1TransportFactory,
} from "./acp.ts";
import { PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES } from "./identity.ts";
import {
	createPrivateAcpProcessTransportFactory,
	createPrivateCodexProcessTransportFactory,
} from "./process-transport.ts";
import { ProductionClaudeProcessBridge } from "./claude-process-bridge.ts";

type Supervision = ExternalAgentConnectorRuntimeOptions["supervision"];

/** Host-private seam for deterministic product tests; stock composition omits it. */
export interface PrivateExternalConnectorVendorAdapterOverrides {
	readonly supervision?: Supervision;
	readonly claudeCompanion?: PrivateClaudeAgentSdkCompanion;
	readonly codexTransportFactory?: PrivateCodexAppServerTransportFactory;
	readonly acpTransportFactory?: PrivateAcpStableV1TransportFactory;
	readonly artifactStore?: Pick<ArtifactStoreProvider, "get">;
}

function dependencyGuide(driver: NonNullable<ExternalConnectorResolvedTarget["driver"]>): string {
	switch (driver) {
		case "claude":
			return "Install the pinned Claude Agent SDK and Claude Code using https://code.claude.com/docs/en/getting-started, then update the target paths and SHA-256 identities.";
		case "codex":
			return "Install Codex CLI using https://developers.openai.com/codex/cli, then update the target paths and SHA-256 identities.";
		case "acp":
			return "Install a compatible ACP agent using https://agentclientprotocol.com/get-started/registry, then update the target paths and SHA-256 identities.";
	}
}

function isMissingDependency(error: unknown): boolean {
	return error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR");
}

function productionSupervision(
	target: ExternalConnectorResolvedTarget,
	privateStatePath: string,
): Supervision {
	try {
		const targetProcess = externalConnectorProcessForTarget(target);
		resolveProductionExternalConnectorDriverProvenance(targetProcess);
		const supervisedProcess = target.driver === "claude"
			? (() => {
					const modulePath = packagedClaudeProcessBridgeModulePath();
					return {
						executablePath: process.execPath,
						arguments: Object.freeze([modulePath]),
						trustedProvenance: Object.freeze({
							modulePath,
							cwd: target.cwd,
							version: target.version,
							executableIdentity: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
							moduleIdentity: `sha256:${createHash("sha256").update(readFileSync(modulePath)).digest("hex")}`,
						}),
					};
				})()
			: targetProcess;
		return createProductionExternalConnectorSupervision({
			privateStatePath,
			process: supervisedProcess,
		});
	} catch (error) {
		if (!isMissingDependency(error) || target.driver === undefined) throw error;
		throw new TypeError(`The configured ${target.driver} dependency is missing. ${dependencyGuide(target.driver)}`);
	}
}

export function privateVendorCapability(target: ExternalConnectorResolvedTarget): ConnectorCapabilitySnapshot {
	const driver = target.driver;
	if (driver === undefined) throw new TypeError("External Connector vendor driver is not declared");
	const identity = PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES[driver];
	const modelAccess = target.capabilityCeiling.modelAccess[0];
	if (modelAccess === undefined) throw new TypeError("External Connector target capability ceiling is empty");
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: target.providerId,
		revision: 1,
		protocol: { name: identity.protocolName, version: identity.protocolVersion },
		modelAccess,
		resume: target.capabilityCeiling.resume,
		toolGateway: target.capabilityCeiling.toolGateway,
		artifacts: target.capabilityCeiling.artifacts,
		images: target.capabilityCeiling.images,
	});
}

export async function createPrivateVendorExternalAgentConnector(options: {
	readonly target: ExternalConnectorResolvedTarget;
	readonly store: ExternalConnectorDurableStore;
	readonly privateStatePath: string;
	readonly credential?: ExternalAgentConnectorRuntimeOptions["credential"];
	readonly adapters?: PrivateExternalConnectorVendorAdapterOverrides;
}) {
	const driver = options.target.driver;
	if (driver === undefined) throw new TypeError("External Connector vendor driver is not declared");
	const capability = privateVendorCapability(options.target);
	const supervision = options.adapters?.supervision ??
		productionSupervision(options.target, options.privateStatePath);
	let connector: ExternalAgentConnector;
	if (driver === "claude") {
		const productionProcessBridge = options.adapters?.supervision === undefined
			? new ProductionClaudeProcessBridge(supervision.processController, options.target)
			: undefined;
		const companion = options.adapters?.claudeCompanion ?? await createPrivateClaudeAgentSdkCompanion({
			executablePath: options.target.modulePath,
		});
		connector = createPrivateClaudeExternalAgentConnector({
			providerId: options.target.providerId,
			capability,
			store: options.store,
			supervision,
			companion,
			cwd: options.target.cwd,
			...(options.credential === undefined ? {} : { credential: options.credential }),
			...(productionProcessBridge === undefined ? {} : { processBridge: productionProcessBridge }),
			...(options.adapters?.artifactStore === undefined ? {} : { artifactStore: options.adapters.artifactStore }),
		});
	} else if (driver === "codex") {
		connector = createPrivateCodexExternalAgentConnector({
			providerId: options.target.providerId,
			capability,
			store: options.store,
			supervision,
			transportFactory: options.adapters?.codexTransportFactory ??
				createPrivateCodexProcessTransportFactory(supervision.processController),
			cwd: options.target.cwd,
			roots: { workspace: options.target.cwd },
			...(options.credential === undefined ? {} : { credential: options.credential }),
		});
	} else {
		connector = createPrivateAcpExternalAgentConnector({
			providerId: options.target.providerId,
			capability,
			store: options.store,
			supervision,
			transportFactory: options.adapters?.acpTransportFactory ??
				createPrivateAcpProcessTransportFactory(supervision.processController),
			cwd: options.target.cwd,
			roots: { workspace: options.target.cwd },
			...(options.credential === undefined ? {} : { credential: options.credential }),
			...(options.adapters?.artifactStore === undefined ? {} : { artifactStore: options.adapters.artifactStore }),
		});
	}
	bindExternalConnectorVendorBehaviorManifest(connector, () => ({
		schemaVersion: 1,
		revision: capability.revision,
		events: [EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT],
		writes: [EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE],
	}));
	return Object.freeze({ connector, capability });
}
