/**
 * Pure Operation Worker identity and lifecycle contracts.
 *
 * This module owns no process, provider, Session, Attempt, Task, or Run
 * authority. It folds safe Host-side Worker facts only. A later Supervisor
 * may use these functions before it persists typed lifecycle events.
 */

import { createHash } from "node:crypto";
import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	type Result as ResultValue,
	type SideEffectState,
} from "@aos-agent/agent-core";

export const WORKER_SCHEMA_VERSION = 1 as const;

export const WORKER_LIFECYCLE_STATUSES = [
	"new",
	"starting",
	"ready",
	"running",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
	"lost",
	"reclaiming",
	"reclaimed",
	"reclaim_unknown",
] as const;
export type WorkerLifecycleStatus = (typeof WORKER_LIFECYCLE_STATUSES)[number];

export const WORKER_EXECUTION_TERMINAL_STATUSES = ["completed", "failed", "cancelled", "lost"] as const;
export type WorkerExecutionTerminalStatus = (typeof WORKER_EXECUTION_TERMINAL_STATUSES)[number];

export const WORKER_RECLAIM_TERMINAL_STATUSES = ["reclaimed", "reclaim_unknown"] as const;
export type WorkerReclaimTerminalStatus = (typeof WORKER_RECLAIM_TERMINAL_STATUSES)[number];

/** Immutable safe identity frozen before Worker activation. */
export interface WorkerBinding {
	readonly schemaVersion: 1;
	readonly workerId: string;
	readonly providerId: string;
	readonly sessionId: string;
	readonly laneId: string;
	readonly runId?: string;
	readonly bindingId?: string;
	readonly bindingEpochId?: string;
	readonly attemptId?: string;
	readonly profileId: string;
	readonly profileRevision: number;
	readonly capabilitySummary: readonly string[];
	readonly deadlineAt?: number;
	readonly credentialTargetRefs: readonly string[];
	readonly requestFingerprint: string;
}

/** Durable/public-safe Worker snapshot. Execution resources never enter it. */
export interface WorkerRecord {
	readonly schemaVersion: 1;
	readonly workerId: string;
	readonly providerId: string;
	readonly sessionId: string;
	readonly laneId: string;
	readonly runId?: string;
	readonly bindingId?: string;
	readonly bindingEpochId?: string;
	readonly attemptId?: string;
	readonly profileId: string;
	readonly status: WorkerLifecycleStatus;
	readonly revision: number;
	readonly createdAt: string;
	readonly readyAt?: string;
	readonly endedAt?: string;
	readonly lastHeartbeatAt?: string;
	readonly activeOperationId?: string;
	readonly receiptId?: string;
}

/** One revision-checked mutation request. The binding is an identity echo. */
export interface WorkerTransition {
	readonly schemaVersion: 1;
	readonly clientRequestId: string;
	readonly expectedRevision: number;
	readonly binding: WorkerBinding;
	readonly to: WorkerLifecycleStatus;
	readonly at: string;
	readonly activeOperationId?: string;
	readonly receiptId?: string;
	readonly sideEffectState?: SideEffectState;
}

export interface WorkerTransitionReceipt {
	readonly schemaVersion: 1;
	readonly clientRequestId: string;
	readonly requestFingerprint: string;
	readonly from: WorkerLifecycleStatus;
	readonly to: WorkerLifecycleStatus;
	readonly previousRevision: number;
	readonly revision: number;
	readonly at: string;
	readonly operationId?: string;
	readonly receiptId?: string;
	readonly sideEffectState?: SideEffectState;
}

/** Monotonic liveness fact. It never extends a deadline or lease. */
export interface WorkerHeartbeat {
	readonly schemaVersion: 1;
	readonly binding: WorkerBinding;
	readonly sequence: number;
	readonly at: string;
}

