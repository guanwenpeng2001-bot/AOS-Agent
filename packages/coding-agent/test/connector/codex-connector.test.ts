import {
	type ArtifactDigest,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	createConnectorCapabilitySnapshot,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type ToolExecutionResult,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import type { CanonicalExternalAgentArtifactReference } from "../../src/core/connector/input.ts";
import {
	translateExternalModelProjection,
	type ExternalResolvedModelProjection,
} from "../../src/core/connector/model-projection.ts";
import type { CanonicalExternalConnectorMapping } from "../../src/core/connector/session-mapping.ts";
import {
	PRIVATE_CODEX_APP_SERVER_IDENTITY,
	PrivateCodexAppServerDriver,
	type PrivateCodexAppServerDriverOptions,
	type PrivateCodexAppServerTransport,
	type PrivateCodexAppServerTransportRequest,
} from "../../src/core/connector/vendor/codex.ts";
import type { SafeLeaseProjection } from "../../src/core/worker/protocol.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverSpawnRequest,
} from "../../src/core/connector/vendor/types.ts";
import * as packageEntry from "../../src/index.ts";

const now = "2026-08-28T00:00:00.000Z";
const providerId = "private-codex-fixture";
const threadId = "codex-thread-1";
const turnId = "codex-turn-1";

const attempt: Attempt = {
	schemaVersion: 1,
	attemptId: "attempt-codex-1",
	dispatchId: "dispatch-codex-1",
	taskId: "task-codex-1",
	providerId,
	bindingId: "binding-codex-1",
	bindingEpochIds: ["binding-epoch-codex-1"],
	status: "starting",
	startedAt: now,
};

const correlation: ExecutionCorrelation = {
	sessionId: "host-session-codex-1",
	laneId: "main",
	revision: 1,
	runId: "run-codex-1",
	operationId: "run-codex-1",
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
	protocol: { name: "codex-app-server", version: PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion },
	modelAccess: "agent_owned",
	resume: true,
	toolGateway: true,
	artifacts: false,
	images: false,
});

const artifactCapability: ConnectorCapabilitySnapshot = createConnectorCapabilitySnapshot({
	schemaVersion: 1,
	providerId,
	revision: 2,
	protocol: { name: "codex-app-server", version: PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion },
	modelAccess: "agent_owned",
	resume: true,
	toolGateway: true,
	artifacts: true,
	images: true,
});

const gatewayCapability: ConnectorCapabilitySnapshot = createConnectorCapabilitySnapshot({
	schemaVersion: 1,
	providerId,
	revision: 3,
	protocol: { name: "codex-app-server", version: PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion },
	modelAccess: "aos_gateway",
	resume: true,
	toolGateway: true,
	artifacts: true,
	images: true,
});

const modelProjection: ExternalResolvedModelProjection = {
	schemaVersion: 1,
	provider: "openai",
	model: "gpt-codex-fixture",
	effort: "high",
	serviceTier: "priority",
	fallbackDecision: { kind: "primary", reason: "fallback_not_used" },
	bindingDigest: { algorithm: "sha256", value: "a".repeat(64) },
};

const safeLeaseProjection: SafeLeaseProjection = {
	schemaVersion: 1,
	leaseId: "lease-codex-1",
	grantId: "grant-codex-1",
	bindingId: attempt.bindingId,
	scopeDigest: `sha256:${"b".repeat(64)}`,
	expiresAt: "2026-08-29T00:00:00.000Z",
	clientRequestId: "credential-codex-1",
};

const modelGateway = {
	schemaVersion: 1 as const,
	endpoint: "http://127.0.0.1:43124/v1",
	authorization: "Bearer aos_gateway_0123456789abcdef0123456789abcdef",
	leaseId: safeLeaseProjection.leaseId,
	modelBindingDigest: modelProjection.bindingDigest.value,
	expiresAt: safeLeaseProjection.expiresAt,
};

function digest(id: string): ArtifactDigest {
	return `sha256:${id}`;
}

function workspaceArtifact(
	kind: "file" | "image",
	mediaType: string,
	relativePath: string,
	id: string,
): CanonicalExternalAgentArtifactReference {
	return {
		schemaVersion: 1,
		artifactId: id,
		kind,
		digest: digest(id),
		mediaType,
		sizeBytes: 3,
		provenance: { source: "workspace", producer: "fixture", trust: "trusted" },
		readHandle: {
			kind: "workspace_relative",
			workspaceId: "workspace-main",
			relativePath,
			ref: `workspace-${id}`,
		},
	};
}

