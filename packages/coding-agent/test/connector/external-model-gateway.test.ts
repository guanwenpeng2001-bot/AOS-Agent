import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@aos-agent/ai";
import { stream as streamOpenAIResponses } from "../../../ai/src/api/openai-responses.ts";
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
const servers: Server[] = [];

afterEach(async () => {
	await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.dispose()));
	await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const MODEL: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-sonnet-fixture-v1:0",
	name: "Gateway Test Model",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
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
	serviceTier: "none",
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
	readonly vault: LocalCredentialVault;
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
	readonly provider?: Provider;
	readonly model?: Model<Api>;
	readonly projection?: ExternalResolvedModelProjection;
	readonly leaseTtlMs?: number;
} = {}): Promise<GatewayFixture> {
	const model = options.model ?? MODEL;
	const projection = options.projection ?? PROJECTION;
	const directory = mkdtempSync(join(tmpdir(), "aos-model-gateway-"));
	directories.push(directory);
	const authPath = join(directory, "auth.json");
	const credentials = AuthStorage.create(authPath);
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "model-gateway-secret-canary" }));
	const requests: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
	const result = options.result ?? assistant();
	const provider: Provider = options.provider ?? {
		id: model.provider,
		name: "Gateway Test Provider",
		auth: {
			apiKey: {
				name: "Gateway test key",
				resolve: async () => ({ auth: { apiKey: "provider-default" }, source: "test" }),
			},
		},
		getModels: () => [model],
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
	const vault = new LocalCredentialVault({
		authPath,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const gateway = new ExternalConnectorModelGateway({
		targetId: "codex-gateway",
		runtime,
		vault,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	gateways.push(gateway);
	const issuedAt = options.now?.() ?? Date.now();
	const leaseTtlMs = options.leaseTtlMs ?? 60_000;
	const lease = {
		schemaVersion: 1 as const,
		leaseId: "lease-model-gateway",
		grantId: "grant-model-gateway",
		bindingId: "binding-model-gateway",
		scopeDigest: `sha256:${"b".repeat(64)}` as const,
		expiresAt: new Date(issuedAt + leaseTtlMs).toISOString(),
		clientRequestId: "request-model-gateway",
	};
	const references = vault.issue({
		leaseId: lease.leaseId,
		grantId: lease.grantId,
		bindingId: lease.bindingId,
		credentialNames: [model.provider],
		requestedTtlMs: leaseTtlMs,
		issuedAtMs: issuedAt,
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
	const capability = await gateway.open(lease, projection);
	if (capability === undefined) throw new Error("Model gateway capability was not created");
	return {
		gateway,
		vault,
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

async function stalledGatewayRequest(fixture: GatewayFixture): Promise<{ readonly settled: Promise<void> }> {
	const endpoint = new URL(`${fixture.capability.endpoint}/responses`);
	const socket = netConnect({ host: endpoint.hostname, port: Number(endpoint.port) });
	await new Promise<void>((resolve, reject) => {
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
	let settle: () => void = () => undefined;
	const settled = new Promise<void>((resolve) => { settle = resolve; });
	const settleAndClose = (): void => {
		settle();
		if (!socket.destroyed) socket.destroy();
	};
	socket.once("data", settleAndClose);
	socket.once("end", settle);
	socket.once("close", settle);
	socket.once("error", settle);
	socket.write([
		`POST ${endpoint.pathname} HTTP/1.1`,
		`Host: ${endpoint.host}`,
		`Authorization: ${fixture.capability.authorization}`,
		"Content-Type: application/json",
		"Content-Length: 4096",
		"",
		`{"model":"${MODEL.id}","input":"partial`,
	].join("\r\n"));
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
	return { settled };
}

function activeProviderFixture(): {
	readonly provider: Provider<"bedrock-converse-stream">;
	readonly started: Promise<void>;
	readonly aborted: Promise<void>;
	readonly settled: Promise<void>;
} {
	let markStarted: () => void = () => undefined;
	let markAborted: () => void = () => undefined;
	let markSettled: () => void = () => undefined;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const settled = new Promise<void>((resolve) => { markSettled = resolve; });
	const provider: Provider<"bedrock-converse-stream"> = {
		id: MODEL.provider,
		name: "Active Gateway Provider",
		auth: {
			apiKey: {
				name: "Gateway active-request test key",
				resolve: async () => ({ auth: { apiKey: "provider-default" }, source: "test" }),
			},
		},
		getModels: () => [MODEL],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			const signal = options?.signal;
			if (signal === undefined) throw new Error("Gateway active request omitted cancellation");
			markStarted();
			const abort = (): void => {
				markAborted();
				const error = assistant({ content: [], stopReason: "aborted", errorMessage: "aborted" });
				stream.push({ type: "error", reason: "aborted", error });
				stream.end();
				markSettled();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
			return stream;
		},
	};
	return { provider, started, aborted, settled };
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
		const unsupported = await gatewayFixture();
		expect(await unsupported.gateway.open(unsupported.lease, {
			...PROJECTION,
			serviceTier: "priority",
		})).toBeUndefined();
		expect(await fixture.gateway.open(
			{ ...fixture.lease, expiresAt: new Date(Date.now() - 1).toISOString() },
			PROJECTION,
		)).toBeUndefined();
	});

	it("renews an active capability past its original expiry and expires at the renewed deadline", async () => {
		const clock = { now: Date.now() };
		const fixture = await gatewayFixture({ now: () => clock.now, leaseTtlMs: 100 });
		const originalExpiry = Date.parse(fixture.capability.expiresAt);
		const requestedAt = originalExpiry - 50;
		const renewedExpiry = requestedAt + 1_000;
		// Mirror the production renewal path: the provider wrapper renews the vault
		// projection before the target (task-credential-provider.ts), so a renewed
		// capability never outlives its credential projection.
		fixture.vault.renew({
			leaseId: fixture.lease.leaseId,
			grantId: fixture.lease.grantId,
			bindingId: fixture.lease.bindingId,
			requestedTtlMs: 1_000,
			renewedAtMs: requestedAt,
		});
		expect(fixture.gateway.renew({
			schemaVersion: 1,
			leaseId: fixture.lease.leaseId,
			grantId: fixture.lease.grantId,
			bindingId: fixture.lease.bindingId,
			targetId: "codex-gateway",
			requestedTtlMs: 1_000,
			requestedAt: new Date(requestedAt).toISOString(),
		})).toMatchObject({ status: "renewed" });

		clock.now = originalExpiry + 1;
		expect((await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: "still live",
		}))).status).toBe(200);

		clock.now = renewedExpiry + 1;
		expect((await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: "expired",
		}))).status).toBe(401);
		expect(() => fixture.gateway.renew({
			schemaVersion: 1,
			leaseId: fixture.lease.leaseId,
			grantId: fixture.lease.grantId,
			bindingId: fixture.lease.bindingId,
			targetId: "codex-gateway",
			requestedTtlMs: 1_000,
			requestedAt: new Date(renewedExpiry + 1).toISOString(),
		})).toThrow("renewal is expired");
	});

	it("keeps the original expiry timer from aborting a renewed active request", async () => {
		const active = activeProviderFixture();
		const fixture = await gatewayFixture({ provider: active.provider, leaseTtlMs: 150 });
		const requestedAt = Date.now();
		// Mirror the production renewal path: vault projection first, then target.
		fixture.vault.renew({
			leaseId: fixture.lease.leaseId,
			grantId: fixture.lease.grantId,
			bindingId: fixture.lease.bindingId,
			requestedTtlMs: 700,
			renewedAtMs: requestedAt,
		});
		expect(fixture.gateway.renew({
			schemaVersion: 1,
			leaseId: fixture.lease.leaseId,
			grantId: fixture.lease.grantId,
			bindingId: fixture.lease.bindingId,
			targetId: "codex-gateway",
			requestedTtlMs: 700,
			requestedAt: new Date(requestedAt).toISOString(),
		})).toMatchObject({ status: "renewed" });
		const request = gatewayFetch(fixture, "responses", JSON.stringify({ model: MODEL.id, input: "wait" }));
		await active.started;
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
		let aborted = false;
		void active.aborted.then(() => { aborted = true; });
		await Promise.resolve();
		expect(aborted).toBe(false);
		expect(fixture.gateway.close(fixture.capability)).toBe(true);
		await active.aborted;
		expect((await request).status).toBe(502);
	});

	it("adapts OpenAI Responses streaming with roles, tools, tool results, and effort", async () => {
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
			service_tier: "none",
			stream: true,
		}));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain("event: response.created");
		expect(body).toContain("event: response.function_call_arguments.done");
		expect(body).toContain("event: response.completed");
		expect(body).toContain('"service_tier":null');
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
		});
		expect(captured?.options).not.toHaveProperty("serviceTier");
		expect(captured?.options).not.toHaveProperty("samplingParams");
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
			service_tier: "none",
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
		expect(captured?.options).toMatchObject({ reasoning: "high", maxTokens: 512 });
		expect(captured?.options).not.toHaveProperty("serviceTier");
	});

	it("round-trips signed and redacted Anthropic thinking blocks without exposing their payloads", async () => {
		const fixture = await gatewayFixture({ result: assistant({
			content: [
				{ type: "thinking", thinking: "private chain", thinkingSignature: "signed-output" },
				{ type: "thinking", thinking: "", thinkingSignature: "redacted-output", redacted: true },
				{ type: "text", text: "answer" },
			],
			stopReason: "stop",
		}) });
		const response = await gatewayFetch(fixture, "messages", JSON.stringify({
			model: MODEL.id,
			max_tokens: 128,
			messages: [
				{ role: "assistant", content: [
					{ type: "thinking", thinking: "prior chain", signature: "signed-input" },
					{ type: "redacted_thinking", data: "redacted-input" },
				] },
				{ role: "user", content: "continue" },
			],
		}));
		expect(response.status).toBe(200);
		expect(fixture.requests[0]?.context.messages[0]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "prior chain", thinkingSignature: "signed-input" },
				{ type: "thinking", thinking: "", thinkingSignature: "redacted-input", redacted: true },
			],
		});
		expect(await response.json()).toMatchObject({
			content: [
				{ type: "thinking", thinking: "private chain", signature: "signed-output" },
				{ type: "redacted_thinking", data: "redacted-output" },
				{ type: "text", text: "answer" },
			],
		});

		expect((await gatewayFetch(fixture, "messages", JSON.stringify({
			model: MODEL.id,
			max_tokens: 128,
			messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] }],
		}))).status).toBe(400);
	});

	it("round-trips the full OpenAI reasoning replay item and rejects malformed replay signatures", async () => {
		const inputReasoning = {
			type: "reasoning",
			id: "rs_input",
			status: "completed",
			summary: [{ type: "summary_text", text: "input summary" }],
			content: [{ type: "reasoning_text", text: "input details" }],
			encrypted_content: "encrypted-input",
		};
		const outputReasoning = {
			type: "reasoning",
			id: "rs_output",
			status: "completed",
			summary: [{ type: "summary_text", text: "output summary" }],
			content: [{ type: "reasoning_text", text: "output details" }],
			encrypted_content: "encrypted-output",
		};
		const fixture = await gatewayFixture({ result: assistant({
			content: [{
				type: "thinking",
				thinking: "output summary",
				thinkingSignature: JSON.stringify(outputReasoning),
			}],
			stopReason: "stop",
		}) });
		const response = await gatewayFetch(fixture, "responses", JSON.stringify({
			model: MODEL.id,
			input: [inputReasoning, { type: "message", role: "user", content: "continue" }],
		}));
		expect(response.status).toBe(200);
		expect(fixture.requests[0]?.context.messages[0]).toMatchObject({
			role: "assistant",
			content: [{
				type: "thinking",
				thinking: "input summary",
				thinkingSignature: JSON.stringify(inputReasoning),
			}],
		});
		expect(await response.json()).toMatchObject({ output: [outputReasoning] });

		const malformedInput = await gatewayFixture();
		const summarylessReasoning = {
			type: "reasoning",
			id: "rs_summaryless",
			status: "completed",
			content: [{ type: "reasoning_text", text: "content-only reasoning" }],
			encrypted_content: "encrypted-summaryless",
		};
		expect((await gatewayFetch(malformedInput, "responses", JSON.stringify({
			model: MODEL.id,
			input: [summarylessReasoning, { type: "message", role: "user", content: "continue" }],
		}))).status).toBe(200);
		expect(malformedInput.requests[0]?.context.messages[0]).toMatchObject({
			content: [{
				type: "thinking",
				thinking: "content-only reasoning",
				thinkingSignature: JSON.stringify(summarylessReasoning),
			}],
		});
		expect((await gatewayFetch(malformedInput, "responses", JSON.stringify({
			model: MODEL.id,
			input: [{ type: "reasoning", id: "rs_bad", summary: [], encrypted_content: { bad: true } }],
		}))).status).toBe(400);
		const malformedOutput = await gatewayFixture({ result: assistant({
			content: [{ type: "thinking", thinking: "bad", thinkingSignature: "not-json" }],
			stopReason: "stop",
		}) });
		expect((await gatewayFetch(malformedOutput, "responses", JSON.stringify({
			model: MODEL.id,
			input: "hello",
		}))).status).toBe(502);
	});

	it("applies an admitted service tier in the final stock OpenAI Responses payload", async () => {
		let receiveBody: (body: string) => void = () => undefined;
		const receivedBody = new Promise<string>((resolve) => { receiveBody = resolve; });
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				receiveBody(Buffer.concat(chunks).toString("utf8"));
				response.writeHead(500).end();
			})();
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo;
		const model: Model<"openai-responses"> = {
			...MODEL,
			id: "gpt-stock-service-tier",
			api: "openai-responses",
			provider: "openai",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
		};
		const projection: ExternalResolvedModelProjection = {
			...PROJECTION,
			provider: model.provider,
			model: model.id,
			serviceTier: "priority",
		};
		const provider: Provider<"openai-responses"> = {
			id: model.provider,
			name: "Stock OpenAI Responses Gateway Provider",
			auth: {
				apiKey: {
					name: "Gateway stock-adapter test key",
					resolve: async () => ({ auth: { apiKey: "provider-default" }, source: "test" }),
				},
			},
			getModels: () => [model],
			stream: streamOpenAIResponses,
			streamSimple: () => { throw new Error("Gateway must use the typed stock stream options"); },
		};
		const fixture = await gatewayFixture({ model, projection, provider });
		const response = await gatewayFetch(fixture, "responses", JSON.stringify({
			model: model.id,
			input: "apply priority",
			reasoning: { effort: "high" },
			service_tier: "priority",
		}));
		expect(response.status).toBe(502);
		expect(JSON.parse(await receivedBody)).toMatchObject({
			model: model.id,
			reasoning: { effort: "high" },
			service_tier: "priority",
		});
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
		const provider: Provider<"bedrock-converse-stream"> = {
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

	it("aborts the exact active bearer request when its capability closes", async () => {
		const active = activeProviderFixture();
		const fixture = await gatewayFixture({ provider: active.provider });
		const request = gatewayFetch(fixture, "responses", JSON.stringify({ model: MODEL.id, input: "wait" }));
		await active.started;

		expect(fixture.gateway.close(fixture.capability)).toBe(true);
		await active.aborted;
		expect((await request).status).toBe(502);
		expect(fixture.gateway.revoke(fixture.revoke)).toMatchObject({ status: "revoked" });
	});

	it("reports revocation unknown until the exact lease request settles", async () => {
		const active = activeProviderFixture();
		const fixture = await gatewayFixture({ provider: active.provider });
		const request = gatewayFetch(fixture, "responses", JSON.stringify({ model: MODEL.id, input: "wait" }));
		await active.started;

		expect(fixture.gateway.revoke(fixture.revoke)).toMatchObject({ status: "revocation_unknown" });
		await active.aborted;
		expect((await request).status).toBe(502);
		expect(fixture.gateway.revoke(fixture.revoke)).toMatchObject({ status: "revoked" });
	});

	it("aborts an active request at the exact capability expiry", async () => {
		const active = activeProviderFixture();
		const fixture = await gatewayFixture({ provider: active.provider, leaseTtlMs: 1_000 });
		const request = gatewayFetch(fixture, "responses", JSON.stringify({ model: MODEL.id, input: "wait" }));
		await active.started;

		await active.aborted;
		expect((await request).status).toBe(502);
		expect(fixture.gateway.close(fixture.capability)).toBe(false);
		expect(fixture.gateway.revoke(fixture.revoke)).toMatchObject({ status: "revoked" });
	}, 5_000);

	it("waits for an active request to settle during session disposal", async () => {
		const active = activeProviderFixture();
		const fixture = await gatewayFixture({ provider: active.provider });
		const request = gatewayFetch(fixture, "responses", JSON.stringify({ model: MODEL.id, input: "wait" }));
		await active.started;

		const disposed = fixture.gateway.dispose();
		await active.aborted;
		await active.settled;
		await disposed;
		expect((await request).status).toBe(502);
	});

	it("cancels stalled partial request bodies during close, revoke, and dispose", async () => {
		const closedFixture = await gatewayFixture();
		const closedRequest = await stalledGatewayRequest(closedFixture);
		expect(closedFixture.gateway.close(closedFixture.capability)).toBe(true);
		await expect(Promise.race([
			closedRequest.settled,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close did not settle stalled body")), 1_000)),
		])).resolves.toBeUndefined();

		const revokedFixture = await gatewayFixture();
		const revokedRequest = await stalledGatewayRequest(revokedFixture);
		expect(revokedFixture.gateway.revoke(revokedFixture.revoke).status).toBe("revocation_unknown");
		await expect(Promise.race([
			revokedRequest.settled,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("revoke did not settle stalled body")), 1_000)),
		])).resolves.toBeUndefined();
		expect(revokedFixture.gateway.revoke(revokedFixture.revoke).status).toBe("revoked");

		const disposedFixture = await gatewayFixture();
		const disposedRequest = await stalledGatewayRequest(disposedFixture);
		await expect(Promise.race([
			disposedFixture.gateway.dispose(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispose did not settle stalled body")), 1_000)),
		])).resolves.toBeUndefined();
		await expect(Promise.race([
			disposedRequest.settled,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("disposed request transport did not settle")), 1_000)),
		])).resolves.toBeUndefined();
	});
});