/** Pure fold state. Transition receipts make idempotency restart-safe. */
export interface WorkerLifecycleState {
	readonly schemaVersion: 1;
	readonly binding: WorkerBinding;
	readonly record: WorkerRecord;
	readonly transitions: readonly WorkerTransitionReceipt[];
	readonly heartbeatSequence?: number;
}

export interface WorkerMutationResult {
	readonly state: WorkerLifecycleState;
	readonly record: WorkerRecord;
	readonly idempotent: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BINDING_KEYS = new Set([
	"schemaVersion",
	"workerId",
	"providerId",
	"sessionId",
	"laneId",
	"runId",
	"bindingId",
	"bindingEpochId",
	"attemptId",
	"profileId",
	"profileRevision",
	"capabilitySummary",
	"deadlineAt",
	"credentialTargetRefs",
	"requestFingerprint",
]);
const RECORD_KEYS = new Set([
	"schemaVersion",
	"workerId",
	"providerId",
	"sessionId",
	"laneId",
	"runId",
	"bindingId",
	"bindingEpochId",
	"attemptId",
	"profileId",
	"status",
	"revision",
	"createdAt",
	"readyAt",
	"endedAt",
	"lastHeartbeatAt",
	"activeOperationId",
	"receiptId",
]);
const TRANSITION_KEYS = new Set([
	"schemaVersion",
	"clientRequestId",
	"expectedRevision",
	"binding",
	"to",
	"at",
	"activeOperationId",
	"receiptId",
	"sideEffectState",
]);
const TRANSITION_RECEIPT_KEYS = new Set([
	"schemaVersion",
	"clientRequestId",
	"requestFingerprint",
	"from",
	"to",
	"previousRevision",
	"revision",
	"at",
	"operationId",
	"receiptId",
	"sideEffectState",
]);
const HEARTBEAT_KEYS = new Set(["schemaVersion", "binding", "sequence", "at"]);
const LIFECYCLE_STATE_KEYS = new Set([
	"schemaVersion",
	"binding",
	"record",
	"transitions",
	"heartbeatSequence",
]);

/** Process/provider material that may never enter a safe Worker contract. */
export const WORKER_FORBIDDEN_KEYS = Object.freeze([
	"pid",
	"executable",
	"argv",
	"cwd",
	"path",
	"workspace",
	"env",
	"environment",
	"stdout",
	"stderr",
	"prompt",
	"secret",
	"token",
	"header",
	"headers",
	"providerError",
	"providerException",
	"rawError",
	"rawFrame",
	"frame",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<WorkerLifecycleStatus, readonly WorkerLifecycleStatus[]>> = {
	new: ["starting"],
	starting: ["ready", "failed", "lost"],
	ready: ["running", "cancelling", "lost"],
	running: ["cancelling", "completed", "failed", "lost"],
	cancelling: ["cancelled", "failed", "lost"],
	completed: ["reclaiming"],
	failed: ["reclaiming"],
	cancelled: ["reclaiming"],
	lost: ["reclaiming"],
	reclaiming: ["reclaimed", "reclaim_unknown"],
	reclaimed: [],
	reclaim_unknown: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
	return value === undefined || isSafeIdentifier(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isIdentifierArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item) => isSafeIdentifier(item)) &&
		new Set(value).size === value.length
	);
}

function hasForbiddenWorkerField(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasForbiddenWorkerField(item, seen));
	for (const [key, item] of Object.entries(value)) {
		if (WORKER_FORBIDDEN_KEYS.includes(key)) return true;
		if (hasForbiddenWorkerField(item, seen)) return true;
	}
	return false;
}

function cloneBinding(value: WorkerBinding): WorkerBinding {
	return Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		workerId: value.workerId,
		providerId: value.providerId,
		sessionId: value.sessionId,
		laneId: value.laneId,
		...(value.runId === undefined ? {} : { runId: value.runId }),
		...(value.bindingId === undefined ? {} : { bindingId: value.bindingId }),
		...(value.bindingEpochId === undefined ? {} : { bindingEpochId: value.bindingEpochId }),
		...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
		profileId: value.profileId,
		profileRevision: value.profileRevision,
		capabilitySummary: Object.freeze([...value.capabilitySummary]),
		...(value.deadlineAt === undefined ? {} : { deadlineAt: value.deadlineAt }),
		credentialTargetRefs: Object.freeze([...value.credentialTargetRefs]),
		requestFingerprint: value.requestFingerprint,
	});
}

