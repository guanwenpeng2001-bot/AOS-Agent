import { Type } from "typebox";
import type { TSchema } from "typebox";
import {
	FoundationError,
	publicExecutionError,
	redactProjection,
	redactText,
	toFoundationError,
	type FoundationErrorCode,
	type PublicExecutionError,
} from "./foundation/errors.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, newFoundationId, type ExecutionCorrelation, type Fingerprint } from "./foundation/identity.ts";
import type { BudgetUsage, Budget } from "./foundation/budget.ts";
import {
	selectorsNarrow,
	type ArtifactRef,
	type ResourceSelector,
	type RevisionReference,
	type VersionedReference,
} from "./foundation/reference.ts";
import type { AgentBinding, BindingEpoch } from "./foundation/role.ts";
import {
	IDEMPOTENCY_STATES,
	SIDE_EFFECT_STATES,
	isSideEffectRetryable,
	type Idempotency,
	type SideEffectState,
} from "./foundation/side-effect.ts";
import type { QuotaReservation } from "./foundation/providers.ts";
import type {
	AppendFoundationRecordResult,
	FoundationRecordQuery,
	FoundationRecord,
	ProvisionedFoundationRecord,
} from "./session/durable/types.ts";
import { DurableLedgerError } from "./session/durable/errors.ts";
import { Result, type ResultValue } from "./result.ts";
import {
	type ExactShapeIssue,
	FingerprintSchema,
	exactShapeIssues,
	makeExactShapeGuard,
	parseExactShape,
	serializeExactShape,
	validateExactShape,
	FoundationJsonValueSchema,
} from "./foundation/schema.ts";

/** Schema version carried by every tool-pipeline durable fact. */
export const TOOL_PIPELINE_SCHEMA_VERSION = 1 as const;
export type ToolPipelineSchemaVersion = typeof TOOL_PIPELINE_SCHEMA_VERSION;

/** The only legal order for one tool invocation. */
export const TOOL_PIPELINE_STAGES = ["prepare", "pre", "guard", "execute", "post", "finalize"] as const;
export type ToolPipelineStage = (typeof TOOL_PIPELINE_STAGES)[number];

/** Monotonic gate kinds enforced by the guard stage. */
export const TOOL_GATE_KINDS = ["capability", "policy", "approval", "sandbox", "quota", "conflict_lock"] as const;
export type ToolGateKind = (typeof TOOL_GATE_KINDS)[number];

/** Terminal outcomes of a finalized ToolReceipt. */
export const TOOL_RECEIPT_OUTCOMES = ["succeeded", "failed", "blocked", "cancelled", "side_effect_unknown"] as const;
export type ToolReceiptOutcome = (typeof TOOL_RECEIPT_OUTCOMES)[number];

/** Deterministic batch join statuses. */
export const TOOL_BATCH_STATUSES = ["succeeded", "partial_failure", "failed", "cancelled"] as const;
export type ToolBatchStatus = (typeof TOOL_BATCH_STATUSES)[number];

/** Transform provenance kinds for accepted arguments versus original arguments. */
export const TOOL_TRANSFORM_KINDS = ["original", "defaulted", "normalized", "coerced", "removed", "redacted"] as const;
export type ToolArgumentTransformKind = (typeof TOOL_TRANSFORM_KINDS)[number];

/** Frozen revision consumed by one invocation. */
export interface ToolRevision {
	schemaVersion: 1;
	type: "tool_revision";
	id: string;
	revision: number;
	fingerprint?: Fingerprint;
}

/** Frozen binding identity consumed by one invocation. */
export interface ToolBindingRef {
	schemaVersion: 1;
	/** Full durable execution identity. Present for AgentHarness calls. */
	sessionId?: string;
	laneId?: string;
	runId?: string;
	operationId?: string;
	attemptId?: string;
	bindingId: string;
	bindingEpochId: string;
	taskId: string;
	dispatchId?: string;
	providerId?: string;
	agentInstanceId?: string;
}

/** Digests are recorded before and after argument preparation. */
export interface ToolArgumentDigests {
	original: Fingerprint;
	accepted: Fingerprint;
}

/** Durable execution fence armed with the accepted argument digest. */
export interface ToolIntentFence {
	schemaVersion: 1;
	fenceId: string;
	intentId: string;
	bindingEpochId: string;
	acceptedArgumentsDigest: Fingerprint;
	armedAt: string;
}

/** Per-field argument transform provenance. */
export interface ToolTransformProvenance {
	field: string;
	kind: ToolArgumentTransformKind;
	/** Stable identity and revision of the transformer that produced this field. */
	transformerId: string;
	transformerRevision: number;
	beforeDigest: Fingerprint;
	afterDigest: Fingerprint;
}

export interface ToolArgumentTransformer {
	transformerId: string;
	transformerRevision: number;
	transform(args: unknown): unknown;
}

/** Verdict record for one monotonic gate. */
export interface ToolGateRecord {
	kind: ToolGateKind;
	verdict: "allowed" | "denied" | "reserved";
	/** The revision against which this verdict was evaluated. */
	reference: VersionedReference;
	reason?: string;
}

/** Durable pre-call intent. It is written before guard or execute. */
export interface ToolIntent {
	schemaVersion: 1;
	intentId: string;
	toolCallId: string;
	toolName: string;
	namespace?: string;
	toolRevision: ToolRevision;
	binding: ToolBindingRef;
	idempotencyKey?: string;
	argumentDigests: ToolArgumentDigests;
	fence: ToolIntentFence;
	transformProvenance: readonly ToolTransformProvenance[];
	attempt: number;
	writtenAt: string;
}

/** Finalized durable result for one invocation. */
export interface ToolReceipt {
	schemaVersion: 1;
	toolReceiptId: string;
	toolCallId: string;
	toolName: string;
	namespace?: string;
	toolRevision: ToolRevision;
	binding: ToolBindingRef;
	idempotencyKey?: string;
	argumentDigests: ToolArgumentDigests;
	transformProvenance: readonly ToolTransformProvenance[];
	gates: readonly ToolGateRecord[];
	sideEffectState: SideEffectState;
	idempotency: Idempotency;
	attempt: number;
	retried: number;
	startedAt?: string;
	completedAt: string;
	outcome: ToolReceiptOutcome;
	artifacts?: readonly ArtifactRef[];
	usage?: BudgetUsage;
	/** Provider-neutral, JSON-safe result retained for durable dedup replay. */
	result?: ToolResultPayload;
	error?: PublicExecutionError;
	/** Set when this receipt replays an earlier receipt with the same key. */
	deduplicatedFrom?: string;
	digest: Fingerprint;
}

/**
 * Durable projection of an AgentToolResult. It intentionally contains only
 * provider-neutral JSON fields; credentials are rejected before persistence.
 */
export interface ToolResultPayload {
	schemaVersion: 1;
	content: readonly ToolResultContent[];
	details?: FoundationJsonValue;
	usage?: ToolResultUsage;
	addedToolNames?: readonly string[];
	terminate?: boolean;
}

export interface ToolResultTextContent {
	type: "text";
	text: string;
}

export interface ToolResultImageContent {
	type: "image";
	artifact: ArtifactRef;
}

export type ToolResultContent = ToolResultTextContent | ToolResultImageContent;

/** Exact provider-neutral projection of the runtime Usage shape. */
export interface ToolResultUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** Reserved Session custom entry carrying the canonical durable tool result. */
export const FOUNDATION_TOOL_RESULT_CUSTOM_TYPE = "foundation.tool_result";

export interface FoundationToolResultEntry {
	schemaVersion: 1;
	runId: string;
	operationId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	result: ToolResultPayload;
}

/** Maximum canonical size of a durable tool result projection. */
export const TOOL_RESULT_PAYLOAD_MAX_BYTES = 1024 * 1024;

function isDurableResultProjectionSafe(value: unknown): boolean {
	try {
		return canonicalFoundationJson(redactProjection(value)) === canonicalFoundationJson(value);
	} catch (_error) {
		return false;
	}
}

/** One overlapping conflict-key group in a batch. */
export interface ToolConflict {
	keys: readonly string[];
	toolCallIds: readonly string[];
}

/** Deterministic source-order join of a batch. */
export interface ToolBatchResult {
	schemaVersion: 1;
	batchId: string;
	status: ToolBatchStatus;
	receipts: readonly ToolReceipt[];
	usage: BudgetUsage;
	conflicts: readonly ToolConflict[];
	/** Effective concurrency cap for this batch. */
	maxConcurrency: number;
	durationMs: number;
}

/** A tool call submitted to the pipeline. */
export interface ToolCall {
	toolCallId: string;
	toolName: string;
	namespace?: string;
	args: FoundationJsonValue;
	/** Keys are scoped to the frozen binding epoch. */
	idempotencyKey?: string;
	attempt?: number;
}

/** Immutable execution context captured for a pipeline run. */
export interface ToolPipelineContext {
	sessionId: string;
	laneId: string;
	/** Durable operation identity; runId is an alias retained for correlation clarity. */
	runId?: string;
	operationId?: string;
	binding: AgentBinding;
	bindingEpoch: BindingEpoch;
	taskId: string;
	dispatchId?: string;
	providerId?: string;
	attemptId?: string;
	attempt?: number;
	agentInstanceId?: string;
	workspace: string;
	deadlineAt?: number;
}

/** Provider-neutral result produced by a tool. */
export interface ToolExecution {
	ok: boolean;
	sideEffectState: SideEffectState;
	artifacts?: readonly ArtifactRef[];
	usage?: BudgetUsage;
	result?: ToolResultPayload;
	error?: PublicExecutionError;
}

export interface ToolExecuteOptions {
	toolCallId: string;
	signal?: AbortSignal;
	context: ToolPipelineContext;
	attempt: number;
	deadlineAt?: number;
	onUpdate?: (partial: unknown) => void;
}

/**
 * Provider-neutral tool definition. The pipeline snapshots this definition
 * at prepare and never resolves it again during execute or retry.
 */
export interface ToolDefinition {
	name: string;
	namespace?: string;
	label?: string;
	description?: string;
	toolRevision: ToolRevision;
	capabilities: readonly string[];
	parameters: TSchema;
	executionMode?: "sequential" | "parallel";
	prepareArguments?: (args: unknown) => unknown;
	argumentTransformer?: ToolArgumentTransformer;
	/** Provider-neutral read-only hook, evaluated after prepare and before guard. */
	preHook?: ToolPreHook;
	/** Provider-neutral post normalizer; it may only return result/artifacts/usage. */
	postProcessor?: ToolPostProcessor;
	conflictKeys?: (args: Record<string, unknown>) => readonly string[];
	idempotency?: Idempotency;
	execute(args: Record<string, unknown>, options: ToolExecuteOptions): Promise<ToolExecution>;
}

export interface ToolPreHookScope {
	readonly context: Readonly<ToolPipelineContext>;
	readonly tool: Readonly<ToolDefinition>;
	readonly args: Readonly<Record<string, unknown>>;
	readonly intent: Readonly<ToolIntent>;
}

export type ToolPreHookResult = void | boolean | ResultValue<void, FoundationError>;
export type ToolPreHook = (scope: ToolPreHookScope) => ToolPreHookResult | Promise<ToolPreHookResult>;

export interface ToolPostProcessorScope {
	readonly context: Readonly<ToolPipelineContext>;
	readonly tool: Readonly<ToolDefinition>;
	readonly args: Readonly<Record<string, unknown>>;
	readonly intent: Readonly<ToolIntent>;
	readonly execution: Readonly<ToolExecution>;
}

export interface ToolPostNormalization {
	result?: ToolResultPayload;
	artifacts?: readonly ArtifactRef[];
	usage?: BudgetUsage;
}

export type ToolPostProcessor = (scope: ToolPostProcessorScope) => ToolPostNormalization | ResultValue<ToolPostNormalization, FoundationError> | undefined | Promise<ToolPostNormalization | ResultValue<ToolPostNormalization, FoundationError> | undefined>;

export interface ToolDefinitionRegistry {
	resolve(toolName: string, namespace?: string): ResultValue<ToolDefinition, FoundationError>;
}

/** Verdict of one gate check. References must be explicit and versioned. */
export interface ToolGateVerdict {
	allowed: boolean;
	reference: VersionedReference;
	reason?: string;
}

export type ToolGateCheck = (
	scope: ToolGateScope,
) => ResultValue<ToolGateVerdict, FoundationError> | Promise<ResultValue<ToolGateVerdict, FoundationError>>;

/** Everything consulted by a gate. */
export interface ToolGateScope {
	context: ToolPipelineContext;
	tool: ToolDefinition;
	args: Record<string, unknown>;
	intent: ToolIntent;
	acceptedArgsDigest: Fingerprint;
	conflictKeys: readonly string[];
}

/**
 * Guard implementations must not widen a previous denial. `release` is an
 * optional lifecycle hook for conflict locks and quota reservations.
 */
export interface ToolGuardSet {
	guard(scope: ToolGateScope): Promise<ResultValue<readonly ToolGateRecord[], FoundationError>>;
	release?(scope: ToolGateScope): Promise<void> | void;
	cleanup?(): Promise<void> | void;
}

/** Durable storage consumed by the pre and finalize stages. */
export interface ToolPipelineStorage {
	writeIntent(intent: ToolIntent): Promise<ResultValue<ToolIntent, FoundationError>>;
	finalizeReceipt(receipt: ToolReceipt): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>>;
	/** Optional durable snapshots used to recover intents left without a fact. */
	listIntents?(query?: ToolPipelineStorageQuery): Promise<readonly ToolIntent[]>;
	listReceipts?(query?: ToolPipelineStorageQuery): Promise<readonly ToolReceipt[]>;
}