function spawnRequest(
	overrides: Partial<ExternalConnectorDriverSpawnRequest> = {},
): ExternalConnectorDriverSpawnRequest {
	return {
		attempt,
		correlation,
		input: { schemaVersion: 1, text: "Perform the Codex fixture task", artifacts: [] },
		capability,
		bindingDigest: "a".repeat(64),
		bindingRevision: 1,
		supervisorRef: "supervisor-codex-1",
		operationNonce: "nonce-codex-1",
		...overrides,
	};
}

function gatewaySpawnRequest(
	driver: PrivateCodexAppServerDriver,
	overrides: Partial<ExternalConnectorDriverSpawnRequest> = {},
): ExternalConnectorDriverSpawnRequest {
	const translated = translateExternalModelProjection(modelProjection, driver.modelSupportMatrix);
	if (!translated.ok) throw new Error("Codex fixture model projection did not translate");
	return spawnRequest({
		capability: gatewayCapability,
		modelProjection,
		modelTranslation: translated.translation,
		credential: safeLeaseProjection,
		modelGateway,
		...overrides,
	});
}

function mapping(): CanonicalExternalConnectorMapping {
	return {
		schemaVersion: 1,
		providerId,
		attemptId: attempt.attemptId,
		externalSessionId: threadId,
		externalTurnId: turnId,
		binding: { digest: { algorithm: "sha256", value: "a".repeat(64) }, revision: 1 },
		capability: { digest: capability.digest, revision: capability.revision },
		supervisor: { ref: "supervisor-codex-1", nonce: "nonce-codex-1" },
		createdAt: now,
	};
}

function turn(
	status: "inProgress" | "completed" | "interrupted" | "failed",
	id = turnId,
): Record<string, FoundationJsonValue> {
	return {
		id,
		items: [],
		itemsView: "full",
		status,
		error:
			status === "failed" ? { message: "redacted by driver", codexErrorInfo: null, additionalDetails: null } : null,
		startedAt: 1,
		completedAt: status === "inProgress" ? null : 2,
		durationMs: status === "inProgress" ? null : 1_000,
	};
}