function cloneRecord(value: WorkerRecord): WorkerRecord {
	return Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		workerId: value.workerId,
		providerId: value.providerId,
		sessionId: value.sessionId,
		laneId: value.laneId,
		...(value.runId === undefined ? {} : { runId: value.runId }),
		...(value.bindingId === undefined ? {} : { bindingId: value.bindingId }),
		...(value.bindingEpochId === undefined ? {} : { bindingEpochId: value.bindingEpochId }),
		...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
		profileId: value.profileId,
		status: value.status,
		revision: value.revision,
		createdAt: value.createdAt,
		...(value.readyAt === undefined ? {} : { readyAt: value.readyAt }),
		...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
		...(value.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: value.lastHeartbeatAt }),
		...(value.activeOperationId === undefined ? {} : { activeOperationId: value.activeOperationId }),
		...(value.receiptId === undefined ? {} : { receiptId: value.receiptId }),
	});
}

export function isWorkerExecutionTerminalStatus(
	status: WorkerLifecycleStatus,
): status is WorkerExecutionTerminalStatus {
	return WORKER_EXECUTION_TERMINAL_STATUSES.includes(status as WorkerExecutionTerminalStatus);
}

export function isWorkerReclaimTerminalStatus(
	status: WorkerLifecycleStatus,
): status is WorkerReclaimTerminalStatus {
	return WORKER_RECLAIM_TERMINAL_STATUSES.includes(status as WorkerReclaimTerminalStatus);
}

export function workerTransitionAllowed(
	from: WorkerLifecycleStatus,
	to: WorkerLifecycleStatus,
): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export function validateWorkerBinding(value: unknown): value is WorkerBinding {
	if (!isRecord(value) || hasForbiddenWorkerField(value) || !hasOnlyKeys(value, BINDING_KEYS)) return false;
	return (
		value.schemaVersion === WORKER_SCHEMA_VERSION &&
		isSafeIdentifier(value.workerId) &&
		isSafeIdentifier(value.providerId) &&
		isSafeIdentifier(value.sessionId) &&
		isSafeIdentifier(value.laneId) &&
		isOptionalIdentifier(value.runId) &&
		isOptionalIdentifier(value.bindingId) &&
		isOptionalIdentifier(value.bindingEpochId) &&
		isOptionalIdentifier(value.attemptId) &&
		isSafeIdentifier(value.profileId) &&
		isPositiveInteger(value.profileRevision) &&
		isIdentifierArray(value.capabilitySummary) &&
		(value.deadlineAt === undefined || isPositiveInteger(value.deadlineAt)) &&
		isIdentifierArray(value.credentialTargetRefs) &&
		typeof value.requestFingerprint === "string" &&
		DIGEST_PATTERN.test(value.requestFingerprint)
	);
}

function recordStatusShape(value: Record<string, unknown>): boolean {
	const status = value.status as WorkerLifecycleStatus;
	const hasReady = value.readyAt !== undefined;
	const hasEnded = value.endedAt !== undefined;
	const hasOperation = value.activeOperationId !== undefined;
	const hasReceipt = value.receiptId !== undefined;
	switch (status) {
		case "new":
			return value.revision === 0 && !hasReady && !hasEnded && !hasOperation && !hasReceipt;
		case "starting":
			return isPositiveInteger(value.revision) && !hasReady && !hasEnded && !hasOperation && !hasReceipt;
		case "ready":
			return hasReady && !hasEnded && !hasOperation && !hasReceipt;
		case "running":
			return hasReady && !hasEnded && hasOperation && !hasReceipt;
		case "cancelling":
			return hasReady && !hasEnded && !hasReceipt;
		case "completed":
			return hasReady && hasEnded && !hasOperation && hasReceipt;
		case "failed":
			return hasEnded && !hasOperation;
		case "cancelled":
			return hasReady && hasEnded && !hasOperation && hasReceipt;
		case "lost":
			return hasEnded && !hasOperation && !hasReceipt;
		case "reclaiming":
		case "reclaimed":
		case "reclaim_unknown":
			return hasEnded && !hasOperation;
	}
}