export interface ToolPipelineStorageQuery {
	correlation?: Partial<ExecutionCorrelation>;
}

/** Minimal append/query surface used to keep tool facts in the Session ledger. */
export interface ToolPipelineLedger {
	appendFoundationRecord(record: ProvisionedFoundationRecord): Promise<AppendFoundationRecordResult>;
	findFoundationRecords(query?: FoundationRecordQuery): Promise<FoundationRecord[]>;
}

export interface SessionToolPipelineStorageOptions {
	ledger: ToolPipelineLedger;
	laneId: string;
	correlationFor: (kind: "intent" | "receipt", value: ToolIntent | ToolReceipt) => ExecutionCorrelation;
	/** Supplies the current writer fence for every default ledger append. */
	fencingToken?: () => string | Promise<string>;
}

/** Session-backed storage: intents and receipts share the one Foundation ledger. */
export class SessionToolPipelineStorage implements ToolPipelineStorage {
	private readonly ledger: ToolPipelineLedger;
	private readonly laneId: string;
	private readonly correlationFor: SessionToolPipelineStorageOptions["correlationFor"];
	private readonly fencingToken?: SessionToolPipelineStorageOptions["fencingToken"];

	constructor(options: SessionToolPipelineStorageOptions) {
		this.ledger = options.ledger;
		this.laneId = options.laneId;
		this.correlationFor = options.correlationFor;
		this.fencingToken = options.fencingToken;
	}

	async writeIntent(intent: ToolIntent): Promise<ResultValue<ToolIntent, FoundationError>> {
		try {
			const correlation = validateToolCorrelation(intent, this.correlationFor("intent", intent), this.laneId);
			if (!correlation.ok) return correlation;
			const prior = await this.ledger.findFoundationRecords({ kind: "intent", objectType: "tool_intent", objectId: intent.intentId, includePruned: true, order: "oldestFirst", correlation: correlationQuery(correlation.value) });
			const existing = prior.find((record) => record.kind === "intent");
			if (existing?.payload !== undefined) {
				const checked = validateToolIntent(existing.payload);
				if (!checked.ok) return checked;
				return canonicalFoundationJson(checked.value) === canonicalFoundationJson(intent)
					? Result.ok(checked.value)
					: Result.err(new FoundationError("session_writer_duplicate_request", "durable tool intent identity conflicts with the existing intent"));
			}
			const fencingToken = this.fencingToken === undefined ? undefined : await this.fencingToken();
			const result = await this.ledger.appendFoundationRecord({
				schemaVersion: 1,
				kind: "intent",
				id: `tool_intent:${intent.intentId}`,
				lane: this.laneId,
				objectType: "tool_intent",
				objectId: intent.intentId,
				clientRequestId: `tool-intent:${intent.intentId}`,
				intent: "create",
				payload: intent as unknown as FoundationJsonValue,
				...(fencingToken === undefined ? {} : { fencingToken }),
				correlation: { ...correlation.value, ...(fencingToken === undefined ? {} : { fencingToken }) },
			});
			if (result.record.kind !== "intent" || result.record.payload === undefined) return Result.err(new FoundationError("foundation_schema_invalid_shape", "Session ledger returned an invalid tool intent"));
			const checked = validateToolIntent(result.record.payload);
			return checked;
		} catch (error) {
			return Result.err(toToolPipelineStorageError(error));
		}
	}

	async finalizeReceipt(receipt: ToolReceipt): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>> {
		try {
			const receiptResult = validateAndVerifyToolReceipt(receipt);
			if (!receiptResult.ok) return receiptResult;
			const correlation = validateToolCorrelation(receipt, this.correlationFor("receipt", receipt), this.laneId);
			if (!correlation.ok) return correlation;
			const fencingToken = this.fencingToken === undefined ? undefined : await this.fencingToken();
			const result = await this.ledger.appendFoundationRecord({
				schemaVersion: 1,
				kind: "fact",
				id: `tool_receipt:${receipt.toolReceiptId}`,
				lane: this.laneId,
				objectType: "tool_receipt",
				objectId: receipt.toolReceiptId,
				clientRequestId: `tool-receipt:${receipt.toolReceiptId}`,
				payload: receipt as unknown as FoundationJsonValue,
				...(fencingToken === undefined ? {} : { fencingToken }),
				correlation: { ...correlation.value, ...(fencingToken === undefined ? {} : { fencingToken }) },
			});
			if (result.record.kind !== "fact") return Result.err(new FoundationError("foundation_schema_invalid_shape", "Session ledger returned an invalid tool receipt"));
			return Result.ok({ toolReceiptRef: receipt.toolReceiptId });
		} catch (error) {
			return Result.err(toToolPipelineStorageError(error));
		}
	}

	async listIntents(query?: ToolPipelineStorageQuery): Promise<readonly ToolIntent[]> {
		const records = await this.ledger.findFoundationRecords({ kind: "intent", objectType: "tool_intent", includePruned: true, order: "oldestFirst", ...(query?.correlation === undefined ? {} : { correlation: query.correlation }) });
		return records.filter((record): record is Extract<FoundationRecord, { kind: "intent" }> => record.kind === "intent" && record.payload !== undefined).map((record) => {
			const checked = validateToolIntent(record.payload);
			if (!checked.ok) throw checked.error;
			return checked.value;
		});
	}

	async listReceipts(query?: ToolPipelineStorageQuery): Promise<readonly ToolReceipt[]> {
		const records = await this.ledger.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", includePruned: true, order: "oldestFirst", ...(query?.correlation === undefined ? {} : { correlation: query.correlation }) });
		return records.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact").map((record) => {
			const checked = validateToolReceipt(record.payload);
			if (!checked.ok) throw checked.error;
			return checked.value;
		});
	}
}

function validateToolCorrelation(
	value: ToolIntent | ToolReceipt,
	correlation: ExecutionCorrelation,
	laneId: string,
): ResultValue<ExecutionCorrelation, FoundationError> {
	const binding = value.binding;
	const expected: Array<[keyof ExecutionCorrelation, string | undefined]> = [
		["sessionId", binding.sessionId],
		["laneId", binding.laneId ?? laneId],
		["runId", binding.runId ?? binding.operationId],
		["operationId", binding.operationId ?? binding.runId],
		["taskId", binding.taskId],
		["dispatchId", binding.dispatchId],
		["attemptId", binding.attemptId],
		["bindingId", binding.bindingId],
		["bindingEpochId", binding.bindingEpochId],
		["providerId", binding.providerId],
		["agentInstanceId", binding.agentInstanceId],
		["toolCallId", value.toolCallId],
	];
	for (const [field, expectedValue] of expected) {
		if (expectedValue !== undefined && correlation[field] !== expectedValue) {
			return Result.err(new FoundationError("invalid_correlation", `Tool ${field} correlation does not match its execution identity`));
		}
	}
	return Result.ok(correlation);
}

function correlationQuery(correlation: ExecutionCorrelation): Partial<ExecutionCorrelation> {
	const { revision: _revision, fencingToken: _fencingToken, ...identity } = correlation;
	return identity;
}

function toToolPipelineStorageError(error: unknown): FoundationError {
	if (error instanceof DurableLedgerError) return new FoundationError(error.code as FoundationErrorCode, error.message);
	return toFoundationError(error, "side_effect_unknown");
}

export interface ToolPipelineCleanup {
	release(scope?: ToolGateScope): Promise<void>;
}

/** Host-side quota accounting used by the default quota gate. */
export interface ToolQuotaAccount extends ToolPipelineCleanup {
	reserve(scope: ToolGateScope): ResultValue<VersionedReference, FoundationError>;
	settle(receipt: ToolReceipt): void;
	readonly usage: BudgetUsage;
	readonly reservations: readonly QuotaReservation[];
}

export interface FoundationToolGuardOptions {
	capability?: { check?: ToolGateCheck };
	policy?: { check?: ToolGateCheck };
	approval?: { check?: ToolGateCheck };
	sandbox?: { check?: ToolGateCheck };
	quota?: { account?: ToolQuotaAccount; check?: ToolGateCheck };
	conflictLock?: { check?: ToolGateCheck };
}

export interface ToolPipelineStageEvent {
	stage: ToolPipelineStage;
	toolCallId: string;
}

export interface ToolPipelineOptions {
	registry: ToolDefinitionRegistry;
	guard?: ToolGuardSet;
	storage?: ToolPipelineStorage;
	quotaAccount?: ToolQuotaAccount;
	budget?: Budget;
	maxConcurrency?: number;
	maxToolCalls?: number;
	maxRetries?: number;
	now?: () => string;
	nowMs?: () => number;
	idGenerator?: (prefix: string) => string;
	canonicalizeConflictKey?: (key: string) => string;
	onStage?: (event: ToolPipelineStageEvent) => void | Promise<void>;
}

export function createToolBindingRef(context: ToolPipelineContext): ToolBindingRef {
	return freeze({
		schemaVersion: 1,
		...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
		...(context.laneId === undefined ? {} : { laneId: context.laneId }),
		...(context.runId === undefined ? {} : { runId: context.runId }),
		...(context.operationId === undefined ? {} : { operationId: context.operationId }),
		...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
		bindingId: context.binding.bindingId,
		bindingEpochId: context.bindingEpoch.bindingEpochId,
		taskId: context.taskId,
		...(context.dispatchId === undefined ? {} : { dispatchId: context.dispatchId }),
		...(context.providerId === undefined ? {} : { providerId: context.providerId }),
		...(context.agentInstanceId === undefined ? {} : { agentInstanceId: context.agentInstanceId }),
	});
}

function toVersionedReference(reference: RevisionReference): VersionedReference {
	return freeze({
		schemaVersion: 1,
		type: reference.type,
		id: reference.id,
		revision: reference.revision,
		...(reference.fingerprint === undefined ? {} : { fingerprint: { ...reference.fingerprint } }),
		...(reference.providerId === undefined ? {} : { providerId: reference.providerId }),
	});
}

function capacityReference(context: ToolPipelineContext, type = "agent_binding"): VersionedReference {
	return {
		schemaVersion: 1,
		type,
		id: context.binding.bindingId,
		revision: context.bindingEpoch.ordinal,
	};
}

/** Default capability gate: required tool capabilities must fit the binding selector. */
function defaultCapabilityCheck(scope: ToolGateScope): ResultValue<ToolGateVerdict, FoundationError> {
	const required = scope.tool.capabilities;
	const reference = toVersionedReference(scope.context.binding.capabilityRevision);
	if (required.length === 0) return Result.ok({ allowed: true, reference });
	const requested: ResourceSelector = { policy: "named", named: [...required] };
	const allowed = selectorsNarrow(scope.context.binding.capabilitySelector, requested);
	return Result.ok({
		allowed,
		reference,
		reason: allowed ? undefined : "tool capability is outside the binding capability selector",
	});
}

/** Default storage keeps standalone pipeline use deterministic and testable. */
export class InMemoryToolPipelineStorage implements ToolPipelineStorage {
	readonly intents: ToolIntent[] = [];
	readonly receipts: ToolReceipt[] = [];
	private readonly intentsById = new Map<string, ToolIntent>();
	private readonly receiptsById = new Map<string, ToolReceipt>();

	async writeIntent(intent: ToolIntent): Promise<ResultValue<ToolIntent, FoundationError>> {
		const existing = this.intentsById.get(intent.intentId);
		if (existing !== undefined) {
			return canonicalFoundationJson(existing) === canonicalFoundationJson(intent)
				? Result.ok(existing)
				: Result.err(new FoundationError("session_writer_duplicate_request", "tool intent id was reused with different content"));
		}
		const stored = cloneToolIntent(intent);
		this.intentsById.set(intent.intentId, stored);
		this.intents.push(stored);
		return Result.ok(stored);
	}

	async finalizeReceipt(receipt: ToolReceipt): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>> {
		const receiptResult = validateAndVerifyToolReceipt(receipt);
		if (!receiptResult.ok) return receiptResult;
		const existing = this.receiptsById.get(receipt.toolReceiptId);
		if (existing !== undefined) {
			return canonicalFoundationJson(existing) === canonicalFoundationJson(receipt)
				? Result.ok({ toolReceiptRef: existing.toolReceiptId })
				: Result.err(new FoundationError("session_writer_duplicate_request", "tool receipt id was reused with different content"));
		}
		const stored = cloneToolReceipt(receipt);
		this.receiptsById.set(receipt.toolReceiptId, stored);
		this.receipts.push(stored);
		return Result.ok({ toolReceiptRef: stored.toolReceiptId });
	}

	async listIntents(): Promise<readonly ToolIntent[]> {
		return [...this.intents];
	}

	async listReceipts(): Promise<readonly ToolReceipt[]> {
		return [...this.receipts];
	}
}

export interface FoundationToolQuotaAccountOptions {
	budget?: Budget;
	maxToolCalls?: number;
	idGenerator?: (prefix: string) => string;
	now?: () => string;
}

interface ToolReservationScope {
	bindingId: string;
	bindingEpochId: string;
	toolCallId: string;
}

/**
 * Small single-host quota account. Reservations are made synchronously at the
 * quota gate, so parallel calls cannot race the tool-call limit.
 */
export class FoundationToolQuotaAccount implements ToolQuotaAccount {
	readonly usage: BudgetUsage = {};
	readonly reservations: QuotaReservation[] = [];

