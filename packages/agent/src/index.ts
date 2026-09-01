export type {
	OtlpHttpTelemetryDiagnostic,
	OtlpHttpTelemetryOptions,
	OtlpHttpTelemetryStats,
	TelemetryContext,
} from "@aos-agent/telemetry";
export { NOOP_TELEMETRY_CONTEXT, OtlpHttpTelemetryContext } from "@aos-agent/telemetry";
export { Agent } from "./agent.ts";
export { agentLoop, agentLoopContinue } from "./agent-loop.ts";
export type {
	AgentHarnessFoundationExecution,
	AgentHarnessOptions,
	HarnessCompactionHookInput,
	HarnessCompactionHookResult,
	HarnessCompactionResult,
	HarnessContextPreparationInput,
	HarnessModelCallBoundaryInput,
	HarnessTool,
	RunOutcome,
} from "./harness/agent-harness.ts";
export { AgentHarness } from "./harness/agent-harness.ts";
export type { ArtifactDigest } from "./harness/artifacts.ts";
export {
	artifactDigestFromId,
	InMemoryArtifactBlobStore,
	isValidArtifactDigest,
	isValidArtifactId,
} from "./harness/artifacts.ts";
export type {
	ContextForkMode,
	ContextSnapshot,
	ContextSnapshotRecord,
	ContextSnapshotSource,
	TaskContextPackage,
} from "./harness/context/snapshot.ts";
export { contextSnapshotFromJSON, createContextSnapshot } from "./harness/context/snapshot.ts";
export { createOrderedBindingEpoch, validateImmutableAgentBinding } from "./harness/foundation/binding.ts";
export type { Budget, BudgetUsage } from "./harness/foundation/budget.ts";
export {
	BudgetSchema,
	BudgetUsageSchema,
	budgetExhaustionReason,
	validateBudget,
	validateBudgetUsage,
} from "./harness/foundation/budget.ts";
export {
	validateAttemptReceiptForProvider,
	validateConnectorCapabilitySnapshotForProvider,
	validateWorkerReceiptForProvider,
} from "./harness/foundation/conformance.ts";
export type {
	ExternalErrorCode,
	FoundationErrorCode,
	PublicExecutionError,
	PublicExecutionErrorCategory,
} from "./harness/foundation/errors.ts";
export {
	EXTERNAL_ERROR_CODES,
	EXTERNAL_ERROR_MESSAGES,
	FOUNDATION_ERROR_CODES,
	FoundationError,
	redactText,
} from "./harness/foundation/errors.ts";
export type {
	DurableEventCategory,
	DurableEventEnvelope,
	EventCorrelationRef,
	FoundationEventEnvelope,
	FoundationJsonValue,
	SchedulerClaimEventPayload,
	SchedulerDeadlockEventPayload,
	SchedulerDispatchEventPayload,
	SchedulerHandoffEventPayload,
	SchedulerQueueEventPayload,
	SchedulerWakeEventPayload,
} from "./harness/foundation/event-catalog.ts";
export {
	createDurableEvent,
	validateDurableEvent,
	validateEventPayloadForCategory,
} from "./harness/foundation/event-catalog.ts";
export type { DispatchExecutionResult } from "./harness/foundation/execution.ts";
export { executeOperation } from "./harness/foundation/execution.ts";
export { ScopedExecutionGateway } from "./harness/foundation/gateway.ts";
export type {
	AcceptanceCriterion,
	AcceptanceFact,
	Ask,
	AskReply,
	AskStatus,
	Goal,
	Plan,
	PlanStatus,
	Stage,
	StageStatus,
	TaskResultRef,
	Todo,
	TodoStatus,
} from "./harness/foundation/goal.ts";
export {
	validateAsk,
	validateGoal,
	validatePlan,
	validateStage,
	validateTaskResultRef,
	validateTodo,
} from "./harness/foundation/goal.ts";
export type { ExecutionCorrelation, Fingerprint } from "./harness/foundation/identity.ts";
export {
	canonicalFoundationJson,
	createExecutionCorrelation,
	fingerprintFoundationValue,
	newFoundationId,
	sha256HexValue,
} from "./harness/foundation/identity.ts";
export { cloneDeepFrozen } from "./harness/foundation/immutability.ts";
export type { McpCapabilityBinding, McpSelection, McpToolRoute } from "./harness/foundation/mcp-selection.ts";
export {
	projectMcpSelectionToSelector,
	resolveMcpSelection,
	validateChildMcpSelection,
	validateMcpSelection,
	validateMcpSelectionForBinding,
} from "./harness/foundation/mcp-selection.ts";
export { decodeLegacyFoundationRecordV1 } from "./harness/foundation/migrations/legacy-foundation-schema.ts";
export { createSecretFreeModelProfile, validateSecretFreeModelProfile } from "./harness/foundation/model-profile.ts";
export type { ObserverCursor } from "./harness/foundation/observer.ts";
export { FoundationObserver } from "./harness/foundation/observer.ts";
export type { PluginContract } from "./harness/foundation/plugin.ts";
export type { ProfileContract } from "./harness/foundation/profile.ts";
export type {
	EndpointKind,
	EndpointSecurityVerdict,
	ProtocolCapabilities,
	ProtocolFeature,
	ProtocolNegotiation,
} from "./harness/foundation/protocol.ts";
export {
	authenticateConnection,
	negotiateProtocol,
	PROTOCOL_VERSION,
	validateEndpointSecurity,
} from "./harness/foundation/protocol.ts";
export type {
	ArtifactStoreProvider,
	ChildAgentProvider,
	ChildSpawnRequest,
	ChildSpawnResult,
	ConnectorCapabilitySnapshot,
	ExecutionProviderDescriptor,
	ExternalAgentConnector,
	FoundationProviderCapability,
	FoundationProviderExecutionOptions,
	QuotaAttribution,
	QuotaProvider,
	QuotaReservation,
	SandboxOperationProvider,
	SandboxOperationRequest,
	SchedulerTaskExecutorProvider,
	ScopedModelGateway,
	TaskExecutorAttemptContext,
	TaskExecutorProvider,
	ToolExecutionResult,
	ToolGateway,
	ToolGatewayRequest,
} from "./harness/foundation/providers.ts";
export {
	createConnectorCapabilitySnapshot,
	validateChildSpawnRequest,
	validateConnectorCapabilitySnapshot,
	validateFoundationProviderCapability,
	validateProviderJson,
	validateQuotaAttribution,
	validateQuotaReservation,
	validateSandboxOperationRequest,
	validateToolExecutionResult,
	validateToolGatewayRequest,
} from "./harness/foundation/providers.ts";
export type {
	ArtifactRef,
	ResourceSelector,
	RevisionReference,
	VersionedReference,
	WorkerReceiptRef,
} from "./harness/foundation/reference.ts";
export {
	ArtifactRefSchema,
	ResourceSelectorSchema,
	RevisionReferenceSchema,
	selectorsNarrow,
	validateArtifactRef,
	validateVersionedReference,
} from "./harness/foundation/reference.ts";
export type {
	AttemptReceipt,
	AttemptReceiptUsage,
	ResultProvenance,
	ResultValidation,
	RunReceipt,
	SettleTaskResultInput,
	TaskResult,
	ValidationResult,
	WorkerReceipt,
} from "./harness/foundation/results.ts";
export {
	createHostTerminalGateAuthority,
	validateAttemptReceipt,
	validateAttemptReceiptUsage,
	validatePublicExecutionError,
	validateRunReceipt,
	validateTaskResult,
	validateWorkerReceipt,
} from "./harness/foundation/results.ts";
export type {
	AgentBinding,
	AgentInstance,
	BindingEpoch,
	ModelProfile,
	ModelRoute,
	RoleDefinition,
	RoleRevision,
} from "./harness/foundation/role.ts";
export {
	createAgentInstance,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	ModelRouteSchema,
	resolveAgentBinding,
	validateAgentBinding,
	validateAgentInstance,
	validateBindingEpoch,
	validateRoleRevision,
} from "./harness/foundation/role.ts";
export type {
	RoleDefinitionPatch,
	RoleRegistry,
	RoleRegistryRecord,
	RoleResolutionLayer,
	RoleResolutionPreview,
	RoleResolveInput,
	RoleTombstone,
} from "./harness/foundation/role-registry.ts";
export {
	InMemoryRoleRegistry,
	ROLE_RESOLUTION_ORDER,
	resolveRoleResolution,
	validateRoleSelectorTightening,
} from "./harness/foundation/role-registry.ts";
export type { ModelProfileRecord } from "./harness/foundation/role-registry-store.ts";
export { DurableModelProfileStore, DurableRoleRegistry } from "./harness/foundation/role-registry-store.ts";
export type { FoundationEnvelope } from "./harness/foundation/schema.ts";
export {
	FingerprintSchema,
	parseExactShape,
	serializeExactShape,
	validateExactShape,
	validateExecutionCorrelation,
	validateFingerprint,
} from "./harness/foundation/schema.ts";
export type { ServiceContract } from "./harness/foundation/service.ts";
export { SessionLedger } from "./harness/foundation/session-ledger.ts";
export type { CanonicalRunResult, DispatchStartResult } from "./harness/foundation/settlement.ts";
export { LayeredResultSettlement, persistTaskEnvelopeBeforeResolver } from "./harness/foundation/settlement.ts";
export type { Idempotency, SideEffectState } from "./harness/foundation/side-effect.ts";
export { isSideEffectRetryable } from "./harness/foundation/side-effect.ts";
export type {
	Attempt,
	Dispatch,
	TaskArtifactProjection,
	TaskEnvelope,
	TaskEnvelopePublicProjection,
} from "./harness/foundation/task.ts";
export {
	createAttempt,
	createTaskEnvelope,
	projectTaskEnvelope,
	TaskEnvelopePublicProjectionSchema,
	validateAttempt,
	validateDispatch,
	validateSpawnAgentIntent,
	validateTaskEnvelope,
	validateTaskEnvelopePublicProjection,
} from "./harness/foundation/task.ts";
export type { MemoryProvenanceBoundary } from "./harness/memory/memory.ts";
export { MemoryError, ScopedMemoryStore } from "./harness/memory/memory.ts";
export {
	bashExecutionToText,
	convertToLlm,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./harness/messages.ts";
export { formatPromptTemplateInvocation, parseCommandArgs } from "./harness/prompt-templates.ts";
export type { ResultValue } from "./harness/result.ts";
export { Result } from "./harness/result.ts";
export type {
	DurableTaskResultToolRecord,
	FileChangeArtifactWrite,
	TaskResultProducerInput,
	TaskResultProducerOutput,
} from "./harness/result-producers.ts";
export {
	aggregateTaskResultProducers,
	isValidationCommand,
	loadDurableFinalAssistantText,
	loadDurableTaskResultToolRecords,
	TASK_RESULT_SUMMARY_MAX_LENGTH,
	writeTaskResultArtifact,
} from "./harness/result-producers.ts";
export { parseFoundationMutation } from "./harness/session/durable/codec.ts";
export { DurableLedgerError, invalidDurableRecord } from "./harness/session/durable/errors.ts";
export { FoundationLedgerState } from "./harness/session/durable/state.ts";
export type {
	AcquireWriterLeaseOptions,
	AppendFoundationRecordResult,
	DurableLedgerApi,
	FoundationFactRecord,
	FoundationObjectResult,
	FoundationRecord,
	FoundationRecordQuery,
	FoundationRetentionPolicy,
	LedgerWriterLease,
	ProvisionedFoundationRecord,
	ReleaseWriterLeaseOptions,
	RenewWriterLeaseOptions,
	SetRetentionPolicyOptions,
} from "./harness/session/durable/types.ts";
export type { SessionLedgerWriterOptions } from "./harness/session/ledger-writer.ts";
export { SessionLedgerWriter } from "./harness/session/ledger-writer.ts";
export { InMemorySessionRepo, InMemorySessionStorage } from "./harness/session/memory.ts";
export type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "./harness/session/search.ts";
export { getFileSystemResultOrThrow } from "./harness/session/search.ts";
export { assertJsonSerializable, Session } from "./harness/session/session.ts";
export type {
	BranchBounds,
	Entry,
	EntryOrder,
	EntryQuery,
	ForkOptions,
	LanePointer,
	LaneRecord,
	LogItem,
	LogOptions,
	MessageEntry,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordQuery,
	SessionCreateOptions,
	SessionMetadata,
	SessionRepo,
	SessionStats,
	SessionStorage,
	StepAttemptRecord,
} from "./harness/session/types.ts";
export { SessionError } from "./harness/session/types.ts";
export { formatSkillInvocation } from "./harness/skills.ts";
export { formatSkillsForSystemPrompt } from "./harness/system-prompt.ts";
export type { ToolGatewayProvider, ToolGatewayRoute, ToolGatewayRouteCatalog } from "./harness/tool-gateway.ts";
export {
	createFoundationToolGateway,
	createFoundationToolGatewayAuthority,
	createSandboxOperationToolGatewayProvider,
	FoundationToolGatewayAuthority,
	isToolGatewayRoute,
} from "./harness/tool-gateway.ts";
export {
	FOUNDATION_TOOL_RESULT_CUSTOM_TYPE,
	validateAndVerifyToolReceipt,
	validateFoundationToolResultEntry,
} from "./harness/tool-pipeline.ts";
export { createBashTool } from "./harness/tools/bash.ts";
export { createEditTool } from "./harness/tools/edit.ts";
export { createReadTool } from "./harness/tools/read.ts";
export type { ExecutionToolContext } from "./harness/tools/tool-context.ts";
export { createWriteTool } from "./harness/tools/write.ts";
export type { AgentHarnessTool, ExecutionEnv, FileSystem } from "./harness/types.ts";
export { FileError, getOrThrow, ok, toError } from "./harness/types.ts";
export { truncateHead } from "./harness/utils/truncate.ts";
export type { AgentOperationSignal } from "./operation-signal.ts";
export { AgentOperationError, createAgentOperationSignal } from "./operation-signal.ts";
export { streamProxy } from "./proxy.ts";
export { setDefaultStreamFn } from "./stream-fn.ts";
export type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	PrepareNextTurnContext,
	QueueMode,
	StreamFn,
	ThinkingLevel,
	ToolExecutionMode,
} from "./types.ts";