export function validateWorkerRecord(value: unknown): value is WorkerRecord {
	if (!isRecord(value) || hasForbiddenWorkerField(value) || !hasOnlyKeys(value, RECORD_KEYS)) return false;
	if (
		value.schemaVersion !== WORKER_SCHEMA_VERSION ||
		!isSafeIdentifier(value.workerId) ||
		!isSafeIdentifier(value.providerId) ||
		!isSafeIdentifier(value.sessionId) ||
		!isSafeIdentifier(value.laneId) ||
		!isOptionalIdentifier(value.runId) ||
		!isOptionalIdentifier(value.bindingId) ||
		!isOptionalIdentifier(value.bindingEpochId) ||
		!isOptionalIdentifier(value.attemptId) ||
		!isSafeIdentifier(value.profileId) ||
		!WORKER_LIFECYCLE_STATUSES.includes(value.status as WorkerLifecycleStatus) ||
		!isNonNegativeInteger(value.revision) ||
		!isCanonicalTimestamp(value.createdAt) ||
		(value.readyAt !== undefined && !isCanonicalTimestamp(value.readyAt)) ||
		(value.endedAt !== undefined && !isCanonicalTimestamp(value.endedAt)) ||
		(value.lastHeartbeatAt !== undefined && !isCanonicalTimestamp(value.lastHeartbeatAt)) ||
		!isOptionalIdentifier(value.activeOperationId) ||
		!isOptionalIdentifier(value.receiptId)
	) {
		return false;
	}
	if (
		(value.readyAt !== undefined && value.readyAt < value.createdAt) ||
		(value.endedAt !== undefined && value.endedAt < (value.readyAt ?? value.createdAt)) ||
		(value.lastHeartbeatAt !== undefined && value.lastHeartbeatAt < value.createdAt) ||
		(value.lastHeartbeatAt !== undefined && value.endedAt !== undefined && value.lastHeartbeatAt > value.endedAt)
	) {
		return false;
	}
	return recordStatusShape(value);
}

function validateWorkerTransitionV1(value: unknown): value is WorkerTransition {
	if (!isRecord(value) || hasForbiddenWorkerField(value) || !hasOnlyKeys(value, TRANSITION_KEYS)) return false;
	return (
		value.schemaVersion === WORKER_SCHEMA_VERSION &&
		isSafeIdentifier(value.clientRequestId) &&
		isNonNegativeInteger(value.expectedRevision) &&
		validateWorkerBinding(value.binding) &&
		WORKER_LIFECYCLE_STATUSES.includes(value.to as WorkerLifecycleStatus) &&
		isCanonicalTimestamp(value.at) &&
		isOptionalIdentifier(value.activeOperationId) &&
		isOptionalIdentifier(value.receiptId) &&
		(value.sideEffectState === undefined ||
			value.sideEffectState === "none" ||
			value.sideEffectState === "unknown" ||
			value.sideEffectState === "side_effect_unknown")
	);
}

function sameBinding(left: WorkerBinding, right: WorkerBinding): boolean {
	return canonicalFoundationJson(cloneBinding(left)) === canonicalFoundationJson(cloneBinding(right));
}