	private readonly budget: Budget;
	private readonly maxToolCalls: number | undefined;
	private readonly idGenerator: (prefix: string) => string;
	private readonly now: () => string;
	private readonly reservationKeys = new Map<string, ToolReservationScope>();

	constructor(options: FoundationToolQuotaAccountOptions = {}) {
		this.budget = freeze({ ...(options.budget ?? {}) });
		this.maxToolCalls = options.maxToolCalls;
		this.idGenerator = options.idGenerator ?? ((prefix) => newFoundationId(prefix.replace(/[^a-z0-9-]/gi, "-")));
		this.now = options.now ?? (() => new Date().toISOString());
	}

	reserve(scope: ToolGateScope): ResultValue<VersionedReference, FoundationError> {
		const budget: Budget = freeze(tightenBudget(scope.context.binding.budget, this.budget));
		const scopeKey: ToolReservationScope = { bindingId: scope.context.binding.bindingId, bindingEpochId: scope.context.bindingEpoch.bindingEpochId, toolCallId: scope.intent.toolCallId };
		const existingReservation = this.reservations.find((reservation) => sameReservationScope(this.reservationKeys.get(reservation.reservationId), scopeKey));
		if (existingReservation !== undefined) return Result.ok(capacityReference(scope.context, "tool_quota"));
		const activeForBinding = [...this.reservationKeys.values()].filter((key) => key.bindingId === scopeKey.bindingId && key.bindingEpochId === scopeKey.bindingEpochId).length;
		if (budget.concurrency !== undefined && activeForBinding >= budget.concurrency) {
			return Result.err(new FoundationError("quota_exceeded", "binding concurrency quota exceeded", { details: { toolCallId: scope.intent.toolCallId, active: activeForBinding, limit: budget.concurrency, bindingId: scope.context.binding.bindingId, bindingEpochId: scope.context.bindingEpoch.bindingEpochId } }));
		}
		const nextToolCalls = (this.usage.toolCalls ?? 0) + 1;
		const limit = this.maxToolCalls === undefined || budget.toolCalls === undefined ? this.maxToolCalls ?? budget.toolCalls : Math.min(this.maxToolCalls, budget.toolCalls);
		if (limit !== undefined && nextToolCalls > limit) {
			return Result.err(
				new FoundationError("quota_exceeded", "tool call quota exceeded", {
					details: { toolCallId: scope.intent.toolCallId, nextToolCalls, limit },
				}),
			);
		}
		if (budget.wallClockMs !== undefined && (this.usage.wallClockMs ?? 0) >= budget.wallClockMs) {
			return Result.err(
				new FoundationError("budget_exhausted", "wall clock budget exhausted", {
					details: { toolCallId: scope.intent.toolCallId },
				}),
			);
		}
		this.usage.toolCalls = nextToolCalls;
		const reservation: QuotaReservation = {
			schemaVersion: 1,
			reservationId: this.idGenerator("quota_reservation"),
			attribution: {
				schemaVersion: 1,
				taskId: scope.context.taskId,
				...(scope.context.binding.goalId === undefined ? {} : { goalId: scope.context.binding.goalId }),
				...(scope.context.attemptId === undefined ? {} : { attemptId: scope.context.attemptId }),
				...(scope.context.agentInstanceId === undefined ? {} : { agentInstanceId: scope.context.agentInstanceId }),
				providerId: "host_tool_pipeline",
				ownerKind: "host",
			},
			budget,
			grantedAt: this.now(),
		};
		this.reservations.push(reservation);
		this.reservationKeys.set(reservation.reservationId, scopeKey);
		return Result.ok(capacityReference(scope.context, "tool_quota"));
	}

	settle(receipt: ToolReceipt): void {
		if (receipt.usage === undefined || receipt.deduplicatedFrom !== undefined) return;
		this.usage.tokens = (this.usage.tokens ?? 0) + (receipt.usage.tokens ?? 0);
		this.usage.costUsd = (this.usage.costUsd ?? 0) + (receipt.usage.costUsd ?? 0);
		this.usage.modelCalls = (this.usage.modelCalls ?? 0) + (receipt.usage.modelCalls ?? 0);
		this.usage.wallClockMs = (this.usage.wallClockMs ?? 0) + (receipt.usage.wallClockMs ?? 0);
	}

	async release(scope?: ToolGateScope): Promise<void> {
		if (scope === undefined) {
			this.reservations.splice(0);
			this.reservationKeys.clear();
			return;
		}
		const scopeKey: ToolReservationScope = { bindingId: scope.context.binding.bindingId, bindingEpochId: scope.context.bindingEpoch.bindingEpochId, toolCallId: scope.intent.toolCallId };
		for (let index = this.reservations.length - 1; index >= 0; index -= 1) {
			const reservation = this.reservations[index]!;
			if (!sameReservationScope(this.reservationKeys.get(reservation.reservationId), scopeKey)) continue;
			this.reservationKeys.delete(reservation.reservationId);
			this.reservations.splice(index, 1);
		}
	}
}

function sameReservationScope(left: ToolReservationScope | undefined, right: ToolReservationScope): boolean {
	return left?.bindingId === right.bindingId && left.bindingEpochId === right.bindingEpochId && left.toolCallId === right.toolCallId;
}

/**
 * Default monotonic guard. Denials are sticky for a binding epoch and gate
 * reference; conflict locks are held until the pipeline releases the scope.
 */
export class FoundationToolGuard implements ToolGuardSet {
	private readonly checks: Record<ToolGateKind, ToolGateCheck>;
	private readonly denials = new Map<string, ToolGateRecord>();
	private readonly conflictOwners = new Map<string, string>();
	private readonly quotaAccount: ToolQuotaAccount | undefined;

	constructor(options: FoundationToolGuardOptions = {}) {
		this.quotaAccount = options.quota?.account;
		const deniedByDefault = (kind: ToolGateKind): ToolGateCheck => (scope) => Result.ok({
			allowed: false,
			reference: capacityReference(scope.context, `tool_${kind}`),
			reason: `${kind} guard has no configured authority`,
		});
		const defaultQuota: ToolGateCheck = (scope) => {
			if (this.quotaAccount === undefined) return Result.ok({ allowed: false, reference: capacityReference(scope.context, "tool_quota"), reason: "quota guard has no configured account" });
			const reserved = this.quotaAccount.reserve(scope);
			return reserved.ok
				? Result.ok({ allowed: true, reference: reserved.value })
				: Result.ok({ allowed: false, reference: capacityReference(scope.context, "tool_quota"), reason: reserved.error.message });
		};
		const defaultConflictLock: ToolGateCheck = (scope) => {
			const keys = scope.conflictKeys;
			for (const key of keys) {
				const owner = this.conflictOwners.get(conflictOwnerKey(scope, key));
				if (owner !== undefined && owner !== scope.intent.toolCallId) {
					return Result.ok({
						allowed: false,
						reference: { schemaVersion: 1, type: "conflict_lock", id: key, revision: scope.context.bindingEpoch.ordinal },
						reason: `conflict lock is held by ${owner}`,
					});
				}
			}
			for (const key of keys) this.conflictOwners.set(conflictOwnerKey(scope, key), scope.intent.toolCallId);
			return Result.ok({
				allowed: true,
				reference: { schemaVersion: 1, type: "conflict_lock", id: keys.join(",") || scope.intent.toolCallId, revision: scope.context.bindingEpoch.ordinal },
			});
		};
		this.checks = {
			capability: options.capability?.check ?? defaultCapabilityCheck,
			policy: options.policy?.check ?? deniedByDefault("policy"),
			approval: options.approval?.check ?? deniedByDefault("approval"),
			sandbox: options.sandbox?.check ?? deniedByDefault("sandbox"),
			quota: options.quota?.check ?? defaultQuota,
			conflict_lock: options.conflictLock?.check ?? defaultConflictLock,
		};
	}

	async guard(scope: ToolGateScope): Promise<ResultValue<readonly ToolGateRecord[], FoundationError>> {
		const records: ToolGateRecord[] = [];
		for (const kind of TOOL_GATE_KINDS) {
			const checked = await this.checkKind(kind, scope);
			if (!checked.ok) return checked;
			records.push(checked.value);
			if (checked.value.verdict === "denied") break;
		}
		return Result.ok(freeze(records));
	}

	async release(scope: ToolGateScope): Promise<void> {
		for (const key of scope.conflictKeys) {
			const ownerKey = conflictOwnerKey(scope, key);
			if (this.conflictOwners.get(ownerKey) === scope.intent.toolCallId) this.conflictOwners.delete(ownerKey);
		}
		await this.quotaAccount?.release(scope);
	}

	async cleanup(): Promise<void> {
		this.conflictOwners.clear();
		await this.quotaAccount?.release();
	}

	private async checkKind(kind: ToolGateKind, scope: ToolGateScope): Promise<ResultValue<ToolGateRecord, FoundationError>> {
		let verdict: ResultValue<ToolGateVerdict, FoundationError>;
		try {
			verdict = await this.checks[kind](scope);
		} catch (error) {
			return Result.err(toFoundationError(error, "tool_guard_denied"));
		}
		if (!verdict.ok) return verdict;
		const windowKey = `${scope.context.bindingEpoch.bindingEpochId}:${kind}:${verdict.value.reference.type}:${verdict.value.reference.id}:${verdict.value.reference.revision ?? 0}`;
		const denied = this.denials.get(windowKey);
		if (denied !== undefined) return Result.ok(denied);
		const record: ToolGateRecord = {
			kind,
			verdict: verdict.value.allowed ? kind === "quota" || kind === "conflict_lock" ? "reserved" : "allowed" : "denied",
			reference: freeze({ ...verdict.value.reference }),
			...(verdict.value.reason === undefined ? {} : { reason: verdict.value.reason }),
		};
		if (record.verdict === "denied") this.denials.set(windowKey, record);
		return Result.ok(freeze(record));
	}
}

/** Fixed prepare -> pre -> guard -> execute -> post -> finalize pipeline. */
export class FoundationToolPipeline {
	private readonly registry: ToolDefinitionRegistry;
	private readonly guard: ToolGuardSet;
	private readonly storage: ToolPipelineStorage;
	private readonly budget: Budget;
	private readonly maxConcurrency: number | undefined;
	private readonly maxRetries: number;
	private readonly now: () => string;
	private readonly nowMs: () => number;
	private readonly idGenerator: (prefix: string) => string;
	private readonly canonicalizeConflictKey: (key: string) => string;
	private readonly quotaAccount: ToolQuotaAccount;
	private readonly onStage: ((event: ToolPipelineStageEvent) => void | Promise<void>) | undefined;
	private readonly completedByKey = new Map<string, { receipt: ToolReceipt; signature: string; semantic: string }>();
	private readonly persistedIntents = new Map<string, ToolIntent>();
	private readonly persistedReceipts = new Map<string, ToolReceipt>();
	private readonly recoveredScopes = new Set<string>();

	constructor(options: ToolPipelineOptions) {
		this.registry = options.registry;
		this.storage = options.storage ?? new InMemoryToolPipelineStorage();
		this.budget = freeze({ ...(options.budget ?? {}) });
		this.maxConcurrency = normalizePositiveLimit(options.maxConcurrency ?? this.budget.concurrency);
		this.maxRetries = normalizeNonNegativeInteger(options.maxRetries ?? 0, "maxRetries");
		this.now = options.now ?? (() => new Date().toISOString());
		this.nowMs = options.nowMs ?? Date.now;
		this.idGenerator = options.idGenerator ?? ((prefix) => newFoundationId(prefix.replace(/[^a-z0-9-]/gi, "-")));
		this.canonicalizeConflictKey = options.canonicalizeConflictKey ?? ((key) => key.trim());
		this.quotaAccount = options.quotaAccount ?? new FoundationToolQuotaAccount({ budget: this.budget, maxToolCalls: options.maxToolCalls, idGenerator: this.idGenerator, now: this.now });
		this.guard = options.guard ?? new FoundationToolGuard({ quota: { account: this.quotaAccount } });
		this.onStage = options.onStage;
	}

	/** Single-call convenience API. */
	async execute(
		call: ToolCall,
		context: ToolPipelineContext,
		options: { signal?: AbortSignal; deadlineAt?: number; onUpdate?: (partial: unknown) => void } = {},
	): Promise<ResultValue<ToolReceipt, FoundationError>> {
		const batch = await this.executeBatch([call], context, options);
		if (!batch.ok) return batch;
		const receipt = batch.value.receipts[0];
		return receipt === undefined ? Result.err(new FoundationError("foundation_schema_invalid_shape", "batch produced no receipt")) : Result.ok(receipt);
	}

