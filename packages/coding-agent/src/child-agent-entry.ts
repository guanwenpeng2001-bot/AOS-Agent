/**
 * Trusted Child Agent process entry.
 *
 * Composition injects the runtime. This module never loads provider code,
 * executable paths, or configuration from RPC, env, or model text.
 *
 * Cancel and close are applied immediately so they can abort an in-flight
 * turn. Ordinary initialize/turn frames stay serialized on inputTail.
 */

import { stdin, stderr, stdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
	AgentHarness,
	canonicalFoundationJson,
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	type AgentHarness as AgentHarnessType,
	type AgentHarnessOptions,
	type AttemptReceipt,
	type BudgetUsage,
	type HarnessTool,
	type Result as ResultValue,
} from "@aos-agent/agent-core";
import { contentText, type Api, type Model, type Models } from "@aos-agent/ai";
import { attachJsonlLineReader, createJsonlLineWriter } from "./modes/rpc/jsonl.ts";
import {
	CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES,
	ChildAgentProtocolSession,
	parseChildAgentFrame,
	serializeChildAgentFrameLine,
	type ChildAgentCancelRequest,
	type ChildAgentEventFrame,
	type ChildAgentInitializeRequest,
	type ChildAgentTurnCompletedEvent,
	type ChildAgentTurnRequest,
} from "./core/subagent-fork-protocol.ts";

export interface ChildAgentTurnResult {
	readonly receipt: AttemptReceipt;
	readonly usage: BudgetUsage;
	readonly stopReason: ChildAgentTurnCompletedEvent["stopReason"];
	readonly output?: string;
}

export interface ChildAgentEntryRuntime {
	initialize(frame: ChildAgentInitializeRequest): Promise<ResultValue<void, FoundationError>>;
	turn(
		frame: ChildAgentTurnRequest,
		signal: AbortSignal,
	): Promise<ResultValue<ChildAgentTurnResult, FoundationError>>;
	cancel(frame: ChildAgentCancelRequest): Promise<ResultValue<void, FoundationError>>;
	close(): Promise<void>;
}

export interface ChildAgentEntryOptions {
	readonly runtime: ChildAgentEntryRuntime;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly diagnostic?: Writable;
	readonly now?: () => string;
}

export interface ChildAgentHarnessRuntimeAuthority {
	readonly models: Models;
	readonly resolveModel: (selection: ChildAgentInitializeRequest["model"]) =>
		ResultValue<Model<Api>, FoundationError> | Promise<ResultValue<Model<Api>, FoundationError>>;
	readonly streamFunction: NonNullable<AgentHarnessOptions["streamFunction"]>;
	readonly tools?: AgentHarnessOptions["tools"];
	readonly toolContext?: AgentHarnessOptions["toolContext"];
	readonly retry?: AgentHarnessOptions["retry"];
	readonly now?: () => string;
}

interface ExactTurnUsageV1 {
	tokens: number;
	costUsd: number;
	modelCalls: number;
	toolCalls: number;
	exact: boolean;
	readonly pending: Promise<void>[];
	readonly toolExecutions: ToolExecutionEvidenceV1[];
}

interface ToolExecutionEvidenceV1 {
	readonly declaredNone: boolean;
	settled: boolean;
}

/** AgentHarness runtime backed by a process-composed provider/model authority. */
export class AgentHarnessChildAgentEntryRuntime implements ChildAgentEntryRuntime {
	private initialized: ChildAgentInitializeRequest | undefined;
	private harness: AgentHarnessType | undefined;
	private activeUsage: ExactTurnUsageV1 | undefined;
	private readonly authority: ChildAgentHarnessRuntimeAuthority;

	constructor(authority: ChildAgentHarnessRuntimeAuthority) {
		this.authority = authority;
	}

