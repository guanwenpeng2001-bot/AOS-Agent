/**
 * Task-level Human Gate v1 core.
 *
 * A Gate is a control-plane fact for "may this task stage proceed?" keyed by
 * `sessionId + taskId + stageId + stageRevision`. It is independent of Runs
 * and of operation-level Policy approvals: approving, rejecting, or
 * cancelling a Gate never starts, stops, or reclassifies a Run, and never
 * satisfies a Policy `ask`.
 *
 * Every Gate transition is appended as a Session custom entry
 * (`customType: "task.gate"`, `schemaVersion: 1`) containing the complete
 * safe Gate snapshot, the transition action, the `clientRequestId`, and the
 * previous revision. Custom entries never participate in Session context, so
 * Gate data never reaches the model. On restart the store folds the current
 * Session's `task.gate` entries in file order and rejects malformed,
 * unsupported, session-mismatched, revision-gapped, or illegal entries
 * without ever surfacing their raw data.
 */

import { randomUUID } from "node:crypto";

import type { SessionEntry } from "./session/manager.ts";

export const TASK_GATE_SCHEMA_VERSION = 1 as const;
export const TASK_GATE_CUSTOM_TYPE = "task.gate" as const;

export const TASK_GATE_STATUS = ["pending", "approved", "rejected", "cancelled"] as const;
export type TaskGateStatus = (typeof TASK_GATE_STATUS)[number];

export const TASK_GATE_ACTION = ["requested", "approved", "rejected", "cancelled"] as const;
export type TaskGateAction = (typeof TASK_GATE_ACTION)[number];

/** Automation Host write commands that map one-to-one onto Gate actions. */
export type TaskGateCommandType =
	| "task.gate.request"
	| "task.gate.approve"
	| "task.gate.reject"
	| "task.gate.cancel";

export const TASK_GATE_ERROR_CODES = [
	"task_gate_invalid",
	"task_gate_not_found",
	"task_gate_conflict",
	"task_gate_idempotency_conflict",
	"task_gate_not_pending",
	"task_gate_stage_revision_mismatch",
	"task_gate_persistence_failed",
] as const;
export type TaskGateErrorCode = (typeof TASK_GATE_ERROR_CODES)[number];

const TASK_GATE_ERROR_MESSAGES: Readonly<Record<TaskGateErrorCode, string>> = {
	task_gate_invalid: "Task gate input is invalid.",
	task_gate_not_found: "Task gate was not found in this session.",
	task_gate_conflict: "Task gate conflict: the business key already has a gate or the gate is already terminal.",
	task_gate_idempotency_conflict:
		"Task gate idempotency conflict: this request key was already used with a different payload.",
	task_gate_not_pending: "Task gate is not pending.",
	task_gate_stage_revision_mismatch: "Task gate stage revision does not match the current stage version.",
	task_gate_persistence_failed: "The task gate transition could not be persisted.",
};

export interface TaskGateErrorView {
	readonly code: TaskGateErrorCode;
	readonly message: string;
	readonly retryable: false;
}

/** Public safe Gate snapshot. `revision` is 0 while pending and 1 once terminal. */
export interface TaskGateRecord {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly gateId: string;
	readonly taskId: string;
	readonly stageId: string;
	readonly stageRevision: number;
	readonly status: TaskGateStatus;
	readonly revision: number;
	readonly requestedAt: string;
	readonly decidedAt?: string;
	readonly runId?: string;
	readonly actorId?: string;
	readonly reasonCode?: string;
}

/** Persisted transition: one full safe snapshot plus transition bookkeeping. */
export interface TaskGateTransition {
	readonly schemaVersion: 1;
	readonly action: TaskGateAction;
	readonly gate: TaskGateRecord;
	readonly previousRevision: number;
	readonly clientRequestId: string;
}

/** Input for `task.gate.request`. */
export interface TaskGateRequest {
	readonly taskId: string;
	readonly stageId: string;
	readonly stageRevision: number;
	readonly runId?: string;
	readonly clientRequestId: string;
}

/** Input for `task.gate.approve` / `task.gate.reject` / `task.gate.cancel`. */
export interface TaskGateDecisionRequest {
	readonly gateId: string;
	readonly actorId?: string;
	readonly reasonCode?: string;
	readonly clientRequestId: string;
}

