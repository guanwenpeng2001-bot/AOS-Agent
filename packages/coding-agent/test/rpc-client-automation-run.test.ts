import { describe, expect, it, vi } from "vitest";
import type { ImageContent } from "@aos-agent/ai";
import { AutomationRpcError, RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcRunStreamEvent } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
	handleLine: (line: string) => void;
};

function createClient(): { client: RpcClient; privateClient: RpcClientPrivate } {
	const client = new RpcClient();
	const privateClient = client as unknown as RpcClientPrivate;
	return { client, privateClient };
}

const IMAGE: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

const acceptedResponse = {
	type: "response",
	command: "run.start",
	success: true,
	data: { runId: "r1", sessionId: "s1", attempt: 1, status: "accepted" },
};

describe("RpcClient Automation Host request shapes", () => {
	it("initializeAutomationHost sends initialize with protocolVersion 1", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "initialize",
			success: true,
			data: {
				host: "automation-host",
				protocolVersion: 1,
				sessionId: "s1",
				runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
			},
		}));
		privateClient.send = send;

		const data = await client.initializeAutomationHost();

		expect(send).toHaveBeenCalledWith({ type: "initialize", protocolVersion: 1 });
		expect(data).toEqual({
			host: "automation-host",
			protocolVersion: 1,
			sessionId: "s1",
			runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
		});
	});

	it("startRun sends run.start with message and optional images", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;

		const result = await client.startRun("do the thing");

		expect(send).toHaveBeenCalledWith({ type: "run.start", message: "do the thing", images: undefined });
		expect(result).toEqual({ runId: "r1", sessionId: "s1", attempt: 1, status: "accepted" });

		await client.startRun("with image", [IMAGE]);
		expect(send).toHaveBeenLastCalledWith({ type: "run.start", message: "with image", images: [IMAGE] });
	});

	it("getRun sends run.get with the run id", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "run.get",
			success: true,
			data: {
				run: { id: "r1", sessionId: "s1", attempt: 1, status: "completed", model: { provider: "anthropic", id: "claude-sonnet-5", thinkingLevel: "high" } },
			},
		}));
		privateClient.send = send;

		const data = await client.getRun("r1");

		expect(send).toHaveBeenCalledWith({ type: "run.get", runId: "r1" });
		expect(data.run.id).toBe("r1");
		expect(data.run.status).toBe("completed");
	});

	it("cancelRun sends run.cancel and returns the immediate status without waiting for a terminal", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "run.cancel",
			success: true,
			data: { runId: "r1", status: "running" },
		}));
		privateClient.send = send;

		const result = await client.cancelRun("r1");

		expect(send).toHaveBeenCalledWith({ type: "run.cancel", runId: "r1" });
		// The immediate pre-terminal status is returned as-is.
		expect(result).toEqual({ runId: "r1", status: "running" });
	});

	it("resumeRun sends run.resume with session, source run, message and images", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "run.resume",
			success: true,
			data: { runId: "r2", sessionId: "s2", attempt: 2, status: "accepted" },
		}));
		privateClient.send = send;

		const result = await client.resumeRun("/tmp/s.jsonl", "r1", "continue", [IMAGE]);

		expect(send).toHaveBeenCalledWith({
			type: "run.resume",
			sessionPath: "/tmp/s.jsonl",
			sourceRunId: "r1",
			message: "continue",
			images: [IMAGE],
		});
		expect(result).toEqual({ runId: "r2", sessionId: "s2", attempt: 2, status: "accepted" });
	});

	it("startRun forwards an optional capabilityProfile and omits it when absent", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;

		await client.startRun("with profile", undefined, "strict");
		expect(send).toHaveBeenLastCalledWith({
			type: "run.start",
			message: "with profile",
			images: undefined,
			capabilityProfile: "strict",
		});

		await client.startRun("plain");
		expect(send).toHaveBeenLastCalledWith({ type: "run.start", message: "plain", images: undefined });
	});

	it("resumeRun forwards an optional capabilityProfile", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "run.resume",
			success: true,
			data: { runId: "r2", sessionId: "s2", attempt: 2, status: "accepted" },
		}));
		privateClient.send = send;

		await client.resumeRun("/tmp/s.jsonl", "r1", "continue", [IMAGE], "strict");
		expect(send).toHaveBeenCalledWith({
			type: "run.resume",
			sessionPath: "/tmp/s.jsonl",
			sourceRunId: "r1",
			message: "continue",
			images: [IMAGE],
			capabilityProfile: "strict",
		});
	});

	it("startRun and resumeRun forward mutually-exclusive model selections", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;

		await client.startRun("route", undefined, undefined, "balanced");
		expect(send).toHaveBeenLastCalledWith({
			type: "run.start",
			message: "route",
			images: undefined,
			modelRoute: "balanced",
		});

		await client.resumeRun("/tmp/s.jsonl", "r1", "role", undefined, undefined, undefined, "worker");
		expect(send).toHaveBeenLastCalledWith({
			type: "run.resume",
			sessionPath: "/tmp/s.jsonl",
			sourceRunId: "r1",
			message: "role",
			images: undefined,
			modelRole: "worker",
		});
	});

	it("startRun and resumeRun forward optional policyProfile without changing model argument positions", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;

		await client.startRun("policy", undefined, "cap", "balanced", undefined, "workspace-safe");
		expect(send).toHaveBeenLastCalledWith({
			type: "run.start",
			message: "policy",
			images: undefined,
			capabilityProfile: "cap",
			modelRoute: "balanced",
			policyProfile: "workspace-safe",
		});

		await client.resumeRun("/tmp/s.jsonl", "r1", "policy", undefined, undefined, undefined, "worker", "strict");
		expect(send).toHaveBeenLastCalledWith({
			type: "run.resume",
			sessionPath: "/tmp/s.jsonl",
			sourceRunId: "r1",
			message: "policy",
			images: undefined,
			modelRole: "worker",
			policyProfile: "strict",
		});
	});

	it("startRun and resumeRun forward optional external references", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;
		const external = { namespace: "ci", externalSessionId: "job-1", externalRunId: "attempt-1" };

		await client.startRun("external", undefined, undefined, undefined, undefined, undefined, external);
		expect(send).toHaveBeenLastCalledWith({
			type: "run.start",
			message: "external",
			images: undefined,
			external,
		});

		await client.resumeRun(
			"/tmp/s.jsonl",
			"r1",
			"external resume",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			external,
		);
		expect(send).toHaveBeenLastCalledWith({
			type: "run.resume",
			sessionPath: "/tmp/s.jsonl",
			sourceRunId: "r1",
			message: "external resume",
			images: undefined,
			external,
		});
	});

	it("sends audit query, replay, and external mapping commands with explicit payloads", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data:
				command.type === "audit.query"
					? { schemaVersion: 1, scope: "current-session", events: [], warnings: [] }
					: command.type === "audit.replay"
						? {
								schemaVersion: 1,
								run: {
									status: "interrupted",
									attempt: 1,
									model: { provider: "p", id: "m", thinkingLevel: "low" },
								},
								events: [],
								status: "interrupted",
								warnings: [],
							}
						: {
								mapping: { namespace: "ci", externalSessionId: "job-1", aosSessionId: "s1", createdAt: "t" },
								appended: true,
								idempotent: false,
							},
		}));
		privateClient.send = send;

		await expect(
			client.auditQuery({ scope: "current-session", types: ["run.completed"], limit: 10 }),
		).resolves.toMatchObject({
			schemaVersion: 1,
		});
		expect(send).toHaveBeenLastCalledWith({
			type: "audit.query",
			scope: "current-session",
			types: ["run.completed"],
			limit: 10,
		});

		await client.auditReplay("r1", { scope: "current-session", limit: 5 });
		expect(send).toHaveBeenLastCalledWith({ type: "audit.replay", runId: "r1", scope: "current-session", limit: 5 });

		const request = {
			external: { namespace: "ci", externalSessionId: "job-1" },
			aosSessionId: "s1",
			aosRunId: "r1",
		};
		await client.externalMap(request);
		expect(send).toHaveBeenLastCalledWith({ type: "external.map", ...request });
	});
});

