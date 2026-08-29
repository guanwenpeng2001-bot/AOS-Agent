/**
 * Foundation parity baseline (T0B): old-AgentSession recorder hosts.
 *
 * Implements {@link ScenarioHost} over the current AgentSession using the
 * existing test infrastructure:
 * - {@link OldAgentSessionHost}: suite-harness recorder (prompt, tool loop,
 *   queued follow-up, cancel/abort, compact).
 * - {@link ResumeAgentSessionHost}: runtime-factory recorder for the persisted
 *   session resume flow (switchSession over the same session file).
 *
 * Both hosts normalize unstable identifiers (entry ids, leaf ids, session ids,
 * tool call ids, run ids, response ids) and timestamps out of every recorded
 * observation, so the transcript fixture is deterministic.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@aos-agent/agent-core";
import type { Usage } from "@aos-agent/ai";
import {
	fakeAssistantMessage,
	registerFakeProvider,
	type FakeProviderRegistration,
	type FakeResponseStep,
} from "@aos-agent/ai/compat";
import { Type } from "typebox";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/index.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import type {
	NormalizedEvent,
	NormalizedMessage,
	NormalizedToolCall,
	ScenarioHost,
} from "./scenarios.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectionText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** Maps random tool call ids to a stable "tcN" sequence. */
class ToolCallIdNormalizer {
	private readonly byId = new Map<string, string>();
	private next = 1;

	map(id: string): string {
		const existing = this.byId.get(id);
		if (existing !== undefined) return existing;
		const assigned = `tc${this.next}`;
		this.next += 1;
		this.byId.set(id, assigned);
		return assigned;
	}
}

