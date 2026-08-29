/**
 * Task Graph v1 core.
 *
 * A Graph is a control-plane state machine that records orchestration facts
 * only: which nodes exist, what each node depends on, whether a node's stage
 * Gate has been satisfied, and which accepted Run executes each node. It is
 * not a second Run ledger, not an execution engine, and not a scheduler:
 * nodes are executed through the existing `run.start` / `run.resume` flow,
 * and the Graph only observes and associates those Runs.
 *
 * A Graph is identified by the business key `sessionId + taskId +
 * graphRevision`. `create` submits the complete node set once and appends one
 * immutable definition entry (`customType: "task.graph"`, `schemaVersion: 1`)
 * with all pending node snapshots. `node.attach` links a pending, ready node
 * to an accepted or running Run of the current Session; `node.settle` folds
 * the attached Run's terminal receipt into the node (completed -> succeeded,
 * failed -> failed, cancelled -> cancelled). Node availability (`ready` /
 * `waiting_dependencies` / `waiting_gate` / `blocked`), `blockingNodeIds`,
 * the per-node `gateStatus`, and the aggregate summary are derived at read
 * time from the persisted node status, the dependency statuses, and the
 * injected read-only Task Gate lookup; they are never persisted.
 *
 * Every write command requires a `clientRequestId`. The idempotency key is
 * `sessionId + commandType + clientRequestId`; retrying the same command with
 * the same key and canonical payload replays the previous result without
 * appending a second transition, and the same key with a different payload is
 * a conflict. Node arrays are canonicalized by sorted `nodeId` before the
 * create fingerprint so reordered input does not create a false conflict.
 *
 * Task Graph custom entries never participate in Session context, so Graph
 * data never reaches the model. On restart the store folds the current
 * Session's `task.graph` entries in file order and rejects malformed,
 * unsupported, session-mismatched, revision-gapped, illegal, idempotency-
 * conflicting, business-key-conflicting, and second-run-association entries
 * with safe warnings, never surfacing raw data.
 */

import type { RunStatus, RunTerminalStatus } from "../session/run-lifecycle.ts";
import type { SessionEntry } from "../session/manager.ts";
import type { TaskGateRecord, TaskGateStatus } from "../task-gate.ts";

export const TASK_GRAPH_SCHEMA_VERSION = 1 as const;
export const TASK_GRAPH_CUSTOM_TYPE = "task.graph" as const;

