import { Buffer } from "node:buffer";
import type { AgentTool } from "@aos-agent/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@aos-agent/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_SNAPSHOT_CUSTOM_TYPE } from "../../src/core/context-engine.ts";
import { EXECUTION_ASSOCIATION_CUSTOM_TYPE } from "../../src/core/execution-association.ts";
import { POLICY_BINDING_CUSTOM_TYPE } from "../../src/core/execution-policy.ts";
import { MODEL_ATTEMPT_CUSTOM_TYPE, MODEL_BINDING_CUSTOM_TYPE } from "../../src/core/model-broker-ledger.ts";
import { FOUNDATION_DURABLE_CUSTOM_TYPE } from "../../src/core/session-manager-storage.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

interface ControlledBashInvocation {
	command: string;
	signal: AbortSignal | undefined;
	finish: () => void;
}

function createControlledBashOperations(invocations: ControlledBashInvocation[]): BashOperations {
	return {
		exec: async (command, _cwd, options) => {
			return await new Promise<{ exitCode: number | null }>((resolve) => {
				invocations.push({
					command,
					signal: options.signal,
					finish: () => resolve({ exitCode: 0 }),
				});
			});
		},
	};
}

async function waitForInvocationCount(invocations: ControlledBashInvocation[], count: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (invocations.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for ${count} bash invocation(s)`);
}

function getInvocationByCommand(
	invocations: ControlledBashInvocation[],
	command: string,
): ControlledBashInvocation {
	const invocation = invocations.find((candidate) => candidate.command === command);
	if (invocation === undefined) {
		throw new Error(`Timed out waiting for bash invocation: ${command}`);
	}
	return invocation;
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let markOperationStarted: (() => void) | undefined;
		const operationStarted = new Promise<void>((resolve) => {
			markOperationStarted = resolve;
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				markOperationStarted?.();
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					if (options.signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await operationStarted;
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("keeps newer bash execution tracked when an older execution finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		await waitForInvocationCount(invocations, 2);
		const firstInvocation = getInvocationByCommand(invocations, "first");
		const secondInvocation = getInvocationByCommand(invocations, "second");
		firstInvocation.finish();
		const firstResult = await firstBash;
		const runningAfterFirstSettles = harness.session.isBashRunning;

		harness.session.abortBash();
		const secondWasAborted = secondInvocation.signal?.aborted;
		secondInvocation.finish();
		const secondResult = await secondBash;

		expect(firstResult.cancelled).toBe(false);
		expect(runningAfterFirstSettles).toBe(true);
		expect(secondWasAborted).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("aborts all active bash executions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		await waitForInvocationCount(invocations, 2);
		harness.session.abortBash();
		const abortedSignals = invocations.map((invocation) => invocation.signal?.aborted);
		for (const invocation of invocations) {
			invocation.finish();
		}
		const results = await Promise.all([firstBash, secondBash]);

		expect(abortedSignals).toEqual([true, true]);
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		const userFacingEntries = entries.filter(
			(entry) =>
				entry.type !== "custom" ||
				(entry.customType !== MODEL_BINDING_CUSTOM_TYPE &&
					entry.customType !== MODEL_ATTEMPT_CUSTOM_TYPE &&
					entry.customType !== EXECUTION_ASSOCIATION_CUSTOM_TYPE &&
					entry.customType !== POLICY_BINDING_CUSTOM_TYPE &&
					entry.customType !== FOUNDATION_DURABLE_CUSTOM_TYPE &&
					!entry.customType.startsWith("harness.config.")),
		);
		expect(userFacingEntries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"custom",
			"message",
			"message",
			"custom",
			"message",
		]);
		const semanticEntries = userFacingEntries.filter((entry) => entry.type !== "custom");
		expect(semanticEntries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(
			semanticEntries.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
		).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const contextSnapshots = userFacingEntries.filter((entry) => entry.type === "custom");
		expect(contextSnapshots).toHaveLength(2);
		for (const entry of contextSnapshots) {
			expect(entry.customType).toBe(CONTEXT_SNAPSHOT_CUSTOM_TYPE);
			expect(entry.data).toMatchObject({
				schemaVersion: 1,
				purpose: "agent_turn",
				sessionId: harness.session.sessionId,
			});
		}
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const lastEntry = harness.sessionManager.getEntries().filter((entry) => entry.type === "message").at(-1);
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") {
			expect(lastEntry.message.role).toBe("assistant");
			if (lastEntry.message.role === "assistant") {
				expect(lastEntry.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("streams bash output to the callback and session events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const callbackDeltas: string[] = [];
		const eventUpdates: Array<{ id: string | undefined; delta: string }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_execution_update") {
				eventUpdates.push({ id: event.id, delta: event.delta });
			}
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello "));
				options.onData(Buffer.from("world"));
				return { exitCode: 0 };
			},
		};

		await harness.session.executeBash("custom", (delta) => callbackDeltas.push(delta), {
			id: "bash-1",
			operations,
		});
		unsubscribe();

		expect(callbackDeltas).toEqual(["hello ", "world"]);
		expect(eventUpdates).toEqual([
			{ id: "bash-1", delta: "hello " },
			{ id: "bash-1", delta: "world" },
		]);
	});
});
