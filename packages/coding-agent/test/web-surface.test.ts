import { request } from "node:http";
import { fingerprintFoundationValue } from "@aos-agent/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AuditQueryResult,
	RunGetData,
	SubagentListData,
	TaskGraphGetData,
	TaskGraphListData,
	WorkerListData,
} from "../src/modes/rpc/rpc-types.ts";
import type { WebReadOnlyRpcClient } from "../src/modes/web/read-only-rpc.ts";
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

const GRAPH = {
	schemaVersion: 1 as const,
	sessionId: "session-1",
	taskId: "task-1",
	graphRevision: 1,
	createdAt: "2026-09-01T00:00:00.000Z",
	nodes: [
		{
			schemaVersion: 1 as const,
			nodeId: "root",
			dependsOn: [],
			status: "succeeded" as const,
			nodeRevision: 2,
			runRef: { sessionId: "session-1", runId: "run-1" },
			availability: null,
			blockingNodeIds: [],
		},
		{
			schemaVersion: 1 as const,
			nodeId: "child",
			dependsOn: ["root"],
			status: "pending" as const,
			nodeRevision: 0,
			availability: "ready" as const,
			blockingNodeIds: [],
		},
	],
	summary: { status: "active" as const, pending: 1, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
};

const WORKERS: WorkerListData = {
	workers: [
		{
			schemaVersion: 1,
			workerId: "worker-1",
			providerId: "worker-provider",
			sessionId: "session-1",
			laneId: "lane-1",
			runId: "run-1",
			attemptId: "attempt-1",
			profileId: "profile-1",
			status: "running",
			revision: 3,
			createdAt: "2026-09-01T00:00:00.000Z",
		},
	],
	truncated: false,
};

const SUBAGENTS: SubagentListData = {
	subagents: [
		{
			schemaVersion: 1,
			source: "subagent.lifecycle",
			sessionId: "session-1",
			runId: "run-1",
			childAgentInstanceId: "child-agent-1",
			parentAgentInstanceId: "parent-agent-1",
			taskId: "task-1",
			status: "running",
			providerKind: "in_process",
			safeSummary: "Inspect task graph",
			correlation: { attemptId: "attempt-1", spawnId: "spawn-1" },
			digest: fingerprintFoundationValue("web-surface-child-agent"),
		},
	],
	truncated: false,
};

describe("read-only web surface", () => {
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
		expect(html.body).toContain("Task graph board");
		expect(html.body).toContain('src="/app.js"');
		expect(script.body).toContain("createElementNS(SVG_NS");
		expect(script.body).toContain("Parent / Child tree");
		const resources = `${html.body}\n${css.body}\n${script.body}`.replace("http://www.w3.org/2000/svg", "");
		expect(resources).not.toMatch(/https?:\/\/|(?:src|href)=["']\/\//u);
	});

	it("forwards only the six allowlisted read methods", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		const run = await postRpc(surface, "run.get", { runId: "run-1" });
		const audit = await postRpc(surface, "audit.query", { scope: "current-session", limit: 25 });
		const graph = await postRpc(surface, "task.graph.get", { taskId: "task-1", graphRevision: 1 });
		const graphs = await postRpc(surface, "task.graph.list", { status: "active", limit: 10 });
		const workers = await postRpc(surface, "worker.list", { runId: "run-1", status: "running", limit: 10 });
		const subagents = await postRpc(surface, "subagent.list", {
			runId: "run-1",
			parentAgentInstanceId: "parent-agent-1",
			status: "running",
			limit: 10,
		});

		expect([run.statusCode, audit.statusCode, graph.statusCode, graphs.statusCode, workers.statusCode, subagents.statusCode]).toEqual([
			200,
			200,
			200,
			200,
			200,
			200,
		]);
		expect(fake.getRun).toHaveBeenCalledWith("run-1");
		expect(fake.auditQuery).toHaveBeenCalledWith({ scope: "current-session", limit: 25 });
		expect(fake.getTaskGraph).toHaveBeenCalledWith("task-1", 1);
		expect(fake.listTaskGraphs).toHaveBeenCalledWith({ status: "active", limit: 10 });
		expect(fake.listWorkers).toHaveBeenCalledWith({ runId: "run-1", status: "running", limit: 10 });
		expect(fake.listSubagents).toHaveBeenCalledWith("run-1", {
			parentAgentInstanceId: "parent-agent-1",
			status: "running",
			limit: 10,
		});
	});

	it("assembles graph, Run, Attempt, Worker, and Child projections for the board", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		const result = await requestSurface(surface, "/api/task-graph-board");

		expect(result.statusCode).toBe(200);
		expect(JSON.parse(result.body)).toEqual({
			data: {
				graphs: [GRAPH],
				runs: [RUN],
				workers: WORKERS.workers,
				subagents: SUBAGENTS.subagents,
				warnings: [],
			},
		});
		expect(fake.listTaskGraphs).toHaveBeenCalledWith({ limit: 100 });
		expect(fake.getRun).toHaveBeenCalledWith("run-1");
		expect(fake.listWorkers).toHaveBeenCalledWith({ limit: 100 });
		expect(fake.listSubagents).toHaveBeenCalledWith("run-1", { limit: 100 });
	});

	it("rejects write methods before reaching RpcClient", async () => {
		const fake = createFakeClient();
		surface = await startWebSurfaceServer(fake.client);

		for (const method of [
			"run.start",
			"run.cancel",
			"task.graph.create",
			"task.graph.node.settle",
			"worker.reclaim",
			"subagent.cancel",
		]) {
			const result = await postRpc(surface, method, { runId: "run-1" });
			expect(result.statusCode).toBe(403);
			expect(JSON.parse(result.body)).toEqual({
				error: {
					code: "method_not_allowed",
					message: "RPC method is not available on the read-only web surface.",
				},
			});
		}

		expect(fake.getRun).not.toHaveBeenCalled();
		expect(fake.auditQuery).not.toHaveBeenCalled();
		expect(fake.getTaskGraph).not.toHaveBeenCalled();
		expect(fake.listTaskGraphs).not.toHaveBeenCalled();
		expect(fake.listWorkers).not.toHaveBeenCalled();
		expect(fake.listSubagents).not.toHaveBeenCalled();
	});

	it("rejects malformed read requests and non-POST API access", async () => {
		const { client } = createFakeClient();
		surface = await startWebSurfaceServer(client);

		expect((await postRpc(surface, "run.get", {})).statusCode).toBe(400);
		expect((await postRpc(surface, "audit.query", { scope: "global" })).statusCode).toBe(400);
		expect((await postRpc(surface, "worker.list", { status: "unknown" })).statusCode).toBe(400);
		expect((await postRpc(surface, "subagent.list", { limit: 10 })).statusCode).toBe(400);
		expect((await requestSurface(surface, "/api/rpc")).statusCode).toBe(405);
		expect((await requestSurface(surface, "/missing")).statusCode).toBe(404);
	});
});