export interface TaskGateListFilter {
	readonly taskId?: string;
	readonly stageId?: string;
	readonly status?: TaskGateStatus;
	readonly limit?: number;
}

export interface TaskGateMutationResult {
	readonly gate: TaskGateRecord;
	readonly appended: boolean;
	readonly idempotent: boolean;
	readonly entryId?: string;
}

export interface TaskGateListResult {
	readonly gates: ReadonlyArray<TaskGateRecord>;
	readonly truncated: boolean;
}

export type TaskGateWarningCode =
	| "malformed_source"
	| "unsupported_schema"
	| "session_mismatch"
	| "revision_gap"
	| "illegal_transition"
	| "idempotency_conflict"
	| "business_key_conflict";

export interface TaskGateWarning {
	readonly code: TaskGateWarningCode;
	/** Alias used by diagnostics consumers that classify warnings by kind. */
	readonly kind: TaskGateWarningCode;
	readonly entryId: string;
}

export interface TaskGateFoldResult {
	/** Current record per Gate, in append order of the first accepted transition. */
	readonly gates: ReadonlyArray<TaskGateRecord>;
	readonly byGateId: ReadonlyMap<string, TaskGateRecord>;
	readonly byBusinessKey: ReadonlyMap<string, TaskGateRecord>;
	/** Idempotency index: `commandType\0clientRequestId` maps to the winning record. */
	readonly byIdempotencyKey: ReadonlyMap<string, TaskGateRecord>;
	readonly warnings: ReadonlyArray<TaskGateWarning>;
}

/** Minimal Session surface used by the store; `SessionManager` satisfies it. */
export interface TaskGateSession {
	getSessionId(): string;
	getEntries(): ReadonlyArray<SessionEntry>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface TaskGateStoreOptions {
	/** Server timestamp source; must return a canonical UTC ISO timestamp. */
	readonly now?: () => string;
	/** Server Gate ID generator; must return a safe identifier. */
	readonly createGateId?: () => string;
	readonly diagnostics?: (warning: TaskGateWarning) => void;
	/**
	 * Read-only invalidation observer fired when a pending Gate becomes
	 * terminal by rejection or cancellation. It is a side channel of the Gate
	 * ledger: it never rewrites the terminal Gate record and it is not fired
	 * for approvals or for idempotent replays.
	 */
	readonly onGateInvalidated?: (gate: TaskGateRecord) => void;
}

export class TaskGateError extends Error {
	readonly code: TaskGateErrorCode;
	readonly retryable = false as const;

	constructor(code: TaskGateErrorCode) {
		// Errors cross RPC boundaries as Error.message. Keep that channel
		// code-derived so caller payloads, paths, commands, and credentials
		// cannot escape through a caller-supplied message.
		super(TASK_GATE_ERROR_MESSAGES[code]);
		this.name = "TaskGateError";
		this.code = code;
	}

