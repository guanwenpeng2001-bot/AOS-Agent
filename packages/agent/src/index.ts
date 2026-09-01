export { agentLoop, agentLoopContinue } from "./agent-loop.ts";
export { Agent } from "./agent.ts";
export { AgentHarness } from "./harness/agent-harness.ts";
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
export {
	InMemoryArtifactBlobStore,
	artifactDigestFromId,
	isValidArtifactDigest,
	isValidArtifactId,
} from "./harness/artifacts.ts";
export type { ArtifactDigest } from "./harness/artifacts.ts";
export { contextSnapshotFromJSON, createContextSnapshot } from "./harness/context/snapshot.ts";
export type {
	ContextForkMode,
	ContextSnapshot,
	ContextSnapshotRecord,
	ContextSnapshotSource,
	TaskContextPackage,
} from "./harness/context/snapshot.ts";
export { createOrderedBindingEpoch, validateImmutableAgentBinding } from "./harness/foundation/binding.ts";
export {
	BudgetSchema,
	BudgetUsageSchema,
	budgetExhaustionReason,
	validateBudget,
	validateBudgetUsage,
} from "./harness/foundation/budget.ts";
export type { Budget, BudgetUsage } from "./harness/foundation/budget.ts";
export {
	validateAttemptReceiptForProvider,
	validateConnectorCapabilitySnapshotForProvider,
	validateWorkerReceiptForProvider,
} from "./harness/foundation/conformance.ts";
export {
	EXTERNAL_ERROR_CODES,
	EXTERNAL_ERROR_MESSAGES,
	FOUNDATION_ERROR_CODES,
	FoundationError,
	redactText,
} from "./harness/foundation/errors.ts";
export type {
	ExternalErrorCode,
	FoundationErrorCode,
	PublicExecutionError,
	PublicExecutionErrorCategory,
} from "./harness/foundation/errors.ts";
export {
	createDurableEvent,
	validateDurableEvent,
	validateEventPayloadForCategory,
} from "./harness/foundation/event-catalog.ts";
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
export { executeOperation } from "./harness/foundation/execution.ts";
export type { DispatchExecutionResult } from "./harness/foundation/execution.ts";
export { ScopedExecutionGateway } from "./harness/foundation/gateway.ts";
export {
	validateAsk,
	validateGoal,
	validatePlan,
	validateStage,
	validateTaskResultRef,
	validateTodo,
} from "./harness/foundation/goal.ts";
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
	canonicalFoundationJson,
	createExecutionCorrelation,
	fingerprintFoundationValue,
	newFoundationId,
	sha256HexValue,
} from "./harness/foundation/identity.ts";
export type { ExecutionCorrelation, Fingerprint } from "./harness/foundation/identity.ts";
export { cloneDeepFrozen } from "./harness/foundation/immutability.ts";
export { decodeLegacyFoundationRecordV1 } from "./harness/foundation/migrations/legacy-foundation-schema.ts";
export {
	projectMcpSelectionToSelector,
	resolveMcpSelection,
	validateChildMcpSelection,
	validateMcpSelection,
	validateMcpSelectionForBinding,
} from "./harness/foundation/mcp-selection.ts";
export type { McpCapabilityBinding, McpSelection, McpToolRoute } from "./harness/foundation/mcp-selection.ts";
export { validateSecretFreeModelProfile } from "./harness/foundation/model-profile.ts";
export { FoundationObserver } from "./harness/foundation/observer.ts";
export type { ObserverCursor } from "./harness/foundation/observer.ts";
export type { PluginContract } from "./harness/foundation/plugin.ts";
export type { ProfileContract } from "./harness/foundation/profile.ts";
export {
	PROTOCOL_VERSION,
	authenticateConnection,
	negotiateProtocol,
	validateEndpointSecurity,
} from "./harness/foundation/protocol.ts";
export type {
	EndpointKind,
	EndpointSecurityVerdict,
	ProtocolCapabilities,
	ProtocolFeature,
	ProtocolNegotiation,
} from "./harness/foundation/protocol.ts";
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
	ArtifactRefSchema,
	ResourceSelectorSchema,
	RevisionReferenceSchema,
	selectorsNarrow,
	validateArtifactRef,
	validateVersionedReference,
} from "./harness/foundation/reference.ts";
export type {
	ArtifactRef,
	ResourceSelector,
	RevisionReference,
	VersionedReference,
	WorkerReceiptRef,
} from "./harness/foundation/reference.ts";
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
export { ROLE_RESOLUTION_ORDER } from "./harness/foundation/role-registry.ts";
export type { RoleRegistry } from "./harness/foundation/role-registry.ts";
export {
	ModelRouteSchema,
	createAgentInstance,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	resolveAgentBinding,
	validateAgentBinding,
	validateAgentInstance,
	validateBindingEpoch,
	validateRoleRevision,
} from "./harness/foundation/role.ts";
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
	FingerprintSchema,
	parseExactShape,
	serializeExactShape,
	validateExactShape,
	validateExecutionCorrelation,
	validateFingerprint,
} from "./harness/foundation/schema.ts";
export type { FoundationEnvelope } from "./harness/foundation/schema.ts";
export type { ServiceContract } from "./harness/foundation/service.ts";
export { SessionLedger } from "./harness/foundation/session-ledger.ts";
export { LayeredResultSettlement, persistTaskEnvelopeBeforeResolver } from "./harness/foundation/settlement.ts";
export type { CanonicalRunResult, DispatchStartResult } from "./harness/foundation/settlement.ts";
export { isSideEffectRetryable } from "./harness/foundation/side-effect.ts";
export type { Idempotency, SideEffectState } from "./harness/foundation/side-effect.ts";
export {
	TaskEnvelopePublicProjectionSchema,
	createAttempt,
	createTaskEnvelope,
	projectTaskEnvelope,
	validateAttempt,
	validateDispatch,
	validateSpawnAgentIntent,
	validateTaskEnvelope,
	validateTaskEnvelopePublicProjection,
} from "./harness/foundation/task.ts";
export type {
	Attempt,
	Dispatch,
	TaskArtifactProjection,
	TaskEnvelope,
	TaskEnvelopePublicProjection,
} from "./harness/foundation/task.ts";
export { MemoryError, ScopedMemoryStore } from "./harness/memory/memory.ts";
export type { MemoryProvenanceBoundary } from "./harness/memory/memory.ts";
export {
	bashExecutionToText,
	convertToLlm,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./harness/messages.ts";
export { formatPromptTemplateInvocation, parseCommandArgs } from "./harness/prompt-templates.ts";
export { Result } from "./harness/result.ts";
export type { ResultValue } from "./harness/result.ts";
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
export { SessionLedgerWriter } from "./harness/session/ledger-writer.ts";
export type { SessionLedgerWriterOptions } from "./harness/session/ledger-writer.ts";
export { InMemorySessionRepo, InMemorySessionStorage } from "./harness/session/memory.ts";
export { getFileSystemResultOrThrow } from "./harness/session/search.ts";
export type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "./harness/session/search.ts";
export { Session, assertJsonSerializable } from "./harness/session/session.ts";
export { SessionError } from "./harness/session/types.ts";
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
export { formatSkillInvocation } from "./harness/skills.ts";
export { formatSkillsForSystemPrompt } from "./harness/system-prompt.ts";
export {
	FoundationToolGatewayAuthority,
	createFoundationToolGateway,
	createFoundationToolGatewayAuthority,
	createSandboxOperationToolGatewayProvider,
	isToolGatewayRoute,
} from "./harness/tool-gateway.ts";
export type { ToolGatewayProvider, ToolGatewayRoute, ToolGatewayRouteCatalog } from "./harness/tool-gateway.ts";
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
export { FileError, getOrThrow, ok, toError } from "./harness/types.ts";
export type { AgentHarnessTool, ExecutionEnv, FileSystem } from "./harness/types.ts";
export { truncateHead } from "./harness/utils/truncate.ts";
export { AgentOperationError, createAgentOperationSignal } from "./operation-signal.ts";
export type { AgentOperationSignal } from "./operation-signal.ts";
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