	async initialize(frame: ChildAgentInitializeRequest): Promise<ResultValue<void, FoundationError>> {
		if (this.harness !== undefined) {
			return Result.err(new FoundationError("subagent_spawn_invalid", "Child Agent runtime is already initialized"));
		}
		const selected = await this.authority.resolveModel(frame.model);
		if (!selected.ok) return selected;
		if (selected.value.provider !== frame.model.provider || selected.value.id !== frame.model.model) {
			return Result.err(new FoundationError("subagent_provider_unavailable", "Child Agent model authority returned a different provider or model"));
		}
		try {
			const inheritedMessages = structuredClone(frame.contextProjection.messages);
			const tools: HarnessTool[] | undefined = this.authority.tools?.map((tool) => ({
				...tool,
				execute: async (toolCallId, params, signal, onUpdate) => {
					const usage = this.activeUsage;
					if (usage === undefined) {
						throw new FoundationError("quota_attribution_error", "Child Agent tool call occurred outside an active turn");
					}
					usage.toolCalls += 1;
					const evidence: ToolExecutionEvidenceV1 = {
						declaredNone: tool.sideEffectState === "none",
						settled: false,
					};
					usage.toolExecutions.push(evidence);
					try {
						return await tool.execute(toolCallId, params, signal, onUpdate);
					} finally {
						evidence.settled = true;
					}
				},
			}));
			const streamFunction: NonNullable<AgentHarnessOptions["streamFunction"]> = async (model, context, options) => {
				const usage = this.activeUsage;
				if (usage === undefined) {
					throw new FoundationError("quota_attribution_error", "Child Agent model call occurred outside an active turn");
				}
				usage.modelCalls += 1;
				try {
					const stream = await this.authority.streamFunction(model, context, options);
					usage.pending.push(
						stream.result().then(
							(message) => {
								const tokens = message.usage.totalTokens;
								const costUsd = message.usage.cost.total;
								if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(costUsd) || costUsd < 0) {
									usage.exact = false;
									return;
								}
								usage.tokens += tokens;
								usage.costUsd += costUsd;
							},
							() => {
								usage.exact = false;
							},
						),
					);
					return stream;
				} catch (error) {
					usage.exact = false;
					throw error;
				}
			};
			const created = await AgentHarness.create({
				session: new Session(new InMemorySessionStorage({ id: frame.correlation.sessionId, createdAt: Date.now() })),
				models: this.authority.models,
				model: selected.value,
				drive: "automatic",
				streamFunction,
				...(tools === undefined ? {} : { tools }),
				...(this.authority.toolContext === undefined ? {} : { toolContext: this.authority.toolContext }),
				...(this.authority.retry === undefined ? {} : { retry: this.authority.retry }),
				systemPrompt: canonicalFoundationJson(frame.contextProjection.runtime),
				contextPreparation: ({ context }) => ({
					...context,
					messages: [...structuredClone(inheritedMessages), ...context.messages],
				}),
			});
			this.initialized = frame;
			this.harness = created.harness;
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(error instanceof FoundationError
				? error
				: new FoundationError("subagent_lost", "Child Agent harness initialization failed", { cause: error }));
		}
	}

	async turn(
		_frame: ChildAgentTurnRequest,
		signal: AbortSignal,
	): Promise<ResultValue<ChildAgentTurnResult, FoundationError>> {
		const initialized = this.initialized;
		const harness = this.harness;
		if (initialized === undefined || harness === undefined) {
			return Result.err(new FoundationError("subagent_lost", "Child Agent harness is not initialized"));
		}
		if (this.activeUsage !== undefined) {
			return Result.err(new FoundationError("subagent_conflict", "Child Agent harness already has an active turn"));
		}
		const exactUsage: ExactTurnUsageV1 = {
			tokens: 0,
			costUsd: 0,
			modelCalls: 0,
			toolCalls: 0,
			exact: true,
			pending: [],
			toolExecutions: [],
		};
		this.activeUsage = exactUsage;
		const abort = (): void => {
			void harness.abort();
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const deadlineRemaining = _frame.deadlineAt === undefined ? undefined : Date.parse(_frame.deadlineAt) - Date.now();
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		if (deadlineRemaining !== undefined) {
			if (!Number.isFinite(deadlineRemaining) || deadlineRemaining <= 0) abort();
			else deadlineTimer = setTimeout(abort, deadlineRemaining);
		}
		try {
			const prompted = await harness.prompt(_frame.input.text);
			if (!prompted.ok) {
				return Result.err(new FoundationError("subagent_lost", "Child Agent harness rejected the turn"));
			}
			await Promise.all(exactUsage.pending);
			if (!exactUsage.exact || exactUsage.modelCalls === 0) {
				return Result.err(new FoundationError("quota_attribution_error", "Child Agent turn usage could not be established exactly"));
			}
			const harnessStatus: AttemptReceipt["status"] = prompted.value.kind === "completed"
				? "succeeded"
				: prompted.value.kind === "aborted"
					? "cancelled"
					: prompted.value.kind === "suspended"
						? "suspended"
						: "failed";
			const sideEffectUnknown = exactUsage.toolExecutions.some((execution) =>
				!execution.declaredNone || !execution.settled,
			);
			const status: AttemptReceipt["status"] = sideEffectUnknown ? "failed" : harnessStatus;
			const finalMessage = "finalMessage" in prompted.value ? prompted.value.finalMessage : undefined;
			const sideEffectError = {
				code: "side_effect_unknown",
				message: "Child Agent tool execution side effect could not be proven absent at turn settlement",
				category: "side_effect_unknown" as const,
				retryable: false,
			};
			const harnessError = prompted.value.kind === "failed"
				? { code: prompted.value.error.code, message: prompted.value.error.message, retryable: false }
				: undefined;
			const receiptError = sideEffectUnknown ? sideEffectError : harnessError;
			const output = sideEffectUnknown
				? `${sideEffectError.code}: ${sideEffectError.message}`
				: prompted.value.kind === "failed"
				? `${prompted.value.error.code}: ${prompted.value.error.message}${finalMessage?.errorMessage === undefined ? "" : ` (${finalMessage.errorMessage})`}`
				: finalMessage === undefined
					? undefined
					: contentText(finalMessage.content);
			const usage: BudgetUsage = {
				tokens: exactUsage.tokens,
				costUsd: exactUsage.costUsd,
				modelCalls: exactUsage.modelCalls,
				toolCalls: exactUsage.toolCalls,
			};
			const attemptReceiptId = `attempt-receipt:${initialized.attemptId}`;
			const stopReason: ChildAgentTurnCompletedEvent["stopReason"] = status === "failed"
				? "error"
				: status === "cancelled"
					? "aborted"
					: status === "suspended"
						? "tool_use"
						: finalMessage?.stopReason === "length"
							? "length"
							: "stop";
			return Result.ok({
				receipt: {
					schemaVersion: 1,
					attemptReceiptId,
					taskId: initialized.taskId,
					dispatchId: initialized.dispatchId,
					attemptId: initialized.attemptId,
					providerId: initialized.providerId,
					agentInstanceId: initialized.agentInstanceId,
					bindingId: initialized.bindingId,
					bindingEpochIds: [initialized.bindingEpochId],
					status,
					workerReceiptRefs: [],
					artifacts: [],
					provenance: {
						producerKind: "agent_executor",
						providerId: initialized.providerId,
						producedAt: (this.authority.now ?? (() => new Date().toISOString()))(),
						correlation: { ...initialized.correlation, attemptReceiptId },
					},
					sideEffectState: sideEffectUnknown ? "side_effect_unknown" : "none",
					...(receiptError === undefined ? {} : { error: receiptError }),
				},
				usage,
				stopReason,
				...(output === undefined ? {} : { output }),
			});
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			signal.removeEventListener("abort", abort);
			this.activeUsage = undefined;
		}
	}

	async cancel(_frame: ChildAgentCancelRequest): Promise<ResultValue<void, FoundationError>> {
		if (this.harness === undefined) {
			return Result.err(new FoundationError("subagent_cancel_failed", "Child Agent harness is not initialized"));
		}
		return Result.ok(undefined);
	}

	async close(): Promise<void> {
		const harness = this.harness;
		this.harness = undefined;
		this.initialized = undefined;
		this.activeUsage = undefined;
		if (harness !== undefined) await harness.close();
	}
}