	toJSON(): TaskGateErrorView {
		return { code: this.code, message: TASK_GATE_ERROR_MESSAGES[this.code], retryable: false };
	}
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRANSITION_KEYS = new Set(["schemaVersion", "action", "gate", "previousRevision", "clientRequestId"]);
const RECORD_KEYS = new Set([
	"schemaVersion",
	"sessionId",
	"gateId",
	"taskId",
	"stageId",
	"stageRevision",
	"status",
	"revision",
	"requestedAt",
	"decidedAt",
	"runId",
	"actorId",
	"reasonCode",
]);
const REQUEST_KEYS = new Set(["taskId", "stageId", "stageRevision", "runId", "clientRequestId"]);
const DECISION_KEYS = new Set(["gateId", "actorId", "reasonCode", "clientRequestId"]);
const LIST_KEYS = new Set(["taskId", "stageId", "status", "limit"]);

export const TASK_GATE_LIST_DEFAULT_LIMIT = 50;
export const TASK_GATE_LIST_MAX_LIMIT = 100;
export const TASK_GATE_CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const TASK_GATE_REASON_CODE_MAX_LENGTH = 64;

/**
 * Keys that must never appear in a gate request, decision, list filter, or
 * persisted snapshot. These are rejected before the state machine runs so
 * task text, tool payloads, paths, environment values, credentials, and
 * provider internals cannot become gate facts.
 */
export const TASK_GATE_FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
	"prompt",
	"message",
	"diff",
	"command",
	"args",
	"cwd",
	"path",
	"content",
	"stdout",
	"stderr",
	"env",
	"environment",
	"headers",
	"token",
	"authorization",
	"credentials",
	"providerError",
	"stack",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/** Safe opaque identifiers reject paths, URLs, userinfo, query text, and controls. */
export function isTaskGateIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

export function isCanonicalTaskGateTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
	return value === undefined || isTaskGateIdentifier(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeEntryId(value: unknown): string | undefined {
	return isTaskGateIdentifier(value) ? value : undefined;
}

function warningFor(entryId: string, code: TaskGateWarningCode): TaskGateWarning {
	return { code, kind: code, entryId: safeEntryId(entryId) ?? "unknown" };
}

/** Map a transition action onto its Automation Host command type. */
export function taskGateCommandType(action: TaskGateAction): TaskGateCommandType {
	switch (action) {
		case "requested":
			return "task.gate.request";
		case "approved":
			return "task.gate.approve";
		case "rejected":
			return "task.gate.reject";
		case "cancelled":
			return "task.gate.cancel";
	}
}

/** Map a Gate status onto the transition action that produced it. */
export function taskGateActionForStatus(status: TaskGateStatus): TaskGateAction {
	switch (status) {
		case "pending":
			return "requested";
		case "approved":
			return "approved";
		case "rejected":
			return "rejected";
		case "cancelled":
			return "cancelled";
	}
}

/**
 * The canonical idempotency payload of a write command. Only validated safe
 * fields participate; comparison is by exact string equality.
 */
export function canonicalTaskGatePayload(command: TaskGateCommandType, input: TaskGateRequest | TaskGateDecisionRequest): string {
	if (command === "task.gate.request") {
		const request = input as TaskGateRequest;
		return JSON.stringify({
			taskId: request.taskId,
			stageId: request.stageId,
			stageRevision: request.stageRevision,
			runId: request.runId ?? null,
		});
	}
	const decision = input as TaskGateDecisionRequest;
	return JSON.stringify({
		gateId: decision.gateId,
		actorId: decision.actorId ?? null,
		reasonCode: decision.reasonCode ?? null,
	});
}

/** Derive the canonical payload of a persisted transition from its snapshot. */
function canonicalTransitionPayload(action: TaskGateAction, gate: TaskGateRecord): string {
	if (action === "requested") {
		return JSON.stringify({
			taskId: gate.taskId,
			stageId: gate.stageId,
			stageRevision: gate.stageRevision,
			runId: gate.runId ?? null,
		});
	}
	return JSON.stringify({
		gateId: gate.gateId,
		actorId: gate.actorId ?? null,
		reasonCode: gate.reasonCode ?? null,
	});
}

/** Validate a Gate snapshot field-by-field, rejecting unknown or forbidden keys. */
export function isTaskGateRecord(value: unknown): value is TaskGateRecord {
	if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) return false;
	return (
		value.schemaVersion === TASK_GATE_SCHEMA_VERSION &&
		isTaskGateIdentifier(value.sessionId) &&
		isTaskGateIdentifier(value.gateId) &&
		isTaskGateIdentifier(value.taskId) &&
		isTaskGateIdentifier(value.stageId) &&
		isPositiveSafeInteger(value.stageRevision) &&
		TASK_GATE_STATUS.includes(value.status as TaskGateStatus) &&
		isNonNegativeSafeInteger(value.revision) &&
		isCanonicalTaskGateTimestamp(value.requestedAt) &&
		(value.decidedAt === undefined || isCanonicalTaskGateTimestamp(value.decidedAt)) &&
		isOptionalIdentifier(value.runId) &&
		isOptionalIdentifier(value.actorId) &&
		isOptionalIdentifier(value.reasonCode) &&
		(pendingRecordRules(value) || terminalRecordRules(value))
	);
}

function pendingRecordRules(value: Record<string, unknown>): boolean {
	return (
		value.status === "pending" &&
		value.revision === 0 &&
		value.decidedAt === undefined &&
		value.actorId === undefined &&
		value.reasonCode === undefined
	);
}

function terminalRecordRules(value: Record<string, unknown>): boolean {
	if (value.status === "pending" || value.revision !== 1 || value.decidedAt === undefined) return false;
	// reasonCode is a reject-only stable short code.
	return value.reasonCode === undefined || value.status === "rejected";
}

/** The transition action must correspond to the snapshot status. */
export function isTaskGateActionForStatus(action: TaskGateAction, status: TaskGateStatus): boolean {
	return taskGateActionForStatus(status) === action;
}

/** Validate a persisted transition payload without accepting raw data. */
export function isTaskGateTransition(value: unknown): value is TaskGateTransition {
	if (!isRecord(value) || !hasOnlyKeys(value, TRANSITION_KEYS)) return false;
	if (value.schemaVersion !== TASK_GATE_SCHEMA_VERSION) return false;
	if (!TASK_GATE_ACTION.includes(value.action as TaskGateAction)) return false;
	if (!isNonNegativeSafeInteger(value.previousRevision)) return false;
	if (!isTaskGateIdentifier(value.clientRequestId)) return false;
	if (!isTaskGateRecord(value.gate)) return false;
	return isTaskGateActionForStatus(value.action as TaskGateAction, value.gate.status);
}

/** Read the declared schema version of a custom entry payload, if any. */
export function taskGateSchemaVersion(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.schemaVersion !== "number") return undefined;
	return value.schemaVersion;
}

/** Parse only the exact schema-versioned transition payload. */
export function parseTaskGateTransition(value: unknown): TaskGateTransition | undefined {
	return isTaskGateTransition(value) ? cloneTransition(value) : undefined;
}

/** Defensive public copy of a Gate record. */
export function serializeTaskGateRecord(value: TaskGateRecord): TaskGateRecord {
	const record: TaskGateRecord = {
		schemaVersion: TASK_GATE_SCHEMA_VERSION,
		sessionId: value.sessionId,
		gateId: value.gateId,
		taskId: value.taskId,
		stageId: value.stageId,
		stageRevision: value.stageRevision,
		status: value.status,
		revision: value.revision,
		requestedAt: value.requestedAt,
	};
	if (value.decidedAt !== undefined) (record as { decidedAt?: string }).decidedAt = value.decidedAt;
	if (value.runId !== undefined) (record as { runId?: string }).runId = value.runId;
	if (value.actorId !== undefined) (record as { actorId?: string }).actorId = value.actorId;
	if (value.reasonCode !== undefined) (record as { reasonCode?: string }).reasonCode = value.reasonCode;
	return record;
}

function cloneTransition(value: TaskGateTransition): TaskGateTransition {
	return {
		schemaVersion: TASK_GATE_SCHEMA_VERSION,
		action: value.action,
		gate: serializeTaskGateRecord(value.gate),
		previousRevision: value.previousRevision,
		clientRequestId: value.clientRequestId,
	};
}

function businessKeyValue(sessionId: string, taskId: string, stageId: string, stageRevision: number): string {
	return `${sessionId}\u0000${taskId}\u0000${stageId}\u0000${stageRevision}`;
}

function businessKey(record: TaskGateRecord): string {
	return businessKeyValue(record.sessionId, record.taskId, record.stageId, record.stageRevision);
}

function idempotencyKey(action: TaskGateAction, clientRequestId: string): string {
	return `${taskGateCommandType(action)}\u0000${clientRequestId}`;
}

/** Two snapshots of the same Gate must agree on all immutable fields. */
function sameGateIdentity(left: TaskGateRecord, right: TaskGateRecord): boolean {
	return (
		left.gateId === right.gateId &&
		left.sessionId === right.sessionId &&
		left.taskId === right.taskId &&
		left.stageId === right.stageId &&
		left.stageRevision === right.stageRevision &&
		left.requestedAt === right.requestedAt &&
		left.runId === right.runId
	);
}

function customEntry(value: SessionEntry): value is Extract<SessionEntry, { type: "custom" }> {
	return value.type === "custom";
}

/**
 * Fold `task.gate` custom entries in append order into the current Gate map.
 * Entries that fail schema, identifier, session, revision, or transition
 * rules are skipped with a warning and never surface raw data. For duplicate
 * idempotency keys the first accepted transition wins; a later entry with the
 * same key but a different payload is dropped with a warning.
 */
export function foldTaskGateEntries(
	entries: ReadonlyArray<SessionEntry>,
	sessionId: string,
	diagnostics?: (warning: TaskGateWarning) => void,
): TaskGateFoldResult {
	const byGateId = new Map<string, TaskGateRecord>();
	const byBusinessKey = new Map<string, TaskGateRecord>();
	const byIdempotencyKey = new Map<string, TaskGateRecord>();
	const warnings: TaskGateWarning[] = [];
	const emit = (warning: TaskGateWarning): void => {
		warnings.push(warning);
		diagnostics?.(warning);
	};
	for (const entry of entries) {
		if (!customEntry(entry) || entry.customType !== TASK_GATE_CUSTOM_TYPE) continue;
		const schemaVersion = taskGateSchemaVersion(entry.data);
		if (schemaVersion === undefined || schemaVersion !== TASK_GATE_SCHEMA_VERSION) {
			emit(warningFor(entry.id, schemaVersion === undefined ? "malformed_source" : "unsupported_schema"));
			continue;
		}
		const transition = parseTaskGateTransition(entry.data);
		if (transition === undefined) {
			emit(warningFor(entry.id, "malformed_source"));
			continue;
		}
		const { action, gate, previousRevision, clientRequestId } = transition;
		if (gate.sessionId !== sessionId) {
			emit(warningFor(entry.id, "session_mismatch"));
			continue;
		}
		const key = idempotencyKey(action, clientRequestId);
		const existingIdempotent = byIdempotencyKey.get(key);
		if (existingIdempotent !== undefined) {
			const existingAction = taskGateActionForStatus(existingIdempotent.status);
			if (canonicalTransitionPayload(existingAction, existingIdempotent) !== canonicalTransitionPayload(action, gate)) {
				emit(warningFor(entry.id, "idempotency_conflict"));
			}
			continue;
		}
		const current = byGateId.get(gate.gateId);
		if (action === "requested") {
			if (current !== undefined) {
				emit(warningFor(entry.id, "illegal_transition"));
				continue;
			}
			if (previousRevision !== 0 || gate.revision !== 0 || gate.status !== "pending") {
				emit(warningFor(entry.id, "revision_gap"));
				continue;
			}
			const keyValue = businessKey(gate);
			const existingBusiness = byBusinessKey.get(keyValue);
			if (existingBusiness !== undefined && existingBusiness.gateId !== gate.gateId) {
				emit(warningFor(entry.id, "business_key_conflict"));
				continue;
			}
			byGateId.set(gate.gateId, serializeTaskGateRecord(gate));
			byBusinessKey.set(keyValue, serializeTaskGateRecord(gate));
			byIdempotencyKey.set(key, serializeTaskGateRecord(gate));
			continue;
		}
		if (current === undefined || current.status !== "pending") {
			emit(warningFor(entry.id, current === undefined ? "revision_gap" : "illegal_transition"));
			continue;
		}
		if (previousRevision !== current.revision || gate.revision !== current.revision + 1) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		if (!sameGateIdentity(current, gate)) {
			emit(warningFor(entry.id, "illegal_transition"));
			continue;
		}
		byGateId.set(gate.gateId, serializeTaskGateRecord(gate));
		byIdempotencyKey.set(key, serializeTaskGateRecord(gate));
	}
	return { gates: [...byGateId.values()], byGateId, byBusinessKey, byIdempotencyKey, warnings };
}

function assertNoForbiddenPayloadKeys(input: Record<string, unknown>): void {
	const forbidden = new Set(TASK_GATE_FORBIDDEN_PAYLOAD_KEYS);
	for (const key of Object.keys(input)) {
		if (forbidden.has(key.toLowerCase())) {
			throw new TaskGateError("task_gate_invalid");
		}
	}
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
	return isTaskGateIdentifier(value) && value.length <= maxLength;
}

function validateRequest(input: TaskGateRequest): void {
	if (!isRecord(input) || !hasOnlyKeys(input, REQUEST_KEYS)) {
		throw new TaskGateError("task_gate_invalid");
	}
	assertNoForbiddenPayloadKeys(input);
	if (
		!isTaskGateIdentifier(input.taskId) ||
		!isTaskGateIdentifier(input.stageId) ||
		!isPositiveSafeInteger(input.stageRevision) ||
		!isOptionalIdentifier(input.runId) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_GATE_CLIENT_REQUEST_ID_MAX_LENGTH)
	) {
		throw new TaskGateError("task_gate_invalid");
	}
}

