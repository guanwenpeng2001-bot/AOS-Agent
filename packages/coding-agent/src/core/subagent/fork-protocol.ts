/**
 * Private Host/Child-Agent stdio JSONL protocol.
 *
 * This channel is not part of PROTOCOL_FEATURE_MATRIX_V1 and does not reuse
 * Operation Worker frame types. A protocol violation is terminal: callers
 * receive subagent_lost and must not retry or reuse the old handle.
 */

import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	validateAttemptReceipt,
	validateBudgetUsage,
	validateExecutionCorrelation,
	type AttemptReceipt,
	type AgentMessage,
	type BudgetUsage,
	type ExecutionCorrelation,
	type Fingerprint,
	type ResultValue,
	type RevisionReference,
	type TaskArtifactProjection,
} from "@aos-agent/agent-core";
import {
	validateChildContextForkPlan,
	type ChildContextForkPlan,
	type ChildRuntimeCriterion,
	type ChildRuntimeLayer,
} from "./context-fork.ts";

export const CHILD_AGENT_PROTOCOL_SCHEMA_VERSION = 1 as const;
export const CHILD_AGENT_PROTOCOL_VERSION = 1 as const;
export const CHILD_AGENT_PROTOCOL_FEATURES = Object.freeze([
	"handshake",
	"turn",
	"cancel",
	"receipt",
	"close",
] as const);
export type ChildAgentProtocolFeature = (typeof CHILD_AGENT_PROTOCOL_FEATURES)[number];

export const CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES = 64 * 1024;
export const CHILD_AGENT_PROTOCOL_MAX_TURN_TEXT_BYTES = 16 * 1024;
export const CHILD_AGENT_PROTOCOL_MAX_OUTPUT_TEXT_BYTES = 16 * 1024;

export const CHILD_AGENT_REQUEST_FRAME_TYPES = Object.freeze(["initialize", "turn", "cancel", "close"] as const);
export type ChildAgentRequestFrameType = (typeof CHILD_AGENT_REQUEST_FRAME_TYPES)[number];

export const CHILD_AGENT_EVENT_FRAME_TYPES = Object.freeze([
	"ready",
	"turn.started",
	"turn.completed",
	"receipt",
	"error",
	"closed",
] as const);
export type ChildAgentEventFrameType = (typeof CHILD_AGENT_EVENT_FRAME_TYPES)[number];

export type ChildAgentCancelReason = "cancel" | "deadline" | "shutdown";

export interface ChildAgentProjectionRef {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly parentBindingId: string;
	readonly childBindingId: string;
	readonly digest: Fingerprint;
}

export interface ChildAgentTranscriptRef {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly spawnId: string;
	readonly attemptId: string;
	readonly leafId?: string;
}

export interface ChildAgentContextProjection {
	readonly schemaVersion: 1;
	readonly plan: ChildContextForkPlan;
	readonly runtime: ChildRuntimeLayer;
	readonly messages: readonly AgentMessage[];
}

export interface ChildAgentInitializeRequest {
	readonly type: "initialize";
	readonly requestId: string;
	readonly spawnId: string;
	readonly protocolVersion: 1;
	readonly features: readonly ChildAgentProtocolFeature[];
	readonly projection: ChildAgentProjectionRef;
	readonly forkSnapshotRef: RevisionReference;
	readonly contextProjection: ChildAgentContextProjection;
	readonly model: { readonly provider: string; readonly model: string };
	readonly correlation: ExecutionCorrelation;
	readonly providerId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId: string;
	readonly transcriptRef?: ChildAgentTranscriptRef;
}

export interface ChildAgentTurnRequest {
	readonly type: "turn";
	readonly requestId: string;
	readonly spawnId: string;
	readonly attemptId: string;
	readonly input: { readonly kind: "prompt"; readonly text: string };
	readonly deadlineAt?: string;
}

export interface ChildAgentCancelRequest {
	readonly type: "cancel";
	readonly requestId: string;
	readonly spawnId: string;
	readonly attemptId: string;
	readonly reason: ChildAgentCancelReason;
}

export interface ChildAgentCloseRequest {
	readonly type: "close";
	readonly requestId: string;
	readonly spawnId: string;
}

export type ChildAgentRequestFrame =
	| ChildAgentInitializeRequest
	| ChildAgentTurnRequest
	| ChildAgentCancelRequest
	| ChildAgentCloseRequest;