export const TASK_GRAPH_NODE_STATUS = [
	"pending",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type TaskGraphNodeStatus = (typeof TASK_GRAPH_NODE_STATUS)[number];

export const TASK_GRAPH_NODE_AVAILABILITY = [
	"ready",
	"waiting_dependencies",
	"waiting_gate",
	"blocked",
] as const;
export type TaskGraphNodeAvailability = (typeof TASK_GRAPH_NODE_AVAILABILITY)[number];

export const TASK_GRAPH_STATUS = ["active", "succeeded", "failed", "cancelled"] as const;
export type TaskGraphStatus = (typeof TASK_GRAPH_STATUS)[number];

export const TASK_GRAPH_ACTION = [
	"created",
	"node.attached",
	"node.succeeded",
	"node.failed",
	"node.cancelled",
] as const;
export type TaskGraphAction = (typeof TASK_GRAPH_ACTION)[number];

/** Automation Host write commands that map one-to-one onto Graph actions. */
export type TaskGraphCommandType =
	| "task.graph.create"
	| "task.graph.get"
	| "task.graph.list"
	| "task.graph.node.attach"
	| "task.graph.node.settle";

export const TASK_GRAPH_COMMAND_TYPE = [
	"task.graph.create",
	"task.graph.get",
	"task.graph.list",
	"task.graph.node.attach",
	"task.graph.node.settle",
] as const;

export const TASK_GRAPH_ERROR_CODES = [
	"task_graph_invalid",
	"task_graph_dependency_cycle",
	"task_graph_not_found",
	"task_graph_conflict",
	"task_graph_idempotency_conflict",
	"task_graph_node_not_found",
	"task_graph_node_not_eligible",
	"task_graph_node_conflict",
	"task_graph_run_not_found",
	"task_graph_run_not_terminal",
	"task_graph_run_state_mismatch",
	"task_graph_persistence_failed",
] as const;
export type TaskGraphErrorCode = (typeof TASK_GRAPH_ERROR_CODES)[number];

const TASK_GRAPH_ERROR_MESSAGES: Readonly<Record<TaskGraphErrorCode, string>> = {
	task_graph_invalid: "Task graph input is invalid.",
	task_graph_dependency_cycle: "Task graph contains a dependency cycle.",
	task_graph_not_found: "Task graph was not found in this session.",
	task_graph_conflict: "Task graph conflict: the business key already has a different graph.",
	task_graph_idempotency_conflict:
		"Task graph idempotency conflict: this request key was already used with a different payload.",
	task_graph_node_not_found: "Task graph node was not found in this graph.",
	task_graph_node_not_eligible: "Task graph node is not pending and ready.",
	task_graph_node_conflict:
		"Task graph node conflict: the node already has a run association, is terminal, or has a revision conflict.",
	task_graph_run_not_found: "Task graph run was not found in this session.",
	task_graph_run_not_terminal: "Task graph run is not terminal yet.",
	task_graph_run_state_mismatch: "Task graph run record and receipt facts are inconsistent.",
	task_graph_persistence_failed: "The task graph transition could not be persisted.",
};

export interface TaskGraphErrorView {
	readonly code: TaskGraphErrorCode;
	readonly message: string;
	readonly retryable: false;
}

export interface TaskGraphGateRef {
	readonly stageId: string;
	readonly stageRevision: number;
}

/** Safe run association; never copies Binding, Receipt, or prompt content. */
export interface TaskGraphRunRef {
	readonly sessionId: string;
	readonly runId: string;
}

/** One node of an immutable Graph definition. */
export interface TaskGraphNodeDefinition {
	readonly nodeId: string;
	readonly dependsOn: ReadonlyArray<string>;
	readonly gateRef?: TaskGraphGateRef;
}

/** Input for `task.graph.create`. */
export interface TaskGraphCreateRequest {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodes: ReadonlyArray<TaskGraphNodeDefinition>;
	readonly clientRequestId: string;
}

/** Input for `task.graph.node.attach`. */
export interface TaskGraphNodeAttachRequest {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly runId: string;
	readonly clientRequestId: string;
}

/** Input for `task.graph.node.settle`. */
export interface TaskGraphNodeSettleRequest {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly clientRequestId: string;
}

export interface TaskGraphListFilter {
	readonly taskId?: string;
	readonly graphRevision?: number;
	readonly status?: TaskGraphStatus;
	readonly limit?: number;
}

/**
 * Persisted node snapshot. `nodeRevision` is the monotonic transition
 * version: 0 pending, 1 running, 2 terminal. v1 never reopens, retries, or
 * rewrites a terminal node. `outcomeCode` is a reserved stable short code.
 */
export interface TaskGraphNodeRecord {
	readonly schemaVersion: 1;
	readonly nodeId: string;
	readonly dependsOn: ReadonlyArray<string>;
	readonly status: TaskGraphNodeStatus;
	readonly nodeRevision: number;
	readonly gateRef?: TaskGraphGateRef;
	readonly runRef?: TaskGraphRunRef;
	readonly outcomeCode?: string;
}

/** Immutable Graph definition persisted by the `created` transition. */
export interface TaskGraphDefinitionRecord {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly createdAt: string;
	readonly nodes: ReadonlyArray<TaskGraphNodeRecord>;
}

/**
 * Public node view: the persisted record plus read-time derived fields.
 * `availability` and `blockingNodeIds` are never persisted or written back;
 * `gateStatus` is present only for a pending node with a `gateRef`.
 */
export interface TaskGraphNodeView extends TaskGraphNodeRecord {
	readonly availability: TaskGraphNodeAvailability | null;
	readonly blockingNodeIds: ReadonlyArray<string>;
	readonly gateStatus?: TaskGateStatus | "missing";
}

export interface TaskGraphSummary {
	readonly status: TaskGraphStatus;
	readonly pending: number;
	readonly running: number;
	readonly succeeded: number;
	readonly failed: number;
	readonly cancelled: number;
}

/** Public safe Graph view returned by create / get / list / mutations. */
export interface TaskGraphRecord {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly createdAt: string;
	readonly nodes: ReadonlyArray<TaskGraphNodeView>;
	readonly summary: TaskGraphSummary;
}

/**
 * Persisted transition. `created` carries the complete immutable definition;
 * node transitions carry the full post-transition node snapshot, the previous
 * node revision, and the `clientRequestId`.
 */
export interface TaskGraphTransition {
	readonly schemaVersion: 1;
	readonly action: TaskGraphAction;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly graph?: TaskGraphDefinitionRecord;
	readonly node?: TaskGraphNodeRecord;
	readonly previousNodeRevision?: number;
	readonly clientRequestId: string;
}

export interface TaskGraphMutationResult {
	readonly graph: TaskGraphRecord;
	/** The affected node view for node transitions; absent for create. */
	readonly node?: TaskGraphNodeView;
	readonly appended: boolean;
	readonly idempotent: boolean;
	readonly entryId?: string;
}

export interface TaskGraphListResult {
	readonly graphs: ReadonlyArray<TaskGraphRecord>;
	readonly truncated: boolean;
}

export type TaskGraphWarningCode =
	| "malformed_source"
	| "unsupported_schema"
	| "session_mismatch"
	| "revision_gap"
	| "illegal_transition"
	| "idempotency_conflict"
	| "business_key_conflict"
	| "run_association_conflict";

export interface TaskGraphWarning {
	readonly code: TaskGraphWarningCode;
	/** Alias used by diagnostics consumers that classify warnings by kind. */
	readonly kind: TaskGraphWarningCode;
	readonly entryId: string;
}

export interface TaskGraphFoldResult {
	/** Immutable definitions in append order of the accepted `created` entry. */
	readonly graphs: ReadonlyArray<TaskGraphDefinitionRecord>;
	readonly byBusinessKey: ReadonlyMap<string, TaskGraphDefinitionRecord>;
	/** Live node records per business key, in definition order of the map values. */
	readonly byNodeId: ReadonlyMap<string, ReadonlyMap<string, TaskGraphNodeRecord>>;
	/** Idempotency index: `commandType\0clientRequestId` maps to the canonical payload of the winning transition. */
	readonly byIdempotencyKey: ReadonlyMap<string, string>;
	readonly warnings: ReadonlyArray<TaskGraphWarning>;
}

/** Minimal read-only Run surface used by attach / settle. */
export interface TaskGraphRunSnapshot {
	readonly sessionId: string;
	readonly runId: string;
	readonly status: RunStatus;
	readonly receiptStatus?: RunTerminalStatus;
}

/**
 * Injected read-only Run lookup. The adapter must only expose public-safe
 * Run facts of the current Session; the store never starts, cancels,
 * resumes, or rewrites a Run.
 */
export interface TaskGraphRunLookup {
	get(runId: string): TaskGraphRunSnapshot | undefined;
}

/**
 * Injected read-only Task Gate lookup. The adapter must only return
 * current-Session safe TaskGateRecord values; the store never creates,
 * approves, rejects, or cancels a Gate.
 */
export interface TaskGraphGateLookup {
	getByBusinessKey(taskId: string, stageId: string, stageRevision: number): TaskGateRecord | undefined;
}

/** Minimal Session surface used by the store; `SessionManager` satisfies it. */
export interface TaskGraphSession {
	getSessionId(): string;
	getEntries(): ReadonlyArray<SessionEntry>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface TaskGraphStoreOptions {
	/** Server timestamp source; must return a canonical UTC ISO timestamp. */
	readonly now?: () => string;
	readonly diagnostics?: (warning: TaskGraphWarning) => void;
	/**
	 * Read-only terminal observer fired when a node becomes terminal through
	 * node.settle. It is a side channel of the Graph ledger: it never rewrites
	 * the terminal node record and it is not fired for idempotent replays.
	 */
	readonly onNodeTerminal?: (node: TaskGraphNodeRecord, taskId: string, runId: string) => void;
}

export class TaskGraphError extends Error {
	readonly code: TaskGraphErrorCode;
	readonly retryable = false as const;

	constructor(code: TaskGraphErrorCode) {
		// Errors cross RPC boundaries as Error.message. Keep that channel
		// code-derived so caller payloads, paths, commands, and credentials
		// cannot escape through a caller-supplied message.
		super(TASK_GRAPH_ERROR_MESSAGES[code]);
		this.name = "TaskGraphError";
		this.code = code;
	}

	toJSON(): TaskGraphErrorView {
		return { code: this.code, message: TASK_GRAPH_ERROR_MESSAGES[this.code], retryable: false };
	}
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRANSITION_KEYS = new Set([
	"schemaVersion",
	"action",
	"taskId",
	"graphRevision",
	"graph",
	"node",
	"previousNodeRevision",
	"clientRequestId",
]);
const DEFINITION_KEYS = new Set(["schemaVersion", "sessionId", "taskId", "graphRevision", "createdAt", "nodes"]);
const NODE_RECORD_KEYS = new Set([
	"schemaVersion",
	"nodeId",
	"dependsOn",
	"status",
	"nodeRevision",
	"gateRef",
	"runRef",
	"outcomeCode",
]);
const GATE_REF_KEYS = new Set(["stageId", "stageRevision"]);
const RUN_REF_KEYS = new Set(["sessionId", "runId"]);
const CREATE_KEYS = new Set(["taskId", "graphRevision", "nodes", "clientRequestId"]);
const ATTACH_KEYS = new Set(["taskId", "graphRevision", "nodeId", "runId", "clientRequestId"]);
const SETTLE_KEYS = new Set(["taskId", "graphRevision", "nodeId", "clientRequestId"]);
const LIST_KEYS = new Set(["taskId", "graphRevision", "status", "limit"]);

export const TASK_GRAPH_LIST_DEFAULT_LIMIT = 50;
export const TASK_GRAPH_LIST_MAX_LIMIT = 100;
export const TASK_GRAPH_MAX_NODES = 256;
export const TASK_GRAPH_MAX_EDGES = 1024;
export const TASK_GRAPH_MAX_DEPENDENCIES_PER_NODE = 64;
export const TASK_GRAPH_ID_MAX_LENGTH = 256;
export const TASK_GRAPH_CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const TASK_GRAPH_OUTCOME_CODE_MAX_LENGTH = 64;
/** Upper bound on the serialized create request, a resource protection contract. */
export const TASK_GRAPH_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * Keys that must never appear in a create request, node definition, list
 * filter, or persisted snapshot. These are rejected before the state machine
 * runs so task text, tool payloads, paths, environment values, credentials,
 * and provider internals cannot become Graph facts.
 */
export const TASK_GRAPH_FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
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
	"finalText",
	"usage",
	"output",
	"url",
	"payload",
	"callback",
	"instructions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/** Safe opaque identifiers reject paths, URLs, userinfo, query text, and controls. */
export function isTaskGraphIdentifier(value: unknown): value is string {
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

export function isCanonicalTaskGraphTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
	return isTaskGraphIdentifier(value) && value.length <= maxLength;
}

function safeEntryId(value: unknown): string | undefined {
	return isTaskGraphIdentifier(value) ? value : undefined;
}

function warningFor(entryId: string, code: TaskGraphWarningCode): TaskGraphWarning {
	return { code, kind: code, entryId: safeEntryId(entryId) ?? "unknown" };
}

/** Map a transition action onto its Automation Host command type. */
export function taskGraphCommandType(action: TaskGraphAction): TaskGraphCommandType {
	switch (action) {
		case "created":
			return "task.graph.create";
		case "node.attached":
			return "task.graph.node.attach";
		case "node.succeeded":
		case "node.failed":
		case "node.cancelled":
			return "task.graph.node.settle";
	}
}

/** Map a node status onto the transition action that produced it. */
export function taskGraphActionForStatus(status: TaskGraphNodeStatus): TaskGraphAction {
	switch (status) {
		case "pending":
			return "created";
		case "running":
			return "node.attached";
		case "succeeded":
			return "node.succeeded";
		case "failed":
			return "node.failed";
		case "cancelled":
			return "node.cancelled";
	}
}

/** Map a terminal Run status onto the node terminal status. */
export function taskGraphNodeStatusForRunTerminal(status: RunTerminalStatus): TaskGraphNodeStatus {
	switch (status) {
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
	}
}

interface TaskGraphNodeLike {
	readonly nodeId: string;
	readonly dependsOn: ReadonlyArray<string>;
	readonly gateRef?: TaskGraphGateRef;
}

/**
 * Canonical node list for idempotency fingerprints: sorted by `nodeId` with
 * only the immutable definition fields, so reordered input does not create a
 * false conflict and node status never participates in the fingerprint.
 */
export function canonicalTaskGraphNodes(nodes: ReadonlyArray<TaskGraphNodeLike>): ReadonlyArray<unknown> {
	return [...nodes]
		.sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))
		.map((node) => ({
			nodeId: node.nodeId,
			dependsOn: [...node.dependsOn],
			...(node.gateRef === undefined
				? {}
				: { gateRef: { stageId: node.gateRef.stageId, stageRevision: node.gateRef.stageRevision } }),
		}));
}

/** The canonical idempotency payload of `task.graph.create`. */
export function canonicalTaskGraphCreatePayload(input: TaskGraphCreateRequest): string {
	return JSON.stringify({
		taskId: input.taskId,
		graphRevision: input.graphRevision,
		nodes: canonicalTaskGraphNodes(input.nodes),
	});
}

/** The canonical idempotency payload of `task.graph.node.attach`. */
export function canonicalTaskGraphAttachPayload(input: TaskGraphNodeAttachRequest): string {
	return JSON.stringify({
		taskId: input.taskId,
		graphRevision: input.graphRevision,
		nodeId: input.nodeId,
		runId: input.runId,
	});
}

/** The canonical idempotency payload of `task.graph.node.settle`. */
export function canonicalTaskGraphSettlePayload(input: TaskGraphNodeSettleRequest): string {
	return JSON.stringify({
		taskId: input.taskId,
		graphRevision: input.graphRevision,
		nodeId: input.nodeId,
	});
}

/** Derive the canonical payload of a persisted transition from its snapshot. */
function canonicalTransitionPayload(
	action: TaskGraphAction,
	taskId: string,
	graphRevision: number,
	graphOrNode: TaskGraphDefinitionRecord | TaskGraphNodeRecord,
): string {
	if (action === "created") {
		const graph = graphOrNode as TaskGraphDefinitionRecord;
		return JSON.stringify({ taskId, graphRevision, nodes: canonicalTaskGraphNodes(graph.nodes) });
	}
	const node = graphOrNode as TaskGraphNodeRecord;
	if (action === "node.attached") {
		return JSON.stringify({ taskId, graphRevision, nodeId: node.nodeId, runId: node.runRef?.runId });
	}
	return JSON.stringify({ taskId, graphRevision, nodeId: node.nodeId });
}

function isTaskGraphGateRef(value: unknown): value is TaskGraphGateRef {
	if (!isRecord(value) || !hasOnlyKeys(value, GATE_REF_KEYS)) return false;
	return isTaskGraphIdentifier(value.stageId) && isPositiveSafeInteger(value.stageRevision);
}

function isTaskGraphRunRef(value: unknown): value is TaskGraphRunRef {
	if (!isRecord(value) || !hasOnlyKeys(value, RUN_REF_KEYS)) return false;
	return isTaskGraphIdentifier(value.sessionId) && isTaskGraphIdentifier(value.runId);
}

function nodeRecordRules(value: Record<string, unknown>): boolean {
	if (value.status === "pending") {
		return value.nodeRevision === 0 && value.runRef === undefined && value.outcomeCode === undefined;
	}
	if (value.status === "running") {
		return value.nodeRevision === 1 && value.runRef !== undefined && value.outcomeCode === undefined;
	}
	return value.nodeRevision === 2 && value.runRef !== undefined;
}

/** Validate a node snapshot field-by-field, rejecting unknown or forbidden keys. */
export function isTaskGraphNodeRecord(value: unknown): value is TaskGraphNodeRecord {
	if (!isRecord(value) || !hasOnlyKeys(value, NODE_RECORD_KEYS)) return false;
	return (
		value.schemaVersion === TASK_GRAPH_SCHEMA_VERSION &&
		isTaskGraphIdentifier(value.nodeId) &&
		Array.isArray(value.dependsOn) &&
		value.dependsOn.length <= TASK_GRAPH_MAX_DEPENDENCIES_PER_NODE &&
		value.dependsOn.every((dep) => isTaskGraphIdentifier(dep)) &&
		TASK_GRAPH_NODE_STATUS.includes(value.status as TaskGraphNodeStatus) &&
		isNonNegativeSafeInteger(value.nodeRevision) &&
		(value.gateRef === undefined || isTaskGraphGateRef(value.gateRef)) &&
		(value.runRef === undefined || isTaskGraphRunRef(value.runRef)) &&
		(value.outcomeCode === undefined || isBoundedIdentifier(value.outcomeCode, TASK_GRAPH_OUTCOME_CODE_MAX_LENGTH)) &&
		nodeRecordRules(value)
	);
}

/** Structural DAG rules: unique IDs, existing deps, no self or duplicate deps, bounded edges. */
function isValidDagStructure(nodes: ReadonlyArray<TaskGraphNodeLike>): boolean {
	const byId = new Set<string>();
	for (const node of nodes) {
		if (byId.has(node.nodeId)) return false;
		byId.add(node.nodeId);
	}
	let edges = 0;
	for (const node of nodes) {
		const seen = new Set<string>();
		for (const dep of node.dependsOn) {
			if (seen.has(dep) || dep === node.nodeId || !byId.has(dep)) return false;
			seen.add(dep);
			edges++;
		}
	}
	return edges <= TASK_GRAPH_MAX_EDGES;
}

/** Kahn topological reduction over the dependency direction; true when a cycle remains. */
function hasDependencyCycle(nodes: ReadonlyArray<TaskGraphNodeLike>): boolean {
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		indegree.set(node.nodeId, node.dependsOn.length);
		for (const dep of node.dependsOn) {
			const list = dependents.get(dep) ?? [];
			list.push(node.nodeId);
			dependents.set(dep, list);
		}
	}
	// The queue and the dependent lists are built in input order, so the
	// result is deterministic for identical input.
	const queue = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.nodeId);
	let consumed = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		consumed++;
		for (const dependent of dependents.get(id) ?? []) {
			indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
			if (indegree.get(dependent) === 0) queue.push(dependent);
		}
	}
	return consumed !== nodes.length;
}

