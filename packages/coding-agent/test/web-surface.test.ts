import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRpcError } from "../src/modes/rpc/rpc-client.ts";
import type {
	AuditQueryResult,
	RunGetData,
	TaskGateListData,
	TaskGateMutationData,
	TaskGraphGetData,
	TaskGraphListData,
} from "../src/modes/rpc/rpc-types.ts";
import type { WebReadOnlyRpcClient } from "../src/modes/web/read-only-rpc.ts";
import type { WebOperationRpcClient } from "../src/modes/web/operations-rpc.ts";
import {
	startWebSurfaceServer,
	type WebSurfaceServer,
	WEB_SURFACE_HOST,
} from "../src/modes/web/server.ts";

interface HttpResult {
	readonly statusCode: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: string;
}

const RUN: RunGetData = {
	run: {
		id: "run-1",
		sessionId: "session-1",
		attempt: 1,
		status: "completed",
		model: { provider: "test", id: "model", thinkingLevel: "off" },
	},
};

const AUDIT: AuditQueryResult = {
	schemaVersion: 1,
	scope: "current-session",
	events: [],
	warnings: [],
};

const PENDING_GATE: TaskGateListData["gates"][number] = {
	schemaVersion: 1,
	sessionId: "session-1",
	gateId: "gate-1",
	taskId: "task-1",
	stageId: "stage-1",
	stageRevision: 1,
	status: "pending",
	revision: 0,
	requestedAt: "2026-09-01T00:00:00.000Z",
};