export interface ChildAgentReadyEvent {
	readonly type: "ready";
	readonly requestId: string;
	readonly spawnId: string;
	readonly protocolVersion: 1;
	readonly features: readonly ChildAgentProtocolFeature[];
	readonly providerId: string;
	readonly agentInstanceId: string;
}

export interface ChildAgentTurnStartedEvent {
	readonly type: "turn.started";
	readonly requestId: string;
	readonly spawnId: string;
	readonly attemptId: string;
	readonly at: string;
}

export interface ChildAgentTurnCompletedEvent {
	readonly type: "turn.completed";
	readonly requestId: string;
	readonly spawnId: string;
	readonly attemptId: string;
	readonly stopReason: "stop" | "length" | "tool_use" | "error" | "aborted";
	readonly usage: BudgetUsage;
	readonly at: string;
	readonly output?: string;
}

export interface ChildAgentReceiptEvent {
	readonly type: "receipt";
	readonly requestId: string;
	readonly receipt: AttemptReceipt;
}

export interface ChildAgentErrorEvent {
	readonly type: "error";
	readonly requestId?: string;
	readonly spawnId: string;
	readonly code: string;
}

export interface ChildAgentClosedEvent {
	readonly type: "closed";
	readonly requestId: string;
	readonly spawnId: string;
}

export type ChildAgentEventFrame =
	| ChildAgentReadyEvent
	| ChildAgentTurnStartedEvent
	| ChildAgentTurnCompletedEvent
	| ChildAgentReceiptEvent
	| ChildAgentErrorEvent
	| ChildAgentClosedEvent;

export type ChildAgentProtocolFrame = ChildAgentRequestFrame | ChildAgentEventFrame;

export const CHILD_AGENT_REQUEST_FRAME_KEYS: Readonly<Record<ChildAgentRequestFrameType, readonly string[]>> =
	Object.freeze({
		initialize: Object.freeze([
			"type",
			"requestId",
			"spawnId",
			"protocolVersion",
			"features",
			"projection",
			"forkSnapshotRef",
			"contextProjection",
			"model",
			"correlation",
			"providerId",
			"taskId",
			"dispatchId",
			"attemptId",
			"bindingId",
			"bindingEpochId",
			"agentInstanceId",
			"transcriptRef",
		]),
		turn: Object.freeze(["type", "requestId", "spawnId", "attemptId", "input", "deadlineAt"]),
		cancel: Object.freeze(["type", "requestId", "spawnId", "attemptId", "reason"]),
		close: Object.freeze(["type", "requestId", "spawnId"]),
	});

export const CHILD_AGENT_EVENT_FRAME_KEYS: Readonly<Record<ChildAgentEventFrameType, readonly string[]>> =
	Object.freeze({
		ready: Object.freeze([
			"type",
			"requestId",
			"spawnId",
			"protocolVersion",
			"features",
			"providerId",
			"agentInstanceId",
		]),
		"turn.started": Object.freeze(["type", "requestId", "spawnId", "attemptId", "at"]),
		"turn.completed": Object.freeze(["type", "requestId", "spawnId", "attemptId", "stopReason", "usage", "at", "output"]),
		receipt: Object.freeze(["type", "requestId", "receipt"]),
		error: Object.freeze(["type", "requestId", "spawnId", "code"]),
		closed: Object.freeze(["type", "requestId", "spawnId"]),
	});

export type ChildAgentProtocolPhase =
	| "new"
	| "initializing"
	| "ready"
	| "running"
	| "cancelling"
	| "closing"
	| "terminal"
	| "lost";

export interface ChildAgentProtocolState {
	readonly schemaVersion: 1;
	readonly phase: ChildAgentProtocolPhase;
	readonly spawnId?: string;
	readonly attemptId?: string;
	readonly providerId?: string;
	readonly agentInstanceId?: string;
	readonly initializedRequestId?: string;
	readonly readyRequestId?: string;
	readonly turnRequestId?: string;
	readonly turnCompleted: boolean;
	readonly receiptReceived: boolean;
	readonly disconnected: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const STOP_REASONS = new Set(["stop", "length", "tool_use", "error", "aborted"]);
const CANCEL_REASONS = new Set(["cancel", "deadline", "shutdown"]);
const ERROR_CODES = new Set([
	"subagent_lost",
	"subagent_spawn_invalid",
	"subagent_cancel_failed",
	"subagent_resume_failed",
	"subagent_close_unknown",
	"subagent_conflict",
	"invalid_correlation",
	"quota_exceeded",
	"quota_attribution_error",
	"budget_exhausted",
	"side_effect_unknown",
]);

type RecordValue = Record<string, unknown>;
type ProtocolResult<TValue> = ResultValue<TValue, FoundationError>;

function isRecord(value: unknown): value is RecordValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return (
			(prototype === Object.prototype || prototype === null) &&
			Reflect.ownKeys(value).every((key) => typeof key === "string")
		);
	} catch {
		return false;
	}
}