/** Deterministic DAG check: structural rules plus acyclicity. */
function isValidDag(nodes: ReadonlyArray<TaskGraphNodeLike>): boolean {
	return isValidDagStructure(nodes) && !hasDependencyCycle(nodes);
}

/** Validate a persisted definition: schema, identifiers, pending snapshots, and a deterministic DAG. */
export function isTaskGraphDefinitionRecord(value: unknown): value is TaskGraphDefinitionRecord {
	if (!isRecord(value) || !hasOnlyKeys(value, DEFINITION_KEYS)) return false;
	if (value.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) return false;
	if (!isTaskGraphIdentifier(value.sessionId)) return false;
	if (!isTaskGraphIdentifier(value.taskId)) return false;
	if (!isPositiveSafeInteger(value.graphRevision)) return false;
	if (!isCanonicalTaskGraphTimestamp(value.createdAt)) return false;
	if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > TASK_GRAPH_MAX_NODES) {
		return false;
	}
	for (const node of value.nodes) {
		if (!isTaskGraphNodeRecord(node)) return false;
		if (node.status !== "pending" || node.nodeRevision !== 0 || node.runRef !== undefined) return false;
	}
	return isValidDag(value.nodes);
}

/** The transition action must correspond to the snapshot status. */
export function isTaskGraphActionForStatus(action: TaskGraphAction, status: TaskGraphNodeStatus): boolean {
	return taskGraphActionForStatus(status) === action;
}