	/**
	 * Reconcile durable intents that have no durable fact. Recovery never calls
	 * a provider: after an uncertain side effect the only safe outcome is an
	 * explicit side_effect_unknown receipt.
	 */
	async recoverUnsettled(context?: ToolPipelineContext): Promise<ResultValue<readonly ToolReceipt[], FoundationError>> {
		if (this.storage.listIntents === undefined || this.storage.listReceipts === undefined) return Result.ok([]);
		let intents: readonly ToolIntent[];
		let receipts: readonly ToolReceipt[];
		try {
			const query = context === undefined ? undefined : toolStorageQuery(context);
			intents = await this.storage.listIntents(query);
			receipts = await this.storage.listReceipts(query);
		} catch (error) {
			return Result.err(toFoundationError(error, "side_effect_unknown"));
		}
		const recovered: ToolReceipt[] = [];
		for (const intent of intents) {
			const intentResult = validateToolIntent(intent);
			if (!intentResult.ok) return intentResult;
			if (context !== undefined && !toolIdentityMatchesContext(intent, context)) continue;
			const matching = receipts.filter((receipt) => receiptIdentityMatchesIntent(receipt, intent));
			let foundExact = false;
			for (const candidate of matching) {
				const receiptResult = validateAndVerifyToolReceipt(candidate);
				if (!receiptResult.ok) return receiptResult;
				if (receiptMatchesIntent(receiptResult.value, intent)) {
					foundExact = true;
					break;
				}
				return Result.err(new FoundationError("invalid_correlation", "durable tool receipt identity or digest does not match its intent"));
			}
			if (foundExact) continue;
			const receipt = finalizeToolReceipt({
				schemaVersion: 1,
				toolReceiptId: this.idGenerator("tool_recovery_receipt"),
				toolCallId: intent.toolCallId,
				toolName: intent.toolName,
				...(intent.namespace === undefined ? {} : { namespace: intent.namespace }),
				toolRevision: cloneToolRevision(intent.toolRevision),
				binding: intent.binding,
				...(intent.idempotencyKey === undefined ? {} : { idempotencyKey: intent.idempotencyKey }),
				argumentDigests: intent.argumentDigests,
				transformProvenance: intent.transformProvenance,
				gates: [],
				sideEffectState: "side_effect_unknown",
				idempotency: "non_idempotent",
				attempt: intent.attempt,
				retried: 0,
				completedAt: this.now(),
				outcome: "side_effect_unknown",
				error: publicExecutionError("side_effect_unknown", "tool outcome is unknown after a possible side effect", { category: "side_effect_unknown" }),
			});
			let stored: ResultValue<{ toolReceiptRef: string }, FoundationError>;
			try {
				stored = await this.storage.finalizeReceipt(receipt);
			} catch (error) {
				return Result.err(sideEffectUnknownError(error));
			}
			if (!stored.ok) return Result.err(sideEffectUnknownError(stored.error));
			recovered.push(receipt);
			receipts = [...receipts, receipt];
		}
		return Result.ok(recovered);
	}

