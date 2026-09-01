import { AutomationRpcError } from "../rpc/rpc-client.ts";
import type {
	RunAcceptedData,
	RunCancelData,
	TaskGateMutationData,
} from "../rpc/rpc-types.ts";
import { WebRpcRequestError } from "./read-only-rpc.ts";

export const WEB_OPERATION_RPC_METHODS = [
	"task.gate.approve",
	"task.gate.reject",
	"run.cancel",
	"run.resume",
] as const;

export type WebOperationRpcMethod = (typeof WEB_OPERATION_RPC_METHODS)[number];

export interface WebOperationRpcClient {
	approveTaskGate(gateId: string, clientRequestId: string, actorId?: string): Promise<TaskGateMutationData>;
	rejectTaskGate(
		gateId: string,
		clientRequestId: string,
		actorId?: string,
		reasonCode?: string,
	): Promise<TaskGateMutationData>;
	cancelRun(runId: string): Promise<RunCancelData>;
	resumeRun(
		sessionPath: string,
		sourceRunId: string,
		message: string,
		images?: undefined,
		capabilityProfile?: undefined,
		modelRoute?: undefined,
		modelRole?: undefined,
		policyProfile?: undefined,
		clientRequestId?: string,
	): Promise<RunAcceptedData>;
}

export class WebOperationError extends Error {
	readonly statusCode: number;
	readonly code:
		| "gate_not_found"
		| "gate_already_decided"
		| "run_not_found"
		| "run_not_cancellable"
		| "run_not_resumable"
		| "session_busy"
		| "operation_unavailable"
		| "operation_failed";

	constructor(statusCode: number, code: WebOperationError["code"], message: string) {
		super(message);
		this.name = "WebOperationError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

export async function invokeWebOperationRpc(
	client: WebOperationRpcClient,
	method: string,
	params: unknown,
): Promise<unknown> {
	try {
		switch (method) {
			case "task.gate.approve": {
				const record = requireConfirmedParams(params, ["gateId", "clientRequestId", "confirmed"]);
				return await client.approveTaskGate(
					requireString(record, "gateId"),
					requireString(record, "clientRequestId"),
					"web-operator",
				);
			}
			case "task.gate.reject": {
				const record = requireConfirmedParams(params, ["gateId", "clientRequestId", "confirmed"]);
				return await client.rejectTaskGate(
					requireString(record, "gateId"),
					requireString(record, "clientRequestId"),
					"web-operator",
					"operator_rejected",
				);
			}
			case "run.cancel": {
				const record = requireConfirmedParams(params, ["runId", "confirmed"]);
				return await client.cancelRun(requireString(record, "runId"));
			}
			case "run.resume": {
				const record = requireConfirmedParams(params, [
					"sessionPath",
					"sourceRunId",
					"message",
					"clientRequestId",
					"confirmed",
				]);
				return await client.resumeRun(
					requireString(record, "sessionPath"),
					requireString(record, "sourceRunId"),
					requireString(record, "message"),
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					requireString(record, "clientRequestId"),
				);
			}
			default:
				throw new WebRpcRequestError(
					403,
					"method_not_allowed",
					"RPC method is not available on the web operations surface.",
				);
		}
	} catch (error: unknown) {
		if (error instanceof WebRpcRequestError || error instanceof WebOperationError) throw error;
		throw mapWebOperationError(error);
	}
}

export function mapWebOperationError(error: unknown): WebOperationError {
	if (!(error instanceof AutomationRpcError)) {
		return new WebOperationError(502, "operation_failed", "The operation could not be completed.");
	}
	switch (error.code) {
		case "task_gate_not_found":
			return new WebOperationError(404, "gate_not_found", "This gate no longer exists.");
		case "task_gate_conflict":
		case "task_gate_idempotency_conflict":
		case "task_gate_not_pending":
		case "task_gate_stage_revision_mismatch":
			return new WebOperationError(
				409,
				"gate_already_decided",
				"This gate was already decided or changed. Refresh and try again.",
			);
		case "run_not_found":
		case "source_run_not_found":
			return new WebOperationError(404, "run_not_found", "This run no longer exists.");
		case "run_not_cancellable":
			return new WebOperationError(409, "run_not_cancellable", "This run can no longer be cancelled.");
		case "source_run_not_resumable":
		case "session_not_persistent":
			return new WebOperationError(409, "run_not_resumable", "This run cannot be resumed from that session.");
		case "session_busy":
			return new WebOperationError(409, "session_busy", "Another run is active. Wait for it to finish first.");
		case "host_not_initialized":
		case "start_rejected":
		case "ledger_persistence_failed":
		case "task_gate_persistence_failed":
		case "session_transition_failed":
			return new WebOperationError(503, "operation_unavailable", "The operation service is temporarily unavailable.");
		default:
			return new WebOperationError(400, "operation_failed", "The operation was rejected.");
	}
}

function requireConfirmedParams(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidRequest("params must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	if (!Object.keys(record).every((key) => allowedKeys.includes(key))) {
		throw invalidRequest("params contain unsupported fields");
	}
	if (record.confirmed !== true) throw invalidRequest("confirmed must be true");
	return record;
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw invalidRequest(`${key} must be a non-empty string`);
	}
	return value;
}

function invalidRequest(message: string): WebRpcRequestError {
	return new WebRpcRequestError(400, "invalid_request", message);
}