/** Validate a persisted transition payload without accepting raw data. */
export function isTaskGraphTransition(value: unknown): value is TaskGraphTransition {
	if (!isRecord(value) || !hasOnlyKeys(value, TRANSITION_KEYS)) return false;
	if (value.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) return false;
	if (!TASK_GRAPH_ACTION.includes(value.action as TaskGraphAction)) return false;
	if (!isTaskGraphIdentifier(value.taskId)) return false;
	if (!isPositiveSafeInteger(value.graphRevision)) return false;
	if (!isBoundedIdentifier(value.clientRequestId, TASK_GRAPH_CLIENT_REQUEST_ID_MAX_LENGTH)) return false;
	const action = value.action as TaskGraphAction;
	if (action === "created") {
		if (!isTaskGraphDefinitionRecord(value.graph)) return false;
		if (value.node !== undefined || value.previousNodeRevision !== undefined) return false;
		const graph = value.graph as TaskGraphDefinitionRecord;
		return graph.taskId === value.taskId && graph.graphRevision === value.graphRevision;
	}
	if (value.graph !== undefined || !isTaskGraphNodeRecord(value.node)) return false;
	if (!isNonNegativeSafeInteger(value.previousNodeRevision)) return false;
	const node = value.node as TaskGraphNodeRecord;
	switch (action) {
		case "node.attached":
			return value.previousNodeRevision === 0 && node.nodeRevision === 1 && node.status === "running";
		case "node.succeeded":
			return value.previousNodeRevision === 1 && node.nodeRevision === 2 && node.status === "succeeded";
		case "node.failed":
			return value.previousNodeRevision === 1 && node.nodeRevision === 2 && node.status === "failed";
		case "node.cancelled":
			return value.previousNodeRevision === 1 && node.nodeRevision === 2 && node.status === "cancelled";
	}
}

/** Read the declared schema version of a custom entry payload, if any. */
export function taskGraphSchemaVersion(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.schemaVersion !== "number") return undefined;
	return value.schemaVersion;
}

/** Parse only the exact schema-versioned transition payload. */
export function parseTaskGraphTransition(value: unknown): TaskGraphTransition | undefined {
	return isTaskGraphTransition(value) ? cloneTransition(value) : undefined;
}

/** Defensive public copy of a node record. */
export function serializeTaskGraphNode(value: TaskGraphNodeRecord): TaskGraphNodeRecord {
	const record: TaskGraphNodeRecord = {
		schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
		nodeId: value.nodeId,
		dependsOn: [...value.dependsOn],
		status: value.status,
		nodeRevision: value.nodeRevision,
	};
	if (value.gateRef !== undefined) {
		(record as { gateRef?: TaskGraphGateRef }).gateRef = {
			stageId: value.gateRef.stageId,
			stageRevision: value.gateRef.stageRevision,
		};
	}
	if (value.runRef !== undefined) {
		(record as { runRef?: TaskGraphRunRef }).runRef = {
			sessionId: value.runRef.sessionId,
			runId: value.runRef.runId,
		};
	}
	if (value.outcomeCode !== undefined) (record as { outcomeCode?: string }).outcomeCode = value.outcomeCode;
	return record;
}

/** Defensive public copy of a Graph definition. */
export function serializeTaskGraphDefinition(value: TaskGraphDefinitionRecord): TaskGraphDefinitionRecord {
	return {
		schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
		sessionId: value.sessionId,
		taskId: value.taskId,
		graphRevision: value.graphRevision,
		createdAt: value.createdAt,
		nodes: value.nodes.map((node) => serializeTaskGraphNode(node)),
	};
}

function cloneTransition(value: TaskGraphTransition): TaskGraphTransition {
	const transition: TaskGraphTransition = {
		schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
		action: value.action,
		taskId: value.taskId,
		graphRevision: value.graphRevision,
		clientRequestId: value.clientRequestId,
	};
	if (value.graph !== undefined) (transition as { graph?: TaskGraphDefinitionRecord }).graph = serializeTaskGraphDefinition(value.graph);
	if (value.node !== undefined) (transition as { node?: TaskGraphNodeRecord }).node = serializeTaskGraphNode(value.node);
	if (value.previousNodeRevision !== undefined) {
		(transition as { previousNodeRevision?: number }).previousNodeRevision = value.previousNodeRevision;
	}
	return transition;
}

function businessKey(sessionId: string, taskId: string, graphRevision: number): string {
	return `${sessionId}\u0000${taskId}\u0000${graphRevision}`;
}

function idempotencyKey(commandType: TaskGraphCommandType, clientRequestId: string): string {
	return `${commandType}\u0000${clientRequestId}`;
}

/** Two snapshots of the same node must agree on all immutable definition fields. */
function sameNodeDefinition(left: TaskGraphNodeRecord, right: TaskGraphNodeRecord): boolean {
	if (left.nodeId !== right.nodeId || left.dependsOn.length !== right.dependsOn.length) return false;
	for (let index = 0; index < left.dependsOn.length; index++) {
		if (left.dependsOn[index] !== right.dependsOn[index]) return false;
	}
	if (left.gateRef === undefined || right.gateRef === undefined) {
		return left.gateRef === right.gateRef;
	}
	return (
		left.gateRef.stageId === right.gateRef.stageId && left.gateRef.stageRevision === right.gateRef.stageRevision
	);
}

/** Full persisted node snapshot equality: definition fields, status, revision, run association, and outcome. */
function sameNodeSnapshot(left: TaskGraphNodeRecord, right: TaskGraphNodeRecord): boolean {
	if (left.nodeId !== right.nodeId || left.status !== right.status || left.nodeRevision !== right.nodeRevision) {
		return false;
	}
	if (!sameNodeDefinition(left, right)) return false;
	if (left.runRef === undefined || right.runRef === undefined) return left.runRef === right.runRef;
	if (left.runRef.sessionId !== right.runRef.sessionId || left.runRef.runId !== right.runRef.runId) return false;
	return (left.outcomeCode ?? undefined) === (right.outcomeCode ?? undefined);
}

/** Full persisted definition snapshot equality across every node. */
function sameDefinitionSnapshot(left: TaskGraphDefinitionRecord, right: TaskGraphDefinitionRecord): boolean {
	if (
		left.sessionId !== right.sessionId ||
		left.taskId !== right.taskId ||
		left.graphRevision !== right.graphRevision ||
		left.createdAt !== right.createdAt ||
		left.nodes.length !== right.nodes.length
	) {
		return false;
	}
	for (let index = 0; index < left.nodes.length; index++) {
		if (!sameNodeSnapshot(left.nodes[index], right.nodes[index])) return false;
	}
	return true;
}

function customEntry(value: SessionEntry): value is Extract<SessionEntry, { type: "custom" }> {
	return value.type === "custom";
}

function graphHasRun(nodesById: ReadonlyMap<string, TaskGraphNodeRecord>, runId: string): boolean {
	for (const node of nodesById.values()) {
		if (node.runRef?.runId === runId) return true;
	}
	return false;
}

/**
 * Fold `task.graph` custom entries in append order into the current Graph
 * projection. Entries that fail schema, identifier, session, revision,
 * transition, idempotency, business-key, or run-association rules are skipped
 * with a warning and never surface raw data. For duplicate idempotency keys
 * the first accepted transition wins; a later entry with the same key but a
 * different payload is dropped with a warning.
 */
