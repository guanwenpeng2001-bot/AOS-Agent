/**
 * Pure Host-side Child Agent lifecycle contracts.
 *
 * This module owns no process, provider, Session, Task, Attempt, settlement,
 * or Run authority. Supervisors may fold these safe records before appending
 * the corresponding typed durable events.
 */

import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	type Result as ResultValue,
} from "@aos-agent/agent-core";

export const SUBAGENT_SCHEMA_VERSION = 1 as const;

export const SUBAGENT_PROVIDER_KINDS = [
	"in_process",
	"fork",
	"agent_runtime_host",
] as const;
export type SubagentProviderKind = (typeof SUBAGENT_PROVIDER_KINDS)[number];

export const CHILD_CONTEXT_FORK_SCOPES = ["none", "all", "recent_n", "task_package"] as const;
export type ChildContextForkScope = (typeof CHILD_CONTEXT_FORK_SCOPES)[number];

export const CHILD_LIFECYCLE_STATUSES = [
	"spawning",
	"running",
	"awaiting_input",
	"background",
	"cancelling",
	"succeeded",
	"failed",
	"cancelled",
	"lost",
	"closed",
] as const;
export type ChildLifecycleStatus = (typeof CHILD_LIFECYCLE_STATUSES)[number];

export const CHILD_EXECUTION_TERMINAL_STATUSES = [
	"succeeded",
	"failed",
	"cancelled",
	"lost",
] as const;
export type ChildExecutionTerminalStatus = (typeof CHILD_EXECUTION_TERMINAL_STATUSES)[number];

/** Durable and public-safe Child Agent snapshot. */
export interface ChildAgentRecord {
	readonly schemaVersion: 1;
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly ancestorIds: readonly string[];
	readonly depth: number;
	readonly spawnId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochIds: readonly string[];
	readonly providerKind: SubagentProviderKind;
	readonly providerId: string;
	readonly forkScope: ChildContextForkScope;
	readonly status: ChildLifecycleStatus;
	readonly revision: number;
	readonly createdAt: string;
	readonly terminalAt?: string;
	readonly attemptReceiptId?: string;
	readonly taskResultId?: string;
}

export interface CreateChildAgentRecordInput {
	readonly schemaVersion: 1;
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly ancestorIds: readonly string[];
	readonly depth: number;
	readonly spawnId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochIds: readonly string[];
	readonly providerKind: SubagentProviderKind;
	readonly providerId: string;
	readonly forkScope: ChildContextForkScope;
	readonly createdAt: string;
}

/** Revision-checked mutation with an immutable identity echo. */
export interface ChildAgentTransition {
	readonly schemaVersion: 1;
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly spawnId: string;
	readonly expectedRevision: number;
	readonly to: ChildLifecycleStatus;
	readonly at: string;
	readonly attemptReceiptId?: string;
	readonly taskResultId?: string;
}