function normalizeAssistantContent(
	content: Array<{ type: string; text?: string; name?: string; id?: string; arguments?: unknown }>,
	normalizer: ToolCallIdNormalizer,
): { text: string; toolCalls?: NormalizedToolCall[] } {
	const text: string[] = [];
	const toolCalls: NormalizedToolCall[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
		} else if (part.type === "toolCall") {
			toolCalls.push({
				name: part.name ?? "unknown",
				args: isRecord(part.arguments) ? (JSON.parse(JSON.stringify(part.arguments)) as Record<string, unknown>) : {},
				id: normalizer.map(part.id ?? "tool"),
			});
		}
	}
	return { text: text.join("\n"), toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

function normalizeMessage(message: AgentMessage, normalizer: ToolCallIdNormalizer): NormalizedMessage {
	switch (message.role) {
		case "user":
			return { role: "user", text: projectionText(message.content) };
		case "assistant": {
			const parts = normalizeAssistantContent(
				message.content as Array<{ type: string; text?: string; name?: string; id?: string; arguments?: unknown }>,
				normalizer,
			);
			return {
				role: "assistant",
				text: parts.text,
				...(parts.toolCalls === undefined ? {} : { toolCalls: parts.toolCalls }),
				...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
			};
		}
		case "toolResult":
			return {
				role: "toolResult",
				text: projectionText(message.content),
				toolName: message.toolName ?? "",
				toolCallId: normalizer.map(message.toolCallId ?? "tool"),
			};
		case "bashExecution":
			return { role: "bashExecution", command: message.command, text: message.output };
		case "branchSummary":
			return { role: "branchSummary", summary: message.summary };
		case "compactionSummary":
			return { role: "compactionSummary", summary: message.summary, tokensBefore: message.tokensBefore ?? 0 };
		case "custom":
			return { role: "custom", customType: message.customType ?? "custom", text: projectionText(message.content) };
		default:
			return { role: "custom", customType: "unknown", text: "" };
	}
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return isRecord(args) ? (JSON.parse(JSON.stringify(args)) as Record<string, unknown>) : {};
}

/** Maps AgentSessionEvent into the normalized, id/timestamp-free trace. */
class EventNormalizer {
	private readonly toolCallIds = new ToolCallIdNormalizer();
	private collapseUpdate = false;

	normalize(event: AgentSessionEvent): NormalizedEvent | undefined {
		switch (event.type) {
			case "agent_start":
				return { type: "agent_start" };
			case "agent_end":
				return { type: "agent_end", willRetry: event.willRetry };
			case "agent_settled":
				return { type: "agent_settled" };
			case "turn_start":
				return { type: "turn_start" };
			case "turn_end":
				return { type: "turn_end" };
			case "message_start":
				this.collapseUpdate = false;
				return { type: "message_start", message: normalizeMessage(event.message, this.toolCallIds) };
			case "message_update": {
				if (this.collapseUpdate) return undefined;
				this.collapseUpdate = true;
				return { type: "message_update", role: "assistant" };
			}
			case "message_end":
				this.collapseUpdate = false;
				return { type: "message_end", message: normalizeMessage(event.message, this.toolCallIds) };
			case "tool_execution_start":
				this.collapseUpdate = false;
				return { type: "tool_execution_start", toolName: event.toolName, args: normalizeToolArgs(event.args) };
			case "tool_execution_update":
				this.collapseUpdate = false;
				return { type: "tool_execution_update", toolName: event.toolName };
			case "tool_execution_end":
				this.collapseUpdate = false;
				return {
					type: "tool_execution_end",
					toolName: event.toolName,
					isError: event.isError,
					resultText: isRecord(event.result)
						? projectionText(
								Array.isArray(event.result.content)
									? (event.result.content as Array<{ type: string; text?: string }>)
									: [],
							)
						: "",
				};
			case "queue_update":
				this.collapseUpdate = false;
				return { type: "queue_update", steering: [...event.steering], followUp: [...event.followUp] };
			case "compaction_start":
				this.collapseUpdate = false;
				return { type: "compaction_start", reason: event.reason };
			case "compaction_end":
				this.collapseUpdate = false;
				return {
					type: "compaction_end",
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					...(event.result === undefined ? {} : { summary: event.result.summary }),
				};
			default:
				return undefined;
		}
	}
}

function usageFrom(tokens: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

type InlineExtensionInput = (agent: ExtensionAPI) => void;

/** Suite-harness recorder over the current AgentSession. */
export class OldAgentSessionHost implements ScenarioHost {
	private readonly events: NormalizedEvent[] = [];
	private readonly eventNormalizer = new EventNormalizer();
	private harness: Harness | undefined;
	private requestedTools: AgentTool[] = [];
	private requestedExtensions: InlineExtensionInput[] = [];
	private requestedSettings: { compaction?: { keepRecentTokens: number } } = {};
	private pendingResponses: FakeResponseStep[] = [];
	private readonly blockingRelease: Map<string, () => void> = new Map();
	private readonly toolStartWaiters: Map<string, Array<() => void>> = new Map();

	addTool(tool: AgentTool): void {
		this.requestedTools = [...this.requestedTools, tool];
	}

	addBlockingTool(name: string): void {
		const tool: AgentTool = {
			name,
			label: name,
			description: `Block until released (${name})`,
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => {
					this.blockingRelease.set(name, resolve);
				});
				return {
					content: [{ type: "text", text: `${name} released` }],
					details: {},
				};
			},
		};
		this.requestedTools = [...this.requestedTools, tool];
	}

	setResponses(responses: FakeResponseStep[]): void {
		if (this.harness) {
			this.harness.setResponses(responses);
			return;
		}
		this.pendingResponses = responses;
	}

	setCompactionKeepRecentTokens(tokens: number): void {
		this.requestedSettings = { compaction: { keepRecentTokens: tokens } };
	}

	setSummaryProvider(
		handler: (customInstructions?: string) => Promise<{ summary: string; tokensBefore: number; usage?: Usage }>,
	): void {
		this.requestedExtensions = [
			...this.requestedExtensions,
			(agent: ExtensionAPI) => {
				agent.on("session_before_compact", async (event) => {
					const provided = await handler(event.customInstructions);
					return {
						compaction: {
							summary: provided.summary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: provided.tokensBefore,
							usage: provided.usage,
							details: {},
						},
					};
				});
			},
		];
	}

	async seedCompactableSession(): Promise<void> {
		const harness = await this.ensureHarness();
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		const assistant: AgentMessage = {
			...fakeAssistantMessage("assistant response to compact", { stopReason: "stop", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usageFrom(100),
		};
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	async waitForToolStart(toolName: string): Promise<void> {
		return new Promise<void>((resolve) => {
			const waiters = this.toolStartWaiters.get(toolName) ?? [];
			waiters.push(resolve);
			this.toolStartWaiters.set(toolName, waiters);
		});
	}

	async releaseTool(toolName: string): Promise<void> {
		const release = this.blockingRelease.get(toolName);
		if (release) {
			this.blockingRelease.delete(toolName);
			release();
		}
	}

	async prompt(text: string): Promise<void> {
		await (await this.ensureHarness()).session.prompt(text);
	}

	async steer(text: string): Promise<void> {
		await (await this.ensureHarness()).session.steer(text);
	}

	async followUp(text: string): Promise<void> {
		await (await this.ensureHarness()).session.followUp(text);
	}

	async queueNextTurn(customType: string, text: string): Promise<void> {
		await (await this.ensureHarness()).session.sendCustomMessage(
			{ customType, content: text, display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
	}

	async waitForIdle(): Promise<void> {
		await (await this.ensureHarness()).session.waitForIdle();
	}

	async abortActiveResponse(responseText: string): Promise<void> {
		const session = (await this.ensureHarness()).session;
		this.setResponses([fakeAssistantMessage(responseText)]);
		const firstUpdate = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const pending = session.prompt("cancel me");
		await firstUpdate;
		await session.abort();
		await pending;
	}

	async compact(customInstructions?: string): Promise<void> {
		await (await this.ensureHarness()).session.compact(customInstructions);
	}

	async resumeSession(): Promise<void> {
		throw new Error("OldAgentSessionHost does not support resumeSession; use ResumeAgentSessionHost");
	}

	async finalMessages(): Promise<NormalizedMessage[]> {
		const messages = (await this.ensureHarness()).session.messages;
		const normalizer = new ToolCallIdNormalizer();
		return messages.map((message) => normalizeMessage(message, normalizer));
	}

	eventTrace(): NormalizedEvent[] {
		return this.events.map((event) => ({ ...event }));
	}

	async pendingMessageCount(): Promise<number> {
		return (await this.ensureHarness()).session.pendingMessageCount;
	}

	async isStreaming(): Promise<boolean> {
		return (await this.ensureHarness()).session.isStreaming;
	}

	async isCompacting(): Promise<boolean> {
		return (await this.ensureHarness()).session.isCompacting;
	}

	async dispose(): Promise<void> {
		if (this.harness) {
			await this.harness.cleanup();
			this.harness = undefined;
		}
	}

	private async ensureHarness(): Promise<Harness> {
		if (this.harness) return this.harness;
		const harness = await createHarness({
			tools: this.requestedTools,
			extensionFactories: [...this.requestedExtensions],
			settings: this.requestedSettings,
		});
		if (this.pendingResponses.length > 0) {
			harness.setResponses(this.pendingResponses);
			this.pendingResponses = [];
		}
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				const waiters = this.toolStartWaiters.get(event.toolName);
				if (waiters) {
					this.toolStartWaiters.delete(event.toolName);
					for (const resolve of waiters) resolve();
				}
			}
			const normalized = this.eventNormalizer.normalize(event);
			if (normalized) {
				this.events.push(normalized);
			}
		});
		this.harness = harness;
		return harness;
	}
}

/** Runtime-factory recorder supporting the persisted-session resume flow. */
export class ResumeAgentSessionHost implements ScenarioHost {
	private readonly events: NormalizedEvent[] = [];
	private readonly eventNormalizer = new EventNormalizer();
	private runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	private fake: FakeProviderRegistration | undefined;
	private pendingResponses: FakeResponseStep[] = [];
	private readonly tempDir: string;

	constructor() {
		this.tempDir = join(tmpdir(), `aos-parity-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(this.tempDir, { recursive: true });
	}

	addTool(_tool: AgentTool): void {
		// The resume flow uses no custom tools.
	}

	addBlockingTool(_name: string): void {
		// The resume flow uses no blocking tools.
	}

	setResponses(responses: FakeResponseStep[]): void {
		if (this.fake) {
			this.fake.setResponses(responses);
			return;
		}
		this.pendingResponses = responses;
	}

	setCompactionKeepRecentTokens(_tokens: number): void {
		// Not exercised by the resume scenario.
	}

	setSummaryProvider(
		_handler: (customInstructions?: string) => Promise<{ summary: string; tokensBefore: number; usage?: Usage }>,
	): void {
		// Not exercised by the resume scenario.
	}

	async seedCompactableSession(): Promise<void> {
		// Not exercised by the resume scenario.
	}

	async waitForToolStart(_toolName: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support blocking tools");
	}

	async releaseTool(_toolName: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support blocking tools");
	}

	async prompt(text: string): Promise<void> {
		await (await this.ensureRuntime()).session.prompt(text);
	}

	async steer(_text: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support queueing while streaming");
	}

	async followUp(_text: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support queueing while streaming");
	}

	async queueNextTurn(_customType: string, _text: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support nextTurn messages");
	}

	async waitForIdle(): Promise<void> {
		await (await this.ensureRuntime()).session.waitForIdle();
	}

	async abortActiveResponse(_responseText: string): Promise<void> {
		throw new Error("ResumeAgentSessionHost does not support abort scenarios");
	}

	async compact(_customInstructions?: string): Promise<void> {
		await (await this.ensureRuntime()).session.compact();
	}

	async resumeSession(): Promise<void> {
		const runtime = await this.ensureRuntime();
		const sessionFile = runtime.session.sessionFile;
		if (!sessionFile) throw new Error("Resume requires a persisted session file");
		await runtime.switchSession(sessionFile);
		await runtime.session.bindExtensions({});
		this.attachToSession(runtime);
	}

	async finalMessages(): Promise<NormalizedMessage[]> {
		const messages = (await this.ensureRuntime()).session.messages;
		const normalizer = new ToolCallIdNormalizer();
		return messages.map((message) => normalizeMessage(message, normalizer));
	}

	eventTrace(): NormalizedEvent[] {
		return this.events.map((event) => ({ ...event }));
	}

	async pendingMessageCount(): Promise<number> {
		return (await this.ensureRuntime()).session.pendingMessageCount;
	}

	async isStreaming(): Promise<boolean> {
		return (await this.ensureRuntime()).session.isStreaming;
	}

	async isCompacting(): Promise<boolean> {
		return (await this.ensureRuntime()).session.isCompacting;
	}

	async dispose(): Promise<void> {
		if (this.runtime) {
			await this.runtime.dispose();
			this.runtime = undefined;
		}
		this.fake?.unregister();
		this.fake = undefined;
		if (existsSync(this.tempDir)) {
			rmSync(this.tempDir, { recursive: true, force: true });
		}
	}

	private async ensureRuntime(): Promise<Awaited<ReturnType<typeof createAgentSessionRuntime>>> {
		if (this.runtime) return this.runtime;
		const tempDir = this.tempDir;
		const events = this.events;

		const fake = registerFakeProvider({
			models: [{ id: "fake-1", reasoning: true }],
		});
		fake.setResponses([]);
		this.fake = fake;
		if (this.pendingResponses.length > 0) {
			fake.setResponses(this.pendingResponses);
			this.pendingResponses = [];
		}

		const recordSessionStart = (event: SessionStartEvent): void => {
			events.push({ type: "session_start", reason: event.reason });
		};
		const recordSessionShutdown = (event: SessionShutdownEvent): void => {
			events.push({ type: "session_shutdown", reason: event.reason });
		};
		const recordSessionBeforeSwitch = (event: SessionBeforeSwitchEvent): void => {
			events.push({ type: "session_before_switch", reason: event.reason });
		};

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage: AuthStorage.inMemory(),
			model: fake.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(agent: ExtensionAPI) => {
						agent.registerProvider(fake.getModel().provider, {
							baseUrl: fake.getModel().baseUrl,
							apiKey: "fake-key",
							api: fake.api,
							models: fake.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						agent.on("session_start", recordSessionStart);
						agent.on("session_shutdown", recordSessionShutdown);
						agent.on("session_before_switch", recordSessionBeforeSwitch);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			registerCandidateSession,
		}) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: runtimeOptions.model,
			});
			registerCandidateSession(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			session: { mode: "new", directory: join(tempDir, "sessions") },
		});
		await runtime.session.bindExtensions({});
		this.attachToSession(runtime);
		this.runtime = runtime;
		return runtime;
	}

	private attachToSession(runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>): void {
		runtime.session.subscribe((event) => {
			const normalized = this.eventNormalizer.normalize(event);
			if (normalized) {
				this.events.push(normalized);
			}
		});
	}
}