export function foldTaskGraphEntries(
	entries: ReadonlyArray<SessionEntry>,
	sessionId: string,
	diagnostics?: (warning: TaskGraphWarning) => void,
): TaskGraphFoldResult {
	const byBusinessKey = new Map<string, TaskGraphDefinitionRecord>();
	const byNodeId = new Map<string, Map<string, TaskGraphNodeRecord>>();
	const byIdempotencyKey = new Map<string, string>();
	const graphs: TaskGraphDefinitionRecord[] = [];
	const warnings: TaskGraphWarning[] = [];
	const emit = (warning: TaskGraphWarning): void => {
		warnings.push(warning);
		diagnostics?.(warning);
	};
	for (const entry of entries) {
		if (!customEntry(entry) || entry.customType !== TASK_GRAPH_CUSTOM_TYPE) continue;
		const schemaVersion = taskGraphSchemaVersion(entry.data);
		if (schemaVersion === undefined || schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) {
			emit(warningFor(entry.id, schemaVersion === undefined ? "malformed_source" : "unsupported_schema"));
			continue;
		}
		const transition = parseTaskGraphTransition(entry.data);
		if (transition === undefined) {
			emit(warningFor(entry.id, "malformed_source"));
			continue;
		}
		const { action, taskId, graphRevision, graph, node, previousNodeRevision, clientRequestId } = transition;
		const key = idempotencyKey(taskGraphCommandType(action), clientRequestId);
		const existingPayload = byIdempotencyKey.get(key);
		if (existingPayload !== undefined) {
			const payload = canonicalTransitionPayload(action, taskId, graphRevision, graph ?? node!);
			if (existingPayload !== payload) {
				emit(warningFor(entry.id, "idempotency_conflict"));
			}
			continue;
		}
		if (action === "created") {
			const definition = graph!;
			if (definition.sessionId !== sessionId) {
				emit(warningFor(entry.id, "session_mismatch"));
				continue;
			}
			const keyValue = businessKey(sessionId, taskId, graphRevision);
			if (byBusinessKey.has(keyValue)) {
				emit(warningFor(entry.id, "business_key_conflict"));
				continue;
			}
			const clone = serializeTaskGraphDefinition(definition);
			byBusinessKey.set(keyValue, clone);
			graphs.push(clone);
			byNodeId.set(
				keyValue,
				new Map(clone.nodes.map((nodeRecord) => [nodeRecord.nodeId, serializeTaskGraphNode(nodeRecord)])),
			);
			byIdempotencyKey.set(key, canonicalTransitionPayload(action, taskId, graphRevision, clone));
			continue;
		}
		const nodeRecord = node!;
		const keyValue = businessKey(sessionId, taskId, graphRevision);
		const nodesById = byNodeId.get(keyValue);
		if (nodesById === undefined) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		const current = nodesById.get(nodeRecord.nodeId);
		if (action === "node.attached") {
			if (current === undefined) {
				emit(warningFor(entry.id, "revision_gap"));
				continue;
			}
			if (current.status !== "pending") {
				// The node already carries a run association (or is terminal);
				// this entry would attach a second Run to the same node.
				emit(warningFor(entry.id, "run_association_conflict"));
				continue;
			}
			if (previousNodeRevision !== 0 || nodeRecord.nodeRevision !== 1 || nodeRecord.status !== "running") {
				emit(warningFor(entry.id, "revision_gap"));
				continue;
			}
			if (!sameNodeDefinition(current, nodeRecord)) {
				emit(warningFor(entry.id, "illegal_transition"));
				continue;
			}
			// The run association must stay inside the current Session; a foreign
			// runRef sessionId is a session-mismatched fact, never a valid attach.
			if (nodeRecord.runRef === undefined || nodeRecord.runRef.sessionId !== sessionId) {
				emit(warningFor(entry.id, "session_mismatch"));
				continue;
			}
			if (graphHasRun(nodesById, nodeRecord.runRef.runId)) {
				emit(warningFor(entry.id, "run_association_conflict"));
				continue;
			}
			nodesById.set(nodeRecord.nodeId, serializeTaskGraphNode(nodeRecord));
			byIdempotencyKey.set(key, canonicalTransitionPayload(action, taskId, graphRevision, nodeRecord));
			continue;
		}
		if (current === undefined) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		if (current.status !== "running") {
			emit(warningFor(entry.id, "illegal_transition"));
			continue;
		}
		if (previousNodeRevision !== current.nodeRevision || nodeRecord.nodeRevision !== current.nodeRevision + 1) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		if (!sameNodeDefinition(current, nodeRecord)) {
			emit(warningFor(entry.id, "illegal_transition"));
			continue;
		}
		if (nodeRecord.runRef === undefined || nodeRecord.runRef.sessionId !== sessionId) {
			emit(warningFor(entry.id, "session_mismatch"));
			continue;
		}
		if (
			current.runRef === undefined ||
			nodeRecord.runRef.runId !== current.runRef.runId ||
			nodeRecord.runRef.sessionId !== current.runRef.sessionId
		) {
			emit(warningFor(entry.id, "run_association_conflict"));
			continue;
		}
		nodesById.set(nodeRecord.nodeId, serializeTaskGraphNode(nodeRecord));
		byIdempotencyKey.set(key, canonicalTransitionPayload(action, taskId, graphRevision, nodeRecord));
	}
	return { graphs, byBusinessKey, byNodeId, byIdempotencyKey, warnings };
}

/**
 * Read-time eligibility of one node. Only pending nodes produce an
 * availability; running and terminal nodes return `null`. `blockingNodeIds`
 * lists the not-yet-succeeded dependency IDs (or the failed/cancelled
 * dependency IDs for a blocked node); a Gate reason is reported through
 * `gateStatus`. The Gate lookup is strictly read-only and is only consulted
 * for pending nodes that carry a `gateRef`.
 */
export function deriveTaskGraphNodeEligibility(
	node: TaskGraphNodeRecord,
	nodesById: ReadonlyMap<string, TaskGraphNodeRecord>,
	taskId: string,
	gateLookup: TaskGraphGateLookup,
): { availability: TaskGraphNodeAvailability | null; blockingNodeIds: ReadonlyArray<string>; gateStatus?: TaskGateStatus | "missing" } {
	if (node.status !== "pending") {
		return { availability: null, blockingNodeIds: [] };
	}
	const failedDependencies: string[] = [];
	const waitingDependencies: string[] = [];
	for (const dependencyId of node.dependsOn) {
		const dependency = nodesById.get(dependencyId);
		if (dependency === undefined) {
			waitingDependencies.push(dependencyId);
			continue;
		}
		if (dependency.status === "failed" || dependency.status === "cancelled") {
			failedDependencies.push(dependencyId);
		} else if (dependency.status !== "succeeded") {
			waitingDependencies.push(dependencyId);
		}
	}
	if (failedDependencies.length > 0) {
		return { availability: "blocked", blockingNodeIds: failedDependencies };
	}
	if (waitingDependencies.length > 0) {
		return { availability: "waiting_dependencies", blockingNodeIds: waitingDependencies };
	}
	if (node.gateRef === undefined) {
		return { availability: "ready", blockingNodeIds: [] };
	}
	const gate = gateLookup.getByBusinessKey(taskId, node.gateRef.stageId, node.gateRef.stageRevision);
	if (gate === undefined) {
		return { availability: "waiting_gate", blockingNodeIds: [], gateStatus: "missing" };
	}
	if (gate.status === "pending") {
		return { availability: "waiting_gate", blockingNodeIds: [], gateStatus: gate.status };
	}
	if (gate.status === "rejected" || gate.status === "cancelled") {
		return { availability: "blocked", blockingNodeIds: [], gateStatus: gate.status };
	}
	return { availability: "ready", blockingNodeIds: [], gateStatus: gate.status };
}