interface ActiveTurnV1 {
	readonly requestId: string;
	readonly spawnId: string;
	readonly attemptId: string;
}

export function runChildAgentProcess(options: ChildAgentEntryOptions): Promise<void> {
	const input = options.input ?? stdin;
	const output = options.output ?? stdout;
	const diagnostic = options.diagnostic ?? stderr;
	const now = options.now ?? (() => new Date().toISOString());
	const writer = createJsonlLineWriter<ChildAgentEventFrame>(output, {
		maxFrameBytes: CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES,
	});
	const protocol = new ChildAgentProtocolSession();
	const runtime = options.runtime;
	let detachInput = (): void => undefined;
	let inputTail = Promise.resolve();
	let controlTail = Promise.resolve();
	let settled = false;
	let resolveRun: () => void = () => undefined;
	let turnController: AbortController | undefined;
	let activeTurn: ActiveTurnV1 | undefined;
	let terminalEmitted = false;
	const run = new Promise<void>((resolve) => {
		resolveRun = resolve;
	});

	const writeDiagnostic = (line: string): void => {
		try {
			diagnostic.write(line);
		} catch {
			// Stderr failure cannot alter the protocol stream.
		}
	};

	const emit = (frame: ChildAgentEventFrame): void => {
		try {
			writer.writeLine(serializeChildAgentFrameLine(frame));
		} catch {
			protocol.markLost();
			writeDiagnostic("child-agent protocol emit failed\n");
		}
	};

	const settle = (): void => {
		if (settled) return;
		settled = true;
		turnController?.abort();
		detachInput();
		input.pause();
		void runtime.close().catch(() => undefined);
		void writer
			.waitForDrain()
			.catch(() => undefined)
			.then(() => {
				writer.detach();
				resolveRun();
			});
	};

	const failLost = (spawnId: string, requestId?: string): void => {
		if (settled) return;
		protocol.markLost();
		emit({
			type: "error",
			spawnId,
			code: "subagent_lost",
			...(requestId === undefined ? {} : { requestId }),
		});
		settle();
	};

	const sessionIsTerminal = (): boolean =>
		settled ||
		terminalEmitted ||
		protocol.state.receiptReceived ||
		protocol.state.phase === "lost" ||
		protocol.state.disconnected;

	const emitChild = (frame: ChildAgentEventFrame): boolean => {
		if (sessionIsTerminal() && frame.type !== "closed") return false;
		const applied = protocol.receiveChildFrame(frame);
		if (!applied.ok) {
			failLost(protocol.state.spawnId ?? "unknown", "requestId" in frame ? frame.requestId : undefined);
			return false;
		}
		emit(frame);
		if (frame.type === "receipt") terminalEmitted = true;
		return true;
	};

	const abortActiveTurn = (): void => {
		turnController?.abort();
	};

	const handleLine = async (line: string): Promise<void> => {
		if (settled) return;
		const parsed = parseChildAgentFrame(line);
		if (!parsed.ok) {
			failLost(protocol.state.spawnId ?? "unknown");
			return;
		}
		if (
			parsed.value.type !== "initialize" &&
			parsed.value.type !== "turn" &&
			parsed.value.type !== "cancel" &&
			parsed.value.type !== "close"
		) {
			failLost(protocol.state.spawnId ?? "unknown");
			return;
		}
		const accepted = protocol.receiveHostFrame(parsed.value);
		if (!accepted.ok) {
			failLost(protocol.state.spawnId ?? parsed.value.spawnId, parsed.value.requestId);
			return;
		}
		const frame = accepted.value.frame;
		if (frame.type === "initialize") {
			const initializedResult = await runtime.initialize(frame);
			if (sessionIsTerminal()) return;
			if (!initializedResult.ok) {
				failLost(frame.spawnId, frame.requestId);
				return;
			}
			const ready = {
				type: "ready" as const,
				requestId: frame.requestId,
				spawnId: frame.spawnId,
				protocolVersion: 1 as const,
				features: frame.features,
				providerId: frame.providerId,
				agentInstanceId: frame.agentInstanceId,
			};
			emitChild(ready);
			return;
		}
		if (frame.type === "turn") {
			turnController?.abort();
			turnController = new AbortController();
			const turn: ActiveTurnV1 = {
				requestId: frame.requestId,
				spawnId: frame.spawnId,
				attemptId: frame.attemptId,
			};
			activeTurn = turn;
			terminalEmitted = false;
			const started = {
				type: "turn.started" as const,
				requestId: frame.requestId,
				spawnId: frame.spawnId,
				attemptId: frame.attemptId,
				at: now(),
			};
			if (!emitChild(started)) return;
			const turned = await runtime.turn(frame, turnController.signal);
			if (sessionIsTerminal() || activeTurn !== turn) return;
			if (!turned.ok) {
				failLost(frame.spawnId, frame.requestId);
				return;
			}
			const stopReason: ChildAgentTurnCompletedEvent["stopReason"] = turned.value.receipt.status === "failed"
				? "error"
				: turned.value.receipt.status === "cancelled"
					? "aborted"
					: turned.value.receipt.status === "suspended"
						? "tool_use"
						: turned.value.stopReason === "length"
							? "length"
							: "stop";
			const completed = {
				type: "turn.completed" as const,
				requestId: frame.requestId,
				spawnId: frame.spawnId,
				attemptId: frame.attemptId,
				stopReason,
				usage: turned.value.usage,
				at: now(),
				...(turned.value.output === undefined ? {} : { output: turned.value.output }),
			};
			if (!emitChild(completed)) return;
			if (!emitChild({ type: "receipt", requestId: frame.requestId, receipt: turned.value.receipt })) return;
			activeTurn = undefined;
			return;
		}
		if (frame.type === "cancel") {
			abortActiveTurn();
			const cancelled = await runtime.cancel(frame);
			if (sessionIsTerminal()) return;
			if (!cancelled.ok) {
				failLost(frame.spawnId, frame.requestId);
				return;
			}
			return;
		}
		abortActiveTurn();
		await runtime.close();
		if (settled) return;
		const closed = { type: "closed" as const, requestId: frame.requestId, spawnId: frame.spawnId };
		if (!emitChild(closed)) return;
		settle();
	};

	detachInput = attachJsonlLineReader(
		input,
		(line) => {
			const parsed = parseChildAgentFrame(line);
			if (parsed.ok && (parsed.value.type === "cancel" || parsed.value.type === "close")) {
				controlTail = controlTail.then(
					() => handleLine(line),
					() => handleLine(line),
				);
				return;
			}
			inputTail = inputTail.then(
				() => handleLine(line),
				() => handleLine(line),
			);
		},
		{
			maxFrameBytes: CHILD_AGENT_PROTOCOL_MAX_FRAME_BYTES,
			onError: () => failLost(protocol.state.spawnId ?? "unknown"),
			onEnd: () => {
				void Promise.all([inputTail, controlTail]).then(() => {
					if (!settled) failLost(protocol.state.spawnId ?? "unknown");
				});
			},
		},
	);

	return run;
}

export const runChildAgentEntry = runChildAgentProcess;