	async recoverPending(): Promise<ResultValue<readonly ToolReceipt[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async recoverPendingIntents(): Promise<ResultValue<readonly ToolReceipt[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async recover(): Promise<ResultValue<readonly ToolReceipt[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async executeBatch(
		calls: readonly ToolCall[],
		context: ToolPipelineContext,
		options: { signal?: AbortSignal; deadlineAt?: number; onUpdate?: (partial: unknown) => void } = {},
	): Promise<ResultValue<ToolBatchResult, FoundationError>> {
		const startedAt = this.nowMs();
		const batchId = this.idGenerator("tool_batch");
		try {
			const contextCheck = validatePipelineContext(context);
			if (!contextCheck.ok) return contextCheck;
			const recoveryScope = contextRecoveryScope(context);
			if (!this.recoveredScopes.has(recoveryScope)) {
				const recovered = await this.recoverUnsettled(context);
				if (!recovered.ok) return recovered;
				this.recoveredScopes.add(recoveryScope);
			}
			await this.loadPersistentState(context);
			const duplicateCall = findDuplicateCallId(calls);
			if (duplicateCall !== undefined) return Result.err(new FoundationError("invalid_identifier", `duplicate tool call id ${duplicateCall}`));
			if (calls.length === 0) {
				return Result.ok({ schemaVersion: 1, batchId, status: "succeeded", receipts: [], usage: {}, conflicts: [], maxConcurrency: 0, durationMs: elapsed(this.nowMs(), startedAt) });
			}

			const prepared: PreparedCall[] = [];
			for (const call of calls) {
				const entry = await this.prepare(call, context);
				if (!entry.ok) return entry;
				prepared.push(entry.value);
			}
			const conflicts = detectConflicts(prepared);
			const dependencies = computeDependencies(prepared);
			const conflictDependencies = computeConflictDependencies(prepared);
			const receipts = new Array<ToolReceipt | undefined>(prepared.length);
			const settledStates = new Array<SettledCallState | undefined>(prepared.length);
			const errors: FoundationError[] = [];
			const settled = prepared.map(() => deferred<void>());
			const signal = options.signal;
			const bindingConcurrency = context.binding.budget.concurrency;
			const concurrencyCaps = [prepared.length, this.maxConcurrency, this.budget.concurrency, bindingConcurrency].filter((value): value is number => value !== undefined);
			const effectiveConcurrency = Math.max(1, Math.min(...concurrencyCaps));
			let active = 0;
			const nextIndex = { value: 0 };

			const runOne = async (index: number): Promise<void> => {
				const entry = prepared[index]!;
				for (const dependency of dependencies.get(index) ?? []) await settled[dependency]!.promise;
				const dependencyFailure = findConflictDependencyFailure(conflictDependencies.get(index) ?? [], settledStates);
				if (dependencyFailure !== undefined) {
					const blocked = await this.finalize(entry, context, {
						outcome: "blocked",
						sideEffectState: "none",
						error: publicExecutionError(
							"tool_conflict_dependency_blocked",
							`tool call skipped because conflicting call ${prepared[dependencyFailure.index]!.call.toolCallId} did not reach a known safe terminal state`,
							{ category: "permission", retryable: false },
						),
					});
					if (blocked.ok) {
						receipts[index] = blocked.value;
						settledStates[index] = { receipt: blocked.value };
					} else {
						errors.push(blocked.error);
						settledStates[index] = { error: blocked.error };
					}
					settled[index]!.resolve();
					return;
				}
				let scope: ToolGateScope | undefined;
				try {
					if (entry.preHookError !== undefined) {
						const denied = await this.finalize(entry, context, { outcome: "blocked", sideEffectState: "none", error: entry.preHookError });
						if (denied.ok) {
							receipts[index] = denied.value;
							settledStates[index] = { receipt: denied.value };
						} else {
							errors.push(denied.error);
							settledStates[index] = { error: denied.error };
						}
						return;
					}
					if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
						const cancelled = await this.finalize(entry, context, { outcome: signal?.aborted ? "cancelled" : "failed", sideEffectState: "none", error: signal?.aborted ? cancellationError() : deadlineError() });
						if (cancelled.ok) {
							receipts[index] = cancelled.value;
							settledStates[index] = { receipt: cancelled.value };
						} else {
							errors.push(cancelled.error);
							settledStates[index] = { error: cancelled.error };
						}
						return;
					}
					active += 1;
					this.peakConcurrency = Math.max(this.peakConcurrency, active);
					scope = this.scopeFor(entry, context);
					const result = await this.runPrepared(entry, context, signal, scope, options);
					if (result.ok) {
						receipts[index] = result.value;
						settledStates[index] = { receipt: result.value };
					} else {
						errors.push(result.error);
						settledStates[index] = { error: result.error };
					}
				} catch (error) {
					const normalized = toFoundationError(error, "tool_guard_denied");
					const fallback = await this.finalize(entry, context, {
						outcome: "failed",
						sideEffectState: "side_effect_unknown",
						error: normalized.toPublicExecutionError(),
					});
					if (fallback.ok) {
						receipts[index] = fallback.value;
						settledStates[index] = { receipt: fallback.value };
					} else {
						errors.push(fallback.error);
						settledStates[index] = { error: fallback.error };
					}
				} finally {
					active = Math.max(0, active - 1);
					if (scope !== undefined) {
						try {
							await this.guard.release?.(scope);
						} catch (error) {
							const releaseError = toFoundationError(error, "tool_guard_denied");
							errors.push(releaseError);
							settledStates[index] = { error: releaseError };
						}
					}
					settled[index]!.resolve();
				}
			};

			const workers = Array.from({ length: effectiveConcurrency }, async () => {
				for (;;) {
					const index = nextIndex.value;
					if (index >= prepared.length) return;
					nextIndex.value += 1;
					await runOne(index);
				}
			});
			await Promise.all(workers);
			if (errors.length > 0) return Result.err(errors[0]!);
			const joined = prepared.map((entry, index) => receipts[index] ?? this.syntheticCancelledReceipt(entry, context));
			const usage = summarizeUsage(joined);
			return Result.ok({
				schemaVersion: 1,
				batchId,
				status: joinStatus(joined),
				receipts: joined,
				usage,
				conflicts,
				maxConcurrency: effectiveConcurrency,
				durationMs: elapsed(this.nowMs(), startedAt),
			});
		} catch (error) {
			return Result.err(toFoundationError(error));
		} finally {
			// Reservations and conflict locks are released per call in runOne. A
			// batch-wide cleanup would release another overlapping batch's leases.
		}
	}

	private peakConcurrency = 0;

	private async prepare(call: ToolCall, context: ToolPipelineContext): Promise<ResultValue<PreparedCall, FoundationError>> {
		if (call.toolCallId.length === 0 || call.toolName.length === 0) return Result.err(new FoundationError("invalid_identifier", "tool call id and name must not be empty"));
		if (call.idempotencyKey !== undefined && call.idempotencyKey.length === 0) return Result.err(new FoundationError("invalid_identifier", "idempotency key must not be empty"));
		const resolved = this.registry.resolve(call.toolName, call.namespace);
		if (!resolved.ok) return resolved;
		const tool = snapshotToolDefinition(resolved.value);
		let original: FoundationJsonValue;
		let acceptedArgs: Record<string, unknown>;
		try {
			original = cloneFoundationValue(call.args);
			if (tool.prepareArguments !== undefined && tool.argumentTransformer !== undefined) throw new FoundationError("foundation_schema_invalid_shape", "tool definition cannot declare two argument transformers");
			const accepted = tool.argumentTransformer === undefined
				? tool.prepareArguments === undefined ? original : tool.prepareArguments(cloneFoundationValue(original))
				: tool.argumentTransformer.transform(cloneFoundationValue(original));
			const normalized = normalizeArguments(accepted);
			if (!normalized.ok) return normalized;
			acceptedArgs = normalized.value;
		} catch (error) {
			return Result.err(toFoundationError(error, "foundation_schema_invalid_shape"));
		}
		const acceptedCheck = validateExactShape(tool.parameters, acceptedArgs, "tool arguments");
		if (!acceptedCheck.ok) return acceptedCheck;
		const originalDigest = fingerprintFoundationValue(original);
		const acceptedDigest = fingerprintFoundationValue(acceptedArgs);
		const conflictKeysResult = collectConflictKeys(tool, acceptedArgs, this.canonicalizeConflictKey);
		if (!conflictKeysResult.ok) return conflictKeysResult;
		const provenance = argumentTransformProvenance(original, acceptedArgs, tool);
		const attempt = call.attempt ?? 1;
		if (!Number.isInteger(attempt) || attempt < 1) return Result.err(new FoundationError("invalid_identifier", "tool attempt must be a positive integer"));
		const persistedCandidates = call.idempotencyKey === undefined
			? []
			: [...this.persistedIntents.values()].filter((candidate) => candidate.idempotencyKey === call.idempotencyKey);
		const persisted = persistedCandidates.find((candidate) => toolIdentityMatchesContext(candidate, context) && candidate.toolCallId === call.toolCallId);
		if (persistedCandidates.some((candidate) => !toolIdentityMatchesContext(candidate, context) || candidate.toolCallId !== call.toolCallId)) {
			return Result.err(new FoundationError("goal_conflict", "idempotency key was already used by a different execution identity"));
		}
		const intentId = persisted?.intentId ?? this.idGenerator("tool_intent");
		const intent = freeze({
			schemaVersion: 1 as const,
			intentId,
			toolCallId: call.toolCallId,
			toolName: tool.name,
			...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
			toolRevision: cloneToolRevision(tool.toolRevision),
			binding: createToolBindingRef(context),
			...(call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey }),
			argumentDigests: { original: originalDigest, accepted: acceptedDigest },
			fence: {
				schemaVersion: 1 as const,
				fenceId: this.idGenerator("tool_fence"),
				intentId,
				bindingEpochId: context.bindingEpoch.bindingEpochId,
				acceptedArgumentsDigest: acceptedDigest,
				armedAt: this.now(),
			},
			transformProvenance: provenance,
			attempt,
			writtenAt: persisted?.writtenAt ?? this.now(),
		});
		if (persisted !== undefined && invocationSignature(persisted) !== invocationSignature(intent)) {
			return Result.err(new FoundationError("goal_conflict", "idempotency key was already used for different frozen tool arguments"));
		}
		const expectedIntent = persisted === undefined ? intent : freeze({ ...intent, fence: cloneToolIntent(persisted).fence });
		if (persisted !== undefined) {
			const persistedIntegrity = validateDurableIntent(persisted, expectedIntent);
			if (!persistedIntegrity.ok) return persistedIntegrity;
		}
		const written = await this.storage.writeIntent(expectedIntent);
		if (!written.ok) return written;
		const durableIntent = validateDurableIntent(written.value, expectedIntent);
		if (!durableIntent.ok) return durableIntent;
		await this.onStage?.({ stage: "prepare", toolCallId: call.toolCallId });
		await this.onStage?.({ stage: "pre", toolCallId: call.toolCallId });
		let preHookError: PublicExecutionError | undefined;
		const acceptedDigestBeforePreHook = acceptedDigest;
		const intentBeforePreHook = canonicalFoundationJson(durableIntent.value);
		const preHook = tool.preHook;
		if (preHook !== undefined) {
			try {
				const hookResult = await preHook(freeze({
					context: freeze(cloneUnknownRecord(context as unknown as Record<string, unknown>)) as Readonly<ToolPipelineContext>,
					tool: snapshotToolDefinition(tool),
					args: freeze(cloneUnknownRecord(acceptedArgs)),
					intent: freeze(cloneToolIntent(durableIntent.value)),
				}));
				const hookResultRecord = hookResult !== null && typeof hookResult === "object" ? hookResult as { ok?: unknown; error?: unknown } : undefined;
				const malformed = hookResult !== undefined && typeof hookResult !== "boolean" && (hookResultRecord === undefined || typeof hookResultRecord.ok !== "boolean");
				const denied = hookResult === false || hookResultRecord?.ok === false;
				if (malformed || denied) {
					const reason = !malformed && hookResultRecord !== undefined && FoundationError.is(hookResultRecord.error) ? hookResultRecord.error.message : "provider-neutral pre hook denied execution";
					preHookError = publicExecutionError("tool_pre_hook_denied", reason, { category: "permission", retryable: false });
				}
			} catch (error) {
				const normalized = toFoundationError(error, "tool_pre_hook_denied");
				preHookError = normalized.toPublicExecutionError();
			}
		}
		try {
			const postHookAcceptedDigest = fingerprintFoundationValue(acceptedArgs);
			const acceptedShape = validateExactShape(tool.parameters, acceptedArgs, "tool arguments after pre hook");
			if (!acceptedShape.ok || postHookAcceptedDigest.value !== acceptedDigestBeforePreHook.value || canonicalFoundationJson(durableIntent.value) !== intentBeforePreHook) {
				preHookError = publicExecutionError("tool_pre_hook_denied", "provider-neutral pre hook changed frozen authority or accepted arguments", { category: "permission", retryable: false });
			}
		} catch (error) {
			preHookError = toFoundationError(error, "tool_pre_hook_denied").toPublicExecutionError();
		}
		const dedupKey = call.idempotencyKey === undefined ? undefined : idempotencyScopeKey(context, call.idempotencyKey);
		const signature = invocationSignature(durableIntent.value);
		const replay = dedupKey === undefined ? undefined : this.completedByKey.get(dedupKey) ?? this.persistentByKey.get(dedupKey);
		if (replay !== undefined && replay.signature !== signature) {
			return Result.err(new FoundationError("goal_conflict", "idempotency key was already used for different frozen tool arguments"));
		}
		if (dedupKey !== undefined && this.persistentConflicts.has(dedupKey)) {
			return Result.err(new FoundationError("session_ledger_conflict", "durable tool receipts conflict for one execution identity"));
		}
		return Result.ok({
			call: freeze({ ...call, args: original }),
			tool,
			intent: durableIntent.value,
			acceptedArgs: freeze(acceptedArgs),
			conflictKeys: conflictKeysResult.value,
			gateRecords: [],
			...(preHookError === undefined ? {} : { preHookError }),
			replay: replay?.receipt,
		});
	}

	private readonly persistentByKey = new Map<string, { receipt: ToolReceipt; signature: string; semantic: string }>();
	private readonly persistentConflicts = new Set<string>();

	private async loadPersistentState(context: ToolPipelineContext): Promise<void> {
		const query = toolStorageQuery(context);
		if (this.storage.listIntents !== undefined) {
			for (const intent of await this.storage.listIntents(query)) {
				const checked = validateToolIntent(intent);
				if (!checked.ok) throw checked.error;
				this.persistedIntents.set(intent.intentId, checked.value);
			}
		}
		if (this.storage.listReceipts !== undefined) {
			for (const receipt of await this.storage.listReceipts(query)) {
				const checked = validateAndVerifyToolReceipt(receipt);
				if (!checked.ok) throw checked.error;
				this.persistedReceipts.set(receipt.toolReceiptId, checked.value);
				if (receipt.idempotencyKey !== undefined) {
					const key = idempotencyScopeKeyFromBinding(receipt.binding, receipt.idempotencyKey);
					const signature = invocationSignatureFromReceipt(checked.value);
					const semantic = projectToolReceiptExecutionSemantics(checked.value);
					const existing = this.persistentByKey.get(key);
					if (existing !== undefined && existing.signature !== signature) throw new FoundationError("goal_conflict", "durable receipts disagree for one idempotency identity");
					if (existing !== undefined && existing.semantic !== semantic) {
						this.persistentConflicts.add(key);
						continue;
					}
					this.persistentByKey.set(key, { receipt: checked.value, signature, semantic });
				}
			}
		}
	}

	private scopeFor(entry: PreparedCall, context: ToolPipelineContext): ToolGateScope {
		return {
			context,
			tool: entry.tool,
			args: entry.acceptedArgs,
			intent: entry.intent,
			acceptedArgsDigest: entry.intent.argumentDigests.accepted,
			conflictKeys: entry.conflictKeys,
		};
	}

	private async runPrepared(
		prepared: PreparedCall,
		context: ToolPipelineContext,
		signal: AbortSignal | undefined,
		scope: ToolGateScope,
		options: { deadlineAt?: number; onUpdate?: (partial: unknown) => void },
	): Promise<ResultValue<ToolReceipt, FoundationError>> {
		if (prepared.replay !== undefined) return this.withDedup(prepared, prepared.replay);
		await this.onStage?.({ stage: "guard", toolCallId: prepared.call.toolCallId });
		const guarded = await this.guard.guard(scope);
		if (!guarded.ok) {
			return this.finalize(prepared, context, {
				outcome: "blocked",
				sideEffectState: "none",
				error: guarded.error.toPublicExecutionError(),
			});
		}
		prepared.gateRecords = guarded.value;
		const monotonic = validateMonotonicGateRecords(guarded.value);
		if (!monotonic.ok) {
			return this.finalize(prepared, context, {
				outcome: "blocked",
				sideEffectState: "none",
				error: monotonic.error.toPublicExecutionError(),
			});
		}
		if (guarded.value.some((record) => record.verdict === "denied")) {
			const denied = guarded.value.find((record) => record.verdict === "denied");
			return this.finalize(prepared, context, {
				outcome: "blocked",
				sideEffectState: "none",
				error: publicExecutionError("tool_guard_denied", denied?.reason ?? "tool guard denied execution", { category: "permission" }),
			});
		}
		if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
			return this.finalize(prepared, context, { outcome: signal?.aborted ? "cancelled" : "failed", sideEffectState: "none", error: signal?.aborted ? cancellationError() : deadlineError() });
		}

		const idempotency: Idempotency = prepared.tool.idempotency ?? "non_idempotent";
		const startedAt = this.now();
		let retried = 0;
		let execution: ToolExecution | undefined;
		for (;;) {
			if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
				return this.finalize(prepared, context, { outcome: signal?.aborted ? "cancelled" : "failed", sideEffectState: "none", error: signal?.aborted ? cancellationError() : deadlineError(), retried });
			}
			await this.onStage?.({ stage: "execute", toolCallId: prepared.call.toolCallId });
			try {
				execution = await prepared.tool.execute(prepared.acceptedArgs, {
					toolCallId: prepared.call.toolCallId,
					signal,
					context,
					attempt: retried + 1,
					deadlineAt: options.deadlineAt ?? context.deadlineAt,
					onUpdate: options.onUpdate,
				});
			} catch (error) {
				const normalized = toFoundationError(error, "tool_execution_failed");
				execution = {
					ok: false,
					sideEffectState: "side_effect_unknown",
					error: normalized.toPublicExecutionError(),
				};
			}
			if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
				execution = {
					ok: false,
					sideEffectState: "side_effect_unknown",
					error: signal?.aborted ? cancellationError() : deadlineError(),
				};
			}
			if (execution.ok || execution.sideEffectState === "side_effect_unknown" || signal?.aborted) break;
			if (execution.error?.retryable === false) break;
			if (!isSideEffectRetryable(execution.sideEffectState, idempotency)) break;
			if (retried >= this.maxRetries) break;
			retried += 1;
		}
		await this.onStage?.({ stage: "post", toolCallId: prepared.call.toolCallId });
		if (execution === undefined) execution = { ok: false, sideEffectState: "side_effect_unknown", error: publicExecutionError("side_effect_unknown", "tool execution produced no settlement", { category: "side_effect_unknown", retryable: false }) };
		const normalizedExecution = await this.applyPostProcessor(prepared, context, execution);
		if (!normalizedExecution.ok) execution = { ok: false, sideEffectState: execution.sideEffectState, error: normalizedExecution.error.toPublicExecutionError() };
		else execution = normalizedExecution.value;
		const sideEffectState: SideEffectState = execution?.sideEffectState === "none"
			? "none"
			: "side_effect_unknown";
		const outcome: ToolReceiptOutcome =
			sideEffectState === "side_effect_unknown"
			? "side_effect_unknown"
			: execution?.ok === true
				? "succeeded"
				: "failed";
		return this.finalize(prepared, context, {
			outcome,
			sideEffectState,
			error: execution?.ok === false ? execution.error : undefined,
			usage: execution?.usage,
			result: execution?.result,
			artifacts: execution?.artifacts,
			startedAt,
			retried,
		});
	}

	private async applyPostProcessor(prepared: PreparedCall, context: ToolPipelineContext, execution: ToolExecution): Promise<ResultValue<ToolExecution, FoundationError>> {
		const processor = prepared.tool.postProcessor;
		if (processor === undefined) return Result.ok(execution);
		let candidate: ToolPostNormalization | undefined;
		try {
			const returned = await processor(freeze({
				context: freeze(cloneUnknownRecord(context as unknown as Record<string, unknown>)) as Readonly<ToolPipelineContext>,
				tool: snapshotToolDefinition(prepared.tool),
				args: freeze(cloneUnknownRecord(prepared.acceptedArgs)),
				intent: freeze(cloneToolIntent(prepared.intent)),
				execution: freeze(cloneUnknownRecord(execution as unknown as Record<string, unknown>)) as Readonly<ToolExecution>,
			}));
			if (returned !== undefined && typeof returned === "object" && returned !== null && "ok" in returned && typeof returned.ok === "boolean") {
				if (!returned.ok) return Result.err(this.stablePostValidationError(returned.error));
				candidate = returned.value;
			} else candidate = returned as ToolPostNormalization | undefined;
		} catch (error) {
			return Result.err(this.stablePostValidationError(error));
		}
		if (candidate === undefined) return Result.ok(execution);
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return Result.err(new FoundationError("tool_post_validation_failed", "post processor must return a result/artifact/usage projection"));
		const keys = Object.keys(candidate);
		if (keys.some((key) => key !== "result" && key !== "artifacts" && key !== "usage")) return Result.err(new FoundationError("tool_post_validation_failed", "post processor cannot change execution settlement fields"));
		if (candidate.result !== undefined) {
			const payloadResult = validateToolResultPayload(candidate.result);
			if (!payloadResult.ok) return Result.err(this.stablePostValidationError(payloadResult.error));
		}
		if (candidate.artifacts !== undefined) {
			const artifactsResult = validateExactShape<readonly ArtifactRef[]>(Type.Array(artifactRefSchema), candidate.artifacts, "tool post artifacts");
			if (!artifactsResult.ok) return Result.err(this.stablePostValidationError(artifactsResult.error));
		}
		const artifacts = candidate.artifacts ?? execution.artifacts;
		const artifactCheck = validateDurableResultArtifacts(candidate.result ?? execution.result, artifacts);
		if (!artifactCheck.ok) return Result.err(this.stablePostValidationError(artifactCheck.error));
		if (candidate.usage !== undefined) {
			const usageResult = validateExactShape<BudgetUsage>(usageSchema, candidate.usage, "tool post usage");
			if (!usageResult.ok) return Result.err(this.stablePostValidationError(usageResult.error));
			if (!isValidBudgetUsage(usageResult.value)) return Result.err(new FoundationError("tool_post_validation_failed", "post processor returned invalid usage"));
		}
		return Result.ok({ ...execution, ...(candidate.result === undefined ? {} : { result: candidate.result }), ...(candidate.artifacts === undefined ? {} : { artifacts: candidate.artifacts }), ...(candidate.usage === undefined ? {} : { usage: candidate.usage }) });
	}

	private stablePostValidationError(error: unknown): FoundationError {
		const normalized = toFoundationError(error, "tool_post_validation_failed");
		return normalized.code === "tool_post_validation_failed" ? normalized : new FoundationError("tool_post_validation_failed", normalized.message);
	}

	private async finalize(
		prepared: PreparedCall,
		context: ToolPipelineContext,
		state: {
			outcome: ToolReceiptOutcome;
			sideEffectState: SideEffectState;
			error?: PublicExecutionError;
			usage?: BudgetUsage;
			result?: ToolResultPayload;
			artifacts?: readonly ArtifactRef[];
			startedAt?: string;
			retried?: number;
		},
	): Promise<ResultValue<ToolReceipt, FoundationError>> {
		let durableResult: ToolResultPayload | undefined;
		const persistResult = state.outcome === "succeeded" && state.sideEffectState === "none";
		const durableArtifacts = persistResult ? state.artifacts : undefined;
		if (persistResult && state.result !== undefined) {
			const payloadResult = validateToolResultPayload(state.result);
			if (!payloadResult.ok) return payloadResult;
			durableResult = payloadResult.value;
		}
		const artifactCheck = validateDurableResultArtifacts(durableResult, durableArtifacts);
		if (!artifactCheck.ok) return artifactCheck;
		await this.onStage?.({ stage: "finalize", toolCallId: prepared.call.toolCallId });
		const receipt = finalizeToolReceipt({
			schemaVersion: 1,
			toolReceiptId: this.idGenerator("tool_receipt"),
			toolCallId: prepared.call.toolCallId,
			toolName: prepared.tool.name,
			...(prepared.tool.namespace === undefined ? {} : { namespace: prepared.tool.namespace }),
			toolRevision: cloneToolRevision(prepared.tool.toolRevision),
			binding: prepared.intent.binding,
			...(prepared.intent.idempotencyKey === undefined ? {} : { idempotencyKey: prepared.intent.idempotencyKey }),
			argumentDigests: prepared.intent.argumentDigests,
			transformProvenance: prepared.intent.transformProvenance,
			gates: prepared.gateRecords,
			sideEffectState: state.sideEffectState,
			idempotency: prepared.tool.idempotency ?? "non_idempotent",
			attempt: prepared.intent.attempt,
			retried: state.retried ?? 0,
			...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
			completedAt: this.now(),
			outcome: state.outcome,
			...(durableArtifacts === undefined ? {} : { artifacts: [...durableArtifacts] }),
			...(state.usage === undefined ? {} : { usage: { ...state.usage } }),
			...(durableResult === undefined ? {} : { result: durableResult }),
			...(state.error === undefined ? {} : { error: state.error }),
		});
		let stored: ResultValue<{ toolReceiptRef: string }, FoundationError>;
		try {
			stored = await this.storage.finalizeReceipt(receipt);
		} catch (error) {
			return Result.err(sideEffectUnknownError(error));
		}
		if (!stored.ok) return Result.err(sideEffectUnknownError(stored.error));
		const key = prepared.intent.idempotencyKey === undefined ? undefined : idempotencyScopeKey(context, prepared.intent.idempotencyKey);
		if (key !== undefined) this.completedByKey.set(key, { receipt, signature: invocationSignature(prepared.intent), semantic: projectToolReceiptExecutionSemantics(receipt) });
		this.quotaAccount.settle(receipt);
		return Result.ok(receipt);
	}

	private async withDedup(prepared: PreparedCall, source: ToolReceipt): Promise<ResultValue<ToolReceipt, FoundationError>> {
		const replayMissingResult = source.outcome === "succeeded" && source.result === undefined;
		const replayOutcome: ToolReceiptOutcome = replayMissingResult ? "side_effect_unknown" : source.outcome;
		const replaySideEffectState: SideEffectState = replayMissingResult ? "side_effect_unknown" : source.sideEffectState;
		const replayError = replayMissingResult
			? publicExecutionError("side_effect_unknown", "durable tool result payload is missing or unrecoverable", { category: "side_effect_unknown", retryable: false })
			: source.error;
		const receipt = finalizeToolReceipt({
			schemaVersion: 1,
			toolReceiptId: this.idGenerator("tool_receipt"),
			toolCallId: prepared.call.toolCallId,
			toolName: prepared.tool.name,
			...(prepared.tool.namespace === undefined ? {} : { namespace: prepared.tool.namespace }),
			toolRevision: cloneToolRevision(prepared.tool.toolRevision),
			binding: prepared.intent.binding,
			...(prepared.intent.idempotencyKey === undefined ? {} : { idempotencyKey: prepared.intent.idempotencyKey }),
			argumentDigests: prepared.intent.argumentDigests,
			transformProvenance: prepared.intent.transformProvenance,
			gates: source.gates,
			sideEffectState: replaySideEffectState,
			idempotency: source.idempotency,
			attempt: prepared.intent.attempt,
			retried: source.retried,
			...(source.startedAt === undefined ? {} : { startedAt: source.startedAt }),
			completedAt: this.now(),
			outcome: replayOutcome,
			...(source.result === undefined || source.artifacts === undefined ? {} : { artifacts: source.artifacts }),
			...(source.usage === undefined ? {} : { usage: source.usage }),
			...(source.result === undefined ? {} : { result: source.result }),
			...(replayError === undefined ? {} : { error: replayError }),
			deduplicatedFrom: source.toolReceiptId,
		});
		let stored: ResultValue<{ toolReceiptRef: string }, FoundationError>;
		try {
			stored = await this.storage.finalizeReceipt(receipt);
		} catch (error) {
			return Result.err(sideEffectUnknownError(error));
		}
		if (!stored.ok) return Result.err(sideEffectUnknownError(stored.error));
		return Result.ok(receipt);
	}

	private syntheticCancelledReceipt(entry: PreparedCall, context: ToolPipelineContext): ToolReceipt {
		return finalizeToolReceipt({
			schemaVersion: 1,
			toolReceiptId: this.idGenerator("tool_receipt"),
			toolCallId: entry.call.toolCallId,
			toolName: entry.tool.name,
			...(entry.tool.namespace === undefined ? {} : { namespace: entry.tool.namespace }),
			toolRevision: cloneToolRevision(entry.tool.toolRevision),
			binding: entry.intent.binding,
			...(entry.intent.idempotencyKey === undefined ? {} : { idempotencyKey: entry.intent.idempotencyKey }),
			argumentDigests: entry.intent.argumentDigests,
			transformProvenance: entry.intent.transformProvenance,
			gates: entry.gateRecords,
			sideEffectState: "none",
			idempotency: entry.tool.idempotency ?? "non_idempotent",
			attempt: entry.intent.attempt,
			retried: 0,
			completedAt: this.now(),
			outcome: "cancelled",
			error: cancellationError(),
		});
	}
}

