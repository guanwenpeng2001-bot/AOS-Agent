import { Type } from "typebox";
import type { TSchema } from "typebox";
import {
	FoundationError,
	publicExecutionError,
	toFoundationError,
	type FoundationErrorCode,
	type PublicExecutionErrorV1,
} from "./foundation/errors.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, newFoundationId, type ExecutionCorrelationV1, type FingerprintV1 } from "./foundation/identity.ts";
import type { BudgetUsageV1, BudgetV1 } from "./foundation/budget.ts";
import {
	selectorsNarrow,
	type ArtifactRefV1,
	type CapabilitySelectorV1,
	type RevisionReferenceV1,
	type VersionedReferenceV1,
} from "./foundation/reference.ts";
import type { AgentBindingV1, BindingEpochV1 } from "./foundation/role.ts";
import {
	IDEMPOTENCY_STATES,
	SIDE_EFFECT_STATES,
	isSideEffectRetryable,
	type IdempotencyV1,
	type SideEffectStateV1,
} from "./foundation/side-effect.ts";
import type { QuotaReservationV1 } from "./foundation/providers.ts";
import type {
	AppendFoundationRecordResultV1,
	FoundationRecordQueryV1,
	FoundationRecordV1,
	ProvisionedFoundationRecordV1,
} from "./session/durable/types.ts";
import { DurableLedgerError } from "./session/durable/errors.ts";
import { Result, type Result as ResultValue } from "./result.ts";
import {
	type ExactShapeIssue,
	FingerprintV1Schema,
	exactShapeIssues,
	makeExactShapeGuard,
	parseExactShape,
	serializeExactShape,
	validateExactShape,
} from "./foundation/schema.ts";

/** Schema version carried by every tool-pipeline durable fact. */
export const TOOL_PIPELINE_SCHEMA_VERSION = 1 as const;
export type ToolPipelineSchemaVersionV1 = typeof TOOL_PIPELINE_SCHEMA_VERSION;

/** The only legal order for one tool invocation. */
export const TOOL_PIPELINE_STAGES_V1 = ["prepare", "pre", "guard", "execute", "post", "finalize"] as const;
export type ToolPipelineStageV1 = (typeof TOOL_PIPELINE_STAGES_V1)[number];

/** Monotonic gate kinds enforced by the guard stage. */
export const TOOL_GATE_KINDS_V1 = ["capability", "policy", "approval", "sandbox", "quota", "conflict_lock"] as const;
export type ToolGateKindV1 = (typeof TOOL_GATE_KINDS_V1)[number];

/** Terminal outcomes of a finalized ToolReceipt. */
export const TOOL_RECEIPT_OUTCOMES_V1 = ["succeeded", "failed", "blocked", "cancelled", "side_effect_unknown"] as const;
export type ToolReceiptOutcomeV1 = (typeof TOOL_RECEIPT_OUTCOMES_V1)[number];

/** Deterministic batch join statuses. */
export const TOOL_BATCH_STATUSES_V1 = ["succeeded", "partial_failure", "failed", "cancelled"] as const;
export type ToolBatchStatusV1 = (typeof TOOL_BATCH_STATUSES_V1)[number];

/** Transform provenance kinds for accepted arguments versus original arguments. */
export const TOOL_TRANSFORM_KINDS_V1 = ["original", "defaulted", "normalized", "coerced", "removed", "redacted"] as const;
export type ToolArgumentTransformKindV1 = (typeof TOOL_TRANSFORM_KINDS_V1)[number];

/** Frozen revision consumed by one invocation. */
export interface ToolRevisionV1 {
	schemaVersion: 1;
	type: "tool_revision";
	id: string;
	revision: number;
	fingerprint?: FingerprintV1;
}