function hasExactKeys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Reflect.ownKeys(value);
	return (
		keys.every((key) => typeof key === "string" && allowed.has(key) && value[key] !== undefined) &&
		required.every((key) => Object.hasOwn(value, key))
	);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function lost(message: string): FoundationError {
	return new FoundationError("subagent_lost", message);
}

function invalid(message: string): FoundationError {
	return new FoundationError("subagent_spawn_invalid", message);
}

export function childAgentProtocolFeaturesMatch(value: unknown): value is readonly ChildAgentProtocolFeature[] {
	if (!Array.isArray(value) || value.length !== CHILD_AGENT_PROTOCOL_FEATURES.length) return false;
	return CHILD_AGENT_PROTOCOL_FEATURES.every((feature, index) => value[index] === feature);
}

function validateFingerprint(value: unknown): value is Fingerprint {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["algorithm", "value"]) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		DIGEST_PATTERN.test(value.value)
	);
}

function validateProjectionRef(value: unknown): value is ChildAgentProjectionRef {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schemaVersion", "spawnId", "parentBindingId", "childBindingId", "digest"]) &&
		value.schemaVersion === 1 &&
		isSafeIdentifier(value.spawnId) &&
		isSafeIdentifier(value.parentBindingId) &&
		isSafeIdentifier(value.childBindingId) &&
		validateFingerprint(value.digest)
	);
}

function validateForkSnapshotRef(value: unknown): value is RevisionReference {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schemaVersion", "type", "id", "revision"], ["fingerprint", "providerId"]) &&
		value.schemaVersion === 1 &&
		value.type === "context_snapshot" &&
		isSafeIdentifier(value.id) &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision >= 0 &&
		(value.fingerprint === undefined || validateFingerprint(value.fingerprint)) &&
		(value.providerId === undefined || isSafeIdentifier(value.providerId))
	);
}

function validateRuntimeCriterion(value: unknown): value is ChildRuntimeCriterion {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["criterionId", "description", "required", "satisfiedBy"]) &&
		isSafeIdentifier(value.criterionId) &&
		typeof value.description === "string" &&
		typeof value.required === "boolean" &&
		typeof value.satisfiedBy === "string"
	);
}

function validateArtifactProjectionArray(value: unknown): value is readonly TaskArtifactProjection[] {
	if (!Array.isArray(value)) return false;
	try {
		canonicalFoundationJson(value);
		return value.every((item) => isRecord(item) && typeof item.artifactId === "string" && item.artifactId.length > 0);
	} catch {
		return false;
	}
}

function validateContextProjection(value: unknown): value is ChildAgentContextProjection {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "plan", "runtime", "messages"]) ||
		value.schemaVersion !== 1 ||
		!validateChildContextForkPlan(value.plan) ||
		!isRecord(value.runtime) ||
		!Array.isArray(value.messages) ||
		!value.messages.every((message) => {
			if (!isRecord(message) || !Array.isArray(message.content)) return false;
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return false;
			try {
				canonicalFoundationJson(message);
				return true;
			} catch {
				return false;
			}
		}) ||
		!hasExactKeys(value.runtime, ["schemaVersion", "kind", "persona", "customInstructions", "goal", "acceptanceCriteria", "inputs", "expectedOutputs"]) ||
		value.runtime.schemaVersion !== 1 ||
		value.runtime.kind !== "system_task" ||
		typeof value.runtime.persona !== "string" ||
		typeof value.runtime.customInstructions !== "string" ||
		typeof value.runtime.goal !== "string" ||
		!Array.isArray(value.runtime.acceptanceCriteria) ||
		!value.runtime.acceptanceCriteria.every(validateRuntimeCriterion) ||
		!validateArtifactProjectionArray(value.runtime.inputs) ||
		!validateArtifactProjectionArray(value.runtime.expectedOutputs)
	) {
		return false;
	}
	return true;
}

