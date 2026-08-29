/**
 * Foundation parity baseline (T0B): scripted observable scenarios.
 *
 * This module defines the *contract* the old AgentSession transcript fixture
 * records: a fixed set of scenario scripts written against a facade-neutral
 * {@link ScenarioHost}. The old-session recorder (`old-agent-session-host.ts`)
 * implements the host over the current AgentSession; later facade-parity tasks
 * (T3/T9) implement the same host over the new AgentHarness and compare their
 * recorded observations against the committed fixture
 * (`fixtures/old-agent-session.transcript.json`).
 *
 * All observations are plain JSON with unstable identifiers and timestamps
 * normalized away, so the fixture is deterministic and diffable.
 */

import type { AgentTool } from "@aos-agent/agent-core";
import type { Usage } from "@aos-agent/ai";
import { fakeAssistantMessage, fakeToolCall, type FakeResponseStep } from "@aos-agent/ai/compat";
import { Type } from "typebox";

/** A tool call block projected with a stable id ("tc1", "tc2", ...). */
export interface NormalizedToolCall {
	name: string;
	args: Record<string, unknown>;
	id: string;
}

/** A transcript message projected onto a stable, id/timestamp-free shape. */
export type NormalizedMessage =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; stopReason?: string; toolCalls?: NormalizedToolCall[] }
	| { role: "toolResult"; text: string; toolName: string; toolCallId: string }
	| { role: "bashExecution"; command: string; text: string }
	| { role: "branchSummary"; summary: string }
	| { role: "compactionSummary"; summary: string; tokensBefore: number }
	| { role: "custom"; customType: string; text: string };

/**
 * A stable projection of an observable session event. Streaming deltas
 * (`message_update`) are collapsed to a single marker per assistant stream
 * because the fake provider's delta chunking is intentionally random.
 */