/** Frozen binding identity consumed by one invocation. */
export interface ToolBindingRefV1 {
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
export interface ToolArgumentDigestsV1 {
	original: FingerprintV1;
	accepted: FingerprintV1;
}

/** Durable execution fence armed with the accepted argument digest. */
export interface ToolIntentFenceV1 {
	schemaVersion: 1;
	fenceId: string;
	intentId: string;
	bindingEpochId: string;
	acceptedArgumentsDigest: FingerprintV1;
	armedAt: string;
}

/** Per-field argument transform provenance. */
export interface ToolTransformProvenanceV1 {
	field: string;
	kind: ToolArgumentTransformKindV1;
}

/** Verdict record for one monotonic gate. */
export interface ToolGateRecordV1 {
	kind: ToolGateKindV1;
	verdict: "allowed" | "denied" | "reserved";
	/** The revision against which this verdict was evaluated. */
	reference: VersionedReferenceV1;
	reason?: string;
}

/** Durable pre-call intent. It is written before guard or execute. */
export interface ToolIntentV1 {
	schemaVersion: 1;
	intentId: string;
	toolCallId: string;
	toolName: string;
	namespace?: string;
	toolRevision: ToolRevisionV1;
	binding: ToolBindingRefV1;
	idempotencyKey?: string;
	argumentDigests: ToolArgumentDigestsV1;
	fence: ToolIntentFenceV1;
	transformProvenance: readonly ToolTransformProvenanceV1[];
	attempt: number;
	writtenAt: string;
}

/** Finalized durable result for one invocation. */
export interface ToolReceiptV1 {
	schemaVersion: 1;
	toolReceiptId: string;
	toolCallId: string;
	toolName: string;
	namespace?: string;
	toolRevision: ToolRevisionV1;
	binding: ToolBindingRefV1;
	idempotencyKey?: string;
	argumentDigests: ToolArgumentDigestsV1;
	transformProvenance: readonly ToolTransformProvenanceV1[];
	gates: readonly ToolGateRecordV1[];
	sideEffectState: SideEffectStateV1;
	idempotency: IdempotencyV1;
	attempt: number;
	retried: number;
	startedAt?: string;
	completedAt: string;
	outcome: ToolReceiptOutcomeV1;
	artifacts?: readonly ArtifactRefV1[];
	usage?: BudgetUsageV1;
	error?: PublicExecutionErrorV1;
	/** Set when this receipt replays an earlier receipt with the same key. */
	deduplicatedFrom?: string;
	digest: FingerprintV1;
}

/** One overlapping conflict-key group in a batch. */
export interface ToolConflictV1 {
	keys: readonly string[];
	toolCallIds: readonly string[];
}

/** Deterministic source-order join of a batch. */
export interface ToolBatchResultV1 {
	schemaVersion: 1;
	batchId: string;
	status: ToolBatchStatusV1;
	receipts: readonly ToolReceiptV1[];
	usage: BudgetUsageV1;
	conflicts: readonly ToolConflictV1[];
	/** Effective concurrency cap for this batch. */
	maxConcurrency: number;
	durationMs: number;
}

/** A tool call submitted to the pipeline. */
export interface ToolCallV1 {
	toolCallId: string;
	toolName: string;
	namespace?: string;
	args: FoundationJsonValue;
	/** Keys are scoped to the frozen binding epoch. */
	idempotencyKey?: string;
	attempt?: number;
}

/** Immutable execution context captured for a pipeline run. */
export interface ToolPipelineContextV1 {
	sessionId: string;
	laneId: string;
	/** Durable operation identity; runId is an alias retained for correlation clarity. */
	runId?: string;
	operationId?: string;
	binding: AgentBindingV1;
	bindingEpoch: BindingEpochV1;
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
export interface ToolExecutionV1 {
	ok: boolean;
	sideEffectState: SideEffectStateV1;
	artifacts?: readonly ArtifactRefV1[];
	usage?: BudgetUsageV1;
	error?: PublicExecutionErrorV1;
}

export interface ToolExecuteOptionsV1 {
	toolCallId: string;
	signal?: AbortSignal;
	context: ToolPipelineContextV1;
	attempt: number;
	deadlineAt?: number;
	onUpdate?: (partial: unknown) => void;
}

/**
 * Provider-neutral tool definition. The pipeline snapshots this definition
 * at prepare and never resolves it again during execute or retry.
 */
export interface ToolDefinitionV1 {
	name: string;
	namespace?: string;
	label?: string;
	description?: string;
	toolRevision: ToolRevisionV1;
	capabilities: readonly string[];
	parameters: TSchema;
	executionMode?: "sequential" | "parallel";
	prepareArguments?: (args: unknown) => unknown;
	conflictKeys?: (args: Record<string, unknown>) => readonly string[];
	idempotency?: IdempotencyV1;
	execute(args: Record<string, unknown>, options: ToolExecuteOptionsV1): Promise<ToolExecutionV1>;
}

export interface ToolDefinitionRegistryV1 {
	resolve(toolName: string, namespace?: string): ResultValue<ToolDefinitionV1, FoundationError>;
}

/** Verdict of one gate check. References must be explicit and versioned. */
export interface ToolGateVerdictV1 {
	allowed: boolean;
	reference: VersionedReferenceV1;
	reason?: string;
}

export type ToolGateCheckV1 = (
	scope: ToolGateScopeV1,
) => ResultValue<ToolGateVerdictV1, FoundationError> | Promise<ResultValue<ToolGateVerdictV1, FoundationError>>;

/** Everything consulted by a gate. */
export interface ToolGateScopeV1 {
	context: ToolPipelineContextV1;
	tool: ToolDefinitionV1;
	args: Record<string, unknown>;
	intent: ToolIntentV1;
	acceptedArgsDigest: FingerprintV1;
	conflictKeys: readonly string[];
}

/**
 * Guard implementations must not widen a previous denial. `release` is an
 * optional lifecycle hook for conflict locks and quota reservations.
 */
export interface ToolGuardSetV1 {
	guard(scope: ToolGateScopeV1): Promise<ResultValue<readonly ToolGateRecordV1[], FoundationError>>;
	release?(scope: ToolGateScopeV1): Promise<void> | void;
	cleanup?(): Promise<void> | void;
}

/** Durable storage consumed by the pre and finalize stages. */
export interface ToolPipelineStorageV1 {
	writeIntent(intent: ToolIntentV1): Promise<ResultValue<ToolIntentV1, FoundationError>>;
	finalizeReceipt(receipt: ToolReceiptV1): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>>;
	/** Optional durable snapshots used to recover intents left without a fact. */
	listIntents?(query?: ToolPipelineStorageQueryV1): Promise<readonly ToolIntentV1[]>;
	listReceipts?(query?: ToolPipelineStorageQueryV1): Promise<readonly ToolReceiptV1[]>;
}

export interface ToolPipelineStorageQueryV1 {
	correlation?: Partial<ExecutionCorrelationV1>;
}

/** Minimal append/query surface used to keep tool facts in the Session ledger. */
export interface ToolPipelineLedgerV1 {
	appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1>;
	findFoundationRecords(query?: FoundationRecordQueryV1): Promise<FoundationRecordV1[]>;
}

export interface SessionToolPipelineStorageOptionsV1 {
	ledger: ToolPipelineLedgerV1;
	laneId: string;
	correlationFor: (kind: "intent" | "receipt", value: ToolIntentV1 | ToolReceiptV1) => ExecutionCorrelationV1;
	/** Supplies the current writer fence for every default ledger append. */
	fencingToken?: () => string | Promise<string>;
}

/** Session-backed storage: intents and receipts share the one Foundation ledger. */
export class SessionToolPipelineStorageV1 implements ToolPipelineStorageV1 {
	private readonly ledger: ToolPipelineLedgerV1;
	private readonly laneId: string;
	private readonly correlationFor: SessionToolPipelineStorageOptionsV1["correlationFor"];
	private readonly fencingToken?: SessionToolPipelineStorageOptionsV1["fencingToken"];

	constructor(options: SessionToolPipelineStorageOptionsV1) {
		this.ledger = options.ledger;
		this.laneId = options.laneId;
		this.correlationFor = options.correlationFor;
		this.fencingToken = options.fencingToken;
	}