function validateTranscriptRef(value: unknown): value is ChildAgentTranscriptRef {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schemaVersion", "sessionId", "laneId", "spawnId", "attemptId"], ["leafId"]) &&
		value.schemaVersion === 1 &&
		isSafeIdentifier(value.sessionId) &&
		isSafeIdentifier(value.laneId) &&
		isSafeIdentifier(value.spawnId) &&
		isSafeIdentifier(value.attemptId) &&
		(value.leafId === undefined || isSafeIdentifier(value.leafId))
	);
}

function validateModelSelection(value: unknown): value is ChildAgentInitializeRequest["model"] {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["provider", "model"]) &&
		typeof value.provider === "string" &&
		value.provider.length > 0 &&
		value.provider.length <= 256 &&
		typeof value.model === "string" &&
		value.model.length > 0 &&
		value.model.length <= 512
	);
}

function validateTurnInput(value: unknown): value is ChildAgentTurnRequest["input"] {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["kind", "text"]) &&
		value.kind === "prompt" &&
		typeof value.text === "string" &&
		utf8ByteLength(value.text) <= CHILD_AGENT_PROTOCOL_MAX_TURN_TEXT_BYTES
	);
}

export function validateChildAgentRequestFrame(value: unknown): ProtocolResult<ChildAgentRequestFrame> {
	if (!isRecord(value) || typeof value.type !== "string") return Result.err(lost("Child Agent request frame is invalid"));
	if (value.type === "initialize") {
		if (
			!hasExactKeys(
				value,
				[
					"type",
					"requestId",
					"spawnId",
					"protocolVersion",
					"features",
					"projection",
					"forkSnapshotRef",
					"contextProjection",
					"model",
					"correlation",
					"providerId",
					"taskId",
					"dispatchId",
					"attemptId",
					"bindingId",
					"bindingEpochId",
					"agentInstanceId",
				],
				["transcriptRef"],
			) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			value.protocolVersion !== CHILD_AGENT_PROTOCOL_VERSION ||
			!childAgentProtocolFeaturesMatch(value.features) ||
			!validateProjectionRef(value.projection) ||
			value.projection.spawnId !== value.spawnId ||
			!validateForkSnapshotRef(value.forkSnapshotRef) ||
			!validateContextProjection(value.contextProjection) ||
			!validateModelSelection(value.model) ||
			value.contextProjection.plan.spawnId !== value.spawnId ||
			canonicalFoundationJson(value.contextProjection.plan.childSnapshotRef) !== canonicalFoundationJson(value.forkSnapshotRef) ||
			!validateExecutionCorrelation(value.correlation).ok ||
			!isSafeIdentifier(value.providerId) ||
			!isSafeIdentifier(value.taskId) ||
			!isSafeIdentifier(value.dispatchId) ||
			!isSafeIdentifier(value.attemptId) ||
			!isSafeIdentifier(value.bindingId) ||
			!isSafeIdentifier(value.bindingEpochId) ||
			!isSafeIdentifier(value.agentInstanceId) ||
			(value.transcriptRef !== undefined && !validateTranscriptRef(value.transcriptRef))
		) {
			return Result.err(lost("Child Agent initialize frame is invalid"));
		}
		const correlation = value.correlation as ExecutionCorrelation;
		if (
			correlation.taskId !== value.taskId ||
			correlation.dispatchId !== value.dispatchId ||
			correlation.attemptId !== value.attemptId ||
			correlation.bindingId !== value.bindingId ||
			correlation.bindingEpochId !== value.bindingEpochId ||
			correlation.agentInstanceId !== value.agentInstanceId ||
			correlation.providerId !== value.providerId
		) {
			return Result.err(lost("Child Agent initialize correlation does not match its identities"));
		}
		return Result.ok(value as unknown as ChildAgentInitializeRequest);
	}
	if (value.type === "turn") {
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId", "attemptId", "input"], ["deadlineAt"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			!isSafeIdentifier(value.attemptId) ||
			!validateTurnInput(value.input) ||
			(value.deadlineAt !== undefined && !isCanonicalTimestamp(value.deadlineAt))
		) {
			return Result.err(lost("Child Agent turn frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentTurnRequest);
	}
	if (value.type === "cancel") {
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId", "attemptId", "reason"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			!isSafeIdentifier(value.attemptId) ||
			typeof value.reason !== "string" ||
			!CANCEL_REASONS.has(value.reason)
		) {
			return Result.err(lost("Child Agent cancel frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentCancelRequest);
	}
	if (value.type === "close") {
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId)
		) {
			return Result.err(lost("Child Agent close frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentCloseRequest);
	}
	return Result.err(lost("Child Agent request frame type is unknown"));
}

export function validateChildAgentEventFrame(value: unknown): ProtocolResult<ChildAgentEventFrame> {
	if (!isRecord(value) || typeof value.type !== "string") return Result.err(lost("Child Agent event frame is invalid"));
	if (value.type === "ready") {
		if (
			!hasExactKeys(value, [
				"type",
				"requestId",
				"spawnId",
				"protocolVersion",
				"features",
				"providerId",
				"agentInstanceId",
			]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			value.protocolVersion !== CHILD_AGENT_PROTOCOL_VERSION ||
			!childAgentProtocolFeaturesMatch(value.features) ||
			!isSafeIdentifier(value.providerId) ||
			!isSafeIdentifier(value.agentInstanceId)
		) {
			return Result.err(lost("Child Agent ready frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentReadyEvent);
	}
	if (value.type === "turn.started") {
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId", "attemptId", "at"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			!isSafeIdentifier(value.attemptId) ||
			!isCanonicalTimestamp(value.at)
		) {
			return Result.err(lost("Child Agent turn.started frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentTurnStartedEvent);
	}
	if (value.type === "turn.completed") {
		const usage = validateBudgetUsage(value.usage);
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId", "attemptId", "stopReason", "usage", "at"], ["output"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId) ||
			!isSafeIdentifier(value.attemptId) ||
			typeof value.stopReason !== "string" ||
			!STOP_REASONS.has(value.stopReason) ||
			!isCanonicalTimestamp(value.at) ||
			!usage.ok ||
			!childAgentUsageIsPresent(usage.value) ||
			(value.output !== undefined && (typeof value.output !== "string" || utf8ByteLength(value.output) > CHILD_AGENT_PROTOCOL_MAX_OUTPUT_TEXT_BYTES))
		) {
			return Result.err(lost("Child Agent turn.completed frame is invalid"));
		}
		return Result.ok({
			type: "turn.completed",
			requestId: value.requestId as string,
			spawnId: value.spawnId as string,
			attemptId: value.attemptId as string,
			stopReason: value.stopReason as ChildAgentTurnCompletedEvent["stopReason"],
			usage: usage.value,
			at: value.at as string,
			...(value.output === undefined ? {} : { output: value.output as string }),
		});
	}
	if (value.type === "receipt") {
		if (!hasExactKeys(value, ["type", "requestId", "receipt"]) || !isSafeIdentifier(value.requestId)) {
			return Result.err(lost("Child Agent receipt frame is invalid"));
		}
		const receipt = validateAttemptReceipt(value.receipt, { providerClass: "agent" });
		if (!receipt.ok) return Result.err(lost("Child Agent receipt is not a legal agent_executor AttemptReceipt"));
		return Result.ok({ type: "receipt", requestId: value.requestId as string, receipt: receipt.value });
	}
	if (value.type === "error") {
		if (
			!hasExactKeys(value, ["type", "spawnId", "code"], ["requestId"]) ||
			!isSafeIdentifier(value.spawnId) ||
			typeof value.code !== "string" ||
			!ERROR_CODES.has(value.code) ||
			(value.requestId !== undefined && !isSafeIdentifier(value.requestId))
		) {
			return Result.err(lost("Child Agent error frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentErrorEvent);
	}
	if (value.type === "closed") {
		if (
			!hasExactKeys(value, ["type", "requestId", "spawnId"]) ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.spawnId)
		) {
			return Result.err(lost("Child Agent closed frame is invalid"));
		}
		return Result.ok(value as unknown as ChildAgentClosedEvent);
	}
	return Result.err(lost("Child Agent event frame type is unknown"));
}

export function validateChildAgentProtocolFrame(value: unknown): ProtocolResult<ChildAgentProtocolFrame> {
	if (!isRecord(value) || typeof value.type !== "string") return Result.err(lost("Child Agent protocol frame is invalid"));
	if ((CHILD_AGENT_REQUEST_FRAME_TYPES as readonly string[]).includes(value.type)) {
		return validateChildAgentRequestFrame(value);
	}
	if ((CHILD_AGENT_EVENT_FRAME_TYPES as readonly string[]).includes(value.type)) {
		return validateChildAgentEventFrame(value);
	}
	return Result.err(lost("Child Agent protocol frame type is unknown"));
}

export function serializeChildAgentFrame(value: unknown): string {
	const checked = validateChildAgentProtocolFrame(value);
	if (!checked.ok) throw checked.error;
	let encoded: string;
	try {
		encoded = canonicalFoundationJson(checked.value);
	} catch {
		throw lost("Child Agent protocol frame is not canonical JSON");
	}
	if (utf8ByteLength(encoded) + 1 > CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES) {
		throw lost("Child Agent protocol frame exceeds the byte bound");
	}
	return encoded;
}

export function serializeChildAgentFrameLine(value: unknown): string {
	return `${serializeChildAgentFrame(value)}\n`;
}

function stripSingleLineEnding(value: string): string | undefined {
	if (value.endsWith("\r\n")) return value.slice(0, -2);
	if (value.endsWith("\n")) return value.slice(0, -1);
	if (value.includes("\r") || value.includes("\n")) return undefined;
	return value;
}

export function parseChildAgentFrame(text: string): ProtocolResult<ChildAgentProtocolFrame> {
	if (typeof text !== "string" || utf8ByteLength(text) > CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES) {
		return Result.err(lost("Child Agent protocol frame is malformed"));
	}
	const line = stripSingleLineEnding(text);
	if (line === undefined || line.length === 0) return Result.err(lost("Child Agent protocol frame is malformed"));
	try {
		return validateChildAgentProtocolFrame(JSON.parse(line) as unknown);
	} catch (error) {
		if (error instanceof FoundationError) return Result.err(error);
		return Result.err(lost("Child Agent protocol frame is malformed"));
	}
}

export function createChildAgentProtocolState(): ChildAgentProtocolState {
	return Object.freeze({
		schemaVersion: CHILD_AGENT_PROTOCOL_SCHEMA_VERSION,
		phase: "new",
		receiptReceived: false,
		turnCompleted: false,
		disconnected: false,
	});
}

function freezeState(value: ChildAgentProtocolState): ChildAgentProtocolState {
	return Object.freeze({ ...value });
}

export function applyChildAgentRequestFrame(
	state: ChildAgentProtocolState,
	value: unknown,
): ProtocolResult<{ readonly state: ChildAgentProtocolState; readonly frame: ChildAgentRequestFrame }> {
	const checked = validateChildAgentRequestFrame(value);
	if (!checked.ok) return checked;
	const frame = checked.value;
	if (state.disconnected || state.phase === "lost") return Result.err(lost("Child Agent protocol is already lost"));
	if (frame.type === "initialize") {
		if (state.phase !== "new") return Result.err(lost("Child Agent initialize is not allowed in the current phase"));
		return Result.ok({
			frame,
			state: freezeState({
				...state,
				phase: "initializing",
				spawnId: frame.spawnId,
				attemptId: frame.attemptId,
				providerId: frame.providerId,
				agentInstanceId: frame.agentInstanceId,
				initializedRequestId: frame.requestId,
			}),
		});
	}
	if (state.spawnId !== undefined && frame.spawnId !== state.spawnId) {
		return Result.err(lost("Child Agent request spawnId does not match the session"));
	}
	if (frame.type === "turn") {
		if (state.phase !== "ready" && state.phase !== "running") {
			return Result.err(lost("Child Agent turn is not allowed in the current phase"));
		}
		if (state.attemptId !== undefined && frame.attemptId !== state.attemptId) {
			return Result.err(lost("Child Agent turn attemptId does not match the session"));
		}
		return Result.ok({
			frame,
			state: freezeState({
				...state,
				phase: "running",
				turnRequestId: frame.requestId,
				turnCompleted: false,
				receiptReceived: false,
			}),
		});
	}
	if (frame.type === "cancel") {
		if (state.phase === "new" || state.phase === "terminal" || state.phase === "closing") {
			return Result.err(lost("Child Agent cancel is not allowed in the current phase"));
		}
		return Result.ok({ frame, state: freezeState({ ...state, phase: "cancelling" }) });
	}
	return Result.ok({
		frame,
		state: freezeState({
			...state,
			phase: "closing",
		}),
	});
}

export function applyChildAgentEventFrame(
	state: ChildAgentProtocolState,
	value: unknown,
): ProtocolResult<{ readonly state: ChildAgentProtocolState; readonly frame: ChildAgentEventFrame }> {
	const checked = validateChildAgentEventFrame(value);
	if (!checked.ok) return checked;
	const frame = checked.value;
	if (state.disconnected || state.phase === "lost") return Result.err(lost("Child Agent protocol is already lost"));
	if (frame.type === "ready") {
		if (state.phase !== "initializing" || state.initializedRequestId !== frame.requestId) {
			return Result.err(lost("Child Agent ready does not match initialize"));
		}
		if (
			state.spawnId !== frame.spawnId ||
			state.providerId !== frame.providerId ||
			state.agentInstanceId !== frame.agentInstanceId
		) {
			return Result.err(lost("Child Agent ready identity does not match initialize"));
		}
		return Result.ok({
			frame,
			state: freezeState({
				...state,
				phase: "ready",
				readyRequestId: frame.requestId,
			}),
		});
	}
	if (frame.type === "error") {
		return Result.ok({ frame, state: freezeState({ ...state, phase: "lost", disconnected: true }) });
	}
	if (state.spawnId !== undefined && "spawnId" in frame && frame.spawnId !== state.spawnId) {
		return Result.err(lost("Child Agent event spawnId does not match the session"));
	}
	if (frame.type === "turn.started") {
		if ((state.phase !== "running" && state.phase !== "cancelling") || state.turnRequestId !== frame.requestId) {
			return Result.err(lost("Child Agent turn.started does not match the active turn"));
		}
		return Result.ok({ frame, state });
	}
	if (frame.type === "turn.completed") {
		if (
			(state.phase !== "running" && state.phase !== "cancelling") ||
			state.turnRequestId !== frame.requestId ||
			state.turnCompleted
		) {
			return Result.err(lost("Child Agent turn.completed does not match the active turn"));
		}
		return Result.ok({ frame, state: freezeState({ ...state, turnCompleted: true }) });
	}
	if (frame.type === "receipt") {
		if (state.turnRequestId !== frame.requestId || !state.turnCompleted) {
			return Result.err(lost("Child Agent receipt does not follow its completed turn"));
		}
		if (state.receiptReceived) return Result.err(lost("Child Agent receipt was duplicated"));
		return Result.ok({
			frame,
			state: freezeState({
				...state,
				phase: "terminal",
				receiptReceived: true,
			}),
		});
	}
	if (state.phase !== "closing" && state.phase !== "terminal") {
		return Result.err(lost("Child Agent closed is not allowed in the current phase"));
	}
	return Result.ok({ frame, state: freezeState({ ...state, phase: "terminal" }) });
}

export function disconnectChildAgentProtocol(state: ChildAgentProtocolState): ChildAgentProtocolState {
	return freezeState({ ...state, phase: "lost", disconnected: true });
}

export class ChildAgentProtocolSession {
	private currentState: ChildAgentProtocolState;

	constructor() {
		this.currentState = createChildAgentProtocolState();
	}

	get state(): ChildAgentProtocolState {
		return this.currentState;
	}

	receiveHostFrame(
		value: unknown,
	): ProtocolResult<{ readonly state: ChildAgentProtocolState; readonly frame: ChildAgentRequestFrame }> {
		const result = applyChildAgentRequestFrame(this.currentState, value);
		if (result.ok) this.currentState = result.value.state;
		return result;
	}

	receiveChildFrame(
		value: unknown,
	): ProtocolResult<{ readonly state: ChildAgentProtocolState; readonly frame: ChildAgentEventFrame }> {
		const result = applyChildAgentEventFrame(this.currentState, value);
		if (result.ok) this.currentState = result.value.state;
		return result;
	}

	markLost(): ChildAgentProtocolState {
		this.currentState = disconnectChildAgentProtocol(this.currentState);
		return this.currentState;
	}
}

export function childAgentUsageIsPresent(usage: BudgetUsage): boolean {
	return (usage.tokens ?? 0) > 0 || (usage.modelCalls ?? 0) > 0 || (usage.toolCalls ?? 0) > 0;
}

export function childAgentProtocolLost(message: string): FoundationError {
	return lost(message);
}

export function childAgentProtocolInvalid(message: string): FoundationError {
	return invalid(message);
}