export function createFoundationToolPipeline(options: ToolPipelineOptions): FoundationToolPipeline {
	return new FoundationToolPipeline(options);
}

interface PreparedCall {
	call: ToolCall;
	tool: ToolDefinition;
	intent: ToolIntent;
	acceptedArgs: Record<string, unknown>;
	conflictKeys: readonly string[];
	gateRecords: readonly ToolGateRecord[];
	preHookError?: PublicExecutionError;
	replay?: ToolReceipt;
}

interface SettledCallState {
	receipt?: ToolReceipt;
	error?: FoundationError;
}

function normalizeArguments(value: unknown): ResultValue<Record<string, unknown>, FoundationError> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return Result.err(new FoundationError("foundation_schema_invalid_shape", "tool arguments must be a JSON object"));
	}
	try {
		const cloned = cloneFoundationValue(value as FoundationJsonValue);
		if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) throw new TypeError("not an object");
		return Result.ok({ ...(cloned as Record<string, FoundationJsonValue>) });
	} catch (error) {
		return Result.err(toFoundationError(error, "foundation_schema_invalid_shape"));
	}
}

function argumentTransformProvenance(original: FoundationJsonValue, accepted: Record<string, unknown>, tool: ToolDefinition): readonly ToolTransformProvenance[] {
	const originalRecord = original !== null && typeof original === "object" && !Array.isArray(original) ? original : undefined;
	const fields = new Set([...(originalRecord === undefined ? [] : Object.keys(originalRecord)), ...Object.keys(accepted)]);
	const transformerId = tool.argumentTransformer?.transformerId ?? `tool:${tool.toolRevision.id}:prepareArguments`;
	const transformerRevision = tool.argumentTransformer?.transformerRevision ?? tool.toolRevision.revision;
	const provenance: ToolTransformProvenance[] = [];
	for (const field of fields) {
		const hadOriginal = originalRecord !== undefined && field in originalRecord;
		const hasAccepted = field in accepted;
		const before = hadOriginal ? originalRecord[field] : null;
		const after = hasAccepted ? accepted[field] : null;
		const beforeDigest = fingerprintFoundationValue(before as FoundationJsonValue);
		const afterDigest = fingerprintFoundationValue(after as FoundationJsonValue);
		if (!hadOriginal && hasAccepted) provenance.push({ field, kind: "defaulted", transformerId, transformerRevision, beforeDigest, afterDigest });
		else if (hadOriginal && !hasAccepted) provenance.push({ field, kind: "removed", transformerId, transformerRevision, beforeDigest, afterDigest });
		else if (hadOriginal && hasAccepted) {
			let same = false;
			try {
				same = fingerprintFoundationValue(before).value === fingerprintFoundationValue(after).value;
			} catch {
				same = false;
			}
			const kind: ToolArgumentTransformKind = same
				? "original"
				: typeof before !== typeof after
					? "coerced"
					: after === "[redacted]"
						? "redacted"
						: "normalized";
			provenance.push({ field, kind, transformerId, transformerRevision, beforeDigest, afterDigest });
		}
	}
	return freeze(provenance.sort((a, b) => a.field.localeCompare(b.field)));
}

function collectConflictKeys(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	canonicalize: (key: string) => string,
): ResultValue<readonly string[], FoundationError> {
	if (tool.conflictKeys === undefined) return Result.ok([]);
	try {
		const keys = new Set<string>();
		for (const raw of tool.conflictKeys(args)) {
			if (typeof raw !== "string") return Result.err(new FoundationError("foundation_schema_invalid_shape", "conflict keys must be strings"));
			const key = canonicalize(raw);
			if (key.length > 0) keys.add(key);
		}
		return Result.ok(freeze([...keys].sort((a, b) => a.localeCompare(b))));
	} catch (error) {
		return Result.err(toFoundationError(error, "foundation_schema_invalid_shape"));
	}
}

function detectConflicts(prepared: readonly PreparedCall[]): readonly ToolConflict[] {
	const keyToCallIds = new Map<string, string[]>();
	for (const call of prepared) {
		for (const key of call.conflictKeys) {
			const existing = keyToCallIds.get(key);
			if (existing === undefined) keyToCallIds.set(key, [call.call.toolCallId]);
			else if (!existing.includes(call.call.toolCallId)) existing.push(call.call.toolCallId);
		}
	}
	return freeze(
		[...keyToCallIds]
			.filter(([, toolCallIds]) => toolCallIds.length > 1)
			.map(([key, toolCallIds]) => ({ keys: [key], toolCallIds: [...toolCallIds] }))
			.sort((a, b) => a.keys[0]!.localeCompare(b.keys[0]!)),
	);
}

function computeDependencies(prepared: readonly PreparedCall[]): Map<number, readonly number[]> {
	const keyOwners = new Map<string, number[]>();
	const dependencies = new Map<number, readonly number[]>();
	for (let index = 0; index < prepared.length; index += 1) {
		const call = prepared[index]!;
		const deps = new Set<number>();
		for (const key of call.conflictKeys) for (const owner of keyOwners.get(key) ?? []) deps.add(owner);
		if (call.tool.executionMode === "sequential") for (let earlier = 0; earlier < index; earlier += 1) deps.add(earlier);
		const ordered = [...deps].sort((a, b) => a - b);
		if (ordered.length > 0) dependencies.set(index, ordered);
		for (const key of call.conflictKeys) {
			const owners = keyOwners.get(key);
			if (owners === undefined) keyOwners.set(key, [index]);
			else owners.push(index);
		}
	}
	return dependencies;
}

function computeConflictDependencies(prepared: readonly PreparedCall[]): Map<number, readonly number[]> {
	const keyOwners = new Map<string, number[]>();
	const dependencies = new Map<number, readonly number[]>();
	for (let index = 0; index < prepared.length; index += 1) {
		const deps = new Set<number>();
		for (const key of prepared[index]!.conflictKeys) for (const owner of keyOwners.get(key) ?? []) deps.add(owner);
		if (deps.size > 0) dependencies.set(index, [...deps].sort((a, b) => a - b));
		for (const key of prepared[index]!.conflictKeys) {
			const owners = keyOwners.get(key);
			if (owners === undefined) keyOwners.set(key, [index]);
			else owners.push(index);
		}
	}
	return dependencies;
}

function findConflictDependencyFailure(
	dependencies: readonly number[],
	settledStates: readonly (SettledCallState | undefined)[],
): { index: number } | undefined {
	for (const index of dependencies) {
		const state = settledStates[index];
		if (state === undefined || state.error !== undefined) return { index };
		const receipt = state.receipt;
		if (receipt === undefined || receipt.sideEffectState !== "none" || receipt.outcome === "side_effect_unknown") return { index };
	}
	return undefined;
}

function joinStatus(receipts: readonly ToolReceipt[]): ToolBatchStatus {
	if (receipts.length === 0 || receipts.every((receipt) => receipt.outcome === "succeeded")) return "succeeded";
	if (receipts.every((receipt) => receipt.outcome === "cancelled")) return "cancelled";
	if (receipts.some((receipt) => receipt.outcome === "succeeded")) return "partial_failure";
	if (receipts.some((receipt) => receipt.outcome === "cancelled") && receipts.every((receipt) => receipt.outcome === "cancelled" || receipt.outcome === "blocked")) return "cancelled";
	return receipts.some((receipt) => receipt.outcome === "cancelled") ? "partial_failure" : "failed";
}

function summarizeUsage(receipts: readonly ToolReceipt[]): BudgetUsage {
	const usage: BudgetUsage = { toolCalls: receipts.length };
	for (const receipt of receipts) {
		if (receipt.usage === undefined) continue;
		usage.tokens = (usage.tokens ?? 0) + (receipt.usage.tokens ?? 0);
		usage.costUsd = (usage.costUsd ?? 0) + (receipt.usage.costUsd ?? 0);
		usage.modelCalls = (usage.modelCalls ?? 0) + (receipt.usage.modelCalls ?? 0);
		usage.wallClockMs = (usage.wallClockMs ?? 0) + (receipt.usage.wallClockMs ?? 0);
	}
	return freeze(usage);
}