function thread(id = threadId): Record<string, FoundationJsonValue> {
	return {
		id,
		extra: null,
		sessionId: "codex-session-tree-1",
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
		cwd: process.cwd(),
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

function threadResponse(id = threadId, resume = false): Record<string, FoundationJsonValue> {
	return {
		thread: thread(id),
		model: "gpt-fixture",
		modelProvider: "openai",
		serviceTier: null,
		cwd: process.cwd(),
		runtimeWorkspaceRoots: [process.cwd()],
		instructionSources: [],
		approvalPolicy: "on-request",
		approvalsReviewer: "user",
		sandbox: {
			type: "workspaceWrite",
			writableRoots: [process.cwd()],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		},
		activePermissionProfile: null,
		reasoningEffort: null,
		multiAgentMode: "explicitRequestOnly",
		...(resume ? { initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null } : {}),
	};
}

interface FakeCodexOptions {
	readonly identity?: PrivateCodexAppServerTransport["identity"];
	readonly resumeThreadId?: string;
	readonly autoComplete?: boolean;
	readonly threadStartResponse?: FoundationJsonValue;
	readonly turnStartResponse?: FoundationJsonValue;
	readonly turnStartedNotification?: FoundationJsonValue;
	readonly turnCompletedNotification?: FoundationJsonValue;
	readonly onTurnStarted?: (server: FakeCodexServer) => void | Promise<void>;
}

class FakeCodexServer {
	readonly messages: Array<Record<string, unknown>> = [];
	readonly #clientToServer = new TransformStream<Uint8Array, Uint8Array>();
	readonly #serverToClient = new TransformStream<Uint8Array, Uint8Array>();
	readonly #writer = this.#serverToClient.writable.getWriter();
	readonly #options: FakeCodexOptions;
	readonly #task: Promise<void>;
	#closed = false;

	constructor(options: FakeCodexOptions = {}) {
		this.#options = options;
		this.#task = this.#readClient();
	}

	transport(): PrivateCodexAppServerTransport {
		return {
			input: this.#serverToClient.readable,
			output: this.#clientToServer.writable,
			identity: this.#options.identity ?? PRIVATE_CODEX_APP_SERVER_IDENTITY,
			close: () => this.closeInput(),
		};
	}

	async send(value: FoundationJsonValue): Promise<void> {
		if (this.#closed) return;
		await this.#writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
	}

	async sendRaw(value: string): Promise<void> {
		if (this.#closed) return;
		await this.#writer.write(new TextEncoder().encode(value));
	}

	async closeInput(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#writer.close();
		this.#writer.releaseLock();
	}

	async waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		for (let index = 0; index < 200; index += 1) {
			const found = this.messages.find(predicate);
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		throw new Error("Fake Codex transcript did not receive the expected message");
	}

	async dispose(): Promise<void> {
		await this.closeInput().catch(() => undefined);
		const writer = this.#clientToServer.writable.getWriter();
		await writer.close().catch(() => undefined);
		writer.releaseLock();
		await this.#task.catch(() => undefined);
	}

	async #readClient(): Promise<void> {
		const reader = this.#clientToServer.readable.getReader();
		let buffered = "";
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
				buffered += new TextDecoder().decode(next.value);
				for (;;) {
					const newline = buffered.indexOf("\n");
					if (newline < 0) break;
					const frame = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					const message = JSON.parse(frame) as Record<string, unknown>;
					this.messages.push(message);
					await this.#accept(message);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async #accept(message: Record<string, unknown>): Promise<void> {
		const id = message.id;
		if (message.method === undefined && id !== undefined && Object.hasOwn(message, "result")) {
			await this.send({ method: "serverRequest/resolved", params: { threadId, requestId: id as string | number } });
			return;
		}
		if (message.method === "initialize") {
			await this.send({
				id: id as number,
				result: {
					userAgent: "codex-cli/0.149.0",
					codexHome: process.cwd(),
					platformFamily: "windows",
					platformOs: "windows",
				},
			});
			return;
		}
		if (message.method === "thread/start") {
			await this.send({ id: id as number, result: this.#options.threadStartResponse ?? threadResponse() });
			return;
		}
		if (message.method === "thread/resume") {
			await this.send({
				id: id as number,
				result: threadResponse(this.#options.resumeThreadId ?? threadId, true),
			});
			return;
		}
		if (message.method === "turn/start") {
			await this.send({
				id: id as number,
				result: this.#options.turnStartResponse ?? { turn: turn("inProgress") },
			});
			await this.send({
				method: "turn/started",
				params: this.#options.turnStartedNotification ?? { threadId, turn: turn("inProgress") },
			});
			await this.#options.onTurnStarted?.(this);
			if (this.#options.autoComplete !== false) {
				await this.send({
					method: "turn/completed",
					params: this.#options.turnCompletedNotification ?? { threadId, turn: turn("completed") },
				});
			}
			return;
		}
		if (message.method === "turn/interrupt") {
			await this.send({ id: id as number, result: {} });
			await this.send({ method: "turn/completed", params: { threadId, turn: turn("interrupted") } });
		}
	}
}

function driverOptions(
	server: FakeCodexServer,
	overrides: Partial<PrivateCodexAppServerDriverOptions> = {},
): PrivateCodexAppServerDriverOptions {
	return {
		providerId,
		transportFactory: async () => server.transport(),
		cwd: process.cwd(),
		roots: { workspace: process.cwd() },
		now: () => now,
		...overrides,
	};
}

async function nextEvent(iterator: AsyncIterator<FoundationJsonValue>): Promise<ExternalConnectorDriverEvent> {
	const next = await iterator.next();
	if (next.done) throw new Error("Codex event stream ended early");
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

function toolResult(
	event: Extract<ExternalConnectorDriverEvent, { readonly type: "tool_gateway_request" }>,
	result: FoundationJsonValue,
	ok = true,
): ToolExecutionResult {
	return {
		schemaVersion: 1,
		toolCallId: event.request.toolCallId,
		toolName: event.request.toolName,
		ok,
		sideEffectState: "none",
		result,
	};
}

describe("private Codex app-server connector", () => {
	it("runs the frozen initialize, thread, turn, and terminal JSONL transcript", async () => {
		const server = new FakeCodexServer();
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		const handle = await driver.spawn(spawnRequest());

		expect(handle).toEqual({
			externalSessionId: threadId,
			externalTurnId: turnId,
			supervisorRef: "supervisor-codex-1",
			operationNonce: "nonce-codex-1",
		});
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded", sideEffectState: "none" });
		expect(server.messages.map((message) => message.method).filter(Boolean)).toEqual([
			"initialize",
			"initialized",
			"thread/start",
			"turn/start",
		]);
		expect(server.messages.every((message) => !Object.hasOwn(message, "jsonrpc"))).toBe(true);
		await driver.dispose();
		await server.dispose();
	});

	it("projects workspace file and image artifacts into native Codex input", async () => {
		const server = new FakeCodexServer();
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		const file = workspaceArtifact("file", "application/pdf", "docs/evidence.pdf", "1".repeat(64));
		const image = workspaceArtifact("image", "image/png", "images/trace.png", "2".repeat(64));
		const handle = await driver.spawn(
			spawnRequest({
				capability: artifactCapability,
				input: { schemaVersion: 1, text: "Inspect both artifacts", artifacts: [file, image] },
			}),
		);

		expect(artifactCapability).toMatchObject({ artifacts: true, images: true });
		const turnStart = server.messages.find((message) => message.method === "turn/start");
		expect(turnStart?.params).toMatchObject({
			input: [
				{ type: "text", text: "Inspect both artifacts", text_elements: [] },
				{ type: "mention", name: "evidence.pdf", path: "docs/evidence.pdf" },
				{ type: "localImage", path: "images/trace.png" },
			],
		});
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		await driver.dispose();
		await server.dispose();
	});

	it.each([
		[
			"unsupported media",
			workspaceArtifact("file", "audio/wav", "audio/fixture.wav", "3".repeat(64)),
		],
		[
			"opaque artifact-store source",
			{
				...workspaceArtifact("image", "image/png", "images/opaque.png", "4".repeat(64)),
				provenance: { source: "artifact_store", producer: "fixture", trust: "trusted" },
				readHandle: { kind: "artifact_store", ref: "4".repeat(64) },
			} satisfies CanonicalExternalAgentArtifactReference,
		],
	] as const)("rejects %s with the stable protocol error", async (_name, artifact) => {
		const server = new FakeCodexServer();
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		await expect(
			driver.spawn(
				spawnRequest({
					capability: artifactCapability,
					input: { schemaVersion: 1, text: "Reject this artifact", artifacts: [artifact] },
				}),
			),
		).rejects.toMatchObject({ code: "external_protocol_unsupported" });
		expect(server.messages).toEqual([]);
		await driver.dispose();
		await server.dispose();
	});

	it("consumes an exact aos_gateway translation and material-free lease", async () => {
		const server = new FakeCodexServer({
			threadStartResponse: {
				...threadResponse(),
				thread: { ...thread(), modelProvider: modelProjection.provider },
				model: modelProjection.model,
				modelProvider: modelProjection.provider,
				serviceTier: modelProjection.serviceTier,
			},
		});
		const transportRequests: PrivateCodexAppServerTransportRequest[] = [];
		const driver = new PrivateCodexAppServerDriver({
			...driverOptions(server),
			transportFactory: async (request) => {
				transportRequests.push(request);
				return server.transport();
			},
		});
		const handle = await driver.spawn(gatewaySpawnRequest(driver));

		expect(gatewayCapability.modelAccess).toBe("aos_gateway");
		expect(transportRequests).toEqual([
			{
				mode: "start",
				supervisorRef: "supervisor-codex-1",
				operationNonce: "nonce-codex-1",
				credential: safeLeaseProjection,
				signal: undefined,
			},
		]);
		expect(server.messages.find((message) => message.method === "thread/start")?.params).toMatchObject({
			modelProvider: modelProjection.provider,
			model: modelProjection.model,
			serviceTier: modelProjection.serviceTier,
			allowProviderModelFallback: false,
		});
		expect(server.messages.find((message) => message.method === "turn/start")?.params).toMatchObject({
			model: modelProjection.model,
			effort: modelProjection.effort,
			serviceTier: modelProjection.serviceTier,
		});
		const wire = JSON.stringify(server.messages);
		expect(wire).not.toContain(safeLeaseProjection.leaseId);
		expect(wire).not.toContain(safeLeaseProjection.grantId);
		await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
		await driver.dispose();
		await server.dispose();
	});

	it("fails closed on aos_gateway translation drift before transport activation", async () => {
		const server = new FakeCodexServer();
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		const request = gatewaySpawnRequest(driver);
		const translation = request.modelTranslation!;
		await expect(
			driver.spawn({
				...request,
				modelTranslation: {
					...translation,
					fields: {
						...translation.fields,
						model: { ...translation.fields.model, value: "drifted-model" },
					},
				},
			}),
		).rejects.toMatchObject({ code: "external_protocol_unsupported" });
		expect(server.messages).toEqual([]);
		await driver.dispose();
		await server.dispose();
	});

	it("fails closed on the pinned schema identity and a missing resumed thread", async () => {
		const mismatch = new FakeCodexServer({
			identity: { cliVersion: "0.149.1", schemaSha256: PRIVATE_CODEX_APP_SERVER_IDENTITY.schemaSha256 },
		});
		const mismatchDriver = new PrivateCodexAppServerDriver(driverOptions(mismatch));
		await expect(mismatchDriver.spawn(spawnRequest())).rejects.toMatchObject({
			code: "external_protocol_unsupported",
		});

		const missing = new FakeCodexServer({ resumeThreadId: "different-thread" });
		const missingDriver = new PrivateCodexAppServerDriver(driverOptions(missing));
		await expect(missingDriver.connect(mapping())).rejects.toMatchObject({ code: "external_event_invalid" });
		await mismatchDriver.dispose();
		await missingDriver.dispose();
		await mismatch.dispose();
		await missing.dispose();
	});

	it("rejects malformed generated thread, response, and turn fields", async () => {
		const invalidThreadStatus = new FakeCodexServer({
			threadStartResponse: {
				...threadResponse(),
				thread: { ...thread(), status: { type: "unexpected" } },
			},
		});
		const invalidThreadDriver = new PrivateCodexAppServerDriver(driverOptions(invalidThreadStatus));
		await expect(invalidThreadDriver.spawn(spawnRequest())).rejects.toMatchObject({ code: "external_event_invalid" });

		const invalidSandbox = new FakeCodexServer({
			threadStartResponse: {
				...threadResponse(),
				sandbox: { type: "workspaceWrite", writableRoots: [7], networkAccess: false },
			},
		});
		const invalidSandboxDriver = new PrivateCodexAppServerDriver(driverOptions(invalidSandbox));
		await expect(invalidSandboxDriver.spawn(spawnRequest())).rejects.toMatchObject({ code: "external_event_invalid" });

		const invalidTurnTimestamp = new FakeCodexServer({
			turnStartResponse: { turn: { ...turn("inProgress"), startedAt: 1.5 } },
		});
		const invalidTurnDriver = new PrivateCodexAppServerDriver(driverOptions(invalidTurnTimestamp));
		await expect(invalidTurnDriver.spawn(spawnRequest())).rejects.toMatchObject({ code: "external_event_invalid" });

		const invalidTurnError = new FakeCodexServer({ autoComplete: false });
		const invalidTurnErrorDriver = new PrivateCodexAppServerDriver(driverOptions(invalidTurnError));
		const handle = await invalidTurnErrorDriver.spawn(spawnRequest());
		await invalidTurnError.send({
			method: "turn/completed",
			params: {
				threadId,
				turn: {
					...turn("failed"),
					error: {
						message: "redacted by driver",
						codexErrorInfo: { httpConnectionFailed: { httpStatusCode: "500" } },
						additionalDetails: null,
					},
				},
			},
		});
		await expect(invalidTurnErrorDriver.read(handle)).rejects.toMatchObject({ code: "external_event_invalid" });

		await invalidThreadDriver.dispose();
		await invalidSandboxDriver.dispose();
		await invalidTurnDriver.dispose();
		await invalidTurnErrorDriver.dispose();
		await invalidThreadStatus.dispose();
		await invalidSandbox.dispose();
		await invalidTurnTimestamp.dispose();
		await invalidTurnError.dispose();
	});

	it.each([
		["untrusted", "user", "accept", true],
		["on-request", "auto_review", "decline", true],
		["never", "guardian_subagent", "decline", false],
	] as const)(
		"routes %s approval with %s reviewer and an exact %s response",
		async (approvalPolicy, approvalsReviewer, decision, ok) => {
			const server = new FakeCodexServer({
				autoComplete: false,
				onTurnStarted: async (active) => {
					await active.send({
						method: "item/commandExecution/requestApproval",
						id: "approval-request-1",
						params: {
							threadId,
							turnId,
							itemId: "command-item-1",
							startedAtMs: 1,
							approvalId: null,
							environmentId: "workspace",
							reason: "fixture",
							command: "echo fixture",
							cwd: process.cwd(),
							commandActions: [],
						},
					});
				},
			});
			const driver = new PrivateCodexAppServerDriver(driverOptions(server, { approvalPolicy, approvalsReviewer }));
			const handle = await driver.spawn(spawnRequest());
			const events = driver.events(handle)[Symbol.asyncIterator]();
			const approval = await nextToolEvent(events);
			expect(approval.request).toMatchObject({
				namespace: "codex",
				toolName: "approval.command_execution",
			});
			await driver.write(handle, {
				schemaVersion: 1,
				kind: "tool_gateway_result",
				operationNonce: handle.operationNonce,
				result: toolResult(approval, { decision }, ok),
			});
			const response = await server.waitFor((message) => message.id === "approval-request-1");
			expect(response).toEqual({
				id: "approval-request-1",
				result: { decision: ok ? decision : "decline" },
			});
			const start = server.messages.find((message) => message.method === "thread/start");
			expect(start?.params).toMatchObject({ approvalPolicy, approvalsReviewer });
			await server.send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
			await expect(driver.read(handle)).resolves.toMatchObject({ status: "succeeded" });
			await driver.dispose();
			await server.dispose();
		},
	);

	it.each([
		["accept", "failed", "side_effect_unknown"],
		["decline", "cancelled", "none"],
	] as const)(
		"reports an interrupted %s command approval with truthful side effects",
		async (decision, status, sideEffectState) => {
			const server = new FakeCodexServer({
				autoComplete: false,
				onTurnStarted: async (active) => {
					await active.send({
						method: "item/commandExecution/requestApproval",
						id: `interrupted-${decision}`,
						params: {
							threadId,
							turnId,
							itemId: `command-${decision}`,
							startedAtMs: 1,
							approvalId: null,
							environmentId: "workspace",
							reason: "fixture",
							command: "echo fixture",
							cwd: process.cwd(),
							commandActions: [],
						},
					});
				},
			});
			const driver = new PrivateCodexAppServerDriver(driverOptions(server));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-interrupted-${decision}` }));
			const events = driver.events(handle)[Symbol.asyncIterator]();
			const approval = await nextToolEvent(events);
			await driver.write(handle, {
				schemaVersion: 1,
				kind: "tool_gateway_result",
				operationNonce: handle.operationNonce,
				result: toolResult(approval, { decision }),
			});
			expect(await nextEvent(events)).toMatchObject({ type: "progress", phase: "server_request_resolved" });
			await expect(driver.cancel(handle)).resolves.toMatchObject({
				status,
				sideEffectState,
				...(status === "failed" ? { error: { code: "side_effect_unknown" } } : {}),
			});
			await driver.dispose();
			await server.dispose();
		},
	);

	it("normalizes interrupted non-none Tool Gateway evidence to side_effect_unknown", async () => {
		const server = new FakeCodexServer({
			autoComplete: false,
			onTurnStarted: async (active) => {
				await active.send({
					method: "item/tool/call",
					id: 72,
					params: {
						threadId,
						turnId,
						callId: "unknown-side-effect-call",
						namespace: "github",
						tool: "write_issue",
						arguments: { issue: 7 },
					},
				});
			},
		});
		const driver = new PrivateCodexAppServerDriver(
			driverOptions(server, {
				dynamicTools: [
					{
						codexNamespace: "github",
						codexName: "write_issue",
						description: "Write one issue",
						inputSchema: { type: "object" },
						gateway: { namespace: "mcp.github", toolName: "write_issue" },
					},
				],
			}),
		);
		const handle = await driver.spawn(spawnRequest({ operationNonce: "nonce-unknown-side-effect" }));
		const events = driver.events(handle)[Symbol.asyncIterator]();
		const tool = await nextToolEvent(events);
		await driver.write(handle, {
			schemaVersion: 1,
			kind: "tool_gateway_result",
			operationNonce: handle.operationNonce,
			result: { ...toolResult(tool, { updated: true }), sideEffectState: "unknown" },
		});
		expect(await nextEvent(events)).toMatchObject({ type: "progress", phase: "server_request_resolved" });
		await expect(driver.cancel(handle)).resolves.toMatchObject({
			status: "failed",
			sideEffectState: "side_effect_unknown",
			error: { code: "side_effect_unknown" },
		});
		await driver.dispose();
		await server.dispose();
	});

	it("exposes only the exact Host-selected local and MCP Tool Gateway intersection", async () => {
		const server = new FakeCodexServer({
			autoComplete: false,
			onTurnStarted: async (active) => {
				await active.send({
					method: "item/tool/call",
					id: 70,
					params: {
						threadId,
						turnId,
						callId: "mcp-call-1",
						namespace: "github",
						tool: "read_issue",
						arguments: { issue: 7 },
					},
				});
			},
		});
		const driver = new PrivateCodexAppServerDriver(
			driverOptions(server, {
				dynamicTools: [
					{
						codexNamespace: null,
						codexName: "workspace_read",
						description: "Read workspace data",
						inputSchema: { type: "object" },
						gateway: { namespace: "workspace", toolName: "read" },
					},
					{
						codexNamespace: "github",
						codexName: "read_issue",
						description: "Read one issue",
						inputSchema: { type: "object" },
						gateway: { namespace: "mcp.github", toolName: "read_issue" },
					},
				],
			}),
		);
		const handle = await driver.spawn(spawnRequest());
		const tool = await nextToolEvent(driver.events(handle)[Symbol.asyncIterator]());
		expect(tool.request).toMatchObject({
			namespace: "mcp.github",
			toolName: "read_issue",
			originalArguments: { issue: 7 },
		});
		await driver.write(handle, {
			schemaVersion: 1,
			kind: "tool_gateway_result",
			operationNonce: handle.operationNonce,
			result: toolResult(tool, { title: "fixture" }),
		});
		await expect(server.waitFor((message) => message.id === 70)).resolves.toEqual({
			id: 70,
			result: {
				contentItems: [{ type: "inputText", text: '{"title":"fixture"}' }],
				success: true,
			},
		});
		await server.send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
		await driver.dispose();
		await server.dispose();
	});

	it("routes an exactly correlated MCP elicitation through the existing gateway", async () => {
		const server = new FakeCodexServer({
			autoComplete: false,
			onTurnStarted: async (active) => {
				await active.send({
					method: "mcpServer/elicitation/request",
					id: "mcp-elicitation-1",
					params: {
						threadId,
						turnId,
						serverName: "github",
						mode: "form",
						_meta: null,
						message: "Approve the MCP request",
						requestedSchema: { type: "object" },
					},
				});
			},
		});
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		const handle = await driver.spawn(spawnRequest());
		const events = driver.events(handle)[Symbol.asyncIterator]();
		const elicitation = await nextToolEvent(events);
		expect(elicitation.request).toMatchObject({
			namespace: "codex",
			toolName: "mcp.elicitation",
			originalArguments: { serverName: "github", mode: "form" },
		});
		await driver.write(handle, {
			schemaVersion: 1,
			kind: "tool_gateway_result",
			operationNonce: handle.operationNonce,
			result: toolResult(elicitation, { action: "decline", content: null, _meta: null }),
		});
		await expect(server.waitFor((message) => message.id === "mcp-elicitation-1")).resolves.toEqual({
			id: "mcp-elicitation-1",
			result: { action: "decline", content: null, _meta: null },
		});
		expect(await nextEvent(events)).toMatchObject({ type: "progress", phase: "server_request_resolved" });
		await expect(driver.cancel(handle)).resolves.toMatchObject({ status: "cancelled", sideEffectState: "none" });
		await driver.dispose();
		await server.dispose();
	});

	it("fails closed when Codex invokes a tool outside the selected intersection", async () => {
		const server = new FakeCodexServer({
			autoComplete: false,
			onTurnStarted: async (active) => {
				await active.send({
					method: "item/tool/call",
					id: 71,
					params: {
						threadId,
						turnId,
						callId: "unknown-call",
						namespace: "github",
						tool: "delete_repo",
						arguments: {},
					},
				});
			},
		});
		const driver = new PrivateCodexAppServerDriver(driverOptions(server));
		const handle = await driver.spawn(spawnRequest());
		await expect(driver.read(handle)).rejects.toMatchObject({ code: "external_event_invalid" });
		await driver.dispose();
		await server.dispose();
	});

	it("reports crash ambiguity, bounds terminal wait, and confirms interrupt truth", async () => {
		const crash = new FakeCodexServer({ autoComplete: false });
		const crashDriver = new PrivateCodexAppServerDriver(driverOptions(crash));
		const crashHandle = await crashDriver.spawn(spawnRequest());
		await crash.closeInput();
		await expect(crashDriver.read(crashHandle)).rejects.toMatchObject({ code: "external_event_invalid" });
		expect(await crashDriver.lookup(mapping())).toEqual({ status: "ambiguous" });

		const timeout = new FakeCodexServer({ autoComplete: false });
		const timeoutDriver = new PrivateCodexAppServerDriver(
			driverOptions(timeout, { limits: { operationTimeoutMs: 1_000, requestTimeoutMs: 5_000 } }),
		);
		const timeoutHandle = await timeoutDriver.spawn(spawnRequest({ operationNonce: "nonce-timeout" }));
		await expect(timeoutDriver.read(timeoutHandle)).rejects.toMatchObject({
			code: "external_resource_limit_exceeded",
		});

		const cancel = new FakeCodexServer({ autoComplete: false });
		const cancelDriver = new PrivateCodexAppServerDriver(driverOptions(cancel));
		const cancelHandle = await cancelDriver.spawn(spawnRequest({ operationNonce: "nonce-cancel" }));
		await expect(cancelDriver.cancel(cancelHandle)).resolves.toMatchObject({ status: "cancelled" });
		await crashDriver.dispose();
		await timeoutDriver.dispose();
		await cancelDriver.dispose();
		await crash.dispose();
		await timeout.dispose();
		await cancel.dispose();
	});

	it("rejects duplicate terminal, malformed, oversized, and unknown app-server frames without raw payloads", async () => {
		for (const variant of ["duplicate", "malformed", "oversized", "unknown"] as const) {
			const server = new FakeCodexServer({
				autoComplete: false,
				onTurnStarted: async (active) => {
					if (variant === "malformed") await active.sendRaw('{"secret":"raw-token"}\n');
					else if (variant === "oversized") await active.sendRaw(`${"x".repeat(4_096)}\n`);
					else if (variant === "unknown") {
						await active.send({ method: "account/updated", params: { secret: "raw-token" } });
					} else {
						await active.send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
						await active.send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
					}
				},
			});
			const driver = new PrivateCodexAppServerDriver(driverOptions(server, { limits: { maxFrameBytes: 2_048 } }));
			const handle = await driver.spawn(spawnRequest({ operationNonce: `nonce-${variant}` }));
			if (variant === "duplicate") {
				await new Promise((resolve) => setTimeout(resolve, 5));
				expect(
					await driver.lookup({
						...mapping(),
						supervisor: { ...mapping().supervisor, nonce: `nonce-${variant}` },
					}),
				).toEqual({
					status: "ambiguous",
				});
			} else {
				const failure = await driver.read(handle).catch((error: unknown) => error);
				expect(failure).toMatchObject({
					code: variant === "oversized" ? "external_frame_oversize" : "external_event_invalid",
				});
				expect(String(failure)).not.toContain("raw-token");
			}
			await driver.dispose();
			await server.dispose();
		}
	});

	it("keeps import and construction default-off with no binary, account, network, or AgentInstance activity", async () => {
		let opens = 0;
		const server = new FakeCodexServer();
		const driver = new PrivateCodexAppServerDriver({
			...driverOptions(server),
			transportFactory: async () => {
				opens += 1;
				return server.transport();
			},
		});
		expect(opens).toBe(0);
		expect("PrivateCodexAppServerDriver" in packageEntry).toBe(false);
		expect("createPrivateCodexExternalAgentConnector" in packageEntry).toBe(false);
		expect(Object.keys(packageEntry).some((key) => key.includes("AgentInstance"))).toBe(false);
		await driver.dispose();
		expect(opens).toBe(0);
		await server.dispose();
	});
});
