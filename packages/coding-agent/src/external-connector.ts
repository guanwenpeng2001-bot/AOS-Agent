export type { ExternalAgentConnector } from "@aos-agent/agent-core";
export {
	EXTERNAL_CONNECTOR_PROVIDER_CLASSES,
	createExternalConnectorRegistry,
	isExternalConnectorSelection,
	serializeExternalConnectorSelection,
	type ExternalConnectorDescriptor,
	type ExternalConnectorProviderClass,
	type ExternalConnectorReadinessStatus,
	type ExternalConnectorRegistration,
	type ExternalConnectorRegistry,
	type ExternalConnectorResolvedSelection,
	type ExternalConnectorSelection,
} from "./core/external-agent-registry.ts";
export {
	EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION,
	ExternalConnectorTargetConfigError,
	buildExternalConnectorTargetConfig,
	resolveExternalConnectorTargetConfig,
	type ExternalConnectorAccountReference,
	type ExternalConnectorCapabilityCeiling,
	type ExternalConnectorCapabilityNarrowing,
	type ExternalConnectorModelAccess,
	type ExternalConnectorResolvedTarget,
	type ExternalConnectorTargetAuthority,
	type ExternalConnectorTargetCatalogConfig,
	type ExternalConnectorTargetConfig,
	type ExternalConnectorTargetConfigBuildOptions,
	type ExternalConnectorTargetConfigErrorReason,
	type ExternalConnectorTargetDefinition,
	type ExternalConnectorTargetSelectionConfig,
	type ExternalConnectorTargetSelectionSource,
	type ExternalConnectorTrustedTarget,
} from "./core/external-connector-target-config.ts";
export {
	PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES,
	PackagedExternalAgentDriverAssetError,
	loadPackagedExternalAgentDriver,
	runPackagedExternalAgentDriverFixture,
	type PackagedExternalAgentDriver,
	type PackagedExternalAgentDriverAssetErrorCode,
	type PackagedExternalAgentDriverName,
	type PackagedExternalAgentDriverOperation,
	type PackagedExternalAgentDriverOperationKind,
	type PackagedExternalAgentDriverTrace,
} from "./core/packaged-external-agent-driver.ts";
export {
	LINE13_PRODUCT_TRACE_OPERATIONS,
	runPackagedLine13ProductTrace,
	type Line13CanonicalClosureSnapshot,
	type Line13ProductTraceOptions,
	type Line13ProductTraceResult,
} from "./core/line13-product-trace.ts";
export {
	runPackagedLine13UpgradeMigration,
	type Line13PackagedUpgradeOptions,
	type Line13PackagedUpgradeResult,
	type Line13UpgradeFault,
} from "./core/line13-packaged-upgrade.ts";
export {
	CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS,
	CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION,
	ExternalAgentInputError,
	fingerprintCanonicalExternalAgentInput,
	gateCanonicalExternalAgentInputBeforeAcceptance,
	validateCanonicalExternalAgentInput,
	type CanonicalExternalAgentArtifactReadHandle,
	type CanonicalExternalAgentArtifactReference,
	type CanonicalExternalAgentInput,
	type ExternalAgentArtifactInspection,
	type ExternalAgentInputAdmissionOptions,
} from "./core/external-agent-input.ts";
export {
	projectExternalModelForExecution,
	type ExternalModelFallbackDecision,
	type ExternalModelProjectionGateInput,
	type ExternalModelProjectionGateResult,
	type ExternalResolvedModelProjection,
} from "./core/external-model-projection.ts";