function isValidBudgetUsage(usage: BudgetUsage): boolean {
	for (const value of Object.values(usage)) {
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return false;
	}
	return true;
}

function tightenBudget(binding: Budget, local: Budget): Budget {
	const result: Budget = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const bindingLimit = binding[key];
		const localLimit = local[key];
		if (bindingLimit !== undefined || localLimit !== undefined) {
			result[key] = bindingLimit === undefined ? localLimit : localLimit === undefined ? bindingLimit : Math.min(bindingLimit, localLimit);
		}
	}
	return result;
}

/** Compute the ToolReceipt digest from every field except `digest`. */
export function finalizeToolReceipt(receipt: Omit<ToolReceipt, "digest">): ToolReceipt {
	const snapshot = cloneUnknownRecord(receipt);
	return freeze({ ...snapshot, digest: fingerprintFoundationValue(snapshot) } as ToolReceipt);
}

/**
 * Projects the execution truth of a receipt for same-operation replay
 * comparison. Receipt id, completedAt, deduplicatedFrom and digest are
 * envelope fields and are excluded; every other execution field remains.
 */
export function projectToolReceiptExecutionSemantics(receipt: ToolReceipt): string {
	return canonicalFoundationJson({
		schemaVersion: receipt.schemaVersion,
		toolCallId: receipt.toolCallId,
		toolName: receipt.toolName,
		...(receipt.namespace === undefined ? {} : { namespace: receipt.namespace }),
		toolRevision: receipt.toolRevision,
		binding: receipt.binding,
		...(receipt.idempotencyKey === undefined ? {} : { idempotencyKey: receipt.idempotencyKey }),
		argumentDigests: receipt.argumentDigests,
		transformProvenance: receipt.transformProvenance,
		gates: receipt.gates,
		sideEffectState: receipt.sideEffectState,
		idempotency: receipt.idempotency,
		attempt: receipt.attempt,
		retried: receipt.retried,
		...(receipt.startedAt === undefined ? {} : { startedAt: receipt.startedAt }),
		outcome: receipt.outcome,
		...(receipt.artifacts === undefined ? {} : { artifacts: receipt.artifacts }),
		...(receipt.usage === undefined ? {} : { usage: receipt.usage }),
		...(receipt.result === undefined ? {} : { result: receipt.result }),
		...(receipt.error === undefined ? {} : { error: receipt.error }),
	});
}

/** Validates the exact, bounded and credential-free durable result projection. */
export function validateToolResultPayload(value: unknown): ResultValue<ToolResultPayload, FoundationError> {
	const checked = validateExactShape<ToolResultPayload>(toolResultPayloadSchema, value, "tool_result_payload");
	if (!checked.ok) return checked;
	try {
		const canonical = canonicalFoundationJson(checked.value);
		if (new TextEncoder().encode(canonical).byteLength > TOOL_RESULT_PAYLOAD_MAX_BYTES) {
			return Result.err(new FoundationError("side_effect_unknown", "durable tool result payload exceeds the bounded replay limit"));
		}
		if (checked.value.details !== undefined && !isDurableResultProjectionSafe(checked.value.details)) {
			return Result.err(new FoundationError("side_effect_unknown", "durable tool result payload is not a safe projection"));
		}
		for (const content of checked.value.content) {
			if (content.type === "text" && redactText(content.text) !== content.text) {
				return Result.err(new FoundationError("side_effect_unknown", "durable tool result payload contains credential material"));
			}
			if (content.type === "image" && !content.artifact.mediaType.startsWith("image/")) {
				return Result.err(new FoundationError("side_effect_unknown", "durable image result has an invalid media type"));
			}
		}
		return checked;
	} catch (_error) {
		return Result.err(new FoundationError("side_effect_unknown", "durable tool result payload is not safely recoverable"));
	}
}

/** Validates the exact reserved Session entry used to project durable results. */
export function validateFoundationToolResultEntry(value: unknown): ResultValue<FoundationToolResultEntry, FoundationError> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return Result.err(new FoundationError("side_effect_unknown", "durable tool result entry is not an object"));
	const record = value as Record<string, unknown>;
	const expectedKeys = ["isError", "operationId", "result", "runId", "schemaVersion", "toolCallId", "toolName"];
	const actualKeys = Object.keys(record).sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return Result.err(new FoundationError("side_effect_unknown", "durable tool result entry has an invalid shape"));
	if (record.schemaVersion !== 1 || typeof record.runId !== "string" || record.runId.length === 0 || typeof record.operationId !== "string" || record.operationId.length === 0 || typeof record.toolCallId !== "string" || record.toolCallId.length === 0 || typeof record.toolName !== "string" || record.toolName.length === 0 || typeof record.isError !== "boolean") {
		return Result.err(new FoundationError("side_effect_unknown", "durable tool result entry has an invalid identity"));
	}
	const result = validateToolResultPayload(record.result);
	if (!result.ok) return result;
	return Result.ok({ schemaVersion: 1, runId: record.runId, operationId: record.operationId, toolCallId: record.toolCallId, toolName: record.toolName, isError: record.isError, result: result.value });
}

function validateDurableResultArtifacts(result: ToolResultPayload | undefined, artifacts: readonly ArtifactRef[] | undefined): ResultValue<true, FoundationError> {
	const expected = result === undefined ? [] : result.content.filter((content): content is ToolResultImageContent => content.type === "image").map((content) => content.artifact);
	const provided = artifacts ?? [];
	if (provided.length !== expected.length) return Result.err(new FoundationError("side_effect_unknown", "tool result image artifacts do not exactly match the durable result payload"));
	for (let index = 0; index < expected.length; index += 1) {
		if (canonicalFoundationJson(provided[index]) !== canonicalFoundationJson(expected[index])) return Result.err(new FoundationError("side_effect_unknown", "tool result image artifacts do not exactly match the durable result payload"));
	}
	return Result.ok(true);
}

/** Stable digest of JSON-like tool arguments, excluding provider-side state. */
export function digestToolArguments(value: unknown): string {
	return fingerprintFoundationValue(value).value;
}

export const argumentDigest = digestToolArguments;

export function fingerprintToolArguments(value: unknown): Fingerprint {
	return fingerprintFoundationValue(value);
}

function snapshotToolDefinition(tool: ToolDefinition): ToolDefinition {
	if (tool.name.length === 0 || tool.toolRevision.id.length === 0 || tool.toolRevision.revision < 0) throw new FoundationError("invalid_identifier", "tool definition has an invalid identity");
	if (tool.prepareArguments !== undefined && tool.argumentTransformer !== undefined) throw new FoundationError("foundation_schema_invalid_shape", "tool definition cannot declare two argument transformers");
	if (tool.argumentTransformer !== undefined && (tool.argumentTransformer.transformerId.trim().length === 0 || !Number.isInteger(tool.argumentTransformer.transformerRevision) || tool.argumentTransformer.transformerRevision < 0)) throw new FoundationError("foundation_schema_invalid_shape", "tool argument transformer identity is invalid");
	return freeze({
		...tool,
		toolRevision: cloneToolRevision(tool.toolRevision),
		capabilities: freeze([...tool.capabilities]),
		...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
	});
}

function cloneToolRevision(value: ToolRevision): ToolRevision {
	return freeze({
		schemaVersion: 1 as const,
		type: "tool_revision" as const,
		id: value.id,
		revision: value.revision,
		...(value.fingerprint === undefined ? {} : { fingerprint: { ...value.fingerprint } }),
	});
}

function validatePipelineContext(context: ToolPipelineContext): ResultValue<ToolPipelineContext, FoundationError> {
	if (context.sessionId.length === 0 || context.laneId.length === 0 || context.taskId.length === 0 || context.workspace.length === 0) return Result.err(new FoundationError("invalid_identifier", "tool pipeline context is incomplete"));
	if (context.binding.taskId !== context.taskId) return Result.err(new FoundationError("binding_task_before_binding", "binding references a different task"));
	if (context.bindingEpoch.taskId !== context.taskId || context.bindingEpoch.bindingId !== context.binding.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "binding epoch does not match the task binding"));
	if (context.deadlineAt !== undefined && (!Number.isFinite(context.deadlineAt) || context.deadlineAt < 0)) return Result.err(new FoundationError("invalid_identifier", "tool pipeline deadline is invalid"));
	return Result.ok(context);
}

function cloneFoundationValue<T extends FoundationJsonValue>(value: T): T {
	return JSON.parse(canonicalFoundationJson(value)) as T;
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
	const canonical = canonicalFoundationJson(value);
	return JSON.parse(canonical) as Record<string, unknown>;
}

function cloneToolIntent(value: ToolIntent): ToolIntent {
	return JSON.parse(canonicalFoundationJson(value)) as ToolIntent;
}

function cloneToolReceipt(value: ToolReceipt): ToolReceipt {
	return JSON.parse(canonicalFoundationJson(value)) as ToolReceipt;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function idempotencyScopeKey(context: ToolPipelineContext, key: string): string {
	return idempotencyScopeKeyFromBinding(createToolBindingRef(context), key);
}

function contextRecoveryScope(context: ToolPipelineContext): string {
	return canonicalFoundationJson(toolStorageQuery(context));
}

function toolStorageQuery(context: ToolPipelineContext): ToolPipelineStorageQuery {
	const binding = createToolBindingRef(context);
	return {
		correlation: {
			sessionId: context.sessionId,
			laneId: context.laneId,
			taskId: binding.taskId,
			bindingId: binding.bindingId,
			bindingEpochId: binding.bindingEpochId,
			...(binding.runId === undefined ? {} : { runId: binding.runId }),
			...(binding.operationId === undefined ? {} : { operationId: binding.operationId }),
			...(binding.dispatchId === undefined ? {} : { dispatchId: binding.dispatchId }),
			...(binding.attemptId === undefined ? {} : { attemptId: binding.attemptId }),
			...(binding.providerId === undefined ? {} : { providerId: binding.providerId }),
			...(binding.agentInstanceId === undefined ? {} : { agentInstanceId: binding.agentInstanceId }),
		},
	};
}

function idempotencyScopeKeyFromBinding(binding: ToolBindingRef, key: string): string {
	const identity: Record<string, string> = { key, bindingId: binding.bindingId, bindingEpochId: binding.bindingEpochId, taskId: binding.taskId };
	for (const [field, value] of [
		["sessionId", binding.sessionId],
		["laneId", binding.laneId],
		["runId", binding.runId],
		["operationId", binding.operationId],
		["dispatchId", binding.dispatchId],
		["attemptId", binding.attemptId],
		["providerId", binding.providerId],
		["agentInstanceId", binding.agentInstanceId],
	] as const) {
		if (value !== undefined) identity[field] = value;
	}
	return canonicalFoundationJson(identity);
}

function toolIdentityMatchesContext(value: ToolIntent | ToolReceipt, context: ToolPipelineContext): boolean {
	const binding = value.binding;
	const fullIdentity = context.runId !== undefined || context.operationId !== undefined;
	const expected: Array<[keyof ToolBindingRef, string | undefined]> = [
		["sessionId", context.sessionId],
		["laneId", context.laneId],
		["runId", context.runId],
		["operationId", context.operationId],
		["taskId", context.taskId],
		["dispatchId", context.dispatchId],
		["attemptId", context.attemptId],
		["bindingId", context.binding.bindingId],
		["bindingEpochId", context.bindingEpoch.bindingEpochId],
		["providerId", context.providerId],
		["agentInstanceId", context.agentInstanceId],
	];
	for (const [field, expectedValue] of expected) {
		if (expectedValue !== undefined && (binding[field] === undefined ? fullIdentity : binding[field] !== expectedValue)) return false;
	}
	return true;
}

function receiptIdentityMatchesIntent(receipt: ToolReceipt, intent: ToolIntent): boolean {
	return receipt.toolCallId === intent.toolCallId
		&& receipt.toolName === intent.toolName
		&& receipt.namespace === intent.namespace
		&& canonicalFoundationJson(receipt.toolRevision) === canonicalFoundationJson(intent.toolRevision)
		&& canonicalFoundationJson(receipt.binding) === canonicalFoundationJson(intent.binding)
		&& receipt.idempotencyKey === intent.idempotencyKey
		&& receipt.attempt === intent.attempt;
}

function deadlineReached(deadlineAt: number | undefined, nowMs: number): boolean {
	return deadlineAt !== undefined && nowMs >= deadlineAt;
}

function invocationSignature(intent: ToolIntent): string {
	const value = {
		toolCallId: intent.toolCallId,
		toolName: intent.toolName,
		toolRevision: intent.toolRevision,
		binding: intent.binding,
		argumentDigests: intent.argumentDigests,
		...(intent.namespace === undefined ? {} : { namespace: intent.namespace }),
	};
	return canonicalFoundationJson(value);
}

function invocationSignatureFromReceipt(receipt: ToolReceipt): string {
	return canonicalFoundationJson({
		toolCallId: receipt.toolCallId,
		toolName: receipt.toolName,
		toolRevision: receipt.toolRevision,
		binding: receipt.binding,
		argumentDigests: receipt.argumentDigests,
		...(receipt.namespace === undefined ? {} : { namespace: receipt.namespace }),
	});
}

export function validateAndVerifyToolReceipt(value: unknown): ResultValue<ToolReceipt, FoundationError> {
	const checked = validateToolReceipt(value);
	if (!checked.ok) return checked;
	const { digest: _digest, ...withoutDigest } = checked.value;
	const expected = fingerprintFoundationValue(withoutDigest);
	if (expected.algorithm !== checked.value.digest.algorithm || expected.value !== checked.value.digest.value) {
		return Result.err(new FoundationError("side_effect_unknown", "durable tool receipt digest is invalid"));
	}
	return checked;
}

function receiptMatchesIntent(receipt: ToolReceipt, intent: ToolIntent): boolean {
	return receipt.toolCallId === intent.toolCallId
		&& receipt.toolName === intent.toolName
		&& receipt.namespace === intent.namespace
		&& canonicalFoundationJson(receipt.toolRevision) === canonicalFoundationJson(intent.toolRevision)
		&& canonicalFoundationJson(receipt.binding) === canonicalFoundationJson(intent.binding)
		&& receipt.idempotencyKey === intent.idempotencyKey
		&& receipt.attempt === intent.attempt
		&& receipt.argumentDigests.original.algorithm === intent.argumentDigests.original.algorithm
		&& receipt.argumentDigests.original.value === intent.argumentDigests.original.value
		&& receipt.argumentDigests.accepted.algorithm === intent.argumentDigests.accepted.algorithm
		&& receipt.argumentDigests.accepted.value === intent.argumentDigests.accepted.value
		&& canonicalFoundationJson(receipt.transformProvenance) === canonicalFoundationJson(intent.transformProvenance);
}

function validateDurableIntent(value: ToolIntent, expected: ToolIntent): ResultValue<ToolIntent, FoundationError> {
	const shape = validateToolIntent(value);
	if (!shape.ok) return shape;
	const intent = shape.value;
	const sameDigest = intent.argumentDigests.accepted.algorithm === expected.argumentDigests.accepted.algorithm && intent.argumentDigests.accepted.value === expected.argumentDigests.accepted.value;
	const sameFence = intent.fence.fenceId === expected.fence.fenceId && intent.fence.intentId === expected.intentId && intent.fence.bindingEpochId === expected.binding.bindingEpochId && intent.fence.acceptedArgumentsDigest.algorithm === expected.argumentDigests.accepted.algorithm && intent.fence.acceptedArgumentsDigest.value === expected.argumentDigests.accepted.value;
	if (intent.intentId !== expected.intentId || intent.toolCallId !== expected.toolCallId || intent.toolName !== expected.toolName || intent.namespace !== expected.namespace || canonicalFoundationJson(intent.toolRevision) !== canonicalFoundationJson(expected.toolRevision) || canonicalFoundationJson(intent.binding) !== canonicalFoundationJson(expected.binding) || intent.idempotencyKey !== expected.idempotencyKey || !sameDigest || intent.argumentDigests.original.value !== expected.argumentDigests.original.value || canonicalFoundationJson(intent.transformProvenance) !== canonicalFoundationJson(expected.transformProvenance) || !sameFence) {
		return Result.err(new FoundationError("tool_guard_denied", "durable tool intent changed before execution"));
	}
	return Result.ok(intent);
}

function validateMonotonicGateRecords(records: readonly ToolGateRecord[]): ResultValue<true, FoundationError> {
	let denied = false;
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (record.kind !== TOOL_GATE_KINDS[index]) {
			return Result.err(new FoundationError("tool_guard_denied", "tool guards must run in the fixed capability, policy, approval, sandbox, quota, conflict-lock order"));
		}
		if (denied) {
			return Result.err(new FoundationError("tool_guard_denied", "a denied tool guard cannot be followed by another guard"));
		}
		if (record.verdict === "reserved" && record.kind !== "quota" && record.kind !== "conflict_lock") {
			return Result.err(new FoundationError("tool_guard_denied", "only quota and conflict-lock guards may reserve capacity"));
		}
		if (record.verdict === "denied") denied = true;
	}
	if (!denied && records.length !== TOOL_GATE_KINDS.length) {
		return Result.err(new FoundationError("tool_guard_denied", "all fixed tool guards must run before a side effect"));
	}
	return Result.ok(true);
}