function recordMatchesBinding(record: WorkerRecord, binding: WorkerBinding): boolean {
	return (
		record.workerId === binding.workerId &&
		record.providerId === binding.providerId &&
		record.sessionId === binding.sessionId &&
		record.laneId === binding.laneId &&
		record.runId === binding.runId &&
		record.bindingId === binding.bindingId &&
		record.bindingEpochId === binding.bindingEpochId &&
		record.attemptId === binding.attemptId &&
		record.profileId === binding.profileId
	);
}

function transitionFingerprint(input: WorkerTransition): string {
	const canonical = canonicalFoundationJson({
		schemaVersion: input.schemaVersion,
		expectedRevision: input.expectedRevision,
		binding: cloneBinding(input.binding),
		to: input.to,
		at: input.at,
		activeOperationId: input.activeOperationId ?? null,
		receiptId: input.receiptId ?? null,
		sideEffectState: input.sideEffectState ?? null,
	});
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function transitionPayloadIsValid(current: WorkerRecord, input: WorkerTransition): boolean {
	if (input.to === "running") {
		return input.activeOperationId !== undefined && input.receiptId === undefined && input.sideEffectState === undefined;
	}
	if (input.to === "cancelling") {
		const operationMatches = input.activeOperationId === current.activeOperationId;
		return operationMatches && input.receiptId === undefined && input.sideEffectState === undefined;
	}
	const terminalOperationMatches = input.activeOperationId === current.activeOperationId;
	if (input.to === "completed") {
		return terminalOperationMatches && input.receiptId !== undefined && input.sideEffectState === "none";
	}
	if (input.to === "cancelled") {
		return terminalOperationMatches && input.receiptId !== undefined && input.sideEffectState === "none";
	}
	if (input.to === "failed") {
		return terminalOperationMatches && input.sideEffectState !== undefined;
	}
	if (input.to === "lost") {
		return terminalOperationMatches && input.receiptId === undefined && input.sideEffectState === "side_effect_unknown";
	}
	return input.activeOperationId === undefined && input.receiptId === undefined && input.sideEffectState === undefined;
}

function nextRecord(current: WorkerRecord, input: WorkerTransition): WorkerRecord {
	const to = input.to;
	const next: WorkerRecord = {
		schemaVersion: WORKER_SCHEMA_VERSION,
		workerId: current.workerId,
		providerId: current.providerId,
		sessionId: current.sessionId,
		laneId: current.laneId,
		...(current.runId === undefined ? {} : { runId: current.runId }),
		...(current.bindingId === undefined ? {} : { bindingId: current.bindingId }),
		...(current.bindingEpochId === undefined ? {} : { bindingEpochId: current.bindingEpochId }),
		...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
		profileId: current.profileId,
		status: to,
		revision: current.revision + 1,
		createdAt: current.createdAt,
		...(current.readyAt === undefined && to !== "ready" ? {} : { readyAt: current.readyAt ?? input.at }),
		...(isWorkerExecutionTerminalStatus(to)
			? { endedAt: input.at }
			: current.endedAt === undefined
				? {}
				: { endedAt: current.endedAt }),
		...(current.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: current.lastHeartbeatAt }),
		...(to === "running"
			? { activeOperationId: input.activeOperationId! }
			: to === "cancelling" && (input.activeOperationId ?? current.activeOperationId) !== undefined
				? { activeOperationId: input.activeOperationId ?? current.activeOperationId }
				: {}),
		...(input.receiptId !== undefined
			? { receiptId: input.receiptId }
			: current.receiptId === undefined
				? {}
				: { receiptId: current.receiptId }),
	};
	return cloneRecord(next);
}

function initialRecord(binding: WorkerBinding, createdAt: string): WorkerRecord {
	return cloneRecord({
		schemaVersion: WORKER_SCHEMA_VERSION,
		workerId: binding.workerId,
		providerId: binding.providerId,
		sessionId: binding.sessionId,
		laneId: binding.laneId,
		...(binding.runId === undefined ? {} : { runId: binding.runId }),
		...(binding.bindingId === undefined ? {} : { bindingId: binding.bindingId }),
		...(binding.bindingEpochId === undefined ? {} : { bindingEpochId: binding.bindingEpochId }),
		...(binding.attemptId === undefined ? {} : { attemptId: binding.attemptId }),
		profileId: binding.profileId,
		status: "new",
		revision: 0,
		createdAt,
	});
}