const GRAPH = {
	schemaVersion: 1 as const,
	sessionId: "session-1",
	taskId: "task-1",
	graphRevision: 1,
	createdAt: "2026-09-01T00:00:00.000Z",
	nodes: [],
	summary: { status: "active" as const, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
};

describe("web operations surface", () => {
	let surface: WebSurfaceServer | undefined;

	afterEach(async () => {
		await surface?.close();
		surface = undefined;
	});

	it("binds only to 127.0.0.1 and serves local assets with restrictive headers", async () => {
		const { client } = createFakeClient();
		surface = await startWebSurfaceServer(client);

		expect(surface.host).toBe(WEB_SURFACE_HOST);
		expect(surface.host).toBe("127.0.0.1");
		expect(surface.url).toBe(`http://127.0.0.1:${surface.port}/`);

		const [html, css, script] = await Promise.all([
			requestSurface(surface, "/"),
			requestSurface(surface, "/app.css"),
			requestSurface(surface, "/app.js"),
		]);
		expect(html.statusCode).toBe(200);
		expect(css.statusCode).toBe(200);
		expect(script.statusCode).toBe(200);
		expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
		expect(html.body).toContain("AOS Agent Web Surface");
		expect(html.body).toContain('src="/app.js"');
		expect(html.body).toContain("Pending gates");
		expect(script.body).toContain('window.confirm(confirmation)');
		expect(script.body).toContain('callApi("/api/ops"');
		for (const method of ["task.gate.approve", "task.gate.reject", "run.cancel", "run.resume"]) {
			expect(script.body).toContain(`"${method}"`);
		}
		expect(`${html.body}\n${css.body}\n${script.body}`).not.toMatch(/https?:\/\/|(?:src|href)=["']\/\//u);
	});

	it("forwards only the five allowlisted read methods", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		const run = await postRpc(surface, "run.get", { runId: "run-1" });
		const audit = await postRpc(surface, "audit.query", { scope: "current-session", limit: 25 });
		const gates = await postRpc(surface, "task.gate.list", { status: "pending", limit: 10 });
		const graph = await postRpc(surface, "task.graph.get", { taskId: "task-1", graphRevision: 1 });
		const graphs = await postRpc(surface, "task.graph.list", { status: "active", limit: 10 });

		expect([run.statusCode, audit.statusCode, gates.statusCode, graph.statusCode, graphs.statusCode]).toEqual([
			200,
			200,
			200,
			200,
			200,
		]);
		expect(fake.getRun).toHaveBeenCalledWith("run-1");
		expect(fake.auditQuery).toHaveBeenCalledWith({ scope: "current-session", limit: 25 });
		expect(fake.listTaskGates).toHaveBeenCalledWith({ status: "pending", limit: 10 });
		expect(fake.getTaskGraph).toHaveBeenCalledWith("task-1", 1);
		expect(fake.listTaskGraphs).toHaveBeenCalledWith({ status: "active", limit: 10 });
	});

	it("constructs exactly the four allowlisted write commands", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		const approve = await postOperation(surface, "task.gate.approve", {
			gateId: "gate-1",
			clientRequestId: "approve-1",
			confirmed: true,
		});
		const reject = await postOperation(surface, "task.gate.reject", {
			gateId: "gate-2",
			clientRequestId: "reject-1",
			confirmed: true,
		});
		const cancel = await postOperation(surface, "run.cancel", { runId: "run-1", confirmed: true });
		const resume = await postOperation(surface, "run.resume", {
			sessionPath: "sessions/session-1.jsonl",
			sourceRunId: "run-1",
			message: "continue after review",
			clientRequestId: "resume-1",
			confirmed: true,
		});

		expect([approve.statusCode, reject.statusCode, cancel.statusCode, resume.statusCode]).toEqual([
			200,
			200,
			200,
			200,
		]);
		expect(fake.approveTaskGate).toHaveBeenCalledWith("gate-1", "approve-1", "web-operator");
		expect(fake.rejectTaskGate).toHaveBeenCalledWith(
			"gate-2",
			"reject-1",
			"web-operator",
			"operator_rejected",
		);
		expect(fake.cancelRun).toHaveBeenCalledWith("run-1");
		expect(fake.resumeRun).toHaveBeenCalledWith(
			"sessions/session-1.jsonl",
			"run-1",
			"continue after review",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"resume-1",
		);
	});

	it("rejects every unlisted write method before reaching RpcClient", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		for (const method of ["run.start", "task.gate.cancel", "task.graph.create", "task.graph.node.settle"]) {
			const result = await postOperation(surface, method, { confirmed: true });
			expect(result.statusCode).toBe(403);
			expect(JSON.parse(result.body)).toEqual({
				error: {
					code: "method_not_allowed",
					message: "RPC method is not available on the web operations surface.",
				},
			});
		}
		expect((await postRpc(surface, "run.cancel", { runId: "run-1", confirmed: true })).statusCode).toBe(403);

		expect(fake.approveTaskGate).not.toHaveBeenCalled();
		expect(fake.rejectTaskGate).not.toHaveBeenCalled();
		expect(fake.cancelRun).not.toHaveBeenCalled();
		expect(fake.resumeRun).not.toHaveBeenCalled();
	});

	it("requires explicit confirmation and exact write parameters", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		expect((await postOperation(surface, "run.cancel", { runId: "run-1" })).statusCode).toBe(400);
		expect(
			(await postOperation(surface, "run.cancel", { runId: "run-1", confirmed: true, extra: "blocked" })).statusCode,
		).toBe(400);
		expect(fake.cancelRun).not.toHaveBeenCalled();
	});

	it("maps Host errors to readable messages without exposing internal details", async () => {
		const fake = createFakeClient();
		fake.rejectTaskGate.mockRejectedValueOnce(
			new AutomationRpcError({
				code: "task_gate_not_pending",
				message: "internal path C:/secret/session.jsonl",
				retryable: false,
			}),
		);
		surface = await startWebSurfaceServer(fake.client);

		const result = await postOperation(surface, "task.gate.reject", {
			gateId: "gate-1",
			clientRequestId: "reject-1",
			confirmed: true,
		});
		expect(result.statusCode).toBe(409);
		expect(JSON.parse(result.body)).toEqual({
			error: {
				code: "gate_already_decided",
				message: "This gate was already decided or changed. Refresh and try again.",
			},
		});
		expect(result.body).not.toContain("C:/secret");
	});

	it("rejects malformed read requests and non-POST API access", async () => {
		const { client } = createFakeClient();
		surface = await startWebSurfaceServer(client);

		expect((await postRpc(surface, "run.get", {})).statusCode).toBe(400);
		expect((await postRpc(surface, "audit.query", { scope: "global" })).statusCode).toBe(400);
		expect((await requestSurface(surface, "/api/rpc")).statusCode).toBe(405);
		expect((await requestSurface(surface, "/api/ops")).statusCode).toBe(405);
		expect((await requestSurface(surface, "/missing")).statusCode).toBe(404);
	});
});