function conflictOwnerKey(scope: ToolGateScope, key: string): string {
	return `${scope.context.bindingEpoch.bindingEpochId}:${key}`;
}

function normalizePositiveLimit(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) throw new RangeError("concurrency limit must be a positive integer");
	return value;
}

function normalizeNonNegativeInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
	return value;
}

function elapsed(now: number, started: number): number {
	return Math.max(0, now - started);
}

function findDuplicateCallId(calls: readonly ToolCall[]): string | undefined {
	const seen = new Set<string>();
	for (const call of calls) {
		if (seen.has(call.toolCallId)) return call.toolCallId;
		seen.add(call.toolCallId);
	}
	return undefined;
}

function cancellationError(): PublicExecutionError {
	return publicExecutionError("tool_cancelled", "tool execution was cancelled", { category: "cancelled" });
}

function deadlineError(): PublicExecutionError {
	return publicExecutionError("deadline_exceeded", "tool execution deadline was exceeded", { category: "deadline", retryable: false });
}

function sideEffectUnknownError(error: unknown): FoundationError {
	const normalized = toFoundationError(error, "side_effect_unknown");
	if (normalized.code === "session_writer_fencing_token" || normalized.code === "session_writer_lease_lost" || normalized.code === "session_writer_stale_revision") return normalized;
	return normalized.code === "side_effect_unknown"
		? normalized
		: new FoundationError("side_effect_unknown", normalized.message);
}

function deferred<T>(): { promise: Promise<T>; resolve: () => void } {
	let resolvePromise: () => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = () => resolve(undefined as T);
	});
	return { promise, resolve: resolvePromise };
}

const toolRevisionSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), type: Type.Literal("tool_revision"), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintSchema) },
	{ additionalProperties: false },
);
const toolBindingRefSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), sessionId: Type.Optional(Type.String({ minLength: 1 })), laneId: Type.Optional(Type.String({ minLength: 1 })), runId: Type.Optional(Type.String({ minLength: 1 })), operationId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), dispatchId: Type.Optional(Type.String({ minLength: 1 })), providerId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
const toolArgumentDigestsSchema = Type.Object({ original: FingerprintSchema, accepted: FingerprintSchema }, { additionalProperties: false });
const toolIntentFenceSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), fenceId: Type.String({ minLength: 1 }), intentId: Type.String({ minLength: 1 }), bindingEpochId: Type.String({ minLength: 1 }), acceptedArgumentsDigest: FingerprintSchema, armedAt: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const toolTransformProvenanceSchema = Type.Object({ field: Type.String({ minLength: 1 }), kind: Type.Union(TOOL_TRANSFORM_KINDS.map((kind) => Type.Literal(kind))), transformerId: Type.String({ minLength: 1 }), transformerRevision: Type.Integer({ minimum: 0 }), beforeDigest: FingerprintSchema, afterDigest: FingerprintSchema }, { additionalProperties: false });
const toolGateReferenceSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintSchema), providerId: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
const toolGateRecordSchema = Type.Object(
	{ kind: Type.Union(TOOL_GATE_KINDS.map((kind) => Type.Literal(kind))), verdict: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("reserved")]), reference: toolGateReferenceSchema, reason: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const publicErrorSchema = Type.Object(
	{ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), category: Type.Optional(Type.String()), retryable: Type.Boolean() },
	{ additionalProperties: false },
);
const usageSchema = Type.Object(
	{ tokens: Type.Optional(Type.Integer({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);
const artifactRefSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ pattern: "^sha256:[A-Fa-f0-9]{64}$" }), producer: Type.Optional(Type.String({ minLength: 1 })), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);
const toolResultTextContentSchema = Type.Object(
	{ type: Type.Literal("text"), text: Type.String() },
	{ additionalProperties: false },
);
const toolResultImageContentSchema = Type.Object(
	{ type: Type.Literal("image"), artifact: artifactRefSchema },
	{ additionalProperties: false },
);
const toolResultUsageSchema = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cacheRead: Type.Integer({ minimum: 0 }),
		cacheWrite: Type.Integer({ minimum: 0 }),
		cacheWrite1h: Type.Optional(Type.Integer({ minimum: 0 })),
		reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
		totalTokens: Type.Integer({ minimum: 0 }),
		cost: Type.Object(
			{
				input: Type.Number({ minimum: 0 }),
				output: Type.Number({ minimum: 0 }),
				cacheRead: Type.Number({ minimum: 0 }),
				cacheWrite: Type.Number({ minimum: 0 }),
				total: Type.Number({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const toolResultPayloadSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		content: Type.Array(Type.Union([toolResultTextContentSchema, toolResultImageContentSchema])),
		details: Type.Optional(FoundationJsonValueSchema),
		usage: Type.Optional(toolResultUsageSchema),
		addedToolNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		terminate: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ToolIntentSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), intentId: Type.String({ minLength: 1 }), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })), toolRevision: toolRevisionSchema, binding: toolBindingRefSchema, idempotencyKey: Type.Optional(Type.String({ minLength: 1 })), argumentDigests: toolArgumentDigestsSchema, fence: toolIntentFenceSchema, transformProvenance: Type.Array(toolTransformProvenanceSchema), attempt: Type.Integer({ minimum: 1 }), writtenAt: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const ToolReceiptSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), toolReceiptId: Type.String({ minLength: 1 }), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })), toolRevision: toolRevisionSchema, binding: toolBindingRefSchema, idempotencyKey: Type.Optional(Type.String({ minLength: 1 })), argumentDigests: toolArgumentDigestsSchema, transformProvenance: Type.Array(toolTransformProvenanceSchema), gates: Type.Array(toolGateRecordSchema), sideEffectState: Type.Union(SIDE_EFFECT_STATES.map((state) => Type.Literal(state))), idempotency: Type.Union(IDEMPOTENCY_STATES.map((state) => Type.Literal(state))), attempt: Type.Integer({ minimum: 1 }), retried: Type.Integer({ minimum: 0 }), startedAt: Type.Optional(Type.String({ minLength: 1 })), completedAt: Type.String({ minLength: 1 }), outcome: Type.Union(TOOL_RECEIPT_OUTCOMES.map((outcome) => Type.Literal(outcome))), artifacts: Type.Optional(Type.Array(artifactRefSchema)), usage: Type.Optional(usageSchema), result: Type.Optional(toolResultPayloadSchema), error: Type.Optional(publicErrorSchema), deduplicatedFrom: Type.Optional(Type.String({ minLength: 1 })), digest: FingerprintSchema },
	{ additionalProperties: false },
);
export const ToolBatchResultSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), batchId: Type.String({ minLength: 1 }), status: Type.Union(TOOL_BATCH_STATUSES.map((status) => Type.Literal(status))), receipts: Type.Array(ToolReceiptSchema), usage: usageSchema, conflicts: Type.Array(Type.Object({ keys: Type.Array(Type.String({ minLength: 1 })), toolCallIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false })), maxConcurrency: Type.Integer({ minimum: 0 }), durationMs: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);
export const isToolIntentShape = makeExactShapeGuard<ToolIntent>(ToolIntentSchema, "tool_intent");
export const isToolReceiptShape = makeExactShapeGuard<ToolReceipt>(ToolReceiptSchema, "tool_receipt");
export function validateToolIntent(value: unknown): ResultValue<ToolIntent, FoundationError> { return validateExactShape<ToolIntent>(ToolIntentSchema, value, "tool_intent"); }
export function serializeToolIntent(value: ToolIntent): string { return serializeExactShape(ToolIntentSchema, value, "tool_intent"); }
export function parseToolIntent(text: string): ResultValue<ToolIntent, FoundationError> { return parseExactShape(ToolIntentSchema, text, "tool_intent"); }
export function validateToolReceipt(value: unknown): ResultValue<ToolReceipt, FoundationError> {
	const checked = validateExactShape<ToolReceipt>(ToolReceiptSchema, value, "tool_receipt");
	if (!checked.ok) return checked;
	if (checked.value.result === undefined) {
		const artifactCheck = validateDurableResultArtifacts(undefined, checked.value.artifacts);
		return artifactCheck.ok ? checked : Result.err(artifactCheck.error);
	}
	if (checked.value.outcome !== "succeeded" || checked.value.sideEffectState !== "none") {
		return Result.err(new FoundationError("side_effect_unknown", "non-successful tool receipts cannot carry a durable result payload"));
	}
	const payloadResult = validateToolResultPayload(checked.value.result);
	if (!payloadResult.ok) return Result.err(payloadResult.error);
	const artifactCheck = validateDurableResultArtifacts(payloadResult.value, checked.value.artifacts);
	return artifactCheck.ok ? checked : Result.err(artifactCheck.error);
}
export function serializeToolReceipt(value: ToolReceipt): string { return serializeExactShape(ToolReceiptSchema, value, "tool_receipt"); }
export function parseToolReceipt(text: string): ResultValue<ToolReceipt, FoundationError> { return parseExactShape(ToolReceiptSchema, text, "tool_receipt"); }
export function validateToolBatchResult(value: unknown): ResultValue<ToolBatchResult, FoundationError> { return validateExactShape<ToolBatchResult>(ToolBatchResultSchema, value, "tool_batch_result"); }
export function serializeToolBatchResult(value: ToolBatchResult): string { return serializeExactShape(ToolBatchResultSchema, value, "tool_batch_result"); }
export function parseToolBatchResult(text: string): ResultValue<ToolBatchResult, FoundationError> { return parseExactShape(ToolBatchResultSchema, text, "tool_batch_result"); }
export function toolReceiptIssues(value: unknown): ExactShapeIssue[] { return exactShapeIssues(ToolReceiptSchema, value); }
