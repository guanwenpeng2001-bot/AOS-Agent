import { readFile } from "node:fs/promises";
import {
	createConnectorCapabilitySnapshot,
	resolveMcpSelection,
	validateAttemptReceipt,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type McpSelection,
	type ToolExecutionResult,
	type ToolGatewayRoute,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import * as packageEntry from "../../src/index.ts";
import { PROVIDER_CLASS } from "../../src/core/connector/provider-class.ts";
import type { CanonicalExternalConnectorMapping } from "../../src/core/connector/session-mapping.ts";
import {
	PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	PrivateClaudeAgentSdkDriver,
	type PrivateClaudeAgentSdkCompanion,
	type PrivateClaudeCompanionQuery,
	type PrivateClaudeCompanionQueryRequest,
} from "../../src/core/connector/vendor/claude.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverSpawnRequest,
} from "../../src/core/connector/vendor/types.ts";

const now = "2026-08-28T00:00:00.000Z";
const providerId = "private-claude-fixture";
const sessionId = "claude-session-1";
const selectedToolName = "mcp__docs__read";

const attempt: Attempt = {
	schemaVersion: 1,
	attemptId: "attempt-claude-1",
	dispatchId: "dispatch-claude-1",
	taskId: "task-claude-1",
	providerId,
	bindingId: "binding-claude-1",
	bindingEpochIds: ["binding-epoch-claude-1"],
	status: "starting",
	startedAt: now,
};

const correlation: ExecutionCorrelation = {
	sessionId: "host-session-claude-1",
	laneId: "main",
	revision: 1,
	runId: "run-claude-1",
	operationId: "run-claude-1",
	taskId: attempt.taskId,
	dispatchId: attempt.dispatchId,
	attemptId: attempt.attemptId,
	bindingId: attempt.bindingId,
	bindingEpochId: attempt.bindingEpochIds[0],
	providerId,
};

const capability: ConnectorCapabilitySnapshot = createConnectorCapabilitySnapshot({
	schemaVersion: 1,
	providerId,
	revision: 1,
	protocol: { name: "claude-agent-sdk", version: PRIVATE_CLAUDE_AGENT_SDK_VERSION },
	modelAccess: "agent_owned",
	resume: false,
	toolGateway: true,
	artifacts: false,
	images: false,
});

const toolGatewayRoute: ToolGatewayRoute = {
	kind: "mcp",
	namespace: "docs",
	toolName: "read",
	providerId: "mcp-provider",
	revision: 1,
	operation: { resource: "filesystem.read", effects: ["read"] },
};

const resolvedMcpSelection = resolveMcpSelection({
	selector: { policy: "named", named: ["docs"] },
	capabilityBinding: {
		id: "capability-binding-claude",
		descriptors: [
			{ id: "descriptor-docs", revision: "1", kind: "mcp_server", name: "docs", mcpServerId: "docs" },
			{
				id: "descriptor-docs-read",
				revision: "1",
				kind: "mcp_tool",
				name: "read",
				exposedToolName: selectedToolName,
				parentId: "descriptor-docs",
				mcpServerId: "docs",
			},
		],
		toolAllowlist: [selectedToolName],
	},
	routeCatalog: [toolGatewayRoute],
});
if (!resolvedMcpSelection.ok) throw resolvedMcpSelection.error;
const mcpSelection: McpSelection = resolvedMcpSelection.value;

const usage = {
	inputTokens: 1,
	outputTokens: 1,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	webSearchRequests: 0,
	costUSD: 0,
	contextWindow: 200_000,
	maxOutputTokens: 8_192,
	canonicalModel: "claude-fixture",
	provider: "firstParty",
	costBasis: "list",
};

function init(tools: readonly string[] = [selectedToolName], servers: readonly string[] = ["docs"]) {
	return {
		type: "system",
		subtype: "init",
		session_id: sessionId,
		tools: [...tools],
		mcp_servers: servers.map((name) => ({ name, status: "connected" })),
	};
}

function result(
	subtype: "success" | "error_during_execution" = "success",
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "result",
		subtype,
		is_error: subtype !== "success",
		session_id: sessionId,
		total_cost_usd: 0,
		usage: { input_tokens: 1, output_tokens: 1 },
		modelUsage: { fixture: usage },
		...overrides,
	};
}

class FakeQuery implements PrivateClaudeCompanionQuery {
	readonly #messages: AsyncIterable<unknown>;
	closed = false;

	constructor(messages: AsyncIterable<unknown>) {
		this.#messages = messages;
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return this.#messages[Symbol.asyncIterator]();
	}

	close(): void {
		this.closed = true;
	}
}