function createFakeClient(): {
	readonly client: WebReadOnlyRpcClient & WebOperationRpcClient;
	readonly getRun: ReturnType<typeof vi.fn>;
	readonly auditQuery: ReturnType<typeof vi.fn>;
	readonly listTaskGates: ReturnType<typeof vi.fn>;
	readonly approveTaskGate: ReturnType<typeof vi.fn>;
	readonly rejectTaskGate: ReturnType<typeof vi.fn>;
	readonly cancelRun: ReturnType<typeof vi.fn>;
	readonly resumeRun: ReturnType<typeof vi.fn>;
	readonly getTaskGraph: ReturnType<typeof vi.fn>;
	readonly listTaskGraphs: ReturnType<typeof vi.fn>;
} {
	const getRun = vi.fn(async (): Promise<RunGetData> => RUN);
	const auditQuery = vi.fn(async (): Promise<AuditQueryResult> => AUDIT);
	const listTaskGates = vi.fn(async (): Promise<TaskGateListData> => ({ gates: [PENDING_GATE], truncated: false }));
	const approveTaskGate = vi.fn(
		async (): Promise<TaskGateMutationData> => ({ gate: { ...PENDING_GATE, status: "approved", revision: 1 }, idempotent: false }),
	);
	const rejectTaskGate = vi.fn(
		async (): Promise<TaskGateMutationData> => ({ gate: { ...PENDING_GATE, status: "rejected", revision: 1 }, idempotent: false }),
	);
	const cancelRun = vi.fn(async () => ({ runId: "run-1", status: "running" as const }));
	const resumeRun = vi.fn(async () => ({ runId: "run-2", sessionId: "session-1", attempt: 2, status: "accepted" as const }));
	const getTaskGraph = vi.fn(async (): Promise<TaskGraphGetData> => ({ graph: GRAPH }));
	const listTaskGraphs = vi.fn(async (): Promise<TaskGraphListData> => ({ graphs: [GRAPH], truncated: false }));
	return {
		client: {
			getRun,
			auditQuery,
			listTaskGates,
			approveTaskGate,
			rejectTaskGate,
			cancelRun,
			resumeRun,
			getTaskGraph,
			listTaskGraphs,
		},
		getRun,
		auditQuery,
		listTaskGates,
		approveTaskGate,
		rejectTaskGate,
		cancelRun,
		resumeRun,
		getTaskGraph,
		listTaskGraphs,
	};
}

function postRpc(surface: WebSurfaceServer, method: string, params: unknown): Promise<HttpResult> {
	return requestSurface(surface, "/api/rpc", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ method, params }),
	});
}

function postOperation(surface: WebSurfaceServer, method: string, params: unknown): Promise<HttpResult> {
	return requestSurface(surface, "/api/ops", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ method, params }),
	});
}

function requestSurface(
	surface: WebSurfaceServer,
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{ host: surface.host, port: surface.port, path, method: options.method ?? "GET", headers: options.headers },
			(response) => {
				response.setEncoding("utf8");
				let body = "";
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.on("end", () => {
					resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body });
				});
			},
		);
		outgoing.once("error", reject);
		outgoing.end(options.body);
	});
}
