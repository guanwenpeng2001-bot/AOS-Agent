# Public API

The package export map is the supported import boundary. The lists below are
checked against `scripts/public-api-whitelist.json`; adding a kept export
requires adding documentation evidence here, in a package README, or in an
example.

## `aos-agent`

The package root contains the CLI, Session SDK, extension, tool, model, RPC,
theme, and resource-loading contracts used by application and extension
authors.

```text
AgentSession, AgentSessionEvent, AgentSessionRuntime, AuditQuery, BashExecutionMessage, BashOperations, BashToolDetails, BorderedLoader, BuildSystemPromptOptions, CompactionResult, CONFIG_DIR_NAME, convertToLlm, createAgentRuntimeCompositionFactory, createAgentSession, createAgentSessionFromServices, CreateAgentSessionOptions, CreateAgentSessionResult, createAgentSessionRuntime, CreateAgentSessionRuntimeFactory, createAgentSessionServices, createBashTool, createCodingTools, createEditTool, createEventBus, createExtensionRuntime, createExternalConnectorRegistry, createFindTool, createGrepTool, createLocalBashOperations, createLsTool, createModelBroker, createReadOnlyTools, createReadTool, createSyntheticSourceInfo, createWriteTool, CredentialSynchronizationError, CustomEditor, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DefaultResourceLoader, defineTool, DynamicBorder, EditOperations, EditToolDetails, Extension, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory, ExtensionRuntime, ExtensionUIContext, ExternalAgentConnector, formatSize, getAgentDir, getDocsPath, getExamplesPath, getLanguageFromPath, getMarkdownTheme, getPackageDir, getReadmePath, getSettingsListTheme, highlightCode, InlineExtension, InputSource, InteractiveMode, isBashToolResult, isToolCallEventType, JsonAgentSessionEvent, KeybindingsManager, keyHint, listSessions, LoadExtensionsResult, MCPAuthStartOptions, MCPAuthStartResult, MCPCredentialStatus, ModelBroker, ModelCycleResult, ModelRegistry, ModelRuntime, parseFrontmatter, ProjectTrustEventResult, PromptOptions, PromptTemplate, ReadOperations, ReadToolDetails, resolveCliModel, resolveModelScopeWithDiagnostics, ResourceLoader, RpcClient, RpcSessionInfo, RpcSessionSearchOptions, runPrintMode, RunReceipt, RunRecord, runRpcMode, serializeConversation, SessionBeforeSwitchEvent, SessionEntry, SessionInfo, SessionListOptions, SessionMessageEntry, SettingsManager, Skill, SlashCommandInfo, TaskGateRecord, Theme, Tool, ToolDefinition, ToolExecutionMode, ToolInfo, truncateHead, truncateLine, truncateTail, TruncationResult, VERSION, withFileMutationQueue, WorkingIndicatorOptions, WriteOperations
```

## `aos-agent/external-connector`

This subpath contains the application-facing External Connector contracts for
registry composition, trusted target configuration, canonical input admission,
model projection, and packaged driver loading. It does not export package-smoke
fixtures.

```text
buildExternalConnectorTargetConfig, CANONICAL_EXTERNAL_AGENT_INPUT_HARD_LIMITS, CANONICAL_EXTERNAL_AGENT_INPUT_SCHEMA_VERSION, CanonicalExternalAgentArtifactReadHandle, CanonicalExternalAgentArtifactReference, CanonicalExternalAgentInput, createExternalConnectorRegistry, EXTERNAL_CONNECTOR_PROVIDER_CLASSES, EXTERNAL_CONNECTOR_TARGET_CONFIG_SCHEMA_VERSION, ExternalAgentArtifactInspection, ExternalAgentConnector, ExternalAgentInputAdmissionOptions, ExternalAgentInputError, ExternalConnectorAccountReference, ExternalConnectorCapabilityCeiling, ExternalConnectorCapabilityNarrowing, ExternalConnectorDescriptor, ExternalConnectorModelAccess, ExternalConnectorProviderClass, ExternalConnectorReadinessStatus, ExternalConnectorRegistration, ExternalConnectorRegistry, ExternalConnectorResolvedSelection, ExternalConnectorResolvedTarget, ExternalConnectorSelection, ExternalConnectorTargetAuthority, ExternalConnectorTargetCatalogConfig, ExternalConnectorTargetConfig, ExternalConnectorTargetConfigBuildOptions, ExternalConnectorTargetConfigError, ExternalConnectorTargetConfigErrorReason, ExternalConnectorTargetDefinition, ExternalConnectorTargetSelectionConfig, ExternalConnectorTargetSelectionSource, ExternalConnectorTrustedTarget, ExternalModelFallbackDecision, ExternalModelProjectionGateInput, ExternalModelProjectionGateResult, ExternalResolvedModelProjection, fingerprintCanonicalExternalAgentInput, gateCanonicalExternalAgentInputBeforeAcceptance, isExternalConnectorSelection, loadPackagedExternalAgentDriver, PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES, PackagedExternalAgentDriver, PackagedExternalAgentDriverAssetError, PackagedExternalAgentDriverAssetErrorCode, PackagedExternalAgentDriverLifecycle, PackagedExternalAgentDriverName, PackagedExternalAgentDriverOperation, PackagedExternalAgentDriverOperationKind, PackagedExternalAgentDriverReceipt, PackagedExternalAgentDriverToolResult, projectExternalModelForExecution, resolveExternalConnectorTargetConfig, serializeExternalConnectorSelection, validateCanonicalExternalAgentInput
```

## `aos-agent/external-connector/testing`

This test-support subpath is for package-boundary checks. The package smoke test
consumes `runPackagedExternalAgentDriverFixture`; its result is described by
`PackagedExternalAgentDriverTrace`. Application code should use the main
External Connector subpath instead.

```text
PackagedExternalAgentDriverTrace, runPackagedExternalAgentDriverFixture
```