class FakeCompanion implements PrivateClaudeAgentSdkCompanion {
	readonly sdkVersion = PRIVATE_CLAUDE_AGENT_SDK_VERSION;
	readonly requests: PrivateClaudeCompanionQueryRequest[] = [];
	readonly queries: FakeQuery[] = [];
	readonly #run: (request: PrivateClaudeCompanionQueryRequest) => AsyncIterable<unknown>;

	constructor(run: (request: PrivateClaudeCompanionQueryRequest) => AsyncIterable<unknown>) {
		this.#run = run;
	}

	query(request: PrivateClaudeCompanionQueryRequest): PrivateClaudeCompanionQuery {
		this.requests.push(request);
		const query = new FakeQuery(this.#run(request));
		this.queries.push(query);
		return query;
	}
}

function driver(
	companion: PrivateClaudeAgentSdkCompanion,
	overrides: Partial<ConstructorParameters<typeof PrivateClaudeAgentSdkDriver>[0]> = {},
): PrivateClaudeAgentSdkDriver {
	return new PrivateClaudeAgentSdkDriver({
		providerId,
		companion,
		cwd: process.cwd(),
		mcpSelection,
		now: () => now,
		...overrides,
	});
}

function spawnRequest(overrides: Partial<ExternalConnectorDriverSpawnRequest> = {}): ExternalConnectorDriverSpawnRequest {
	return {
		attempt,
		correlation,
		input: { schemaVersion: 1, text: "Perform the Claude fixture task", artifacts: [] },
		capability,
		bindingDigest: "c".repeat(64),
		bindingRevision: 1,
		mcpSelection,
		toolGatewayRoutes: [toolGatewayRoute],
		supervisorRef: "supervisor-claude-1",
		operationNonce: "nonce-claude-1",
		...overrides,
	};
}

function mapping(): CanonicalExternalConnectorMapping {
	return {
		schemaVersion: 1,
		providerId,
		attemptId: attempt.attemptId,
		externalSessionId: sessionId,
		externalTurnId: attempt.attemptId,
		binding: { digest: { algorithm: "sha256", value: "c".repeat(64) }, revision: 1 },
		capability: { digest: capability.digest, revision: capability.revision },
		supervisor: { ref: "supervisor-claude-1", nonce: "nonce-claude-1" },
		createdAt: now,
	};
}

async function nextEvent(iterator: AsyncIterator<FoundationJsonValue>): Promise<ExternalConnectorDriverEvent> {
	const next = await iterator.next();
	if (next.done) throw new Error("Claude event stream ended early");
	return next.value as unknown as ExternalConnectorDriverEvent;
}

async function nextToolEvent(
	iterator: AsyncIterator<FoundationJsonValue>,
): Promise<Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>> {
	for (;;) {
		const event = await nextEvent(iterator);
		if (event.type === "tool_gateway_request") return event;
	}
}

function gatewayResult(
	event: Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>,
	input: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
	return {
		schemaVersion: 1,
		toolCallId: event.request.toolCallId,
		toolName: event.request.toolName,
		ok: true,
		sideEffectState: "none",
		...input,
	};
}

async function settle(
	connector: PrivateClaudeAgentSdkDriver,
	handle: ExternalConnectorDriverHandle,
	event: Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>,
	input: Partial<ToolExecutionResult> = {},
): Promise<void> {
	await connector.write(handle, {
		schemaVersion: 1,
		kind: "tool_gateway_result",
		operationNonce: handle.operationNonce,
		result: gatewayResult(event, input),
	});
}

describe("private Claude Agent SDK connector driver", () => {
	it("runs one pinned query with exact MCP authority and never replays a prompt on connect", async () => {
		let permissionDecision: string | undefined;
		let toolResult: unknown;
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			permissionDecision = await request.requestPermission({
				requestId: "permission-1",
				toolUseId: "tool-use-1",
				toolName: selectedToolName,
				input: { path: "README.md" },
				signal: request.abortController.signal,
			});
			toolResult = await request.executeTool({
				toolUseId: "tool-use-1",
				toolName: selectedToolName,
				input: { path: "README.md" },
				signal: request.abortController.signal,
			});
			yield result("success", {
				total_cost_usd: 0.125,
				usage: {
					input_tokens: 3,
					output_tokens: 2,
					cache_read_input_tokens: 4,
					cache_creation_input_tokens: 5,
				},
			});
		});
		const connector = driver(companion);
		const handle = await connector.spawn(spawnRequest());
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect(await nextEvent(iterator)).toMatchObject({ type: "started", externalSessionId: sessionId });
		const permission = await nextToolEvent(iterator);
		expect(permission.request).toMatchObject({
			namespace: "claude",
			toolName: "claude.permission.request",
			originalArguments: { toolName: selectedToolName, input: { path: "README.md" } },
		});
		await settle(connector, handle, permission, { result: { behavior: "allow" } });
		const tool = await nextToolEvent(iterator);
		expect(tool.request).toMatchObject({ toolName: selectedToolName, originalArguments: { path: "README.md" } });
		await settle(connector, handle, tool, { result: { content: "fixture" } });
		const evidence = await connector.read(handle);
		expect(evidence).toMatchObject({
			status: "succeeded",
			sideEffectState: "none",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				cacheReadInputTokens: 4,
				cacheCreationInputTokens: 5,
				costUsd: 0.125,
			},
		});
		expect(validateAttemptReceipt({
			schemaVersion: 1,
			attemptReceiptId: `attempt_receipt_${attempt.attemptId}`,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: attempt.bindingEpochIds,
			status: evidence.status,
			workerReceiptRefs: [],
			artifacts: [],
			usage: evidence.usage,
			provenance: { producerKind: "external_connector", providerId, producedAt: now, correlation },
			sideEffectState: evidence.sideEffectState,
	}, { providerClass: PROVIDER_CLASS.externalConnector })).toMatchObject({ ok: true });
		expect(permissionDecision).toBe("allow");
		expect(toolResult).toEqual({ ok: true, sideEffectState: "none", result: { content: "fixture" } });
		expect(companion.requests[0]).toMatchObject({
			sdkVersion: "0.3.246",
			prompt: "Perform the Claude fixture task",
			tools: [{ exposedToolName: selectedToolName }],
		});
		await expect(connector.connect({ ...mapping(), attemptId: "attempt-claude-other" })).rejects.toMatchObject({
			code: "external_event_invalid",
		});
		expect(await connector.connect(mapping())).toEqual(handle);
		expect(companion.requests).toHaveLength(1);

		await connector.dispose();
		const resumedCompanion = new FakeCompanion(async function* () { yield init(); });
		const resumed = driver(resumedCompanion);
		await expect(resumed.connect(mapping())).rejects.toMatchObject({
			code: "external_resume_unsupported",
		});
		expect(resumedCompanion.requests).toHaveLength(0);
		await resumed.dispose();
	});

	it("rejects malformed or stale MCP selections and intersects exact Tool Gateway routes", async () => {
		const companion = new FakeCompanion(async function* (request) {
			yield init(request.tools.map((tool) => tool.exposedToolName), request.tools.map((tool) => tool.serverName));
			yield result();
		});
		expect(() => driver(companion, {
			mcpSelection: {
				...mcpSelection,
				digest: { algorithm: "sha256", value: "0".repeat(64) },
			},
		})).toThrow("Claude MCP selection is not canonical");

		const connector = driver(companion);
		const staleRoute: ToolGatewayRoute = { ...toolGatewayRoute, revision: 2 };
		const staleSelection = resolveMcpSelection({
			selector: { policy: "named", named: ["docs"] },
			capabilityBinding: {
				id: "capability-binding-claude",
				descriptors: [
					{ id: "descriptor-docs", revision: "1", kind: "mcp_server", name: "docs", mcpServerId: "docs" },
					{
						id: "descriptor-docs-read",
						revision: "1",
						kind: "mcp_tool",
						name: "read",
						exposedToolName: selectedToolName,
						parentId: "descriptor-docs",
						mcpServerId: "docs",
					},
				],
				toolAllowlist: [selectedToolName],
			},
			routeCatalog: [staleRoute],
		});
		if (!staleSelection.ok) throw staleSelection.error;
		await expect(connector.spawn(spawnRequest({
			mcpSelection: staleSelection.value,
			toolGatewayRoutes: [staleRoute],
		}))).rejects.toMatchObject({ code: "external_protocol_unsupported" });
		await expect(connector.spawn(spawnRequest({
			toolGatewayRoutes: [{ ...toolGatewayRoute, toolName: "write" }],
		}))).rejects.toMatchObject({ code: "external_protocol_unsupported" });

		const narrowed = await connector.spawn(spawnRequest({ toolGatewayRoutes: [] }));
		await expect(connector.read(narrowed)).resolves.toMatchObject({ status: "succeeded" });
		expect(companion.requests).toHaveLength(1);
		expect(companion.requests[0]?.tools).toEqual([]);
		await connector.dispose();
	});

	it("rejects unbounded, fractional, or widened Claude result usage", async () => {
		for (const invalidResult of [
			result("success", { usage: { input_tokens: 0.5, output_tokens: 1 } }),
			result("success", { total_cost_usd: Number.MAX_SAFE_INTEGER + 1 }),
			result("success", { modelUsage: { fixture: { ...usage, unexpected: 1 } } }),
		]) {
			const connector = driver(new FakeCompanion(async function* () {
				yield init();
				yield invalidResult;
			}));
			const handle = await connector.spawn(spawnRequest());
			await expect(connector.read(handle)).rejects.toMatchObject({ code: "external_event_invalid" });
			await connector.dispose();
		}
	});

	it("routes execution through Tool Gateway even when the SDK skips permission callbacks", async () => {
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			await request.executeTool({
				toolUseId: "auto-approved-tool",
				toolName: selectedToolName,
				input: { path: "package.json" },
				signal: request.abortController.signal,
			});
			yield result();
		});
		const connector = driver(companion);
		const handle = await connector.spawn(spawnRequest());
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect((await nextEvent(iterator)).type).toBe("started");
		const event = await nextToolEvent(iterator);
		expect(event.request.toolName).toBe(selectedToolName);
		await settle(connector, handle, event);
		await expect(connector.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		await connector.dispose();
	});

	it("denies missing, late, duplicate, reviewer, and team-enforced permission decisions", async () => {
		const decisions: string[] = [];
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			for (const requestId of ["missing", "reviewer", "team", "duplicate", "duplicate"]) {
				decisions.push(await request.requestPermission({
					requestId,
					toolUseId: `tool-${requestId}`,
					toolName: selectedToolName,
					input: { path: "protected/result.txt" },
					signal: request.abortController.signal,
				}));
			}
			yield result();
		});
		const connector = driver(companion, { limits: { requestTimeoutMs: 30 } });
		const handle = await connector.spawn(spawnRequest());
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect((await nextEvent(iterator)).type).toBe("started");
		const missing = await nextToolEvent(iterator);
		await new Promise((resolve) => setTimeout(resolve, 40));
		await expect(settle(connector, handle, missing, { result: { behavior: "allow" } })).rejects.toMatchObject({
			code: "external_event_invalid",
		});
		for (const expected of ["reviewer", "team", "duplicate"]) {
			const event = await nextToolEvent(iterator);
			expect(event.request.originalArguments).toMatchObject({ input: { path: "protected/result.txt" } });
			await settle(connector, handle, event, {
				ok: false,
				result: { requirement: expected },
			});
		}
		await expect(connector.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		expect(decisions).toEqual(["deny", "deny", "deny", "deny", "deny"]);
		await connector.dispose();
	});

	it("preserves unknown side-effect truth when abort follows a routed tool", async () => {
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			await request.executeTool({
				toolUseId: "effect-before-abort",
				toolName: selectedToolName,
				input: { path: "result.txt" },
				signal: request.abortController.signal,
			});
		});
		const connector = driver(companion);
		const handle = await connector.spawn(spawnRequest());
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect((await nextEvent(iterator)).type).toBe("started");
		expect((await nextToolEvent(iterator)).request.toolName).toBe(selectedToolName);
		await expect(connector.cancel(handle)).resolves.toMatchObject({
			status: "failed",
			error: { code: "side_effect_unknown", category: "side_effect_unknown" },
			sideEffectState: "side_effect_unknown",
		});
		await expect(connector.read(handle)).resolves.toMatchObject({
			status: "failed",
			sideEffectState: "side_effect_unknown",
		});
		expect(companion.queries[0]?.closed).toBe(true);
		await connector.dispose();
	});

	it("settles failed side_effect_unknown when an abort interrupts an active effect", async () => {
		const controller = new AbortController();
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			await request.executeTool({
				toolUseId: "effect-before-signal-abort",
				toolName: selectedToolName,
				input: { path: "result.txt" },
				signal: request.abortController.signal,
			});
		});
		const connector = driver(companion);
		const handle = await connector.spawn(spawnRequest({ signal: controller.signal }));
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect((await nextEvent(iterator)).type).toBe("started");
		expect((await nextToolEvent(iterator)).request.toolName).toBe(selectedToolName);
		controller.abort();
		await expect(connector.read(handle)).resolves.toMatchObject({
			status: "failed",
			error: { code: "side_effect_unknown" },
			sideEffectState: "side_effect_unknown",
		});
		await connector.dispose();
	});

	it("settles failed side_effect_unknown when cancellation races a late SDK result", async () => {
		let toolCompleted: () => void = () => undefined;
		const completed = new Promise<void>((resolve) => { toolCompleted = resolve; });
		let releaseResult: () => void = () => undefined;
		const lateResult = new Promise<void>((resolve) => { releaseResult = resolve; });
		const companion = new FakeCompanion(async function* (request) {
			yield init();
			await request.executeTool({
				toolUseId: "effect-before-late-result",
				toolName: selectedToolName,
				input: { path: "result.txt" },
				signal: request.abortController.signal,
			});
			toolCompleted();
			await lateResult;
			yield result();
		});
		const connector = driver(companion);
		const handle = await connector.spawn(spawnRequest());
		const iterator = connector.events(handle)[Symbol.asyncIterator]();
		expect((await nextEvent(iterator)).type).toBe("started");
		const event = await nextToolEvent(iterator);
		await settle(connector, handle, event, { sideEffectState: "unknown" });
		await completed;
		await expect(connector.cancel(handle)).resolves.toMatchObject({
			status: "failed",
			error: { code: "side_effect_unknown" },
			sideEffectState: "side_effect_unknown",
		});
		releaseResult();
		await Promise.resolve();
		await expect(connector.read(handle)).resolves.toMatchObject({
			status: "failed",
			sideEffectState: "side_effect_unknown",
		});
		await connector.dispose();
	});

	it("redacts prompt, transcript, header, token, result, and vendor errors from events and receipt", async () => {
		const secrets = ["PROMPT_SECRET", "TRANSCRIPT_SECRET", "HEADER_SECRET", "TOKEN_SECRET", "ERROR_SECRET"];
		const companion = new FakeCompanion(async function* () {
			yield init();
			yield {
				type: "assistant",
				session_id: sessionId,
				message: { content: [{ type: "text", text: "TRANSCRIPT_SECRET HEADER_SECRET TOKEN_SECRET" }] },
			};
			yield result("error_during_execution", { errors: ["ERROR_SECRET"], result: "TRANSCRIPT_SECRET" });
		});
		const connector = driver(companion, { env: { AUTHORIZATION: "HEADER_SECRET", ANTHROPIC_API_KEY: "TOKEN_SECRET" } });
		const handle = await connector.spawn(spawnRequest({
			input: { schemaVersion: 1, text: "PROMPT_SECRET", artifacts: [] },
		}));
		const observed: unknown[] = [];
		for await (const event of connector.events(handle)) observed.push(event);
		const evidence = await connector.read(handle);
		const publicOutput = JSON.stringify({ observed, evidence });
		for (const secret of secrets) expect(publicOutput).not.toContain(secret);
		expect(evidence).toMatchObject({ status: "failed", error: { message: "Run failed." } });
		await connector.dispose();
	});

	it("fails closed on malformed, oversized, mismatched, and duplicate SDK messages", async () => {
		for (const run of [
			async function* () { yield { type: "future", secret: "x" }; },
			async function* () { yield init([selectedToolName, "mcp__docs__write"]); },
			async function* () { yield init(); yield { type: "assistant", session_id: sessionId, body: "x".repeat(2_048) }; },
			async function* () { yield init(); yield init(); },
		]) {
			const connector = driver(new FakeCompanion(run), { limits: { maxMessageBytes: 1_024 } });
			try {
				const handle = await connector.spawn(spawnRequest());
				await expect(connector.read(handle)).rejects.toMatchObject({
					code: expect.stringMatching(/external_(event_invalid|frame_oversize|protocol_unsupported)/u),
				});
			} catch (error) {
				expect(error).toMatchObject({
					code: expect.stringMatching(/external_(event_invalid|frame_oversize|protocol_unsupported)/u),
				});
			}
			await connector.dispose();
		}
	});

	it("is exact, static, package-private, and default-off", async () => {
		const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
			readonly optionalDependencies: Record<string, string>;
		};
		const companionSource = await readFile(
			new URL("../../src/vendor-driver-companions/claude-entry.ts", import.meta.url),
			"utf8",
		);
		const coreSource = await readFile(new URL("../../src/core/connector/vendor/claude.ts", import.meta.url), "utf8");
		expect(manifest.optionalDependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.246");
		expect(manifest.optionalDependencies.zod).toBe("4.4.3");
		expect(companionSource).toContain('from "@anthropic-ai/claude-agent-sdk"');
		expect(companionSource).toContain("settingSources: []");
		expect(companionSource).toContain("strictMcpConfig: true");
		expect(companionSource).toContain("tools: []");
		expect(companionSource).toContain("allowedTools: []");
		expect(coreSource).not.toContain("import(");
		expect(coreSource).not.toContain("@anthropic-ai/claude-agent-sdk");
		expect(Object.keys(packageEntry).filter((key) => key.toLowerCase().includes("claude"))).toEqual([]);
	});
});
