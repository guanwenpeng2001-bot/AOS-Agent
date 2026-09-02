import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { LocalCredentialVault } from "../../src/core/policy/credential-vault.ts";
import {
	ExternalConnectorModelGateway,
	type ExternalModelGatewayCapability,
} from "../../src/core/connector/model-gateway.ts";
import { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import type { ExternalResolvedModelProjection } from "../../src/core/connector/model-projection.ts";

const directories: string[] = [];
const gateways: ExternalConnectorModelGateway[] = [];

afterEach(async () => {
	await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.dispose()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const MODEL: Model<"anthropic-messages"> = {
	id: "gpt-test",
	name: "Gateway Test Model",
	api: "anthropic-messages",
	provider: "gateway-provider",
	baseUrl: "https://provider.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 4_096,
};

const PROJECTION: ExternalResolvedModelProjection = {
	schemaVersion: 1,
	provider: MODEL.provider,
	model: MODEL.id,
	effort: "high",
	serviceTier: "priority",
	fallbackDecision: { kind: "primary", reason: "fallback_not_used" },
	bindingDigest: { algorithm: "sha256", value: "a".repeat(64) },
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "gateway response" },
			{ type: "toolCall", id: "result-call", name: "lookup", arguments: { query: "result" } },
		],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 7,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			reasoning: 1,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
		...overrides,
	};
}

function completedStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
	stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	return stream;
}

interface GatewayFixture {
	readonly gateway: ExternalConnectorModelGateway;
	readonly capability: ExternalModelGatewayCapability;
	readonly lease: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly scopeDigest: `sha256:${string}`;
		readonly expiresAt: string;
		readonly clientRequestId: string;
	};
	readonly revoke: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId: string;
		readonly requestedAt: string;
	};
	readonly requests: Array<{ readonly context: Context; readonly options: SimpleStreamOptions | undefined }>;
}

