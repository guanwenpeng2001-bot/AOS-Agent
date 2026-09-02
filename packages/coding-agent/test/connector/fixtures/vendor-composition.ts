import {
	AGENT_METHODS,
	agent,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { FoundationJsonValue } from "../../../../agent/src/internal.ts";
import {
	PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	type PrivateClaudeAgentSdkCompanion,
	type PrivateClaudeCompanionQuery,
} from "../../../src/core/connector/vendor/claude.ts";
import {
	PRIVATE_CODEX_APP_SERVER_IDENTITY,
	type PrivateCodexAppServerTransport,
} from "../../../src/core/connector/vendor/codex.ts";
import type { PrivateExternalConnectorVendorAdapterOverrides } from "../../../src/core/connector/vendor/composition.ts";
import type { PrivateExternalConnectorVendorDriver } from "../../../src/core/connector/vendor/identity.ts";
import { createExternalConnectorTestSupervision } from "../external-connector-test-supervision.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function claudeCompanion(): PrivateClaudeAgentSdkCompanion {
	return {
		sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
		query: (request): PrivateClaudeCompanionQuery => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "system",
					subtype: "init",
					session_id: "claude-product-session",
					tools: request.tools.map((tool) => tool.exposedToolName),
					mcp_servers: request.tools.map((tool) => ({ name: tool.serverName, status: "connected" })),
				};
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

function codexTransport(cwd: string): PrivateCodexAppServerTransport {
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
						await writer.write(encoder.encode(`${JSON.stringify({ id, result: {
							thread: codexThread(cwd),
							model: "gpt-fixture",
							modelProvider: "openai",
							serviceTier: null,
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
						await writer.write(encoder.encode(`${JSON.stringify({ id, result: { turn: codexTurn("inProgress") } })}\n`));
						await writer.write(encoder.encode(`${JSON.stringify({
							method: "turn/started",
							params: { threadId: "codex-product-thread", turn: codexTurn("inProgress") },
						})}\n`));
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
): PrivateExternalConnectorVendorAdapterOverrides {
	const supervision = createExternalConnectorTestSupervision().options;
	if (driver === "claude") return { supervision, claudeCompanion: claudeCompanion() };
	if (driver === "codex") return { supervision, codexTransportFactory: async () => codexTransport(cwd) };
	return { supervision, acpTransportFactory: acpTransport() };
}