/** Derive the aggregate Graph status and counts from the node statuses. */
export function summarizeTaskGraph(nodes: ReadonlyArray<{ readonly status: TaskGraphNodeStatus }>): TaskGraphSummary {
	const counts: Record<TaskGraphNodeStatus, number> = {
		pending: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const node of nodes) {
		counts[node.status]++;
	}
	let status: TaskGraphStatus = "active";
	if (counts.pending === 0 && counts.running === 0) {
		if (counts.failed > 0) status = "failed";
		else if (counts.cancelled > 0) status = "cancelled";
		else status = "succeeded";
	}
	return { status, ...counts };
}

function assertNoForbiddenPayloadKeys(input: Record<string, unknown>): void {
	const forbidden = new Set(TASK_GRAPH_FORBIDDEN_PAYLOAD_KEYS);
	for (const key of Object.keys(input)) {
		if (forbidden.has(key.toLowerCase())) {
			throw new TaskGraphError("task_graph_invalid");
		}
	}
}

function validateNodeDefinition(node: TaskGraphNodeDefinition): void {
	const raw: unknown = node;
	if (!isRecord(raw) || !hasOnlyKeys(raw, new Set(["nodeId", "dependsOn", "gateRef"]))) {
		throw new TaskGraphError("task_graph_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (!isBoundedIdentifier(node.nodeId, TASK_GRAPH_ID_MAX_LENGTH)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (!Array.isArray(node.dependsOn) || node.dependsOn.length > TASK_GRAPH_MAX_DEPENDENCIES_PER_NODE) {
		throw new TaskGraphError("task_graph_invalid");
	}
	for (const dependencyId of node.dependsOn) {
		if (!isBoundedIdentifier(dependencyId, TASK_GRAPH_ID_MAX_LENGTH)) {
			throw new TaskGraphError("task_graph_invalid");
		}
	}
	if (node.gateRef !== undefined) {
		const gateRef: unknown = node.gateRef;
		if (!isRecord(gateRef) || !hasOnlyKeys(gateRef, GATE_REF_KEYS)) {
			throw new TaskGraphError("task_graph_invalid");
		}
		assertNoForbiddenPayloadKeys(gateRef);
		if (
			!isBoundedIdentifier(node.gateRef.stageId, TASK_GRAPH_ID_MAX_LENGTH) ||
			!isPositiveSafeInteger(node.gateRef.stageRevision)
		) {
			throw new TaskGraphError("task_graph_invalid");
		}
	}
}

function validateCreateRequest(input: TaskGraphCreateRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, CREATE_KEYS)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (!isBoundedIdentifier(input.taskId, TASK_GRAPH_ID_MAX_LENGTH)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (!isPositiveSafeInteger(input.graphRevision)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (!isBoundedIdentifier(input.clientRequestId, TASK_GRAPH_CLIENT_REQUEST_ID_MAX_LENGTH)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > TASK_GRAPH_MAX_NODES) {
		throw new TaskGraphError("task_graph_invalid");
	}
	for (const node of input.nodes) {
		validateNodeDefinition(node);
	}
	if (new TextEncoder().encode(JSON.stringify(input)).length > TASK_GRAPH_MAX_REQUEST_BYTES) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (!isValidDagStructure(input.nodes)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (hasDependencyCycle(input.nodes)) {
		throw new TaskGraphError("task_graph_dependency_cycle");
	}
}

function validateAttachRequest(input: TaskGraphNodeAttachRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, ATTACH_KEYS)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.taskId, TASK_GRAPH_ID_MAX_LENGTH) ||
		!isPositiveSafeInteger(input.graphRevision) ||
		!isBoundedIdentifier(input.nodeId, TASK_GRAPH_ID_MAX_LENGTH) ||
		!isTaskGraphIdentifier(input.runId) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_GRAPH_CLIENT_REQUEST_ID_MAX_LENGTH)
	) {
		throw new TaskGraphError("task_graph_invalid");
	}
}

function validateSettleRequest(input: TaskGraphNodeSettleRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, SETTLE_KEYS)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.taskId, TASK_GRAPH_ID_MAX_LENGTH) ||
		!isPositiveSafeInteger(input.graphRevision) ||
		!isBoundedIdentifier(input.nodeId, TASK_GRAPH_ID_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_GRAPH_CLIENT_REQUEST_ID_MAX_LENGTH)
	) {
		throw new TaskGraphError("task_graph_invalid");
	}
}