function validateWorkerTransitionReceiptV1(value: unknown): value is WorkerTransitionReceipt {
	if (
		!isRecord(value) ||
		hasForbiddenWorkerField(value) ||
		!hasOnlyKeys(value, TRANSITION_RECEIPT_KEYS)
	) {
		return false;
	}
	return (
		value.schemaVersion === WORKER_SCHEMA_VERSION &&
		isSafeIdentifier(value.clientRequestId) &&
		typeof value.requestFingerprint === "string" &&
		DIGEST_PATTERN.test(value.requestFingerprint) &&
		WORKER_LIFECYCLE_STATUSES.includes(value.from as WorkerLifecycleStatus) &&
		WORKER_LIFECYCLE_STATUSES.includes(value.to as WorkerLifecycleStatus) &&
		isNonNegativeInteger(value.previousRevision) &&
		isPositiveInteger(value.revision) &&
		isCanonicalTimestamp(value.at) &&
		isOptionalIdentifier(value.operationId) &&
		isOptionalIdentifier(value.receiptId) &&
		(value.sideEffectState === undefined ||
			value.sideEffectState === "none" ||
			value.sideEffectState === "unknown" ||
			value.sideEffectState === "side_effect_unknown")
	);
}

export function validateWorkerHeartbeat(value: unknown): value is WorkerHeartbeat {
	if (!isRecord(value) || hasForbiddenWorkerField(value) || !hasOnlyKeys(value, HEARTBEAT_KEYS)) return false;
	return (
		value.schemaVersion === WORKER_SCHEMA_VERSION &&
		validateWorkerBinding(value.binding) &&
		isNonNegativeInteger(value.sequence) &&
		isCanonicalTimestamp(value.at)
	);
}

export function validateWorkerLifecycleState(value: unknown): value is WorkerLifecycleState {
	if (
		!isRecord(value) ||
		hasForbiddenWorkerField(value) ||
		!hasOnlyKeys(value, LIFECYCLE_STATE_KEYS) ||
		value.schemaVersion !== WORKER_SCHEMA_VERSION ||
		!validateWorkerBinding(value.binding) ||
		!validateWorkerRecord(value.record) ||
		!recordMatchesBinding(value.record, value.binding) ||
		!Array.isArray(value.transitions) ||
		(value.heartbeatSequence !== undefined && !isNonNegativeInteger(value.heartbeatSequence)) ||
		(value.heartbeatSequence === undefined) !== (value.record.lastHeartbeatAt === undefined)
	) {
		return false;
	}

	let folded = initialRecord(value.binding, value.record.createdAt);
	let previousTimestamp = value.record.createdAt;
	const requestFingerprints = new Map<string, string>();
	for (const item of value.transitions) {
		if (
			!validateWorkerTransitionReceiptV1(item) ||
			item.from !== folded.status ||
			item.previousRevision !== folded.revision ||
			item.revision !== folded.revision + 1 ||
			item.at < previousTimestamp ||
			!workerTransitionAllowed(item.from, item.to)
		) {
			return false;
		}
		const priorFingerprint = requestFingerprints.get(item.clientRequestId);
		if (priorFingerprint !== undefined) return false;
		const input: WorkerTransition = {
			schemaVersion: WORKER_SCHEMA_VERSION,
			clientRequestId: item.clientRequestId,
			expectedRevision: item.previousRevision,
			binding: value.binding,
			to: item.to,
			at: item.at,
			...(item.operationId === undefined ? {} : { activeOperationId: item.operationId }),
			...(item.receiptId === undefined ? {} : { receiptId: item.receiptId }),
			...(item.sideEffectState === undefined ? {} : { sideEffectState: item.sideEffectState }),
		};
		if (
			item.requestFingerprint !== transitionFingerprint(input) ||
			!transitionPayloadIsValid(folded, input)
		) {
			return false;
		}
		requestFingerprints.set(item.clientRequestId, item.requestFingerprint);
		folded = nextRecord(folded, input);
		previousTimestamp = item.at;
	}

	const expected = cloneRecord({
		...folded,
		...(value.record.lastHeartbeatAt === undefined
			? {}
			: { lastHeartbeatAt: value.record.lastHeartbeatAt }),
	});
	return canonicalFoundationJson(expected) === canonicalFoundationJson(cloneRecord(value.record));
}