async function gatewayFixture(options: {
	readonly result?: AssistantMessage;
	readonly now?: () => number;
	readonly provider?: Provider<"anthropic-messages">;
} = {}): Promise<GatewayFixture> {
	const directory = mkdtempSync(join(tmpdir(), "aos-model-gateway-"));
	directories.push(directory);
	const authPath = join(directory, "auth.json");
	const credentials = AuthStorage.create(authPath);
	await credentials.modify(MODEL.provider, async () => ({ type: "api_key", key: "model-gateway-secret-canary" }));
	const requests: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
	const result = options.result ?? assistant();
	const provider: Provider<"anthropic-messages"> = options.provider ?? {
		id: MODEL.provider,
		name: "Gateway Test Provider",
		auth: {
			apiKey: {
				name: "Gateway test key",
				resolve: async () => ({ auth: { apiKey: "provider-default" }, source: "test" }),
			},
		},
		getModels: () => [MODEL],
		stream: (_model, context, streamOptions) => {
			requests.push({ context, options: streamOptions });
			return completedStream(result);
		},
		streamSimple: (_model, context, streamOptions) => {
			requests.push({ context, options: streamOptions });
			return completedStream(result);
		},
	};
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(provider);
	await runtime.refresh({ allowNetwork: false });
	const vault = new LocalCredentialVault({ authPath });
	const gateway = new ExternalConnectorModelGateway({
		targetId: "codex-gateway",
		runtime,
		vault,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	gateways.push(gateway);
	const lease = {
		schemaVersion: 1 as const,
		leaseId: "lease-model-gateway",
		grantId: "grant-model-gateway",
		bindingId: "binding-model-gateway",
		scopeDigest: `sha256:${"b".repeat(64)}` as const,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		clientRequestId: "request-model-gateway",
	};
	const references = vault.issue({
		leaseId: lease.leaseId,
		grantId: lease.grantId,
		bindingId: lease.bindingId,
		credentialNames: [MODEL.provider],
		requestedTtlMs: 60_000,
	});
	const projected = gateway.project({
		schemaVersion: 1,
		leaseId: lease.leaseId,
		grantId: lease.grantId,
		bindingId: lease.bindingId,
		targetId: "codex-gateway",
		references,
		projectedAt: new Date().toISOString(),
	});
	if (projected.status !== "succeeded") throw new Error("Gateway reference projection failed");
	const capability = await gateway.open(lease, PROJECTION);
	if (capability === undefined) throw new Error("Model gateway capability was not created");
	return {
		gateway,
		capability,
		lease,
		revoke: {
			schemaVersion: 1,
			leaseId: lease.leaseId,
			grantId: lease.grantId,
			bindingId: lease.bindingId,
			targetId: "codex-gateway",
			requestedAt: new Date().toISOString(),
		},
		requests,
	};
}

function gatewayFetch(
	fixture: GatewayFixture,
	path: "messages" | "responses",
	body: string,
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(`${fixture.capability.endpoint}/${path}`, {
		method: "POST",
		headers: {
			authorization: fixture.capability.authorization,
			"content-type": "application/json",
		},
		body,
		...(signal === undefined ? {} : { signal }),
	});
}

describe("External Connector model gateway", () => {
	it("opens only an exact live loopback capability and fails closed on unknown revoke", async () => {
		const fixture = await gatewayFixture();
		expect(fixture.capability).toMatchObject({
			endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
			leaseId: fixture.lease.leaseId,
			modelBindingDigest: PROJECTION.bindingDigest.value,
		});
		expect(JSON.stringify(fixture.capability)).not.toContain("model-gateway-secret-canary");
		expect(fixture.gateway.close({ ...fixture.capability, modelBindingDigest: "0".repeat(64) })).toBe(false);
		expect(fixture.gateway.close(fixture.capability)).toBe(true);
		expect(fixture.gateway.close(fixture.capability)).toBe(false);
		expect(fixture.gateway.revoke(fixture.revoke)).toMatchObject({ status: "revoked" });
		expect(() => fixture.gateway.revoke(fixture.revoke)).toThrow("revocation is unknown");
		expect(await fixture.gateway.open(fixture.lease, PROJECTION)).toBeUndefined();
		expect(await fixture.gateway.open(
			{ ...fixture.lease, expiresAt: new Date(Date.now() - 1).toISOString() },
			PROJECTION,
		)).toBeUndefined();
	});

	it("adapts OpenAI Responses streaming with roles, tools, tool results, effort, and tier", async () => {
		const fixture = await gatewayFixture();
		const response = await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			instructions: "system policy",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{\"query\":\"input\"}" },
				{ type: "function_call_output", call_id: "call-1", output: "tool output" },
			],
			tools: [{ type: "function", name: "lookup", description: "Look up data", parameters: { type: "object" } }],
			reasoning: { effort: "high" },
			service_tier: "priority",
			stream: true,
		}));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain("event: response.created");
		expect(body).toContain("event: response.function_call_arguments.done");
		expect(body).toContain("event: response.completed");
		expect(body).toContain('"service_tier":"priority"');
		const captured = fixture.requests[0];
		expect(captured?.context.systemPrompt).toBe("system policy");
		expect(captured?.context.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "input" } }] },
			{ role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [{ type: "text", text: "tool output" }] },
		]);
		expect(captured?.context.tools).toMatchObject([{ name: "lookup", parameters: { type: "object" } }]);
		expect(captured?.options).toMatchObject({
			reasoning: "high",
			serviceTier: "priority",
			samplingParams: { service_tier: "priority" },
		});
	});

	it("adapts Anthropic Messages streaming with roles, tools, and tool results", async () => {
		const fixture = await gatewayFixture();
		const response = await gatewayFetch(fixture, "messages", JSON.stringify({
			model: MODEL.id,
			max_tokens: 512,
			system: [{ type: "text", text: "system policy" }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { query: "input" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "tool output" }] },
			],
			tools: [{ name: "lookup", description: "Look up data", input_schema: { type: "object" } }],
			output_config: { effort: "high" },
			service_tier: "priority",
			stream: true,
		}));
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("event: message_start");
		expect(body).toContain("event: content_block_delta");
		expect(body).toContain("event: message_stop");
		expect(body).toContain('"type":"tool_use"');
		const captured = fixture.requests[0];
		expect(captured?.context.systemPrompt).toBe("system policy");
		expect(captured?.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(captured?.context.messages[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "lookup",
		});
		expect(captured?.options).toMatchObject({ reasoning: "high", maxTokens: 512, serviceTier: "priority" });
	});

	it("rejects malformed, oversized, expired, request-mismatched, and result-mismatched cases", async () => {
		const clock = { now: Date.now() };
		const fixture = await gatewayFixture({ now: () => clock.now });
		expect((await gatewayFetch(fixture, "responses", "{")).status).toBe(400);
		expect((await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: "x".repeat(1024 * 1024),
		}))).status).toBe(413);
		expect((await gatewayFetch(fixture, "responses", JSON.stringify({
			model: "wrong-model",
			input: "hello",
		}))).status).toBe(400);
		clock.now = Date.parse(fixture.capability.expiresAt) + 1;
		expect((await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: "hello",
		}))).status).toBe(401);

		const mismatched = await gatewayFixture({ result: assistant({ provider: "different-provider" }) });
		expect((await gatewayFetch(mismatched, "responses", JSON.stringify({
			model: MODEL.id,
			input: "hello",
		}))).status).toBe(502);
	});

	it("cancels the ModelRuntime request when the vendor disconnects", async () => {
		let aborted = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const provider: Provider<"anthropic-messages"> = {
			id: MODEL.provider,
			name: "Cancelling Gateway Provider",
			auth: {
				apiKey: {
					name: "Gateway cancellation test key",
					resolve: async () => ({ auth: { apiKey: "provider-default" }, source: "test" }),
				},
			},
			getModels: () => [MODEL],
			stream: () => createAssistantMessageEventStream(),
			streamSimple: (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				markStarted?.();
				options?.signal?.addEventListener("abort", () => {
					aborted = true;
					const error = assistant({ content: [], stopReason: "aborted", errorMessage: "aborted" });
					stream.push({ type: "error", reason: "aborted", error });
				}, { once: true });
				return stream;
			},
		};
		const fixture = await gatewayFixture({ provider });
		const controller = new AbortController();
		const request = gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: "wait",
			stream: true,
		}), controller.signal);
		await started;
		controller.abort();
		await expect(request).rejects.toThrow();
		await vi.waitFor(() => expect(aborted).toBe(true));
	});
});