describe("RpcClient Automation Host structured failures", () => {
	it("throws AutomationRpcError retaining code, message and retryable (session_busy)", async () => {
		const { client, privateClient } = createClient();
		privateClient.send = vi.fn(async () => ({
			type: "response",
			command: "run.start",
			success: false,
			error: { code: "session_busy", message: "A run is already active", retryable: true },
		}));

		const promise = client.startRun("nope");

		await expect(promise).rejects.toBeInstanceOf(AutomationRpcError);
		await expect(promise).rejects.toBeInstanceOf(Error);
		await expect(promise).rejects.toMatchObject({
			code: "session_busy",
			message: "A run is already active",
			retryable: true,
		});
	});

	it("throws AutomationRpcError for host_not_initialized on command-level commands", async () => {
		const { client, privateClient } = createClient();
		privateClient.send = vi.fn(async () => ({
			type: "response",
			command: "run.get",
			success: false,
			error: { code: "host_not_initialized", message: "Automation Host is not initialized", retryable: false },
		}));

		const promise = client.getRun("r1");

		await expect(promise).rejects.toBeInstanceOf(AutomationRpcError);
		await expect(promise).rejects.toMatchObject({
			code: "host_not_initialized",
			message: "Automation Host is not initialized",
			retryable: false,
		});
	});

	it("normalizes a legacy string error to a plain Error", async () => {
		const { client, privateClient } = createClient();
		privateClient.send = vi.fn(async () => ({
			type: "response",
			command: "initialize",
			success: false,
			error: "legacy string failure",
		}));

		const promise = client.initializeAutomationHost();

		await expect(promise).rejects.toThrow("legacy string failure");
		await expect(promise).rejects.not.toBeInstanceOf(AutomationRpcError);
	});
});

