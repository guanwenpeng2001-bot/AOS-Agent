// Core Agent

export { uuidv7 } from "@aos-agent/ai";
export type {
	AttributeValue,
	ExactTelemetryAttributes,
	InferEventAttributes,
	InferOptionalAttributes,
	InferRequiredAndOptionalAttributes,
	InferStartAttributes,
	RecordedTelemetryEvent,
	RecordedTelemetrySpan,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanAttributes as TelemetrySpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@aos-agent/telemetry";
export {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
} from "@aos-agent/telemetry";
export * from "./agent.ts";
// Loop functions
export * from "./agent-loop.ts";
export {
	AGENT_LOOP_ERROR_CATEGORIES,
	AGENT_LOOP_ERROR_CODES,
	classifyAgentLoopError,
	classifyAssistantMessageError,
	decideAgentLoopRetry,
	getAgentLoopErrorMessage,
	redactedThrownAgentError,
	redactAgentLoopErrorMessage,
	type AgentLoopErrorCategory,
	type AgentLoopErrorClassification,
	type AgentLoopErrorCode,
	type AgentLoopErrorOptions,
	type AgentLoopErrorSideEffect,
	type AgentLoopProviderKind,
	type AgentLoopProviderPhase,
	type AgentLoopRetryDecision,
	type AgentLoopRetryDecisionReason,
	type AgentLoopRetryOptions,
	type AgentLoopRetryCallbacks,
} from "./agent-errors.ts";
export {
	AgentLoopConvergenceGuard,
	DEFAULT_AGENT_LOOP_CONVERGENCE,
	createAgentLoopConvergenceGuard,
	fingerprintAgentTurn,
	type AgentLoopConvergenceDecision,
	type AgentLoopConvergenceObservation,
	type AgentLoopConvergenceOptions,
	type AgentLoopConvergenceReason,
	type AgentLoopConvergenceState,
} from "./loop-convergence.ts";
export {
	AgentDeadlineExceeded,
	AgentOperationError,
	createAgentOperationSignal,
	raceWithAbortSignal,
	type AgentOperationSignal,
	type AgentOperationSignalOptions,
} from "./operation-signal.ts";
export * from "./harness/agent-harness.ts";
// Foundation modular public contracts are the single identity/event/protocol authority.
export * from "./harness/foundation/index.ts";
export * from "./harness/foundation-capabilities.ts";
export * from "./harness/artifacts.ts";
export * from "./harness/context/index.ts";
export * from "./harness/memory/index.ts";
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
export {
	type CompactionPreparation,
	type CompactionSettings,
	type CompactResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
// Foundation v1 runtime contracts
export * from "./harness/profile.ts";
export * from "./harness/plugins.ts";
export * from "./harness/runtime-services.ts";
export * from "./harness/tool-gateway.ts";
export * from "./harness/tool-pipeline.ts";
// Harness
export * from "./harness/result.ts";
export * from "./harness/session/index.ts";
export * from "./harness/session/search.ts";
export * from "./harness/skills.ts";
export * from "./harness/system-prompt.ts";
export type {
	AiSpan,
	AiSpanAttributes,
	AiSpanEndAttributes,
	AiSpanEventAttributes,
	AiSpanEventName,
	AiSpanName,
	AiSpanStartAttributes,
	AiTelemetrySpan,
	HarnessSpan,
	HarnessSpanAttributes,
	HarnessSpanEndAttributes,
	HarnessSpanEventAttributes,
	HarnessSpanEventName,
	HarnessSpanName,
	HarnessSpanStartAttributes,
	HarnessTelemetrySpan,
} from "./harness/telemetry.ts";
export {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	HARNESS_TELEMETRY_SCHEMA,
	startAiSpan,
	startHarnessSpan,
} from "./harness/telemetry.ts";
export * from "./harness/tools/index.ts";
export {
	type AgentHarnessResources,
	type AgentHarnessStreamOptions,
	type AgentHarnessStreamOptionsPatch,
	type AgentHarnessTool,
	type AgentHarnessToolContextSource,
	type HarnessCancellation,
	type HarnessCancellationOptions,
	type HarnessOperationContext,
	type HarnessProviderCallback,
	type HarnessProviderContext,
	type HarnessProviderErrorCategory,
	type HarnessProviderErrorClassification,
	type HarnessProviderErrorOptions,
	type HarnessProviderKind,
	type HarnessProviderPhase,
	type HarnessRetryDecision,
	type HarnessRetryDecisionReason,
	type HarnessRetryOptions,
	type HarnessSideEffectState,
	BranchSummaryError,
	type BranchSummaryErrorCode,
	CompactionError,
	type CompactionErrorCode,
	type ExecutionEnv,
	ExecutionError,
	type ExecutionErrorCode,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileSystem,
	HarnessDeadlineExceeded,
	classifyHarnessProviderError,
	createHarnessCancellation,
	createHarnessProviderContext,
	decideHarnessRetry,
	getOrThrow,
	getOrUndefined,
	ok,
	type PromptTemplate,
	type Shell,
	type ShellExecOptions,
	type Skill,
	toError,
	invokeHarnessProvider,
} from "./harness/types.ts";
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";
// Proxy utilities
export * from "./proxy.ts";
// Stream defaults
export { setDefaultStreamFn } from "./stream-fn.ts";
// Types
export * from "./types.ts";