function validateListFilter(filter: TaskGraphListFilter): void {
	const raw: unknown = filter;
	if (!isRecord(raw) || !hasOnlyKeys(raw, LIST_KEYS)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (filter.taskId !== undefined && !isBoundedIdentifier(filter.taskId, TASK_GRAPH_ID_MAX_LENGTH)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (filter.graphRevision !== undefined && !isPositiveSafeInteger(filter.graphRevision)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (filter.status !== undefined && !TASK_GRAPH_STATUS.includes(filter.status)) {
		throw new TaskGraphError("task_graph_invalid");
	}
	if (
		filter.limit !== undefined &&
		(!Number.isSafeInteger(filter.limit) || filter.limit <= 0 || filter.limit > TASK_GRAPH_LIST_MAX_LIMIT)
	) {
		throw new TaskGraphError("task_graph_invalid");
	}
}

function isTerminalRunStatus(status: RunStatus): status is RunTerminalStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Session-scoped Task Graph store. A new instance folds the current
 * Session's `task.graph` entries, which makes business-key uniqueness,
 * run association, and idempotency restart-safe. All writes go through the
 * injected Session single-writer (the append callback); a write is
 * acknowledged only after the appended transition folds back.
 */
export class TaskGraphStore {
	private readonly session: TaskGraphSession;
	private readonly sessionId: string;
	private readonly runLookup: TaskGraphRunLookup;
	private readonly gateLookup: TaskGraphGateLookup;
	private readonly nowFn: () => string;
	private readonly diagnosticsSink: ((warning: TaskGraphWarning) => void) | undefined;
	private readonly nodeTerminalSink: ((node: TaskGraphNodeRecord, taskId: string, runId: string) => void) | undefined;
	private diagnosedEntryIds = new Set<string>();
	private fold: TaskGraphFoldResult = {
		graphs: [],
		byBusinessKey: new Map(),
		byNodeId: new Map(),
		byIdempotencyKey: new Map(),
		warnings: [],
	};

	constructor(
		session: TaskGraphSession,
		runLookup: TaskGraphRunLookup,
		gateLookup: TaskGraphGateLookup,
		options: TaskGraphStoreOptions = {},
	) {
		this.session = session;
		this.sessionId = session.getSessionId();
		this.runLookup = runLookup;
		this.gateLookup = gateLookup;
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.diagnosticsSink = options.diagnostics;
		this.nodeTerminalSink = options.onNodeTerminal;
		this.refresh();
	}

	private nextTimestamp(): string {
		let timestamp: string;
		try {
			timestamp = this.nowFn();
		} catch {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		if (!isCanonicalTaskGraphTimestamp(timestamp)) {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		return timestamp;
	}

	/** Re-read append-only entries and return the current diagnostics snapshot. */
	refresh(): ReadonlyArray<TaskGraphWarning> {
		let entries: ReadonlyArray<SessionEntry>;
		try {
			entries = this.session.getEntries();
		} catch {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		const warnings: TaskGraphWarning[] = [];
		this.fold = foldTaskGraphEntries(entries, this.sessionId, (warning) => {
			warnings.push(warning);
			if (!this.diagnosedEntryIds.has(warning.entryId)) {
				this.diagnosedEntryIds.add(warning.entryId);
				this.diagnosticsSink?.(warning);
			}
		});
		return warnings;
	}

	warnings(): readonly TaskGraphWarning[] {
		return this.fold.warnings;
	}

	getWarnings(): readonly TaskGraphWarning[] {
		return this.warnings();
	}

	private nodesById(businessKeyValue: string): ReadonlyMap<string, TaskGraphNodeRecord> {
		return this.fold.byNodeId.get(businessKeyValue) ?? new Map<string, TaskGraphNodeRecord>();
	}

	private buildNodeView(
		node: TaskGraphNodeRecord,
		nodesById: ReadonlyMap<string, TaskGraphNodeRecord>,
		taskId: string,
	): TaskGraphNodeView {
		const eligibility = deriveTaskGraphNodeEligibility(node, nodesById, taskId, this.gateLookup);
		const view: TaskGraphNodeView = {
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			nodeId: node.nodeId,
			dependsOn: [...node.dependsOn],
			status: node.status,
			nodeRevision: node.nodeRevision,
			availability: eligibility.availability,
			blockingNodeIds: [...eligibility.blockingNodeIds],
		};
		if (node.gateRef !== undefined) {
			(view as { gateRef?: TaskGraphGateRef }).gateRef = {
				stageId: node.gateRef.stageId,
				stageRevision: node.gateRef.stageRevision,
			};
		}
		if (node.runRef !== undefined) {
			(view as { runRef?: TaskGraphRunRef }).runRef = {
				sessionId: node.runRef.sessionId,
				runId: node.runRef.runId,
			};
		}
		if (eligibility.gateStatus !== undefined) (view as { gateStatus?: TaskGateStatus | "missing" }).gateStatus = eligibility.gateStatus;
		if (node.outcomeCode !== undefined) (view as { outcomeCode?: string }).outcomeCode = node.outcomeCode;
		return view;
	}

	private buildGraphView(definition: TaskGraphDefinitionRecord): TaskGraphRecord {
		const nodesById = this.nodesById(businessKey(this.sessionId, definition.taskId, definition.graphRevision));
		const views = definition.nodes.map((definitionNode) => {
			const current = nodesById.get(definitionNode.nodeId) ?? definitionNode;
			return this.buildNodeView(current, nodesById, definition.taskId);
		});
		return {
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			sessionId: definition.sessionId,
			taskId: definition.taskId,
			graphRevision: definition.graphRevision,
			createdAt: definition.createdAt,
			nodes: views,
			summary: summarizeTaskGraph(views),
		};
	}

	private replayCreate(businessKeyValue: string): TaskGraphMutationResult {
		const definition = this.fold.byBusinessKey.get(businessKeyValue);
		if (definition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		return { graph: this.buildGraphView(definition), appended: false, idempotent: true };
	}

	private replayNode(businessKeyValue: string, nodeId: string): TaskGraphMutationResult {
		const definition = this.fold.byBusinessKey.get(businessKeyValue);
		if (definition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		const nodesById = this.nodesById(businessKeyValue);
		const node = nodesById.get(nodeId) ?? definition.nodes.find((candidate) => candidate.nodeId === nodeId);
		if (node === undefined) {
			throw new TaskGraphError("task_graph_node_not_found");
		}
		return {
			graph: this.buildGraphView(definition),
			node: this.buildNodeView(node, nodesById, definition.taskId),
			appended: false,
			idempotent: true,
		};
	}

	/** Create an immutable Graph, or replay a prior identical create. */
	create(input: TaskGraphCreateRequest): TaskGraphMutationResult {
		validateCreateRequest(input);
		this.refresh();
		const key = idempotencyKey("task.graph.create", input.clientRequestId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== canonicalTaskGraphCreatePayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayCreate(businessKey(this.sessionId, input.taskId, input.graphRevision));
		}
		const keyValue = businessKey(this.sessionId, input.taskId, input.graphRevision);
		if (this.fold.byBusinessKey.has(keyValue)) {
			throw new TaskGraphError("task_graph_conflict");
		}
		const createdAt = this.nextTimestamp();
		const definition: TaskGraphDefinitionRecord = {
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			sessionId: this.sessionId,
			taskId: input.taskId,
			graphRevision: input.graphRevision,
			createdAt,
			nodes: input.nodes.map((node) => ({
				schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
				nodeId: node.nodeId,
				dependsOn: [...node.dependsOn],
				status: "pending",
				nodeRevision: 0,
				...(node.gateRef === undefined
					? {}
					: { gateRef: { stageId: node.gateRef.stageId, stageRevision: node.gateRef.stageRevision } }),
			})),
		};
		// Re-fold immediately before append so a concurrent writer cannot sneak
		// a conflicting graph or idempotency payload past the command-start
		// snapshot.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== canonicalTaskGraphCreatePayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayCreate(keyValue);
		}
		if (this.fold.byBusinessKey.has(keyValue)) {
			throw new TaskGraphError("task_graph_conflict");
		}
		return this.appendTransition({
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			action: "created",
			taskId: input.taskId,
			graphRevision: input.graphRevision,
			graph: definition,
			clientRequestId: input.clientRequestId,
		});
	}

	/** Associate an accepted or running Run of the current Session with a ready node. */
	attach(input: TaskGraphNodeAttachRequest): TaskGraphMutationResult {
		validateAttachRequest(input);
		this.refresh();
		const key = idempotencyKey("task.graph.node.attach", input.clientRequestId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== canonicalTaskGraphAttachPayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayNode(businessKey(this.sessionId, input.taskId, input.graphRevision), input.nodeId);
		}
		const keyValue = businessKey(this.sessionId, input.taskId, input.graphRevision);
		const definition = this.fold.byBusinessKey.get(keyValue);
		if (definition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		const nodesById = this.nodesById(keyValue);
		const node = nodesById.get(input.nodeId);
		if (node === undefined) {
			throw new TaskGraphError("task_graph_node_not_found");
		}
		if (node.status !== "pending" || node.nodeRevision !== 0) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		const eligibility = deriveTaskGraphNodeEligibility(node, nodesById, definition.taskId, this.gateLookup);
		if (eligibility.availability !== "ready") {
			throw new TaskGraphError("task_graph_node_not_eligible");
		}
		const run = this.runLookup.get(input.runId);
		if (run === undefined || run.sessionId !== this.sessionId) {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (run.status !== "accepted" && run.status !== "running") {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (graphHasRun(nodesById, input.runId)) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		// Re-fold immediately before append so the first valid transition wins
		// even if another writer attached the node or the Run after the
		// command-start snapshot.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== canonicalTaskGraphAttachPayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayNode(keyValue, input.nodeId);
		}
		const freshDefinition = this.fold.byBusinessKey.get(keyValue);
		if (freshDefinition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		const freshNodesById = this.nodesById(keyValue);
		const freshNode = freshNodesById.get(input.nodeId);
		if (freshNode === undefined) {
			throw new TaskGraphError("task_graph_node_not_found");
		}
		if (freshNode.status !== "pending" || freshNode.nodeRevision !== 0) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		const freshEligibility = deriveTaskGraphNodeEligibility(freshNode, freshNodesById, freshDefinition.taskId, this.gateLookup);
		if (freshEligibility.availability !== "ready") {
			throw new TaskGraphError("task_graph_node_not_eligible");
		}
		const freshRun = this.runLookup.get(input.runId);
		if (freshRun === undefined || freshRun.sessionId !== this.sessionId) {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (freshRun.status !== "accepted" && freshRun.status !== "running") {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (graphHasRun(freshNodesById, input.runId)) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		const attachedNode: TaskGraphNodeRecord = {
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			nodeId: input.nodeId,
			dependsOn: [...node.dependsOn],
			status: "running",
			nodeRevision: 1,
			...(node.gateRef === undefined
				? {}
				: { gateRef: { stageId: node.gateRef.stageId, stageRevision: node.gateRef.stageRevision } }),
			runRef: { sessionId: this.sessionId, runId: input.runId },
		};
		return this.appendTransition({
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			action: "node.attached",
			taskId: input.taskId,
			graphRevision: input.graphRevision,
			node: attachedNode,
			previousNodeRevision: 0,
			clientRequestId: input.clientRequestId,
		});
	}

	/**
	 * Fold the attached Run's terminal receipt into the node. `settle` reads
	 * the Run lookup again at settle time and accepts no caller-supplied
	 * status, `finalText`, or terminal error.
	 */
	settle(input: TaskGraphNodeSettleRequest): TaskGraphMutationResult {
		validateSettleRequest(input);
		this.refresh();
		const key = idempotencyKey("task.graph.node.settle", input.clientRequestId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== canonicalTaskGraphSettlePayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayNode(businessKey(this.sessionId, input.taskId, input.graphRevision), input.nodeId);
		}
		const keyValue = businessKey(this.sessionId, input.taskId, input.graphRevision);
		const definition = this.fold.byBusinessKey.get(keyValue);
		if (definition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		const nodesById = this.nodesById(keyValue);
		const node = nodesById.get(input.nodeId);
		if (node === undefined) {
			throw new TaskGraphError("task_graph_node_not_found");
		}
		if (node.status !== "running" || node.nodeRevision !== 1 || node.runRef === undefined) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		const run = this.runLookup.get(node.runRef.runId);
		if (run === undefined || run.sessionId !== this.sessionId) {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (!isTerminalRunStatus(run.status)) {
			throw new TaskGraphError("task_graph_run_not_terminal");
		}
		// settle maps the current terminal receipt, never the record status alone.
		// A terminal record without a persisted receipt, or a receipt that
		// disagrees with the record, is an inconsistent record/receipt fact pair.
		if (run.receiptStatus === undefined || run.receiptStatus !== run.status) {
			throw new TaskGraphError("task_graph_run_state_mismatch");
		}
		// Re-fold immediately before append; settle must not rely on a stale
		// projection or a stale Run snapshot.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== canonicalTaskGraphSettlePayload(input)) {
				throw new TaskGraphError("task_graph_idempotency_conflict");
			}
			return this.replayNode(keyValue, input.nodeId);
		}
		const freshDefinition = this.fold.byBusinessKey.get(keyValue);
		if (freshDefinition === undefined) {
			throw new TaskGraphError("task_graph_not_found");
		}
		const freshNodesById = this.nodesById(keyValue);
		const freshNode = freshNodesById.get(input.nodeId);
		if (freshNode === undefined) {
			throw new TaskGraphError("task_graph_node_not_found");
		}
		if (freshNode.status !== "running" || freshNode.nodeRevision !== 1 || freshNode.runRef === undefined) {
			throw new TaskGraphError("task_graph_node_conflict");
		}
		const freshRun = this.runLookup.get(freshNode.runRef.runId);
		if (freshRun === undefined || freshRun.sessionId !== this.sessionId) {
			throw new TaskGraphError("task_graph_run_not_found");
		}
		if (!isTerminalRunStatus(freshRun.status)) {
			throw new TaskGraphError("task_graph_run_not_terminal");
		}
		if (freshRun.receiptStatus === undefined || freshRun.receiptStatus !== freshRun.status) {
			throw new TaskGraphError("task_graph_run_state_mismatch");
		}
		const terminalStatus = taskGraphNodeStatusForRunTerminal(freshRun.status);
		const terminalNode: TaskGraphNodeRecord = {
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			nodeId: freshNode.nodeId,
			dependsOn: [...freshNode.dependsOn],
			status: terminalStatus,
			nodeRevision: 2,
			...(freshNode.gateRef === undefined
				? {}
				: { gateRef: { stageId: freshNode.gateRef.stageId, stageRevision: freshNode.gateRef.stageRevision } }),
			runRef: { sessionId: freshNode.runRef.sessionId, runId: freshNode.runRef.runId },
		};
		const result = this.appendTransition({
			schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
			action: taskGraphActionForStatus(terminalStatus),
			taskId: input.taskId,
			graphRevision: input.graphRevision,
			node: terminalNode,
			previousNodeRevision: 1,
			clientRequestId: input.clientRequestId,
		});
		// A terminal node invalidates the node's credential grants: the observer
		// (Task Credential service) revokes/settles them. The appended node
		// record is never rewritten here — this is a side channel only.
		if (this.nodeTerminalSink !== undefined) {
			this.nodeTerminalSink(serializeTaskGraphNode(terminalNode), input.taskId, freshNode.runRef.runId);
		}
		return result;
	}

	private appendTransition(transition: TaskGraphTransition): TaskGraphMutationResult {
		if (!isTaskGraphTransition(transition)) {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		let entryId: string;
		try {
			entryId = this.session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, cloneTransition(transition));
		} catch (error) {
			if (error instanceof TaskGraphError) throw error;
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		this.refresh();
		// Prove that exactly this transition was folded back. The idempotency key
		// is registered only by the first accepted transition carrying it, so it
		// must now resolve to this transition's canonical payload; and the folded
		// snapshot must equal the appended snapshot in full. If a concurrent first
		// valid transition won the append race, this transition was skipped with a
		// fold warning and the key is absent (or bound to the winner's payload), so
		// this request must not be reported as success.
		const key = idempotencyKey(taskGraphCommandType(transition.action), transition.clientRequestId);
		const expectedPayload = canonicalTransitionPayload(
			transition.action,
			transition.taskId,
			transition.graphRevision,
			transition.graph ?? transition.node!,
		);
		if (this.fold.byIdempotencyKey.get(key) !== expectedPayload) {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		const keyValue = businessKey(this.sessionId, transition.taskId, transition.graphRevision);
		const definition = this.fold.byBusinessKey.get(keyValue);
		if (definition === undefined) {
			throw new TaskGraphError("task_graph_persistence_failed");
		}
		let nodeView: TaskGraphNodeView | undefined;
		if (transition.action === "created") {
			if (transition.graph === undefined || !sameDefinitionSnapshot(definition, transition.graph)) {
				throw new TaskGraphError("task_graph_persistence_failed");
			}
		} else {
			const node = transition.node;
			if (node === undefined) {
				throw new TaskGraphError("task_graph_persistence_failed");
			}
			const foldedNode = this.nodesById(keyValue).get(node.nodeId);
			if (foldedNode === undefined || !sameNodeSnapshot(foldedNode, node)) {
				throw new TaskGraphError("task_graph_persistence_failed");
			}
			nodeView = this.buildNodeView(foldedNode, this.nodesById(keyValue), definition.taskId);
		}
		return {
			graph: this.buildGraphView(definition),
			...(nodeView === undefined ? {} : { node: nodeView }),
			appended: true,
			idempotent: false,
			...(safeEntryId(entryId) === undefined ? {} : { entryId: safeEntryId(entryId) }),
		};
	}

	/** Read one Graph of the current Session. Read-only; never appends. */
	get(taskId: string, graphRevision: number): TaskGraphRecord | undefined {
		if (!isBoundedIdentifier(taskId, TASK_GRAPH_ID_MAX_LENGTH) || !isPositiveSafeInteger(graphRevision)) {
			throw new TaskGraphError("task_graph_invalid");
		}
		this.refresh();
		const definition = this.fold.byBusinessKey.get(businessKey(this.sessionId, taskId, graphRevision));
		return definition === undefined ? undefined : this.buildGraphView(definition);
	}

	/** List Graphs of the current Session with optional filters. Read-only; never appends. */
	list(filter: TaskGraphListFilter = {}): TaskGraphListResult {
		validateListFilter(filter);
		this.refresh();
		const limit = filter.limit ?? TASK_GRAPH_LIST_DEFAULT_LIMIT;
		const graphs: TaskGraphRecord[] = [];
		for (const definition of this.fold.graphs) {
			if (filter.taskId !== undefined && definition.taskId !== filter.taskId) continue;
			if (filter.graphRevision !== undefined && definition.graphRevision !== filter.graphRevision) continue;
			const view = this.buildGraphView(definition);
			if (filter.status !== undefined && view.summary.status !== filter.status) continue;
			if (graphs.length >= limit) {
				return { graphs, truncated: true };
			}
			graphs.push(view);
		}
		return { graphs, truncated: false };
	}
}

export function createTaskGraphStore(
	session: TaskGraphSession,
	runLookup: TaskGraphRunLookup,
	gateLookup: TaskGraphGateLookup,
	options?: TaskGraphStoreOptions,
): TaskGraphStore {
	return new TaskGraphStore(session, runLookup, gateLookup, options);
}