describe("RpcClient capability inspection", () => {
	it("getCapabilities sends get_capabilities without a binding id", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: { binding: null, bindings: [] },
		}));
		privateClient.send = send;

		const data = await client.getCapabilities();

		expect(send).toHaveBeenCalledWith({ type: "get_capabilities" });
		expect(data).toEqual({ binding: null, bindings: [] });
	});

	it("getCapabilities sends get_capabilities with a binding id and parses the view", async () => {
		const { client, privateClient } = createClient();
		const view = {
			id: "binding:default:abc123",
			profile: "default",
			createdAt: "t",
			descriptors: [{ id: "builtin_tool:core:read", revision: "rev:1", exposedToolName: "Read" }],
			decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
			toolAllowlist: ["Read"],
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: { binding: view, bindings: [] },
		}));
		privateClient.send = send;

		const data = await client.getCapabilities("binding:default:abc123");

		expect(send).toHaveBeenCalledWith({ type: "get_capabilities", bindingId: "binding:default:abc123" });
		expect(data.binding?.id).toBe("binding:default:abc123");
		expect(data.binding?.toolAllowlist).toEqual(["Read"]);
	});

	it("getCapabilities rejects with a plain Error for a string failure", async () => {
		const { client, privateClient } = createClient();
		privateClient.send = vi.fn(async () => ({
			type: "response",
			command: "get_capabilities",
			success: false,
			error: "Capability binding not found: binding:ghost",
		}));

		const promise = client.getCapabilities("binding:ghost");

		await expect(promise).rejects.toThrow("Capability binding not found: binding:ghost");
		await expect(promise).rejects.not.toBeInstanceOf(AutomationRpcError);
	});
});

describe("RpcClient execution policy inspection", () => {
	it("getExecutionPolicy sends get_execution_policy and returns safe metadata", async () => {
		const { client, privateClient } = createClient();
		const data = {
			summary: {
				bindingId: "policy-binding:abc",
				profileId: "legacy",
				profileRevision: "rev",
				projectTrust: "trusted",
				enforcement: "legacy",
				sandboxStatus: "not_required",
				sandboxCapabilities: { filesystem: false, process: false, network: false, credentialIsolation: false },
			},
			pendingApprovals: [],
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_execution_policy",
			success: true,
			data,
		}));
		privateClient.send = send;

		await expect(client.getExecutionPolicy()).resolves.toEqual(data);
		expect(send).toHaveBeenCalledWith({ type: "get_execution_policy" });
	});

	it("approvePolicy and rejectPolicy send session-scoped policy commands", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async (command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
		}));
		privateClient.send = send;

		await client.approvePolicy("policy-request:1");
		await client.rejectPolicy("policy-request:2");

		expect(send).toHaveBeenNthCalledWith(1, { type: "policy.approve", requestId: "policy-request:1" });
		expect(send).toHaveBeenNthCalledWith(2, { type: "policy.reject", requestId: "policy-request:2" });
	});
});

describe("RpcClient model route inspection", () => {
	it("getModelRoutes sends the read-only query and returns the safe catalog", async () => {
		const { client, privateClient } = createClient();
		const catalog = { schemaVersion: 1, models: [], routes: [], roles: [], bindings: [] };
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_model_routes",
			success: true,
			data: catalog,
		}));
		privateClient.send = send;

		const data = await client.getModelRoutes();

		expect(send).toHaveBeenCalledWith({ type: "get_model_routes" });
		expect(data).toEqual(catalog);
	});
});