export function createWorkerLifecycle(
	bindingValue: unknown,
	createdAt: string,
): ResultValue<WorkerLifecycleState, FoundationError> {
	if (!validateWorkerBinding(bindingValue) || !isCanonicalTimestamp(createdAt)) {
		return Result.err(new FoundationError("worker_invalid", "Worker binding or creation timestamp is invalid"));
	}
	const binding = cloneBinding(bindingValue);
	const record = initialRecord(binding, createdAt);
	return Result.ok(Object.freeze({ schemaVersion: WORKER_SCHEMA_VERSION, binding, record, transitions: Object.freeze([]) }));
}

export function applyWorkerTransition(
	state: WorkerLifecycleState,
	inputValue: unknown,
): ResultValue<WorkerMutationResult, FoundationError> {
	if (!validateWorkerLifecycleState(state)) {
		return Result.err(new FoundationError("worker_persistence_failed", "Worker lifecycle state is invalid"));
	}
	if (!validateWorkerTransitionV1(inputValue)) {
		return Result.err(new FoundationError("worker_invalid", "Worker transition is invalid"));
	}
	const input = inputValue;
	if (!sameBinding(state.binding, input.binding)) {
		return Result.err(new FoundationError("worker_binding_invalid", "Worker transition identity does not match its binding"));
	}
	const requestFingerprint = transitionFingerprint(input);
	const prior = state.transitions.find((item) => item.clientRequestId === input.clientRequestId);
	if (prior !== undefined) {
		if (prior.requestFingerprint !== requestFingerprint) {
			return Result.err(new FoundationError("worker_conflict", "Worker request key was reused with a different transition"));
		}
		return Result.ok({ state, record: state.record, idempotent: true });
	}
	if (input.expectedRevision !== state.record.revision) {
		return Result.err(new FoundationError("worker_conflict", "Worker transition revision is stale or has a gap"));
	}
	if (!workerTransitionAllowed(state.record.status, input.to)) {
		return Result.err(new FoundationError("worker_conflict", "Worker lifecycle transition is not allowed"));
	}
	const lastTransitionAt = state.transitions.at(-1)?.at ?? state.record.createdAt;
	const previousTimestamp =
		state.record.lastHeartbeatAt !== undefined && state.record.lastHeartbeatAt > lastTransitionAt
			? state.record.lastHeartbeatAt
			: lastTransitionAt;
	if (input.at < previousTimestamp || !transitionPayloadIsValid(state.record, input)) {
		return Result.err(new FoundationError("worker_operation_invalid", "Worker transition operation facts are invalid"));
	}
	const record = nextRecord(state.record, input);
	if (!validateWorkerRecord(record)) {
		return Result.err(new FoundationError("worker_persistence_failed", "Worker transition produced an invalid safe record"));
	}
	const transition: WorkerTransitionReceipt = Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		clientRequestId: input.clientRequestId,
		requestFingerprint,
		from: state.record.status,
		to: input.to,
		previousRevision: state.record.revision,
		revision: record.revision,
		at: input.at,
		...(input.activeOperationId === undefined ? {} : { operationId: input.activeOperationId }),
		...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
		...(input.sideEffectState === undefined ? {} : { sideEffectState: input.sideEffectState }),
	});
	const nextState: WorkerLifecycleState = Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		binding: state.binding,
		record,
		transitions: Object.freeze([...state.transitions, transition]),
		...(state.heartbeatSequence === undefined ? {} : { heartbeatSequence: state.heartbeatSequence }),
	});
	return Result.ok({ state: nextState, record, idempotent: false });
}

