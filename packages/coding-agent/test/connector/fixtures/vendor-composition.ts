import {
	AGENT_METHODS,
	agent,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { FoundationJsonValue } from "../../../../agent/src/internal.ts";
import {
	PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	type PrivateClaudeAgentSdkCompanion,
	type PrivateClaudeCompanionQueryRequest,
	type PrivateClaudeCompanionQuery,
} from "../../../src/core/connector/vendor/claude.ts";
import {
	PRIVATE_CODEX_APP_SERVER_IDENTITY,
	type PrivateCodexAppServerTransport,
	type PrivateCodexAppServerTransportRequest,
} from "../../../src/core/connector/vendor/codex.ts";
import type { PrivateExternalConnectorVendorAdapterOverrides } from "../../../src/core/connector/vendor/composition.ts";
import type { PrivateExternalConnectorVendorDriver } from "../../../src/core/connector/vendor/identity.ts";
import type { ExternalConnectorModelGateway } from "../../../src/core/connector/model-gateway.ts";
import { createExternalConnectorTestSupervision } from "../external-connector-test-supervision.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface VendorAdapterFixtureCaptures {
	claudeQuery?: PrivateClaudeCompanionQueryRequest;
	codexTransport?: PrivateCodexAppServerTransportRequest;
	credentialEvents?: string[];
	gatewayRequests?: Array<{
		readonly path: "/messages" | "/responses";
		readonly authorization: string;
		readonly request: Readonly<Record<string, unknown>>;
		readonly status: number;
		readonly response: unknown;
		readonly responseBytes: number;
	}>;
	modelRequests?: Array<{
		readonly method: "stream" | "streamSimple";
		readonly provider: string;
		readonly model: string;
		readonly apiKey?: string;
		readonly context: string;
		readonly maxTokens?: number;
		readonly reasoning?: string;
		readonly reasoningEffort?: string;
		readonly serviceTier?: string | null;
	}>;
	modelGateway?: ExternalConnectorModelGateway;
	supervision?: ReturnType<typeof createExternalConnectorTestSupervision>;
}

async function requestGateway(
	captures: VendorAdapterFixtureCaptures | undefined,
	endpoint: string,
	authorization: string,
	path: "/messages" | "/responses",
	request: Readonly<Record<string, unknown>>,
): Promise<unknown> {
	captures?.credentialEvents?.push(`gateway-request-start:${path}`);
	const response = await fetch(`${endpoint}${path}`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	const responseText = await response.text();
	const responseValue: unknown = responseText.length === 0 ? undefined : JSON.parse(responseText);
	captures?.gatewayRequests?.push({
		path,
		authorization,
		request,
		status: response.status,
		response: responseValue,
		responseBytes: encoder.encode(responseText).byteLength,
	});
	captures?.credentialEvents?.push(`gateway-request-status:${response.status}`);
	captures?.credentialEvents?.push(`gateway-request-settled:${path}`);
	if (!response.ok) throw new Error(`Gateway fixture request failed with status ${response.status}`);
	return responseValue;
}

function claudeCompanion(captures?: VendorAdapterFixtureCaptures): PrivateClaudeAgentSdkCompanion {
	return {
		sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
		query: (request): PrivateClaudeCompanionQuery => ({
			async *[Symbol.asyncIterator]() {
				if (captures !== undefined) captures.claudeQuery = request;
				yield {
					type: "system",
					subtype: "init",
					session_id: "claude-product-session",
					tools: request.tools.map((tool) => tool.exposedToolName),
					mcp_servers: request.tools.map((tool) => ({ name: tool.serverName, status: "connected" })),
					...(request.model === undefined ? {} : { model: request.model.model, effort: request.model.effort }),
				};
				if (request.modelGateway !== undefined && request.model !== undefined) {
					const prompt = request.prompt.content
						.flatMap((block) => block.type === "text" ? [block.text] : [])
						.join("\n");
					await requestGateway(captures, request.modelGateway.endpoint, request.modelGateway.authorization, "/messages", {
						model: request.model.model,
						max_tokens: 16,
						messages: [{ role: "user", content: prompt }],
						output_config: { effort: request.model.effort },
						stream: false,
					});
				}
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					session_id: "claude-product-session",
					total_cost_usd: 0,
					usage: { input_tokens: 1, output_tokens: 1 },
					modelUsage: {
						fixture: {
							inputTokens: 1,
							outputTokens: 1,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
							webSearchRequests: 0,
							costUSD: 0,
							contextWindow: 1,
							maxOutputTokens: 1,
							...(request.model === undefined
								? {}
								: { canonicalModel: request.model.model, provider: request.model.provider }),
						},
					},
				};
			},
			close: () => undefined,
		}),
	};
}

function codexThread(cwd: string): FoundationJsonValue {
	return {
		id: "codex-product-thread",
		extra: null,
		sessionId: "codex-product-session",
		forkedFromId: null,
		parentThreadId: null,
		preview: "",
		ephemeral: false,
		section: null,
		sectionEnteredAt: null,
		projectId: null,
		historyMode: "legacy",
		modelProvider: "openai",
		createdAt: 1,
		updatedAt: 1,
		recencyAt: 1,
		status: { type: "idle" },
		path: null,
		cwd,
		cliVersion: PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion,
		source: "appServer",
		canAcceptDirectInput: true,
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns: [],
	};
}