function validateDecision(command: TaskGateCommandType, input: TaskGateDecisionRequest): void {
	if (!isRecord(input) || !hasOnlyKeys(input, DECISION_KEYS)) {
		throw new TaskGateError("task_gate_invalid");
	}
	assertNoForbiddenPayloadKeys(input);
	if (
		!isTaskGateIdentifier(input.gateId) ||
		!isOptionalIdentifier(input.actorId) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_GATE_CLIENT_REQUEST_ID_MAX_LENGTH)
	) {
		throw new TaskGateError("task_gate_invalid");
	}
	if (command !== "task.gate.reject" && input.reasonCode !== undefined) {
		throw new TaskGateError("task_gate_invalid");
	}
	if (
		input.reasonCode !== undefined &&
		!isBoundedIdentifier(input.reasonCode, TASK_GATE_REASON_CODE_MAX_LENGTH)
	) {
		throw new TaskGateError("task_gate_invalid");
	}
}

function validateListFilter(filter: TaskGateListFilter): void {
	const raw: unknown = filter;
	if (!isRecord(raw) || !hasOnlyKeys(raw, LIST_KEYS)) {
		throw new TaskGateError("task_gate_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (filter.taskId !== undefined && !isTaskGateIdentifier(filter.taskId)) {
		throw new TaskGateError("task_gate_invalid");
	}
	if (filter.stageId !== undefined && !isTaskGateIdentifier(filter.stageId)) {
		throw new TaskGateError("task_gate_invalid");
	}
	if (filter.status !== undefined && !TASK_GATE_STATUS.includes(filter.status)) {
		throw new TaskGateError("task_gate_invalid");
	}
	if (
		filter.limit !== undefined &&
		(!Number.isSafeInteger(filter.limit) || filter.limit <= 0 || filter.limit > TASK_GATE_LIST_MAX_LIMIT)
	) {
		throw new TaskGateError("task_gate_invalid");
	}
}

/**
 * Session-scoped Task Gate store. A new instance folds the current Session's
 * `task.gate` entries, which makes lookups, uniqueness, and idempotency
 * restart-safe. All writes go through the injected Session single-writer;
 * a write is acknowledged only after the appended transition folds back.
 */
export class TaskGateStore {
	private readonly session: TaskGateSession;
	private readonly sessionId: string;
	private readonly nowFn: () => string;
	private readonly createIdFn: () => string;
	private readonly diagnosticsSink: ((warning: TaskGateWarning) => void) | undefined;
	private readonly invalidationSink: ((gate: TaskGateRecord) => void) | undefined;
	private diagnosedEntryIds = new Set<string>();
	private fold: TaskGateFoldResult = {
		gates: [],
		byGateId: new Map(),
		byBusinessKey: new Map(),
		byIdempotencyKey: new Map(),
		warnings: [],
	};

	constructor(session: TaskGateSession, options: TaskGateStoreOptions = {}) {
		this.session = session;
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.createIdFn = options.createGateId ?? (() => `gate_${randomUUID()}`);
		this.diagnosticsSink = options.diagnostics;
		this.invalidationSink = options.onGateInvalidated;
		this.sessionId = session.getSessionId();
		this.refresh();
	}

	private nextGateId(): string {
		for (let attempt = 0; attempt < 5; attempt++) {
			const gateId = this.createIdFn();
			if (isTaskGateIdentifier(gateId) && !this.fold.byGateId.has(gateId)) {
				return gateId;
			}
		}
		throw new TaskGateError("task_gate_persistence_failed");
	}

	private nextTimestamp(): string {
		let timestamp: string;
		try {
			timestamp = this.nowFn();
		} catch {
			throw new TaskGateError("task_gate_persistence_failed");
		}
		if (!isCanonicalTaskGateTimestamp(timestamp)) {
			throw new TaskGateError("task_gate_persistence_failed");
		}
		return timestamp;
	}

	/** Re-read append-only entries and return the current diagnostics snapshot. */
	refresh(): ReadonlyArray<TaskGateWarning> {
		let entries: ReadonlyArray<SessionEntry>;
		try {
			entries = this.session.getEntries();
		} catch {
			throw new TaskGateError("task_gate_persistence_failed");
		}
		const warnings: TaskGateWarning[] = [];
		this.fold = foldTaskGateEntries(entries, this.sessionId, (warning) => {
			warnings.push(warning);
			if (!this.diagnosedEntryIds.has(warning.entryId)) {
				this.diagnosedEntryIds.add(warning.entryId);
				this.diagnosticsSink?.(warning);
			}
		});
		return warnings;
	}

	warnings(): readonly TaskGateWarning[] {
		return this.fold.warnings;
	}

	getWarnings(): readonly TaskGateWarning[] {
		return this.warnings();
	}

	/** Create a pending Gate for a task stage, or replay a prior identical request. */
	request(input: TaskGateRequest): TaskGateMutationResult {
		validateRequest(input);
		this.refresh();
		const key = idempotencyKey("requested", input.clientRequestId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (canonicalTransitionPayload("requested", existing) !== canonicalTaskGatePayload("task.gate.request", input)) {
				throw new TaskGateError("task_gate_idempotency_conflict");
			}
			return { gate: serializeTaskGateRecord(existing), appended: false, idempotent: true };
		}
		const keyValue = businessKeyValue(this.sessionId, input.taskId, input.stageId, input.stageRevision);
		if (this.fold.byBusinessKey.has(keyValue)) {
			throw new TaskGateError("task_gate_conflict");
		}
		const gate: TaskGateRecord = {
			schemaVersion: TASK_GATE_SCHEMA_VERSION,
			sessionId: this.sessionId,
			gateId: this.nextGateId(),
			taskId: input.taskId,
			stageId: input.stageId,
			stageRevision: input.stageRevision,
			status: "pending",
			revision: 0,
			requestedAt: this.nextTimestamp(),
		};
		if (input.runId !== undefined) (gate as { runId?: string }).runId = input.runId;
		// Re-fold immediately before append so a concurrent writer cannot sneak
		// a second pending gate or a conflicting idempotency payload past the
		// check that ran at command start.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (
				canonicalTransitionPayload("requested", freshExisting) !==
				canonicalTaskGatePayload("task.gate.request", input)
			) {
				throw new TaskGateError("task_gate_idempotency_conflict");
			}
			return { gate: serializeTaskGateRecord(freshExisting), appended: false, idempotent: true };
		}
		if (this.fold.byBusinessKey.has(keyValue) || this.fold.byGateId.has(gate.gateId)) {
			throw new TaskGateError("task_gate_conflict");
		}
		return this.appendTransition({ schemaVersion: 1, action: "requested", gate, previousRevision: 0, clientRequestId: input.clientRequestId });
	}

	/** Approve a pending Gate. */
	approve(input: TaskGateDecisionRequest): TaskGateMutationResult {
		return this.decide("task.gate.approve", "approved", input);
	}

	/** Reject a pending Gate. */
	reject(input: TaskGateDecisionRequest): TaskGateMutationResult {
		return this.decide("task.gate.reject", "rejected", input);
	}

	/** Cancel a pending Gate. */
	cancel(input: TaskGateDecisionRequest): TaskGateMutationResult {
		return this.decide("task.gate.cancel", "cancelled", input);
	}

	private decide(command: TaskGateCommandType, action: Exclude<TaskGateAction, "requested">, input: TaskGateDecisionRequest): TaskGateMutationResult {
		validateDecision(command, input);
		this.refresh();
		const key = idempotencyKey(action, input.clientRequestId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (canonicalTransitionPayload(action, existing) !== canonicalTaskGatePayload(command, input)) {
				throw new TaskGateError("task_gate_idempotency_conflict");
			}
			return { gate: serializeTaskGateRecord(existing), appended: false, idempotent: true };
		}
		const current = this.fold.byGateId.get(input.gateId);
		if (current === undefined) {
			throw new TaskGateError("task_gate_not_found");
		}
		if (current.status !== "pending") {
			if (current.status === action) {
				throw new TaskGateError("task_gate_not_pending");
			}
			throw new TaskGateError("task_gate_conflict");
		}
		const gate: TaskGateRecord = serializeTaskGateRecord(current);
		(gate as { status: TaskGateStatus }).status = action;
		(gate as { revision: number }).revision = current.revision + 1;
		(gate as { decidedAt?: string }).decidedAt = this.nextTimestamp();
		if (input.actorId !== undefined) (gate as { actorId?: string }).actorId = input.actorId;
		if (input.reasonCode !== undefined) (gate as { reasonCode?: string }).reasonCode = input.reasonCode;
		// Re-fold immediately before append so the first terminal writer wins
		// even if another decision landed after the command-start snapshot.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (canonicalTransitionPayload(action, freshExisting) !== canonicalTaskGatePayload(command, input)) {
				throw new TaskGateError("task_gate_idempotency_conflict");
			}
			return { gate: serializeTaskGateRecord(freshExisting), appended: false, idempotent: true };
		}
		const freshCurrent = this.fold.byGateId.get(input.gateId);
		if (freshCurrent === undefined) {
			throw new TaskGateError("task_gate_not_found");
		}
		if (freshCurrent.status !== "pending") {
			if (freshCurrent.status === action) {
				throw new TaskGateError("task_gate_not_pending");
			}
			throw new TaskGateError("task_gate_conflict");
		}
		if (!sameGateIdentity(freshCurrent, current) || freshCurrent.revision !== current.revision) {
			throw new TaskGateError("task_gate_conflict");
		}
		const result = this.appendTransition({
			schemaVersion: 1,
			action,
			gate,
			previousRevision: current.revision,
			clientRequestId: input.clientRequestId,
		});
		// Rejection and cancellation invalidate the task stage: the observer
		// (Task Credential service) revokes/settles the stage's credential
		// grants. Approval is not an invalidation and the appended record is
		// never rewritten here — this is a side channel only.
		if ((action === "rejected" || action === "cancelled") && this.invalidationSink !== undefined) {
			this.invalidationSink(serializeTaskGateRecord(result.gate));
		}
		return result;
	}

	private appendTransition(transition: TaskGateTransition): TaskGateMutationResult {
		if (!isTaskGateTransition(transition)) {
			throw new TaskGateError("task_gate_persistence_failed");
		}
		let entryId: string;
		try {
			entryId = this.session.appendCustomEntry(TASK_GATE_CUSTOM_TYPE, cloneTransition(transition));
		} catch (error) {
			if (error instanceof TaskGateError) throw error;
			throw new TaskGateError("task_gate_persistence_failed");
		}
		this.refresh();
		const folded = this.fold.byGateId.get(transition.gate.gateId);
		if (folded === undefined || folded.status !== transition.gate.status || folded.revision !== transition.gate.revision) {
			throw new TaskGateError("task_gate_persistence_failed");
		}
		return {
			gate: serializeTaskGateRecord(folded),
			appended: true,
			idempotent: false,
			...(safeEntryId(entryId) === undefined ? {} : { entryId: safeEntryId(entryId) }),
		};
	}

	/** Read one Gate in the current Session. Read-only; never appends. */
	get(gateId: string): TaskGateRecord | undefined {
		if (!isTaskGateIdentifier(gateId)) {
			throw new TaskGateError("task_gate_invalid");
		}
		this.refresh();
		const record = this.fold.byGateId.get(gateId);
		return record === undefined ? undefined : serializeTaskGateRecord(record);
	}

	/**
	 * Read the current Gate of this Session by business key
	 * (`taskId + stageId + stageRevision`). Read-only; never appends. The fold's
	 * business-key projection resolves the Gate and the gate map returns its
	 * current snapshot, so a terminal decision is visible here.
	 */
	getByBusinessKey(taskId: string, stageId: string, stageRevision: number): TaskGateRecord | undefined {
		if (!isTaskGateIdentifier(taskId) || !isTaskGateIdentifier(stageId) || !isPositiveSafeInteger(stageRevision)) {
			throw new TaskGateError("task_gate_invalid");
		}
		this.refresh();
		const resolved = this.fold.byBusinessKey.get(businessKeyValue(this.sessionId, taskId, stageId, stageRevision));
		if (resolved === undefined) return undefined;
		const current = this.fold.byGateId.get(resolved.gateId);
		return current === undefined ? undefined : serializeTaskGateRecord(current);
	}

	/** List Gates of the current Session with optional filters. Read-only; never appends. */
	list(filter: TaskGateListFilter = {}): TaskGateListResult {
		validateListFilter(filter);
		this.refresh();
		const limit = filter.limit ?? TASK_GATE_LIST_DEFAULT_LIMIT;
		const gates: TaskGateRecord[] = [];
		for (const record of this.fold.gates) {
			if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue;
			if (filter.stageId !== undefined && record.stageId !== filter.stageId) continue;
			if (filter.status !== undefined && record.status !== filter.status) continue;
			if (gates.length >= limit) {
				return { gates, truncated: true };
			}
			gates.push(serializeTaskGateRecord(record));
		}
		return { gates, truncated: false };
	}
}

export function createTaskGateStore(session: TaskGateSession, options?: TaskGateStoreOptions): TaskGateStore {
	return new TaskGateStore(session, options);
}