export function applyWorkerHeartbeat(
	state: WorkerLifecycleState,
	inputValue: unknown,
): ResultValue<WorkerMutationResult, FoundationError> {
	if (!validateWorkerLifecycleState(state)) {
		return Result.err(new FoundationError("worker_persistence_failed", "Worker lifecycle state is invalid"));
	}
	if (!validateWorkerHeartbeat(inputValue)) {
		return Result.err(new FoundationError("worker_invalid", "Worker heartbeat is invalid"));
	}
	const input = inputValue;
	if (!sameBinding(state.binding, input.binding)) {
		return Result.err(new FoundationError("worker_binding_invalid", "Worker heartbeat identity does not match its binding"));
	}
	if (
		state.record.status === "new" ||
		isWorkerExecutionTerminalStatus(state.record.status) ||
		state.record.status === "reclaiming" ||
		isWorkerReclaimTerminalStatus(state.record.status)
	) {
		return Result.err(new FoundationError("worker_conflict", "Worker heartbeat is not allowed in this lifecycle state"));
	}
	if (state.heartbeatSequence !== undefined && input.sequence === state.heartbeatSequence) {
		if (input.at !== state.record.lastHeartbeatAt) {
			return Result.err(new FoundationError("worker_conflict", "Worker heartbeat sequence was reused with a different timestamp"));
		}
		return Result.ok({ state, record: state.record, idempotent: true });
	}
	const lastTransitionAt = state.transitions.at(-1)?.at ?? state.record.createdAt;
	const previousTimestamp =
		state.record.lastHeartbeatAt !== undefined && state.record.lastHeartbeatAt > lastTransitionAt
			? state.record.lastHeartbeatAt
			: lastTransitionAt;
	if (
		(state.heartbeatSequence !== undefined && input.sequence < state.heartbeatSequence) ||
		input.at < previousTimestamp
	) {
		return Result.err(new FoundationError("worker_conflict", "Worker heartbeat is stale"));
	}
	const record = cloneRecord({ ...state.record, lastHeartbeatAt: input.at });
	const nextState: WorkerLifecycleState = Object.freeze({
		schemaVersion: WORKER_SCHEMA_VERSION,
		binding: state.binding,
		record,
		transitions: state.transitions,
		heartbeatSequence: input.sequence,
	});
	return Result.ok({ state: nextState, record, idempotent: false });
}

/** Serialize only the exact allowlisted safe Worker record. */
export function serializeWorkerRecord(value: unknown): string {
	if (!validateWorkerRecord(value)) {
		throw new FoundationError("worker_invalid", "Worker record is not safe to serialize");
	}
	return JSON.stringify(cloneRecord(value));
}

/** Parse an exact safe record; raw process/provider material is rejected. */
export function parseWorkerRecord(text: string): ResultValue<WorkerRecord, FoundationError> {
	try {
		const value = JSON.parse(text) as unknown;
		if (!validateWorkerRecord(value)) {
			return Result.err(new FoundationError("worker_invalid", "Serialized Worker record is invalid"));
		}
		return Result.ok(cloneRecord(value));
	} catch {
		return Result.err(new FoundationError("worker_invalid", "Serialized Worker record is not valid JSON"));
	}
}

/** Serialize the immutable safe binding for the private initialize handshake. */
export function serializeWorkerBinding(value: unknown): string {
	if (!validateWorkerBinding(value)) {
		throw new FoundationError("worker_binding_invalid", "Worker binding is not safe to serialize");
	}
	return JSON.stringify(cloneBinding(value));
}