	async writeIntent(intent: ToolIntentV1): Promise<ResultValue<ToolIntentV1, FoundationError>> {
		try {
			const correlation = validateToolCorrelation(intent, this.correlationFor("intent", intent), this.laneId);
			if (!correlation.ok) return correlation;
			const prior = await this.ledger.findFoundationRecords({ kind: "intent", objectType: "tool_intent", objectId: intent.intentId, includePruned: true, order: "oldestFirst", correlation: correlationQuery(correlation.value) });
			const existing = prior.find((record) => record.kind === "intent");
			if (existing?.payload !== undefined) {
				const checked = validateToolIntentV1(existing.payload);
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
			const checked = validateToolIntentV1(result.record.payload);
			return checked;
		} catch (error) {
			return Result.err(toToolPipelineStorageError(error));
		}
	}

	async finalizeReceipt(receipt: ToolReceiptV1): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>> {
		try {
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

	async listIntents(query?: ToolPipelineStorageQueryV1): Promise<readonly ToolIntentV1[]> {
		const records = await this.ledger.findFoundationRecords({ kind: "intent", objectType: "tool_intent", includePruned: true, order: "oldestFirst", ...(query?.correlation === undefined ? {} : { correlation: query.correlation }) });
		return records.filter((record): record is Extract<FoundationRecordV1, { kind: "intent" }> => record.kind === "intent" && record.payload !== undefined).map((record) => {
			const checked = validateToolIntentV1(record.payload);
			if (!checked.ok) throw checked.error;
			return checked.value;
		});
	}

	async listReceipts(query?: ToolPipelineStorageQueryV1): Promise<readonly ToolReceiptV1[]> {
		const records = await this.ledger.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", includePruned: true, order: "oldestFirst", ...(query?.correlation === undefined ? {} : { correlation: query.correlation }) });
		return records.filter((record): record is Extract<FoundationRecordV1, { kind: "fact" }> => record.kind === "fact").map((record) => {
			const checked = validateToolReceiptV1(record.payload);
			if (!checked.ok) throw checked.error;
			return checked.value;
		});
	}
}

function validateToolCorrelation(
	value: ToolIntentV1 | ToolReceiptV1,
	correlation: ExecutionCorrelationV1,
	laneId: string,
): ResultValue<ExecutionCorrelationV1, FoundationError> {
	const binding = value.binding;
	const expected: Array<[keyof ExecutionCorrelationV1, string | undefined]> = [
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

function correlationQuery(correlation: ExecutionCorrelationV1): Partial<ExecutionCorrelationV1> {
	const { revision: _revision, fencingToken: _fencingToken, ...identity } = correlation;
	return identity;
}

function toToolPipelineStorageError(error: unknown): FoundationError {
	if (error instanceof DurableLedgerError) return new FoundationError(error.code as FoundationErrorCode, error.message);
	return toFoundationError(error, "side_effect_unknown");
}

export interface ToolPipelineCleanupV1 {
	release(): Promise<void>;
}

/** Host-side quota accounting used by the default quota gate. */
export interface ToolQuotaAccountV1 extends ToolPipelineCleanupV1 {
	reserve(scope: ToolGateScopeV1): ResultValue<VersionedReferenceV1, FoundationError>;
	settle(receipt: ToolReceiptV1): void;
	readonly usage: BudgetUsageV1;
	readonly reservations: readonly QuotaReservationV1[];
}

export interface FoundationToolGuardOptionsV1 {
	capability?: { check?: ToolGateCheckV1 };
	policy?: { check?: ToolGateCheckV1 };
	approval?: { check?: ToolGateCheckV1 };
	sandbox?: { check?: ToolGateCheckV1 };
	quota?: { account?: ToolQuotaAccountV1; check?: ToolGateCheckV1 };
	conflictLock?: { check?: ToolGateCheckV1 };
}

export interface ToolPipelineStageEventV1 {
	stage: ToolPipelineStageV1;
	toolCallId: string;
}

export interface ToolPipelineOptionsV1 {
	registry: ToolDefinitionRegistryV1;
	guard?: ToolGuardSetV1;
	storage?: ToolPipelineStorageV1;
	quotaAccount?: ToolQuotaAccountV1;
	budget?: BudgetV1;
	maxConcurrency?: number;
	maxToolCalls?: number;
	maxRetries?: number;
	now?: () => string;
	nowMs?: () => number;
	idGenerator?: (prefix: string) => string;
	canonicalizeConflictKey?: (key: string) => string;
	onStage?: (event: ToolPipelineStageEventV1) => void | Promise<void>;
}

export function createToolBindingRefV1(context: ToolPipelineContextV1): ToolBindingRefV1 {
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

function toVersionedReference(reference: RevisionReferenceV1): VersionedReferenceV1 {
	return freeze({
		schemaVersion: 1,
		type: reference.type,
		id: reference.id,
		revision: reference.revision,
		...(reference.fingerprint === undefined ? {} : { fingerprint: { ...reference.fingerprint } }),
		...(reference.providerId === undefined ? {} : { providerId: reference.providerId }),
	});
}

function capacityReference(context: ToolPipelineContextV1, type = "agent_binding"): VersionedReferenceV1 {
	return {
		schemaVersion: 1,
		type,
		id: context.binding.bindingId,
		revision: context.bindingEpoch.ordinal,
	};
}

/** Default capability gate: required tool capabilities must fit the binding selector. */
function defaultCapabilityCheck(scope: ToolGateScopeV1): ResultValue<ToolGateVerdictV1, FoundationError> {
	const required = scope.tool.capabilities;
	const reference = toVersionedReference(scope.context.binding.capabilityRevision);
	if (required.length === 0) return Result.ok({ allowed: true, reference });
	const requested: CapabilitySelectorV1 = { policy: "named", named: [...required] };
	const allowed = selectorsNarrow(scope.context.binding.capabilitySelector, requested);
	return Result.ok({
		allowed,
		reference,
		reason: allowed ? undefined : "tool capability is outside the binding capability selector",
	});
}

/** Default storage keeps standalone pipeline use deterministic and testable. */
export class InMemoryToolPipelineStorageV1 implements ToolPipelineStorageV1 {
	readonly intents: ToolIntentV1[] = [];
	readonly receipts: ToolReceiptV1[] = [];
	private readonly intentsById = new Map<string, ToolIntentV1>();
	private readonly receiptsById = new Map<string, ToolReceiptV1>();

	async writeIntent(intent: ToolIntentV1): Promise<ResultValue<ToolIntentV1, FoundationError>> {
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

	async finalizeReceipt(receipt: ToolReceiptV1): Promise<ResultValue<{ toolReceiptRef: string }, FoundationError>> {
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

	async listIntents(): Promise<readonly ToolIntentV1[]> {
		return [...this.intents];
	}

	async listReceipts(): Promise<readonly ToolReceiptV1[]> {
		return [...this.receipts];
	}
}

export interface FoundationToolQuotaAccountOptionsV1 {
	budget?: BudgetV1;
	maxToolCalls?: number;
	idGenerator?: (prefix: string) => string;
	now?: () => string;
}

/**
 * Small single-host quota account. Reservations are made synchronously at the
 * quota gate, so parallel calls cannot race the tool-call limit.
 */
export class FoundationToolQuotaAccountV1 implements ToolQuotaAccountV1 {
	readonly usage: BudgetUsageV1 = {};
	readonly reservations: QuotaReservationV1[] = [];

	private readonly budget: BudgetV1;
	private readonly maxToolCalls: number | undefined;
	private readonly idGenerator: (prefix: string) => string;
	private readonly now: () => string;

	constructor(options: FoundationToolQuotaAccountOptionsV1 = {}) {
		this.budget = freeze({ ...(options.budget ?? {}) });
		this.maxToolCalls = options.maxToolCalls;
		this.idGenerator = options.idGenerator ?? ((prefix) => newFoundationId(prefix.replace(/[^a-z0-9-]/gi, "-")));
		this.now = options.now ?? (() => new Date().toISOString());
	}

	reserve(scope: ToolGateScopeV1): ResultValue<VersionedReferenceV1, FoundationError> {
		const budget: BudgetV1 = freeze(tightenBudget(scope.context.binding.budget, this.budget));
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
		this.reservations.push({
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
		});
		return Result.ok(capacityReference(scope.context, "tool_quota"));
	}

	settle(receipt: ToolReceiptV1): void {
		if (receipt.usage === undefined || receipt.deduplicatedFrom !== undefined) return;
		this.usage.tokens = (this.usage.tokens ?? 0) + (receipt.usage.tokens ?? 0);
		this.usage.costUsd = (this.usage.costUsd ?? 0) + (receipt.usage.costUsd ?? 0);
		this.usage.modelCalls = (this.usage.modelCalls ?? 0) + (receipt.usage.modelCalls ?? 0);
		this.usage.wallClockMs = (this.usage.wallClockMs ?? 0) + (receipt.usage.wallClockMs ?? 0);
	}

	async release(): Promise<void> {
		this.reservations.splice(0);
	}
}

/**
 * Default monotonic guard. Denials are sticky for a binding epoch and gate
 * reference; conflict locks are held until the pipeline releases the scope.
 */
export class FoundationToolGuardV1 implements ToolGuardSetV1 {
	private readonly checks: Record<ToolGateKindV1, ToolGateCheckV1>;
	private readonly denials = new Map<string, ToolGateRecordV1>();
	private readonly conflictOwners = new Map<string, string>();
	private readonly quotaAccount: ToolQuotaAccountV1 | undefined;

	constructor(options: FoundationToolGuardOptionsV1 = {}) {
		this.quotaAccount = options.quota?.account;
		const deniedByDefault = (kind: ToolGateKindV1): ToolGateCheckV1 => (scope) => Result.ok({
			allowed: false,
			reference: capacityReference(scope.context, `tool_${kind}`),
			reason: `${kind} guard has no configured authority`,
		});
		const defaultQuota: ToolGateCheckV1 = (scope) => {
			if (this.quotaAccount === undefined) return Result.ok({ allowed: false, reference: capacityReference(scope.context, "tool_quota"), reason: "quota guard has no configured account" });
			const reserved = this.quotaAccount.reserve(scope);
			return reserved.ok
				? Result.ok({ allowed: true, reference: reserved.value })
				: Result.ok({ allowed: false, reference: capacityReference(scope.context, "tool_quota"), reason: reserved.error.message });
		};
		const defaultConflictLock: ToolGateCheckV1 = (scope) => {
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

	async guard(scope: ToolGateScopeV1): Promise<ResultValue<readonly ToolGateRecordV1[], FoundationError>> {
		const records: ToolGateRecordV1[] = [];
		for (const kind of TOOL_GATE_KINDS_V1) {
			const checked = await this.checkKind(kind, scope);
			if (!checked.ok) return checked;
			records.push(checked.value);
			if (checked.value.verdict === "denied") break;
		}
		return Result.ok(freeze(records));
	}

	async release(scope: ToolGateScopeV1): Promise<void> {
		for (const key of scope.conflictKeys) {
			const ownerKey = conflictOwnerKey(scope, key);
			if (this.conflictOwners.get(ownerKey) === scope.intent.toolCallId) this.conflictOwners.delete(ownerKey);
		}
		await this.quotaAccount?.release();
	}

	async cleanup(): Promise<void> {
		this.conflictOwners.clear();
		await this.quotaAccount?.release();
	}

	private async checkKind(kind: ToolGateKindV1, scope: ToolGateScopeV1): Promise<ResultValue<ToolGateRecordV1, FoundationError>> {
		let verdict: ResultValue<ToolGateVerdictV1, FoundationError>;
		try {
			verdict = await this.checks[kind](scope);
		} catch (error) {
			return Result.err(toFoundationError(error, "tool_guard_denied"));
		}
		if (!verdict.ok) return verdict;
		const windowKey = `${scope.context.bindingEpoch.bindingEpochId}:${kind}:${verdict.value.reference.type}:${verdict.value.reference.id}:${verdict.value.reference.revision ?? 0}`;
		const denied = this.denials.get(windowKey);
		if (denied !== undefined) return Result.ok(denied);
		const record: ToolGateRecordV1 = {
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
export class FoundationToolPipelineV1 {
	private readonly registry: ToolDefinitionRegistryV1;
	private readonly guard: ToolGuardSetV1;
	private readonly storage: ToolPipelineStorageV1;
	private readonly budget: BudgetV1;
	private readonly maxConcurrency: number | undefined;
	private readonly maxRetries: number;
	private readonly now: () => string;
	private readonly nowMs: () => number;
	private readonly idGenerator: (prefix: string) => string;
	private readonly canonicalizeConflictKey: (key: string) => string;
	private readonly quotaAccount: ToolQuotaAccountV1;
	private readonly onStage: ((event: ToolPipelineStageEventV1) => void | Promise<void>) | undefined;
	private readonly completedByKey = new Map<string, { receipt: ToolReceiptV1; signature: string }>();
	private readonly persistedIntents = new Map<string, ToolIntentV1>();
	private readonly persistedReceipts = new Map<string, ToolReceiptV1>();
	private readonly recoveredScopes = new Set<string>();

	constructor(options: ToolPipelineOptionsV1) {
		this.registry = options.registry;
		this.storage = options.storage ?? new InMemoryToolPipelineStorageV1();
		this.budget = freeze({ ...(options.budget ?? {}) });
		this.maxConcurrency = normalizePositiveLimit(options.maxConcurrency ?? this.budget.concurrency);
		this.maxRetries = normalizeNonNegativeInteger(options.maxRetries ?? 0, "maxRetries");
		this.now = options.now ?? (() => new Date().toISOString());
		this.nowMs = options.nowMs ?? Date.now;
		this.idGenerator = options.idGenerator ?? ((prefix) => newFoundationId(prefix.replace(/[^a-z0-9-]/gi, "-")));
		this.canonicalizeConflictKey = options.canonicalizeConflictKey ?? ((key) => key.trim());
		this.quotaAccount = options.quotaAccount ?? new FoundationToolQuotaAccountV1({ budget: this.budget, maxToolCalls: options.maxToolCalls, idGenerator: this.idGenerator, now: this.now });
		this.guard = options.guard ?? new FoundationToolGuardV1({ quota: { account: this.quotaAccount } });
		this.onStage = options.onStage;
	}

	/** Single-call convenience API. */
	async execute(
		call: ToolCallV1,
		context: ToolPipelineContextV1,
		options: { signal?: AbortSignal; deadlineAt?: number; onUpdate?: (partial: unknown) => void } = {},
	): Promise<ResultValue<ToolReceiptV1, FoundationError>> {
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
	async recoverUnsettled(context?: ToolPipelineContextV1): Promise<ResultValue<readonly ToolReceiptV1[], FoundationError>> {
		if (this.storage.listIntents === undefined || this.storage.listReceipts === undefined) return Result.ok([]);
		let intents: readonly ToolIntentV1[];
		let receipts: readonly ToolReceiptV1[];
		try {
			const query = context === undefined ? undefined : toolStorageQuery(context);
			intents = await this.storage.listIntents(query);
			receipts = await this.storage.listReceipts(query);
		} catch (error) {
			return Result.err(toFoundationError(error, "side_effect_unknown"));
		}
		const recovered: ToolReceiptV1[] = [];
		for (const intent of intents) {
			const checkedIntent = validateToolIntentV1(intent);
			if (!checkedIntent.ok) return checkedIntent;
			if (context !== undefined && !toolIdentityMatchesContext(intent, context)) continue;
			const matching = receipts.filter((receipt) => receiptIdentityMatchesIntent(receipt, intent));
			let foundExact = false;
			for (const candidate of matching) {
				const checkedReceipt = validateAndVerifyToolReceiptV1(candidate);
				if (!checkedReceipt.ok) return checkedReceipt;
				if (receiptMatchesIntent(checkedReceipt.value, intent)) {
					foundExact = true;
					break;
				}
				return Result.err(new FoundationError("invalid_correlation", "durable tool receipt identity or digest does not match its intent"));
			}
			if (foundExact) continue;
			const receipt = finalizeToolReceiptV1({
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

	async recoverPending(): Promise<ResultValue<readonly ToolReceiptV1[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async recoverPendingIntents(): Promise<ResultValue<readonly ToolReceiptV1[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async recover(): Promise<ResultValue<readonly ToolReceiptV1[], FoundationError>> {
		return this.recoverUnsettled();
	}

	async executeBatch(
		calls: readonly ToolCallV1[],
		context: ToolPipelineContextV1,
		options: { signal?: AbortSignal; deadlineAt?: number; onUpdate?: (partial: unknown) => void } = {},
	): Promise<ResultValue<ToolBatchResultV1, FoundationError>> {
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

			const prepared: PreparedCallV1[] = [];
			for (const call of calls) {
				const entry = await this.prepare(call, context);
				if (!entry.ok) return entry;
				prepared.push(entry.value);
			}
			const conflicts = detectConflicts(prepared);
			const dependencies = computeDependencies(prepared);
			const conflictDependencies = computeConflictDependencies(prepared);
			const receipts = new Array<ToolReceiptV1 | undefined>(prepared.length);
			const settledStates = new Array<SettledCallStateV1 | undefined>(prepared.length);
			const errors: FoundationError[] = [];
			const settled = prepared.map(() => deferred<void>());
			const signal = options.signal;
			const effectiveConcurrency = Math.max(1, Math.min(this.maxConcurrency ?? prepared.length, prepared.length));
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
				let scope: ToolGateScopeV1 | undefined;
				try {
					if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
						const cancelled = await this.finalize(entry, context, { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", error: signal?.aborted ? cancellationError() : deadlineError() });
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
			try {
				await this.quotaAccount.release();
			} finally {
				await this.guard.cleanup?.();
			}
		}
	}

	private peakConcurrency = 0;

	private async prepare(call: ToolCallV1, context: ToolPipelineContextV1): Promise<ResultValue<PreparedCallV1, FoundationError>> {
		if (call.toolCallId.length === 0 || call.toolName.length === 0) return Result.err(new FoundationError("invalid_identifier", "tool call id and name must not be empty"));
		if (call.idempotencyKey !== undefined && call.idempotencyKey.length === 0) return Result.err(new FoundationError("invalid_identifier", "idempotency key must not be empty"));
		const resolved = this.registry.resolve(call.toolName, call.namespace);
		if (!resolved.ok) return resolved;
		const tool = snapshotToolDefinition(resolved.value);
		let original: FoundationJsonValue;
		let acceptedArgs: Record<string, unknown>;
		try {
			original = cloneFoundationValue(call.args);
			const accepted = tool.prepareArguments === undefined ? original : tool.prepareArguments(cloneFoundationValue(original));
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
		const provenance = argumentTransformProvenance(original, acceptedArgs);
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
			binding: createToolBindingRefV1(context),
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
		const expectedIntent = persisted ?? intent;
		const written = await this.storage.writeIntent(expectedIntent);
		if (!written.ok) return written;
		const durableIntent = validateDurableIntent(written.value, expectedIntent);
		if (!durableIntent.ok) return durableIntent;
		await this.onStage?.({ stage: "prepare", toolCallId: call.toolCallId });
		await this.onStage?.({ stage: "pre", toolCallId: call.toolCallId });
		const dedupKey = call.idempotencyKey === undefined ? undefined : idempotencyScopeKey(context, call.idempotencyKey);
		const signature = invocationSignature(durableIntent.value);
		const replay = dedupKey === undefined ? undefined : this.completedByKey.get(dedupKey) ?? this.persistentByKey.get(dedupKey);
		if (replay !== undefined && replay.signature !== signature) {
			return Result.err(new FoundationError("goal_conflict", "idempotency key was already used for different frozen tool arguments"));
		}
		return Result.ok({
			call: freeze({ ...call, args: original }),
			tool,
			intent: durableIntent.value,
			acceptedArgs: freeze(acceptedArgs),
			conflictKeys: conflictKeysResult.value,
			gateRecords: [],
			replay: replay?.receipt,
		});
	}

	private readonly persistentByKey = new Map<string, { receipt: ToolReceiptV1; signature: string }>();

	private async loadPersistentState(context: ToolPipelineContextV1): Promise<void> {
		const query = toolStorageQuery(context);
		if (this.storage.listIntents !== undefined) {
			for (const intent of await this.storage.listIntents(query)) {
				const checked = validateToolIntentV1(intent);
				if (!checked.ok) throw checked.error;
				this.persistedIntents.set(intent.intentId, checked.value);
			}
		}
		if (this.storage.listReceipts !== undefined) {
			for (const receipt of await this.storage.listReceipts(query)) {
				const checked = validateAndVerifyToolReceiptV1(receipt);
				if (!checked.ok) throw checked.error;
				this.persistedReceipts.set(receipt.toolReceiptId, checked.value);
				if (receipt.idempotencyKey !== undefined) {
					const key = idempotencyScopeKeyFromBinding(receipt.binding, receipt.idempotencyKey);
					const signature = invocationSignatureFromReceipt(checked.value);
					const existing = this.persistentByKey.get(key);
					if (existing !== undefined && existing.signature !== signature) throw new FoundationError("goal_conflict", "durable receipts disagree for one idempotency identity");
					this.persistentByKey.set(key, { receipt: checked.value, signature });
				}
			}
		}
	}

	private scopeFor(entry: PreparedCallV1, context: ToolPipelineContextV1): ToolGateScopeV1 {
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
		prepared: PreparedCallV1,
		context: ToolPipelineContextV1,
		signal: AbortSignal | undefined,
		scope: ToolGateScopeV1,
		options: { deadlineAt?: number; onUpdate?: (partial: unknown) => void },
	): Promise<ResultValue<ToolReceiptV1, FoundationError>> {
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
			return this.finalize(prepared, context, { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", error: signal?.aborted ? cancellationError() : deadlineError() });
		}

		const idempotency: IdempotencyV1 = prepared.tool.idempotency ?? "non_idempotent";
		const startedAt = this.now();
		let retried = 0;
		let execution: ToolExecutionV1 | undefined;
		for (;;) {
			if (signal?.aborted || deadlineReached(options.deadlineAt ?? context.deadlineAt, this.nowMs())) {
				return this.finalize(prepared, context, { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", error: signal?.aborted ? cancellationError() : deadlineError(), startedAt, retried });
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
		const sideEffectState: SideEffectStateV1 = execution?.sideEffectState === "none"
			? "none"
			: "side_effect_unknown";
		const outcome: ToolReceiptOutcomeV1 =
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
			artifacts: execution?.artifacts,
			startedAt,
			retried,
		});
	}

	private async finalize(
		prepared: PreparedCallV1,
		context: ToolPipelineContextV1,
		state: {
			outcome: ToolReceiptOutcomeV1;
			sideEffectState: SideEffectStateV1;
			error?: PublicExecutionErrorV1;
			usage?: BudgetUsageV1;
			artifacts?: readonly ArtifactRefV1[];
			startedAt?: string;
			retried?: number;
		},
	): Promise<ResultValue<ToolReceiptV1, FoundationError>> {
		await this.onStage?.({ stage: "finalize", toolCallId: prepared.call.toolCallId });
		const receipt = finalizeToolReceiptV1({
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
			...(state.artifacts === undefined ? {} : { artifacts: [...state.artifacts] }),
			...(state.usage === undefined ? {} : { usage: { ...state.usage } }),
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
		if (key !== undefined) this.completedByKey.set(key, { receipt, signature: invocationSignature(prepared.intent) });
		this.quotaAccount.settle(receipt);
		return Result.ok(receipt);
	}

	private async withDedup(prepared: PreparedCallV1, source: ToolReceiptV1): Promise<ResultValue<ToolReceiptV1, FoundationError>> {
		const receipt = finalizeToolReceiptV1({
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
			sideEffectState: source.sideEffectState,
			idempotency: source.idempotency,
			attempt: prepared.intent.attempt,
			retried: source.retried,
			...(source.startedAt === undefined ? {} : { startedAt: source.startedAt }),
			completedAt: this.now(),
			outcome: source.outcome,
			...(source.artifacts === undefined ? {} : { artifacts: source.artifacts }),
			...(source.usage === undefined ? {} : { usage: source.usage }),
			...(source.error === undefined ? {} : { error: source.error }),
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

	private syntheticCancelledReceipt(entry: PreparedCallV1, context: ToolPipelineContextV1): ToolReceiptV1 {
		return finalizeToolReceiptV1({
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

export const ToolPipelineV1 = FoundationToolPipelineV1;
export const FoundationToolPipeline = FoundationToolPipelineV1;

export function createFoundationToolPipelineV1(options: ToolPipelineOptionsV1): FoundationToolPipelineV1 {
	return new FoundationToolPipelineV1(options);
}

interface PreparedCallV1 {
	call: ToolCallV1;
	tool: ToolDefinitionV1;
	intent: ToolIntentV1;
	acceptedArgs: Record<string, unknown>;
	conflictKeys: readonly string[];
	gateRecords: readonly ToolGateRecordV1[];
	replay?: ToolReceiptV1;
}

interface SettledCallStateV1 {
	receipt?: ToolReceiptV1;
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

function argumentTransformProvenance(original: FoundationJsonValue, accepted: Record<string, unknown>): readonly ToolTransformProvenanceV1[] {
	const originalRecord = original !== null && typeof original === "object" && !Array.isArray(original) ? original : undefined;
	const fields = new Set([...(originalRecord === undefined ? [] : Object.keys(originalRecord)), ...Object.keys(accepted)]);
	const provenance: ToolTransformProvenanceV1[] = [];
	for (const field of fields) {
		const hadOriginal = originalRecord !== undefined && field in originalRecord;
		const hasAccepted = field in accepted;
		if (!hadOriginal && hasAccepted) provenance.push({ field, kind: "defaulted" });
		else if (hadOriginal && !hasAccepted) provenance.push({ field, kind: "removed" });
		else if (hadOriginal && hasAccepted) {
			const before = originalRecord[field];
			const after = accepted[field];
			let same = false;
			try {
				same = fingerprintFoundationValue(before).value === fingerprintFoundationValue(after).value;
			} catch {
				same = false;
			}
			const kind: ToolArgumentTransformKindV1 = same
				? "original"
				: typeof before !== typeof after
					? "coerced"
					: after === "[redacted]"
						? "redacted"
						: "normalized";
			provenance.push({ field, kind });
		}
	}
	return freeze(provenance.sort((a, b) => a.field.localeCompare(b.field)));
}

function collectConflictKeys(
	tool: ToolDefinitionV1,
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

function detectConflicts(prepared: readonly PreparedCallV1[]): readonly ToolConflictV1[] {
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

function computeDependencies(prepared: readonly PreparedCallV1[]): Map<number, readonly number[]> {
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

function computeConflictDependencies(prepared: readonly PreparedCallV1[]): Map<number, readonly number[]> {
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
	settledStates: readonly (SettledCallStateV1 | undefined)[],
): { index: number } | undefined {
	for (const index of dependencies) {
		const state = settledStates[index];
		if (state === undefined || state.error !== undefined) return { index };
		const receipt = state.receipt;
		if (receipt === undefined || receipt.sideEffectState !== "none" || receipt.outcome === "side_effect_unknown") return { index };
	}
	return undefined;
}

function joinStatus(receipts: readonly ToolReceiptV1[]): ToolBatchStatusV1 {
	if (receipts.length === 0 || receipts.every((receipt) => receipt.outcome === "succeeded")) return "succeeded";
	if (receipts.every((receipt) => receipt.outcome === "cancelled")) return "cancelled";
	if (receipts.some((receipt) => receipt.outcome === "succeeded")) return "partial_failure";
	if (receipts.some((receipt) => receipt.outcome === "cancelled") && receipts.every((receipt) => receipt.outcome === "cancelled" || receipt.outcome === "blocked")) return "cancelled";
	return receipts.some((receipt) => receipt.outcome === "cancelled") ? "partial_failure" : "failed";
}

function summarizeUsage(receipts: readonly ToolReceiptV1[]): BudgetUsageV1 {
	const usage: BudgetUsageV1 = { toolCalls: receipts.length };
	for (const receipt of receipts) {
		if (receipt.usage === undefined) continue;
		usage.tokens = (usage.tokens ?? 0) + (receipt.usage.tokens ?? 0);
		usage.costUsd = (usage.costUsd ?? 0) + (receipt.usage.costUsd ?? 0);
		usage.modelCalls = (usage.modelCalls ?? 0) + (receipt.usage.modelCalls ?? 0);
		usage.wallClockMs = (usage.wallClockMs ?? 0) + (receipt.usage.wallClockMs ?? 0);
	}
	return freeze(usage);
}

function tightenBudget(binding: BudgetV1, local: BudgetV1): BudgetV1 {
	const result: BudgetV1 = {};
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
export function finalizeToolReceiptV1(receipt: Omit<ToolReceiptV1, "digest">): ToolReceiptV1 {
	const snapshot = cloneUnknownRecord(receipt);
	return freeze({ ...snapshot, digest: fingerprintFoundationValue(snapshot) } as ToolReceiptV1);
}

/** Stable digest of JSON-like tool arguments, excluding provider-side state. */
export function digestToolArguments(value: unknown): string {
	return fingerprintFoundationValue(value).value;
}

export const argumentDigest = digestToolArguments;

export function digestToolArgumentsV1(value: unknown): FingerprintV1 {
	return fingerprintFoundationValue(value);
}

function snapshotToolDefinition(tool: ToolDefinitionV1): ToolDefinitionV1 {
	if (tool.name.length === 0 || tool.toolRevision.id.length === 0 || tool.toolRevision.revision < 0) throw new FoundationError("invalid_identifier", "tool definition has an invalid identity");
	return freeze({
		...tool,
		toolRevision: cloneToolRevision(tool.toolRevision),
		capabilities: freeze([...tool.capabilities]),
		...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
	});
}

function cloneToolRevision(value: ToolRevisionV1): ToolRevisionV1 {
	return freeze({
		schemaVersion: 1 as const,
		type: "tool_revision" as const,
		id: value.id,
		revision: value.revision,
		...(value.fingerprint === undefined ? {} : { fingerprint: { ...value.fingerprint } }),
	});
}

function validatePipelineContext(context: ToolPipelineContextV1): ResultValue<ToolPipelineContextV1, FoundationError> {
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

function cloneToolIntent(value: ToolIntentV1): ToolIntentV1 {
	return JSON.parse(canonicalFoundationJson(value)) as ToolIntentV1;
}

function cloneToolReceipt(value: ToolReceiptV1): ToolReceiptV1 {
	return JSON.parse(canonicalFoundationJson(value)) as ToolReceiptV1;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function idempotencyScopeKey(context: ToolPipelineContextV1, key: string): string {
	return idempotencyScopeKeyFromBinding(createToolBindingRefV1(context), key);
}

function contextRecoveryScope(context: ToolPipelineContextV1): string {
	return canonicalFoundationJson(toolStorageQuery(context));
}

function toolStorageQuery(context: ToolPipelineContextV1): ToolPipelineStorageQueryV1 {
	const binding = createToolBindingRefV1(context);
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

function idempotencyScopeKeyFromBinding(binding: ToolBindingRefV1, key: string): string {
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

function toolIdentityMatchesContext(value: ToolIntentV1 | ToolReceiptV1, context: ToolPipelineContextV1): boolean {
	const binding = value.binding;
	const fullIdentity = context.runId !== undefined || context.operationId !== undefined;
	const expected: Array<[keyof ToolBindingRefV1, string | undefined]> = [
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

function receiptIdentityMatchesIntent(receipt: ToolReceiptV1, intent: ToolIntentV1): boolean {
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

function invocationSignature(intent: ToolIntentV1): string {
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

function invocationSignatureFromReceipt(receipt: ToolReceiptV1): string {
	return canonicalFoundationJson({
		toolCallId: receipt.toolCallId,
		toolName: receipt.toolName,
		toolRevision: receipt.toolRevision,
		binding: receipt.binding,
		argumentDigests: receipt.argumentDigests,
		...(receipt.namespace === undefined ? {} : { namespace: receipt.namespace }),
	});
}

function validateAndVerifyToolReceiptV1(value: unknown): ResultValue<ToolReceiptV1, FoundationError> {
	const checked = validateToolReceiptV1(value);
	if (!checked.ok) return checked;
	const { digest: _digest, ...withoutDigest } = checked.value;
	const expected = fingerprintFoundationValue(withoutDigest);
	if (expected.algorithm !== checked.value.digest.algorithm || expected.value !== checked.value.digest.value) {
		return Result.err(new FoundationError("side_effect_unknown", "durable tool receipt digest is invalid"));
	}
	return checked;
}

function receiptMatchesIntent(receipt: ToolReceiptV1, intent: ToolIntentV1): boolean {
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

function validateDurableIntent(value: ToolIntentV1, expected: ToolIntentV1): ResultValue<ToolIntentV1, FoundationError> {
	const shape = validateToolIntentV1(value);
	if (!shape.ok) return shape;
	const intent = shape.value;
	const sameDigest = intent.argumentDigests.accepted.algorithm === expected.argumentDigests.accepted.algorithm && intent.argumentDigests.accepted.value === expected.argumentDigests.accepted.value;
	const sameFence = intent.fence.fenceId === expected.fence.fenceId && intent.fence.intentId === expected.intentId && intent.fence.bindingEpochId === expected.binding.bindingEpochId && intent.fence.acceptedArgumentsDigest.algorithm === expected.argumentDigests.accepted.algorithm && intent.fence.acceptedArgumentsDigest.value === expected.argumentDigests.accepted.value;
	if (intent.intentId !== expected.intentId || intent.toolCallId !== expected.toolCallId || intent.toolName !== expected.toolName || intent.namespace !== expected.namespace || canonicalFoundationJson(intent.toolRevision) !== canonicalFoundationJson(expected.toolRevision) || canonicalFoundationJson(intent.binding) !== canonicalFoundationJson(expected.binding) || intent.idempotencyKey !== expected.idempotencyKey || !sameDigest || intent.argumentDigests.original.value !== expected.argumentDigests.original.value || canonicalFoundationJson(intent.transformProvenance) !== canonicalFoundationJson(expected.transformProvenance) || !sameFence) {
		return Result.err(new FoundationError("tool_guard_denied", "durable tool intent changed before execution"));
	}
	return Result.ok(intent);
}

function validateMonotonicGateRecords(records: readonly ToolGateRecordV1[]): ResultValue<true, FoundationError> {
	let denied = false;
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		if (record.kind !== TOOL_GATE_KINDS_V1[index]) {
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
	if (!denied && records.length !== TOOL_GATE_KINDS_V1.length) {
		return Result.err(new FoundationError("tool_guard_denied", "all fixed tool guards must run before a side effect"));
	}
	return Result.ok(true);
}

function conflictOwnerKey(scope: ToolGateScopeV1, key: string): string {
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

function findDuplicateCallId(calls: readonly ToolCallV1[]): string | undefined {
	const seen = new Set<string>();
	for (const call of calls) {
		if (seen.has(call.toolCallId)) return call.toolCallId;
		seen.add(call.toolCallId);
	}
	return undefined;
}

function cancellationError(): PublicExecutionErrorV1 {
	return publicExecutionError("tool_cancelled", "tool execution was cancelled", { category: "cancelled" });
}

function deadlineError(): PublicExecutionErrorV1 {
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
	{ schemaVersion: Type.Literal(1), type: Type.Literal("tool_revision"), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(FingerprintV1Schema) },
	{ additionalProperties: false },
);
const toolBindingRefSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), sessionId: Type.Optional(Type.String({ minLength: 1 })), laneId: Type.Optional(Type.String({ minLength: 1 })), runId: Type.Optional(Type.String({ minLength: 1 })), operationId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), dispatchId: Type.Optional(Type.String({ minLength: 1 })), providerId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
const toolArgumentDigestsSchema = Type.Object({ original: FingerprintV1Schema, accepted: FingerprintV1Schema }, { additionalProperties: false });
const toolIntentFenceSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), fenceId: Type.String({ minLength: 1 }), intentId: Type.String({ minLength: 1 }), bindingEpochId: Type.String({ minLength: 1 }), acceptedArgumentsDigest: FingerprintV1Schema, armedAt: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const toolTransformProvenanceSchema = Type.Object({ field: Type.String({ minLength: 1 }), kind: Type.Union(TOOL_TRANSFORM_KINDS_V1.map((kind) => Type.Literal(kind))) }, { additionalProperties: false });
const toolGateReferenceSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintV1Schema), providerId: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
const toolGateRecordSchema = Type.Object(
	{ kind: Type.Union(TOOL_GATE_KINDS_V1.map((kind) => Type.Literal(kind))), verdict: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("reserved")]), reference: toolGateReferenceSchema, reason: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const publicErrorSchema = Type.Object(
	{ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), category: Type.Optional(Type.String()), retryable: Type.Boolean() },
	{ additionalProperties: false },
);
const usageSchema = Type.Object(
	{ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);
const artifactRefSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ pattern: "^sha256:[A-Fa-f0-9]{64}$" }), producer: Type.Optional(Type.String({ minLength: 1 })), sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);

export const ToolIntentV1Schema = Type.Object(
	{ schemaVersion: Type.Literal(1), intentId: Type.String({ minLength: 1 }), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })), toolRevision: toolRevisionSchema, binding: toolBindingRefSchema, idempotencyKey: Type.Optional(Type.String({ minLength: 1 })), argumentDigests: toolArgumentDigestsSchema, fence: toolIntentFenceSchema, transformProvenance: Type.Array(toolTransformProvenanceSchema), attempt: Type.Integer({ minimum: 1 }), writtenAt: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const ToolReceiptV1Schema = Type.Object(
	{ schemaVersion: Type.Literal(1), toolReceiptId: Type.String({ minLength: 1 }), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })), toolRevision: toolRevisionSchema, binding: toolBindingRefSchema, idempotencyKey: Type.Optional(Type.String({ minLength: 1 })), argumentDigests: toolArgumentDigestsSchema, transformProvenance: Type.Array(toolTransformProvenanceSchema), gates: Type.Array(toolGateRecordSchema), sideEffectState: Type.Union(SIDE_EFFECT_STATES.map((state) => Type.Literal(state))), idempotency: Type.Union(IDEMPOTENCY_STATES.map((state) => Type.Literal(state))), attempt: Type.Integer({ minimum: 1 }), retried: Type.Integer({ minimum: 0 }), startedAt: Type.Optional(Type.String({ minLength: 1 })), completedAt: Type.String({ minLength: 1 }), outcome: Type.Union(TOOL_RECEIPT_OUTCOMES_V1.map((outcome) => Type.Literal(outcome))), artifacts: Type.Optional(Type.Array(artifactRefSchema)), usage: Type.Optional(usageSchema), error: Type.Optional(publicErrorSchema), deduplicatedFrom: Type.Optional(Type.String({ minLength: 1 })), digest: FingerprintV1Schema },
	{ additionalProperties: false },
);
export const ToolBatchResultV1Schema = Type.Object(
	{ schemaVersion: Type.Literal(1), batchId: Type.String({ minLength: 1 }), status: Type.Union(TOOL_BATCH_STATUSES_V1.map((status) => Type.Literal(status))), receipts: Type.Array(ToolReceiptV1Schema), usage: usageSchema, conflicts: Type.Array(Type.Object({ keys: Type.Array(Type.String({ minLength: 1 })), toolCallIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false })), maxConcurrency: Type.Integer({ minimum: 0 }), durationMs: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);
export const isToolIntentV1Shape = makeExactShapeGuard<ToolIntentV1>(ToolIntentV1Schema, "tool_intent");
export const isToolReceiptV1Shape = makeExactShapeGuard<ToolReceiptV1>(ToolReceiptV1Schema, "tool_receipt");
export function validateToolIntentV1(value: unknown): ResultValue<ToolIntentV1, FoundationError> { return validateExactShape<ToolIntentV1>(ToolIntentV1Schema, value, "tool_intent"); }
export function serializeToolIntentV1(value: ToolIntentV1): string { return serializeExactShape(ToolIntentV1Schema, value, "tool_intent"); }
export function parseToolIntentV1(text: string): ResultValue<ToolIntentV1, FoundationError> { return parseExactShape(ToolIntentV1Schema, text, "tool_intent"); }
export function validateToolReceiptV1(value: unknown): ResultValue<ToolReceiptV1, FoundationError> { return validateExactShape<ToolReceiptV1>(ToolReceiptV1Schema, value, "tool_receipt"); }
export function serializeToolReceiptV1(value: ToolReceiptV1): string { return serializeExactShape(ToolReceiptV1Schema, value, "tool_receipt"); }
export function parseToolReceiptV1(text: string): ResultValue<ToolReceiptV1, FoundationError> { return parseExactShape(ToolReceiptV1Schema, text, "tool_receipt"); }
export function validateToolBatchResultV1(value: unknown): ResultValue<ToolBatchResultV1, FoundationError> { return validateExactShape<ToolBatchResultV1>(ToolBatchResultV1Schema, value, "tool_batch_result"); }
export function serializeToolBatchResultV1(value: ToolBatchResultV1): string { return serializeExactShape(ToolBatchResultV1Schema, value, "tool_batch_result"); }
export function parseToolBatchResultV1(text: string): ResultValue<ToolBatchResultV1, FoundationError> { return parseExactShape(ToolBatchResultV1Schema, text, "tool_batch_result"); }
export function toolReceiptIssuesV1(value: unknown): ExactShapeIssue[] { return exactShapeIssues(ToolReceiptV1Schema, value); }