export type NormalizedEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: NormalizedMessage }
	| { type: "message_update"; role: "assistant" }
	| { type: "message_end"; message: NormalizedMessage }
	| { type: "tool_execution_start"; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolName: string }
	| { type: "tool_execution_end"; toolName: string; isError: boolean; resultText: string }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			aborted: boolean;
			willRetry: boolean;
			summary?: string;
	  }
	| { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork" }
	| { type: "session_shutdown"; reason: "reload" | "new" | "resume" | "fork" | "quit" }
	| { type: "session_before_switch"; reason: "new" | "resume" };

/** A queue snapshot projected from queue_update events (only real snapshots). */
export interface QueueSnapshot {
	steering: string[];
	followUp: string[];
}

/**
 * Facade-neutral driving surface. The old-session recorder implements this
 * over the current AgentSession; the new-facade recorder will implement the
 * same surface over AgentHarness so the scripts run unchanged.
 */
export interface ScenarioHost {
	/** Queue scripted model responses (fake provider steps). */
	setResponses(responses: FakeResponseStep[]): void;
	/** Register a custom tool before the first prompt. */
	addTool(tool: AgentTool): void;
	/** Lower the compaction threshold so the seeded session becomes compactable. */
	setCompactionKeepRecentTokens(tokens: number): void;
	/** Provide the compaction summary instead of a second model call. */
	setSummaryProvider(
		handler: (customInstructions?: string) => Promise<{
			summary: string;
			tokensBefore: number;
			usage?: Usage;
		}>,
	): void;
	/** Seed the session with enough persisted messages that compaction can run. */
	seedCompactableSession(): Promise<void>;
	/** Register a blocking tool that waits until {@link releaseTool} is called. */
	addBlockingTool(name: string): void;
	/** Resolve once the named tool starts executing. */
	waitForToolStart(toolName: string): Promise<void>;
	/** Release the named blocking tool. */
	releaseTool(toolName: string): Promise<void>;
	/** Submit a user prompt while idle. */
	prompt(text: string): Promise<void>;
	/** Queue a steering message while a run is active; delivered before the next LLM call. */
	steer(text: string): Promise<void>;
	/** Queue a follow-up message while a run is active; delivered after the run settles. */
	followUp(text: string): Promise<void>;
	/** Queue a custom message for the next prompt. */
	queueNextTurn(customType: string, text: string): Promise<void>;
	/** Resolve once the session is idle (and after any queued work drains). */
	waitForIdle(): Promise<void>;
	/** Start a prompt and abort it after the first streamed delta. */
	abortActiveResponse(responseText: string): Promise<void>;
	/** Run a manual compaction. */
	compact(customInstructions?: string): Promise<void>;
	/** Persist the transcript and resume it from a fresh session (same file). */
	resumeSession(): Promise<void>;
	/** Project the current transcript. */
	finalMessages(): Promise<NormalizedMessage[]>;
	/** Project the observed event trace. */
	eventTrace(): NormalizedEvent[];
	pendingMessageCount(): Promise<number>;
	isStreaming(): Promise<boolean>;
	isCompacting(): Promise<boolean>;
	dispose(): Promise<void>;
}

/** Scenario script: drives the host and returns a deterministic observation. */
export interface ScenarioScript {
	id: string;
	description: string;
	coverage: string[];
	run(host: ScenarioHost): Promise<ScenarioObservation>;
}

export interface ScenarioObservation {
	finalMessages: NormalizedMessage[];
	eventTypes: string[];
	streamDeltasObserved: boolean;
	markers: Record<string, unknown>;
}

function queueSnapshots(events: NormalizedEvent[]): QueueSnapshot[] {
	const snapshots: QueueSnapshot[] = [];
	for (const event of events) {
		if (event.type === "queue_update") {
			snapshots.push({ steering: [...event.steering], followUp: [...event.followUp] });
		}
	}
	return snapshots;
}

function userTexts(messages: NormalizedMessage[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => (message.role === "user" ? message.text : ""));
}

function assistantTexts(messages: NormalizedMessage[]): string[] {
	return messages
		.filter((message) => message.role === "assistant")
		.map((message) => (message.role === "assistant" ? message.text : ""));
}

function roles(messages: NormalizedMessage[]): string[] {
	return messages.map((message) => message.role);
}

function streamDeltasObserved(events: NormalizedEvent[]): boolean {
	return events.some((event) => event.type === "message_update" && event.role === "assistant");
}

function toolExecutionStarts(events: NormalizedEvent[]): string[] {
	return events
		.filter((event): event is Extract<NormalizedEvent, { type: "tool_execution_start" }> =>
			event.type === "tool_execution_start"
		)
		.map((event) => event.toolName);
}

function compactionStartReasons(events: NormalizedEvent[]): string[] {
	return events
		.filter((event): event is Extract<NormalizedEvent, { type: "compaction_start" }> =>
			event.type === "compaction_start"
		)
		.map((event) => event.reason);
}

function compactionEndPayload(
	events: NormalizedEvent[],
): { reason: string; aborted: boolean; willRetry: boolean; summary?: string } | undefined {
	const event = events.find(
		(event): event is Extract<NormalizedEvent, { type: "compaction_end" }> => event.type === "compaction_end",
	);
	return event
		? { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, summary: event.summary }
		: undefined;
}

function sessionEventReasons(
	events: NormalizedEvent[],
	type: "session_start" | "session_shutdown" | "session_before_switch",
): string[] {
	return events
		.filter(
			(event): event is Extract<
				NormalizedEvent,
				{ type: "session_start" | "session_shutdown" | "session_before_switch" }
			> => event.type === type,
		)
		.map((event) => event.reason);
}

export const foundationParityScripts: ScenarioScript[] = [
	{
		id: "prompt-stream",
		description:
			"Idle prompt: a user message is appended, the model streams an assistant reply through message_start/message_update/message_end, the run ends with agent_end/agent_settled, and the session returns to idle.",
		coverage: ["prompt", "model stream", "message lifecycle", "agent settlement", "waitForIdle"],
		run: async (host) => {
			host.setResponses([fakeAssistantMessage("hello from the model")]);
			await host.prompt("hi");
			await host.waitForIdle();
			return {
				finalMessages: await host.finalMessages(),
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: streamDeltasObserved(host.eventTrace()),
				markers: {
					idleAfterPrompt: true,
					pendingAtEnd: await host.pendingMessageCount(),
					streamingAtEnd: await host.isStreaming(),
				},
			};
		},
	},
	{
		id: "tool-loop",
		description:
			"Tool loop: the model emits a tool call, the tool executes (tool_execution_start/end), a toolResult message is appended, and a follow-up LLM response completes the run.",
		coverage: ["tool loop", "tool execution lifecycle", "toolResult message", "tool call"],
		run: async (host) => {
			const toolRuns: string[] = [];
			host.addTool({
				name: "echo",
				label: "Echo",
				description: "Echo text back",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_toolCallId, params) => {
					const text =
						typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
					toolRuns.push(text);
					return {
						content: [{ type: "text", text: `echo:${text}` }],
						details: { text },
					};
				},
			});
			host.setResponses([
				fakeAssistantMessage(fakeToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
				fakeAssistantMessage("done"),
			]);
			await host.prompt("start");
			const finalMessages = await host.finalMessages();
			return {
				finalMessages,
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: streamDeltasObserved(host.eventTrace()),
				markers: {
					toolRuns,
					toolExecutionStarts: toolExecutionStarts(host.eventTrace()),
					finalRoles: roles(finalMessages),
				},
			};
		},
	},
	{
		id: "queued-follow-up",
		description:
			"Queued follow-up: while a run is blocked in a tool, steer and followUp messages are queued (queue_update events, pendingMessageCount), then delivered in order once the run settles.",
		coverage: ["queued follow-up", "steer", "followUp", "queue_update", "pendingMessageCount"],
		run: async (host) => {
			host.addBlockingTool("wait");
			host.setResponses([
				fakeAssistantMessage(fakeToolCall("wait", {}), { stopReason: "toolUse" }),
				fakeAssistantMessage("handled steer"),
				fakeAssistantMessage("handled follow-up"),
			]);
			const promptPromise = host.prompt("start");
			await host.waitForToolStart("wait");
			await host.steer("steer now");
			await host.followUp("follow-up later");
			const queuedCountWhileBlocked = await host.pendingMessageCount();
			const queueSnapshotsWhileBlocked = queueSnapshots(host.eventTrace());
			await host.releaseTool("wait");
			await promptPromise;
			await host.waitForIdle();
			const finalMessages = await host.finalMessages();
			return {
				finalMessages,
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: streamDeltasObserved(host.eventTrace()),
				markers: {
					queuedCountWhileBlocked,
					queueSnapshotsWhileBlocked,
					queueSnapshotsAll: queueSnapshots(host.eventTrace()),
					pendingAtEnd: await host.pendingMessageCount(),
					finalUserTexts: userTexts(finalMessages),
					finalAssistantTexts: assistantTexts(finalMessages),
				},
			};
		},
	},
	{
		id: "cancel-abort",
		description:
			"Cancel/abort: aborting an active streamed response settles the run with an assistant message whose stopReason is 'aborted'.",
		coverage: ["cancel/abort", "aborted assistant message", "run settlement"],
		run: async (host) => {
			await host.abortActiveResponse("x".repeat(20_000));
			await host.waitForIdle();
			const finalMessages = await host.finalMessages();
			const aborted = finalMessages.find((message) => message.role === "assistant");
			return {
				finalMessages,
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: streamDeltasObserved(host.eventTrace()),
				markers: {
					abortedStopReason: aborted?.role === "assistant" ? aborted.stopReason : undefined,
					finalRoles: roles(finalMessages),
					streamingAtEnd: await host.isStreaming(),
				},
			};
		},
	},
	{
		id: "compact",
		description:
			"Compact: a manual compaction with an extension-provided summary emits compaction_start/compaction_end(manual) and replaces the seeded transcript with a compactionSummary message.",
		coverage: ["compact", "compaction events", "compactionSummary message"],
		run: async (host) => {
			host.setCompactionKeepRecentTokens(1);
			host.setSummaryProvider(async (customInstructions) => ({
				summary: `summary from extension${customInstructions ? `: ${customInstructions}` : ""}`,
				tokensBefore: 1,
			}));
			host.setResponses([fakeAssistantMessage("reply after compaction")]);
			await host.seedCompactableSession();
			await host.compact();
			await host.waitForIdle();
			const finalMessages = await host.finalMessages();
			return {
				finalMessages,
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: false,
				markers: {
					compactionSummary: finalMessages
						.filter((message) => message.role === "compactionSummary")
						.map((message) => (message.role === "compactionSummary" ? message.summary : "")),
					compactionStartReasons: compactionStartReasons(host.eventTrace()),
					compactionEndPayload: compactionEndPayload(host.eventTrace()),
					finalRoles: roles(finalMessages),
				},
			};
		},
	},
	{
		id: "resume",
		description:
			"Resume: a persisted transcript is restored by a fresh session over the same file (session_start reason 'resume') and the conversation continues without losing prior messages.",
		coverage: ["resume", "session persistence", "session_start(resume)"],
		run: async (host) => {
			host.setResponses([fakeAssistantMessage("first reply")]);
			await host.prompt("first question");
			const beforeResume = await host.finalMessages();
			await host.resumeSession();
			const restored = await host.finalMessages();
			host.setResponses([fakeAssistantMessage("reply after resume")]);
			await host.prompt("second question");
			await host.waitForIdle();
			const finalMessages = await host.finalMessages();
			return {
				finalMessages,
				eventTypes: host.eventTrace().map((event) => event.type),
				streamDeltasObserved: streamDeltasObserved(host.eventTrace()),
				markers: {
					beforeResumeRoles: roles(beforeResume),
					restoredRoles: roles(restored),
					sessionStartReasons: sessionEventReasons(host.eventTrace(), "session_start"),
					sessionShutdownReasons: sessionEventReasons(host.eventTrace(), "session_shutdown"),
					sessionBeforeSwitchReasons: sessionEventReasons(host.eventTrace(), "session_before_switch"),
					finalUserTexts: userTexts(finalMessages),
				},
			};
		},
	},
];