export interface ChildAgentTransitionResult {
	readonly record: ChildAgentRecord;
	readonly idempotent: boolean;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CREATE_KEYS = new Set([
	"schemaVersion",
	"childAgentInstanceId",
	"parentAgentInstanceId",
	"ancestorIds",
	"depth",
	"spawnId",
	"taskId",
	"dispatchId",
	"attemptId",
	"bindingId",
	"bindingEpochIds",
	"providerKind",
	"providerId",
	"forkScope",
	"createdAt",
]);
const RECORD_KEYS = new Set([
	...CREATE_KEYS,
	"status",
	"revision",
	"terminalAt",
	"attemptReceiptId",
	"taskResultId",
]);
const TRANSITION_KEYS = new Set([
	"schemaVersion",
	"childAgentInstanceId",
	"parentAgentInstanceId",
	"spawnId",
	"expectedRevision",
	"to",
	"at",
	"attemptReceiptId",
	"taskResultId",
]);

/** Provider/process material that may never enter a safe Child Agent record. */
export const SUBAGENT_FORBIDDEN_KEYS = Object.freeze([
	"pid",
	"executable",
	"argv",
	"command",
	"args",
	"cwd",
	"path",
	"workspace",
	"worktreePath",
	"env",
	"environment",
	"stdout",
	"stderr",
	"transcript",
	"prompt",
	"message",
	"body",
	"content",
	"secret",
	"token",
	"credential",
	"authorization",
	"cookie",
	"header",
	"headers",
	"providerError",
	"providerException",
	"providerStack",
	"rawError",
	"rawFrame",
	"frame",
	"handle",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<ChildLifecycleStatus, readonly ChildLifecycleStatus[]>> = {
	spawning: ["running", "failed", "lost"],
	running: ["awaiting_input", "background", "cancelling", "succeeded", "failed", "lost"],
	awaiting_input: ["background", "cancelling", "failed", "lost"],
	background: ["awaiting_input", "cancelling", "succeeded", "failed", "lost"],
	cancelling: ["failed", "cancelled", "lost"],
	succeeded: ["closed"],
	failed: ["closed"],
	cancelled: ["closed"],
	lost: ["closed"],
	closed: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasForbiddenSubagentField(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasForbiddenSubagentField(item, seen));
	for (const [key, item] of Object.entries(value)) {
		if (SUBAGENT_FORBIDDEN_KEYS.includes(key)) return true;
		if (hasForbiddenSubagentField(item, seen)) return true;
	}
	return false;
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

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isIdentifierArray(value: unknown, allowEmpty: boolean): value is readonly string[] {
	return (
		Array.isArray(value) &&
		(allowEmpty || value.length > 0) &&
		value.every((item) => isSafeIdentifier(item)) &&
		new Set(value).size === value.length
	);
}

function lineageIsValid(value: {
	readonly childAgentInstanceId: string;
	readonly parentAgentInstanceId: string;
	readonly ancestorIds: readonly string[];
	readonly depth: number;
}): boolean {
	return (
		value.depth === value.ancestorIds.length &&
		value.depth > 0 &&
		value.ancestorIds.at(-1) === value.parentAgentInstanceId &&
		!value.ancestorIds.includes(value.childAgentInstanceId)
	);
}

function recordStatusShape(value: Record<string, unknown>): boolean {
	const status = value.status as ChildLifecycleStatus;
	const terminal = isChildExecutionTerminalStatus(status) || status === "closed";
	if (terminal !== (value.terminalAt !== undefined)) return false;
	if ((status === "succeeded" || status === "cancelled") && value.attemptReceiptId === undefined) return false;
	if (status === "lost" && (value.attemptReceiptId !== undefined || value.taskResultId !== undefined)) return false;
	if (value.taskResultId !== undefined && value.attemptReceiptId === undefined) return false;
	if (!terminal && (value.attemptReceiptId !== undefined || value.taskResultId !== undefined)) return false;
	return status !== "spawning" || value.revision === 0;
}

function cloneChildAgentRecord(value: ChildAgentRecord): ChildAgentRecord {
	return Object.freeze({
		schemaVersion: SUBAGENT_SCHEMA_VERSION,
		childAgentInstanceId: value.childAgentInstanceId,
		parentAgentInstanceId: value.parentAgentInstanceId,
		ancestorIds: Object.freeze([...value.ancestorIds]),
		depth: value.depth,
		spawnId: value.spawnId,
		taskId: value.taskId,
		dispatchId: value.dispatchId,
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		bindingEpochIds: Object.freeze([...value.bindingEpochIds]),
		providerKind: value.providerKind,
		providerId: value.providerId,
		forkScope: value.forkScope,
		status: value.status,
		revision: value.revision,
		createdAt: value.createdAt,
		...(value.terminalAt === undefined ? {} : { terminalAt: value.terminalAt }),
		...(value.attemptReceiptId === undefined ? {} : { attemptReceiptId: value.attemptReceiptId }),
		...(value.taskResultId === undefined ? {} : { taskResultId: value.taskResultId }),
	});
}

export function isChildExecutionTerminalStatus(
	status: ChildLifecycleStatus,
): status is ChildExecutionTerminalStatus {
	return CHILD_EXECUTION_TERMINAL_STATUSES.includes(status as ChildExecutionTerminalStatus);
}

export function childLifecycleTransitionAllowed(
	from: ChildLifecycleStatus,
	to: ChildLifecycleStatus,
): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

export function validateCreateChildAgentRecordInput(
	value: unknown,
): value is CreateChildAgentRecordInput {
	if (!isRecord(value) || hasForbiddenSubagentField(value) || !hasOnlyKeys(value, CREATE_KEYS)) return false;
	if (
		value.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
		!isSafeIdentifier(value.childAgentInstanceId) ||
		!isSafeIdentifier(value.parentAgentInstanceId) ||
		!isIdentifierArray(value.ancestorIds, false) ||
		!isNonNegativeInteger(value.depth) ||
		!isSafeIdentifier(value.spawnId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeIdentifier(value.dispatchId) ||
		!isSafeIdentifier(value.attemptId) ||
		!isSafeIdentifier(value.bindingId) ||
		!isIdentifierArray(value.bindingEpochIds, false) ||
		!SUBAGENT_PROVIDER_KINDS.includes(value.providerKind as SubagentProviderKind) ||
		!isSafeIdentifier(value.providerId) ||
		!CHILD_CONTEXT_FORK_SCOPES.includes(value.forkScope as ChildContextForkScope) ||
		!isCanonicalTimestamp(value.createdAt)
	) {
		return false;
	}
	return lineageIsValid(value as unknown as CreateChildAgentRecordInput);
}

export function validateChildAgentRecord(value: unknown): value is ChildAgentRecord {
	if (!isRecord(value) || hasForbiddenSubagentField(value) || !hasOnlyKeys(value, RECORD_KEYS)) return false;
	const creation = {
		schemaVersion: value.schemaVersion,
		childAgentInstanceId: value.childAgentInstanceId,
		parentAgentInstanceId: value.parentAgentInstanceId,
		ancestorIds: value.ancestorIds,
		depth: value.depth,
		spawnId: value.spawnId,
		taskId: value.taskId,
		dispatchId: value.dispatchId,
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		bindingEpochIds: value.bindingEpochIds,
		providerKind: value.providerKind,
		providerId: value.providerId,
		forkScope: value.forkScope,
		createdAt: value.createdAt,
	};
	return (
		validateCreateChildAgentRecordInput(creation) &&
		CHILD_LIFECYCLE_STATUSES.includes(value.status as ChildLifecycleStatus) &&
		isNonNegativeInteger(value.revision) &&
		typeof value.createdAt === "string" &&
		(value.terminalAt === undefined || isCanonicalTimestamp(value.terminalAt)) &&
		(value.terminalAt === undefined || value.terminalAt >= value.createdAt) &&
		(value.attemptReceiptId === undefined || isSafeIdentifier(value.attemptReceiptId)) &&
		(value.taskResultId === undefined || isSafeIdentifier(value.taskResultId)) &&
		recordStatusShape(value)
	);
}

export function validateChildAgentTransition(value: unknown): value is ChildAgentTransition {
	return (
		isRecord(value) &&
		!hasForbiddenSubagentField(value) &&
		hasOnlyKeys(value, TRANSITION_KEYS) &&
		value.schemaVersion === SUBAGENT_SCHEMA_VERSION &&
		isSafeIdentifier(value.childAgentInstanceId) &&
		isSafeIdentifier(value.parentAgentInstanceId) &&
		isSafeIdentifier(value.spawnId) &&
		isNonNegativeInteger(value.expectedRevision) &&
		CHILD_LIFECYCLE_STATUSES.includes(value.to as ChildLifecycleStatus) &&
		isCanonicalTimestamp(value.at) &&
		(value.attemptReceiptId === undefined || isSafeIdentifier(value.attemptReceiptId)) &&
		(value.taskResultId === undefined || isSafeIdentifier(value.taskResultId)) &&
		(value.taskResultId === undefined || value.attemptReceiptId !== undefined) &&
		(value.to !== "succeeded" && value.to !== "cancelled" ? true : value.attemptReceiptId !== undefined) &&
		(value.to !== "lost" || (value.attemptReceiptId === undefined && value.taskResultId === undefined))
	);
}

export function createChildAgentRecord(
	inputValue: unknown,
): ResultValue<ChildAgentRecord, FoundationError> {
	if (!validateCreateChildAgentRecordInput(inputValue)) {
		return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent record input is invalid"));
	}
	return Result.ok(
		cloneChildAgentRecord({
			...inputValue,
			status: "spawning",
			revision: 0,
		}),
	);
}

export function transitionChildAgentRecord(
	currentValue: unknown,
	transitionValue: unknown,
): ResultValue<ChildAgentTransitionResult, FoundationError> {
	if (!validateChildAgentRecord(currentValue)) {
		return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent record is invalid"));
	}
	if (!validateChildAgentTransition(transitionValue)) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent transition is invalid"));
	}
	const current = currentValue;
	const transition = transitionValue;
	if (
		transition.childAgentInstanceId !== current.childAgentInstanceId ||
		transition.parentAgentInstanceId !== current.parentAgentInstanceId ||
		transition.spawnId !== current.spawnId
	) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent transition identity does not match"));
	}
	if (current.status === "closed" && transition.to === "closed") {
		if (
			transition.expectedRevision !== current.revision &&
			transition.expectedRevision !== current.revision - 1
		) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent close revision is stale or has a gap"));
		}
		if (
			(transition.attemptReceiptId !== undefined && transition.attemptReceiptId !== current.attemptReceiptId) ||
			(transition.taskResultId !== undefined && transition.taskResultId !== current.taskResultId)
		) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent close retry conflicts with recorded results"));
		}
		return Result.ok({ record: current, idempotent: true });
	}
	if (transition.expectedRevision !== current.revision) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent transition revision is stale or has a gap"));
	}
	if (!childLifecycleTransitionAllowed(current.status, transition.to)) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent lifecycle transition is not allowed"));
	}
	if (transition.at < (current.terminalAt ?? current.createdAt)) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent transition timestamp is stale"));
	}
	const enteringTerminal = isChildExecutionTerminalStatus(transition.to);
	const closing = transition.to === "closed";
	if (!enteringTerminal && !closing && (transition.attemptReceiptId !== undefined || transition.taskResultId !== undefined)) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent result references require a terminal transition"));
	}
	if (
		closing &&
		((transition.attemptReceiptId !== undefined && transition.attemptReceiptId !== current.attemptReceiptId) ||
			(transition.taskResultId !== undefined && transition.taskResultId !== current.taskResultId))
	) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent close cannot change recorded results"));
	}
	if (
		(current.attemptReceiptId !== undefined && transition.attemptReceiptId !== undefined && transition.attemptReceiptId !== current.attemptReceiptId) ||
		(current.taskResultId !== undefined && transition.taskResultId !== undefined && transition.taskResultId !== current.taskResultId)
	) {
		return Result.err(new FoundationError("subagent_conflict", "Child Agent result references are immutable"));
	}
	const record = cloneChildAgentRecord({
		...current,
		status: transition.to,
		revision: current.revision + 1,
		...(enteringTerminal ? { terminalAt: transition.at } : {}),
		...(transition.attemptReceiptId === undefined
			? current.attemptReceiptId === undefined
				? {}
				: { attemptReceiptId: current.attemptReceiptId }
			: { attemptReceiptId: transition.attemptReceiptId }),
		...(transition.taskResultId === undefined
			? current.taskResultId === undefined
				? {}
				: { taskResultId: current.taskResultId }
			: { taskResultId: transition.taskResultId }),
	});
	if (!validateChildAgentRecord(record)) {
		return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent transition produced an invalid safe record"));
	}
	return Result.ok({ record, idempotent: false });
}

/** Serialize only the exact allowlisted safe record in canonical key order. */
export function serializeChildAgentRecord(value: unknown): string {
	if (!validateChildAgentRecord(value)) {
		throw new FoundationError("subagent_spawn_invalid", "Child Agent record is not safe to serialize");
	}
	return canonicalFoundationJson(cloneChildAgentRecord(value));
}

/** Parse an exact safe record; process, provider, and transcript material is rejected. */
export function parseChildAgentRecord(
	text: string,
): ResultValue<ChildAgentRecord, FoundationError> {
	try {
		const value = JSON.parse(text) as unknown;
		if (!validateChildAgentRecord(value)) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Serialized Child Agent record is invalid"));
		}
		return Result.ok(cloneChildAgentRecord(value));
	} catch {
		return Result.err(new FoundationError("subagent_spawn_invalid", "Serialized Child Agent record is not valid JSON"));
	}
}