function createFakeClient(): {
	readonly client: WebReadOnlyRpcClient;
	readonly getRun: ReturnType<typeof vi.fn>;
	readonly auditQuery: ReturnType<typeof vi.fn>;
	readonly getTaskGraph: ReturnType<typeof vi.fn>;
	readonly listTaskGraphs: ReturnType<typeof vi.fn>;
	readonly listWorkers: ReturnType<typeof vi.fn>;
	readonly listSubagents: ReturnType<typeof vi.fn>;
} {
	const getRun = vi.fn(async (): Promise<RunGetData> => RUN);
	const auditQuery = vi.fn(async (): Promise<AuditQueryResult> => AUDIT);
	const getTaskGraph = vi.fn(async (): Promise<TaskGraphGetData> => ({ graph: GRAPH }));
	const listTaskGraphs = vi.fn(async (): Promise<TaskGraphListData> => ({ graphs: [GRAPH], truncated: false }));
	const listWorkers = vi.fn(async (): Promise<WorkerListData> => WORKERS);
	const listSubagents = vi.fn(async (): Promise<SubagentListData> => SUBAGENTS);
	return {
		client: { getRun, auditQuery, getTaskGraph, listTaskGraphs, listWorkers, listSubagents },
		getRun,
		auditQuery,
		getTaskGraph,
		listTaskGraphs,
		listWorkers,
		listSubagents,
	};
}

function postRpc(surface: WebSurfaceServer, method: string, params: unknown): Promise<HttpResult> {
	return requestSurface(surface, "/api/rpc", {
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