describe("RpcClient Automation Host event routing", () => {
	it("routes run.* records to onRunEvent and legacy session events to onEvent", () => {
		const { client, privateClient } = createClient();
		const runEvents: RpcRunStreamEvent[] = [];
		const sessionEvents: unknown[] = [];

		client.onRunEvent((event) => {
			runEvents.push(event);
		});
		client.onEvent((event) => {
			sessionEvents.push(event);
		});

		privateClient.handleLine(
			JSON.stringify({ type: "run.started", runId: "r1", sessionId: "s1", sequence: 1, timestamp: "t1" }),
		);
		privateClient.handleLine(
			JSON.stringify({
				type: "run.event",
				runId: "r1",
				sessionId: "s1",
				sequence: 2,
				timestamp: "t2",
				event: { type: "message_start", message: { role: "assistant", content: [] } },
			}),
		);
		privateClient.handleLine(
			JSON.stringify({
				type: "run.completed",
				runId: "r1",
				sessionId: "s1",
				sequence: 3,
				timestamp: "t3",
				receipt: { runId: "r1", sessionId: "s1", status: "completed", usage: { input: 1, output: 2, total: 3 } },
			}),
		);
		privateClient.handleLine(JSON.stringify({ type: "agent_settled" }));
		privateClient.handleLine(
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "hi" } }),
		);

		expect(runEvents.map((event) => event.type)).toEqual(["run.started", "run.event", "run.completed"]);
		// run.event wraps a JSON-safe session event.
		const runEvent = runEvents.find(
			(event): event is Extract<RpcRunStreamEvent, { type: "run.event" }> => event.type === "run.event",
		);
		expect(runEvent?.event.type).toBe("message_start");
		// Terminal records carry a receipt.
		const completed = runEvents.find(
			(event): event is Extract<RpcRunStreamEvent, { type: "run.completed" }> => event.type === "run.completed",
		);
		expect(completed?.receipt.status).toBe("completed");

		// onEvent sees only legacy session events, never run.* records.
		expect(sessionEvents.map((event) => (event as { type: string }).type)).toEqual(["agent_settled", "message_update"]);
	});

	it("routes run.failed and run.cancelled terminal records to onRunEvent", () => {
		const { client, privateClient } = createClient();
		const runEvents: RpcRunStreamEvent[] = [];
		const sessionEvents: unknown[] = [];

		client.onRunEvent((event) => {
			runEvents.push(event);
		});
		client.onEvent((event) => {
			sessionEvents.push(event);
		});

		privateClient.handleLine(
			JSON.stringify({
				type: "run.failed",
				runId: "r1",
				sessionId: "s1",
				sequence: 1,
				timestamp: "t",
				receipt: {
					runId: "r1",
					sessionId: "s1",
					status: "failed",
					usage: { input: 0, output: 0, total: 0 },
					terminalError: { code: "model_error", message: "Provider request failed", retryable: false },
				},
			}),
		);
		privateClient.handleLine(
			JSON.stringify({
				type: "run.cancelled",
				runId: "r2",
				sessionId: "s1",
				sequence: 1,
				timestamp: "t",
				receipt: { runId: "r2", sessionId: "s1", status: "cancelled", usage: { input: 0, output: 0, total: 0 } },
			}),
		);

		expect(runEvents.map((event) => event.type)).toEqual(["run.failed", "run.cancelled"]);
		expect(sessionEvents).toEqual([]);
		// A terminal run.failed receipt retains model_error as its structured error.
		const failed = runEvents.find(
			(event): event is Extract<RpcRunStreamEvent, { type: "run.failed" }> => event.type === "run.failed",
		);
		expect(failed?.receipt.terminalError).toEqual({
			code: "model_error",
			message: "Provider request failed",
			retryable: false,
		});
	});

	it("onRunEvent unsubscribe stops delivery", () => {
		const { client, privateClient } = createClient();
		const runEvents: RpcRunStreamEvent[] = [];

		const unsubscribe = client.onRunEvent((event) => {
			runEvents.push(event);
		});
		unsubscribe();

		privateClient.handleLine(
			JSON.stringify({ type: "run.started", runId: "r1", sessionId: "s1", sequence: 1, timestamp: "t" }),
		);

		expect(runEvents).toEqual([]);
	});
});