function codexTurn(status: "inProgress" | "completed"): FoundationJsonValue {
	return {
		id: "codex-product-turn",
		items: [],
		itemsView: "full",
		status,
		error: null,
		startedAt: 1,
		completedAt: status === "completed" ? 2 : null,
		durationMs: status === "completed" ? 1 : null,
	};
}

function codexTransport(cwd: string, captures?: VendorAdapterFixtureCaptures): PrivateCodexAppServerTransport {
	const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
	const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
	const writer = serverToClient.writable.getWriter();
	void (async () => {
		const reader = clientToServer.readable.getReader();
		let buffered = "";
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
				buffered += decoder.decode(next.value, { stream: true });
				for (;;) {
					const newline = buffered.indexOf("\n");
					if (newline < 0) break;
					const message = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
					buffered = buffered.slice(newline + 1);
					const id = message.id as number;
					if (message.method === "initialize") {
						await writer.write(encoder.encode(`${JSON.stringify({ id, result: {
							userAgent: "codex-cli/0.149.0",
							codexHome: cwd,
							platformFamily: "fixture",
							platformOs: "fixture",
						} })}\n`));
					} else if (message.method === "thread/start") {
						const params = message.params as Record<string, unknown>;
						await writer.write(encoder.encode(`${JSON.stringify({ id, result: {
							thread: codexThread(cwd),
							model: params.model ?? "gpt-fixture",
							modelProvider: params.modelProvider ?? "openai",
							serviceTier: params.serviceTier ?? null,
							cwd,
							runtimeWorkspaceRoots: [cwd],
							instructionSources: [],
							approvalPolicy: "on-request",
							approvalsReviewer: "user",
							sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
							activePermissionProfile: null,
							reasoningEffort: null,
							multiAgentMode: "explicitRequestOnly",
						} })}\n`));
					} else if (message.method === "turn/start") {
						const params = message.params as Record<string, unknown>;
						await writer.write(encoder.encode(`${JSON.stringify({ id, result: { turn: codexTurn("inProgress") } })}\n`));
						await writer.write(encoder.encode(`${JSON.stringify({
							method: "turn/started",
							params: { threadId: "codex-product-thread", turn: codexTurn("inProgress") },
						})}\n`));
						const environment = captures?.supervision?.processController.launchOptions.at(-1)?.environment;
						const endpoint = environment?.AOS_MODEL_GATEWAY_ENDPOINT;
						const authorization = environment?.AOS_MODEL_GATEWAY_AUTHORIZATION;
						if (endpoint !== undefined && authorization !== undefined && typeof params.model === "string") {
							const input = Array.isArray(params.input) ? params.input : [];
							const prompt = input.flatMap((candidate) => {
								if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
								const item = candidate as Record<string, unknown>;
								return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
							}).join("\n");
							await requestGateway(captures, endpoint, authorization, "/responses", {
								model: params.model,
								input: prompt,
								...(typeof params.effort === "string" ? { reasoning: { effort: params.effort } } : {}),
								...(typeof params.serviceTier === "string" ? { service_tier: params.serviceTier } : {}),
								max_output_tokens: 16,
								stream: false,
							});
						}
						await writer.write(encoder.encode(`${JSON.stringify({
							method: "turn/completed",
							params: { threadId: "codex-product-thread", turn: codexTurn("completed") },
						})}\n`));
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	})().catch(() => undefined);
	return {
		input: serverToClient.readable,
		output: clientToServer.writable,
		identity: PRIVATE_CODEX_APP_SERVER_IDENTITY,
		close: async () => {
			await writer.close().catch(() => undefined);
			writer.releaseLock();
		},
	};
}

function acpTransport() {
	const app = agent({ name: "aos-product-acp-fixture" })
		.onRequest(AGENT_METHODS.initialize, () => ({
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
		}))
		.onRequest(AGENT_METHODS.session_new, () => ({ sessionId: "acp-product-session" }))
		.onRequest(AGENT_METHODS.session_prompt, () => ({ stopReason: "end_turn" }));
	return async () => {
		const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
		const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
		const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));
		return {
			input: agentToClient.readable,
			output: clientToAgent.writable,
			close: (error?: unknown) => connection.close(error),
		};
	};
}

export function vendorAdapterFixture(
	driver: PrivateExternalConnectorVendorDriver,
	cwd: string,
	captures?: VendorAdapterFixtureCaptures,
): PrivateExternalConnectorVendorAdapterOverrides {
	const supervisionFixture = createExternalConnectorTestSupervision(captures?.credentialEvents === undefined
		? {}
		: {
			event: { hardMs: 10_000, idleMs: 10_000 },
			receipt: { hardMs: 10_000, idleMs: 10_000 },
		});
	if (captures !== undefined) captures.supervision = supervisionFixture;
	const supervision = supervisionFixture.options;
	if (driver === "claude") return { supervision, claudeCompanion: claudeCompanion(captures) };
	if (driver === "codex") return {
		supervision,
		codexTransportFactory: async (request) => {
			if (captures !== undefined) captures.codexTransport = request;
			return codexTransport(cwd, captures);
		},
	};
	return { supervision, acpTransportFactory: acpTransport() };
}
