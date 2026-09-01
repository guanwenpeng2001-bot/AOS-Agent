import type {
	AuditQuery,
	AuditQueryResult,
	RunGetData,
	TaskGateListData,
	TaskGateStatus,
	TaskGraphGetData,
	TaskGraphListData,
	TaskGraphStatus,
} from "../rpc/rpc-types.ts";

export const WEB_READ_ONLY_RPC_METHODS = [
	"run.get",
	"audit.query",
	"task.gate.list",
	"task.graph.get",
	"task.graph.list",
] as const;

export type WebReadOnlyRpcMethod = (typeof WEB_READ_ONLY_RPC_METHODS)[number];

export interface WebReadOnlyRpcClient {
	getRun(runId: string): Promise<RunGetData>;
	auditQuery(query: AuditQuery): Promise<AuditQueryResult>;
	listTaskGates(filter?: {
		taskId?: string;
		stageId?: string;
		status?: TaskGateStatus;
		limit?: number;
	}): Promise<TaskGateListData>;
	getTaskGraph(taskId: string, graphRevision: number): Promise<TaskGraphGetData>;
	listTaskGraphs(filter?: {
		taskId?: string;
		graphRevision?: number;
		status?: TaskGraphStatus;
		limit?: number;
	}): Promise<TaskGraphListData>;
}

export class WebRpcRequestError extends Error {
	readonly statusCode: number;
	readonly code: "method_not_allowed" | "invalid_request";

	constructor(statusCode: number, code: "method_not_allowed" | "invalid_request", message: string) {
		super(message);
		this.name = "WebRpcRequestError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

export async function invokeWebReadOnlyRpc(
	client: WebReadOnlyRpcClient,
	method: string,
	params: unknown,
): Promise<unknown> {
	switch (method) {
		case "run.get": {
			const record = requireRecord(params);
			return client.getRun(requireString(record, "runId"));
		}
		case "audit.query":
			return client.auditQuery(parseAuditQuery(params));
		case "task.gate.list":
			return client.listTaskGates(parseTaskGateFilter(params));
		case "task.graph.get": {
			const record = requireRecord(params);
			return client.getTaskGraph(requireString(record, "taskId"), requirePositiveInteger(record, "graphRevision"));
		}
		case "task.graph.list":
			return client.listTaskGraphs(parseTaskGraphFilter(params));
		default:
			throw new WebRpcRequestError(403, "method_not_allowed", "RPC method is not available on the read-only web surface.");
	}
}

function parseTaskGateFilter(value: unknown): {
	taskId?: string;
	stageId?: string;
	status?: TaskGateStatus;
	limit?: number;
} {
	const record = value === undefined ? {} : requireRecord(value);
	const filter: { taskId?: string; stageId?: string; status?: TaskGateStatus; limit?: number } = {};
	if (record.taskId !== undefined) filter.taskId = requireString(record, "taskId");
	if (record.stageId !== undefined) filter.stageId = requireString(record, "stageId");
	if (record.limit !== undefined) filter.limit = requirePositiveInteger(record, "limit");
	if (record.status !== undefined) {
		if (!isTaskGateStatus(record.status)) throw invalidRequest("status is invalid");
		filter.status = record.status;
	}
	return filter;
}

function parseAuditQuery(value: unknown): AuditQuery {
	const record = requireRecord(value);
	const scope = requireString(record, "scope");
	if (scope !== "current-session" && scope !== "session-directory") {
		throw invalidRequest("scope must be current-session or session-directory");
	}
	const query: {
		scope: AuditQuery["scope"];
		sessionId?: string;
		runId?: string;
		types?: AuditQuery["types"];
		from?: string;
		to?: string;
		cursor?: string;
		limit?: number;
	} = { scope };
	for (const key of ["sessionId", "runId", "from", "to", "cursor"] as const) {
		const item = record[key];
		if (item !== undefined) query[key] = requireString(record, key);
	}
	if (record.limit !== undefined) query.limit = requirePositiveInteger(record, "limit");
	if (record.types !== undefined) {
		if (!Array.isArray(record.types) || !record.types.every((item) => typeof item === "string")) {
			throw invalidRequest("types must be an array of strings");
		}
		query.types = record.types as AuditQuery["types"];
	}
	return query;
}

function parseTaskGraphFilter(value: unknown): {
	taskId?: string;
	graphRevision?: number;
	status?: TaskGraphStatus;
	limit?: number;
} {
	const record = value === undefined ? {} : requireRecord(value);
	const filter: { taskId?: string; graphRevision?: number; status?: TaskGraphStatus; limit?: number } = {};
	if (record.taskId !== undefined) filter.taskId = requireString(record, "taskId");
	if (record.graphRevision !== undefined) filter.graphRevision = requirePositiveInteger(record, "graphRevision");
	if (record.limit !== undefined) filter.limit = requirePositiveInteger(record, "limit");
	if (record.status !== undefined) {
		if (!isTaskGraphStatus(record.status)) throw invalidRequest("status is invalid");
		filter.status = record.status;
	}
	return filter;
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidRequest("params must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw invalidRequest(`${key} must be a non-empty string`);
	return value;
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw invalidRequest(`${key} must be a positive integer`);
	}
	return value;
}

function isTaskGraphStatus(value: unknown): value is TaskGraphStatus {
	return value === "active" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isTaskGateStatus(value: unknown): value is TaskGateStatus {
	return value === "pending" || value === "approved" || value === "rejected" || value === "cancelled";
}

function invalidRequest(message: string): WebRpcRequestError {
	return new WebRpcRequestError(400, "invalid_request", message);
}
